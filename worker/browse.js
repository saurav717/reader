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
import { BROWSER_UA } from '../server/scholar.js';
import { fetchChecked, MAX_PDF_BYTES, rejectUrl } from '../server/fetchPdf.js';
import { pdfCandidates, pdfLinksIn } from '../server/pdfLinks.js';
import { acceptKey, BUTTONS, clamp, clicks, closedError, fetchFileInPage, startsWithPdf, VIEWPORT } from '../server/browseShared.js';

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
const COOKIES_KEY = 'browser-cookies';

export const NO_BROWSER =
  'This Worker has no browser binding. Add `[browser] binding = "BROWSER"` to wrangler.toml — Browser Rendering is on Cloudflare\'s free plan — and redeploy it with `npm run deploy:worker`.';

/** Whether this Worker can open a browser, and if not, why. */
export function availability(env) {
  return env?.BROWSER ? { available: true } : { available: false, reason: NO_BROWSER };
}

/** What the app is told when nothing is open. */
export function idle(env, extra = {}) {
  return { ...availability(env), open: false, seq: 0, pdf: null, persistent: Boolean(env?.SESSIONS), ...extra };
}

// ----------------------------------------------------------- the session ----

/**
 * How a browser is reached. Taken as parameters so a test can point these
 * at a Chromium of its own; in the Worker they are Cloudflare's.
 */
const defaultDriver = {
  launch: (env) => puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS }),
  connect: (env, session) => puppeteer.connect(env.BROWSER, session),
};

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
    case 'down':
      await page.mouse.move(x, y);
      return page.mouse.down({ button, clickCount: clicks(event.clickCount) });
    case 'up':
      return page.mouse.up({ button, clickCount: clicks(event.clickCount) });
    case 'wheel':
      await page.mouse.move(x, y);
      return page.mouse.wheel({
        deltaX: clamp(event.dx, 2000) * Math.sign(Number(event.dx) || 0),
        deltaY: clamp(event.dy, 2000) * Math.sign(Number(event.dy) || 0),
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
    const urls = showingPdf ? [url] : [...pdfCandidates(url), ...pdfLinksIn(html, url), url];
    // The page fetches first, with the standing it has earned — a bot check
    // passed, a sign-in made — and the Worker's own fetch follows the links.
    const bytes = (await fetchFileInPage(page, urls, MAX_PDF_BYTES)) || (await fetchFileWithCookies(page, urls));
    if (!bytes) {
      throw new Error(
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
  if (!env?.SESSIONS) return false;
  try {
    const cookies = (await allCookies(page)).filter(unexpired).map(forSetCookie);
    await env.SESSIONS.put(COOKIES_KEY, JSON.stringify(cookies));
    return true;
  } catch {
    return false;
  }
}

/** The cookies kept, or none. */
export async function storedCookies(env) {
  if (!env?.SESSIONS) return [];
  try {
    const raw = await env.SESSIONS.get(COOKIES_KEY);
    const cookies = raw ? JSON.parse(raw) : [];
    return Array.isArray(cookies) ? cookies.filter(unexpired) : [];
  } catch {
    return [];
  }
}

/** Put the kept cookies into a fresh session, so a sign-in made last time still holds. */
export async function restoreCookies(env, page) {
  const cookies = await storedCookies(env);
  if (!cookies.length) return;
  for (const cookie of cookies) {
    await page.setCookie(cookie).catch(() => undefined);
  }
}

/** Forget every cookie kept. */
export async function forgetCookies(env) {
  if (!env?.SESSIONS) return false;
  await env.SESSIONS.delete(COOKIES_KEY);
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
