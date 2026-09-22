import type { AuthorRef, PaperRef, SourceId } from '../types';
import { api, hasProxy } from './api';
import { politely } from './contact';

const ALL_SOURCES: { id: SourceId; label: string; needsProxy: boolean; authors: boolean }[] = [
  { id: 'arxiv', label: 'arXiv', needsProxy: true, authors: true },
  { id: 'openalex', label: 'OpenAlex', needsProxy: false, authors: true },
  { id: 'semanticscholar', label: 'Semantic Scholar', needsProxy: false, authors: true },
  { id: 'crossref', label: 'Crossref', needsProxy: false, authors: false },
];

/**
 * Only the sources this deployment can actually reach. Functions rather than
 * constants because the proxy can be configured at runtime: paste a Worker URL
 * into Settings and arXiv joins the list without a reload.
 */
export function sourceList(): { id: SourceId; label: string; authors: boolean }[] {
  return ALL_SOURCES.filter((source) => hasProxy() || !source.needsProxy).map(({ id, label, authors }) => ({
    id,
    label,
    authors,
  }));
}

/** The subset that can answer "who is this person", for the Authors tab. */
export function authorSources(): { id: SourceId; label: string; authors: boolean }[] {
  return sourceList().filter((source) => source.authors);
}

export function defaultSources(): SourceId[] {
  return hasProxy() ? ['arxiv', 'openalex', 'crossref'] : ['openalex', 'crossref'];
}

const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();

/** How many results each source is asked for, per page. */
export const PAGE_SIZE = 20;

// ------------------------------------------------------------ query shape ----

// Words that carry no signal in an AND-of-terms query and that make an
// otherwise findable paper unfindable when every one of them has to match.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'to', 'via', 'with', 'what', 'why',
]);

/** Splits on quoted phrases, keeping them intact. */
function terms(query: string): { phrases: string[]; words: string[] } {
  const phrases: string[] = [];
  const rest = query.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const trimmed = clean(phrase);
    if (trimmed) phrases.push(trimmed);
    return ' ';
  });
  const words = rest
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}\-.]/gu, ''))
    .filter(Boolean);
  return { phrases, words };
}

/**
 * arXiv's search is Lucene-shaped, so `all:attention is all you need` parses as
 * `all:attention` followed by four bare words it does not know what to do with
 * — which is why a multi-word search used to come back with junk. Phrases get
 * quoted and terms get joined with an explicit AND.
 *
 * `field` is arXiv's prefix: `all`, `ti`, `abs`, `au`.
 */
export function arxivQuery(query: string, field: 'all' | 'ti' | 'abs' | 'au' = 'all'): string {
  const { phrases, words } = terms(query);
  const clauses = phrases.map((phrase) => `${field}:"${phrase}"`);
  const meaningful = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  for (const word of meaningful.length ? meaningful : words) clauses.push(`${field}:${word}`);
  return clauses.join(' AND ');
}

/**
 * The phrase form of a free-text query: the whole thing as one quoted phrase.
 * Someone pasting a title wants that title, and this finds it exactly; the AND
 * form above is the fallback when it finds nothing.
 */
function arxivPhraseQuery(query: string, field: 'all' | 'ti' | 'abs' | 'au' = 'all'): string | null {
  const { phrases, words } = terms(query);
  if (phrases.length || words.length < 2) return null;
  return `${field}:"${words.join(' ')}"`;
}

// ---------------------------------------------------------------- arXiv ----

function parseArxiv(xml: string): PaperRef[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  return Array.from(doc.getElementsByTagName('entry')).map((entry) => {
    const rawId = clean(entry.getElementsByTagName('id')[0]?.textContent);
    const versioned = rawId.split('/abs/')[1] || rawId;
    const arxivId = versioned.replace(/v\d+$/, '');
    const links = Array.from(entry.getElementsByTagName('link'));
    const pdf = links.find((link) => link.getAttribute('title') === 'pdf')?.getAttribute('href');
    return {
      id: `arxiv:${arxivId}`,
      source: 'arxiv' as const,
      title: clean(entry.getElementsByTagName('title')[0]?.textContent),
      authors: Array.from(entry.getElementsByTagName('author')).map((author) =>
        clean(author.getElementsByTagName('name')[0]?.textContent),
      ),
      abstract: clean(entry.getElementsByTagName('summary')[0]?.textContent),
      published: clean(entry.getElementsByTagName('published')[0]?.textContent),
      categories: Array.from(entry.getElementsByTagName('category'))
        .map((category) => category.getAttribute('term') || '')
        .filter(Boolean),
      arxivId: versioned,
      doi: clean(entry.getElementsByTagName('arxiv:doi')[0]?.textContent) || undefined,
      pdfUrl: pdf ? pdf.replace(/^http:/, 'https:') : `https://arxiv.org/pdf/${versioned}`,
      landingUrl: `https://arxiv.org/abs/${versioned}`,
    };
  });
}

async function arxivFetch(searchQuery: string, start: number, limit: number, signal?: AbortSignal) {
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: String(start),
    max_results: String(limit),
    sortBy: 'relevance',
  });
  const response = await fetch(api(`/arxiv/query?${params}`), { signal });
  if (!response.ok) throw new Error(`arXiv search failed (${response.status})`);
  return parseArxiv(await response.text());
}

async function searchArxiv(query: string, page: number, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  const start = page * limit;
  const phrase = arxivPhraseQuery(query);
  if (phrase) {
    const exact = await arxivFetch(phrase, start, limit, signal);
    if (exact.length) return exact;
  }
  return arxivFetch(arxivQuery(query), start, limit, signal);
}

async function arxivByAuthor(name: string, page: number, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  return arxivFetch(`au:"${name.replace(/"/g, '')}"`, page * limit, limit, signal);
}

// ------------------------------------------------------------- OpenAlex ----

/** OpenAlex ships abstracts as a word -> positions map for copyright reasons. */
function invertAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

export interface OpenAlexLocation {
  pdf_url: string | null;
  landing_page_url: string | null;
  /** `type` tells a repository deposit apart from the version of record. */
  source: { display_name: string | null; type?: string | null } | null;
  /** submittedVersion | acceptedVersion | publishedVersion, where stated. */
  version?: string | null;
  is_oa?: boolean;
}

export interface OpenAlexWork {
  id: string;
  doi: string | null;
  display_name: string | null;
  publication_date: string | null;
  abstract_inverted_index: Record<string, number[]> | null;
  authorships: { author: { display_name: string | null } }[];
  primary_location: OpenAlexLocation | null;
  /** Where OpenAlex thinks the best free copy is — often not the primary one. */
  best_oa_location?: OpenAlexLocation | null;
  /**
   * Every copy OpenAlex knows of, the repository deposits included. The two
   * fields above are picks out of this list, and the tail of it is where a
   * paper that the publisher has locked is usually still readable.
   */
  locations?: OpenAlexLocation[] | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
  concepts: { display_name: string }[];
  cited_by_count?: number;
  ids?: { arxiv?: string; pmcid?: string };
}

/**
 * The best free PDF OpenAlex knows of. `primary_location` is the version of
 * record — usually behind a paywall — so the OA locations come first, and a
 * PubMed Central id is worth a guess when neither carries a direct link.
 */
export function openAlexPdf(work: OpenAlexWork): string | undefined {
  const pmcid = work.ids?.pmcid?.match(/PMC\d+/i)?.[0];
  const candidate =
    work.best_oa_location?.pdf_url ||
    work.primary_location?.pdf_url ||
    work.open_access?.oa_url ||
    (pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/` : undefined);
  return candidate && /^https:/i.test(candidate) ? candidate : undefined;
}

export function fromOpenAlex(work: OpenAlexWork): PaperRef {
  const doi = work.doi ? work.doi.replace('https://doi.org/', '') : undefined;
  const arxivFromDoi = doi?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1] || work.ids?.arxiv?.split('/').pop();
  return {
    id: arxivFromDoi ? `arxiv:${arxivFromDoi}` : doi ? `doi:${doi}` : work.id,
    source: 'openalex' as const,
    title: clean(work.display_name),
    authors: (work.authorships || []).map((authorship) => clean(authorship.author?.display_name)).filter(Boolean),
    abstract: invertAbstract(work.abstract_inverted_index),
    published: work.publication_date || '',
    categories: (work.concepts || []).slice(0, 3).map((concept) => concept.display_name),
    arxivId: arxivFromDoi,
    doi,
    pdfUrl: openAlexPdf(work) || (arxivFromDoi ? `https://arxiv.org/pdf/${arxivFromDoi}` : undefined),
    landingUrl:
      work.primary_location?.landing_page_url ||
      work.best_oa_location?.landing_page_url ||
      (doi ? `https://doi.org/${doi}` : undefined),
    venue: work.primary_location?.source?.display_name || work.best_oa_location?.source?.display_name || undefined,
    citedBy: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
  };
}

async function openAlexWorks(params: URLSearchParams, signal?: AbortSignal): Promise<PaperRef[]> {
  const response = await fetch(`https://api.openalex.org/works?${politely(params)}`, { signal });
  if (!response.ok) throw new Error(`OpenAlex search failed (${response.status})`);
  const payload = (await response.json()) as { results: OpenAlexWork[] };
  return (payload.results || []).map(fromOpenAlex);
}

async function searchOpenAlex(query: string, page: number, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  return openAlexWorks(
    new URLSearchParams({ search: query, per_page: String(limit), page: String(page + 1) }),
    signal,
  );
}

// ------------------------------------------------------ Semantic Scholar ----

export interface SemanticScholarPaper {
  paperId: string;
  title: string | null;
  abstract: string | null;
  venue: string | null;
  publicationDate: string | null;
  year: number | null;
  citationCount?: number | null;
  authors: { name: string }[];
  externalIds: { ArXiv?: string; DOI?: string } | null;
  openAccessPdf: { url: string } | null;
}

const S2_FIELDS = 'title,abstract,venue,year,publicationDate,authors,externalIds,openAccessPdf,citationCount';

function fromSemanticScholar(paper: SemanticScholarPaper): PaperRef {
  const arxivId = paper.externalIds?.ArXiv;
  const doi = paper.externalIds?.DOI;
  return {
    id: arxivId ? `arxiv:${arxivId}` : doi ? `doi:${doi}` : `s2:${paper.paperId}`,
    source: 'semanticscholar' as const,
    title: clean(paper.title),
    authors: (paper.authors || []).map((author) => clean(author.name)).filter(Boolean),
    abstract: clean(paper.abstract),
    published: paper.publicationDate || (paper.year ? `${paper.year}-01-01` : ''),
    categories: [],
    arxivId,
    doi,
    pdfUrl: paper.openAccessPdf?.url || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined),
    landingUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : undefined,
    venue: paper.venue || undefined,
    citedBy: typeof paper.citationCount === 'number' ? paper.citationCount : undefined,
  };
}

function s2Error(status: number, what: string): Error {
  // The unauthenticated endpoint rate-limits aggressively; say so plainly.
  return new Error(
    status === 429
      ? 'Semantic Scholar is rate-limiting; try again shortly'
      : `Semantic Scholar ${what} failed (${status})`,
  );
}

async function searchSemanticScholar(query: string, page: number, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(page * limit),
    fields: S2_FIELDS,
  });
  const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { signal });
  if (!response.ok) throw s2Error(response.status, 'search');
  const payload = (await response.json()) as { data?: SemanticScholarPaper[] };
  return (payload.data || []).map(fromSemanticScholar);
}

// --------------------------------------------------------------- Crossref ----

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  abstract?: string;
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  subject?: string[];
  URL?: string;
  link?: { URL?: string; 'content-type'?: string }[];
  'is-referenced-by-count'?: number;
}

/** Crossref returns abstracts as JATS XML fragments rather than as text. */
function stripJats(value: string | undefined): string {
  if (!value) return '';
  return clean(value.replace(/<[^>]+>/g, ' '));
}

function fromCrossref(item: CrossrefItem): PaperRef {
  const doi = item.DOI?.toLowerCase();
  const arxivFromDoi = doi?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1];
  const parts = item.issued?.['date-parts']?.[0] || [];
  const published = parts.length
    ? `${parts[0]}-${String(parts[1] || 1).padStart(2, '0')}-${String(parts[2] || 1).padStart(2, '0')}`
    : '';
  const pdfLink = (item.link || []).find((link) => link['content-type'] === 'application/pdf')?.URL;
  return {
    id: arxivFromDoi ? `arxiv:${arxivFromDoi}` : doi ? `doi:${doi}` : `crossref:${item.URL || ''}`,
    source: 'crossref' as const,
    title: clean(item.title?.[0]),
    authors: (item.author || [])
      .map((author) => clean(author.name || [author.given, author.family].filter(Boolean).join(' ')))
      .filter(Boolean),
    abstract: stripJats(item.abstract),
    published,
    categories: (item.subject || []).slice(0, 3),
    arxivId: arxivFromDoi,
    doi,
    // Crossref's link list is mostly publisher-gated; a real PDF is resolved
    // later, by Unpaywall and the two indexes, when the paper is opened.
    pdfUrl: pdfLink && /^https:/i.test(pdfLink) ? pdfLink : undefined,
    landingUrl: item.URL || (doi ? `https://doi.org/${doi}` : undefined),
    venue: clean(item['container-title']?.[0]) || undefined,
    citedBy: typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : undefined,
  };
}

async function crossrefWorks(params: URLSearchParams, signal?: AbortSignal): Promise<PaperRef[]> {
  params.set(
    'select',
    'DOI,title,abstract,author,issued,container-title,subject,URL,link,is-referenced-by-count',
  );
  const response = await fetch(`https://api.crossref.org/works?${politely(params)}`, { signal });
  if (!response.ok) throw new Error(`Crossref search failed (${response.status})`);
  const payload = (await response.json()) as { message?: { items?: CrossrefItem[] } };
  return (payload.message?.items || []).map(fromCrossref).filter((paper) => paper.title);
}

async function searchCrossref(query: string, page: number, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  return crossrefWorks(
    new URLSearchParams({
      'query.bibliographic': query,
      rows: String(limit),
      offset: String(page * limit),
    }),
    signal,
  );
}

// ---------------------------------------------------------------- lineage ----

export interface Lineage {
  /** The oldest indexed works using the phrase — where the idea comes from. */
  earliest: PaperRef[];
  /** The most cited ones — how it reached the paper you are reading. */
  influential: PaperRef[];
}

/**
 * The trail behind a phrase, from OpenAlex: the first papers to use it and the
 * ones everyone since has cited. Searching titles and abstracts rather than
 * full text keeps the answer about the term itself.
 */
export async function lookupLineage(phrase: string, signal?: AbortSignal): Promise<Lineage> {
  // Commas separate filters and colons separate a filter from its value, so
  // neither can survive inside the phrase being searched for.
  const term = phrase.replace(/[,:|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!term) return { earliest: [], influential: [] };
  const base = () => {
    const params = new URLSearchParams({ per_page: '4' });
    params.set('filter', `title_and_abstract.search:${term}`);
    return params;
  };
  const oldest = base();
  oldest.set('sort', 'publication_date:asc');
  const cited = base();
  cited.set('sort', 'cited_by_count:desc');

  const [earliest, influential] = await Promise.all([
    openAlexWorks(oldest, signal),
    openAlexWorks(cited, signal),
  ]);
  const seen = new Set(earliest.map((paper) => paper.id));
  return { earliest, influential: influential.filter((paper) => !seen.has(paper.id)) };
}

// ----------------------------------------------------------------- people ----

interface OpenAlexAuthor {
  id: string;
  display_name: string | null;
  orcid: string | null;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: { h_index?: number };
  last_known_institutions?: { display_name: string | null }[];
  last_known_institution?: { display_name: string | null } | null;
}

async function openAlexAuthors(name: string, limit: number, signal?: AbortSignal): Promise<AuthorRef[]> {
  const params = new URLSearchParams({ search: name, per_page: String(limit) });
  const response = await fetch(`https://api.openalex.org/authors?${politely(params)}`, { signal });
  if (!response.ok) throw new Error(`OpenAlex author search failed (${response.status})`);
  const payload = (await response.json()) as { results?: OpenAlexAuthor[] };
  return (payload.results || []).map((author) => ({
    id: `openalex:${author.id.split('/').pop()}`,
    source: 'openalex' as const,
    name: clean(author.display_name),
    affiliation:
      clean(author.last_known_institutions?.[0]?.display_name) ||
      clean(author.last_known_institution?.display_name) ||
      undefined,
    orcid: author.orcid?.replace('https://orcid.org/', '') || undefined,
    worksCount: author.works_count,
    citedBy: author.cited_by_count,
    hIndex: author.summary_stats?.h_index,
  }));
}

interface S2Author {
  authorId: string;
  name: string | null;
  affiliations?: string[];
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
  externalIds?: { ORCID?: string[] };
}

async function semanticScholarAuthors(name: string, limit: number, signal?: AbortSignal): Promise<AuthorRef[]> {
  const params = new URLSearchParams({
    query: name,
    limit: String(limit),
    fields: 'name,affiliations,paperCount,citationCount,hIndex,externalIds',
  });
  const response = await fetch(`https://api.semanticscholar.org/graph/v1/author/search?${params}`, { signal });
  if (!response.ok) throw s2Error(response.status, 'author search');
  const payload = (await response.json()) as { data?: S2Author[] };
  return (payload.data || []).map((author) => ({
    id: `s2:${author.authorId}`,
    source: 'semanticscholar' as const,
    name: clean(author.name),
    affiliation: clean(author.affiliations?.[0]) || undefined,
    orcid: author.externalIds?.ORCID?.[0],
    worksCount: author.paperCount,
    citedBy: author.citationCount,
    hIndex: author.hIndex,
  }));
}

export interface AuthorOutcome {
  authors: AuthorRef[];
  errors: { source: SourceId; message: string }[];
}

/**
 * People matching a name, from whichever indexes keep author records.
 *
 * Both of them disambiguate imperfectly, so the same person can appear twice
 * with different counts. Rather than guessing which record is right, near-
 * identical names are folded together keeping the fullest one, and the rest
 * are shown as the separate candidates they are.
 */
export async function searchAuthors(
  name: string,
  sources: SourceId[],
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<AuthorOutcome> {
  const trimmed = name.trim();
  if (!trimmed) return { authors: [], errors: [] };
  const limit = options.limit ?? 10;

  const runners: Partial<Record<SourceId, (n: string, l: number, s?: AbortSignal) => Promise<AuthorRef[]>>> = {
    openalex: openAlexAuthors,
    semanticscholar: semanticScholarAuthors,
  };
  const usable = sources.filter((source) => runners[source] && authorSources().some((entry) => entry.id === source));
  if (!usable.length) {
    return { authors: [], errors: [{ source: 'openalex', message: 'No source selected that can search for people.' }] };
  }

  const settled = await Promise.allSettled(
    usable.map((source) => (runners[source] as NonNullable<typeof runners[SourceId]>)(trimmed, limit, options.signal)),
  );

  const authors: AuthorRef[] = [];
  const errors: { source: SourceId; message: string }[] = [];
  const byName = new Map<string, AuthorRef>();

  settled.forEach((outcome, position) => {
    const source = usable[position];
    if (outcome.status === 'rejected') {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      if (!/abort/i.test(message)) errors.push({ source, message });
      return;
    }
    for (const author of outcome.value) {
      if (!author.name) continue;
      const key = `${author.orcid || normalise(author.name)}`;
      const existing = byName.get(key);
      if (existing) {
        // Keep whichever record knows more; ORCID matches are the same person.
        if ((author.worksCount || 0) > (existing.worksCount || 0)) {
          Object.assign(existing, { ...author, id: existing.id, source: existing.source });
        }
        continue;
      }
      byName.set(key, author);
      authors.push(author);
    }
  });

  authors.sort((a, b) => (b.citedBy || 0) - (a.citedBy || 0));
  return { authors, errors };
}

/** Everything a given person has written, newest and most-cited first. */
export async function papersByAuthor(
  author: AuthorRef,
  options: { page?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<PaperRef[]> {
  const limit = options.limit ?? PAGE_SIZE;
  const page = options.page ?? 0;

  if (author.id.startsWith('openalex:')) {
    const params = new URLSearchParams({
      per_page: String(limit),
      page: String(page + 1),
      sort: 'cited_by_count:desc',
    });
    params.set('filter', `author.id:${author.id.slice('openalex:'.length)}`);
    return openAlexWorks(params, options.signal);
  }

  if (author.id.startsWith('s2:')) {
    const params = new URLSearchParams({
      fields: S2_FIELDS,
      limit: String(limit),
      offset: String(page * limit),
    });
    const response = await fetch(
      `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(author.id.slice(3))}/papers?${params}`,
      { signal: options.signal },
    );
    if (!response.ok) throw s2Error(response.status, 'author papers');
    const payload = (await response.json()) as { data?: SemanticScholarPaper[] };
    return (payload.data || []).map(fromSemanticScholar);
  }

  return [];
}

/**
 * Papers whose author list contains this name, straight from a free-text name
 * rather than from a chosen person. Broader and noisier than `papersByAuthor`,
 * but it works when none of the indexes has a record worth picking.
 */
export async function searchByAuthorName(
  name: string,
  sources: SourceId[],
  options: { page?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<SearchOutcome> {
  const trimmed = name.trim();
  if (!trimmed) return { results: [], errors: [], exhausted: true };
  const limit = options.limit ?? PAGE_SIZE;
  const page = options.page ?? 0;

  const runners: Partial<Record<SourceId, (q: string, p: number, l: number, s?: AbortSignal) => Promise<PaperRef[]>>> = {
    arxiv: arxivByAuthor,
    openalex: (query, p, l, signal) => {
      const params = new URLSearchParams({ per_page: String(l), page: String(p + 1), sort: 'cited_by_count:desc' });
      params.set('filter', `raw_author_name.search:${query.replace(/[,:|]+/g, ' ')}`);
      return openAlexWorks(params, signal);
    },
    crossref: (query, p, l, signal) =>
      crossrefWorks(
        new URLSearchParams({ 'query.author': query, rows: String(l), offset: String(p * l) }),
        signal,
      ),
  };

  return runQuery(sources, runners, trimmed, page, limit, options.signal);
}

// ---------------------------------------------------------------- search ----

export interface SearchOutcome {
  results: PaperRef[];
  errors: { source: SourceId; message: string }[];
  /** True when no source had a full page left to give. */
  exhausted: boolean;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * What makes two records the same paper. The arXiv id comes first, and not the
 * DOI: arXiv mints a DOI of its own (10.48550/arXiv.NNNN) which OpenAlex and
 * Crossref report but arXiv's own API does not, so keying on the DOI would file
 * the same preprint twice — once as a DOI and once as an id. Failing both, the
 * title is all there is, which is why it is normalised down to letters and
 * digits before it is compared.
 */
function identity(paper: PaperRef): string {
  if (paper.arxivId) return `arxiv:${paper.arxivId.replace(/v\d+$/, '').toLowerCase()}`;
  if (paper.doi) return `doi:${paper.doi.toLowerCase()}`;
  const title = normalise(paper.title);
  return title ? `title:${title}` : paper.id;
}

/** Fills the gaps in `into` from `from` without overwriting what it has. */
function absorb(into: PaperRef, from: PaperRef): void {
  if (!into.abstract && from.abstract) into.abstract = from.abstract;
  if (!into.pdfUrl && from.pdfUrl) into.pdfUrl = from.pdfUrl;
  if (!into.landingUrl && from.landingUrl) into.landingUrl = from.landingUrl;
  if (!into.venue && from.venue) into.venue = from.venue;
  if (!into.doi && from.doi) into.doi = from.doi;
  if (!into.arxivId && from.arxivId) into.arxivId = from.arxivId;
  if (!into.published && from.published) into.published = from.published;
  if (!into.categories.length && from.categories.length) into.categories = from.categories;
  if (!into.authors.length && from.authors.length) into.authors = from.authors;
  if (typeof from.citedBy === 'number' && (into.citedBy ?? -1) < from.citedBy) into.citedBy = from.citedBy;
}

/**
 * Reciprocal rank fusion, which is how the per-source result lists become one
 * list. Each source votes with 1/(k + its rank), so a paper two indexes both
 * put near the top outranks one that a single index ranked first — without
 * either source's scores having to mean the same thing as the other's.
 */
const RRF_K = 60;

function runQuery(
  sources: SourceId[],
  runners: Partial<Record<SourceId, (q: string, page: number, limit: number, signal?: AbortSignal) => Promise<PaperRef[]>>>,
  query: string,
  page: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  // A source the deployment cannot reach would only produce a confusing error.
  const usable = sources.filter(
    (source) => runners[source] && sourceList().some((entry) => entry.id === source),
  );
  if (!usable.length) {
    return Promise.resolve({
      results: [],
      errors: [{ source: sources[0] ?? 'openalex', message: 'No sources are selected — turn at least one on.' }],
      exhausted: true,
    });
  }

  return Promise.allSettled(
    usable.map((source) => (runners[source] as NonNullable<typeof runners[SourceId]>)(query, page, limit, signal)),
  ).then((settled) => {
    const errors: { source: SourceId; message: string }[] = [];
    const merged = new Map<string, { paper: PaperRef; score: number }>();
    let exhausted = true;

    settled.forEach((outcome, position) => {
      const source = usable[position];
      if (outcome.status === 'rejected') {
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        if (!/abort/i.test(message)) errors.push({ source, message });
        return;
      }
      if (outcome.value.length >= limit) exhausted = false;
      outcome.value.forEach((paper, rank) => {
        if (!paper.title) return;
        const key = identity(paper);
        const vote = 1 / (RRF_K + rank);
        const existing = merged.get(key);
        if (existing) {
          existing.score += vote;
          absorb(existing.paper, paper);
          // A record that can actually be read beats one that cannot.
          if (!existing.paper.arxivId && paper.arxivId) existing.paper.source = paper.source;
        } else {
          merged.set(key, { paper: { ...paper }, score: vote });
        }
      });
    });

    const results = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.paper);

    return { results, errors, exhausted };
  });
}

export async function search(
  query: string,
  sources: SourceId[],
  options: { limit?: number; page?: number; signal?: AbortSignal } = {},
): Promise<SearchOutcome> {
  const limit = options.limit ?? PAGE_SIZE;
  const page = options.page ?? 0;
  const trimmed = query.trim();
  if (!trimmed) return { results: [], errors: [], exhausted: true };

  const runners: Partial<Record<SourceId, (q: string, p: number, l: number, s?: AbortSignal) => Promise<PaperRef[]>>> = {
    arxiv: searchArxiv,
    openalex: searchOpenAlex,
    semanticscholar: searchSemanticScholar,
    crossref: searchCrossref,
  };

  return runQuery(sources, runners, trimmed, page, limit, options.signal);
}

export function arxivIdFromQuery(query: string): string | null {
  // Anchored, so a year-like number inside a longer query is not mistaken for
  // an identifier: only a query that *is* an arXiv id jumps straight to it.
  const match = query.trim().match(/^(?:arxiv[:/ ]+)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
  return match ? match[1] : null;
}

/** Direct lookup when the query is itself an arXiv id. Needs the proxy. */
export async function lookupArxiv(id: string, signal?: AbortSignal): Promise<PaperRef[]> {
  if (!hasProxy()) return [];
  const response = await fetch(api(`/arxiv/query?id_list=${encodeURIComponent(id)}`), { signal });
  if (!response.ok) throw new Error(`arXiv lookup failed (${response.status})`);
  return parseArxiv(await response.text());
}
