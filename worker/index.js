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
import { fetchOpenReview, openReviewAccount, openReviewFiles, saidChallenge } from '../server/openreview.js';
import { pmcFiles } from '../server/pmc.js';
import {
  authorSearchUrl,
  getScholar,
  parseAuthors,
  parseCitationView,
  parseProfile,
  parseProfileWorks,
  parseResults,
  profileUrl,
  profileSort,
  searchUrl,
  versionsUrl,
  workUrl,
} from '../server/scholar.js';
import { askServices } from '../server/scholarServices.js';
import { emailAllowed, googleEmail, issuePass, readPass } from '../server/passes.js';
import * as browse from './browse.js';
import * as browserless from './browserless.js';

// The Durable Object that holds the browser session open; the runtime needs
// it exported from the entry. See worker/browserSession.js.
export { BrowserSession } from './browserSession.js';
export { Usage } from './usage.js';
import { rateLimited, refusal } from './browserSession.js';

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
    // The browser session's input arrives as JSON; the app's token and its
    // client id come as headers (see `authorized` and `clientOf` below).
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Reader-Client, X-Google-Token',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

/**
 * Who may use what costs something or belongs to someone. A Worker on the
 * open internet is reachable by anyone who reads its address out of the
 * site's JavaScript, and an Origin header is a browser's courtesy, not a
 * credential — anything but a browser sends whichever it likes. So the
 * routes that drive a browser, keep or use a sign-in, or spend a metered
 * account (Browserless, SerpApi) take a token: the READER_TOKEN secret,
 * which whoever runs this Worker pastes into Settings → Paper proxy once.
 *
 *     npx wrangler secret put READER_TOKEN
 *
 * Without the secret those routes are simply off, and say so. Everything a
 * stranger could do no harm with — arXiv, an open-access PDF, Scholar asked
 * directly — needs no token, so the site keeps working for a visitor who
 * has none.
 */
const TOKEN_MESSAGE = 'sign in with Google to use this (Settings → Google), or paste this proxy’s token under Settings → Paper proxy';
const NO_TOKEN_MESSAGE = 'this Worker has no READER_TOKEN secret, so what needs one is off — see wrangler.toml';

function sameSecret(given, expected) {
  // Compared byte for byte whatever the outcome, so a wrong token takes as
  // long to refuse as a nearly right one.
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) differ |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return differ === 0;
}

/**
 * Who the request is from, as far as the gated routes care: the owner, with
 * READER_TOKEN itself; anyone signed in with Google, with the pass this
 * Worker gave them (see server/passes.js); or nobody — null.
 */
async function authorized(request, env) {
  const expected = String(env.READER_TOKEN || '').trim();
  if (!expected) return null;
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!given) return null;
  if (sameSecret(given, expected)) return { owner: true };
  const pass = await readPass(given, expected);
  return pass && emailAllowed(pass.email, env.READER_EMAILS) ? { email: pass.email } : null;
}

/**
 * Whether a signed-in person is asking faster than a person does — the one
 * guard on the owner's paid accounts now that anyone with a Google account
 * may use them. The owner is never limited; without the binding, nobody is.
 */
async function personOverLimit(env, who) {
  if (!who?.email || !env.PERSON_LIMIT) return false;
  try {
    const { success } = await env.PERSON_LIMIT.limit({ key: who.email });
    return !success;
  } catch {
    return false;
  }
}

/**
 * Put `counts` on the tally of whoever `who` is (see worker/usage.js): their
 * email for a pass, "owner" for READER_TOKEN itself. After the answer has
 * gone, where the runtime lets it; never in the way of one.
 */
function tally(env, ctx, who, counts) {
  if (!env.USAGE || !who) return;
  const email = who.email || 'owner';
  const done = env.USAGE.get(env.USAGE.idFromName('usage'))
    .fetch('https://usage/record', { method: 'POST', body: JSON.stringify({ email, counts, at: Date.now() }) })
    .catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(done);
}

/** The refusal, worded for whether there is a token to give at all. */
const needsToken = (env, headers) =>
  json({ error: env.READER_TOKEN ? TOKEN_MESSAGE : NO_TOKEN_MESSAGE, token: true, google: Boolean(env.READER_TOKEN && env.GOOGLE_CLIENT_ID) }, 401, headers);

/**
 * Which browser this is: an id the app makes up once and keeps, sent with
 * every request. The browser session and the jar of cookies are both kept
 * under it, so one person's sign-in is never another's. Its shape is
 * checked and nothing else: it is a name, not a secret — the session token
 * and READER_TOKEN are the secrets.
 */
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
function clientOf(request, url) {
  const given = request.headers.get('X-Reader-Client') || url.searchParams.get('client') || '';
  return CLIENT_ID.test(given) ? given : '';
}

/** Who is asking, for the rate limit: the connecting address. */
const addressOf = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

/**
 * How many times a minute one address may ask for a file. A rate-limit
 * binding in wrangler.toml; without one the Worker relies on the token
 * alone, which is what gates the paths that cost anything.
 */
async function overLimit(env, request) {
  if (!env.PDF_LIMIT) return false;
  try {
    const { success } = await env.PDF_LIMIT.limit({ key: addressOf(request) });
    return !success;
  } catch {
    return false;
  }
}

/**
 * The one session object, which holds the browser. It lives where its
 * first request came from, which is near the person and, when the browser
 * is at Browserless, far from the browser — and every frame and every
 * click crosses that distance. BROWSER_SESSION_LOCATION, a plain var,
 * asks for it to be made near the browser instead (wnam for Browserless's
 * San Francisco, weur for London or Amsterdam); the object is named by
 * the hint, so changing it makes a new one there.
 */
function sessionStub(env, client) {
  const hint = String(env.BROWSER_SESSION_LOCATION || '').trim().toLowerCase();
  // One object per browser that uses the reader, named by its client id —
  // never one for everyone, whose screen and sign-in the next visitor
  // would land in.
  const name = `client:${client}${hint ? `@${hint}` : ''}`;
  return env.BROWSER_SESSION.get(env.BROWSER_SESSION.idFromName(name), hint ? { locationHint: hint } : undefined);
}

export default {
  async fetch(request, env = {}, ctx = undefined) {
    // A SerpApi key, as a secret: `npx wrangler secret put SERPAPI_KEY`. With
    // it, Scholar is asked through SerpApi, which is the one way Scholar
    // answers a Worker at all. See server/serpapi.js.
    const serpKey = (env.SERPAPI_KEY || '').trim();
    // A Serply key, the same way: `npx wrangler secret put SERPLY_KEY`. Serply
    // fetches Scholar's own pages, read by the parsers the direct way uses,
    // and is asked first when both are set. See server/serply.js.
    const serplyKey = (env.SERPLY_KEY || '').trim();
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    if (request.method !== 'GET' && !path.startsWith('/access/') && !path.startsWith('/scholar/captcha') && !path.startsWith('/browse/') && path !== '/auth/google') {
      return json({ error: 'method not allowed' }, 405, headers);
    }

    try {
      if (path === '/health') {
        return json(
          { ok: true, access: false, auth: Boolean(String(env.READER_TOKEN || '').trim()), google: Boolean(String(env.READER_TOKEN || '').trim() && env.GOOGLE_CLIENT_ID), browse: browse.availability(env).available, scholar: serplyKey && serpKey ? 'serply+serpapi' : serplyKey ? 'serply' : serpKey ? 'serpapi' : 'direct' },
          200,
          headers,
        );
      }

      // A Google sign-in, swapped for a pass: see server/passes.js. POST, from
      // this app only, with the signed-in person's Google access token.
      if (path === '/auth/google') {
        if (request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
        if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'not from this app' }, 403, headers);
        const secret = String(env.READER_TOKEN || '').trim();
        if (!secret || !env.GOOGLE_CLIENT_ID) {
          return json({ error: 'this Worker does not take Google sign-ins: it needs READER_TOKEN and GOOGLE_CLIENT_ID — see wrangler.toml' }, 501, headers);
        }
        const email = await googleEmail(request.headers.get('X-Google-Token') || '', env.GOOGLE_CLIENT_ID);
        if (!email) return json({ error: 'Google did not vouch for that sign-in; sign in again' }, 401, headers);
        // Anyone signed in, unless the owner has named who in READER_EMAILS.
        if (!emailAllowed(email, env.READER_EMAILS)) {
          return json({ error: `${email} is not on this proxy's list; ask whoever runs it to add you` }, 403, headers);
        }
        const pass = await issuePass(email, secret);
        tally(env, ctx, { email }, { signin: 1 });
        const { expires } = await readPass(pass, secret);
        return json({ pass, email, expires }, 200, { ...headers, 'Cache-Control': 'no-store' });
      }

      // Who uses this Worker's paid accounts, and how much: worker/usage.js.
      // The owner's alone — READER_TOKEN itself, not a pass.
      if (path === '/usage') {
        const who = await authorized(request, env);
        if (!who?.owner) return json({ error: 'the tally is for whoever holds READER_TOKEN' }, 401, headers);
        if (!env.USAGE) return json({ error: 'no USAGE object is bound here — see wrangler.toml' }, 501, headers);
        const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 30));
        const answer = await env.USAGE.get(env.USAGE.idFromName('usage')).fetch(`https://usage/report?days=${days}`);
        return json(await answer.json(), 200, { ...headers, 'Cache-Control': 'no-store' });
      }

      // A Worker has no disk and no GPU: the local workspace is the Node proxy's alone.
      if (path === '/workspace/status') {
        return json({ available: false, reason: 'The local workspace needs the proxy in server/ running on your own machine, with READER_WORKSPACE set.' }, 200, headers);
      }
      if (path.startsWith('/workspace/')) return json({ error: 'the local workspace is not available on a Worker' }, 404, headers);

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
        // Driving a browser takes the token; looking at whether there is one
        // to drive does not. The session object's own `/note-check` is the
        // Worker's to call from `/pdf`, never the internet's.
        const withToken = await authorized(request, env);
        if (changes && !withToken) return needsToken(env, headers);
        if (path === '/browse/open') tally(env, ctx, withToken, { browser: 1 });
        if (path === '/browse/note-check') return json({ error: 'not found' }, 404, headers);
        const client = clientOf(request, url);
        if (!client && path !== '/browse/status') return json({ error: 'no client id — this site is older than this Worker; reload it' }, 400, headers);
        const scoped = browse.forClient(env, client);
        const forClient = (search) => {
          const params = new URLSearchParams(search);
          if (client) params.set('client', client);
          const string = params.toString();
          return string ? `?${string}` : '';
        };

        // The stream: a WebSocket the session object answers with frames
        // and takes input on, handed through as it came, upgrade and all.
        // Only from this app — a browser sends its Origin on the handshake
        // — since what goes over it drives a signed-in browser.
        if (path === '/browse/stream') {
          if (!fromThisApp) return json({ error: 'not from this app' }, 403, headers);
          if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'a WebSocket upgrade' }, 426, headers);
          if (!env.BROWSER_SESSION) return json({ error: 'no session object holds the browser here; poll /browse/frame instead' }, 404, headers);
          return sessionStub(env, client).fetch(new URL(`https://browser-session/stream${forClient(url.search)}`), { headers: request.headers });
        }

        // Held open in a Durable Object where one is bound (the fast way,
        // and what wrangler.toml ships); reconnected per request otherwise.
        // The status too: the object knows whether it holds a browser, whether
        // an open is in flight and for how long, and what last went wrong.
        if (env.BROWSER_SESSION) {
          // The status of nobody's object in particular is the availability.
          if (path === '/browse/status' && !client) {
            return json({ ...browse.idle(env), browsers: await browse.limitsOf(env) }, 200, { ...headers, 'Cache-Control': 'no-store' });
          }
          const stub = sessionStub(env, client);
          const inner = new URL(`https://browser-session${path.replace(/^\/browse/, '')}${forClient(url.search)}`);
          const answer = await stub.fetch(inner, {
            method: request.method,
            headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
            body: request.method === 'POST' ? await request.text() : undefined,
          });
          // The status says where the page is and what it is called, and
          // hands the session back to whoever holds this client id — which
          // is a name anyone could send. Without the token it says only
          // whether a browser is held and what Cloudflare allows.
          if (path === '/browse/status' && !withToken) {
            const full = await answer.json().catch(() => ({}));
            const { session: _session, url: _url, title: _title, log: _log, lastError, frame: _frame, pdf: _pdf, ...rest } = full;
            return json(
              { ...rest, ...(lastError?.message ? { lastError: { message: lastError.message, at: lastError.at } } : {}) },
              answer.status,
              { ...headers, 'Cache-Control': 'no-store' },
            );
          }
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
          // With what Cloudflare will allow just now on it — how many browsers
          // are alive against how many may be, and whether another may be
          // started — which is the one place to look when it refuses.
          if (path === '/browse/status') {
            return json({ ...browse.idle(env), browsers: await browse.limitsOf(env) }, 200, { ...headers, 'Cache-Control': 'no-store' });
          }
          if (path === '/browse/open') {
            if (request.method !== 'POST') return json({ error: 'POST to open the browser' }, 405, headers);
            if (!fromThisApp) return json({ error: 'not from this app' }, 403, headers);
            try {
              return json({ ok: true, ...(await browse.open(scoped, url.searchParams.get('url') || '')) }, 200, { ...headers, 'Cache-Control': 'no-store' });
            } catch (error) {
              if (rateLimited(error)) throw error; // worded below, with the wait
              return json({ error: String(error?.message || error) }, 400, headers);
            }
          }
          if (path === '/browse/frame') {
            try {
              return json(await browse.frame(scoped, session), 200, { ...headers, 'Cache-Control': 'no-store' });
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
            return json(await browse.input(scoped, session, events), 200, { ...headers, 'Cache-Control': 'no-store' });
          }
          if (path === '/browse/grab' || path === '/browse/pdf') {
            if (path === '/browse/grab' && request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
            if (path === '/browse/grab' && !fromThisApp) return json({ error: 'not from this app' }, 403, headers);
            let bytes;
            try {
              bytes = await browse.grab(scoped, session);
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
            return json({ ok: true, ...(await browse.close(scoped, session)) }, 200, { ...headers, 'Cache-Control': 'no-store' });
          }
          return json({ error: 'not found' }, 404, headers);
        } catch (error) {
          if (error?.code === 'closed') return json({ error: 'no browser is open' }, 409, headers);
          if (String(error?.message || '').includes('browser binding')) return json({ error: String(error.message) }, 400, headers);
          // Cloudflare's own refusal, worded for the person, with which limit
          // it met and how long to wait (see the Durable Object, which also
          // waits it out; this fallback does not).
          if (rateLimited(error)) {
            const refused = refusal(error, await browse.limitsOf(env));
            return json({ error: refused.message, retryAfter: refused.retryAfter, browsers: refused.browsers }, 429, {
              ...headers,
              'Retry-After': String(refused.retryAfter),
            });
          }
          throw error;
        }
      }

      // Signing in with an institution needs a browser window on a screen,
      // and a Worker has neither. The app asks here before offering it, and
      // this is the answer that tells it to explain instead.
      if (path.startsWith('/access/')) {
        // "Forget sign-ins" has something to forget here only where the
        // cookies of a browser session were kept.
        const scoped = browse.forClient(env, clientOf(request, url));
        if (path === '/access/forget' && request.method === 'POST' && ALLOWED_ORIGINS.includes(origin)) {
          if (!(await authorized(request, env))) return needsToken(env, headers);
          return json({ ok: true, forgotten: await browse.forgetCookies(scoped) }, 200, headers);
        }
        const kept = env.SESSIONS && (await authorized(request, env)) ? (await browse.storedCookies(scoped)).length > 0 : false;
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
                  profileUrl(url.searchParams.get('user'), {
                    start: Math.max(0, Number(url.searchParams.get('start')) || 0),
                    sort: profileSort(url.searchParams.get('sort')),
                  })
                : path === '/scholar/person'
                ? /^[\w-]{6,32}$/.test(url.searchParams.get('user') || '') && profileUrl(url.searchParams.get('user'), { sort: 'citations' })
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
              : path === '/scholar/person'
              ? (html) => [parseProfile(html, url.searchParams.get('user'))].filter(Boolean)
              : path === '/scholar/work'
                ? parseCitationView
                : parseResults;
        const kind = path.replace('/scholar/', '');
        const query = (url.searchParams.get('q') || '').trim();
        const name = (url.searchParams.get('name') || '').trim();
        const user = (url.searchParams.get('user') || '').trim();
        const cluster = (url.searchParams.get('cluster') || '').trim();
        const citation = (url.searchParams.get('citation') || '').trim();
        const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
        const sort = profileSort(url.searchParams.get('sort'));
        // The person's name, where the app knows it: Serply finds works by name.
        const who = (url.searchParams.get('name') || '').trim().slice(0, 200) || undefined;
        const params =
          kind === 'search'
            ? query && { query, start: Math.min(90, start) }
            : kind === 'authors'
              ? name && { name }
              : kind === 'profile'
                ? /^[\w-]{6,32}$/.test(user) && { user, start, sort, name: who }
                : kind === 'person'
                ? /^[\w-]{6,32}$/.test(user) && { user, name: who }
                : kind === 'versions'
                  ? /^\d{1,25}$/.test(cluster) && { cluster, title: (url.searchParams.get('title') || '').trim().slice(0, 300) || undefined }
                  : kind === 'work'
                    ? /^[\w-]{6,32}$/.test(user) && /^[\w-]{6,32}:[\w-]{6,32}$/.test(citation) && { user, citation }
                    : null;
        // Serply or SerpApi, whichever answers this ask better first and the
        // other when it refuses — see server/scholarServices.js.
        if (serplyKey || serpKey) {
          // Both are metered on the account whose key it is.
          const who = await authorized(request, env);
          if (!who) return needsToken(env, headers);
          if (await personOverLimit(env, who)) {
            return json({ error: 'too many Scholar searches at once; try again in a minute' }, 429, { ...headers, 'Retry-After': '60' });
          }
          try {
            const { results, via, spent } = await askServices(kind, params, { serply: serplyKey, serpapi: serpKey });
            tally(env, ctx, who, { scholar: 1, ...spent });
            return json({ results, source: 'scholar', via }, 200, { ...headers, 'Cache-Control': 'private, max-age=300' });
          } catch (error) {
            tally(env, ctx, who, { scholar: 1, ...(error?.spent || {}) });
            if (error && error.serply) return json({ error: error.message, serply: true, reason: error.reason }, 503, headers);
            if (error && error.serpapi) return json({ error: error.message, serpapi: true, reason: error.reason }, 503, headers);
            return json({ error: String(error?.message || error) }, 502, headers);
          }
        }
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
          // Followed wherever arXiv sent it, which had better still be arXiv.
          if (!upstream.ok || !ASSET_HOSTS.has(new URL(upstream.url).hostname)) continue;
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
        // Whose request: with the token, the sign-in kept for this client is
        // tried on a login wall and a browser at Browserless on a check for
        // a person; without it the file is fetched plainly or not at all.
        const withToken = await authorized(request, env);
        tally(env, ctx, withToken, { pdf: 1 });
        const scoped = browse.forClient(env, withToken ? clientOf(request, url) : '');
        if (!withToken && (await overLimit(env, request))) {
          return json({ error: 'too many files at once from this address; try again in a minute' }, 429, { ...headers, 'Retry-After': '60' });
        }

        const servePdfBytes = (bytes) =>
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
        // A paper on OpenReview is asked for from its API, never the site,
        // which answers every fetch with a check Cloudflare's browser never
        // passes; signed in with the account the Worker is given, since the
        // check now stands in front of the API too (server/openreview.js).
        if (openReviewFiles(target).length) {
          const { response: answer, said } = await fetchOpenReview(target, { env, userAgent: UA });
          if (answer) {
            try {
              return servePdfBytes(await readPdf(answer, answer.headers.get('content-type')));
            } catch (error) {
              said.push(String(error?.message || error));
            }
          }
          // The site itself answers every fetch from here with its check, so
          // there is no use asking it: say what the API said instead, and
          // what would get past it.
          const fix = openReviewAccount(env)
            ? ''
            : saidChallenge(said)
              ? ' — give the Worker an OpenReview account (the OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD secrets) and it signs in, which skips the check'
              : '';
          return json(
            {
              error: `OpenReview's API would not hand over the file (${said.join('; ') || 'no answer'})${fix}`,
              botCheck: true,
              loginWall: true,
              where: 'cloudflare',
              host: 'openreview.net',
            },
            502,
            headers,
          );
        }

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
          const pmc = await fromPmc();
          if (pmc) return servePdf(pmc);
          const cookie = withToken ? browse.cookieHeaderFor(await browse.storedCookies(scoped), target) : '';
          if (cookie) {
            try {
              const retry = await fetchChecked(target, { userAgent: UA, headers: { Cookie: cookie } });
              if (retry.response.ok) {
                const bytes = await readPdf(retry.response, retry.response.headers.get('content-type'));
                return servePdf(bytes, { private: true });
              }
            } catch {
              // Signed in, but not to this; say what the first attempt said.
            }
          }
          return json({ error, loginWall: true, host }, status, headers);
        };
        // A file that came through someone's sign-in, or a browser passing
        // a check on their behalf, is theirs: nothing on the way may keep it.
        const servePdf = (bytes, { private: mine = false } = {}) =>
          new Response(bytes, {
            headers: {
              ...headers,
              'Content-Type': 'application/pdf',
              'Content-Length': String(bytes.length),
              'Content-Disposition': disposition(url.searchParams),
              'Cache-Control': mine ? 'private, no-store' : 'public, max-age=86400',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        // A paper in PubMed Central whose page would not hand over the file
        // is asked for the way PubMed Central means programs to (server/pmc.js).
        const fromPmc = async () => {
          for (const file of await pmcFiles(target, { userAgent: UA })) {
            try {
              const { response: answer } = await fetchChecked(file, { userAgent: UA });
              if (answer.ok) return await readPdf(answer, answer.headers.get('content-type'));
            } catch {
              // The next file, or none.
            }
          }
          return null;
        };

        // A site's check for a person, served in place of the file: Cloudflare
        // marks it with this header whatever the status code. A Worker cannot
        // answer it, and its browser cannot pass it either — Cloudflare
        // identifies its own rendering browsers as bots to every site it
        // protects — so this is said plainly, for the app to point elsewhere,
        // rather than as a login wall that a sign-in here would get past.
        //
        // Unless there is a browser elsewhere (worker/browserless.js): then
        // the file is asked for from a Browserless page, which passes the
        // checks that need no box and hands the file back; one that needs a
        // person is said so, with the host remembered by the session object,
        // so that the pane the app then offers opens at Browserless straight
        // away — and the offer stands, as it does from the Node proxy.
        if ((response.headers.get('cf-mitigated') || '').trim().toLowerCase() === 'challenge') {
          const pmc = await fromPmc();
          if (pmc) return servePdf(pmc);
          // Browserless is metered on the account whose token this is, and
          // the browser there carries this person's sign-in: with the token only.
          if (browserless.configured(env) && withToken) {
            const got = await browserless.fetchFile(scoped, target, { restoreCookies: browse.restoreCookies, saveCookies: browse.saveCookies });
            if (got?.bytes) return servePdf(got.bytes, { private: true });
            const client = clientOf(request, url);
            if (env.BROWSER_SESSION && client) {
              await sessionStub(env, client)
                .fetch(`https://browser-session/note-check?host=${encodeURIComponent(host)}&client=${encodeURIComponent(client)}`, { method: 'POST' })
                .catch(() => undefined);
            }
            return json(
              {
                error: `${host} checks for a person before it hands out the file, and the browser at Browserless met a box to tick — open a browser here and tick it`,
                botCheck: true,
                loginWall: true,
                where: 'browserless',
                host,
              },
              502,
              headers,
            );
          }
          return json(
            {
              error: `${host} checks for a person before it hands out the file, and Cloudflare refuses the Worker's requests to such a check`,
              botCheck: true,
              where: 'cloudflare',
              host,
            },
            502,
            headers,
          );
        }
        if (!response.ok) {
          const error = `the publisher answered ${response.status} for that PDF`;
          if (response.status === 401 || response.status === 403) return loginWall(502, error);
          const pmc = await fromPmc();
          if (pmc) return servePdf(pmc);
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
        if (!ASSET_HOSTS.has(new URL(upstream.url).hostname)) return json({ error: 'host not allowed' }, 403, headers);
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
