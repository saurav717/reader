/**
 * Asking Scholar for a page the way a person does: a real browser.
 *
 * The plain request in `server/scholar.js` sends a browser's headers, but it
 * is not a browser — no JavaScript, no cookie jar, none of the signals Google
 * fingerprints — and Scholar tells the difference. Driving Chromium instead
 * gets through a good deal more often, at the cost of a browser process and
 * about a second per page.
 *
 * Node only, and off unless asked for: Playwright is a devDependency, and a
 * deployment that has not installed it must still start. `npm start` with
 *
 *   SCHOLAR_BROWSER=1 npm start
 *
 * turns it on; without it the proxy uses the plain fetch. The Cloudflare
 * Worker cannot use this at all — there is no browser in that runtime, which
 * is one more reason Scholar from a Worker mostly returns captchas.
 *
 * The browser is started once and kept, because a cold start per search would
 * be slower than the request it is making.
 */
import { BROWSER_UA } from './scholar.js';

let browserPromise = null;
let context = null;

/** True when this process has been asked to use a browser and can. */
export function browserWanted() {
  return process.env.SCHOLAR_BROWSER === '1' || process.env.SCHOLAR_BROWSER === 'true';
}

async function ensureContext() {
  if (context) return context;
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({
        // The image this runs in may keep Chromium somewhere of its own.
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        args: ['--disable-blink-features=AutomationControlled'],
      });
    })();
  }
  const browser = await browserPromise;
  context = await browser.newContext({
    userAgent: BROWSER_UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  // Scholar shows a consent interstitial in some regions; this is the cookie
  // clicking through it sets, and it saves a page load every time.
  await context.addCookies([
    { name: 'CONSENT', value: 'YES+', domain: '.google.com', path: '/' },
    { name: 'GSP', value: 'LM=1:S=scholar', domain: '.scholar.google.com', path: '/' },
  ]);
  return context;
}

/**
 * A Scholar page, fetched in Chromium. Same shape as `plainFetch`, so it drops
 * straight into `getScholar`.
 */
export async function browserFetch(url, { signal } = {}) {
  const ctx = await ensureContext();
  const page = await ctx.newPage();
  try {
    const abort = () => page.close().catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const html = await page.content();
    signal?.removeEventListener('abort', abort);
    return { status: response ? response.status() : 200, html };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Lets the process exit, and is what the tests call between runs. */
export async function closeBrowser() {
  const open = context;
  context = null;
  await open?.close().catch(() => undefined);
  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  await browser?.close().catch(() => undefined);
}

/**
 * The fetcher this process should use. Falls back to the plain one, once and
 * loudly, if the browser cannot be started — a missing Playwright install
 * should degrade rather than take the proxy down with it.
 */
export async function scholarFetcher(plain) {
  if (!browserWanted()) return plain;
  try {
    await ensureContext();
    return browserFetch;
  } catch (error) {
    console.warn(`[scholar] SCHOLAR_BROWSER is set but Chromium would not start (${error?.message || error}); using plain requests.`);
    return plain;
  }
}
