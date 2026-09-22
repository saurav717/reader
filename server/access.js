/**
 * Papers behind a login: signing in with an institution, and fetching with
 * that sign-in.
 *
 * IEEE, ACM, Springer, Elsevier and the rest hand a PDF to a browser that has
 * signed in through a university, and a web page to everyone else. The proxy
 * is everyone else: it asks anonymously, gets the page, and reports the copy
 * as one that "would not hand over a PDF". Nothing the app's own page can do
 * changes that — a browser will not let script read a cross-origin response,
 * cookies or no cookies — so the sign-in has to happen where the fetching
 * happens, which is here.
 *
 * So this opens a real browser window, on the machine the proxy runs on, at
 * the publisher's page. The person signs in there the way they would anywhere
 * — institutional sign-in, Shibboleth, OpenAthens, whatever their library
 * uses — and closes the window. The session lives in a browser profile of its
 * own on disk, and from then on a PDF that came back as a login wall is asked
 * for again through that profile, which is what turns the page into the file.
 *
 * Only the Node proxy can do this: it needs Playwright, a Chromium, and a
 * screen to put the window on. The Cloudflare Worker has none of the three,
 * and says so from `/access/status` so the app can offer the sign-in where it
 * can work and explain where it cannot.
 *
 * Nothing here runs unless asked. Playwright is a devDependency and is only
 * imported on the first request that needs it, so a deployment without it
 * still starts, and answers "not available" with the reason.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_PDF_BYTES, rejectUrl } from './fetchPdf.js';

/** Where the signed-in browser profile lives. Cookies stay in Chromium's own store. */
export const PROFILE_DIR =
  process.env.READER_PROFILE_DIR || path.join(os.homedir(), '.reader', 'browser-profile');

const FETCH_TIMEOUT_MS = 45_000;
/** How many pages to follow from a landing page before giving up on the file. */
const MAX_PAGE_HOPS = 4;

// --------------------------------------------------------------- status ----

let playwrightPromise = null;

async function playwright() {
  if (!playwrightPromise) {
    playwrightPromise = import('playwright').catch((error) => {
      playwrightPromise = null;
      throw error;
    });
  }
  return playwrightPromise;
}

function executablePath(chromium) {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (process.env.READER_BROWSER_CHANNEL) return undefined;
  return chromium.executablePath();
}

/** A window needs a screen. macOS and Windows always have one; Linux says. */
function hasDisplay() {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Whether this proxy can open a browser window at all — for a sign-in, or
 * for a Scholar captcha (see server/scholarBrowser.js) — and if not, why,
 * worded for the person who could fix it. Nothing is launched to answer this.
 */
export async function availability() {
  let chromium;
  try {
    ({ chromium } = await playwright());
  } catch {
    return {
      available: false,
      reason:
        'Playwright is not installed on the proxy. Run `npm install` there without PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD and restart it.',
    };
  }
  const executable = executablePath(chromium);
  if (executable && !existsSync(executable)) {
    return {
      available: false,
      reason:
        'Playwright is installed on the proxy but its Chromium is not. Run `npx playwright install chromium` there, or set READER_BROWSER_CHANNEL=chrome to use the Chrome you already have.',
    };
  }
  if (!hasDisplay()) {
    return {
      available: false,
      reason:
        'The proxy is running somewhere with no screen to open a browser window on. Run it on your own machine (`npm start`) and point Settings → Paper proxy at it.',
    };
  }
  return { available: true };
}

// -------------------------------------------------------------- browser ----

/**
 * One browser at a time on the profile: Chromium locks the directory, so the
 * sign-in window (headed) and the quiet fetches (headless) take turns.
 */
let context = null;
let contextMode = null;
let launching = null;
/** The page the person is signing in on, while the window is open. */
let signInPage = null;

async function launch(mode) {
  const { chromium } = await playwright();
  const options = {
    headless: mode === 'headless',
    viewport: null,
    locale: 'en-US',
    // The "controlled by automated test software" bar is not something a
    // person signing in should have to read, and a few sign-in pages refuse a
    // browser that shows it.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (process.env.READER_BROWSER_CHANNEL) options.channel = process.env.READER_BROWSER_CHANNEL;
  else if (process.env.CHROMIUM_PATH) options.executablePath = process.env.CHROMIUM_PATH;
  const launched = await chromium.launchPersistentContext(PROFILE_DIR, options);
  launched.on('close', () => {
    if (context === launched) {
      context = null;
      contextMode = null;
      signInPage = null;
    }
  });
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
    signInPage = null;
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

/** Cookies for a host, which is the only sign this profile has signed in there. */
async function cookiesFor(url) {
  if (!context) return [];
  try {
    return await context.cookies(url);
  } catch {
    return [];
  }
}

/** Whether a sign-in was ever done on this machine. Cheap: a directory check. */
export function everSignedIn() {
  return existsSync(PROFILE_DIR);
}

// -------------------------------------------------------------- sign in ----

/**
 * Open the window. The page is the publisher's own — the paper's landing
 * page, usually — because that is where the institutional sign-in link is,
 * and because after signing in the person can see for themselves that the
 * paper now opens.
 */
export async function openSignIn(url) {
  const reason = rejectUrl(url);
  if (reason) throw new Error(reason);
  const ready = await availability();
  if (!ready.available) throw new Error(ready.reason);

  const ctx = await ensureContext('headed');
  // A persistent context opens with a blank page; use it rather than leaving
  // an empty tab beside the sign-in.
  const blank = ctx.pages().find((page) => page.url() === 'about:blank');
  const page = signInPage && !signInPage.isClosed() ? signInPage : blank || (await ctx.newPage());
  signInPage = page;
  page.once('close', () => {
    if (signInPage === page) signInPage = null;
  });
  await page.bringToFront().catch(() => undefined);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {
    // A slow page is still a page the person can sign in on.
  });
  return { host: new URL(url).hostname };
}

/** What the app polls while the window is open. */
export async function status() {
  const ready = await availability();
  const window = signInPage && !signInPage.isClosed() ? 'open' : 'closed';
  return { ...ready, window, everSignedIn: everSignedIn(), profile: PROFILE_DIR };
}

/** "I have signed in": close the window so the fetches can have the profile. */
export async function closeSignIn() {
  const page = signInPage;
  signInPage = null;
  if (page && !page.isClosed()) await page.close().catch(() => undefined);
  return { window: 'closed' };
}

/** Sign out of everything: the profile, and every session in it, is deleted. */
export async function forget() {
  signInPage = null;
  const open = context;
  context = null;
  contextMode = null;
  if (open) await open.close().catch(() => undefined);
  await rm(PROFILE_DIR, { recursive: true, force: true });
  return { forgotten: true };
}

/** Lets the process exit; the tests call it between runs. */
export async function closeAccessBrowser() {
  signInPage = null;
  const open = context;
  context = null;
  contextMode = null;
  if (open) await open.close().catch(() => undefined);
}

// ------------------------------------------------------- finding the file ----

/**
 * The URL a signed-in browser should ask for, given the one the indexes gave
 * us. Mostly that is the same URL. IEEE is the exception worth knowing about:
 * its landing page never links the file directly, but the stamp endpoints
 * answer with it once there is a session.
 */
export function pdfCandidates(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return [target];
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'ieeexplore.ieee.org') {
    const arnumber =
      url.pathname.match(/\/(?:abstract\/)?document\/(\d+)/)?.[1] || url.searchParams.get('arnumber');
    if (arnumber) {
      return [
        `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}`,
        `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${arnumber}`,
        target,
      ];
    }
  }
  return [target];
}

const attr = (tag, name) => {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};

const decode = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\\//g, '/');

/**
 * Where a landing page says its PDF is. Publishers agree on very little, but
 * most of them put a `citation_pdf_url` meta tag on the page for Google
 * Scholar's sake; IEEE keeps the path in a JSON blob instead, and its stamp
 * page wraps the file in a frame. Absolute URLs, in the order worth trying.
 */
export function pdfLinksIn(html, base) {
  const found = [];
  const push = (value) => {
    if (!value) return;
    try {
      const absolute = new URL(decode(value), base).toString();
      if (!found.includes(absolute)) found.push(absolute);
    } catch {
      // not a URL
    }
  };
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (name === 'citation_pdf_url') push(attr(tag, 'content'));
  }
  // IEEE: "pdfPath":"/iel7/…/09000000.pdf" and sometimes "pdfUrl":"/stamp/…"
  for (const match of html.matchAll(/"(?:pdfPath|pdfUrl)"\s*:\s*"([^"]+)"/g)) push(match[1]);
  for (const tag of html.match(/<i?frame\b[^>]*>/gi) || []) push(attr(tag, 'src'));
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    if (href && /\.pdf(\?|$)|\/pdf\/|stampPDF|getPDF/i.test(href)) push(href);
  }
  return found.filter((url) => /^https:\/\//i.test(url));
}

const isPdf = (bytes) => bytes.length > 4 && bytes.subarray(0, 5).toString('latin1').startsWith('%PDF');

/**
 * The file, through the signed-in profile. Throws with a reason meant for the
 * person reading: no sign-in for that host, or a sign-in that still did not
 * get the file.
 */
export async function fetchWithSession(target) {
  const reason = rejectUrl(target);
  if (reason) throw new Error(reason);
  if (!everSignedIn()) throw new Error('no sign-in on this proxy yet');

  const ctx = await ensureContext(signInPage && !signInPage.isClosed() ? 'headed' : 'headless');
  const host = new URL(target).hostname;
  if (!(await cookiesFor(target)).length) throw new Error(`not signed in at ${host}`);

  const queue = pdfCandidates(target);
  const seen = new Set();
  let hops = 0;
  while (queue.length && hops < MAX_PAGE_HOPS) {
    const url = queue.shift();
    if (seen.has(url) || rejectUrl(url)) continue;
    seen.add(url);
    hops += 1;
    let response;
    try {
      response = await ctx.request.get(url, {
        headers: { Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8' },
        maxRedirects: 5,
        timeout: FETCH_TIMEOUT_MS,
      });
    } catch {
      continue;
    }
    const length = Number(response.headers()['content-length'] || 0);
    if (length > MAX_PDF_BYTES) throw new Error('that PDF is too large to fetch');
    const body = await response.body();
    if (body.length > MAX_PDF_BYTES) throw new Error('that PDF is too large to fetch');
    if (response.ok() && isPdf(body)) return body;
    const type = (response.headers()['content-type'] || '').toLowerCase();
    if (type.includes('html') || type.includes('xml') || !type) {
      for (const link of pdfLinksIn(body.toString('utf8'), response.url())) queue.push(link);
    }
  }
  throw new Error(`signed in at ${host}, but it still would not hand over the PDF — does your institution subscribe to it?`);
}
