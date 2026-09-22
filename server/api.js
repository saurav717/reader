// Connect-style handler mounted at /api by both the Vite dev server and the
// production Express server. Everything here exists because the browser cannot
// fetch it directly: arXiv serves no CORS headers, and neither do most of the
// publishers and repositories an open-access PDF link points at.

import { disposition, fetchChecked, readPdf, rejectUrl } from './fetchPdf.js';
import * as access from './access.js';
import {
  authorSearchUrl,
  getScholar,
  isScholarUrl,
  parseAuthors,
  parseProfileWorks,
  parseResults,
  plainFetch,
  profileUrl,
  searchUrl,
  versionsUrl,
} from './scholar.js';
import { captchaStatus, closeCaptcha, openCaptcha, scholarFetcher } from './scholarBrowser.js';
import { askSerp } from './serpapi.js';

const ARXIV_ID = /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[0-9]+)?$/;

const UA = 'reader/0.1 (personal research reading tool)';

// Which other origins may call this proxy. The site on GitHub Pages can be
// pointed at a proxy on your own machine — Settings → Paper proxy,
// http://localhost:8080 — which is the one way the institutional sign-in
// below can work for it, since a Worker has no window to sign in with. A
// proxy that answered every origin would be one anyone could fetch through,
// so the list is short, and ALLOWED_ORIGINS (comma-separated) extends it.
const ALLOWED_ORIGINS = new Set(
  [
    'https://saurav717.github.io',
    'http://localhost:5173',
    'http://localhost:8080',
    ...(process.env.ALLOWED_ORIGINS || '').split(','),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean),
);

/** CORS headers for a cross-origin caller we allow, else none. */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Whether a request that changes something — opens a window, forgets the
 * sign-ins — came from this app. A page on any other site could POST here
 * without reading the answer, and opening browser windows on somebody's
 * machine at a URL of another site's choosing is not something to allow.
 */
function fromThisApp(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin without an Origin header: not a browser, or an old one
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

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
    'Content-Disposition': disposition(url.searchParams),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

// Any other open-access PDF: OpenAlex and Semantic Scholar hand out links to
// publishers and repositories that send no CORS headers either, so the browser
// needs this route to read them. See server/fetchPdf.js for what it refuses.
async function pdf(url, res) {
  const target = url.searchParams.get('url') || '';
  const reason = rejectUrl(target);
  if (reason) return send(res, 400, { error: reason });
  const host = new URL(target).hostname;

  // A login wall is the one failure a person can do something about: sign in
  // through their institution, in a window this proxy opens, and ask again.
  // The answer says when that is what happened, so the app can offer it.
  const loginWall = async (status, error) => {
    if (access.everSignedIn()) {
      try {
        const bytes = await access.fetchWithSession(target);
        return servePdf(res, url, bytes);
      } catch (retry) {
        return send(res, status, { error: `${error}; ${retry?.message || retry}`, loginWall: true, host });
      }
    }
    return send(res, status, { error, loginWall: true, host });
  };

  let result;
  try {
    result = await fetchChecked(target, { userAgent: UA });
  } catch (error) {
    return send(res, 400, { error: String(error?.message || error) });
  }
  const { response } = result;
  if (!response.ok) {
    const error = `the publisher answered ${response.status} for that PDF`;
    if (response.status === 401 || response.status === 403) return loginWall(502, error);
    return send(res, response.status === 404 ? 404 : 502, { error });
  }

  let bytes;
  try {
    bytes = await readPdf(response, response.headers.get('content-type'));
  } catch (error) {
    const message = String(error?.message || error);
    if (/web page/.test(message)) return loginWall(415, message);
    return send(res, 415, { error: message });
  }
  return servePdf(res, url, bytes);
}

function servePdf(res, url, bytes) {
  const buffer = Buffer.from(bytes);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': disposition(url.searchParams),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

// ------------------------------------------------------ institutional ----
//
// Signing in with an institution, for the publishers that want one before
// they hand over a PDF. See server/access.js: a real browser window opens on
// the machine this runs on, the person signs in there, and from then on a
// login wall is retried through that browser's profile.

async function accessSignIn(req, url, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST to open a sign-in window' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  const target = url.searchParams.get('url') || '';
  try {
    return send(res, 200, { ok: true, ...(await access.openSignIn(target)) });
  } catch (error) {
    return send(res, 400, { error: String(error?.message || error) });
  }
}

async function accessAction(req, res, action) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  try {
    return send(res, 200, { ok: true, ...(await action()) });
  } catch (error) {
    return send(res, 502, { error: String(error?.message || error) });
  }
}

// ------------------------------------------------------------- Scholar ----
//
// Google publishes no API for Scholar, so these routes fetch the pages a
// person would open and parse them. See server/scholar.js for what that costs
// and how often it is refused; a captcha comes back as 503 with
// `blocked: true`, which is how the app knows to say so and use its other
// sources rather than showing an empty list — and with the page that was
// refused, so the app can offer to show the captcha. `/scholar/captcha`
// opens that page in a real browser window on this machine, the person
// solves it there, and Scholar is asked again through that browser. See
// server/scholarBrowser.js.

/** A stand-in for the fetch, when a test or a script has handed one in. */
let fetchPage;
const scholarPage = async (url, options) => {
  if (fetchPage) return fetchPage(url, options);
  // Decided per request rather than once: a captcha solved along the way
  // moves Scholar from plain requests to the browser that solved it.
  const fetcher = await scholarFetcher(plainFetch);
  return fetcher(url, options);
};

/**
 * Swap in another way of getting a Scholar page. The end-to-end test hands in
 * saved fixtures so that it exercises these routes and the parsing for real
 * without anything leaving the machine; `scripts/scholar-live.mjs` uses it the
 * other way, to force a browser.
 */
export function setScholarFetcher(fetcher) {
  fetchPage = fetcher;
}

/**
 * With a SerpApi key on this proxy, Scholar is asked through SerpApi instead
 * — see server/serpapi.js: JSON back, no captcha, and it works from a
 * server. Without one, the page itself, as above.
 */
const serpKey = () => (process.env.SERPAPI_KEY || '').trim();

/** How this proxy asks Scholar, for /health and for anyone wondering. */
export const scholarVia = () => (serpKey() ? 'serpapi' : 'direct');

async function scholar(res, { kind, params, url, parse }) {
  try {
    const results = serpKey()
      ? await askSerp(kind, params, serpKey())
      : parse(await getScholar(url, { fetchPage: scholarPage }));
    return send(res, 200, { results, source: 'scholar', via: scholarVia() }, { 'Cache-Control': 'private, max-age=300' });
  } catch (error) {
    if (error && error.blocked) {
      return send(res, 503, { error: error.message, blocked: true, reason: error.reason, url: error.url });
    }
    if (error && error.serpapi) {
      return send(res, 503, { error: error.message, serpapi: true, reason: error.reason });
    }
    return send(res, 502, { error: String(error?.message || error) });
  }
}

// The captcha, shown to a person. A POST, and only from this app: it opens a
// window on the machine the proxy runs on, which is not something a page on
// another site should be able to do — and only ever at a Scholar page, which
// openCaptcha checks.
async function scholarCaptcha(req, url, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST to open the captcha in a window' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  const target = url.searchParams.get('url') || '';
  if (!isScholarUrl(target)) return send(res, 400, { error: 'only a scholar.google.com page can be opened here' });
  try {
    return send(res, 200, { ok: true, ...(await openCaptcha(target)) });
  } catch (error) {
    return send(res, 400, { error: String(error?.message || error) });
  }
}

function scholarSearch(url, res) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return send(res, 400, { error: 'q is required' });
  const start = Math.max(0, Math.min(90, Number(url.searchParams.get('start')) || 0));
  return scholar(res, { kind: 'search', params: { query, start }, url: searchUrl(query, { start }), parse: parseResults });
}

function scholarAuthors(url, res) {
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return send(res, 400, { error: 'name is required' });
  return scholar(res, { kind: 'authors', params: { name }, url: authorSearchUrl(name), parse: parseAuthors });
}

function scholarProfile(url, res) {
  const user = (url.searchParams.get('user') || '').trim();
  if (!/^[\w-]{6,32}$/.test(user)) return send(res, 400, { error: 'bad Scholar profile id' });
  const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
  return scholar(res, { kind: 'profile', params: { user, start }, url: profileUrl(user, { start }), parse: parseProfileWorks });
}

function scholarVersions(url, res) {
  const cluster = (url.searchParams.get('cluster') || '').trim();
  if (!/^\d{1,25}$/.test(cluster)) return send(res, 400, { error: 'bad cluster id' });
  return scholar(res, { kind: 'versions', params: { cluster }, url: versionsUrl(cluster), parse: parseResults });
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
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (Object.keys(cors).length) {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => writeHead(status, { ...cors, ...(headers || {}) });
  }
  try {
    switch (url.pathname) {
      case '/arxiv/query':
        return await arxivQuery(url, res);
      case '/arxiv/html':
        return await arxivHtml(url, res);
      case '/arxiv/pdf':
        return await arxivPdf(url, res);
      case '/pdf':
        return await pdf(url, res);
      case '/scholar/search':
        return await scholarSearch(url, res);
      case '/scholar/authors':
        return await scholarAuthors(url, res);
      case '/scholar/profile':
        return await scholarProfile(url, res);
      case '/scholar/versions':
        return await scholarVersions(url, res);
      case '/scholar/captcha':
        return await scholarCaptcha(req, url, res);
      case '/scholar/captcha/status':
        return send(res, 200, await captchaStatus(), { 'Cache-Control': 'no-store' });
      case '/scholar/captcha/close':
        return await accessAction(req, res, () => closeCaptcha());
      case '/asset':
        return await asset(url, res);
      case '/access/status':
        return send(res, 200, await access.status(), { 'Cache-Control': 'no-store' });
      case '/access/signin':
        return await accessSignIn(req, url, res);
      case '/access/close':
        return await accessAction(req, res, () => access.closeSignIn());
      case '/access/forget':
        return await accessAction(req, res, () => access.forget());
      case '/health':
        return send(res, 200, { ok: true, access: (await access.availability()).available, scholar: scholarVia() });
      default:
        if (next) return next();
        return send(res, 404, { error: 'not found' });
    }
  } catch (error) {
    return send(res, 502, { error: String(error && error.message ? error.message : error) });
  }
}
