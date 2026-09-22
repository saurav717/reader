import type { Paper, PaperLocation, PaperRef } from '../types';
import { api, hasProxy, NO_PROXY_REASON } from './api';
import { downloadFile, ensureDriveToken } from './google';
import { findLocations } from './locations';
import { fromOpenAlex, openAlexPdf, type OpenAlexWork } from './sources';
import { contactEmail } from './contact';

/**
 * Getting the actual PDF, whichever source a paper came from.
 *
 * arXiv is the easy case: the id is the URL. OpenAlex and Semantic Scholar
 * return an abstract and, when the paper is open access, a link to a PDF on
 * some publisher or repository — which the browser cannot fetch itself, both
 * because of CORS and because it is a cross-origin document. So every PDF goes
 * through the app's own proxy, and when a search result carries no link at all
 * we go back to the two APIs by DOI and ask again: search results and the
 * per-work record do not always agree about what is free to read.
 */

const https = (url: string | undefined | null): string | undefined => {
  if (!url) return undefined;
  const upgraded = url.replace(/^http:\/\//i, 'https://');
  return /^https:\/\//i.test(upgraded) ? upgraded : undefined;
};

/** The upstream PDF URL for a paper, before the proxy is involved. */
export function pdfSourceUrl(paper: PaperRef): string | undefined {
  if (paper.arxivId) return `https://arxiv.org/pdf/${paper.arxivId}`;
  return https(paper.pdfUrl);
}

/** A filename a person would recognise in their downloads folder. */
export function pdfFileName(paper: PaperRef): string {
  const stem = paper.title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const tail = paper.arxivId ? ` (arXiv ${paper.arxivId})` : '';
  return `${stem || 'paper'}${tail}`;
}

/**
 * Where to fetch a paper's PDF from this app. Null when there is no PDF to
 * fetch, or no proxy to fetch it through.
 */
export function pdfProxyUrl(paper: PaperRef, options: { download?: boolean } = {}): string | null {
  if (!hasProxy()) return null;
  const name = encodeURIComponent(pdfFileName(paper));
  const download = options.download ? '&download=1' : '';
  if (paper.arxivId) {
    return api(`/arxiv/pdf?id=${encodeURIComponent(paper.arxivId)}&name=${name}${download}`);
  }
  const source = https(paper.pdfUrl);
  if (!source) return null;
  return api(`/pdf?url=${encodeURIComponent(source)}&name=${name}${download}`);
}

/**
 * The same, for one location out of a paper's list rather than for whichever
 * link the paper happened to arrive with. arXiv keeps its own route because it
 * is the one host the proxy knows how to ask by id.
 */
export function locationProxyUrl(
  paper: PaperRef,
  location: PaperLocation,
  options: { download?: boolean } = {},
): string | null {
  if (!hasProxy()) return null;
  const name = encodeURIComponent(pdfFileName(paper));
  const download = options.download ? '&download=1' : '';
  const arxiv = location.host === 'arxiv.org' ? location.url.match(/\/pdf\/([^?#]+?)(?:\.pdf)?$/i)?.[1] : null;
  if (arxiv) return api(`/arxiv/pdf?id=${encodeURIComponent(arxiv)}&name=${name}${download}`);
  const source = https(location.url);
  if (!source) return null;
  return api(`/pdf?url=${encodeURIComponent(source)}&name=${name}${download}`);
}

// ------------------------------------------------------------- resolving ----

async function openAlexPdfFor(paper: PaperRef, signal?: AbortSignal): Promise<string | undefined> {
  const key = paper.doi
    ? `doi:${paper.doi}`
    : paper.id.startsWith('https://openalex.org/')
      ? paper.id.split('/').pop()
      : undefined;
  if (key) {
    const response = await fetch(`https://api.openalex.org/works/${encodeURIComponent(key)}`, { signal });
    if (response.ok) return openAlexPdf((await response.json()) as OpenAlexWork);
    if (response.status !== 404) return undefined;
  }
  if (!paper.title) return undefined;
  // No DOI — match on the title instead, and only trust an exact match.
  const params = new URLSearchParams({ per_page: '1' });
  params.set('filter', `title.search:${paper.title.replace(/[,:|]+/g, ' ').slice(0, 200)}`);
  const response = await fetch(`https://api.openalex.org/works?${params}`, { signal });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { results?: OpenAlexWork[] };
  const work = (payload.results || [])[0];
  if (!work) return undefined;
  const same = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (same(fromOpenAlex(work).title) !== same(paper.title)) return undefined;
  return openAlexPdf(work);
}

async function semanticScholarPdfFor(paper: PaperRef, signal?: AbortSignal): Promise<string | undefined> {
  const key = paper.arxivId
    ? `ARXIV:${paper.arxivId.replace(/v\d+$/, '')}`
    : paper.doi
      ? `DOI:${paper.doi}`
      : paper.id.startsWith('s2:')
        ? paper.id.slice(3)
        : undefined;
  if (!key) return undefined;
  const response = await fetch(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(key)}?fields=openAccessPdf`,
    { signal },
  );
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { openAccessPdf?: { url?: string } | null };
  return https(payload.openAccessPdf?.url);
}

interface UnpaywallLocation {
  url_for_pdf?: string | null;
  url?: string | null;
}

/**
 * Unpaywall, which does one job — find the free copy of a DOI — and does it
 * better than either index, because it also knows about repository deposits
 * the publisher never advertises. It requires a contact address and refuses
 * the request without one, so no email in Settings means this is skipped.
 */
async function unpaywallPdfFor(paper: PaperRef, signal?: AbortSignal): Promise<string | undefined> {
  const email = contactEmail();
  if (!email || !paper.doi) return undefined;
  const response = await fetch(
    `https://api.unpaywall.org/v2/${encodeURIComponent(paper.doi)}?email=${encodeURIComponent(email)}`,
    { signal },
  );
  if (!response.ok) return undefined;
  const payload = (await response.json()) as {
    best_oa_location?: UnpaywallLocation | null;
    oa_locations?: UnpaywallLocation[] | null;
  };
  const candidates = [payload.best_oa_location, ...(payload.oa_locations || [])];
  for (const location of candidates) {
    const found = https(location?.url_for_pdf || location?.url);
    if (found) return found;
  }
  return undefined;
}

/**
 * A PDF link for a paper that arrived without one. Unpaywall first where we
 * have a DOI and an address to give it, then OpenAlex — which knows about more
 * repositories than Semantic Scholar — and Semantic Scholar last. Returns
 * undefined when the paper simply is not free to read anywhere any of them can
 * see.
 */
export async function resolvePdfUrl(paper: PaperRef, signal?: AbortSignal): Promise<string | undefined> {
  const known = pdfSourceUrl(paper);
  if (known) return known;
  for (const lookup of [unpaywallPdfFor, openAlexPdfFor, semanticScholarPdfFor]) {
    try {
      const found = await lookup(paper, signal);
      if (found) return found;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // One source being down is not a reason to skip the other.
    }
  }
  return undefined;
}

// -------------------------------------------------------------- fetching ----

/** A copy a person could get by signing in, and where to go to do it. */
export interface SignInOffer {
  host: string;
  /** The publisher's page to open the sign-in window at. */
  url: string;
}

export class PdfError extends Error {
  /** True when the publisher answered with a login wall rather than the file. */
  loginWall: boolean;
  /** The host that wanted the sign-in. */
  host?: string;
  /** Set on the summary error when at least one copy was behind a login. */
  signIn?: SignInOffer;

  constructor(message: string, options: { loginWall?: boolean; host?: string; signIn?: SignInOffer } = {}) {
    super(message);
    this.loginWall = Boolean(options.loginWall);
    this.host = options.host;
    this.signIn = options.signIn;
  }
}

async function downloadPdf(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new PdfError('Could not reach the PDF.');
  }
  if (!response.ok) {
    const body = await response
      .json()
      .then((payload: { error?: string; loginWall?: boolean; host?: string }) => payload)
      .catch(() => undefined);
    const detail = body?.error;
    throw new PdfError(detail ? `Could not fetch the PDF — ${detail}.` : 'Could not fetch the PDF.', {
      loginWall: Boolean(body?.loginWall),
      host: body?.host,
    });
  }
  const blob = await response.blob();
  // Keep the type honest: a blob URL only renders in the viewer if it says PDF.
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}

/**
 * Downloads in progress, by URL. Opening a paper straight from a search result
 * asks for its PDF twice — the viewer wants to show it, the Drive sync wants to
 * upload it — and they are the same file. One request, handed to both.
 *
 * The last one is kept for a minute after it lands, because those two requests
 * are not always in flight at the same moment: the sync starts as the paper is
 * added and the viewer starts as the reader mounts, which on a fast connection
 * is after the first has finished. One paper's worth of bytes — the viewer is
 * holding the same blob anyway — against fetching a whole PDF twice.
 */
const inFlight = new Map<string, Promise<Blob>>();
const KEEP_MS = 60_000;
let recent: { url: string; blob: Blob; at: number } | null = null;

/** Rejects the way an aborted fetch does, so callers need no special case. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * The PDF itself, through the proxy. A blob rather than a bare URL in an
 * `<iframe>` so that a failure is something we can explain rather than a blank
 * grey pane, and so the Download button does not fetch the file a second time.
 *
 * A caller that gives up takes its own promise with it; the download itself
 * carries on for whoever else is waiting on it.
 */
export async function fetchPdf(paper: PaperRef, signal?: AbortSignal): Promise<Blob> {
  if (!hasProxy()) throw new PdfError(NO_PROXY_REASON);
  const url = pdfProxyUrl(paper);
  if (!url) throw new PdfError('No PDF is available for this paper.');
  return shareDownload(url, signal);
}

/** One download per URL, however many callers are waiting on it. */
function shareDownload(url: string, signal?: AbortSignal): Promise<Blob> {
  if (recent && recent.url === url && Date.now() - recent.at < KEEP_MS) return Promise.resolve(recent.blob);

  let shared = inFlight.get(url);
  if (!shared) {
    shared = downloadPdf(url)
      .then((blob) => {
        recent = { url, blob, at: Date.now() };
        return blob;
      })
      .finally(() => inFlight.delete(url));
    inFlight.set(url, shared);
    // Nobody may be listening yet, and an unhandled rejection is noisy.
    shared.catch(() => undefined);
  }
  return signal ? Promise.race([shared, whenAborted(signal)]) : shared;
}

// ----------------------------------------------------------- every copy ----

export interface FetchedFromLocation {
  blob: Blob;
  /** Which of the copies actually answered. */
  location: PaperLocation;
  /** The ones tried before it, and why each failed. */
  tried: { location: PaperLocation; error: string }[];
}

/**
 * The paper, from whichever of its copies will part with one.
 *
 * A single link is a coin toss: a publisher's DOI resolves to a login wall, a
 * repository link rots, a `.pdf` URL turns out to be a landing page — and
 * until it has been asked, all of them look alike. So each copy is tried in
 * turn, best first, and the first one that returns actual PDF bytes wins. The
 * proxy does the deciding: it refuses anything that is not a PDF, which is
 * what makes "did this work" answerable rather than a guess.
 */
export async function fetchPdfFromLocations(
  paper: PaperRef,
  locations: PaperLocation[],
  signal?: AbortSignal,
): Promise<FetchedFromLocation> {
  if (!hasProxy()) throw new PdfError(NO_PROXY_REASON);
  // A landing page is worth asking for too — plenty of them answer with the
  // file — but only after every copy that claims to be one has been tried.
  const candidates = locations.filter((location) => locationProxyUrl(paper, location));
  if (!candidates.length) throw new PdfError('No open-access copy of this paper could be found anywhere we can see.');

  const tried: { location: PaperLocation; error: string; loginWall: boolean; host?: string }[] = [];
  for (const location of candidates) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = locationProxyUrl(paper, location) as string;
    try {
      return { blob: await shareDownload(url, signal), location, tried };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      tried.push({
        location,
        error: error instanceof Error ? error.message : String(error),
        loginWall: error instanceof PdfError && error.loginWall,
        host: error instanceof PdfError ? error.host : undefined,
      });
    }
  }

  // Say which copies were tried: "it did not work" is not actionable, and the
  // list is often the answer — every copy being the publisher's means the
  // paper is simply not open access. Two copies at the same publisher are one
  // name with a count, not the name twice.
  const counts = new Map<string, number>();
  for (const entry of tried) counts.set(entry.location.label, (counts.get(entry.location.label) || 0) + 1);
  const names = Array.from(counts.entries()).map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const summary = names.slice(0, 3).join(', ') + (names.length > 3 ? `, and ${names.length - 3} more` : '');

  // A login wall is the one failure a person can do something about, so it is
  // named — and the offer carries the publisher's own page to sign in at,
  // which is where the institutional sign-in link lives.
  const walled = tried.find((entry) => entry.loginWall);
  const signIn = walled ? signInOffer(walled.host || walled.location.host, locations) : undefined;
  throw new PdfError(
    `None of the ${candidates.length} known ${candidates.length === 1 ? 'copy' : 'copies'} of this paper would hand over a PDF` +
      `${summary ? ` (tried ${summary})` : ''}` +
      `${signIn ? ` — ${walled?.location.label || signIn.host} asks for a sign-in` : ''}.`,
    { loginWall: Boolean(signIn), host: signIn?.host, signIn },
  );
}

/** The page to sign in at for a host: its landing page if we know one, else the file's URL. */
function signInOffer(host: string, locations: PaperLocation[]): SignInOffer {
  const same = locations.filter((location) => location.host === host.replace(/^www\./, ''));
  const page = same.find((location) => !location.isPdf) || same[0];
  return { host, url: page ? page.url : `https://${host}/` };
}

/** Save a blob under a name, from the page, with no round trip to a server. */
export function saveBlob(blob: Blob, paper: PaperRef): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${pdfFileName(paper)}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can beat the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Whether a paper in the library already knows where its PDF is. */
export const hasKnownPdf = (paper: Paper): boolean => Boolean(pdfSourceUrl(paper));

export type PdfAvailability = 'checking' | 'ready' | 'none';

/**
 * Whether there is a PDF to open, from everything the reader knows about a
 * paper — not only the one link it arrived with.
 *
 * A paper has a PDF to show when Drive already holds a copy, when a single
 * link is known or was resolved by DOI, or when any of the places it is
 * published is a file rather than a landing page. A list of landing pages
 * alone is not a PDF to open: `fetchPdfFromLocations` will try them, but a
 * paper that opens on a login wall is worse than one that opens on its
 * abstract with the copies listed beside it. The answer is `checking` only
 * while the by-DOI lookup or the search for copies is still out; once both
 * are back with nothing, it is `none`.
 *
 * This used to hinge on the single link alone, which is what left a paper
 * from a Google Scholar profile — no DOI, no arXiv id, three copies on the
 * author's own university site and one already in Drive — opening on
 * "No PDF of this paper is free to read anywhere we can see".
 */
export function pdfAvailability(known: {
  /** A single link: the paper's own, or the one resolved by DOI. */
  pdfUrl?: string | null;
  /** Whether the by-DOI lookup for that link has finished. */
  resolved: boolean;
  /** Drive holds a copy, and it can be read back from there. */
  driveCopy: boolean;
  /** Everywhere the paper is published, or null while that is being looked up. */
  locations: PaperLocation[] | null;
}): PdfAvailability {
  if (known.driveCopy || known.pdfUrl) return 'ready';
  if (known.locations?.some((location) => location.isPdf)) return 'ready';
  if (!known.resolved || known.locations === null) return 'checking';
  return 'none';
}

// ------------------------------------------------------------------ Drive ---

/** Where a copy of the file came from, for the line under the title. */
export type PdfOrigin = 'drive' | 'proxy' | 'file' | 'browser';

/**
 * A file handed over by the person, checked to be a PDF before anything is
 * done with it. The browser will not fetch a publisher's file for the page,
 * signed in or not, but it will read one the person drops on it — which is
 * the way through a login wall that needs no proxy at all.
 */
export async function pdfFromFile(file: Blob): Promise<Blob> {
  if (!file.size) throw new PdfError('That file is empty.');
  if (file.size > 64 * 1024 * 1024) throw new PdfError('That file is larger than 64 MB, which is more than a paper.');
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const magic = String.fromCharCode(...head);
  if (!magic.startsWith('%PDF')) throw new PdfError('That file is not a PDF.');
  return file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
}

export interface FetchedPdf {
  blob: Blob;
  from: PdfOrigin;
  /** Which copy answered, when it was not the one in Drive. */
  location?: PaperLocation;
}

/**
 * The PDF, preferring the copy in Drive.
 *
 * Once a paper has been synced, Drive holds the same bytes the proxy fetched —
 * and Google's API, unlike arXiv and the publishers, answers the browser
 * directly. So a paper that has been saved reads back without the proxy at all,
 * which also means it still opens on a deployment that has no server.
 *
 * Drive is only ever the *second* place a PDF can come from: putting it there
 * means uploading bytes, and getting the bytes in the first place is the
 * cross-origin fetch the browser will not do. There is no asking Drive to go
 * and fetch a URL for us.
 */
export async function fetchPaperPdf(
  paper: PaperRef,
  options: {
    driveFileId?: string;
    clientId?: string;
    driveConnected?: boolean;
    /** The copies already resolved for this paper, if the caller has them. */
    locations?: PaperLocation[];
  } = {},
  signal?: AbortSignal,
): Promise<FetchedPdf> {
  const { driveFileId, clientId, driveConnected } = options;

  if (driveFileId && driveConnected && clientId) {
    try {
      const token = await ensureDriveToken(clientId);
      return { blob: await downloadFile(token, driveFileId, signal), from: 'drive' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // The copy may have been deleted, or the grant may have lapsed. The
      // publisher is still there, so this is not worth failing over.
      if (!hasProxy()) {
        throw new PdfError('The copy in your Drive could not be read, and there is no server to fetch it through.');
      }
    }
  }

  // Not in Drive: ask every place the paper is published, best copy first,
  // rather than betting the whole thing on the one link a search result
  // happened to carry.
  const locations = options.locations ?? (await findLocations(paper, signal));
  const fetched = await fetchPdfFromLocations(paper, locations, signal);
  return { blob: fetched.blob, from: 'proxy', location: fetched.location };
}
