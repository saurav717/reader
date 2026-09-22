// Connect-style handler mounted at /api by both the Vite dev server and the
// production Express server. Everything here exists because arXiv serves no
// CORS headers: the browser cannot talk to it directly.

const ARXIV_ID = /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[0-9]+)?$/;

const UA = 'reader/0.1 (personal research reading tool)';

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function arxivQuery(url, res) {
  const params = new URLSearchParams();
  for (const key of ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder']) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  if (!params.has('search_query') && !params.has('id_list')) {
    return send(res, 400, { error: 'search_query or id_list is required' });
  }
  const upstream = await fetch(`https://export.arxiv.org/api/query?${params}`, {
    headers: { 'User-Agent': UA },
  });
  const text = await upstream.text();
  res.writeHead(upstream.ok ? 200 : upstream.status, {
    'Content-Type': 'application/atom+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(text);
}

// arXiv publishes native HTML for recent submissions; ar5iv has LaTeXML
// conversions of nearly everything older. Try the native one first.
async function arxivHtml(url, res) {
  const id = url.searchParams.get('id') || '';
  if (!ARXIV_ID.test(id)) return send(res, 400, { error: 'bad arXiv id' });
  const bare = id.replace(/v[0-9]+$/, '');
  const candidates = [
    { url: `https://arxiv.org/html/${id}`, source: 'arxiv' },
    { url: `https://ar5iv.labs.arxiv.org/html/${bare}`, source: 'ar5iv' },
  ];
  for (const candidate of candidates) {
    try {
      const upstream = await fetch(candidate.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!upstream.ok) continue;
      const html = await upstream.text();
      // ar5iv answers 200 with a stub when it has no conversion for a paper.
      if (html.length < 2000 || /No HTML for/i.test(html)) continue;
      return send(res, 200, { html, source: candidate.source, base: upstream.url }, {
        'Cache-Control': 'public, max-age=3600',
      });
    } catch {
      // try the next candidate
    }
  }
  return send(res, 404, { error: 'no HTML rendering available for this paper' });
}

async function arxivPdf(url, res) {
  const id = url.searchParams.get('id') || '';
  if (!ARXIV_ID.test(id)) return send(res, 400, { error: 'bad arXiv id' });
  const upstream = await fetch(`https://arxiv.org/pdf/${id}`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!upstream.ok) return send(res, upstream.status, { error: 'could not fetch PDF' });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buffer);
}

// Only the handful of hosts the app actually reads from; an open proxy here
// would let any page on this origin fetch anything as the server.
const ASSET_HOSTS = new Set(['arxiv.org', 'ar5iv.labs.arxiv.org', 'ar5iv.org', 'browse.arxiv.org']);

async function asset(url, res) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return send(res, 400, { error: 'bad url' });
  }
  if (parsed.protocol !== 'https:' || !ASSET_HOSTS.has(parsed.hostname)) {
    return send(res, 403, { error: 'host not allowed' });
  }
  const upstream = await fetch(parsed, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!upstream.ok) return send(res, upstream.status, { error: 'upstream error' });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buffer);
}

export default async function apiRouter(req, res, next) {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    switch (url.pathname) {
      case '/arxiv/query':
        return await arxivQuery(url, res);
      case '/arxiv/html':
        return await arxivHtml(url, res);
      case '/arxiv/pdf':
        return await arxivPdf(url, res);
      case '/asset':
        return await asset(url, res);
      case '/health':
        return send(res, 200, { ok: true });
      default:
        if (next) return next();
        return send(res, 404, { error: 'not found' });
    }
  } catch (error) {
    return send(res, 502, { error: String(error && error.message ? error.message : error) });
  }
}
