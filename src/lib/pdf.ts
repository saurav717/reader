import type { Paper, PaperRef } from '../types';
import { api, hasProxy, NO_PROXY_REASON } from './api';
import { fromOpenAlex, openAlexPdf, type OpenAlexWork } from './sources';

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
  if (!hasProxy) return null;
  const name = encodeURIComponent(pdfFileName(paper));
  const download = options.download ? '&download=1' : '';
  if (paper.arxivId) {
    return api(`/arxiv/pdf?id=${encodeURIComponent(paper.arxivId)}&name=${name}${download}`);
  }
  const source = https(paper.pdfUrl);
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

/**
 * A PDF link for a paper that arrived without one. OpenAlex first — it knows
 * about more repositories — then Semantic Scholar. Returns undefined when the
 * paper simply is not free to read anywhere either of them can see.
 */
export async function resolvePdfUrl(paper: PaperRef, signal?: AbortSignal): Promise<string | undefined> {
  const known = pdfSourceUrl(paper);
  if (known) return known;
  for (const lookup of [openAlexPdfFor, semanticScholarPdfFor]) {
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

export class PdfError extends Error {}

/**
 * The PDF itself, through the proxy. A blob rather than a bare URL in an
 * `<iframe>` so that a failure is something we can explain rather than a blank
 * grey pane, and so the Download button does not fetch the file a second time.
 */
export async function fetchPdf(paper: PaperRef, signal?: AbortSignal): Promise<Blob> {
  if (!hasProxy) throw new PdfError(NO_PROXY_REASON);
  const url = pdfProxyUrl(paper);
  if (!url) throw new PdfError('No PDF is available for this paper.');

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new PdfError('Could not reach the PDF.');
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { error?: string }) => body?.error)
      .catch(() => undefined);
    throw new PdfError(detail ? `Could not fetch the PDF — ${detail}.` : 'Could not fetch the PDF.');
  }
  const blob = await response.blob();
  // Keep the type honest: a blob URL only renders in the viewer if it says PDF.
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
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
