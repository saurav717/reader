/**
 * A browser elsewhere, for the check Cloudflare's own browser cannot pass.
 *
 * The Worker's browser is Cloudflare's (worker/browse.js), and Cloudflare
 * tells every site it protects that requests from its rendering browsers
 * are bots — so a site whose check for a person is Cloudflare's refuses
 * that browser however many times the box is ticked (the README, under
 * "A site that checks for a person first"). Browserless runs Chromiums of
 * its own, on addresses of its own, and speaks the same DevTools protocol
 * over a WebSocket, so the Worker can drive one of those exactly as it
 * drives Cloudflare's: the same session object, the same screencast, the
 * same fetch of the file by the page that was let in. What changes is
 * whose browser it is, which is the one thing such a check is about.
 *
 * It is opt-in, and a fallback: with a token (`npx wrangler secret put
 * BROWSERLESS_TOKEN`) the Worker still opens Cloudflare's free browser
 * first, and hands the session over to Browserless only when a page comes
 * back as Cloudflare's check — and goes straight there for a host it has
 * seen do that before. `/pdf` does the same for a file: a fetch answered
 * with the check is asked for again from a Browserless page, which passes
 * the checks that need no box and hands back the file, and says where the
 * check was met when it needs a person. Browserless meters browser time
 * in units (the free plan has some a month; a session is a unit per half
 * minute, a residential proxy so many a megabyte), so nothing here starts
 * one that Cloudflare's would do.
 *
 * Three settings, beside the secret, as plain vars in wrangler.toml:
 *
 *   BROWSERLESS_URL      the region: wss://production-sfo.browserless.io
 *                        (the default), -lon or -ams.
 *   BROWSERLESS_PROXY    "residential" to leave from a home address, which
 *                        is what a check likes best and what costs units
 *                        by the megabyte; unset, the browser's own address.
 *   BROWSERLESS_COUNTRY  the proxy's country, "us" say, when one is set.
 *   BROWSERLESS_SESSION_MS  how long a session in the pane may run. The free
 *                        plan allows two minutes, which is the default; a
 *                        paid plan allows more, and this raises it. A cap
 *                        Browserless names in a refusal is obeyed either way.
 *
 * Web APIs and the Workers runtime only: the WebSocket is opened with a
 * fetch carrying `Upgrade: websocket`, which is how a Worker opens one.
 */
import { WorkersWebSocketTransport } from '@cloudflare/puppeteer/internal/cloudflare/WorkersWebSocketTransport.js';
import { connectToCDPBrowser } from '@cloudflare/puppeteer/internal/cloudflare/utils.js';
import { MAX_PDF_BYTES, rejectUrl } from '../server/fetchPdf.js';
import { challengedHost, checkAfter, fetchFileInPage, isMainDocument, VIEWPORT } from '../server/browseShared.js';

export const DEFAULT_URL = 'wss://production-sfo.browserless.io';
/** The path that asks for Browserless's stealth Chromium, which hides what a check looks for in a driven browser. */
const STEALTH_PATH = '/chromium/stealth';
/**
 * How long a session may run: a person ticking a box, signing in, reading.
 * Browserless's own default is half a minute; its free plan allows two
 * minutes at most, and refuses a longer ask outright — so this is the
 * default, and BROWSERLESS_SESSION_MS raises it on a plan that allows more.
 */
export const SESSION_MS = 120_000;
/** How long a fetch of one file may hold a browser, check and all. Under the free plan's cap. */
const FETCH_SESSION_MS = 90_000;
/** How long any single ask over the DevTools protocol may take; the same bound as Cloudflare's browser gets. */
const PROTOCOL_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
/** How long `/pdf` waits for a check that needs no box to pass on its own before saying it needs a person. */
export const CHECK_WAIT_MS = 15_000;
/** Session ids of this browser's are marked, so the object knows whose browser it holds after an eviction. */
const ID_PREFIX = 'browserless:';

/** Whether a token is set, so that there is a browser elsewhere to hand a check to. */
export const configured = (env) => Boolean(String(env?.BROWSERLESS_TOKEN || '').trim());

/** Whether a session id is one of Browserless's — which nothing can reconnect to, and Cloudflare's limits know nothing of. */
export const isBrowserless = (id) => typeof id === 'string' && id.startsWith(ID_PREFIX);

/**
 * The WebSocket address to connect at, from the settings: the region, the
 * stealth path, the token, the proxy, and how long the session may run.
 * Pure, so the tests can pin it without a token ever being logged.
 */
export function endpoint({ token, url = DEFAULT_URL, proxy = '', country = '', timeoutMs = SESSION_MS } = {}) {
  const base = String(url || DEFAULT_URL).trim().replace(/\/+$/, '');
  if (!/^wss?:\/\/[^/?#]+$/i.test(base)) throw new Error('BROWSERLESS_URL must be a wss:// address with no path, like wss://production-sfo.browserless.io');
  const query = new URLSearchParams();
  query.set('token', String(token || '').trim());
  query.set('timeout', String(Math.max(1000, Math.round(timeoutMs))));
  const via = String(proxy || '').trim().toLowerCase();
  if (via) {
    query.set('proxy', via);
    const where = String(country || '').trim().toLowerCase();
    if (where) query.set('proxyCountry', where);
  }
  return `${base}${STEALTH_PATH}?${query}`;
}

/** How long a session in the pane may run, from the settings: the plan's two minutes unless raised. */
export function sessionMsOf(env) {
  const set = Number(String(env?.BROWSERLESS_SESSION_MS || '').trim());
  return Number.isFinite(set) && set >= 1000 ? Math.round(set) : SESSION_MS;
}

/** The address from the Worker's own settings. */
export function endpointFor(env, { timeoutMs = sessionMsOf(env) } = {}) {
  return endpoint({
    token: env?.BROWSERLESS_TOKEN,
    url: env?.BROWSERLESS_URL,
    proxy: env?.BROWSERLESS_PROXY,
    country: env?.BROWSERLESS_COUNTRY,
    timeoutMs,
  });
}

/** The address, safe to write down: everything but the token. */
export const redacted = (address) => String(address).replace(/token=[^&]*/, 'token=…');

/**
 * The most a session may run on this plan, when Browserless refused a
 * longer ask and said so — "must be a whole number of milliseconds between
 * 1 and 120,000 (your plan's maximum session time, 2 minutes)" — or null
 * when the refusal was about something else. Pure: pinned by the tests.
 */
export function sessionCapIn(message) {
  const match = String(message || '').match(/'timeout'[^]*?between\s+1\s+and\s+([\d,]+)/i);
  if (!match) return null;
  const cap = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(cap) && cap >= 1000 ? cap : null;
}

/**
 * What a refusal said, fit for a sentence: its text, or, when the body is
 * a web page — nginx's "429 Too Many Requests" page is what the plan's
 * browsers all being in use comes back as — the page's title or heading
 * rather than its markup. Pure: pinned by the tests.
 */
export function saidIn(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (/^\s*</.test(raw) || /<\/?(html|body|head|h1|title)\b/i.test(raw)) {
    const inner = (tag) => (raw.match(new RegExp(`<${tag}[^>]*>([^<]*)<`, 'i')) || [])[1]?.trim();
    return (inner('title') || inner('h1') || raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200);
  }
  return raw.slice(0, 200);
}

/** Whether a refusal is Browserless saying its browsers are all in use, or asked for too often: a wait cures it. */
export function tooBusy(error) {
  return error?.status === 429 || /code:\s*429\b/.test(String(error?.message || ''));
}

/**
 * A WebSocket to Browserless, the way a Worker opens one: a fetch with
 * `Upgrade: websocket` over https, whose answer carries the socket. A
 * refusal — a bad token, the plan's browsers all in use — comes back as a
 * plain response, and is worded from its status and body.
 */
export async function openSocket(address, doFetch = globalThis.fetch) {
  const over = String(address).replace(/^ws(s?):\/\//i, 'http$1://');
  const response = await doFetch(over, { headers: { Upgrade: 'websocket' } });
  const socket = response.webSocket;
  if (!socket) {
    const text = await response.text().catch(() => '');
    const said = saidIn(text);
    const error = new Error(`Browserless would not open a browser: code: ${response.status}${said ? `: message: ${said}` : ''}`);
    error.status = response.status;
    throw error;
  }
  socket.accept();
  return socket;
}

/**
 * A Browserless browser, driven over the DevTools protocol like Cloudflare's
 * own: the socket wrapped in the same transport, the same connection with
 * the same protocol timeout, and a session id of this browser's own, so
 * the object knows whose it is. A session asked for longer than the plan
 * allows is refused before any browser starts, with the plan's cap in the
 * refusal; it is asked for again at that cap, once. The pieces are
 * injectable for the tests.
 */
export async function launch(env, { open = openSocket, connect = connectToCDPBrowser, timeoutMs = sessionMsOf(env) } = {}) {
  if (!configured(env)) throw new Error('This Worker has no BROWSERLESS_TOKEN, so there is no browser elsewhere to hand a check to.');
  const id = `${ID_PREFIX}${crypto.randomUUID()}`;
  let socket;
  try {
    socket = await open(endpointFor(env, { timeoutMs }));
  } catch (error) {
    const cap = sessionCapIn(error?.message);
    if (!cap || cap >= timeoutMs) throw error;
    socket = await open(endpointFor(env, { timeoutMs: cap }));
  }
  const transport = new WorkersWebSocketTransport(socket, id);
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

// -------------------------------------------------------- the file, for /pdf ----

/**
 * A file behind a site's check for a person, fetched from a Browserless
 * page: opened at the file's URL, given the check time to pass on its own
 * — most need no box from a browser on an address of its own — and then
 * asked to fetch the file itself, with the clearance the check granted,
 * which is a cookie bound to the browser that earned it. The browser is
 * closed after, whatever happened: browser time is what Browserless meters.
 *
 * @returns {Promise<{bytes: Uint8Array}|{check: {host: string, times: number, answered: number}}|null>}
 *   the file; or the check, when it needs a person, for the app to offer the
 *   pane; or null when the page gave neither (a login wall, a dead link).
 */
export async function fetchFile(env, url, { launch: doLaunch = launch, restoreCookies, saveCookies, waitMs = CHECK_WAIT_MS } = {}) {
  if (rejectUrl(url) || !configured(env)) return null;
  let browser;
  try {
    browser = await doLaunch(env, { timeoutMs: FETCH_SESSION_MS });
  } catch {
    return null;
  }
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setViewport(VIEWPORT).catch(() => undefined);
    if (restoreCookies) await restoreCookies(env, page).catch(() => undefined);
    // The page itself arriving — as the check, or as the site — is what
    // says whether the check is on; the widget's own frame says nothing.
    let check = null;
    let settled = null;
    const clear = new Promise((resolve) => (settled = resolve));
    page.on('response', (response) => {
      if (!isMainDocument(response, page)) return;
      check = checkAfter(check, challengedHost(response), false);
      if (!check) settled();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    if (check) {
      // The check's page came: given a while to run its scripts and follow
      // on to the file, which is what a check that needs no box does.
      await Promise.race([clear, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
    if (check) return { check };
    const bytes = await fetchFileInPage(page, [page.url(), url], MAX_PDF_BYTES);
    if (!bytes) return null;
    if (saveCookies) await saveCookies(env, page).catch(() => undefined);
    return { bytes };
  } catch {
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
