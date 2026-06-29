// POST /api/lead
// Recebe um contacto da Calculadora FCT pública.
// 1. Grava na tabela Neon `leads_fct_calc` (projecto: cool-bird-69912607, db: neondb).
// 2. Best-effort: cria/actualiza o contacto no HubSpot CRM (upsert por email).
// 3. Best-effort: envia notificação por email ao Bilal via Resend.
// Se DATABASE_URL não estiver definida, devolve 503 e o front-end cai no
// fallback mailto:. HubSpot e Resend são opcionais — se as chaves não estiverem
// definidas, são saltados sem falhar o pedido (a app continua funcional).
//
// Env vars (no Vercel):
//   DATABASE_URL          (obrigatória)  postgres connection string da Neon
//   HUBSPOT_TOKEN         (opcional)     Private App token HubSpot (scope crm.objects.contacts.write)
//   RESEND_API_KEY        (opcional)     chave Resend para notificação
//   LEAD_ALERT_EMAIL      (opcional)     destinatário(s), default bilal.machraa@aitipro.com
//   LEAD_ALERT_FROM       (opcional)     remetente Resend, default onboarding@resend.dev
//   LEAD_ALLOWED_ORIGINS  (opcional)     lista CORS separada por vírgulas
//   LEAD_RATE_LIMIT_MAX   (opcional)     pedidos por janela/IP, default 12
//   LEAD_RATE_LIMIT_WINDOW_SEC (opcional) janela em segundos, default 900
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (opcional) rate-limit durável

import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

const ALERT_TO = (process.env.LEAD_ALERT_EMAIL || 'bilal.machraa@aitipro.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALERT_FROM = process.env.LEAD_ALERT_FROM || 'AiTiPro Calculadora <onboarding@resend.dev>';
const MAX_BODY_BYTES = 10_000;
const ALLOWED_ORIGINS = (process.env.LEAD_ALLOWED_ORIGINS ||
  'https://calculadora-fct.aitipro.com,http://localhost:3000,http://localhost:3001,http://localhost:5173,http://127.0.0.1:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
const RATE_LIMIT_MAX = clampPositiveInt(process.env.LEAD_RATE_LIMIT_MAX, 12, 1, 1000);
const RATE_LIMIT_WINDOW_SEC = clampPositiveInt(process.env.LEAD_RATE_LIMIT_WINDOW_SEC, 900, 60, 86400);
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const memoryRateLimit = new Map();

function clampPositiveInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fmtEur(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function requestIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : (xff || (req.socket && req.socket.remoteAddress) || 'unknown');
  return String(raw).split(',')[0].trim() || 'unknown';
}

function rateLimitKey(req) {
  const ipHash = createHash('sha256').update(requestIp(req)).digest('hex').slice(0, 32);
  return `lead:${ipHash}`;
}

function jsonContentTypeAllowed(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  return !type || type.includes('application/json');
}

function memoryRateLimitCheck(key) {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW_SEC * 1000;
  const current = memoryRateLimit.get(key);
  const entry = current && current.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + windowMs };
  memoryRateLimit.set(key, entry);

  if (memoryRateLimit.size > 5000) {
    for (const [storedKey, stored] of memoryRateLimit) {
      if (stored.resetAt <= now) memoryRateLimit.delete(storedKey);
    }
  }

  return {
    limited: entry.count > RATE_LIMIT_MAX,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

async function upstashRateLimitCheck(key) {
  const response = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, RATE_LIMIT_WINDOW_SEC],
    ]),
  });
  if (!response.ok) throw new Error(`upstash:${response.status}`);

  const payload = await response.json();
  const count = Number(payload && payload[0] && payload[0].result);
  if (!Number.isFinite(count)) throw new Error('upstash:invalid-response');

  return {
    limited: count > RATE_LIMIT_MAX,
    retryAfter: RATE_LIMIT_WINDOW_SEC,
  };
}

async function rateLimitCheck(req) {
  const key = rateLimitKey(req);
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      return await upstashRateLimitCheck(key);
    } catch (err) {
      console.error('Rate limit backend error:', err);
    }
  }
  return memoryRateLimitCheck(key);
}

// Cria/actualiza o contacto no HubSpot CRM. Idempotente: faz upsert por email,
// por isso re-submissões do mesmo email actualizam o contacto em vez de duplicar.
// Best-effort — qualquer falha é registada mas NÃO bloqueia a captura do lead.
async function pushToHubspot(d) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return 'skipped';

  const e = (d.estimativa && typeof d.estimativa === 'object') ? d.estimativa : null;
  const partes = String(d.nome || '').split(' ').filter(Boolean);
  const firstname = partes.shift() || String(d.nome || '');
  const lastname = partes.join(' ');

  const resumo = e
    ? `Estimativa FCT (calculadora): base ${fmtEur(e.saldoBase)} · conservador ${fmtEur(e.saldoCons)} · otimista ${fmtEur(e.saldoOtim)}. ` +
      `Setor: ${e.setor || '—'} · Trabalhadores: ${e.nTrab ?? '—'} · Ano constituição: ${e.anoConst ?? '—'}.`
    : 'Contacto da Calculadora FCT (sem estimativa calculada antes de enviar).';

  // NB: email é o idProperty do upsert — não vai em properties (HubSpot rejeita).
  const properties = {
    firstname,
    company: d.empresa,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW',
    message: resumo,
  };
  if (lastname) properties.lastname = lastname;
  if (d.telefone) properties.phone = d.telefone;

  const payload = { inputs: [{ idProperty: 'email', id: d.email, properties }] };

  try {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* corpo não-JSON */ }

    if (!r.ok) {
      console.error('HubSpot upsert HTTP error:', r.status, text.slice(0, 400));
      return `failed:http:${r.status}:${text.slice(0, 160)}`;
    }
    // Endpoints batch podem devolver 2xx com falhas por-registo.
    if (parsed && (parsed.numErrors || (Array.isArray(parsed.errors) && parsed.errors.length))) {
      console.error('HubSpot upsert record error:', text.slice(0, 400));
      return `failed:record:${text.slice(0, 160)}`;
    }
    const id = parsed && parsed.results && parsed.results[0] && parsed.results[0].id;
    return id ? `upserted:${id}` : 'upserted';
  } catch (err) {
    console.error('HubSpot error:', err);
    return `failed:exc:${err.message || 'unknown'}`;
  }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

function setResponseHeaders(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (originAllowed(req) && req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  }
}

function buildEmailHtml(d, leadId) {
  const e = d.estimativa;
  const estBlock = e
    ? `<div style="background:#f0fdf8;border-left:3px solid #1bc88a;padding:14px 18px;border-radius:0 6px 6px 0;margin:14px 0;font-size:14px">
         <p style="margin:0 0 6px"><b>Estimativa calculada no site:</b></p>
         <ul style="margin:6px 0 0;padding-left:20px">
           <li>Setor: ${esc(e.setor)}</li>
           <li>Trabalhadores: ${esc(e.nTrab)}</li>
           <li>Ano de constituição: ${esc(e.anoConst)}</li>
           <li>Saldo conservador: ${fmtEur(e.saldoCons)}</li>
           <li><b>Saldo base: ${fmtEur(e.saldoBase)}</b></li>
           <li>Saldo otimista: ${fmtEur(e.saldoOtim)}</li>
         </ul>
       </div>`
    : `<p style="margin:14px 0;color:#999;font-size:13px">(O contacto não chegou a usar a calculadora antes de enviar.)</p>`;

  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0;padding:20px;color:#1e2d3d">
    <div style="background:#1bc88a;color:#fff;padding:14px 18px;border-radius:6px;font-weight:700;letter-spacing:.04em">NOVO LEAD #${leadId} · Calculadora FCT</div>
    <h2 style="font-size:18px;margin:18px 0 10px">${esc(d.nome)} — ${esc(d.empresa)}</h2>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Email</td><td><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Telefone</td><td>${esc(d.telefone) || '—'}</td></tr>
    </table>
    ${estBlock}
    <p style="margin:18px 0 8px;font-size:13px"><a href="https://console.neon.tech/app/projects/cool-bird-69912607" style="color:#0d3b38;font-weight:700">► Ver no Neon Console</a></p>
    <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
    <p style="font-size:11px;color:#999">Notificação automática · AiTiPro · calculadora-fct.aitipro.com</p>
  </div>`;
}

export default async function handler(req, res) {
  setResponseHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(originAllowed(req) ? 204 : 403).end();
  }
  if (!originAllowed(req)) return res.status(403).json({ error: 'Origin not allowed.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!jsonContentTypeAllowed(req)) return res.status(415).json({ error: 'Unsupported media type.' });

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) return res.status(413).json({ error: 'Payload too large.' });

  if (!sql) {
    // Sem DB configurada: devolve 503 para o front-end cair no fallback mailto.
    return res.status(503).json({ error: 'Lead backend not configured.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return res.status(413).json({ error: 'Payload too large.' });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body required.' });

  const honeypot = cleanText(body.website || body.empresa_site, 200);
  if (honeypot) return res.status(204).end();

  const limit = await rateLimitCheck(req);
  if (limit.limited) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Too many requests.' });
  }

  const consent = body.consent === true || body.consent === 'true' || body.consent === '1';
  const nome     = cleanText(body.nome, 200);
  const empresa  = cleanText(body.empresa, 200);
  const email    = cleanText(body.email, 200).toLowerCase();
  const telefone = cleanText(body.telefone, 60) || null;
  const estimativa = (body.estimativa && typeof body.estimativa === 'object') ? body.estimativa : null;

  if (!nome || !empresa || !email) return res.status(400).json({ error: 'nome, empresa e email são obrigatórios.' });
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) return res.status(400).json({ error: 'Email inválido.' });
  if (telefone && !/^[+()\d\s.-]{6,30}$/.test(telefone)) return res.status(400).json({ error: 'Telefone inválido.' });
  if (!consent) return res.status(400).json({ error: 'Consentimento obrigatório.' });

  const setor      = estimativa ? (cleanText(estimativa.setor, 100) || null) : null;
  const nTrab      = estimativa ? clampInt(estimativa.nTrab, 1, 100000) : null;
  const anoConst   = estimativa ? clampInt(estimativa.anoConst, 1900, 2030) : null;
  const saldoBase  = estimativa ? clampInt(estimativa.saldoBase, 0, 100000000) : null;
  const saldoCons  = estimativa ? clampInt(estimativa.saldoCons, 0, 100000000) : null;
  const saldoOtim  = estimativa ? clampInt(estimativa.saldoOtim, 0, 100000000) : null;
  const meses      = estimativa ? clampInt(estimativa.meses, 0, 200) : null;
  // Minimização RGPD: o schema permite estes campos, mas a captura de lead não precisa deles.
  const userAgent  = null;
  const referer    = null;

  let leadId;
  try {
    const inserted = await sql`
      INSERT INTO leads_fct_calc
        (nome, empresa, email, telefone, setor, n_trab, ano_const, saldo_base, saldo_cons, saldo_otim, meses, user_agent, referer)
      VALUES
        (${nome}, ${empresa}, ${email}, ${telefone}, ${setor}, ${nTrab}, ${anoConst}, ${saldoBase}, ${saldoCons}, ${saldoOtim}, ${meses}, ${userAgent}, ${referer})
      RETURNING id;
    `;
    leadId = inserted[0].id;
  } catch (err) {
    console.error('Neon insert error:', err);
    return res.status(500).json({ error: 'Database error.' });
  }

  // HubSpot CRM best-effort — upsert do contacto; não falha o request se falhar.
  try {
    await pushToHubspot({ nome, empresa, email, telefone, estimativa });
  } catch (err) {
    console.error('HubSpot push error:', err);
  }

  // Notificação Resend best-effort — não falha o request se o email falhar.
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const html = buildEmailHtml({ nome, empresa, email, telefone, estimativa }, leadId);
      const r = await resend.emails.send({
        from: ALERT_FROM,
        to: ALERT_TO,
        replyTo: email,
        subject: `[Calculadora FCT] ${empresa} — ${nome}`,
        html
      });
      if (r && r.error) console.error('Resend send error:', r.error);
    } catch (err) {
      console.error('Resend error:', err);
    }
  }

  return res.status(200).json({ ok: true });
}
