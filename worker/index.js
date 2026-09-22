/**
 * The arXiv proxy as a Cloudflare Worker, for when the app is on a static host
 * (GitHub Pages) that cannot run `server/api.js`.
 *
 * This duplicates the routes in server/api.js rather than importing them: the
 * Workers runtime speaks Request/Response, not Node's req/res, so there is no
 * shared shape to reuse. Keep the two in step.
 *
 * Deploy:  npx wrangler deploy
 * Then rebuild the app with VITE_API_BASE=https://<your-worker>.workers.dev
 */

const ARXIV_ID = /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[0-9]+)?$/;
const UA = 'reader/0.1 (personal research reading tool)';
const ASSET_HOSTS = new Set(['arxiv.org', 'ar5iv.labs.arxiv.org', 'ar5iv.org', 'browse.arxiv.org']);

// Which origins may call this worker. Narrow it to your own site: a wide-open
// proxy is one anybody can point at arXiv on your account's quota.
const ALLOWED_ORIGINS = ['https://saurav717.github.io', 'http://localhost:5173', 'http://localhost:8080'];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, headers);

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

    try {
      if (path === '/health') return json({ ok: true }, 200, headers);

      if (path === '/arxiv/query') {
        const params = new URLSearchParams();
        for (const key of ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder']) {
          const value = url.searchParams.get(key);
          if (value) params.set(key, value);
        }
        if (!params.has('search_query') && !params.has('id_list')) {
          return json({ error: 'search_query or id_list is required' }, 400, headers);
        }
        const upstream = await fetch(`https://export.arxiv.org/api/query?${params}`, {
          headers: { 'User-Agent': UA },
        });
        return new Response(await upstream.text(), {
          status: upstream.ok ? 200 : upstream.status,
          headers: { ...headers, 'Content-Type': 'application/atom+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
        });
      }

      if (path === '/arxiv/html') {
        const id = url.searchParams.get('id') || '';
        if (!ARXIV_ID.test(id)) return json({ error: 'bad arXiv id' }, 400, headers);
        const bare = id.replace(/v[0-9]+$/, '');
        for (const candidate of [
          { url: `https://arxiv.org/html/${id}`, source: 'arxiv' },
          { url: `https://ar5iv.labs.arxiv.org/html/${bare}`, source: 'ar5iv' },
        ]) {
          const upstream = await fetch(candidate.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
          if (!upstream.ok) continue;
          const html = await upstream.text();
          if (html.length < 2000 || /No HTML for/i.test(html)) continue;
          return json({ html, source: candidate.source, base: upstream.url }, 200, {
            ...headers,
            'Cache-Control': 'public, max-age=3600',
          });
        }
        return json({ error: 'no HTML rendering available for this paper' }, 404, headers);
      }

      if (path === '/arxiv/pdf') {
        const id = url.searchParams.get('id') || '';
        if (!ARXIV_ID.test(id)) return json({ error: 'bad arXiv id' }, 400, headers);
        const upstream = await fetch(`https://arxiv.org/pdf/${id}`, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
        });
        if (!upstream.ok) return json({ error: 'could not fetch PDF' }, upstream.status, headers);
        return new Response(upstream.body, {
          headers: { ...headers, 'Content-Type': 'application/pdf', 'Cache-Control': 'public, max-age=86400' },
        });
      }

      if (path === '/asset') {
        const target = url.searchParams.get('url') || '';
        let parsed;
        try {
          parsed = new URL(target);
        } catch {
          return json({ error: 'bad url' }, 400, headers);
        }
        if (parsed.protocol !== 'https:' || !ASSET_HOSTS.has(parsed.hostname)) {
          return json({ error: 'host not allowed' }, 403, headers);
        }
        const upstream = await fetch(parsed, { headers: { 'User-Agent': UA }, redirect: 'follow' });
        if (!upstream.ok) return json({ error: 'upstream error' }, upstream.status, headers);
        return new Response(upstream.body, {
          headers: {
            ...headers,
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      return json({ error: 'not found' }, 404, headers);
    } catch (error) {
      return json({ error: String(error?.message || error) }, 502, headers);
    }
  },
};
