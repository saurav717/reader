/**
 * What the hover cards in the reader say: who an author of the open paper
 * is, and which paper a citation points at.
 *
 * Both are asked of OpenAlex first — it sends CORS headers, needs no key,
 * and knows a person's institution, counts and topics — and, for a person,
 * of Google Scholar through the proxy where there is one, since a Scholar
 * profile is the one people keep themselves. Every answer is kept for the
 * session: a card that is hovered over twice asks once.
 */
import type { AuthorRef, PaperRef } from '../types';
import { parseReference, titleFits } from './citations';
import { politely } from './contact';
import { hasProxy } from './api';
import { scholarAuthors } from './scholar';
import { crossrefWorks, fromOpenAlex, nameMatches, openAlexWorks, type OpenAlexWork } from './sources';

const OPENALEX = 'https://api.openalex.org';

/** One promise per question, whoever asks it. A failure is forgotten, so the next hover asks again. */
function remembered<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const known = cache.get(key);
  if (known) return known;
  const made = make();
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  return made;
}

async function openAlexJson<T>(path: string, params = new URLSearchParams()): Promise<T | null> {
  const query = politely(params).toString();
  const response = await fetch(`${OPENALEX}/${path}${query ? `?${query}` : ''}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenAlex answered ${response.status}`);
  return (await response.json()) as T;
}

/** A filter value OpenAlex will not split on: no commas, colons or pipes. */
const filterValue = (value: string) => value.replace(/[,:|]+/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------ citations ---

const references = new Map<string, Promise<PaperRef | null>>();

/**
 * The paper a bibliography entry cites, or null when nothing found is
 * plainly it. A DOI or arXiv id in the entry is looked up directly; else
 * the title read off the entry is searched for, at OpenAlex and then at
 * Crossref, and a result is taken only when its title is in the entry.
 */
export function resolveReference(entry: string): Promise<PaperRef | null> {
  const key = entry.replace(/\s+/g, ' ').trim();
  return remembered(references, key, () => findReference(key));
}

async function findReference(entry: string): Promise<PaperRef | null> {
  const parsed = parseReference(entry);
  const direct = parsed.doi ?? (parsed.arxivId ? `10.48550/arxiv.${parsed.arxivId}` : undefined);
  if (direct) {
    const work = await openAlexJson<OpenAlexWork>(`works/doi:${encodeURIComponent(direct)}`).catch(() => null);
    if (work) return fromOpenAlex(work);
  }

  const fits = (paper: PaperRef) => titleFits(paper.title, entry);
  // Two records with the title: the one from the entry's year, else the most cited.
  const pick = (found: PaperRef[]) => {
    const fitting = found.filter(fits);
    const sameYear = parsed.year ? fitting.find((paper) => paper.published.startsWith(parsed.year!.slice(0, 4))) : undefined;
    return sameYear ?? fitting.sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0))[0] ?? null;
  };

  if (parsed.title && parsed.title.length >= 8) {
    const params = new URLSearchParams({ per_page: '5' });
    params.set('filter', `title.search:${filterValue(parsed.title)}`);
    const found = pick(await openAlexWorks(params).catch(() => []));
    if (found) return found;
  }

  // Crossref's bibliographic query is made for a reference as printed.
  const crossref = pick(
    await crossrefWorks(new URLSearchParams({ 'query.bibliographic': entry.slice(0, 400), rows: '3' })).catch(() => []),
  );
  if (crossref) return crossref;

  // Last, OpenAlex's own search over the whole entry.
  const params = new URLSearchParams({ search: (parsed.title || entry).slice(0, 300), per_page: '5' });
  return pick(await openAlexWorks(params).catch(() => []));
}

// --------------------------------------------------------------- people ---

interface Authorship {
  author: { id: string; display_name: string | null; orcid?: string | null };
  raw_author_name?: string | null;
  institutions?: { display_name: string | null }[];
}

type WorkWithAuthors = OpenAlexWork & { authorships: Authorship[]; title?: string | null };

interface OpenAlexAuthorRecord {
  id: string;
  display_name: string | null;
  orcid: string | null;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: { h_index?: number; i10_index?: number; '2yr_mean_citedness'?: number };
  last_known_institutions?: { display_name: string | null }[];
  topics?: { display_name: string }[];
}

/** A person, as far as the hover card needs to know them. */
export interface AuthorDetails {
  name: string;
  /**
   * How the record was found: through the open paper's own entry at
   * OpenAlex, which names this very person; or by the name alone, which
   * may be somebody else with it.
   */
  via: 'paper' | 'name' | 'none';
  openAlexId?: string;
  orcid?: string;
  /** Where they were when they wrote this paper. */
  affiliationHere?: string;
  /** Where they are now, as far as OpenAlex knows. */
  affiliation?: string;
  worksCount?: number;
  citedBy?: number;
  hIndex?: number;
  i10Index?: number;
  topics: string[];
  topWorks: PaperRef[];
}

interface PaperKey {
  id: string;
  title: string;
  doi?: string;
  arxivId?: string;
}

const paperAuthors = new Map<string, Promise<Authorship[]>>();

/** The open paper's authors as OpenAlex records them, with their ids and institutions. */
function authorshipsOf(paper: PaperKey): Promise<Authorship[]> {
  return remembered(paperAuthors, paper.id, async () => {
    const fields = new URLSearchParams({ select: 'id,title,authorships' });
    const doi = paper.doi ?? (paper.arxivId ? `10.48550/arxiv.${paper.arxivId.replace(/v\d+$/, '')}` : undefined);
    if (doi) {
      const work = await openAlexJson<WorkWithAuthors>(`works/doi:${encodeURIComponent(doi)}`, fields).catch(() => null);
      if (work?.authorships?.length) return work.authorships;
    }
    if (!paper.title) return [];
    const params = new URLSearchParams({ per_page: '5', select: 'id,title,display_name,authorships' });
    params.set('filter', `title.search:${filterValue(paper.title)}`);
    const found = await openAlexJson<{ results?: WorkWithAuthors[] }>('works', params);
    const match = found?.results?.find((work) => titleFits(work.title || work.display_name || '', paper.title));
    return match?.authorships ?? [];
  });
}

const people = new Map<string, Promise<AuthorDetails>>();

/**
 * Who one of the open paper's authors is. `position` is where the name
 * stands in the byline, which picks the right record when two authors share
 * a surname.
 */
export function authorDetails(name: string, position: number, paper: PaperKey): Promise<AuthorDetails> {
  return remembered(people, `${paper.id}|${position}|${name}`, () => findAuthor(name, position, paper));
}

async function findAuthor(name: string, position: number, paper: PaperKey): Promise<AuthorDetails> {
  const ships = await authorshipsOf(paper).catch(() => [] as Authorship[]);
  const named = (ship: Authorship) => nameMatches(ship.author.display_name || ship.raw_author_name || '', name);
  const ship = ships[position] && named(ships[position]) ? ships[position] : ships.find(named);

  let via: AuthorDetails['via'] = ship ? 'paper' : 'none';
  let id = ship?.author.id?.split('/').pop();
  if (!id) {
    const params = new URLSearchParams({ search: name, per_page: '5' });
    const found = await openAlexJson<{ results?: OpenAlexAuthorRecord[] }>('authors', params).catch(() => null);
    const best = found?.results?.find((record) => nameMatches(record.display_name || '', name));
    if (best) {
      id = best.id.split('/').pop();
      via = 'name';
    }
  }

  const details: AuthorDetails = {
    name,
    via,
    topics: [],
    topWorks: [],
    affiliationHere: ship?.institutions?.map((institution) => institution.display_name).filter(Boolean).join('; ') || undefined,
  };
  if (!id) return details;

  const worksParams = new URLSearchParams({ per_page: '3', sort: 'cited_by_count:desc' });
  worksParams.set('filter', `author.id:${id}`);
  const [record, works] = await Promise.all([
    openAlexJson<OpenAlexAuthorRecord>(`authors/${id}`).catch(() => null),
    openAlexWorks(worksParams).catch(() => [] as PaperRef[]),
  ]);
  details.openAlexId = id;
  details.topWorks = works;
  if (record) {
    details.orcid = record.orcid?.replace('https://orcid.org/', '') || undefined;
    details.affiliation = record.last_known_institutions?.[0]?.display_name || undefined;
    details.worksCount = record.works_count;
    details.citedBy = record.cited_by_count;
    details.hIndex = record.summary_stats?.h_index;
    details.i10Index = record.summary_stats?.i10_index;
    details.topics = (record.topics || []).slice(0, 4).map((topic) => topic.display_name);
  }
  return details;
}

// -------------------------------------------------------------- Scholar ---

const profiles = new Map<string, Promise<AuthorRef | null>>();

const COMMON = new Set(['the', 'and', 'for', 'edu', 'com', 'org', 'www', 'university', 'institute', 'college', 'school', 'department', 'technology', 'research', 'science', 'sciences']);

/**
 * The words of an institution's name that say which one it is, and its
 * initials — Scholar writes "MIT" and "mit.edu" where OpenAlex writes
 * "Massachusetts Institute of Technology".
 */
const placeWords = (value: string): string[] => {
  const words = value.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const initials = words.filter((word) => !['of', 'the', 'and', 'for', 'at', 'de'].includes(word)).map((word) => word[0]).join('');
  const out = words.filter((word) => word.length > 2 && !COMMON.has(word));
  if (initials.length >= 2 && words.length > 1) out.push(initials);
  return out;
};

/**
 * Their Google Scholar profile, through the proxy — null when there is no
 * proxy, Scholar would not answer, or no profile is plainly them. Among
 * several with the name, the one at the institution OpenAlex names wins; a
 * lone profile with the name is taken as it is.
 */
export function scholarProfile(name: string, places: string[]): Promise<AuthorRef | null> {
  if (!hasProxy()) return Promise.resolve(null);
  return remembered(profiles, `${name}|${places.join('|')}`, async () => {
    const found = (await scholarAuthors(name).catch(() => [] as AuthorRef[])).filter(
      (author) => author.scholarProfileUrl && nameMatches(author.name, name),
    );
    if (!found.length) return null;
    const wanted = new Set(places.flatMap(placeWords));
    const atPlace = found.find((author) => {
      const here = [author.affiliation || '', author.verifiedEmail || ''].join(' ');
      return placeWords(here).some((word) => wanted.has(word));
    });
    return atPlace ?? (found.length === 1 ? found[0] : null);
  });
}
