import type { PaperRef, SourceId } from '../types';
import { api, hasProxy } from './api';

const ALL_SOURCES: { id: SourceId; label: string; needsProxy: boolean }[] = [
  { id: 'arxiv', label: 'arXiv', needsProxy: true },
  { id: 'openalex', label: 'OpenAlex', needsProxy: false },
  { id: 'semanticscholar', label: 'Semantic Scholar', needsProxy: false },
];

/** Only the sources this deployment can actually reach. */
export const SOURCES = ALL_SOURCES.filter((source) => hasProxy || !source.needsProxy).map(
  ({ id, label }) => ({ id, label }),
);

export const DEFAULT_SOURCES: SourceId[] = hasProxy ? ['arxiv'] : ['openalex'];

const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();

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

async function searchArxiv(query: string, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(limit),
    sortBy: 'relevance',
  });
  const response = await fetch(api(`/arxiv/query?${params}`), { signal });
  if (!response.ok) throw new Error(`arXiv search failed (${response.status})`);
  return parseArxiv(await response.text());
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

interface OpenAlexWork {
  id: string;
  doi: string | null;
  display_name: string | null;
  publication_date: string | null;
  abstract_inverted_index: Record<string, number[]> | null;
  authorships: { author: { display_name: string | null } }[];
  primary_location: { pdf_url: string | null; landing_page_url: string | null; source: { display_name: string | null } | null } | null;
  concepts: { display_name: string }[];
  cited_by_count?: number;
  ids?: { arxiv?: string };
}

function fromOpenAlex(work: OpenAlexWork): PaperRef {
  const doi = work.doi ? work.doi.replace('https://doi.org/', '') : undefined;
  const arxivFromDoi = doi?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1];
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
    pdfUrl: work.primary_location?.pdf_url || undefined,
    landingUrl: work.primary_location?.landing_page_url || undefined,
    venue: work.primary_location?.source?.display_name || undefined,
    citedBy: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
  };
}

async function openAlexWorks(params: URLSearchParams, signal?: AbortSignal): Promise<PaperRef[]> {
  const response = await fetch(`https://api.openalex.org/works?${params}`, { signal });
  if (!response.ok) throw new Error(`OpenAlex search failed (${response.status})`);
  const payload = (await response.json()) as { results: OpenAlexWork[] };
  return (payload.results || []).map(fromOpenAlex);
}

async function searchOpenAlex(query: string, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  return openAlexWorks(new URLSearchParams({ search: query, per_page: String(limit) }), signal);
}

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

// ------------------------------------------------------ Semantic Scholar ----

interface SemanticScholarPaper {
  paperId: string;
  title: string | null;
  abstract: string | null;
  venue: string | null;
  publicationDate: string | null;
  year: number | null;
  authors: { name: string }[];
  externalIds: { ArXiv?: string; DOI?: string } | null;
  openAccessPdf: { url: string } | null;
}

async function searchSemanticScholar(query: string, limit: number, signal?: AbortSignal): Promise<PaperRef[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: 'title,abstract,venue,year,publicationDate,authors,externalIds,openAccessPdf',
  });
  const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { signal });
  if (!response.ok) {
    // The unauthenticated endpoint rate-limits aggressively; say so plainly.
    throw new Error(response.status === 429 ? 'Semantic Scholar is rate-limiting; try again shortly' : `Semantic Scholar search failed (${response.status})`);
  }
  const payload = (await response.json()) as { data?: SemanticScholarPaper[] };
  return (payload.data || []).map((paper) => {
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
    };
  });
}

// ---------------------------------------------------------------- search ----

export interface SearchOutcome {
  results: PaperRef[];
  errors: { source: SourceId; message: string }[];
}

export async function search(
  query: string,
  sources: SourceId[],
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchOutcome> {
  const limit = options.limit ?? 20;
  const trimmed = query.trim();
  if (!trimmed) return { results: [], errors: [] };

  const runners: Record<SourceId, (q: string, l: number, s?: AbortSignal) => Promise<PaperRef[]>> = {
    arxiv: searchArxiv,
    openalex: searchOpenAlex,
    semanticscholar: searchSemanticScholar,
  };

  // A source the deployment cannot reach would only produce a confusing error.
  const usable = sources.filter((source) => SOURCES.some((entry) => entry.id === source));
  const settled = await Promise.allSettled(
    usable.map((source) => runners[source](trimmed, limit, options.signal)),
  );

  const results: PaperRef[] = [];
  const errors: { source: SourceId; message: string }[] = [];
  const seen = new Set<string>();

  settled.forEach((outcome, position) => {
    const source = usable[position];
    if (outcome.status === 'rejected') {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      if (!/abort/i.test(message)) errors.push({ source, message });
      return;
    }
    for (const paper of outcome.value) {
      if (!paper.title || seen.has(paper.id)) continue;
      seen.add(paper.id);
      results.push(paper);
    }
  });

  return { results, errors };
}

export function arxivIdFromQuery(query: string): string | null {
  const match = query.trim().match(/(?:arxiv[:/ ]+)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return match ? match[1] : null;
}

/** Direct lookup when the query is itself an arXiv id. Needs the proxy. */
export async function lookupArxiv(id: string, signal?: AbortSignal): Promise<PaperRef[]> {
  if (!hasProxy) return [];
  const response = await fetch(api(`/arxiv/query?id_list=${encodeURIComponent(id)}`), { signal });
  if (!response.ok) throw new Error(`arXiv lookup failed (${response.status})`);
  return parseArxiv(await response.text());
}
