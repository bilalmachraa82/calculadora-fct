// Proxy first-party para o endpoint de recolha do Umami Cloud.
// O script de tracking (data-host-url="/u") faz POST para /u/api/send, que o
// vercel.json reescreve para esta função. Reenvia para gateway.umami.is/api/send
// preservando o IP do visitante (X-Forwarded-For) para geo correcto.
//
// Porquê uma função em vez de um rewrite externo: os rewrites do Vercel para
// URLs externas só fazem proxy de GET; o POST do collect tem de passar por aqui.

const UMAMI_COLLECT = 'https://gateway.umami.is/api/send';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let body = req.body;
  if (body == null) body = '';
  else if (typeof body !== 'string') body = JSON.stringify(body);

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
