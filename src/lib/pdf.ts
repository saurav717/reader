import type { Paper, PaperLocation, PaperRef } from '../types';
import { api, apiHeaders, hasProxy, NO_PROXY_REASON } from './api';
import { downloadFile, ensureDriveToken, findFile, findFolder } from './google';
import { baseName, ROOT_FOLDER } from './sidecar';
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
  // A book or a pasted link is in none of these indexes, and asking them by
  // its title only finds some other work of the same name.
  if (paper.source === 'books') return undefined;
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

/**
 * A copy behind a site's check for a person — Cloudflare's "Verify you are
 * human" — rather than a sign-in, and whose proxy met it. From the Worker
 * such a check never passes, by Cloudflare's own design (it identifies its
 * rendering browsers as bots to every site it protects), so the reader
 * says so and points at a tab of the person's own; from the Node proxy a
 * window or the browser in the pane may pass it; and from the Worker with
 * a browser at Browserless, that browser met a box to tick, which the pane
 * — opened there — offers to the person.
 */
export interface CheckOffer {
  host: string;
  /** The file's own URL, to open in a tab of your own, where your browser passes the check. */
  url: string;
  where: 'cloudflare' | 'proxy' | 'browserless';
}

export class PdfError extends Error {
  /** True when the publisher answered with a login wall rather than the file. */
  loginWall: boolean;
  /** The host that wanted the sign-in. */
  host?: string;
  /** Set on the summary error when at least one copy was behind a login. */
  signIn?: SignInOffer;
  /** Set when a copy was behind a site's check for a person, and whose proxy met it. */
  check?: CheckOffer;
  /** Set on the summary error: each copy that was asked, and what it said. */
  tried?: CopyAttempt[];

  constructor(
    message: string,
    options: { loginWall?: boolean; host?: string; signIn?: SignInOffer; check?: CheckOffer; tried?: CopyAttempt[] } = {},
  ) {
    super(message);
    this.loginWall = Boolean(options.loginWall);
    this.host = options.host;
    this.signIn = options.signIn;
    this.check = options.check;
    this.tried = options.tried;
  }
}

async function downloadPdf(url: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    // Always the proxy's address (see pdfProxyUrl), so the token goes along.
    response = await fetch(url, { signal, headers: apiHeaders() });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new PdfError('Could not reach the PDF.');
  }
  if (!response.ok) {
    const body = await response
      .json()
      .then((payload: { error?: string; loginWall?: boolean; host?: string; botCheck?: boolean; where?: string }) => payload)
      .catch(() => undefined);
    const detail = body?.error;
    const check =
      body?.botCheck && body.host
        ? {
            host: body.host,
            url: new URL(url, location.href).searchParams.get('url') || `https://${body.host}/`,
            where: body.where === 'proxy' ? ('proxy' as const) : body.where === 'browserless' ? ('browserless' as const) : ('cloudflare' as const),
          }
        : undefined;
    throw new PdfError(detail ? `Could not fetch the PDF — ${detail}.` : 'Could not fetch the PDF.', {
      loginWall: Boolean(body?.loginWall),
      host: body?.host,
      check,
    });
  }
  const blob = await readBody(response, signal);
  // Keep the type honest: a blob URL only renders in the viewer if it says PDF.
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}

/**
 * A response's body, with a connection that broke or was cut short on the
 * way said as that. The browser's own words for it are no help — Safari's
 * are "Load failed", Chrome's "Failed to fetch" — and they arrived under
 * a copy's name as if the site had said them.
 */
async function readBody(response: Response, signal?: AbortSignal): Promise<Blob> {
  try {
    return await response.blob();
  } catch (error) {
    if ((error instanceof DOMException && error.name === 'AbortError') || signal?.aborted) throw error;
    const said = error instanceof Error ? error.message : String(error);
    throw new PdfError(`Could not fetch the PDF — the connection to the proxy broke before the whole file arrived (${said})`);
  }
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
const inFlight = new Map<string, { promise: Promise<Blob>; controller: AbortController; waiting: number }>();
const KEEP_MS = 60_000;
let recent: { url: string; blob: Blob; at: number } | null = null;

/** How many of a paper's copies are asked for at once. */
export const COPIES_AT_ONCE = 3;

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

/**
 * One download per URL, however many callers are waiting on it — and none
 * once the last of them has gone. A caller that gives up takes its own
 * promise with it; when nobody is left waiting the download itself is
 * stopped, since through the proxy it is not only bandwidth: a copy behind
 * a site's check is fetched from a browser at Browserless, whose one
 * session on the free plan is the one the pane in the reader needs when
 * the person leaves the copies to sign in there instead. A caller with no
 * signal is counted as waiting for good.
 */
function shareDownload(url: string, signal?: AbortSignal): Promise<Blob> {
  if (recent && recent.url === url && Date.now() - recent.at < KEEP_MS) return Promise.resolve(recent.blob);

  let shared = inFlight.get(url);
  if (!shared) {
    const controller = new AbortController();
    const entry = {
      controller,
      waiting: 0,
      promise: downloadPdf(url, controller.signal)
        .then((blob) => {
          recent = { url, blob, at: Date.now() };
          return blob;
        })
        .finally(() => {
          if (inFlight.get(url) === entry) inFlight.delete(url);
        }),
    };
    // Nobody may be listening yet, and an unhandled rejection is noisy.
    entry.promise.catch(() => undefined);
    inFlight.set(url, entry);
    shared = entry;
  }
  if (!signal) {
    shared.waiting = Number.POSITIVE_INFINITY;
    return shared.promise;
  }
  const entry = shared;
  entry.waiting += 1;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    entry.waiting -= 1;
    if (entry.waiting <= 0 && inFlight.get(url) === entry) {
      inFlight.delete(url);
      entry.controller.abort();
    }
  };
  return Promise.race([entry.promise, whenAborted(signal)]).finally(() => {
    // Settled either way: this caller is no longer waiting. Only an abort
    // can leave the download with nobody on it, since a download that
    // finished has finished for everyone.
    if (signal.aborted) leave();
  });
}

// ----------------------------------------------------------- every copy ----

/** One copy that was asked for the file, and what came of it. */
export interface CopyAttempt {
  location: PaperLocation;
  /** Why it was not the one shown: the proxy's refusal, or what the file looked like. */
  error: string;
  /** True when it did hand over a PDF, but one that did not look like the paper. */
  doubtful?: boolean;
}

/**
 * A second opinion on a PDF a copy handed over: why it is probably not the
 * paper — a poster, slides — or null when it looks like one. `paperContent`'s
 * `judgePdf` is the one the reader uses.
 */
export type PdfJudge = (blob: Blob, location: PaperLocation) => Promise<string | null>;

export interface FetchedFromLocation {
  blob: Blob;
  /** Which of the copies actually answered. */
  location: PaperLocation;
  /** The ones tried before it, and why each was passed over. */
  tried: CopyAttempt[];
  /**
   * Set when every copy that answered looked wrong to the judge, and this is
   * the best of them — shown, since it is what there is, with a word why.
   */
  doubt?: string;
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
 *
 * A PDF is not always the paper, though — a conference's link can be the
 * poster. With a `judge`, a file it has doubts about is held back while the
 * other copies are asked, and returned (with `doubt` saying why) only when
 * none of them answers with anything better.
 *
 * A `preferred` copy — the one picked by hand — is asked on its own before
 * any other is started, so a quicker copy cannot answer in its place; the
 * rest are asked only if it will not hand the file over.
 */
export async function fetchPdfFromLocations(
  paper: PaperRef,
  locations: PaperLocation[],
  signal?: AbortSignal,
  options: { judge?: PdfJudge; preferred?: string } = {},
): Promise<FetchedFromLocation> {
  if (!hasProxy()) throw new PdfError(NO_PROXY_REASON);
  // A landing page is worth asking for too — plenty of them answer with the
  // file — but only after every copy that claims to be one has been tried.
  const candidates = locations.filter((location) => locationProxyUrl(paper, location));
  if (!candidates.length) throw new PdfError('No open-access copy of this paper could be found anywhere we can see.');

  // A few at a time, best copy first, and the first to answer wins. One at a
  // time was the sum of every refusal before the one that answered — and a
  // refusal is not quick: a publisher's page fetched in full, a login wall
  // followed, a check for a person met and handed to another browser — so
  // ten copies could be minutes before the reader said anything. The window
  // starts in rank order, so the copies most likely to answer without a
  // wall have the head start; a copy that answers is the file whichever it
  // is. One copy per site at a time, though: two copies at one publisher
  // answer alike, and a site with a check in front of its files is asked
  // from a browser at Browserless, which has one session to give on the
  // free plan. The downloads a win leaves in flight run on for whoever asks
  // next (see `shareDownload`), which is a couple of files at most.
  const tried: (CopyAttempt & { loginWall: boolean; host?: string; check?: CheckOffer })[] = [];
  /** The best-ranked file the judge had doubts about, kept in case nothing better comes. */
  let held: { index: number; blob: Blob; doubt: string } | null = null;
  const attempts = (): CopyAttempt[] => tried.map(({ location, error, doubtful }) => (doubtful ? { location, error, doubtful } : { location, error }));
  type Settled = { index: number; blob?: Blob; error?: unknown };
  const inFlight = new Map<number, Promise<Settled>>();
  const started = new Set<number>();
  const hostOf = (location: PaperLocation) => location.host.replace(/^www\./, '');
  const busy = () => new Set(Array.from(inFlight.keys(), (index) => hostOf(candidates[index])));
  /** The copy picked by hand, while it has the floor to itself. */
  let alone = options.preferred ? candidates.findIndex((location) => location.url === options.preferred) : -1;
  const launch = () => {
    const hosts = busy();
    const index =
      alone >= 0
        ? started.has(alone)
          ? -1
          : alone
        : candidates.findIndex((location, at) => !started.has(at) && !hosts.has(hostOf(location)));
    if (index < 0) return false;
    started.add(index);
    const url = locationProxyUrl(paper, candidates[index]) as string;
    inFlight.set(
      index,
      shareDownload(url, signal).then(
        (blob) => ({ index, blob }),
        (error: unknown) => ({ index, error }),
      ),
    );
    return true;
  };
  while (started.size < candidates.length && inFlight.size < COPIES_AT_ONCE && launch());
  while (inFlight.size) {
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.index);
    if (settled.index === alone) alone = -1;
    const location = candidates[settled.index];
    if (settled.blob) {
      // With nothing else to try, a doubt would change nothing — and asking
      // it means loading pdf.js, which a reader in PDF mode otherwise never does.
      const doubt = options.judge && candidates.length > 1 ? await options.judge(settled.blob, location) : null;
      if (!doubt) return { blob: settled.blob, location, tried: attempts() };
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      tried.push({ location, error: doubt, doubtful: true, loginWall: false });
      if (!held || settled.index < held.index) held = { index: settled.index, blob: settled.blob, doubt };
      while (started.size < candidates.length && inFlight.size < COPIES_AT_ONCE && launch());
      continue;
    }
    const error = settled.error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    tried.push({
      location,
      error: error instanceof Error ? error.message : String(error),
      loginWall: error instanceof PdfError && error.loginWall,
      host: error instanceof PdfError ? error.host : undefined,
      check: error instanceof PdfError ? error.check : undefined,
    });
    while (started.size < candidates.length && inFlight.size < COPIES_AT_ONCE && launch());
  }

  // Every copy has answered, and none with a file that looked like the
  // paper: the best of the doubtful ones is still better than nothing.
  if (held) {
    const location = candidates[held.index];
    return { blob: held.blob, location, tried: attempts().filter((entry) => entry.location !== location), doubt: held.doubt };
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
  // A check for a person is named too, with the file's own URL to open in a
  // tab of the person's own — the one browser such a check is sure to pass.
  const checked = tried.find((entry) => entry.check)?.check;
  const check = checked ? { ...checked, url: tried.find((entry) => entry.check === checked)?.location.url || checked.url } : undefined;
  throw new PdfError(
    `None of the ${candidates.length} known ${candidates.length === 1 ? 'copy' : 'copies'} of this paper would hand over a PDF` +
      `${summary ? ` (tried ${summary})` : ''}` +
      `${signIn ? ` — ${walled?.location.label || signIn.host} asks for a sign-in` : ''}` +
      `${check && !signIn ? ` — ${check.host} checks for a person before it hands out the file` : ''}.`,
    { loginWall: Boolean(signIn), host: signIn?.host, signIn, check, tried: attempts() },
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
  /** The copies asked before it, and why each was passed over. */
  tried?: CopyAttempt[];
  /** Why the file shown may not be the paper, when every copy that answered looked doubtful. */
  doubt?: string;
  /**
   * The copy in Drive this came from, when Drive was asked by name and had
   * one the library did not know about — for the caller to record, so the
   * next open needs no lookup.
   */
  drive?: { folderId: string; pdfFileId: string; pdfLink?: string };
}

/**
 * Whether Drive already holds this paper's PDF, by the name the sync gives it:
 * `<root>/<paper>/<paper>.pdf`. The library records the file's id when it
 * does the saving — but the file can be there without the record: saved
 * from another browser, saved before the library was cleared, or saved by a
 * sync whose result never made it back. Drive is the shared copy; the
 * library is only this browser's memory of it. So a paper with no id on
 * record is looked for by name before anything is asked of the proxy.
 *
 * `folderId` short-cuts to the paper's own folder when the library knows it
 * (a paper synced as metadata only), which makes it one request rather
 * than three. A look, never a create: a paper that is not in Drive leaves
 * nothing behind, and nothing is cached between looks, so a folder deleted
 * or renamed by hand in Drive is seen as it is on the next open.
 */
export async function findPdfInDrive(
  accessToken: string,
  paper: PaperRef,
  options: { rootFolderName?: string; folderId?: string } = {},
): Promise<{ folderId: string; pdfFileId: string; pdfLink?: string } | null> {
  const stem = baseName(paper);
  let folderId = options.folderId ?? null;
  if (!folderId) {
    const rootId = await findFolder(accessToken, options.rootFolderName || ROOT_FOLDER);
    if (!rootId) return null;
    folderId = await findFolder(accessToken, stem, rootId);
    if (!folderId) return null;
  }
  const file = await findFile(accessToken, `${stem}.pdf`, folderId);
  return file ? { folderId, pdfFileId: file.id, pdfLink: file.webViewLink } : null;
}

/**
 * The copy in Drive, or null when Drive has none: by the id the library
 * recorded, else by name (see `findPdfInDrive`). Needs no list of the
 * paper's copies, so the reader asks this the moment a paper opens, while
 * the indexes are still being asked where else it is — a paper already in
 * Drive is on screen before that list is back. What goes wrong reading a
 * copy Drive does have (deleted by hand, the grant lapsed) is thrown, so the
 * caller can tell "nothing there" from "could not be read".
 */
export async function fetchPdfFromDrive(
  paper: PaperRef,
  options: {
    driveFileId?: string;
    driveFolderId?: string;
    rootFolderName?: string;
    clientId?: string;
    driveConnected?: boolean;
  },
  signal?: AbortSignal,
): Promise<FetchedPdf | null> {
  const { driveFileId, driveFolderId, rootFolderName, clientId, driveConnected } = options;
  if (!driveConnected || !clientId) return null;
  const token = await ensureDriveToken(clientId);
  let fileId = driveFileId;
  let found: FetchedPdf['drive'];
  if (!fileId) {
    found = (await findPdfInDrive(token, paper, { rootFolderName, folderId: driveFolderId })) ?? undefined;
    fileId = found?.pdfFileId;
  }
  if (!fileId) return null;
  return { blob: await downloadFile(token, fileId, signal), from: 'drive', drive: found };
}

/**
 * The PDF, preferring the copy in Drive.
 *
 * Once a paper has been synced, Drive holds the same bytes the proxy fetched —
 * and Google's API, unlike arXiv and the publishers, answers the browser
 * directly. So a paper that has been saved reads back without the proxy at all,
 * which also means it still opens on a deployment that has no server.
 *
 * Drive is asked first whenever it is connected: by the file id the library
 * recorded when it saved the paper, or, with none on record, by name — so a
 * paper saved from another browser, or one whose save the library did not
 * hear about, still opens on its copy in Drive rather than going back to the
 * publisher (and back through the sign-in) for the same bytes. Only when
 * Drive has nothing is a copy fetched through the proxy.
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
    /** The paper's own folder in Drive, when the library knows it: a shorter look. */
    driveFolderId?: string;
    /** The top-level folder the papers are kept in, when it is not the default. */
    rootFolderName?: string;
    clientId?: string;
    driveConnected?: boolean;
    /** The copies already resolved for this paper, if the caller has them. */
    locations?: PaperLocation[];
    /** A second opinion on each file a copy hands over; see `fetchPdfFromLocations`. */
    judge?: PdfJudge;
    /** The copy picked by hand, asked alone before the rest; see `fetchPdfFromLocations`. */
    preferred?: string;
  } = {},
  signal?: AbortSignal,
): Promise<FetchedPdf> {
  const { clientId, driveConnected } = options;

  if (driveConnected && clientId) {
    try {
      const found = await fetchPdfFromDrive(paper, options, signal);
      if (found) return found;
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
  const fetched = await fetchPdfFromLocations(paper, locations, signal, { judge: options.judge, preferred: options.preferred });
  return { blob: fetched.blob, from: 'proxy', location: fetched.location, tried: fetched.tried, doubt: fetched.doubt };
}
