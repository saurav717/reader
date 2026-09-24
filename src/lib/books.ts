/**
 * Books, and PDFs that are not in any paper index.
 *
 * The paper indexes know papers. A book, a thesis scanned by a library, a
 * report someone uploaded, or a PDF sitting on a course page is in none of
 * them — so this looks in the two places that do keep them and will hand the
 * file over: Open Library, which catalogues books and knows which of them the
 * Internet Archive holds a free scan of, and the Internet Archive itself,
 * which holds millions of texts as PDFs. Both answer a browser directly, so
 * neither needs the proxy.
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
  // Each half is asked for a full page, so the merge sees a full page — and
  // offers "Load more" — for as long as either of them has more to give.
  const [books, texts] = await Promise.allSettled([
    searchOpenLibrary(query, page, limit, signal),
    searchArchive(query, page, limit, signal),
  ]);
  if (books.status === 'rejected' && texts.status === 'rejected') throw books.reason;
  const fromBooks = books.status === 'fulfilled' ? books.value : [];
  const fromTexts = texts.status === 'fulfilled' ? texts.value : [];
  const scans = new Set(fromBooks.map(archiveIdOf).filter(Boolean));
  const others = fromTexts.filter((text) => !scans.has(archiveIdOf(text)));
  // Interleaved, so neither half is buried under the other.
  const merged: PaperRef[] = [];
  for (let index = 0; index < Math.max(fromBooks.length, others.length); index += 1) {
    if (fromBooks[index]) merged.push(fromBooks[index]);
    if (others[index]) merged.push(others[index]);
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
