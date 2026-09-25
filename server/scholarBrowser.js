/**
 * Asking Scholar for a page the way a person does: a real browser — and, when
 * Scholar asks for a person, supplying one.
 *
 * The plain request in `server/scholar.js` sends a browser's headers, but it
 * is not a browser — no JavaScript, no cookie jar, none of the signals Google
 * fingerprints — and Scholar tells the difference. Driving Chromium instead
 * gets through a good deal more often, at the cost of a browser process and
 * about a second per page.
 *
 * And when Scholar still answers with a captcha, this is where it is solved.
 * A captcha is Google asking to be shown a person, and the app cannot show it
 * one: the page may open Scholar in a tab, but the cookie that solving it
 * earns would land in that tab's browser, on that machine, and the proxy would
 * be refused exactly as before. So the captcha is shown where the fetching
 * happens: the proxy opens the refused page in a real, visible browser window
 * on its own machine, the person solves it there, and from then on every
 * Scholar page is asked for through that same browser — headless, on the
 * same profile — which carries the cookie Google issued for the solve. That
 * profile lives on disk, so a solve outlasts a restart.
 *
 * Node only, and off unless asked for: Playwright is a devDependency, and a
 * deployment that has not installed it must still start. `npm start` with
 *
 *   SCHOLAR_BROWSER=1 npm start
 *
 * turns the browser on for every request; without it the proxy uses the plain
 * fetch until a captcha has been solved here, and the browser from then on.
 * The Cloudflare Worker cannot use any of this — there is no browser in that
 * runtime and no screen — which is one more reason Scholar from a Worker
 * mostly returns captchas.
 *
 * The browser is started once and kept, because a cold start per search would
 * be slower than the request it is making.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availability, extraBrowserArgs } from './access.js';
import { worded } from './fetchPdf.js';
import { BROWSER_UA, blockedReason, isScholarUrl } from './scholar.js';

/**
 * Where Scholar's cookies live. Its own directory, apart from the signed-in
 * publisher profile in `server/access.js`: Chromium locks a profile while it
 * is open, and the two are opened and closed on different occasions.
 */
export const PROFILE_DIR =
  process.env.READER_SCHOLAR_PROFILE_DIR || path.join(os.homedir(), '.reader', 'scholar-profile');

/** True when this process has been asked to use a browser for every request. */
export function browserAsked() {
  return process.env.SCHOLAR_BROWSER === '1' || process.env.SCHOLAR_BROWSER === 'true';
}

/**
 * True when Scholar should be asked through Chromium: either because it was
 * asked for, or because a captcha has been solved on this proxy — the cookie
 * that solve earned is in the browser profile, and a plain request would not
 * carry it. The profile directory existing is the record of a solve.
 */
export function browserWanted() {
  return browserAsked() || existsSync(PROFILE_DIR);
}

// -------------------------------------------------------------- browser ----

/**
 * One browser at a time on the profile: Chromium locks the directory, so the
 * captcha window (headed) and the quiet fetches (headless) take turns.
 */
let context = null;
let contextMode = null;
let launching = null;
/** The page the captcha is being solved on, while the window is open. */
let captchaPage = null;
/** Whether the last captcha window ended with Scholar answering. */
let solved = false;

async function launch(mode) {
  const { chromium } = await import('playwright');
  const options = {
    headless: mode === 'headless',
    // The same browser in both modes, so what Scholar saw solve the captcha
    // is what asks it for the next page.
    userAgent: BROWSER_UA,
    locale: 'en-US',
    viewport: mode === 'headless' ? { width: 1280, height: 900 } : null,
    // The "controlled by automated test software" bar is not something a
    // person solving a captcha should have to read.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', ...extraBrowserArgs()],
  };
  if (process.env.READER_BROWSER_CHANNEL) options.channel = process.env.READER_BROWSER_CHANNEL;
  else if (process.env.CHROMIUM_PATH) options.executablePath = process.env.CHROMIUM_PATH;
  const launched = await chromium.launchPersistentContext(PROFILE_DIR, options);
  launched.on('close', () => {
    if (context === launched) {
      context = null;
      contextMode = null;
      captchaPage = null;
    }
  });
  // Scholar shows a consent interstitial in some regions; this is the cookie
  // clicking through it sets, and it saves a page load every time.
  await launched.addCookies([
    { name: 'CONSENT', value: 'YES+', domain: '.google.com', path: '/' },
    { name: 'GSP', value: 'LM=1:S=scholar', domain: '.scholar.google.com', path: '/' },
  ]);
  return launched;
}

async function ensureContext(mode) {
  if (launching) await launching;
  if (context && contextMode === mode) return context;
  if (context) {
    // Switching modes: the profile can only be open once.
    const open = context;
    context = null;
    contextMode = null;
    captchaPage = null;
    await open.close().catch(() => undefined);
  }
  launching = launch(mode)
    .then((launched) => {
      context = launched;
      contextMode = mode;
      return launched;
    })
    .finally(() => {
      launching = null;
    });
  return launching;
}

const windowOpen = () => Boolean(captchaPage && !captchaPage.isClosed());

/**
 * A Scholar page, fetched in Chromium. Same shape as `plainFetch`, so it drops
 * straight into `getScholar`. While the captcha window is open the page is
 * opened beside it, so that a fetch does not close the window on the person.
 */
export async function browserFetch(url, { signal } = {}) {
  const ctx = await ensureContext(windowOpen() ? 'headed' : 'headless');
  const page = await ctx.newPage();
  try {
    const abort = () => page.close().catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      // Playwright's message is a call log several lines long, and names
      // things — paths, flags, the machine's own addresses — that are for
      // whoever runs the proxy, not for the panel. The log gets the first
      // line; the panel gets that the page would not load.
      console.warn(`[scholar] the browser could not load ${url}: ${String(error?.message || error).split('\n')[0]}`);
      throw worded("the proxy's browser could not load the page");
    }
    const html = await page.content();
    signal?.removeEventListener('abort', abort);
    return { status: response ? response.status() : 200, html };
  } finally {
    await page.close().catch(() => undefined);
  }
}

// -------------------------------------------------------------- captcha ----

/**
 * Open the window at the page Scholar refused. That is the page the captcha
 * is on — Scholar shows it in place of the results, and shows the results
 * once it is solved — so the person sees exactly what a browser of their own
 * would have shown them. Only a Scholar URL is ever opened: the app hands
 * this back from the refusal, and a page on another site could hand in
 * anything.
 */
export async function openCaptcha(url) {
  if (!isScholarUrl(url)) throw worded('only a scholar.google.com page can be opened here');
  const ready = await availability();
  if (!ready.available) throw worded(ready.reason);

  solved = false;
  const ctx = await ensureContext('headed');
  // A persistent context opens with a blank page; use it rather than leaving
  // an empty tab beside the captcha.
  const blank = ctx.pages().find((page) => page.url() === 'about:blank');
  const page = windowOpen() ? captchaPage : blank || (await ctx.newPage());
  captchaPage = page;
  page.once('close', () => {
    if (captchaPage === page) captchaPage = null;
  });
  await page.bringToFront().catch(() => undefined);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {
    // A slow page is still a page the person can solve the captcha on.
  });
  return { host: 'scholar.google.com' };
}

/**
 * Whether the page in the window has stopped being a captcha: Scholar sends
 * the person on to the results the moment it accepts the answer, and that
 * is the signal that the solve is done. Read from the page itself rather
 * than from its URL, because the inline captcha stays on the same URL.
 */
async function windowAnswered() {
  if (!windowOpen()) return false;
  try {
    if (!isScholarUrl(captchaPage.url())) return false;
    const html = await captchaPage.content();
    return html.length > 0 && blockedReason(html, 200) === null;
  } catch {
    // Mid-navigation, which is what solving looks like from here. Ask again.
    return false;
  }
}

/**
 * What the app polls while the window is open. Closes the window itself once
 * Scholar has accepted the answer, so the person has nothing more to do — the
 * app sees `window: 'closed'` and asks Scholar again, and this time through
 * the profile the solve just landed in.
 */
export async function captchaStatus() {
  const ready = await availability();
  if (await windowAnswered()) {
    solved = true;
    await closeCaptcha();
  }
  return {
    ...ready,
    window: windowOpen() ? 'open' : 'closed',
    solved,
    /** Whether Scholar is asked through the browser on this proxy. */
    browser: browserWanted(),
    /** Whether a solve has ever landed here. The directory itself is the proxy's business. */
    profileExists: existsSync(PROFILE_DIR),
  };
}

/** "I have solved it": close the window so the fetches can have the profile. */
export async function closeCaptcha() {
  const page = captchaPage;
  captchaPage = null;
  if (page && !page.isClosed()) await page.close().catch(() => undefined);
  return { window: 'closed' };
}

/** Lets the process exit, and is what the tests call between runs. */
export async function closeBrowser() {
  captchaPage = null;
  const open = context;
  context = null;
  contextMode = null;
  await open?.close().catch(() => undefined);
}

let browserFailed = false;

/**
 * The fetcher this process should use right now. The browser where it is
 * wanted — asked for, or a captcha has been solved on it — falling back to
 * the plain one, once and loudly, if Chromium cannot be started: a missing
 * Playwright install should degrade rather than take the proxy down with it.
 */
export async function scholarFetcher(plain) {
  if (!browserWanted() || browserFailed) return plain;
  try {
    await ensureContext(windowOpen() ? 'headed' : 'headless');
    return browserFetch;
  } catch (error) {
    browserFailed = true;
    console.warn(`[scholar] a browser was wanted but Chromium would not start (${error?.message || error}); using plain requests.`);
    return plain;
  }
}
