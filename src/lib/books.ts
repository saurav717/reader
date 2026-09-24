/**
 * Books, and PDFs that are not in any paper index.
 *
 * The paper indexes know papers. A book, a thesis scanned by a library, a
 * report someone uploaded, or a PDF sitting on a course page is in none of
 * them — so this looks in the places that do keep them and will hand the
 * file over: Open Library, which catalogues books and knows which of them the
 * Internet Archive holds a free scan of; Google Books' free ebooks, whose
 * PDFs it lets anyone download; and the Internet Archive itself, which holds
 * millions of texts as PDFs. All three answer a browser directly, so none of
 * them needs the proxy.
 *
 * And a PDF that is simply at a link — pasted into the search box — becomes a
 * paper of its own, added and read like any other.
 */
import type { PaperLocation, PaperRef } from '../types';

const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();

const list = (value: string | string[] | null | undefined): string[] =>
  (Array.isArray(value) ? value : value ? [value] : []).map(clean).filter(Boolean);

const ARCHIVE = 'https://archive.org';

/** Where the Internet Archive serves one of an item's files. */
export const archiveFileUrl = (identifier: string, name: string) =>
  `${ARCHIVE}/download/${encodeURIComponent(identifier)}/${name.split('/').map(encodeURIComponent).join('/')}`;

/**
 * The PDF of an item the Archive scanned itself. Every book it digitises gets
 * one under the item's own name, which is what Open Library's free scans are.
 */
export const archiveScanPdf = (identifier: string) => archiveFileUrl(identifier, `${identifier}.pdf`);

/** The Archive item a paper is, or is a scan on: `archive:<id>`, `openlibrary:<work>:<scan>`. */
export function archiveIdOf(paper: Pick<PaperRef, 'id'>): string | null {
  if (paper.id.startsWith('archive:')) return paper.id.slice('archive:'.length) || null;
  if (paper.id.startsWith('openlibrary:')) return paper.id.split(':')[2] || null;
  return null;
}

// ---------------------------------------------------------- Open Library ----

export interface OpenLibraryDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  subject?: string[];
  ia?: string[];
  /** `public` is a free download; `borrowable` and `printdisabled` are loans. */
  ebook_access?: string;
  public_scan_b?: boolean;
  isbn?: string[];
}

const OPEN_LIBRARY_FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'publisher',
  'subject',
  'ia',
  'ebook_access',
  'public_scan_b',
  'isbn',
].join(',');

/**
 * One book. Its id carries the Archive scan, where there is one, so a book
 * found here and the same scan found on the Archive fold into one entry:
 * `openlibrary:<work>:<scan>`. Only a free scan is given a PDF; a book that is
 * only lent out has its page, and nothing that pretends to be the file.
 */
export function fromOpenLibrary(doc: OpenLibraryDoc): PaperRef {
  const work = clean(doc.key).replace(/^\/works\//, '');
  const free = doc.ebook_access === 'public' || doc.public_scan_b === true;
  const scan = free ? clean(doc.ia?.[0]) : '';
  const title = [clean(doc.title), clean(doc.subtitle)].filter(Boolean).join(': ');
  return {
    id: `openlibrary:${work}:${scan}`,
    source: 'books',
    title,
    authors: list(doc.author_name),
    abstract: '',
    published: doc.first_publish_year ? `${doc.first_publish_year}-01-01` : '',
    categories: list(doc.subject).slice(0, 3),
    pdfUrl: scan ? archiveScanPdf(scan) : undefined,
    landingUrl: scan ? `${ARCHIVE}/details/${scan}` : work ? `https://openlibrary.org/works/${work}` : undefined,
    venue: list(doc.publisher)[0] ? `Book · ${list(doc.publisher)[0]}` : 'Book',
  };
}

export async function searchOpenLibrary(
  query: string,
  page: number,
  limit: number,
  signal?: AbortSignal,
): Promise<PaperRef[]> {
  const params = new URLSearchParams({
    q: query,
    fields: OPEN_LIBRARY_FIELDS,
    limit: String(limit),
    page: String(page + 1),
  });
  const response = await fetch(`https://openlibrary.org/search.json?${params}`, { signal });
  if (!response.ok) throw new Error(`Open Library answered ${response.status}`);
  const payload = (await response.json()) as { docs?: OpenLibraryDoc[] };
  const books = (payload.docs || []).map(fromOpenLibrary).filter((book) => book.title);
  // The ones that can be read come first: a free scan is what was asked for.
  return [...books.filter((book) => book.pdfUrl), ...books.filter((book) => !book.pdfUrl)];
}

// ------------------------------------------------------ Internet Archive ----

export interface ArchiveDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  date?: string;
  year?: string | number;
  description?: string | string[];
  publisher?: string | string[];
  subject?: string | string[];
}

function archiveDate(doc: ArchiveDoc): string {
  const date = clean(doc.date);
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  const year = clean(String(doc.year ?? '')) || date.match(/\d{4}/)?.[0] || '';
  return /^\d{4}$/.test(year) ? `${year}-01-01` : '';
}

/**
 * One text on the Archive. Which of its files is the PDF is not in the
 * search answer — a scan's is named after the item, an upload keeps whatever
 * name it came with — so the file is looked up when the paper's copies are
 * (see `archiveLocations`), and until then the item's page is the link.
 */
export function fromArchive(doc: ArchiveDoc): PaperRef {
  const identifier = clean(doc.identifier);
  const description = list(doc.description).join(' ').replace(/<[^>]+>/g, ' ');
  return {
    id: `archive:${identifier}`,
    source: 'books',
    title: list(doc.title)[0] || identifier,
    authors: list(doc.creator),
    abstract: clean(description).slice(0, 1200),
    published: archiveDate(doc),
    categories: list(doc.subject).slice(0, 3),
    landingUrl: `${ARCHIVE}/details/${identifier}`,
    venue: list(doc.publisher)[0] ? `Internet Archive · ${list(doc.publisher)[0]}` : 'Internet Archive',
  };
}

/** Only texts that have a PDF among their files. */
export function archiveQuery(query: string): string {
  return `(${query}) AND mediatype:(texts) AND format:(PDF)`;
}

export async function searchArchive(
  query: string,
  page: number,
  limit: number,
  signal?: AbortSignal,
): Promise<PaperRef[]> {
  const params = new URLSearchParams({
    q: archiveQuery(query),
    rows: String(limit),
    page: String(page + 1),
    output: 'json',
  });
  for (const field of ['identifier', 'title', 'creator', 'date', 'year', 'description', 'publisher', 'subject']) {
    params.append('fl[]', field);
  }
  const response = await fetch(`${ARCHIVE}/advancedsearch.php?${params}`, { signal });
  if (!response.ok) throw new Error(`the Internet Archive answered ${response.status}`);
  const payload = (await response.json()) as { response?: { docs?: ArchiveDoc[] } };
  return (payload.response?.docs || []).filter((doc) => doc.identifier).map(fromArchive);
}

// ---------------------------------------------------------- Google Books ----

export interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publishedDate?: string;
    publisher?: string;
    description?: string;
    categories?: string[];
    canonicalVolumeLink?: string;
    infoLink?: string;
    industryIdentifiers?: { type?: string; identifier?: string }[];
  };
  accessInfo?: {
    publicDomain?: boolean;
    /** `ALL_PAGES`, `PARTIAL` or `NO_PAGES` — how much of it Google's viewer shows, where you are. */
    viewability?: string;
    pdf?: { isAvailable?: boolean; downloadLink?: string };
  };
  saleInfo?: { saleability?: string };
}

/**
 * The PDF Google Books will hand anyone, where there is one: a public-domain
 * or free book's. A link to an `.acsm` is Adobe's DRM for a bought ebook,
 * not a file, and is no PDF here.
 */
export function googleBooksDownload(volume: GoogleVolume): string | undefined {
  const pdf = volume.accessInfo?.pdf;
  const link = clean(pdf?.downloadLink);
  if (!pdf?.isAvailable || !link || /\.acsm(\?|$)|acs4_fulfillment/i.test(link)) return undefined;
  return link.replace(/^http:\/\//i, 'https://');
}

export function fromGoogleBooks(volume: GoogleVolume): PaperRef {
  const info = volume.volumeInfo || {};
  const date = clean(info.publishedDate);
  const page = clean(info.canonicalVolumeLink || info.infoLink).replace(/^http:\/\//i, 'https://');
  return {
    id: `googlebooks:${clean(volume.id)}`,
    source: 'books',
    title: [clean(info.title), clean(info.subtitle)].filter(Boolean).join(': '),
    authors: list(info.authors),
    abstract: clean(info.description).replace(/<[^>]+>/g, ' ').slice(0, 1200),
    published: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : /^\d{4}/.test(date) ? `${date.slice(0, 4)}-01-01` : '',
    categories: list(info.categories).slice(0, 3),
    pdfUrl: googleBooksDownload(volume),
    landingUrl: page || undefined,
    venue: [
      'Google Books',
      googleBooksDownload(volume) ? '' : viewabilityLabel(volume),
      clean(info.publisher),
    ].filter(Boolean).join(' · '),
  };
}

/** What Google shows of a book it has no file of, for the line under its title. */
function viewabilityLabel(volume: GoogleVolume): string {
  const view = volume.accessInfo?.viewability;
  if (view === 'ALL_PAGES') return 'read in Google’s viewer only';
  if (view === 'PARTIAL') return 'preview only';
  return 'no preview';
}

/**
 * Why a Google Books page gave no file, asked from this browser — so in the
 * country you are reading from, which is what decides what Google shows —
 * rather than from the proxy's. Null when it does have a PDF to download.
 */
export function googleBooksNoPdf(volume: GoogleVolume): string | null {
  if (googleBooksDownload(volume)) return null;
  const title = volume.volumeInfo?.title ? `“${clean(volume.volumeInfo.title)}”` : 'this book';
  const view = volume.accessInfo?.viewability;
  const link = clean(volume.accessInfo?.pdf?.downloadLink);
  const drm = /\.acsm(\?|$)|acs4_fulfillment/i.test(link) || volume.saleInfo?.saleability === 'FOR_SALE';
  const why =
    view === 'ALL_PAGES'
      ? `Google Books lets you read ${title} in its own viewer, but keeps no file of it to download: the viewer only ever sends the page you are on${drm ? ', and the edition is sold on Google Play as a protected ebook' : ''}.`
      : view === 'PARTIAL'
        ? `Google Books only shows a preview of ${title} — some of its pages — and has no file of it to download.`
        : drm
          ? `Google Books sells ${title} as a protected ebook (Adobe’s .acsm), not as a PDF anyone can download.`
          : `Google Books has no file of ${title} to download.`;
  return `${why} Try one of the other copies listed below, turn on Books & PDFs in Discover for a free scan from Open Library or the Internet Archive, or drop in a copy of your own.`;
}

/** A Google Books volume as the API describes it, asked from this browser. */
export async function googleVolume(id: string, signal?: AbortSignal): Promise<GoogleVolume> {
  const response = await fetch(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) throw new Error(`Google Books answered ${response.status}`);
  return (await response.json()) as GoogleVolume;
}

/**
 * The volume a Google Books link is about, in any of the shapes Google gives
 * one — the same reading as `googleBooksId` in server/pdfLinks.js, which the
 * proxy uses for "Fetch the PDF from this page".
 */
export function googleBooksIdFromLink(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const valid = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{8,20}$/.test(id) ? id : null);
  if (/^books\.google\.[a-z.]+$/.test(host)) return valid(url.searchParams.get('id'));
  if (host === 'play.google.com') {
    return url.pathname.startsWith('/store/books/details') ? valid(url.searchParams.get('id')) : null;
  }
  if (/^(www\.)?google\.[a-z.]+$/.test(host)) return valid(url.pathname.match(/^\/books\/edition\/[^/]*\/([A-Za-z0-9_-]+)/)?.[1]);
  return null;
}

/** One volume, as a paper, asked of the Books API by its id. */
export async function googleBook(id: string, signal?: AbortSignal): Promise<PaperRef> {
  return fromGoogleBooks(await googleVolume(id, signal));
}

/**
 * Every book Google knows by the query, the ones it lets anyone download
 * first. The rest come as their page, to open in the browser pane and read
 * there, the way a borrowable Open Library book does: the line under each
 * says how much Google shows of it.
 */
export async function searchGoogleBooks(
  query: string,
  page: number,
  limit: number,
  signal?: AbortSignal,
): Promise<PaperRef[]> {
  const size = Math.min(40, limit);
  const params = new URLSearchParams({
    q: query,
    maxResults: String(size),
    startIndex: String(page * size),
    printType: 'books',
  });
  const response = await fetch(`https://www.googleapis.com/books/v1/volumes?${params}`, { signal });
  if (!response.ok) throw new Error(`Google Books answered ${response.status}`);
  const payload = (await response.json()) as { items?: GoogleVolume[] };
  const books = (payload.items || []).filter((volume) => volume.id).map(fromGoogleBooks).filter((book) => book.title);
  return [...books.filter((book) => book.pdfUrl), ...books.filter((book) => !book.pdfUrl)];
}

/**
 * Both, as one source: a book in Open Library and its scan on the Archive are
 * the same thing, and a text only the Archive has is still worth finding.
 * Either failing leaves the other's answer; both failing is an error.
 */
export async function searchBooks(
  query: string,
  page: number,
  limit: number,
  signal?: AbortSignal,
): Promise<PaperRef[]> {
  // Each is asked for a full page, so the merge sees a full page — and
  // offers "Load more" — for as long as any of them has more to give.
  const settled = await Promise.allSettled([
    searchOpenLibrary(query, page, limit, signal),
    searchGoogleBooks(query, page, limit, signal),
    searchArchive(query, page, limit, signal),
  ]);
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed && settled.every((outcome) => outcome.status === 'rejected')) throw failed.reason;
  const [fromBooks, fromGoogle, fromTexts] = settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
  const scans = new Set(fromBooks.map(archiveIdOf).filter(Boolean));
  const others = fromTexts.filter((text) => !scans.has(archiveIdOf(text)));
  // Interleaved, so none of them is buried under the others.
  const merged: PaperRef[] = [];
  for (let index = 0; index < Math.max(fromBooks.length, fromGoogle.length, others.length); index += 1) {
    for (const group of [fromBooks, fromGoogle, others]) if (group[index]) merged.push(group[index]);
  }
  return merged;
}

interface ArchiveFile {
  name?: string;
  format?: string;
  size?: string;
  private?: string | boolean;
}

/** The Archive's own names for a PDF, the text-bearing ones first. */
const PDF_FORMATS = ['Text PDF', 'Additional Text PDF', 'Image Container PDF', 'PDF'];

/**
 * The PDFs an Archive item actually holds, asked of its metadata. A lent-out
 * book's files are marked private and refuse a download, so they are left out.
 */
export async function archiveLocations(identifier: string, signal?: AbortSignal): Promise<PaperLocation[]> {
  const response = await fetch(`${ARCHIVE}/metadata/${encodeURIComponent(identifier)}/files`, { signal });
  if (!response.ok) return [];
  const payload = (await response.json()) as { result?: ArchiveFile[] };
  const files = (payload.result || []).filter(
    (file) =>
      file.name &&
      String(file.private) !== 'true' &&
      (PDF_FORMATS.includes(clean(file.format)) || /\.pdf$/i.test(file.name)),
  );
  const rank = (file: ArchiveFile) => {
    const at = PDF_FORMATS.indexOf(clean(file.format));
    return at < 0 ? PDF_FORMATS.length : at;
  };
  files.sort((a, b) => rank(a) - rank(b));
  return files.map((file) => ({
    url: archiveFileUrl(identifier, file.name as string),
    host: 'archive.org',
    label: 'Internet Archive',
    kind: 'repository' as const,
    isPdf: true,
    via: 'paper' as const,
  }));
}

// ------------------------------------------------------------ a PDF link ----

/** The query, when it is a link rather than words. */
export function linkFromQuery(query: string): URL | null {
  const trimmed = query.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.hostname.includes('.') ? url : null;
  } catch {
    return null;
  }
}

const LOOKS_LIKE_PDF = /\.pdf$|\/pdf(\/|$)|[?&](format|type)=pdf/i;

/**
 * A title from the link itself, until the file says otherwise: the last part
 * of the path, without `.pdf`, its separators turned back into spaces —
 * `Deep_Learning-Goodfellow.pdf` reads as "Deep Learning Goodfellow".
 */
export function titleFromLink(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  let last = '';
  for (let index = parts.length - 1; index >= 0 && !last; index -= 1) {
    let part = parts[index];
    try {
      part = decodeURIComponent(part);
    } catch {
      // keep it as it came
    }
    part = part.replace(/\.pdf$/i, '');
    if (part && !/^(pdf|download|view|file|content)$/i.test(part)) last = part;
  }
  const words = clean(last.replace(/[_+-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : url.hostname.replace(/^www\./, '');
}

/**
 * A pasted link, as a paper. Its id is the link, so pasting it again finds the
 * same paper rather than a second copy of it. A link that looks like a file
 * is the PDF; anything else is a page, which the reader offers to open and
 * which a file can be dropped onto by hand.
 */
export function paperFromLink(url: URL): PaperRef {
  const href = url.href.replace(/^http:\/\//i, 'https://');
  const isPdf = LOOKS_LIKE_PDF.test(url.pathname + url.search);
  return {
    id: `url:${href}`,
    source: 'books',
    title: titleFromLink(url),
    authors: [],
    abstract: '',
    published: '',
    categories: [],
    pdfUrl: isPdf ? href : undefined,
    landingUrl: href,
    venue: url.hostname.replace(/^www\./, ''),
  };
}
