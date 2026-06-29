import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const MAX_BODY_BYTES = 12_000;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://diagnostico.aitipro.com',
  'https://www.diagnostico.aitipro.com',
  'http://localhost:3000',
  'http://localhost:4174',
  'http://127.0.0.1:4174'
];
const RATE_LIMIT_WINDOW_MS = positiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const RATE_LIMIT_MAX = positiveInt(process.env.RATE_LIMIT_MAX, 12);
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

  const bucketKey = hashKey(clientIp(req));
  if (!allowRequest(bucketKey)) {
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
    await sql`
      INSERT INTO diagnostico_leads
        (nome, email, telefone, empresa, setor, colaboradores, leads_semana,
         tempo_resposta, horas_repetitivas, ferramentas, perda_estimada_mensal,
         assuncao_custo_hora, assuncao_pct_recuperavel, assuncao_valor_lead,
         agentes_sugeridos, consentimento_rgpd, origem)
      VALUES
        (${lead.nome}, ${lead.email}, ${lead.telefone}, ${lead.empresa},
         ${lead.setor}, ${lead.colaboradores}, ${lead.leads_semana},
         ${lead.tempo_resposta}, ${lead.horas_repetitivas},
         ${lead.ferramentas}, ${lead.perda_estimada_mensal},
         ${lead.assuncao_custo_hora}, ${lead.assuncao_pct_recuperavel},
         ${lead.assuncao_valor_lead}, ${lead.agentes_sugeridos},
         ${lead.consentimento_rgpd}, ${lead.origem})
    `;

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
  return {
    nome: cleanText(body.nome, 120),
    email: cleanText(body.email, 254).toLowerCase(),
    telefone: cleanText(body.telefone, 40) || null,
    empresa: cleanText(body.empresa, 140),
    setor: cleanText(body.setor, 120) || null,
    colaboradores: cleanText(body.colaboradores, 80) || null,
    leads_semana: cleanText(body.leads_semana, 80) || null,
    tempo_resposta: cleanText(body.tempo_resposta, 80) || null,
    horas_repetitivas: cleanText(body.horas_repetitivas, 80) || null,
    ferramentas: cleanArray(body.ferramentas, 8, 80),
    perda_estimada_mensal: cleanNumber(body.perda_estimada_mensal, 0, 1_000_000),
    assuncao_custo_hora: cleanNumber(body.assuncao_custo_hora, 0, 500),
    assuncao_pct_recuperavel: cleanNumber(body.assuncao_pct_recuperavel, 0, 100),
    assuncao_valor_lead: cleanNumber(body.assuncao_valor_lead, 0, 50_000),
    agentes_sugeridos: cleanArray(body.agentes_sugeridos, 6, 120),
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

  if (!lead.consentimento_rgpd) {
    return 'Consentimento RGPD obrigatório.';
  }

  return null;
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

function allowRequest(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    cleanupBuckets(now);
    return true;
  }

  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
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
