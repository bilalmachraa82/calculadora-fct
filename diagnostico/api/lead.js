import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const MAX_BODY_BYTES = 32_000;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://diagnostico.aitipro.com',
  'https://www.diagnostico.aitipro.com',
  'http://localhost:3000',
  'http://localhost:4174',
  'http://127.0.0.1:4174'
];
const RATE_LIMIT_WINDOW_MS = positiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const RATE_LIMIT_MAX = positiveInt(process.env.RATE_LIMIT_MAX, 12);
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const ALERT_TO = (process.env.LEAD_ALERT_EMAIL || 'bilal.machraa@aitipro.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALERT_FROM = process.env.LEAD_ALERT_FROM || 'AiTiPro Diagnóstico <onboarding@resend.dev>';
const rateBuckets = new Map();

export default async function handler(req, res) {
  setBaseHeaders(res);

  const corsOk = applyCors(req, res);
  if (!corsOk) {
    return res.status(403).json({ error: 'Pedido não autorizado.' });
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    return res.status(415).json({ error: 'Formato não suportado.' });
  }

  const limit = await rateLimitCheck(req);
  if (limit.limited) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Demasiados pedidos. Tente novamente mais tarde.' });
  }

  try {
    const body = await readJsonBody(req);

    if (cleanText(body.website, 120)) {
      return res.status(204).end();
    }

    const lead = normaliseLead(body);
    const validationError = validateLead(lead);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const url = process.env.DATABASE_URL;
    if (!url) {
      return res.status(503).json({ error: 'Serviço temporariamente indisponível.' });
    }

    const sql = neon(url);
    const inserted = await sql`
      INSERT INTO diagnostico_leads
        (nome, email, telefone, empresa, cargo, objetivo, nif, nif_valido,
         nif_tipo, cae, cae_divisao, cae_sector, website_empresa, janela_contacto,
         setor, colaboradores, leads_semana, tempo_resposta, horas_repetitivas,
         dor_prioritaria, prazo_decisao, existia_antes_2023, ferramentas, perda_estimada_mensal,
         assuncao_custo_hora, assuncao_pct_recuperavel, assuncao_valor_lead,
         agentes_sugeridos, lead_score, urgencia, enriquecimento_estado,
         enriquecimento_empresa, relatorio_executivo,
         cenarios_impacto, matriz_prioridade, plano_14_dias, roadmap_90_dias,
         riscos_governanca, metricas_sucesso, agenda_reuniao, consentimento_rgpd,
         origem)
      VALUES
        (${lead.nome}, ${lead.email}, ${lead.telefone}, ${lead.empresa},
         ${lead.cargo}, ${lead.objetivo}, ${lead.nif}, ${lead.nif_valido},
         ${lead.nif_tipo}, ${lead.cae}, ${lead.cae_divisao}, ${lead.cae_sector},
         ${lead.website_empresa}, ${lead.janela_contacto}, ${lead.setor},
         ${lead.colaboradores}, ${lead.leads_semana}, ${lead.tempo_resposta},
         ${lead.horas_repetitivas}, ${lead.dor_prioritaria},
         ${lead.prazo_decisao}, ${lead.existia_antes_2023}, ${lead.ferramentas},
         ${lead.perda_estimada_mensal},
         ${lead.assuncao_custo_hora}, ${lead.assuncao_pct_recuperavel},
         ${lead.assuncao_valor_lead}, ${lead.agentes_sugeridos},
         ${lead.lead_score}, ${lead.urgencia}, ${lead.enriquecimento_estado},
         ${lead.enriquecimento_empresa}, ${lead.relatorio_executivo},
         ${lead.cenarios_impacto}, ${lead.matriz_prioridade},
         ${lead.plano_14_dias}, ${lead.roadmap_90_dias},
         ${lead.riscos_governanca}, ${lead.metricas_sucesso},
         ${lead.agenda_reuniao}, ${lead.consentimento_rgpd}, ${lead.origem})
      RETURNING id;
    `;

    notifyResend(lead, inserted[0]?.id).catch((err) => {
      console.error('diagnostico notify failed', { message: err?.message });
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.publicMessage });
    }

    console.error('diagnostico lead failed', {
      name: error?.name,
      message: error?.message,
      code: error?.code
    });

    return res.status(500).json({ error: 'Não foi possível guardar o pedido.' });
  }
}

function setBaseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  const allowed = allowedOrigins();

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (!origin) {
    return true;
  }

  if (!allowed.has(origin)) {
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  return true;
}

function allowedOrigins() {
  const configured = String(process.env.DIAGNOSTICO_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

async function readJsonBody(req) {
  if (typeof req.body === 'object' && req.body !== null) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) {
      throw publicError(413, 'Pedido demasiado grande.');
    }
    return parseJson(req.body);
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw publicError(413, 'Pedido demasiado grande.');
    }
    chunks.push(chunk);
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw publicError(400, 'JSON inválido.');
  }
}

function normaliseLead(body) {
  const nif = cleanDigits(body.nif, 9) || null;
  const cae = cleanDigits(body.cae, 5) || null;
  const nifInfo = analyseNif(nif);

  return {
    nome: cleanText(body.nome, 120),
    email: cleanText(body.email, 254).toLowerCase(),
    telefone: cleanText(body.telefone, 40) || null,
    empresa: cleanText(body.empresa, 140),
    cargo: cleanText(body.cargo, 100) || null,
    objetivo: cleanText(body.objetivo, 140) || null,
    nif,
    nif_valido: nif ? nifInfo.valid : null,
    nif_tipo: cleanText(body.nif_tipo, 80) || nifInfo.kind || null,
    cae,
    cae_divisao: cleanNumber(body.cae_divisao, 1, 99),
    cae_sector: cleanText(body.cae_sector, 120) || null,
    website_empresa: cleanUrl(body.website_empresa, 240) || null,
    janela_contacto: cleanText(body.janela_contacto, 80) || null,
    setor: cleanText(body.setor, 120) || null,
    colaboradores: cleanText(body.colaboradores, 80) || null,
    leads_semana: cleanText(body.leads_semana, 80) || null,
    tempo_resposta: cleanText(body.tempo_resposta, 80) || null,
    horas_repetitivas: cleanText(body.horas_repetitivas, 80) || null,
    dor_prioritaria: cleanText(body.dor_prioritaria, 140) || null,
    prazo_decisao: cleanText(body.prazo_decisao, 120) || null,
    existia_antes_2023: cleanText(body.existia_antes_2023, 80) || null,
    ferramentas: cleanArray(body.ferramentas, 8, 80),
    perda_estimada_mensal: cleanNumber(body.perda_estimada_mensal, 0, 1_000_000),
    assuncao_custo_hora: cleanNumber(body.assuncao_custo_hora, 0, 500),
    assuncao_pct_recuperavel: cleanNumber(body.assuncao_pct_recuperavel, 0, 100),
    assuncao_valor_lead: cleanNumber(body.assuncao_valor_lead, 0, 50_000),
    agentes_sugeridos: cleanArray(body.agentes_sugeridos, 6, 120),
    lead_score: cleanNumber(body.lead_score, 0, 100),
    urgencia: cleanText(body.urgencia, 40) || null,
    enriquecimento_estado: cleanText(body.enriquecimento_estado, 120) || null,
    enriquecimento_empresa: cleanArray(body.enriquecimento_empresa, 8, 260),
    relatorio_executivo: cleanArray(body.relatorio_executivo, 6, 360),
    cenarios_impacto: cleanArray(body.cenarios_impacto, 6, 260),
    matriz_prioridade: cleanArray(body.matriz_prioridade, 8, 260),
    plano_14_dias: cleanArray(body.plano_14_dias, 6, 260),
    roadmap_90_dias: cleanArray(body.roadmap_90_dias, 6, 300),
    riscos_governanca: cleanArray(body.riscos_governanca, 8, 280),
    metricas_sucesso: cleanArray(body.metricas_sucesso, 8, 280),
    agenda_reuniao: cleanArray(body.agenda_reuniao, 6, 220),
    consentimento_rgpd: body.consentimento_rgpd === true,
    origem: cleanText(body.origem, 80) || 'diagnostico-web'
  };
}

function validateLead(lead) {
  if (lead.nome.length < 2) {
    return 'Nome obrigatório.';
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    return 'Email válido obrigatório.';
  }

  if (lead.empresa.length < 2) {
    return 'Empresa obrigatória.';
  }

  if (lead.telefone && !/^[+()\d\s.-]{6,40}$/.test(lead.telefone)) {
    return 'Telefone parece inválido.';
  }

  if (lead.nif && !lead.nif_valido) {
    return 'NIF parece inválido.';
  }

  if (lead.cae && (lead.cae.length < 2 || lead.cae.length > 5)) {
    return 'CAE parece inválido.';
  }

  if (lead.website_empresa && !/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(lead.website_empresa)) {
    return 'Website parece inválido.';
  }

  if (!lead.consentimento_rgpd) {
    return 'Consentimento RGPD obrigatório.';
  }

  return null;
}

function cleanDigits(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }

  return String(value).replace(/\D/g, '').slice(0, maxLength);
}

function analyseNif(value) {
  const clean = cleanDigits(value, 9);
  if (!clean) {
    return { valid: false, kind: '' };
  }

  const kind = {
    '1': 'Pessoa singular',
    '2': 'Pessoa singular',
    '3': 'Pessoa singular',
    '5': 'Pessoa colectiva',
    '6': 'Organismo público',
    '7': 'Entidade equiparada',
    '8': 'Empresário em nome individual',
    '9': 'Entidade não residente/equiparada'
  }[clean.charAt(0)] || 'Prefixo pouco comum';

  if (clean.length !== 9) {
    return { valid: false, kind };
  }

  const digits = clean.split('').map(Number);
  const sum = digits.slice(0, 8).reduce((total, digit, index) => total + digit * (9 - index), 0);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return { valid: check === digits[8], kind };
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanUrl(value, maxLength) {
  const text = cleanText(value, maxLength);
  if (!text) return '';

  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.includes('.')) return '';
    return parsed.href.slice(0, maxLength);
  } catch {
    return '';
  }
}

function cleanArray(value, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);

  return items.length ? items : null;
}

function cleanNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(max, Math.max(min, Math.round(number)));
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
}

function hashKey(value) {
  return crypto
    .createHash('sha256')
    .update(String(process.env.RATE_LIMIT_SALT || 'diagnostico') + ':' + value)
    .digest('hex')
    .slice(0, 32);
}

function memoryCheck(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    cleanupBuckets(now);
    return { limited: false, retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
  }

  bucket.count += 1;
  return {
    limited: bucket.count > RATE_LIMIT_MAX,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

async function upstashCheck(key) {
  const response = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)]
    ])
  });
  if (!response.ok) throw new Error(`upstash:${response.status}`);

  const payload = await response.json();
  const count = Number(payload?.[0]?.result);
  if (!Number.isFinite(count)) throw new Error('upstash:invalid-response');

  return { limited: count > RATE_LIMIT_MAX, retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
}

async function rateLimitCheck(req) {
  const key = hashKey(clientIp(req));
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      return await upstashCheck(key);
    } catch (error) {
      console.error('Rate limit backend error:', { message: error?.message });
    }
  }
  return memoryCheck(key);
}

function cleanupBuckets(now) {
  if (rateBuckets.size < 1_000) {
    return;
  }

  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function publicError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatEuro(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('pt-PT') + ' €';
}

function buildEmailHtml(lead, leadId) {
  const agentes = Array.isArray(lead.agentes_sugeridos) ? lead.agentes_sugeridos : [];
  const executivo = Array.isArray(lead.relatorio_executivo) ? lead.relatorio_executivo : [];
  const cenarios = Array.isArray(lead.cenarios_impacto) ? lead.cenarios_impacto : [];
  const matriz = Array.isArray(lead.matriz_prioridade) ? lead.matriz_prioridade : [];
  const enriquecimento = Array.isArray(lead.enriquecimento_empresa) ? lead.enriquecimento_empresa : [];
  const agenda = Array.isArray(lead.agenda_reuniao) ? lead.agenda_reuniao : [];
  const plano = Array.isArray(lead.plano_14_dias) ? lead.plano_14_dias : [];
  const roadmap = Array.isArray(lead.roadmap_90_dias) ? lead.roadmap_90_dias : [];
  const riscos = Array.isArray(lead.riscos_governanca) ? lead.riscos_governanca : [];
  const metricas = Array.isArray(lead.metricas_sucesso) ? lead.metricas_sucesso : [];
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:600px;color:#132033">
    <div style="background:#20c997;color:#fff;padding:12px 16px;border-radius:6px;font-weight:700;letter-spacing:.04em">NOVO LEAD #${esc(leadId)} · Diagnóstico IA</div>
    <h2 style="font-size:18px;margin:16px 0 8px">${esc(lead.nome)} — ${esc(lead.empresa)}</h2>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Email</td><td><a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Telefone</td><td>${esc(lead.telefone) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Função</td><td>${esc(lead.cargo) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Objectivo</td><td>${esc(lead.objetivo) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Janela contacto</td><td>${esc(lead.janela_contacto) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">NIF</td><td>${esc(lead.nif) || '—'} ${lead.nif_valido === true ? '(válido)' : ''} ${esc(lead.nif_tipo) || ''}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">CAE</td><td>${esc(lead.cae) || '—'} ${esc(lead.cae_sector) || ''}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Website</td><td>${lead.website_empresa ? `<a href="${esc(lead.website_empresa)}">${esc(lead.website_empresa)}</a>` : '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Setor</td><td>${esc(lead.setor) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Dor</td><td>${esc(lead.dor_prioritaria) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Prazo</td><td>${esc(lead.prazo_decisao) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Existia antes 2023</td><td>${esc(lead.existia_antes_2023) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Fonte externa</td><td>${esc(lead.enriquecimento_estado) || '—'}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Perda mensal estimada</td><td>${formatEuro(lead.perda_estimada_mensal)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Urgência</td><td>${esc(lead.urgencia) || '—'} ${typeof lead.lead_score === 'number' ? `(${lead.lead_score}/100)` : ''}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#5b6a7e">Agentes sugeridos</td><td>${agentes.map(esc).join(' · ') || '—'}</td></tr>
    </table>
    <h3 style="font-size:15px;margin:18px 0 6px">Sumário executivo</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${executivo.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Cenários de impacto</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${cenarios.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Matriz de prioridade</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${matriz.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Enriquecimento externo</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${enriquecimento.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Agenda sugerida</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${agenda.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Plano 14 dias</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${plano.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Roadmap 90 dias</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${roadmap.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <h3 style="font-size:15px;margin:18px 0 6px">Riscos e métricas</h3>
    <ol style="font-size:14px;margin-top:0;padding-left:20px">${riscos.concat(metricas).map((item) => `<li>${esc(item)}</li>`).join('') || '<li>—</li>'}</ol>
    <p style="font-size:11px;color:#9aa5b1;margin-top:16px">Notificação automática · AiTiPro · diagnostico.aitipro.com</p>
  </div>`;
}

async function notifyResend(lead, leadId) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  // import dinâmico: se 'resend' não estiver instalado, falha graciosamente (log) sem partir o endpoint.
  const { Resend } = await import('resend');
  const resend = new Resend(key);
  const r = await resend.emails.send({
    from: ALERT_FROM,
    to: ALERT_TO,
    replyTo: lead.email,
    subject: `[Diagnóstico IA] ${lead.empresa} — ${lead.nome}`,
    html: buildEmailHtml(lead, leadId)
  });
  if (r && r.error) console.error('Resend send error:', r.error);
}
