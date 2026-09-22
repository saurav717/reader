/**
 * The PDF and arXiv proxy as a Cloudflare Worker, for when the app is on a
 * static host (GitHub Pages) that cannot run `server/api.js`.
 *
 * This duplicates the routes in server/api.js rather than importing them: the
 * Workers runtime speaks Request/Response, not Node's req/res, so there is no
 * shared shape to reuse. Keep the two in step. The one thing both do share is
 * `server/fetchPdf.js`, which is written against web APIs only — the rules for
 * which URLs may be fetched are too important to keep two copies of.
 *
 * Deploy:  npx wrangler deploy
 * Then rebuild the app with VITE_API_BASE=https://<your-worker>.workers.dev
 */
import { disposition, fetchChecked, readPdf, rejectUrl } from '../server/fetchPdf.js';
import {
  authorSearchUrl,
  getScholar,
  parseAuthors,
  parseCitationView,
  parseProfileWorks,
  parseResults,
  profileUrl,
  searchUrl,
  versionsUrl,
  workUrl,
} from '../server/scholar.js';
import { askSerp } from '../server/serpapi.js';

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
  async fetch(request, env = {}) {
    // A SerpApi key, as a secret: `npx wrangler secret put SERPAPI_KEY`. With
    // it, Scholar is asked through SerpApi, which is the one way Scholar
    // answers a Worker at all. See server/serpapi.js.
    const serpKey = (env.SERPAPI_KEY || '').trim();
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    if (request.method !== 'GET' && !path.startsWith('/access/') && !path.startsWith('/scholar/captcha') && !path.startsWith('/browse/')) {
      return json({ error: 'method not allowed' }, 405, headers);
    }

    try {
      if (path === '/health') return json({ ok: true, access: false, browse: false, scholar: serpKey ? 'serpapi' : 'direct' }, 200, headers);

      // The browser inside the reader is the proxy's own Chromium, and a
      // Worker has none — not even a headless one. Same answer, same shape,
      // so the app explains what to run instead of offering.
      if (path.startsWith('/browse/')) {
        return json(
          {
            available: false,
            open: false,
            seq: 0,
            pdf: null,
            reason:
              'This proxy is a Cloudflare Worker, which has no browser to open. Run the Node proxy somewhere with Chromium — `npm start` in the reader repository, on your own machine or on any server; no screen is needed — and point Settings → Paper proxy at it.',
          },
          path === '/browse/status' || path === '/browse/frame' ? 200 : 501,
          headers,
        );
      }

      // Signing in with an institution needs a browser window on a screen,
      // and a Worker has neither. The app asks here before offering it, and
      // this is the answer that tells it to explain instead.
      if (path.startsWith('/access/')) {
        return json(
          {
            available: false,
            window: 'closed',
            everSignedIn: false,
            reason:
              'This proxy is a Cloudflare Worker, which has no browser to sign in with. Run the proxy on your own machine (`npm start` in the reader repository) and point Settings → Paper proxy at http://localhost:8080.',
            browse: { available: false, reason: 'This proxy is a Cloudflare Worker, which has no browser to open.' },
          },
          path === '/access/status' ? 200 : 501,
          headers,
        );
      }

      // Google Scholar, which publishes no API — see server/scholar.js. Expect
      // this to be refused often from here: Workers run in datacentres, and a
      // datacentre is what Scholar's captcha is for. It comes back as a 503
      // saying so, and the app falls back to the sources that have APIs.
      //
      // Showing the captcha to a person takes a browser window on a screen,
      // which a Worker has no more of than a sign-in does. Said so, the same
      // way, so the app explains instead of offering.
      if (path.startsWith('/scholar/captcha')) {
        return json(
          {
            available: false,
            window: 'closed',
            solved: false,
            browser: false,
            reason:
              'This proxy is a Cloudflare Worker, which has no browser to show the captcha in. Run the proxy on your own machine (`npm start` in the reader repository) and point Settings → Paper proxy at http://localhost:8080.',
          },
          path === '/scholar/captcha/status' ? 200 : 501,
          headers,
        );
      }
      if (path.startsWith('/scholar/')) {
        if (serpKey) {
          const kind = path.replace('/scholar/', '');
          const query = (url.searchParams.get('q') || '').trim();
          const name = (url.searchParams.get('name') || '').trim();
          const user = (url.searchParams.get('user') || '').trim();
          const cluster = (url.searchParams.get('cluster') || '').trim();
          const citation = (url.searchParams.get('citation') || '').trim();
          const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
          const params =
            kind === 'search'
              ? query && { query, start: Math.min(90, start) }
              : kind === 'authors'
                ? name && { name }
                : kind === 'profile'
                  ? /^[\w-]{6,32}$/.test(user) && { user, start }
                  : kind === 'versions'
                    ? /^\d{1,25}$/.test(cluster) && { cluster }
                    : kind === 'work'
                      ? /^[\w-]{6,32}$/.test(user) && /^[\w-]{6,32}:[\w-]{6,32}$/.test(citation) && { user, citation }
                      : null;
          if (params === null) return json({ error: 'not found' }, 404, headers);
          if (!params) return json({ error: 'missing or bad parameter' }, 400, headers);
          try {
            return json({ results: await askSerp(kind, params, serpKey), source: 'scholar', via: 'serpapi' }, 200, {
              ...headers,
              'Cache-Control': 'private, max-age=300',
            });
          } catch (error) {
            if (error && error.serpapi) return json({ error: error.message, serpapi: true, reason: error.reason }, 503, headers);
            return json({ error: String(error?.message || error) }, 502, headers);
          }
        }
        const scholarUrl =
          path === '/scholar/search'
            ? (url.searchParams.get('q') || '').trim() &&
              searchUrl((url.searchParams.get('q') || '').trim(), {
                start: Math.max(0, Math.min(90, Number(url.searchParams.get('start')) || 0)),
              })
            : path === '/scholar/authors'
              ? (url.searchParams.get('name') || '').trim() && authorSearchUrl((url.searchParams.get('name') || '').trim())
              : path === '/scholar/profile'
                ? /^[\w-]{6,32}$/.test(url.searchParams.get('user') || '') &&
                  profileUrl(url.searchParams.get('user'), { start: Math.max(0, Number(url.searchParams.get('start')) || 0) })
                : path === '/scholar/versions'
                  ? /^\d{1,25}$/.test(url.searchParams.get('cluster') || '') && versionsUrl(url.searchParams.get('cluster'))
                  : path === '/scholar/work'
                    ? /^[\w-]{6,32}$/.test(url.searchParams.get('user') || '') &&
                      /^[\w-]{6,32}:[\w-]{6,32}$/.test(url.searchParams.get('citation') || '') &&
                      workUrl(url.searchParams.get('user'), url.searchParams.get('citation'))
                    : null;
        if (scholarUrl === null) return json({ error: 'not found' }, 404, headers);
        if (!scholarUrl) return json({ error: 'missing or bad parameter' }, 400, headers);
        const parse =
          path === '/scholar/authors'
            ? parseAuthors
            : path === '/scholar/profile'
              ? parseProfileWorks
              : path === '/scholar/work'
                ? parseCitationView
                : parseResults;
        try {
          return json({ results: parse(await getScholar(scholarUrl)), source: 'scholar', via: 'direct' }, 200, {
            ...headers,
            'Cache-Control': 'private, max-age=300',
          });
        } catch (error) {
          if (error && error.blocked) {
            return json({ error: error.message, blocked: true, reason: error.reason, url: error.url }, 503, headers);
          }
          return json({ error: String(error?.message || error) }, 502, headers);
        }
      }

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
          headers: {
            ...headers,
            'Content-Type': 'application/pdf',
            'Content-Disposition': disposition(url.searchParams),
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      // Any other open-access PDF, from whichever publisher or repository
      // OpenAlex and Semantic Scholar point at. See server/fetchPdf.js for
      // what this refuses and why.
      if (path === '/pdf') {
        const target = url.searchParams.get('url') || '';
        const reason = rejectUrl(target);
        if (reason) return json({ error: reason }, 400, headers);

        let response;
        try {
          ({ response } = await fetchChecked(target, { userAgent: UA }));
        } catch (error) {
          return json({ error: String(error?.message || error) }, 400, headers);
        }
        const host = new URL(target).hostname;
        if (!response.ok) {
          const error = `the publisher answered ${response.status} for that PDF`;
          // A login wall, which a person could sign in through — but not
          // from here; see /access/status above. Said so the app can explain.
          const loginWall = response.status === 401 || response.status === 403;
          return json({ error, ...(loginWall ? { loginWall, host } : {}) }, response.status === 404 ? 404 : 502, headers);
        }

        let bytes;
        try {
          bytes = await readPdf(response, response.headers.get('content-type'));
        } catch (error) {
          const message = String(error?.message || error);
          return json({ error: message, ...(/web page/.test(message) ? { loginWall: true, host } : {}) }, 415, headers);
        }
        return new Response(bytes, {
          headers: {
            ...headers,
            'Content-Type': 'application/pdf',
            'Content-Length': String(bytes.length),
            'Content-Disposition': disposition(url.searchParams),
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
          },
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
