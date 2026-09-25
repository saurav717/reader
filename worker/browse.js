/**
 * The browser inside the reader, from the Cloudflare Worker.
 *
 * A Worker has no Chromium of its own, but Cloudflare will run one for it:
 * Browser Rendering, a binding (`[browser]` in wrangler.toml) that hands out
 * headless Chrome sessions the Worker drives over the DevTools protocol with
 * `@cloudflare/puppeteer`. So the same pane the Node proxy fills
 * (server/browse.js) can be filled from the Worker, which is what lets the
 * site on GitHub Pages sign in to a publisher with nothing running anywhere
 * of the person's own.
 *
 * The shape is the Node one's, but stateless: a Worker keeps nothing
 * between requests, so each request connects to the browser session by its
 * id — handed to the app when the session is opened, and sent back with
 * every request after — does its work, and disconnects, which leaves the
 * session alive (`keep_alive`) for the next one. Frames are screenshots
 * taken on each poll rather than a screencast, since there is no process
 * to receive one; a PDF is noticed by what the page says it is showing
 * (`document.contentType`) and then fetched with the session's cookies,
 * since there is no download to catch either.
 *
 * This stateless form is the fallback. The fast form is worker/browserSession.js,
 * a Durable Object that holds one connection open for the session's life
 * and streams Chrome's screencast, the way the Node proxy does; it reuses
 * the helpers below and is what wrangler.toml binds. Without that binding
 * the routes fall back to reconnecting per request, which works but is slow.
 *
 * With a KV namespace bound as SESSIONS the cookies are saved when the
 * browser closes or hands over a file, put back when the next one opens,
 * and used to retry a login wall on `/pdf` — which is what makes a sign-in
 * hold for the next paper, as the Node proxy's profile does. Without one,
 * a sign-in lasts as long as the session.
 */
import puppeteer from '@cloudflare/puppeteer';
import { WorkersWebSocketTransport } from '@cloudflare/puppeteer/internal/cloudflare/WorkersWebSocketTransport.js';
import { connectToCDPBrowser } from '@cloudflare/puppeteer/internal/cloudflare/utils.js';
import { BROWSER_UA } from '../server/scholar.js';
import { fetchChecked, MAX_PDF_BYTES, rejectUrl } from '../server/fetchPdf.js';
import { grabTargets, pdfCandidates, pdfLinksIn } from '../server/pdfLinks.js';
import { acceptKey, BUTTONS, clamp, clicks, closedError, fetchFileInPage, startsWithPdf, VIEWPORT } from '../server/browseShared.js';
import * as browserless from './browserless.js';

/**
 * How long a session outlives the last connection to it. Long enough for
 * the Durable Object to reconnect after an eviction, short enough not to
 * spend the day's browser minutes on a session nobody is using — and a
 * session alive is one of the few Cloudflare allows at once.
 */
export const KEEP_ALIVE_MS = 90_000;
/** A pause before each frame, so a polling app gets a few frames a second and not a hundred. */
const FRAME_PAUSE_MS = 350;
export const NAVIGATION_TIMEOUT_MS = 20_000;
/** How many pages to follow from a landing page before giving up on the file. */
const MAX_PAGE_HOPS = 4;
/**
 * Where a person's cookies are kept: one jar per browser that uses the
 * reader, never one for everyone. The client id comes from the app with
 * every request (worker/index.js scopes `env` with it); with no id there is
 * no jar, and a sign-in lasts as long as the browser session.
 */
const cookiesKey = (env) => (env?.READER_CLIENT ? `cookies:${env.READER_CLIENT}` : null);
/** A jar unused for this long is dropped by KV on its own. */
const COOKIES_TTL_S = 30 * 24 * 3600;
/**
 * Cookies never worth keeping: a sign-in through Google leaves Google's own
 * session behind, which no publisher needs afterwards, and which is far
 * more than a paper is worth holding on to.
 */
const NEVER_KEPT = /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com|youtube\.com|gstatic\.com)$/i;
const worthKeeping = (cookie) => !NEVER_KEPT.test(String(cookie.domain || '').replace(/^\./, ''));

/** `env` with the client id the jar is keyed by, for the calls below. */
export function forClient(env, client) {
  if (!client) return env;
  const scoped = Object.create(env);
  Object.defineProperty(scoped, 'READER_CLIENT', { value: client, enumerable: false });
  return scoped;
}

export const NO_BROWSER =
  'This Worker has no browser binding. Add `[browser] binding = "BROWSER"` to wrangler.toml — Browser Rendering is on Cloudflare\'s free plan — and redeploy it with `npm run deploy:worker`; or set a BROWSERLESS_TOKEN secret for a browser at Browserless instead.';

/**
 * Whether this Worker can open a browser, and if not, why — and, when it
 * can, whose the browser is, which the app needs to know when a site's
 * check for a person is Cloudflare's too (see `botCheck` in
 * src/lib/browse.ts): Cloudflare's own, with the binding; Browserless's,
 * with a token and no binding; and, with both, Cloudflare's first, with
 * Browserless's named as where a check Cloudflare's cannot pass is handed
 * to (`fallback`). See worker/browserless.js.
 */
export function availability(env) {
  const elsewhere = browserless.configured(env);
  if (env?.BROWSER) return elsewhere ? { available: true, where: 'cloudflare', fallback: 'browserless' } : { available: true, where: 'cloudflare' };
  if (elsewhere) return { available: true, where: 'browserless' };
  return { available: false, reason: NO_BROWSER };
}

/** What the app is told when nothing is open. */
export function idle(env, extra = {}) {
  return { ...availability(env), open: false, seq: 0, pdf: null, persistent: Boolean(env?.SESSIONS), ...extra };
}

// ----------------------------------------------------------- the session ----

/**
 * How a browser is reached. Taken as parameters so a test can point these
 * at a Chromium of its own; in the Worker they are Cloudflare's — or, asked
 * for with `at: 'browserless'`, or without a binding to Cloudflare's,
 * Browserless's (worker/browserless.js). A Browserless session cannot be
 * connected to again once let go, and Cloudflare's lists and limits know
 * nothing of it.
 */
export const defaultDriver = {
  launch: async (env, { at } = {}) => {
    if (at === 'browserless' || !env?.BROWSER) return browserless.launch(env);
    return connectSession(env, (await puppeteer.acquire(env.BROWSER, { keep_alive: KEEP_ALIVE_MS })).sessionId);
  },
  connect: (env, session) => {
    if (browserless.isBrowserless(session)) return Promise.reject(new Error(`Browserless session ${session} cannot be connected to again`));
    return connectSession(env, session);
  },
  sessions: (env) => puppeteer.sessions(env.BROWSER),
  limits: (env) => puppeteer.limits(env.BROWSER),
};

/**
 * How long any single ask over the DevTools protocol may take. Puppeteer's
 * own default is three minutes, which is how a session whose Chrome had
 * stopped answering held a request that long; this bounds every call on a
 * page — a navigation, a picture, a cookie — not only the connection.
 */
export const PROTOCOL_TIMEOUT_MS = 30_000;

/**
 * A connection to a session, made here rather than by `puppeteer.connect`
 * for two things it does not do: the protocol timeout above, and closing
 * the socket when the handshake fails. Cloudflare accepts the socket for
 * a session whose Chrome has stopped answering, and Puppeteer, when its
 * first ask over it then fails, leaves the socket open — and a session
 * with a socket open is alive, held, and spending the day's browser time
 * until Cloudflare's own cap ends it ten minutes on. Two of today's four
 * sessions ran exactly that long. The pieces are injectable for the tests.
 */
export async function connectSession(env, id, { create = WorkersWebSocketTransport.create, connect = connectToCDPBrowser } = {}) {
  const transport = await create(env.BROWSER, id);
  try {
    return await connect(transport, { sessionId: id, protocolTimeout: PROTOCOL_TIMEOUT_MS });
  } catch (error) {
    try {
      transport.close();
    } catch {
      // Closed already, or never open.
    }
    throw error;
  }
}

/**
 * What Cloudflare will allow just now, asked rather than guessed: how many
 * browsers are alive against how many may be at once, whether another may
 * be started this minute, and if not how long until one may. Asking is not
 * an acquisition, so it never counts against the minute the way asking for
 * a browser and being refused may. Null where the Worker has no browser,
 * or Cloudflare would not say.
 */
export async function limitsOf(env, driver = defaultDriver) {
  if (!env?.BROWSER) return null;
  try {
    return shapeLimits(await driver.limits(env));
  } catch {
    return null;
  }
}

/**
 * Cloudflare's answer, in the shape the app and the refusals use. Its
 * `timeUntilNextAllowedBrowserAcquisition` is taken as milliseconds, like
 * `keep_alive` and the session times in the same API; the Durable Object
 * asks again after the wait either way, so a misread costs a few extra
 * asks, never a browser. Pure: pinned by the tests.
 */
export function shapeLimits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  const wait = Number(raw.timeUntilNextAllowedBrowserAcquisition);
  return {
    alive: Array.isArray(raw.activeSessions) ? raw.activeSessions.length : null,
    max: count(raw.maxConcurrentSessions),
    allowed: count(raw.allowedBrowserAcquisitions),
    nextInMs: Number.isFinite(wait) && wait > 0 ? Math.round(wait) : 0,
  };
}

async function connect(env, session, driver) {
  if (!env?.BROWSER) throw new Error(NO_BROWSER);
  if (!session || !/^[\w.:-]{1,128}$/.test(session)) throw closedError();
  try {
    return await driver.connect(env, session);
  } catch {
    throw closedError();
  }
}

/** The page the person is looking at: the newest one that is not blank, which is also how a pop-up takes over. */
async function currentPage(browser) {
  const pages = await browser.pages();
  const real = pages.filter((page) => page.url() !== 'about:blank');
  return real[real.length - 1] || pages[pages.length - 1] || (await browser.newPage());
}

/** With the browser, then let go of it — disconnected, so the session lives on; closed, if asked. */
async function withBrowser(env, session, driver, work, { close = false } = {}) {
  const browser = await connect(env, session, driver);
  try {
    const page = await currentPage(browser);
    // Every connection applies Puppeteer's own default viewport (800×600)
    // to the pages it finds, so the size is set again each time.
    await page.setViewport(VIEWPORT).catch(() => undefined);
    return await work(browser, page);
  } finally {
    if (close) await browser.close().catch(() => undefined);
    else await browser.disconnect().catch(() => undefined);
  }
}

/** What the page shows now: a picture, where it is, and whether it is showing a PDF. */
async function snapshot(page, env, session) {
  const url = page.url();
  let title = '';
  let frame;
  let showingPdf = false;
  try {
    title = await page.title();
  } catch {
    // mid-navigation
  }
  try {
    frame = await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });
  } catch {
    // A page that cannot be drawn yet; the next poll will.
  }
  try {
    showingPdf = (await page.evaluate(() => document.contentType)) === 'application/pdf';
  } catch {
    // Chrome's PDF viewer refuses to be asked, which is itself the answer.
    showingPdf = /\.pdf(\?|$)/i.test(url);
  }
  return {
    ...availability(env),
    open: true,
    session,
    persistent: Boolean(env.SESSIONS),
    url,
    title,
    seq: Date.now(),
    width: page.viewport()?.width || VIEWPORT.width,
    height: page.viewport()?.height || VIEWPORT.height,
    loading: false,
    frame,
    pdf: showingPdf && !rejectUrl(url) ? { from: url, size: 0 } : null,
  };
}

/**
 * Open a session at a site. Only https, and never at a private address —
 * the app hands over the site the person chose, and a page on another site
 * could hand in anything.
 */
export async function open(env, url, driver = defaultDriver) {
  const reason = rejectUrl(url);
  if (reason) throw new Error(reason);
  // Stateless, this reconnects to the session on every request, which
  // only Cloudflare's browser allows; Browserless's is the Durable Object's.
  if (!env?.BROWSER) throw new Error(NO_BROWSER);
  const browser = await driver.launch(env);
  const session = browser.sessionId();
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setViewport(VIEWPORT);
    // The browser presents itself as what it is. It used to be given a
    // user-agent string typed in by hand, and a string on its own is worse
    // than the truth: Chrome answers an override that comes without
    // client-hint metadata by sending no `Sec-CH-UA` headers at all and an
    // empty `navigator.userAgentData`, and a browser whose string and hints
    // disagree is the one thing a bot check is sure about. Cloudflare's
    // check then never showed the box to tick; it looped. (The README, under
    // "A site that checks for a person first", says what to expect now.)
    await restoreCookies(env, page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {
      // A slow or refused page is still a page the person can see and act on.
    });
    return await snapshot(page, env, session);
  } finally {
    await browser.disconnect().catch(() => undefined);
  }
}

/** The next picture. Waits a moment first so a polling app is paced, not the session. */
export async function frame(env, session, driver = defaultDriver) {
  return withBrowser(env, session, driver, async (_browser, page) => {
    await new Promise((resolve) => setTimeout(resolve, FRAME_PAUSE_MS));
    return snapshot(page, env, session);
  });
}

/** Something the person did to the picture, done to the page. Same shapes as the Node proxy takes. */
export async function input(env, session, events, driver = defaultDriver) {
  return withBrowser(env, session, driver, async (_browser, page) => {
    for (const event of events) await apply(page, event || {});
    return { ok: true };
  });
}

export async function apply(page, event) {
  const x = clamp(event.x, VIEWPORT.width);
  const y = clamp(event.y, VIEWPORT.height);
  const button = BUTTONS.has(event.button) ? event.button : 'left';
  const navigation = { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS };
  switch (event.type) {
    case 'move':
      return page.mouse.move(x, y);
    // Puppeteer keeps the mouse's state per page, and refuses a release
    // whose press it did not see — which is what a click split across a
    // hand-over looks like: the press on the page before, the release on
    // the page after. Refused, not failed: the next click is whole.
    case 'down':
      await page.mouse.move(x, y);
      return page.mouse.down({ button, clickCount: clicks(event.clickCount) }).catch(() => undefined);
    case 'up':
      return page.mouse.up({ button, clickCount: clicks(event.clickCount) }).catch(() => undefined);
    case 'wheel':
      await page.mouse.move(x, y);
      // The size of the scroll, bounded, with its direction put back: the
      // bound alone floors a scroll up at nothing, which is what a wheel
      // that would not scroll up was.
      return page.mouse.wheel({
        deltaX: clamp(Math.abs(Number(event.dx) || 0), 2000) * Math.sign(Number(event.dx) || 0),
        deltaY: clamp(Math.abs(Number(event.dy) || 0), 2000) * Math.sign(Number(event.dy) || 0),
      });
    case 'keydown':
      if (!acceptKey(event.key)) return undefined;
      return page.keyboard.down(event.key).catch(() => undefined);
    case 'keyup':
      if (!acceptKey(event.key)) return undefined;
      return page.keyboard.up(event.key).catch(() => undefined);
    case 'insert':
      if (typeof event.text !== 'string' || !event.text || event.text.length > 10_000) return undefined;
      return page.keyboard.sendCharacter(event.text);
    case 'navigate': {
      const target = String(event.url || '').trim();
      const reason = rejectUrl(target);
      if (reason) throw new Error(reason);
      return page.goto(target, navigation).catch(() => undefined);
    }
    case 'back':
      return page.goBack(navigation).catch(() => undefined);
    case 'forward':
      return page.goForward(navigation).catch(() => undefined);
    case 'reload':
      return page.reload(navigation).catch(() => undefined);
    default:
      throw new Error(`unknown input: ${String(event.type)}`);
  }
}

/**
 * The PDF for the page the person is on, fetched with the session's cookies:
 * the page's own URL when it is showing the file, else the file the page
 * links — its `citation_pdf_url`, IEEE's stamp endpoints, the links it shows
 * once rendered — followed the way the Node proxy follows them. Throws,
 * worded for the person, when nothing within reach is a file.
 */
export async function grab(env, session, driver = defaultDriver) {
  return withBrowser(env, session, driver, async (_browser, page) => {
    const url = page.url();
    if (rejectUrl(url)) throw new Error('the page the browser is on is not one a PDF can be fetched from');
    let html = '';
    let showingPdf = false;
    try {
      showingPdf = (await page.evaluate(() => document.contentType)) === 'application/pdf';
      if (!showingPdf) html = await page.content();
    } catch {
      showingPdf = /\.pdf(\?|$)/i.test(url);
    }
    const { urls, why } = showingPdf ? { urls: [url], why: null } : await grabTargets(url, html);
    // The page fetches first, with the standing it has earned — a bot check
    // passed, a sign-in made — and the Worker's own fetch follows the links.
    const bytes = (await fetchFileInPage(page, urls, MAX_PDF_BYTES)) || (await fetchFileWithCookies(page, urls));
    if (!bytes) {
      throw new Error(
        why ||
        `no PDF was found from ${new URL(url).hostname} — open the file itself in the browser here, or sign in first if the page is asking for it`,
      );
    }
    await saveCookies(env, page);
    return bytes;
  });
}

/** Close the session. The cookies are kept where there is somewhere to keep them. */
export async function close(env, session, driver = defaultDriver) {
  try {
    return await withBrowser(env, session, driver, async (_browser, page) => {
      await saveCookies(env, page);
      return { open: false };
    }, { close: true });
  } catch (error) {
    if (error?.code === 'closed') return { open: false };
    throw error;
  }
}

// ------------------------------------------------------- fetching the file ----

/** "a=b; c=d" for a URL, from the page's own jar. */
async function cookieHeaderFromPage(page, url) {
  try {
    return (await page.cookies(url)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    return '';
  }
}

/**
 * The first PDF among the URLs, following each landing page to where it
 * says its file is, with the browser's cookies for each host on the request.
 */
export async function fetchFileWithCookies(page, urls) {
  const queue = [...urls];
  const seen = new Set();
  let hops = 0;
  while (queue.length && hops < MAX_PAGE_HOPS) {
    const url = queue.shift();
    if (seen.has(url) || rejectUrl(url)) continue;
    seen.add(url);
    hops += 1;
    const cookie = await cookieHeaderFromPage(page, url);
    let response;
    let finalUrl = url;
    try {
      ({ response, url: finalUrl } = await fetchChecked(url, {
        userAgent: BROWSER_UA,
        headers: { Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8', ...(cookie ? { Cookie: cookie } : {}) },
      }));
    } catch {
      continue;
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_PDF_BYTES) throw new Error('that PDF is too large to fetch');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new Error('that PDF is too large to fetch');
    if (response.ok && startsWithPdf(bytes)) return bytes;
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type.includes('html') || type.includes('xml') || !type) {
      for (const link of pdfLinksIn(new TextDecoder().decode(bytes), finalUrl)) queue.push(link);
    }
  }
  return null;
}

// --------------------------------------------------------------- cookies ----

/** Every cookie the session holds, for every host. */
async function allCookies(page) {
  const cdp = await page.createCDPSession();
  try {
    const { cookies } = await cdp.send('Network.getAllCookies');
    return cookies || [];
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** A cookie as CDP reports it, as `page.setCookie` wants it. */
function forSetCookie(cookie) {
  const shaped = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
  };
  if (typeof cookie.expires === 'number' && cookie.expires > 0) shaped.expires = cookie.expires;
  if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) shaped.sameSite = cookie.sameSite;
  return shaped;
}

const unexpired = (cookie) => !(typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires * 1000 < Date.now());

/** Keep the session's cookies, where there is a KV namespace to keep them in. */
export async function saveCookies(env, page) {
  const key = cookiesKey(env);
  if (!env?.SESSIONS || !key) return false;
  try {
    const cookies = (await allCookies(page)).filter(unexpired).filter(worthKeeping).map(forSetCookie);
    await env.SESSIONS.put(key, JSON.stringify(cookies), { expirationTtl: COOKIES_TTL_S });
    return true;
  } catch {
    return false;
  }
}

/** The cookies kept, or none. */
export async function storedCookies(env) {
  const key = cookiesKey(env);
  if (!env?.SESSIONS || !key) return [];
  try {
    const raw = await env.SESSIONS.get(key);
    const cookies = raw ? JSON.parse(raw) : [];
    return Array.isArray(cookies) ? cookies.filter(unexpired) : [];
  } catch {
    return [];
  }
}

/**
 * Put the kept cookies into a fresh session, so a sign-in made last time
 * still holds. How many were put back.
 *
 * All of them in one protocol call — `Network.setCookies` — rather than one
 * `page.setCookie` each: a sign-in through an institution leaves a hundred
 * cookies and more across the publisher, the identity provider and Google,
 * and Puppeteer's `setCookie` is two round trips to the browser per cookie
 * (a delete, then a set), which from a Worker far from its browser is
 * seconds a dozen — the open's deadline gone before the page was asked for.
 * Chrome refuses the batch when one cookie in it is malformed, and then
 * they go one at a time, each its own single call, the bad ones skipped.
 *
 * `cookies` are the ones to put back when the caller has read them already
 * (the read from KV overlaps the browser's start that way); `cdp` a session
 * on the page to use rather than open one.
 */
export async function restoreCookies(env, page, { cookies, cdp } = {}) {
  const kept = cookies ?? (await storedCookies(env));
  if (!kept.length) return 0;
  const session = cdp ?? (await page.createCDPSession());
  try {
    try {
      await session.send('Network.setCookies', { cookies: kept });
      return kept.length;
    } catch {
      let restored = 0;
      for (const cookie of kept) {
        const ok = await session
          .send('Network.setCookie', cookie)
          .then((answer) => answer?.success !== false)
          .catch(() => false);
        if (ok) restored += 1;
      }
      return restored;
    }
  } finally {
    if (!cdp) await session.detach().catch(() => undefined);
  }
}

/** Forget every cookie kept. */
export async function forgetCookies(env) {
  const key = cookiesKey(env);
  if (!env?.SESSIONS || !key) return false;
  await env.SESSIONS.delete(key);
  return true;
}

/**
 * The Cookie header the kept cookies make for a URL — a host's own cookies,
 * and its parent domains' — for `/pdf` to retry a login wall with. Pure,
 * given the cookies: pinned by the tests.
 */
export function cookieHeaderFor(cookies, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '/';
  const matches = cookies.filter((cookie) => {
    const domain = String(cookie.domain || '').toLowerCase();
    const bare = domain.replace(/^\./, '');
    // ".example.org" is the host and everything under it; "example.org" is the host alone.
    const hostOk = domain.startsWith('.') ? host === bare || host.endsWith(`.${bare}`) : host === bare;
    const pathOk = path.startsWith(cookie.path || '/');
    const secureOk = !cookie.secure || parsed.protocol === 'https:';
    return hostOk && pathOk && secureOk && unexpired(cookie);
  });
  return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
