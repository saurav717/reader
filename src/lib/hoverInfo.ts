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
import { fromScholar, scholarAuthors, scholarPaperAuthors, scholarPerson, scholarProfileWorks } from './scholar';
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

/** A topic as OpenAlex files a work or a person under it, with the field it belongs to. */
export interface OpenAlexTopic {
  display_name: string;
  /** On a person: how many of their works are on it. */
  count?: number;
  field?: { display_name: string | null } | null;
}

type WorkWithAuthors = OpenAlexWork & {
  authorships: Authorship[];
  title?: string | null;
  topics?: OpenAlexTopic[];
  publication_year?: number | null;
};

interface OpenAlexAuthorRecord {
  id: string;
  display_name: string | null;
  orcid: string | null;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: { h_index?: number; i10_index?: number; '2yr_mean_citedness'?: number };
  last_known_institutions?: { display_name: string | null }[];
  topics?: OpenAlexTopic[];
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
  /** Their name as the index writes it out, when the byline has only initials. */
  fullName?: string;
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
  /**
   * The record OpenAlex gave for the name, when it does not look like the
   * person who wrote this paper — another of the name, or several people
   * folded into one record. None of it is shown as theirs: not its counts,
   * its institution, its topics or its papers.
   */
  mistaken?: {
    openAlexId: string;
    /** Why it was set aside, as the card says it. */
    reason: string;
    affiliation?: string;
    topics: string[];
  };
}

interface PaperKey {
  id: string;
  title: string;
  doi?: string;
  arxivId?: string;
  year?: number;
}

/** The open paper as OpenAlex records it: its authors, with ids and institutions, and what it is about. */
interface PaperRecord {
  authorships: Authorship[];
  topics: OpenAlexTopic[];
}

const paperRecords = new Map<string, Promise<PaperRecord>>();

function recordOf(paper: PaperKey): Promise<PaperRecord> {
  return remembered(paperRecords, paper.id, async () => {
    const of = (work?: WorkWithAuthors | null): PaperRecord => ({ authorships: work?.authorships ?? [], topics: work?.topics ?? [] });
    const fields = new URLSearchParams({ select: 'id,title,authorships,topics,publication_year' });
    const doi = paper.doi ?? (paper.arxivId ? `10.48550/arxiv.${paper.arxivId.replace(/v\d+$/, '')}` : undefined);
    if (doi) {
      const work = await openAlexJson<WorkWithAuthors>(`works/doi:${encodeURIComponent(doi)}`, fields).catch(() => null);
      if (work?.authorships?.length) return of(work);
    }
    if (!paper.title) return of();
    const params = new URLSearchParams({ per_page: '5', select: 'id,title,display_name,authorships,topics,publication_year' });
    params.set('filter', `title.search:${filterValue(paper.title)}`);
    const found = await openAlexJson<{ results?: WorkWithAuthors[] }>('works', params);
    return of(found?.results?.find((work) => titleFits(work.title || work.display_name || '', paper.title)));
  });
}

/** Years apart two runs of a record's papers have to be before it is taken for two people. */
const ERA_GAP = 30;
/** The least share of a record's work that has to be in the paper's fields for it to be the paper's author. */
const FIELD_SHARE = 0.05;

/**
 * Why an author record is not the person who wrote the paper, or undefined
 * when nothing says so. OpenAlex's disambiguation files people under a
 * name, and now and then files a paper under the wrong person or folds two
 * people into one: a self-help book of 1936 under an engineer publishing
 * since 1999. Two things give that away. The record's papers come in runs
 * decades apart, with nothing between — no one's career looks like that. Or
 * next to nothing it has is in the fields this paper is in.
 *
 * `years` is how many of the record's papers came out in each year;
 * `paperTopics` and `personTopics` are OpenAlex's topics for the paper and
 * for the person, with their fields.
 */
export function recordDoubt(
  paperTopics: OpenAlexTopic[],
  personTopics: OpenAlexTopic[],
  years: Record<string, number>,
): string | undefined {
  const active = Object.entries(years)
    .filter(([year, count]) => /^\d{4}$/.test(year) && count > 0)
    .map(([year]) => Number(year))
    .sort((a, b) => a - b);
  for (let i = 1; i < active.length; i++) {
    if (active[i] - active[i - 1] >= ERA_GAP) {
      const span = (from: number, to: number) => (from === to ? String(from) : `${from}–${to}`);
      return `its papers come from ${span(active[0], active[i - 1])} and from ${span(active[i], active[active.length - 1])}, with nothing in between — more than one person under one name`;
    }
  }

  const fieldOf = (topic: OpenAlexTopic) => topic.field?.display_name || '';
  const fields = new Set(paperTopics.map(fieldOf).filter(Boolean));
  const counted = personTopics.filter((topic) => fieldOf(topic));
  if (fields.size && counted.length) {
    const weight = (topic: OpenAlexTopic) => (typeof topic.count === 'number' && topic.count > 0 ? topic.count : 1);
    const total = counted.reduce((sum, topic) => sum + weight(topic), 0);
    const inFields = counted.filter((topic) => fields.has(fieldOf(topic))).reduce((sum, topic) => sum + weight(topic), 0);
    if (inFields / total < FIELD_SHARE) {
      const theirs = [...new Set(counted.map(fieldOf))].slice(0, 2).join(' and ');
      return `its work is in ${theirs}, and this paper is in ${[...fields].slice(0, 2).join(' and ')}`;
    }
  }
  return undefined;
}

/** How many of an author's papers came out in each year. */
async function yearsOf(id: string): Promise<Record<string, number>> {
  const params = new URLSearchParams({ group_by: 'publication_year' });
  params.set('filter', `author.id:${id}`);
  const found = await openAlexJson<{ group_by?: { key: string; count: number }[] }>('works', params);
  return Object.fromEntries((found?.group_by || []).map((group) => [group.key, group.count]));
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
  const found = await recordOf(paper).catch((): PaperRecord => ({ authorships: [], topics: [] }));
  const ships = found.authorships;
  const named = (ship: Authorship) => nameMatches(ship.author.display_name || ship.raw_author_name || '', name);
  const ship = ships[position] && named(ships[position]) ? ships[position] : ships.find(named);

  let via: AuthorDetails['via'] = ship ? 'paper' : 'none';
  let id = ship?.author.id?.split('/').pop();
  if (!id) {
    const params = new URLSearchParams({ search: name, per_page: '5' });
    const results = await openAlexJson<{ results?: OpenAlexAuthorRecord[] }>('authors', params).catch(() => null);
    const best = results?.results?.find((record) => nameMatches(record.display_name || '', name));
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

  const worksParams = new URLSearchParams({ per_page: '15', sort: 'cited_by_count:desc' });
  worksParams.set('filter', `author.id:${id}`);
  const [record, found15, years] = await Promise.all([
    openAlexJson<OpenAlexAuthorRecord>(`authors/${id}`).catch(() => null),
    openAlexJson<{ results?: (OpenAlexWork & { primary_topic?: OpenAlexTopic | null })[] }>('works', worksParams).catch(() => null),
    yearsOf(id).catch(() => ({}) as Record<string, number>),
  ]);
  // OpenAlex now and then folds several people of a name into one record, so
  // its most cited works are kept to the fields this paper is in: an
  // aphasia paper's author is not the author of one on construction robots.
  const fields = new Set(found.topics.map((topic) => topic.field?.display_name).filter(Boolean));
  const inField = (work: { primary_topic?: OpenAlexTopic | null }) =>
    !fields.size || !work.primary_topic?.field?.display_name || fields.has(work.primary_topic.field.display_name);
  const works = (found15?.results || []).filter(inField).slice(0, 3).map(fromOpenAlex);
  const topics = (record?.topics || []).slice(0, 4).map((topic) => topic.display_name);
  const affiliation = record?.last_known_institutions?.[0]?.display_name || undefined;

  const doubt = recordDoubt(found.topics, record?.topics || [], years);
  if (doubt) {
    details.mistaken = { openAlexId: id, reason: doubt, affiliation, topics };
    return details;
  }

  details.openAlexId = id;
  details.topWorks = works;
  // The name the paper's own record gives them, else the person record's.
  const written = [ship?.author.display_name, record?.display_name].find((full) => full && full.length > name.length && nameMatches(full, name));
  if (written) details.fullName = written;
  if (record) {
    details.orcid = record.orcid?.replace('https://orcid.org/', '') || undefined;
    details.affiliation = affiliation;
    details.worksCount = record.works_count;
    details.citedBy = record.cited_by_count;
    details.hIndex = record.summary_stats?.h_index;
    details.i10Index = record.summary_stats?.i10_index;
    details.topics = topics;
  }
  return details;
}

// ----------------------------------------------------------- elsewhere ---

const OPEN_LIBRARY = 'https://openlibrary.org';

/** A book or paper of theirs found somewhere other than their OpenAlex record. */
export interface OtherWork {
  title: string;
  year?: number;
  /** How many editions Open Library knows of — a book's reach, where a paper's is its citations. */
  editions?: number;
  citedBy?: number;
  url?: string;
}

/** Where else a person has a page of their own: Wikipedia, Open Library, Wikidata and the like. */
export interface Elsewhere {
  /** Their name as those pages write it, when it is fuller than the byline's. */
  fullName?: string;
  /** When they lived — "1888–1955" — for someone who has died. */
  lived?: string;
  /** Who they are, in a line: "American writer and lecturer". */
  description?: string;
  /** A paragraph about them. */
  about?: string;
  profiles: { site: string; url: string }[];
  /** Their best-known works there, the open paper left out. */
  works: OtherWork[];
}

interface OpenLibraryDoc {
  key: string;
  title: string;
  author_name?: string[];
  author_key?: string[];
  first_publish_year?: number;
  edition_count?: number;
}

interface OpenLibraryAuthor {
  name?: string;
  personal_name?: string;
  birth_date?: string;
  death_date?: string;
  bio?: string | { value?: string };
  wikipedia?: string;
  remote_ids?: { wikidata?: string; viaf?: string; isni?: string };
}

async function json<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return (await response.json()) as T;
}

async function openLibrarySearch(params: URLSearchParams): Promise<OpenLibraryDoc[]> {
  params.set('fields', 'key,title,author_name,author_key,first_publish_year,edition_count');
  const found = await json<{ docs?: OpenLibraryDoc[] }>(`${OPEN_LIBRARY}/search.json?${params}`);
  return found?.docs ?? [];
}

const yearIn = (value?: string) => /\d{3,4}/.exec(value || '')?.[0];

/** The English Wikipedia page a Wikidata item links to, with its one-line description and first paragraph. */
async function wikipedia(wikidata: string): Promise<{ url: string; description?: string; extract?: string } | null> {
  const params = new URLSearchParams({ action: 'wbgetentities', ids: wikidata, props: 'sitelinks', sitefilter: 'enwiki', format: 'json', origin: '*' });
  const entity = await json<{ entities?: Record<string, { sitelinks?: { enwiki?: { title: string } } }> }>(
    `https://www.wikidata.org/w/api.php?${params}`,
  );
  const title = entity?.entities?.[wikidata]?.sitelinks?.enwiki?.title;
  if (!title) return null;
  const page = encodeURIComponent(title.replace(/ /g, '_'));
  const summary = await json<{ description?: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${page}`,
  ).catch(() => null);
  return {
    url: summary?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${page}`,
    description: summary?.description,
    extract: summary?.extract,
  };
}

const elsewhereCache = new Map<string, Promise<Elsewhere>>();

/**
 * Where else the author has a page, found through the open paper: Open
 * Library is asked for a book with its title and an author of the name, and
 * the author it files the book under is followed to their record, their
 * Wikipedia page and Wikidata item, and their other books. Going by the
 * paper and not by the name is what keeps a namesake out — a search for
 * "D Carnegie" finds several people; the author of *How to Win Friends and
 * Influence People* is one. A paper Open Library does not know finds nothing.
 */
export function profilesElsewhere(name: string, paper: PaperKey): Promise<Elsewhere> {
  return remembered(elsewhereCache, `${paper.id}|${name}`, () => findElsewhere(name, paper));
}

async function findElsewhere(name: string, paper: PaperKey): Promise<Elsewhere> {
  const none: Elsewhere = { profiles: [], works: [] };
  const surname = name.trim().split(/\s+/).pop() || name;
  if (!paper.title || paper.title.length < 8) return none;
  const docs = await openLibrarySearch(new URLSearchParams({ title: paper.title.slice(0, 200), author: surname, limit: '10' }));

  let key: string | undefined;
  for (const doc of docs) {
    if (!titleFits(doc.title, paper.title)) continue;
    const at = (doc.author_name || []).findIndex((author) => nameMatches(author, name));
    if (at >= 0 && doc.author_key?.[at]) {
      key = doc.author_key[at];
      break;
    }
  }
  if (!key) return none;

  const [author, books] = await Promise.all([
    json<OpenLibraryAuthor>(`${OPEN_LIBRARY}/authors/${key}.json`).catch(() => null),
    openLibrarySearch(new URLSearchParams({ q: `author_key:${key}`, sort: 'editions', limit: '12' })).catch(() => []),
  ]);

  const out: Elsewhere = { profiles: [], works: [] };
  const fullName = author?.name || author?.personal_name;
  if (fullName && fullName.toLowerCase() !== name.toLowerCase()) out.fullName = fullName;
  const born = yearIn(author?.birth_date);
  const died = yearIn(author?.death_date);
  if (born || died) out.lived = died ? `${born ?? '?'}–${died}` : `born ${born}`;
  const bio = typeof author?.bio === 'string' ? author.bio : author?.bio?.value;

  const wikidata = author?.remote_ids?.wikidata;
  const wiki = wikidata ? await wikipedia(wikidata).catch(() => null) : null;
  if (wiki) {
    out.profiles.push({ site: 'Wikipedia', url: wiki.url });
    out.description = wiki.description;
    out.about = wiki.extract;
  } else if (author?.wikipedia) {
    out.profiles.push({ site: 'Wikipedia', url: author.wikipedia });
  }
  if (!out.about && bio) out.about = bio.replace(/\s+/g, ' ').trim();
  out.profiles.push({ site: 'Open Library', url: `${OPEN_LIBRARY}/authors/${key}` });
  if (wikidata) out.profiles.push({ site: 'Wikidata', url: `https://www.wikidata.org/wiki/${wikidata}` });
  if (author?.remote_ids?.viaf) out.profiles.push({ site: 'VIAF', url: `https://viaf.org/viaf/${author.remote_ids.viaf}` });

  // One entry per book: Open Library keeps translations and retitlings apart.
  const seen = new Set<string>();
  for (const book of books) {
    const fold = book.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!fold || seen.has(fold) || titleFits(book.title, paper.title) || titleFits(paper.title, book.title)) continue;
    seen.add(fold);
    out.works.push({ title: book.title, year: book.first_publish_year, editions: book.edition_count, url: `${OPEN_LIBRARY}${book.key}` });
    if (out.works.length >= 4) break;
  }
  return out;
}

const underName = new Map<string, Promise<OtherWork[]>>();

/**
 * What else has been published under the name, for someone with a page
 * nowhere: the most cited papers OpenAlex has with the name as printed on
 * them, and the books Open Library files under it, the open paper left out.
 * Nothing here says it is the same person, and the card says as much.
 */
export function worksUnderName(name: string, paper: PaperKey): Promise<OtherWork[]> {
  return remembered(underName, `${paper.id}|${name}`, async () => {
    const params = new URLSearchParams({ per_page: '5', sort: 'cited_by_count:desc' });
    params.set('filter', `raw_author_name.search:${filterValue(name)}`);
    const [papers, books] = await Promise.all([
      openAlexWorks(params).catch(() => [] as PaperRef[]),
      openLibrarySearch(new URLSearchParams({ author: name, sort: 'editions', limit: '5' })).catch(() => [] as OpenLibraryDoc[]),
    ]);
    const all: OtherWork[] = [
      ...books
        .filter((book) => (book.author_name || []).some((author) => nameMatches(author, name)))
        .map((book) => ({ title: book.title, year: book.first_publish_year, editions: book.edition_count, url: `${OPEN_LIBRARY}${book.key}` })),
      ...papers
        .filter((work) => work.authors.some((author) => nameMatches(author, name)))
        .map((work) => ({ title: work.title, year: Number(work.published.slice(0, 4)) || undefined, citedBy: work.citedBy, url: work.landingUrl })),
    ];
    const seen = new Set<string>();
    return all
      .filter((work) => {
        const fold = work.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!fold || seen.has(fold) || titleFits(work.title, paper.title) || titleFits(paper.title, work.title)) return false;
        seen.add(fold);
        return true;
      })
      .slice(0, 5);
  });
}

// -------------------------------------------------------------- Scholar ---

const profiles = new Map<string, Promise<ScholarFind>>();
const paperAuthors = new Map<string, Promise<Awaited<ReturnType<typeof scholarPaperAuthors>>>>();

/** A Scholar profile, with what the profile's own page says: its counts and its most cited works. */
export interface ScholarProfile extends AuthorRef {
  homepage?: string;
  citedBySince?: number;
  i10Index?: number;
  works: PaperRef[];
}

/**
 * What asking Scholar for someone's profile came to. `confirmed` is whether
 * the profile is plainly theirs: Scholar's record of the paper links the
 * byline's name to it, or the profile lists the paper among its own works.
 * Only a confirmed profile's counts are shown as the author's; one found by
 * the name, and at the right institution or the only one of the name, is a
 * likely profile and is offered as that. `error` is set when Scholar could
 * not be asked, which is not the same as their having no profile.
 */
export interface ScholarFind {
  profile: ScholarProfile | null;
  confirmed: boolean;
  how?: 'paper' | 'listed' | 'place' | 'name';
  error?: string;
}

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A profile opened: the page's counts and works over what the link or the search gave. */
async function opened(ref: AuthorRef): Promise<ScholarProfile> {
  const person = ref.scholarUserId ? await scholarPerson(ref.scholarUserId).catch(() => undefined) : undefined;
  if (!person) return { ...ref, works: [] };
  return {
    ...ref,
    name: person.name || ref.name,
    affiliation: person.affiliation || ref.affiliation,
    verifiedEmail: person.verifiedEmail || ref.verifiedEmail,
    interests: person.interests.length ? person.interests : ref.interests,
    scholarProfileUrl: person.profileUrl || ref.scholarProfileUrl,
    homepage: person.homepage,
    citedBy: person.citedBy ?? ref.citedBy,
    citedBySince: person.citedBySince,
    hIndex: person.hIndex,
    i10Index: person.i10Index,
    works: person.works.map(fromScholar),
  };
}

const fromLink = (link: { name: string; userId: string }): AuthorRef => ({
  id: `scholar:${link.userId}`,
  source: 'scholar',
  name: link.name,
  scholarUserId: link.userId,
  scholarProfileUrl: `https://scholar.google.com/citations?hl=en&user=${encodeURIComponent(link.userId)}`,
});

const isPaper = (title: string, paper: string) => titleFits(title.replace(/…$/, ''), paper);

/** Pages of a profile's newest works looked through for the paper, past its most cited. */
const NEWEST_PAGES = 3;

/**
 * Whether a profile lists the paper among its works. Its most cited works
 * are looked at first — they came with the profile — then its newest, page
 * by page, until the pages are older than the paper, or run out.
 */
async function listsPaper(profile: ScholarProfile, paper: { title: string; year?: number }): Promise<boolean> {
  if (profile.works.some((work) => isPaper(work.title, paper.title))) return true;
  if (!profile.scholarUserId) return false;
  for (let page = 0; page < NEWEST_PAGES; page += 1) {
    const works = await scholarProfileWorks(profile.scholarUserId, { page, order: 'newest' }).catch(() => [] as PaperRef[]);
    if (works.some((work) => isPaper(work.title, paper.title))) return true;
    if (works.length < 20) return false;
    const years = works.map((work) => Number(work.published.slice(0, 4))).filter(Boolean);
    if (paper.year && years.length && Math.max(...years) < paper.year) return false;
  }
  return false;
}

/** How many people of the name are opened to see whether they list the paper. */
const CANDIDATES = 4;

export interface ScholarAsk {
  /** Where OpenAlex has them, when they wrote the paper and now. */
  places?: string[];
  /** Their name written out in full, where an index knows it: "Erin J. Braun" for "EJ Braun". */
  fullNames?: string[];
  /** Whether the one profile of the name may be offered as likely theirs. */
  loneOk?: boolean;
  /** The paper they are an author of, and where they stand in its byline. */
  paper?: { id: string; title: string; year?: number };
  position?: number;
}

/**
 * Their Google Scholar profile, through the proxy.
 *
 * First through the paper: Scholar's record of it links each author who has
 * put it on their profile to that profile, which settles who they are
 * whatever their name. Of two authors of the paper whose names fit, the one
 * standing at `position` in the byline is taken.
 *
 * Else by the name — as the byline prints it and written out in full — and
 * then only a profile that lists the paper is taken as theirs. Scholar's
 * search for a name finds everyone of it: three S Chennuris, or its only
 * "D Carnegie", an engineer in Wellington rather than the author of a book
 * from 1936. None of them listing the paper, the one at the institution
 * OpenAlex names, or the one profile of the name when `loneOk`, is offered
 * as likely theirs and no more.
 */
export function scholarProfile(name: string, ask: ScholarAsk = {}): Promise<ScholarFind> {
  if (!hasProxy()) return Promise.resolve({ profile: null, confirmed: false });
  const { places = [], fullNames = [], loneOk = true, paper, position = -1 } = ask;
  const key = [paper?.id ?? '', position, name, fullNames.join('/'), places.join('/'), loneOk].join('|');
  return remembered(profiles, key, async (): Promise<ScholarFind> => {
    const problems: string[] = [];

    if (paper?.title) {
      const record = await remembered(paperAuthors, paper.id, () => scholarPaperAuthors(paper.title)).catch((error) => {
        problems.push(why(error));
        return undefined;
      });
      const fits = (record?.linked ?? []).filter((link) => nameMatches(link.name, name));
      if (fits.length) {
        const byline = record!.authors;
        const distance = (link: { name: string }) => {
          const at = byline.findIndex((author) => author === link.name || nameMatches(author, link.name));
          return at < 0 || position < 0 ? 0 : Math.abs(at - position);
        };
        const link = fits.slice().sort((a, b) => distance(a) - distance(b))[0];
        return { profile: await opened(fromLink(link)), confirmed: true, how: 'paper' };
      }
    }

    // Everyone of the name, by each way of writing it.
    const queries = Array.from(new Set([name, ...fullNames].map((query) => query.trim()).filter(Boolean)));
    const found: AuthorRef[] = [];
    for (const query of queries) {
      try {
        for (const author of await scholarAuthors(query)) {
          if (!author.scholarProfileUrl || !nameMatches(author.name, name)) continue;
          if (found.some((other) => (other.scholarUserId || other.id) === (author.scholarUserId || author.id))) continue;
          found.push(author);
        }
      } catch (error) {
        problems.push(why(error));
      }
    }
    if (!found.length) return { profile: null, confirmed: false, error: problems[0] };

    const wanted = new Set(places.flatMap(placeWords));
    const atPlace = (author: AuthorRef) => placeWords([author.affiliation || '', author.verifiedEmail || ''].join(' ')).some((word) => wanted.has(word));
    // Those at the paper's institution are looked at first.
    const ranked = found.slice().sort((a, b) => Number(atPlace(b)) - Number(atPlace(a)));

    let likely: ScholarProfile | null = null;
    let how: ScholarFind['how'];
    for (const [index, candidate] of ranked.slice(0, paper?.title ? CANDIDATES : 1).entries()) {
      const profile = await opened(candidate);
      if (paper?.title && (await listsPaper(profile, paper))) return { profile, confirmed: true, how: 'listed' };
      if (index === 0 && atPlace(candidate)) {
        likely = profile;
        how = 'place';
      }
    }
    if (!likely && loneOk && found.length === 1) {
      likely = await opened(found[0]);
      how = 'name';
    }
    return likely ? { profile: likely, confirmed: false, how } : { profile: null, confirmed: false, error: problems[0] };
  });
}

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
