// Connect-style handler mounted at /api by both the Vite dev server and the
// production Express server. Everything here exists because the browser cannot
// fetch it directly: arXiv serves no CORS headers, and neither do most of the
// publishers and repositories an open-access PDF link points at.

import { disposition, FETCH_TIMEOUT_MS, fetchChecked, readPdf, rejectUrl, worded } from './fetchPdf.js';
import { loopbackHost, privateReason, rateLimit, tokenRefusal, tokenRequired, validToken } from './guard.js';
import { fetchOpenReview, openReviewFiles } from './openreview.js';
import { pmcFiles } from './pmc.js';
import * as access from './access.js';
import {
  authorSearchUrl,
  getScholar,
  isScholarUrl,
  parseAuthors,
  parseCitationView,
  parseProfile,
  parseProfileWorks,
  parseResults,
  plainFetch,
  profileUrl,
  profileSort,
  searchUrl,
  versionsUrl,
  workUrl,
} from './scholar.js';
import { captchaStatus, closeCaptcha, openCaptcha, scholarFetcher } from './scholarBrowser.js';
import * as browse from './browse.js';
import { askSerp } from './serpapi.js';
import { askSerply } from './serply.js';
import * as workspace from './workspace.js';

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
    // The browser session's input arrives as JSON; the token from Settings
    // rides in Authorization; and X-Reader-Client is the app's own id for
    // the browser it is in. A cross-origin request may send none of these
    // unless they are named here.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Reader-Client',
    'Access-Control-Max-Age': '86400',
  };
}

/** A small JSON body, read by hand: nothing here mounts a body parser. */
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(worded('that request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(worded('that request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Whether a request that changes something — opens a window, forgets the
 * sign-ins — came from this app. A page on any other site could POST here
 * without reading the answer, and opening browser windows on somebody's
 * machine at a URL of another site's choosing is not something to allow.
 *
 * A browser names where a cross-origin POST came from in Origin, and that
 * has to be one of ours. No Origin at all is not a browser page — curl, a
 * script, an old browser on the same origin — and is taken at its word only
 * when it can show something a page on another site cannot: the token, or
 * a Host header that says the request came in over loopback, which a page
 * elsewhere cannot reach. The Host header on its own proves nothing — the
 * one asking chose it — so it is never compared against the Origin.
 */
export function fromThisApp(req) {
  const origin = req.headers.origin;
  if (origin) return ALLOWED_ORIGINS.has(origin);
  if (validToken(req)) return true;
  return loopbackHost(req.headers.host);
}

/**
 * Answers a gated route when the request may not use it, and says so with
 * true; null when it may. See server/guard.js for which routes and why.
 */
function gate(req, res) {
  const reason = tokenRefusal(req);
  if (!reason) return null;
  send(res, 401, { error: reason, auth: true }, { 'Cache-Control': 'no-store' });
  return true;
}

/**
 * Answers a route that costs something when this client has asked for it
 * too often lately, and says so with true; null otherwise. The token
 * exempts a request, since it says who is asking; without one the client's
 * address is all there is.
 */
function limited(req, res, kind) {
  const retryAfter = rateLimit(req, kind);
  if (retryAfter === null) return null;
  send(res, 429, { error: 'too many requests — try again in a moment' }, { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' });
  return true;
}

/**
 * What to tell the person about an error: its message when it was written
 * for them (`worded` in server/fetchPdf.js), and a short generic line
 * otherwise, with the real one on the server's log. A library's message —
 * a DNS failure, a TLS complaint, Playwright's call log — is for whoever
 * runs the proxy, not for a page on the other side of it.
 */
function said(error, fallback = 'could not fetch that') {
  if (error?.forPerson || error?.code === 'closed') return String(error.message);
  console.warn(`[api] ${fallback}: ${error?.stack || error?.message || error}`);
  return fallback;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** How a fetch to arXiv is made: named, and given up on after a while. */
const upstreamInit = (extra = {}) => ({ headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...extra });

async function arxivQuery(url, res) {
  const params = new URLSearchParams();
  for (const key of ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder']) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  if (!params.has('search_query') && !params.has('id_list')) {
    return send(res, 400, { error: 'search_query or id_list is required' });
  }
  const upstream = await fetch(`https://export.arxiv.org/api/query?${params}`, upstreamInit());
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
      const upstream = await fetch(candidate.url, upstreamInit({ redirect: 'follow' }));
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
  const upstream = await fetch(`https://arxiv.org/pdf/${id}`, upstreamInit({ redirect: 'follow' }));
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
async function pdf(req, url, res) {
  const target = url.searchParams.get('url') || '';
  const reason = rejectUrl(target) || (await privateReason(target));
  if (reason) return send(res, 400, { error: reason });
  const host = new URL(target).hostname;
  // Every fetch below re-checks each hop, by name and by what DNS says of it.
  const options = { userAgent: UA, check: privateReason };

  // A login wall is the one failure a person can do something about: sign in
  // through their institution, in a window this proxy opens, and ask again.
  // The answer says when that is what happened, so the app can offer it —
  // and when what stood in the way was a site's check for a person rather
  // than a sign-in (`botCheck`), which a window on this machine passes too.
  const loginWall = async (status, error, extra = {}) => {
    const pmc = await fromPmc();
    if (pmc) return servePdf(res, url, pmc);
    // The retry reads with somebody's institutional session, which is
    // not something to hand to whoever can reach the proxy: with a token
    // set, the token; without one, the loopback-only proxy on this machine.
    if (access.everSignedIn() && !tokenRefusal(req)) {
      try {
        const bytes = await access.fetchWithSession(target);
        return servePdf(res, url, bytes, { private: true });
      } catch (retry) {
        return send(res, status, { error: `${error}; ${said(retry, 'the signed-in browser could not fetch it either')}`, loginWall: true, host, ...extra });
      }
    }
    return send(res, status, { error, loginWall: true, host, ...extra });
  };
  // A paper in PubMed Central whose page would not hand over the file is
  // asked for the way PubMed Central means programs to (server/pmc.js).
  const fromPmc = async () => {
    for (const file of await pmcFiles(target, { userAgent: UA })) {
      try {
        const { response } = await fetchChecked(file, options);
        if (response.ok) return await readPdf(response, response.headers.get('content-type'));
      } catch {
        // The next file, or none.
      }
    }
    return null;
  };

  // A paper on OpenReview is asked for from its API first: the web site
  // answers every fetch with a check of its own (server/openreview.js).
  if (openReviewFiles(target).length) {
    const { response } = await fetchOpenReview(target, { env: process.env, userAgent: UA });
    if (response) {
      try {
        return servePdf(res, url, await readPdf(response, response.headers.get('content-type')));
      } catch {
        // The site itself, then.
      }
    }
  }

  let result;
  try {
    result = await fetchChecked(target, options);
  } catch (error) {
    return send(res, error?.forPerson ? 400 : 502, { error: said(error) });
  }
  const { response } = result;
  // Cloudflare marks the check it serves in place of a page, whatever the
  // status code — see `challengedHost` in server/browseShared.js.
  if ((response.headers.get('cf-mitigated') || '').trim().toLowerCase() === 'challenge') {
    return loginWall(502, `${host} checks for a person before it hands out the file, and this proxy's own fetch cannot answer that check`, {
      botCheck: true,
      where: 'proxy',
    });
  }
  if (!response.ok) {
    const error = `the publisher answered ${response.status} for that PDF`;
    if (response.status === 401 || response.status === 403) return loginWall(502, error);
    const pmc = await fromPmc();
    if (pmc) return servePdf(res, url, pmc);
    return send(res, response.status === 404 ? 404 : 502, { error });
  }

  let bytes;
  try {
    bytes = await readPdf(response, response.headers.get('content-type'));
  } catch (error) {
    const message = said(error, 'could not read that PDF');
    if (/web page/.test(message)) return loginWall(415, message);
    return send(res, 415, { error: message });
  }
  return servePdf(res, url, bytes);
}

/**
 * The file, to the app. A public PDF may be cached by anything between here
 * and the app; one fetched with somebody's sign-in (`private`) may not —
 * it is theirs, and a shared cache would hand it to the next person.
 */
function servePdf(res, url, bytes, { private: personal = false } = {}) {
  const buffer = Buffer.from(bytes);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': disposition(url.searchParams),
    'Cache-Control': personal ? 'private, no-store' : 'public, max-age=86400',
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
    return send(res, 400, { error: said(error, 'could not open the sign-in window') });
  }
}

async function accessAction(req, res, action) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  try {
    return send(res, 200, { ok: true, ...(await action()) });
  } catch (error) {
    return send(res, 502, { error: said(error, 'could not do that') });
  }
}

// ------------------------------------------------------ browser session ----
//
// The browser inside the reader: the same profile as the sign-in window,
// headless, streamed into the app as pictures and driven from there. See
// server/browse.js. Everything that opens, drives or closes it is a POST
// from this app only — a page on another site could otherwise steer a
// signed-in browser on somebody's proxy — and the frames are GETs the
// app's origin may read, like every other answer here.

async function browseOpen(req, url, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST to open the browser' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  try {
    return send(res, 200, { ok: true, ...(await browse.open(url.searchParams.get('url') || '')) }, { 'Cache-Control': 'no-store' });
  } catch (error) {
    return send(res, 400, { error: said(error, 'could not open the browser') });
  }
}

async function browseFrame(url, res) {
  const after = Number(url.searchParams.get('after'));
  const wait = url.searchParams.get('wait') !== '0';
  const answer = wait
    ? await browse.waitForChange(Number.isFinite(after) ? after : -1)
    : await browse.status(Number.isFinite(after) ? after : -1);
  return send(res, 200, answer, { 'Cache-Control': 'no-store' });
}

async function browseInput(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  let events;
  try {
    const body = await readJson(req);
    events = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
  } catch (error) {
    return send(res, 400, { error: said(error, 'could not read that') });
  }
  if (events.length > 64) return send(res, 400, { error: 'too many events at once' });
  try {
    for (const event of events) await browse.input(event || {});
    return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
  } catch (error) {
    return send(res, error?.code === 'closed' ? 409 : 400, { error: said(error, 'the browser could not do that') });
  }
}

async function browseGrab(req, url, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  try {
    await browse.grab();
  } catch (error) {
    return send(res, error?.code === 'closed' ? 409 : 404, { error: said(error, 'no PDF could be fetched from that page') });
  }
  return browsePdf(url, res);
}

function browsePdf(url, res) {
  const bytes = browse.pdfBytes();
  if (!bytes) return send(res, 404, { error: 'the browser has not met a PDF yet' });
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': bytes.length,
    'Content-Disposition': disposition(url.searchParams),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(bytes);
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
 * With a Serply or a SerpApi key on this proxy, Scholar is asked through
 * them instead — see server/serply.js and server/serpapi.js: no captcha, and
 * it works from a server. Serply fetches Scholar's own pages, read by the
 * parsers here; SerpApi answers JSON. With both, Serply first and SerpApi
 * when Serply refuses. Without either, the page itself, as above.
 */
const serpKey = () => (process.env.SERPAPI_KEY || '').trim();
const serplyKey = () => (process.env.SERPLY_KEY || '').trim();

/** How this proxy asks Scholar, for /health and for anyone wondering. */
export const scholarVia = () => (serplyKey() ? 'serply' : serpKey() ? 'serpapi' : 'direct');

/** One ask of Scholar, by whichever way this proxy has: the results and which answered. */
async function askScholar({ kind, params, url, parse }) {
  if (serplyKey()) {
    try {
      return { results: await askSerply(url, parse, serplyKey()), via: 'serply' };
    } catch (error) {
      if (!(error && error.serply && serpKey())) throw error;
    }
  }
  if (serpKey()) return { results: await askSerp(kind, params, serpKey()), via: 'serpapi' };
  return { results: parse(await getScholar(url, { fetchPage: scholarPage })), via: 'direct' };
}

async function scholar(req, res, ask) {
  // Serply and SerpApi are metered on this proxy's keys, so with a token set
  // only the token may spend them. Scholar asked directly costs nothing but
  // Google's patience, and stays open.
  if (serplyKey() || serpKey()) {
    const refused = gate(req, res);
    if (refused) return refused;
  }
  try {
    const { results, via } = await askScholar(ask);
    return send(res, 200, { results, source: 'scholar', via }, { 'Cache-Control': 'private, max-age=300' });
  } catch (error) {
    if (error && error.blocked) {
      return send(res, 503, { error: error.message, blocked: true, reason: error.reason, url: error.url });
    }
    if (error && error.serply) {
      return send(res, 503, { error: error.message, serply: true, reason: error.reason });
    }
    if (error && error.serpapi) {
      return send(res, 503, { error: error.message, serpapi: true, reason: error.reason });
    }
    return send(res, 502, { error: said(error, 'could not reach Scholar') });
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
    return send(res, 400, { error: said(error, 'could not open the captcha window') });
  }
}

function scholarSearch(req, url, res) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return send(res, 400, { error: 'q is required' });
  const start = Math.max(0, Math.min(90, Number(url.searchParams.get('start')) || 0));
  return scholar(req, res, { kind: 'search', params: { query, start }, url: searchUrl(query, { start }), parse: parseResults });
}

function scholarAuthors(req, url, res) {
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return send(res, 400, { error: 'name is required' });
  return scholar(req, res, { kind: 'authors', params: { name }, url: authorSearchUrl(name), parse: parseAuthors });
}

function scholarProfile(req, url, res) {
  const user = (url.searchParams.get('user') || '').trim();
  if (!/^[\w-]{6,32}$/.test(user)) return send(res, 400, { error: 'bad Scholar profile id' });
  const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
  const sort = profileSort(url.searchParams.get('sort'));
  return scholar(req, res, {
    kind: 'profile',
    params: { user, start, sort },
    url: profileUrl(user, { start, sort }),
    parse: parseProfileWorks,
  });
}

// One person, from the top of their profile: name, place, interests, their
// citations, h-index and i10-index, and their most cited works. The hover
// card over an author asks for it once it knows which profile is theirs.
function scholarPerson(req, url, res) {
  const user = (url.searchParams.get('user') || '').trim();
  if (!/^[\w-]{6,32}$/.test(user)) return send(res, 400, { error: 'bad Scholar profile id' });
  return scholar(req, res, {
    kind: 'person',
    params: { user },
    url: profileUrl(user, { sort: 'citations' }),
    parse: (html) => [parseProfile(html, user)].filter(Boolean),
  });
}

/** Valid as far as the routes are concerned: a profile id, and an entry's `<user>:<code>`. */
export const PROFILE_ID = /^[\w-]{6,32}$/;
export const CITATION_ID = /^[\w-]{6,32}:[\w-]{6,32}$/;

// One entry on a profile, opened: where the file Scholar found for it, and
// the cluster it belongs to, are shown. The list gives neither, so the app
// asks for this when it comes to reading one of a profile's papers.
function scholarWork(req, url, res) {
  const user = (url.searchParams.get('user') || '').trim();
  const citation = (url.searchParams.get('citation') || '').trim();
  if (!PROFILE_ID.test(user)) return send(res, 400, { error: 'bad Scholar profile id' });
  if (!CITATION_ID.test(citation)) return send(res, 400, { error: 'bad Scholar citation id' });
  return scholar(req, res, {
    kind: 'work',
    params: { user, citation },
    url: workUrl(user, citation),
    parse: parseCitationView,
  });
}

function scholarVersions(req, url, res) {
  const cluster = (url.searchParams.get('cluster') || '').trim();
  if (!/^\d{1,25}$/.test(cluster)) return send(res, 400, { error: 'bad cluster id' });
  return scholar(req, res, { kind: 'versions', params: { cluster }, url: versionsUrl(cluster), parse: parseResults });
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
  // The hosts are arXiv's own, but a name is only a name until DNS says.
  if (await privateReason(parsed.toString())) return send(res, 403, { error: 'host not allowed' });
  const upstream = await fetch(parsed, upstreamInit({ redirect: 'follow' }));
  if (!upstream.ok) return send(res, upstream.status, { error: 'upstream error' });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buffer);
}

/**
 * The status of the browser inside the reader, for whoever asks. Where the
 * browser is, what the page is called and the picture of it are what the
 * person signed in there is looking at, so those go only to the token when
 * one is wanted; the rest — whether it could open, whether anything is —
 * is what the app needs to offer it, and is public.
 */
async function browseStatus(req, res) {
  const full = await browse.status();
  if (!tokenRequired() || validToken(req)) return send(res, 200, full, { 'Cache-Control': 'no-store' });
  const { url, title, frame, pdf, check, ...rest } = full;
  return send(res, 200, { ...rest, pdf: pdf ? { size: pdf.size } : null }, { 'Cache-Control': 'no-store' });
}

/**
 * The routes that want the token, when one is wanted — see server/guard.js.
 * Everything under /browse and /access but the two status routes, the
 * captcha window, and the routes above that spend on what is this proxy's.
 */
function gated(pathname) {
  if (pathname === '/browse/status' || pathname === '/access/status') return false;
  return pathname.startsWith('/browse/') || pathname.startsWith('/access/') || pathname.startsWith('/scholar/captcha') || pathname.startsWith('/workspace/');
}

// ------------------------------------------------------------ workspace ----
//
// The Implementation page's scaffold, on this machine: what the machine is,
// the files written under READER_WORKSPACE, and a command run there with its
// output streamed back. See server/workspace.js. Writing and running are
// POSTs from this app only; the whole prefix is gated by the token when one
// is wanted, since a run is a shell on the proxy's machine.

async function workspaceScaffold(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST the files to write' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  try {
    const body = await readJson(req, 4 * 1024 * 1024);
    return send(res, 200, { ok: true, ...(await workspace.writeScaffold(body)) }, { 'Cache-Control': 'no-store' });
  } catch (error) {
    return send(res, 400, { error: said(error, 'could not write the scaffold') });
  }
}

async function workspaceRun(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST the command to run' });
  if (!fromThisApp(req)) return send(res, 403, { error: 'not from this app' });
  let body;
  try {
    body = await readJson(req);
    workspace.run(body, res, req);
  } catch (error) {
    return send(res, 400, { error: said(error, 'could not run that') });
  }
}

/** Which rate-limit bucket a route draws from, if any. */
function costOf(pathname) {
  if (pathname === '/pdf' || pathname === '/asset') return 'pdf';
  if (pathname.startsWith('/scholar/') && !pathname.startsWith('/scholar/captcha')) return 'scholar';
  if (pathname === '/browse/open') return 'browse';
  return null;
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
  if (gated(url.pathname)) {
    const refused = gate(req, res);
    if (refused) return refused;
  }
  const cost = costOf(url.pathname);
  if (cost) {
    const held = limited(req, res, cost);
    if (held) return held;
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
        return await pdf(req, url, res);
      case '/scholar/search':
        return await scholarSearch(req, url, res);
      case '/scholar/authors':
        return await scholarAuthors(req, url, res);
      case '/scholar/profile':
        return await scholarProfile(req, url, res);
      case '/scholar/person':
        return await scholarPerson(req, url, res);
      case '/scholar/versions':
        return await scholarVersions(req, url, res);
      case '/scholar/work':
        return await scholarWork(req, url, res);
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
      case '/browse/status':
        return await browseStatus(req, res);
      case '/browse/open':
        return await browseOpen(req, url, res);
      case '/browse/frame':
        return await browseFrame(url, res);
      case '/browse/input':
        return await browseInput(req, res);
      case '/browse/grab':
        return await browseGrab(req, url, res);
      case '/browse/pdf':
        return browsePdf(url, res);
      case '/browse/close':
        return await accessAction(req, res, () => browse.close());
      case '/workspace/status':
        return send(res, 200, await workspace.status(), { 'Cache-Control': 'no-store' });
      case '/workspace/scaffold':
        return await workspaceScaffold(req, res);
      case '/workspace/run':
        return await workspaceRun(req, res);
      case '/health':
        return send(res, 200, {
          ok: true,
          access: (await access.availability()).available,
          browse: (await access.browseAvailability()).available,
          scholar: scholarVia(),
          /** Whether the sign-in and browser routes want a token — so the app can ask for one. */
          auth: tokenRequired(),
          /** Whether READER_WORKSPACE names a directory the Implementation page can write into and run in. */
          workspace: workspace.available(),
        });
      default:
        if (next) return next();
        return send(res, 404, { error: 'not found' });
    }
  } catch (error) {
    return send(res, 502, { error: said(error) });
  }
}
