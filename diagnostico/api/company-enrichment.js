const MAX_BODY_BYTES = 4_000;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://diagnostico.aitipro.com',
  'https://www.diagnostico.aitipro.com',
  'http://localhost:3000',
  'http://localhost:4174',
  'http://127.0.0.1:4174'
];

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

  try {
    const body = await readJsonBody(req);
    const nif = cleanDigits(body.nif, 9);
    const empresa = cleanText(body.empresa, 140);

    if (body.consentimento_rgpd !== true) {
      return res.status(400).json({ error: 'Consentimento obrigatório.' });
    }

    const nifInfo = analyseNif(nif);
    if (!nifInfo.valid) {
      return res.status(400).json({ error: 'NIF inválido.' });
    }

    if (!/^[5679]/.test(nif)) {
      return res.status(200).json({
        status: 'skipped',
        source: 'Sem consulta externa',
        checks: ['NIF não parece NIPC de pessoa colectiva; consulta pública ignorada por minimização.']
      });
    }

    const vies = await lookupVies(nif);
    const checks = [
      vies.isValid ? 'VIES confirma número IVA/PT válido.' : 'VIES não confirmou número IVA/PT activo.',
      empresa && vies.name ? nameCheck(empresa, vies.name) : 'Nome público devolvido apenas se disponível em VIES.',
      'VIES não devolve CAE; o CAE continua a vir do campo indicado pelo utilizador.'
    ];

    return res.status(200).json({
      status: vies.isValid ? 'found' : 'not_found',
      source: 'VIES · Comissão Europeia',
      company_name: vies.name || '',
      fetched_at: new Date().toISOString(),
      checks
    });
  } catch (error) {
    console.error('company enrichment failed', {
      name: error?.name,
      message: error?.message
    });
    return res.status(200).json({
      status: 'unavailable',
      source: 'VIES · Comissão Europeia',
      checks: ['Fonte externa indisponível; relatório gerado com CAE e respostas declaradas.']
    });
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
      throw new Error('body_too_large');
    }
    return parseJson(req.body);
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('body_too_large');
    }
    chunks.push(chunk);
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(raw) {
  return JSON.parse(raw || '{}');
}

async function lookupVies(nif) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/PT/vat/${nif}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`vies:${response.status}`);
    }
    const payload = await response.json();
    return {
      isValid: payload?.isValid === true,
      name: cleanPublicName(payload?.name)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanPublicName(value) {
  const text = cleanText(value, 180);
  if (!text || text === '---') return '';
  return text;
}

function nameCheck(input, publicName) {
  const a = normaliseName(input);
  const b = normaliseName(publicName);
  if (!a || !b) {
    return 'Nome público não comparável.';
  }
  if (b.includes(a) || a.includes(b)) {
    return `Nome VIES compatível: ${publicName}.`;
  }
  return `Nome VIES a validar na sessão: ${publicName}.`;
}

function normaliseName(value) {
  return cleanText(value, 180)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(LDA|LIMITADA|SA|S A|UNIPESSOAL|SOCIEDADE|EMPRESA)\b/gi, '')
    .replace(/[^A-Z0-9]+/gi, ' ')
    .trim()
    .toUpperCase();
}

function cleanDigits(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  return String(value).replace(/\D/g, '').slice(0, maxLength);
}

function analyseNif(value) {
  const clean = cleanDigits(value, 9);
  if (clean.length !== 9) {
    return { valid: false };
  }

  const digits = clean.split('').map(Number);
  const sum = digits.slice(0, 8).reduce((total, digit, index) => total + digit * (9 - index), 0);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return { valid: check === digits[8] };
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
