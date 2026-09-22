/**
 * Google Scholar as a source, through the app's own proxy.
 *
 * Scholar publishes no API, so `server/scholar.js` fetches the pages a person
 * would open and parses them; this is the browser's half of that. It needs the
 * proxy for the same reason arXiv does — no CORS headers — and it needs it for
 * a second reason too: the request has to come from somewhere Scholar has not
 * already decided is a robot.
 *
 * Being refused is a normal outcome here, not an error to hide. `ScholarError`
 * carries `blocked`, and the panel says which sources are still answering
 * rather than showing an empty list.
 *
 * A captcha is the one refusal a person can do something about, and the
 * bottom of this file is how: the proxy opens the refused page in a real
 * browser window on its own machine, the person solves the captcha there,
 * and Scholar is asked again through that browser. The window cannot be this
 * tab's — the cookie a solve earns would land here, not on the proxy, and
 * Scholar would refuse the proxy exactly as before — so the proxy has to be
 * one with a screen: `npm start` on your own machine.
 */
import type { AuthorRef, PaperRef } from '../types';
import { api, hasProxy } from './api';

export interface ScholarResult {
  id?: string;
  title: string;
  url?: string;
  pdfUrl?: string;
  pdfKind?: string;
  pdfHost?: string;
  authors: string[];
  venue?: string;
  year?: number;
  snippet: string;
  citedBy?: number;
  clusterId?: string;
  versionCount?: number;
}

export interface ScholarAuthor {
  userId?: string;
  name: string;
  profileUrl?: string;
  affiliation?: string;
  verifiedEmail?: string;
  interests: string[];
  citedBy?: number;
}

export class ScholarError extends Error {
  blocked: boolean;
  reason?: string;
  /** The Scholar page that answered with a captcha — where it can be shown and solved. */
  captchaUrl?: string;
  constructor(message: string, blocked = false, reason?: string, captchaUrl?: string) {
    super(message);
    this.blocked = blocked;
    this.reason = reason;
    this.captchaUrl = captchaUrl;
  }
}

const NO_PROXY =
  'Google Scholar needs the proxy: it sends no CORS headers, and a request from a browser tab would never reach it. Settings → Paper proxy.';

const SCHOLAR = 'https://scholar.google.com';

/**
 * The Scholar page a proxy request stands for — the same URL `server/scholar.js`
 * builds. The proxy names the page it was refused on, but a proxy older than
 * this page does not, and the offer to show the captcha should not depend on
 * which one is answering: the page knows what it asked for.
 */
const scholarPage = (path: string, params: Record<string, string>) => `${SCHOLAR}/${path}?${new URLSearchParams(params)}`;

/**
 * One proxy request. `page` is the Scholar page it asks for, kept on the
 * error when Scholar answers it with a captcha, so the captcha can be shown.
 */
async function ask<T>(path: string, page: string, signal?: AbortSignal): Promise<T[]> {
  if (!hasProxy()) throw new ScholarError(NO_PROXY);
  let response: Response;
  try {
    response = await fetch(api(path), { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ScholarError('Could not reach the proxy to ask Google Scholar.');
  }
  const payload = (await response.json().catch(() => ({}))) as {
    results?: T[];
    error?: string;
    blocked?: boolean;
    reason?: string;
    url?: string;
  };
  if (!response.ok) {
    throw new ScholarError(
      payload.error || `Google Scholar search failed (${response.status})`,
      Boolean(payload.blocked),
      payload.reason,
      // A captcha, or a bare refusal that a real browser gets past: both are
      // answered by opening the page in the proxy's window.
      payload.blocked && (payload.reason === 'captcha' || payload.reason === 'refused') ? payload.url || page : undefined,
    );
  }
  return payload.results || [];
}

/**
 * A Scholar id is not a DOI and not an arXiv id, so a Scholar record folds in
 * with the other sources on its title — which is what `identity()` in
 * sources.ts falls back to. The cluster id rides along so that "all N
 * versions" can be asked for later.
 */
export function fromScholar(result: ScholarResult): PaperRef {
  const arxiv = (result.pdfUrl || result.url || '').match(/arxiv\.org\/(?:pdf|abs)\/([^?#]+?)(?:\.pdf)?$/i)?.[1];
  const doi = (result.url || '').match(/doi\.org\/(10\.[^?#\s]+)/i)?.[1];
  return {
    id: arxiv ? `arxiv:${arxiv}` : doi ? `doi:${doi.toLowerCase()}` : `scholar:${result.clusterId || result.id || result.title}`,
    source: 'scholar',
    title: result.title,
    authors: result.authors || [],
    // Scholar gives a two-line snippet rather than an abstract; it is marked as
    // what it is so the reader does not present it as one.
    abstract: result.snippet || '',
    published: result.year ? `${result.year}-01-01` : '',
    categories: [],
    arxivId: arxiv,
    doi: doi?.toLowerCase(),
    pdfUrl: result.pdfUrl,
    landingUrl: result.url,
    venue: result.venue,
    citedBy: result.citedBy,
    scholarCluster: result.clusterId,
    scholarVersions: result.versionCount,
  };
}

export async function searchScholar(query: string, page = 0, signal?: AbortSignal): Promise<PaperRef[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Scholar pages in tens, whatever we ask for.
  const start = page * 10;
  const results = await ask<ScholarResult>(
    `/scholar/search?q=${encodeURIComponent(trimmed)}&start=${start}`,
    scholarPage('scholar', { hl: 'en', as_sdt: '0,5', q: trimmed, ...(start ? { start: String(start) } : {}) }),
    signal,
  );
  return results.map(fromScholar);
}

export async function scholarAuthors(name: string, signal?: AbortSignal): Promise<AuthorRef[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const results = await ask<ScholarAuthor>(
    `/scholar/authors?name=${encodeURIComponent(trimmed)}`,
    scholarPage('citations', { hl: 'en', view_op: 'search_authors', mauthors: trimmed }),
    signal,
  );
  return results
    .filter((author) => author.name)
    .map((author) => ({
      id: `scholar:${author.userId || author.name}`,
      source: 'scholar' as const,
      name: author.name,
      affiliation: author.affiliation,
      citedBy: author.citedBy,
      scholarUserId: author.userId,
      scholarProfileUrl: author.profileUrl,
      interests: author.interests,
      verifiedEmail: author.verifiedEmail,
    }));
}

/** Everything on one person's Scholar profile, which is their own list. */
export async function scholarProfileWorks(userId: string, page = 0, signal?: AbortSignal): Promise<PaperRef[]> {
  const start = page * 20;
  const results = await ask<ScholarResult>(
    `/scholar/profile?user=${encodeURIComponent(userId)}&start=${start}`,
    scholarPage('citations', {
      hl: 'en',
      user: userId,
      cstart: String(start),
      pagesize: '20',
      view_op: 'list_works',
      sortby: 'pubdate',
    }),
    signal,
  );
  return results.map(fromScholar);
}

/**
 * Scholar's "All 84 versions" — every copy of one paper it knows of, which is
 * the longest such list anywhere and the reason this source is worth the
 * trouble. Each version is a result in its own right, carrying the host it
 * sits on and, where Scholar found one, a direct link to the file.
 */
export async function scholarVersions(clusterId: string, signal?: AbortSignal): Promise<ScholarResult[]> {
  if (!/^\d{1,25}$/.test(clusterId)) return [];
  return ask<ScholarResult>(
    `/scholar/versions?cluster=${encodeURIComponent(clusterId)}`,
    scholarPage('scholar', { hl: 'en', as_sdt: '0,5', cluster: clusterId }),
    signal,
  );
}

// ------------------------------------------------------------- the captcha --

export interface CaptchaStatus {
  /** Whether this proxy can open a window to show the captcha in at all. */
  available: boolean;
  /** Why not, worded for the person who could fix it. */
  reason?: string;
  /** Whether the captcha window is open right now. */
  window: 'open' | 'closed';
  /** Whether the last window ended with Scholar accepting the answer. */
  solved: boolean;
  /** Whether Scholar is now asked through the browser that solved it. */
  browser: boolean;
}

const CAPTCHA_UNAVAILABLE: CaptchaStatus = {
  available: false,
  window: 'closed',
  solved: false,
  browser: false,
  reason: 'There is no proxy configured, so there is nothing to show the captcha in.',
};

async function askCaptcha(path: string, init?: RequestInit): Promise<CaptchaStatus> {
  const response = await fetch(api(path), { ...init, headers: { Accept: 'application/json' } });
  const payload = (await response.json().catch(() => ({}))) as Partial<CaptchaStatus> & { error?: string };
  if (!response.ok) throw new Error(payload.error || `The proxy answered ${response.status}.`);
  return { ...CAPTCHA_UNAVAILABLE, ...payload };
}

/** The proxy's answer, fresh. */
export async function captchaStatus(): Promise<CaptchaStatus> {
  if (!hasProxy()) return CAPTCHA_UNAVAILABLE;
  try {
    return await askCaptcha('/scholar/captcha/status');
  } catch {
    // A proxy older than this page has no such route, and one that is down
    // has none either: no window, and what to do about it.
    return {
      ...CAPTCHA_UNAVAILABLE,
      reason:
        'This proxy is older than this page and does not know how to show a captcha. Update it: `npm run deploy:worker` for the Worker, or pull the repository and restart `npm start` on your machine, which is also the proxy that can open the window.',
    };
  }
}

/** Open the window at the Scholar page that was refused. */
export async function showCaptcha(url: string): Promise<void> {
  await askCaptcha(`/scholar/captcha?url=${encodeURIComponent(url)}`, { method: 'POST' });
}

/** "I have solved it": close the window, so the fetches can use the profile. */
export async function finishCaptcha(): Promise<void> {
  await askCaptcha('/scholar/captcha/close', { method: 'POST' }).catch(() => undefined);
}

/**
 * Resolves once the captcha window has closed — on its own, the moment
 * Scholar accepts the answer; by the person; or by `finishCaptcha`. Polls,
 * because the proxy has no way to call back, and gives up quietly on abort.
 */
export async function waitForCaptcha(signal?: AbortSignal, intervalMs = 1500): Promise<CaptchaStatus> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const status = await captchaStatus();
    if (status.window !== 'open') return status;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}
