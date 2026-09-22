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
import * as browse from './browse.js';

// The Durable Object that holds the browser session open; the runtime needs
// it exported from the entry. See worker/browserSession.js.
export { BrowserSession } from './browserSession.js';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // The browser session's input arrives as JSON.
    'Access-Control-Allow-Headers': 'Content-Type',
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
      if (path === '/health') {
        return json({ ok: true, access: false, browse: browse.availability(env).available, scholar: serpKey ? 'serpapi' : 'direct' }, 200, headers);
      }

      // The browser inside the reader, on Cloudflare's Browser Rendering
      // rather than a Chromium of this Worker's own — see worker/browse.js.
      // Opening one takes a POST from the site; everything after takes the
      // session id that opening handed out, which nobody else has.
      if (path.startsWith('/browse/')) {
        const session = url.searchParams.get('session') || '';
        const fromThisApp = ALLOWED_ORIGINS.includes(origin);
        const changes = ['/browse/open', '/browse/input', '/browse/grab', '/browse/close'].includes(path);
        if (changes && request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
        if (changes && !fromThisApp) return json({ error: 'not from this app' }, 403, headers);

        // Held open in a Durable Object where one is bound (the fast way,
        // and what wrangler.toml ships); reconnected per request otherwise.
        if (env.BROWSER_SESSION && !['/browse/status'].includes(path)) {
          const stub = env.BROWSER_SESSION.get(env.BROWSER_SESSION.idFromName('the-browser'));
          const inner = new URL(`https://browser-session${path.replace(/^\/browse/, '')}${url.search}`);
          const answer = await stub.fetch(inner, {
            method: request.method,
            headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
            body: request.method === 'POST' ? await request.text() : undefined,
          });
          const type = answer.headers.get('Content-Type') || 'application/json; charset=utf-8';
          const extra = type.startsWith('application/pdf')
            ? { 'Content-Disposition': disposition(url.searchParams), 'X-Content-Type-Options': 'nosniff' }
            : {};
          return new Response(answer.body, {
            status: answer.status,
            headers: { ...headers, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra },
          });
        }

        try {
          if (path === '/browse/status') return json(browse.idle(env), 200, { ...headers, 'Cache-Control': 'no-store' });
          if (path === '/browse/open') {
            if (request.method !== 'POST') return json({ error: 'POST to open the browser' }, 405, headers);
            if (!fromThisApp) return json({ error: 'not from this app' }, 403, headers);
            try {
              return json({ ok: true, ...(await browse.open(env, url.searchParams.get('url') || '')) }, 200, { ...headers, 'Cache-Control': 'no-store' });
            } catch (error) {
              return json({ error: String(error?.message || error) }, 400, headers);
            }
          }
          if (path === '/browse/frame') {
            try {
              return json(await browse.frame(env, session), 200, { ...headers, 'Cache-Control': 'no-store' });
            } catch (error) {
              if (error?.code !== 'closed') throw error;
              return json(browse.idle(env), 200, { ...headers, 'Cache-Control': 'no-store' });
            }
          }
          if (path === '/browse/input') {
            if (request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
            if (!fromThisApp) return json({ error: 'not from this app' }, 403, headers);
            let events;
            try {
              const body = await request.json();
              events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
            } catch {
              return json({ error: 'that request body is not JSON' }, 400, headers);
            }
            if (events.length > 64) return json({ error: 'too many events at once' }, 400, headers);
            return json(await browse.input(env, session, events), 200, { ...headers, 'Cache-Control': 'no-store' });
          }
          if (path === '/browse/grab' || path === '/browse/pdf') {
            if (path === '/browse/grab' && request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
            if (path === '/browse/grab' && !fromThisApp) return json({ error: 'not from this app' }, 403, headers);
            let bytes;
            try {
              bytes = await browse.grab(env, session);
            } catch (error) {
              if (error?.code === 'closed') throw error;
              return json({ error: String(error?.message || error) }, 404, headers);
            }
            return new Response(bytes, {
              headers: {
                ...headers,
                'Content-Type': 'application/pdf',
                'Content-Length': String(bytes.length),
                'Content-Disposition': disposition(url.searchParams),
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
              },
            });
          }
          if (path === '/browse/close') {
            if (request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
            if (!fromThisApp) return json({ error: 'not from this app' }, 403, headers);
            return json({ ok: true, ...(await browse.close(env, session)) }, 200, { ...headers, 'Cache-Control': 'no-store' });
          }
          return json({ error: 'not found' }, 404, headers);
        } catch (error) {
          if (error?.code === 'closed') return json({ error: 'no browser is open' }, 409, headers);
          if (String(error?.message || '').includes('browser binding')) return json({ error: String(error.message) }, 400, headers);
          throw error;
        }
      }

      // Signing in with an institution needs a browser window on a screen,
      // and a Worker has neither. The app asks here before offering it, and
      // this is the answer that tells it to explain instead.
      if (path.startsWith('/access/')) {
        // "Forget sign-ins" has something to forget here only where the
        // cookies of a browser session were kept.
        if (path === '/access/forget' && request.method === 'POST' && ALLOWED_ORIGINS.includes(origin)) {
          return json({ ok: true, forgotten: await browse.forgetCookies(env) }, 200, headers);
        }
        const kept = env.SESSIONS ? (await browse.storedCookies(env)).length > 0 : false;
        return json(
          {
            available: false,
            window: 'closed',
            everSignedIn: kept,
            reason:
              'This proxy is a Cloudflare Worker, which has no screen to open a window on — but it can open a browser inside the reader instead, from the offer under a walled paper.',
            browse: browse.availability(env),
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
        // A login wall, which a person can sign in through in the browser
        // inside the reader (see /browse/ above). Where that sign-in's
        // cookies were kept, the file is asked for again with them first,
        // which is what makes one sign-in last for the next paper.
        const loginWall = async (status, error) => {
          const cookie = browse.cookieHeaderFor(await browse.storedCookies(env), target);
          if (cookie) {
            try {
              const retry = await fetchChecked(target, { userAgent: UA, headers: { Cookie: cookie } });
              if (retry.response.ok) {
                const bytes = await readPdf(retry.response, retry.response.headers.get('content-type'));
                return servePdf(bytes);
              }
            } catch {
              // Signed in, but not to this; say what the first attempt said.
            }
          }
          return json({ error, loginWall: true, host }, status, headers);
        };
        const servePdf = (bytes) =>
          new Response(bytes, {
            headers: {
              ...headers,
              'Content-Type': 'application/pdf',
              'Content-Length': String(bytes.length),
              'Content-Disposition': disposition(url.searchParams),
              'Cache-Control': 'public, max-age=86400',
              'X-Content-Type-Options': 'nosniff',
            },
          });

        if (!response.ok) {
          const error = `the publisher answered ${response.status} for that PDF`;
          if (response.status === 401 || response.status === 403) return loginWall(502, error);
          return json({ error }, response.status === 404 ? 404 : 502, headers);
        }

        let bytes;
        try {
          bytes = await readPdf(response, response.headers.get('content-type'));
        } catch (error) {
          const message = String(error?.message || error);
          if (/web page/.test(message)) return loginWall(415, message);
          return json({ error: message }, 415, headers);
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
