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
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `The proxy answered ${response.status}.`);
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

/** Open the browser at a site. */
export async function openBrowser(url: string): Promise<BrowseStatus> {
  session = null;
  const opened = { ...UNAVAILABLE, ...(await ask<Partial<BrowseStatus>>(`/browse/open?url=${encodeURIComponent(url)}`, { method: 'POST' })) };
  session = opened.session || null;
  return opened;
}

/**
 * The next frame after `after`, or the status as it stands once the proxy
 * has waited its turn. Rejects the way an aborted fetch does on abort.
 */
export async function nextFrame(after: number, signal?: AbortSignal): Promise<BrowseStatus> {
  const response = await fetch(api(withSession(`/browse/frame?after=${after}`)), { headers: { Accept: 'application/json' }, signal });
  const payload = (await response.json().catch(() => ({}))) as Partial<BrowseStatus> & { error?: string };
  if (!response.ok) throw new Error(payload.error || `The proxy answered ${response.status}.`);
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
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `The proxy answered ${response.status}.`);
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
