/**
 * A browser inside the reader, driven from the page.
 *
 * When every copy of a paper has been tried and the one that would answer
 * wants a sign-in, this is the way to go and sign in — without leaving the
 * reader, and without a screen on the proxy. The proxy opens the site in
 * its own Chromium, headless, on the same profile the institutional sign-in
 * uses (server/browse.js); what that page shows arrives here as pictures,
 * and what the person does to the picture — clicks, keys, scrolling — goes
 * back. A sign-in made this way is kept on the proxy, so the next paper
 * from the same publisher needs none; the PDF the browser meets, or the one
 * fetched from the page it is on, comes back as a blob and opens like any
 * other copy.
 *
 * The pictures are polled: one request that the proxy holds until there is
 * a newer frame — or the URL, the title or a PDF has changed — so an idle
 * page costs nothing. Input is sent in order, one request at a time, with
 * mouse movement collapsed to the latest position while a request is out.
 */
import type { PaperLocation, PaperRef } from '../types';
import { api, hasProxy } from './api';
import { scholarPaperUrl } from './locations';
import type { SignInOffer } from './pdf';

export interface BrowseStatus {
  /** Whether this proxy has a browser to open at all. */
  available: boolean;
  /** Why not, worded for the person who could fix it. */
  reason?: string;
  /** Whether a page is open right now. */
  open: boolean;
  url?: string;
  title?: string;
  /** Counts up on every frame and every other change; what the next poll asks for frames after. */
  seq: number;
  /** The page's size in its own pixels, which input coordinates are in. */
  width?: number;
  height?: number;
  loading?: boolean;
  /** A JPEG, base64, when there is one newer than the poll asked for. */
  frame?: string;
  /** A PDF the browser has met or fetched, waiting to be collected. */
  pdf: { from: string; size: number } | null;
  /**
   * The session's id, from a proxy that keeps nothing between requests (the
   * Worker): sent back with every request after the one that opened it.
   */
  session?: string;
  /** Whether a sign-in made here outlasts the session — kept in a profile, or in a KV namespace. */
  persistent?: boolean;
  /** What Cloudflare last said it would allow, from the Worker; the Node proxy has no such limits. */
  browsers?: BrowserLimits | null;
  /**
   * Whose browser it is: Cloudflare's, driven by the Worker; the proxy's
   * own on its own machine; or Browserless's, driven by the Worker on an
   * address of its own. It matters when a site's check for a person is
   * Cloudflare's too — see `botCheck`. A proxy deployed before this says
   * nothing, and the Worker is then told by the session id it alone hands out.
   */
  where?: 'cloudflare' | 'proxy' | 'browserless';
  /**
   * Where the Worker hands a session whose page came as Cloudflare's check,
   * which Cloudflare's own browser never passes: a browser at Browserless,
   * when the Worker has a token for one. Absent otherwise.
   */
  fallback?: 'browserless';
  /** Why the last hand-over gave no browser at Browserless, in Browserless's words; absent when it did, or none was tried. */
  fallbackError?: string;
  /** The site's check for a person, when that is what the page is — noticed by the proxy from the response itself. */
  check?: BrowseCheck | null;
}

/**
 * A site's check for a person, as the proxy sees it come: which host's,
 * how many times running its page has come, and how many of those came
 * after the person did something to it — ticked the box, say. A check
 * that comes back after it was answered is the site refusing the browser.
 */
export interface BrowseCheck {
  host: string;
  times: number;
  answered: number;
}

/**
 * What Cloudflare will allow the Worker just now: how many browsers are
 * alive against how many may be at once, whether another may be started
 * this minute, and if not how long until one may. Null where unknown.
 */
export interface BrowserLimits {
  alive: number | null;
  max: number | null;
  allowed: number | null;
  nextInMs: number;
}

/**
 * What the proxy answered with, when it would not: the status, and — when
 * Cloudflare would not start a browser — how many seconds until it said it
 * would, for the pane to count down and try again on its own.
 */
export class BrowseError extends Error {
  status: number;
  retryAfter: number | null;
  browsers: BrowserLimits | null;
  /** True when it is the day's browser time that is spent: no wait short of tomorrow cures it. */
  daily: boolean;

  constructor(message: string, status: number, retryAfter: number | null = null, browsers: BrowserLimits | null = null, daily = false) {
    super(message);
    this.name = 'BrowseError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.browsers = browsers;
    this.daily = daily;
  }

  /** Whether this is Cloudflare rationing browsers, which a wait will cure, rather than something wrong. */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** The error a refusal makes, with the wait when the proxy named one. */
function refused(status: number, payload: { error?: string; retryAfter?: unknown; browsers?: unknown; daily?: unknown }): BrowseError {
  const seconds = Number(payload.retryAfter);
  const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
  const browsers = payload.browsers && typeof payload.browsers === 'object' ? (payload.browsers as BrowserLimits) : null;
  return new BrowseError(payload.error || `The proxy answered ${status}.`, status, retryAfter, browsers, payload.daily === true);
}

export type BrowseInput =
  | { type: 'move'; x: number; y: number }
  | { type: 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'keydown' | 'keyup'; key: string }
  | { type: 'insert'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' };

const UNAVAILABLE: BrowseStatus = {
  available: false,
  open: false,
  seq: 0,
  pdf: null,
  reason: 'There is no proxy configured, so there is no browser to open.',
};

/** The open session's id, where the proxy hands one out; the Node proxy has one session and no id. */
let session: string | null = null;

/** A route's path with the session id on it, when there is one. */
function withSession(path: string): string {
  if (!session) return path;
  return `${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(session)}`;
}

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(api(withSession(path)), { ...init, headers: { Accept: 'application/json', ...(init?.headers || {}) } });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; retryAfter?: unknown; browsers?: unknown };
  if (!response.ok) throw refused(response.status, payload);
  return payload;
}

/** Whether the proxy can open a browser, and what it has open. */
export async function browseStatus(): Promise<BrowseStatus> {
  if (!hasProxy()) return UNAVAILABLE;
  try {
    return { ...UNAVAILABLE, ...(await ask<Partial<BrowseStatus>>('/browse/status')) };
  } catch {
    return { ...UNAVAILABLE, reason: 'This proxy does not know how to open a browser. Update it and restart.' };
  }
}

/**
 * How long an open is waited for. The Worker gives up on its own before
 * this — every step of opening has a deadline there — so this is for a
 * proxy that never answers at all: the spinner ends with a sentence.
 */
export const OPEN_TIMEOUT_MS = 120_000;

/** Open the browser at a site. */
export async function openBrowser(url: string): Promise<BrowseStatus> {
  session = null;
  let answer: Partial<BrowseStatus>;
  try {
    answer = await ask<Partial<BrowseStatus>>(`/browse/open?url=${encodeURIComponent(url)}`, { method: 'POST', signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new BrowseError(
        `The proxy did not answer within ${Math.round(OPEN_TIMEOUT_MS / 1000)} seconds. Its /browse/status says what it is doing; try again in a moment, and if it keeps happening, redeploy the Worker from the current app repository.`,
        504,
      );
    }
    throw error;
  }
  const opened = { ...UNAVAILABLE, ...answer };
  session = opened.session || null;
  return opened;
}

/**
 * The next frame after `after`, or the status as it stands once the proxy
 * has waited its turn. Rejects the way an aborted fetch does on abort.
 */
export async function nextFrame(after: number, signal?: AbortSignal): Promise<BrowseStatus> {
  const response = await fetch(api(withSession(`/browse/frame?after=${after}`)), { headers: { Accept: 'application/json' }, signal });
  const payload = (await response.json().catch(() => ({}))) as Partial<BrowseStatus> & { error?: string; retryAfter?: unknown };
  if (!response.ok) throw refused(response.status, payload);
  return { ...UNAVAILABLE, ...payload };
}

/** Something done to the page. Several at once arrive in order. */
export async function sendInput(events: BrowseInput[]): Promise<void> {
  if (!events.length) return;
  await ask('/browse/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

async function pdfFrom(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(api(withSession(path)), init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; retryAfter?: unknown };
    throw refused(response.status, payload);
  }
  const blob = await response.blob();
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}

/** The PDF from the page the browser is on, found and fetched by the proxy with the browser's sign-in. */
export function grabPdf(name: string): Promise<Blob> {
  return pdfFrom(`/browse/grab?name=${encodeURIComponent(name)}`, { method: 'POST' });
}

/** The PDF the browser has met, as a blob. */
export function collectPdf(name: string): Promise<Blob> {
  return pdfFrom(`/browse/pdf?name=${encodeURIComponent(name)}`);
}

/** Close the page. The sign-in it made stays on the proxy, where the proxy can keep one. */
export async function closeBrowser(): Promise<void> {
  const open = session;
  session = null;
  if (open) {
    await fetch(api(`/browse/close?session=${encodeURIComponent(open)}`), { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => undefined);
    return;
  }
  await ask('/browse/close', { method: 'POST' }).catch(() => undefined);
}

// ------------------------------------------------------------------ sites ----

/** A site worth opening the browser at, for the chooser. */
export interface BrowseSite {
  url: string;
  host: string;
  label: string;
  /** Why it is on the list, for the line under the name. */
  note: string;
  /** True for the one that asked for the sign-in, which goes first. */
  walled?: boolean;
}

const bareHost = (host: string) => host.replace(/^www\./, '');

/**
 * Where to offer to go: every host the paper is published on, one entry
 * each, the one that wanted a sign-in first, then publishers — where the
 * institutional sign-in link is — then the rest; each at its landing page
 * where there is one, since a landing page is where the sign-in link lives,
 * else at the file. Google Scholar's page for the paper last, as the way to
 * a copy none of the indexes listed.
 */
export function browseSites(paper: PaperRef, locations: PaperLocation[] | null, signIn?: SignInOffer | null): BrowseSite[] {
  const walledHost = signIn ? bareHost(signIn.host) : null;
  const groups = new Map<string, PaperLocation[]>();
  for (const location of locations || []) {
    if (!/^https:\/\//i.test(location.url)) continue;
    const host = bareHost(location.host);
    groups.set(host, [...(groups.get(host) || []), location]);
  }
  if (walledHost && signIn && /^https:\/\//i.test(signIn.url) && !groups.has(walledHost)) {
    groups.set(walledHost, [{ url: signIn.url, host: walledHost, label: signIn.host, kind: 'publisher', isPdf: false, via: 'paper' }]);
  }

  const rankOf = (kind: PaperLocation['kind']) => (kind === 'publisher' ? 1 : kind === 'unknown' ? 2 : kind === 'repository' ? 3 : 4);
  const sites: (BrowseSite & { rank: number })[] = [];
  for (const [host, group] of groups) {
    const walled = host === walledHost;
    // A landing page beats a file as the place to sign in from; the offer's
    // own page, where there is one, is that landing page.
    const page = group.find((location) => !location.isPdf);
    const chosen = walled && signIn && /^https:\/\//i.test(signIn.url) ? { ...(page || group[0]), url: signIn.url, isPdf: false } : page || group[0];
    const kind = group.map((location) => location.kind).sort((a, b) => rankOf(a) - rankOf(b))[0];
    const label = group.find((location) => location.label && location.label !== location.host)?.label || chosen.label || host;
    const note = walled
      ? 'asked for a sign-in — go there and sign in through your institution'
      : chosen.isPdf
        ? kind === 'preprint'
          ? 'the preprint, as a file'
          : kind === 'repository'
            ? 'a repository copy, as a file'
            : 'a copy, as a file'
        : kind === 'publisher'
          ? "the publisher's page for the paper"
          : 'a page about the paper';
    sites.push({ url: chosen.url, host, label, note, walled, rank: walled ? 0 : rankOf(kind) });
  }
  sites.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  sites.push({
    url: scholarPaperUrl(paper),
    host: 'scholar.google.com',
    label: 'Google Scholar',
    note: 'every version Scholar knows of, including copies no index lists',
    rank: 9,
  });
  return sites.map(({ rank: _rank, ...site }) => site);
}

/**
 * What to tell the person when the page the browser is on is a site's check
 * for a person — Cloudflare's "Just a moment…" and its kin — rather than the
 * site itself, or null when it is not. The check is the site's, and it
 * either shows a box to tick or lets the browser through on its own; what
 * the person needs to know is which page they are looking at, whether the
 * box is worth ticking, and what to do instead when it is not.
 *
 * Two things decide that. The proxy says, from the response itself, whether
 * the page is Cloudflare's check and whether it has come back after the
 * person answered it (`status.check`); the title and the URL are the fallback
 * for a proxy that does not. And the proxy says whose browser it is
 * (`status.where`): when the check is Cloudflare's and the browser is
 * Cloudflare's own — the Worker's, through Browser Rendering — the check
 * will not pass, by Cloudflare's own design: it identifies every request its
 * rendering browsers make as a bot to every site it protects, and no number
 * of ticks changes that. Saying so is the kindest thing the pane can do,
 * since the box otherwise comes back for as long as anyone keeps ticking it.
 * Unless the Worker has a browser elsewhere to hand the session to
 * (`status.fallback`): then the check is a moment's wait, and the page
 * comes again from that browser, whose box is the person's to tick.
 */
export function botCheck(status: Pick<BrowseStatus, 'url' | 'title' | 'check' | 'where' | 'session' | 'fallback' | 'fallbackError'> | null): string | null {
  if (!status?.url) return null;
  let host = '';
  try {
    host = new URL(status.url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const title = status.title || '';
  const seen = status.check && status.check.host === host ? status.check : null;
  const cloudflareTitled = /[?&]__cf_chl(?:_rt)?_tk=/.test(status.url) || /^just a moment|attention required!?\s*\|\s*cloudflare/i.test(title);
  const generic = /verify you are human|security verification|checking your browser|are you a robot|one more step/i.test(title);
  if (!seen && !cloudflareTitled && !generic) return null;
  // The header the proxy saw is Cloudflare's own mark; the title is the guess.
  const cloudflares = Boolean(seen) || cloudflareTitled;
  const where = status.where ?? (status.session ? 'cloudflare' : 'proxy');
  const answered = (seen?.answered ?? 0) > 0;
  const own = 'Open the file in a tab of your own and drop it on the paper instead';
  if (cloudflares && where === 'cloudflare') {
    if (status.fallback === 'browserless') {
      if (status.fallbackError) {
        return `${host} is checking that a person is here, and the check is Cloudflare's, which Cloudflare's own browser never passes. It was to be handed to a browser at Browserless, but Browserless gave none — ${status.fallbackError.replace(/[.\s]+$/, '')} — so it stays here, where the box will not pass. ${own}, or check the token and the plan at Browserless and open this site again.`;
      }
      return `${host} is checking that a person is here, and the check is Cloudflare's, which Cloudflare's own browser never passes — so this session is being handed to a browser at Browserless, on an address of its own. A moment: the page opens again there, and a box that appears then is yours to tick.`;
    }
    const why =
      "the check is Cloudflare's and so is this browser, and Cloudflare tells every site it protects that its rendering browsers are bots";
    return answered
      ? `${host}'s check has come back after you answered it, and it will keep coming back: ${why}, so from here the check does not pass however many times the box is ticked. ${own}, or run the proxy on your own machine (Settings → Paper proxy), whose browser is its own.`
      : `${host} is checking that a person is here before it shows the page. It is not expected to pass from here — ${why} — and if the box comes back after you tick it, that is why. ${own}, or run the proxy on your own machine (Settings → Paper proxy), whose browser is its own.`;
  }
  if (answered) {
    return `${host}'s check has come back after you answered it: the site is refusing this browser, and ticking the box again rarely changes its mind. ${own}.`;
  }
  return `${host} is checking that a person is here before it shows the page. If a box to tick appears, tick it; when the check passes the page follows on its own. If it does not pass, open the file in a tab of your own and drop it on the paper instead.`;
}

/** A site typed by hand, made into something the proxy will open, or null. */
export function siteFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ input ----

/**
 * The DOM's name for a key, as Playwright wants it — which is the same name
 * for nearly everything. A dead key or an IME composition has no name the
 * proxy can press, and is left out.
 */
export function keyName(key: string): string | null {
  if (!key || key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
  if (key.length === 1) return key;
  return /^(?:F[1-9]|F1[0-2]|[A-Z][A-Za-z0-9]{1,20})$/.test(key) ? key : null;
}

/**
 * A point on the picture, as a point on the page: the picture is the page
 * scaled to fit, so the scale is the ratio of the two widths.
 */
export function toPagePoint(
  client: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  if (!box.width || !box.height) return { x: 0, y: 0 };
  const x = ((client.x - box.left) / box.width) * page.width;
  const y = ((client.y - box.top) / box.height) * page.height;
  return {
    x: Math.round(Math.max(0, Math.min(page.width, x))),
    y: Math.round(Math.max(0, Math.min(page.height, y))),
  };
}

/**
 * Input, sent in order and one request at a time. Mouse movement is the
 * one thing that arrives faster than it can be sent, and only the latest
 * position matters, so a move waiting to go is replaced rather than queued.
 */
export class InputQueue {
  private pending: BrowseInput[] = [];
  private sending = false;
  private failed: ((error: Error) => void) | null;

  constructor(onError?: (error: Error) => void) {
    this.failed = onError ?? null;
  }

  push(event: BrowseInput): void {
    if (event.type === 'move') {
      const last = this.pending[this.pending.length - 1];
      if (last?.type === 'move') {
        this.pending[this.pending.length - 1] = event;
        void this.flush();
        return;
      }
    }
    this.pending.push(event);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.pending.length) return;
    this.sending = true;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await sendInput(batch);
    } catch (error) {
      this.failed?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.sending = false;
      if (this.pending.length) void this.flush();
    }
  }
}
