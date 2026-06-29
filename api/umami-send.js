// Proxy first-party para o endpoint de recolha do Umami Cloud.
// O script de tracking (data-host-url="/u") faz POST para /u/api/send, que o
// vercel.json reescreve para esta função. Reenvia para gateway.umami.is/api/send
// preservando o IP do visitante (X-Forwarded-For) para geo correcto.
//
// Porquê uma função em vez de um rewrite externo: os rewrites do Vercel para
// URLs externas só fazem proxy de GET; o POST do collect tem de passar por aqui.

const UMAMI_COLLECT = 'https://gateway.umami.is/api/send';
const MAX_BODY_BYTES = 10_000;
const ALLOWED_ORIGINS = (process.env.ANALYTICS_ALLOWED_ORIGINS ||
  process.env.LEAD_ALLOWED_ORIGINS ||
  'https://calculadora-fct.aitipro.com,http://localhost:3000,http://localhost:3001,http://localhost:5173,http://127.0.0.1:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

function originAllowed(req) {
  const origin = req.headers.origin;
  return Boolean(origin && ALLOWED_ORIGINS.includes(origin));
}

function jsonContentTypeAllowed(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  return !type || type.includes('application/json');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (originAllowed(req)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(originAllowed(req) ? 204 : 403).end();
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!jsonContentTypeAllowed(req)) {
    return res.status(415).json({ error: 'Unsupported media type.' });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Payload too large.' });
  }

  let body = req.body;
  if (body == null) body = '';
  else if (typeof body !== 'string') body = JSON.stringify(body);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Payload too large.' });
  }

  const xff = req.headers['x-forwarded-for'] ||
    (req.socket && req.socket.remoteAddress) || '';

  try {
    const upstream = await fetch(UMAMI_COLLECT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'X-Forwarded-For': xff,
      },
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain');
    return res.end(text);
  } catch (err) {
    console.error('umami proxy error:', err);
    return res.status(502).json({ error: 'proxy_failed' });
  }
}
