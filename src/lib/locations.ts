/**
 * Every place a paper can be read from, not just the first one an index
 * happens to mention.
 *
 * This is the piece Google Scholar's "All 14 versions" line does: one paper is
 * a publisher's copy, an arXiv preprint, an institutional repository deposit
 * and a PubMed Central record all at once, and which of them actually hands
 * over a PDF is not knowable until one is asked. Picking a single "best" link
 * and failing when it turns out to be a login wall is what made papers outside
 * arXiv hard to open here.
 *
 * Scholar itself is not one of the sources below and cannot be: it publishes no
 * API, its terms forbid automated access, and it blocks the datacentre IPs any
 * proxy of this app runs on. What it indexes, though, is largely what Unpaywall,
 * OpenAlex, Semantic Scholar and Crossref *do* publish, so the versions list
 * below is assembled from those four directly. There is a link out to the
 * Scholar page for the paper alongside it, for the cases where a person wants
 * to look themselves.
 */
import type { PaperLocation, PaperRef } from '../types';
import { hasProxy } from './api';
import { contactEmail, politely } from './contact';
import { scholarLookup, scholarVersions, scholarWork } from './scholar';
import type { OpenAlexWork } from './sources';

const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();

/** https-only: the proxy refuses anything else, and so should we. */
function https(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const upgraded = String(url).trim().replace(/^http:\/\//i, 'https://');
  return /^https:\/\/\S+$/i.test(upgraded) ? upgraded : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Two URLs for the same file, written differently. Normalising away the scheme,
 * a `www.`, a trailing slash and the query string is enough to fold the copies
 * that OpenAlex, Unpaywall and Semantic Scholar all report separately.
 */
function fingerprint(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

/** Hosts whose links are files even when nobody says `.pdf`. */
const PDF_PATH = /\.pdf($|\?)|\/pdf(\/|$)|format=pdf|type=printable/i;

const looksLikePdf = (url: string) => PDF_PATH.test(url);

function locate(
  url: string | null | undefined,
  rest: Omit<PaperLocation, 'url' | 'host' | 'label'> & { label?: string },
): PaperLocation | null {
  const safe = https(url);
  if (!safe) return null;
  const host = hostOf(safe);
  if (!host) return null;
  return {
    url: safe,
    host,
    label: clean(rest.label) || host,
    kind: rest.kind,
    isPdf: rest.isPdf || looksLikePdf(safe),
    via: rest.via,
    version: rest.version,
  };
}

// ------------------------------------------------------------- the paper ----

/** What the search result itself already said, before anything is fetched. */
function fromPaper(paper: PaperRef): PaperLocation[] {
  const found: (PaperLocation | null)[] = [];
  if (paper.arxivId) {
    const id = paper.arxivId;
    found.push(
      locate(`https://arxiv.org/pdf/${id}`, { kind: 'preprint', isPdf: true, via: 'arxiv', label: 'arXiv' }),
    );
  }
  found.push(locate(paper.pdfUrl, { kind: 'unknown', isPdf: true, via: 'paper' }));
  // A profile's entry lands on Scholar's own page about the paper, which is
  // not a copy of it: the copies are what that page lists, read below.
  if (!isScholarPage(paper.landingUrl)) {
    found.push(locate(paper.landingUrl, { kind: 'publisher', isPdf: false, via: 'paper' }));
  }
  return found.filter((entry): entry is PaperLocation => Boolean(entry));
}

const isScholarPage = (url: string | undefined) => hostOf(url || '') === 'scholar.google.com';

// ------------------------------------------------------------ Unpaywall ----

interface UnpaywallLocation {
  url?: string | null;
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
  host_type?: string | null;
  repository_institution?: string | null;
  version?: string | null;
}

/**
 * Unpaywall does one job — find every free copy of a DOI — and does it better
 * than either index, because it also knows about repository deposits the
 * publisher never advertises. It requires a contact address and refuses the
 * request without one, so no email in Settings means this is skipped.
 */
async function fromUnpaywall(paper: PaperRef, signal?: AbortSignal): Promise<PaperLocation[]> {
  const email = contactEmail();
  if (!email || !paper.doi) return [];
  const response = await fetch(
    `https://api.unpaywall.org/v2/${encodeURIComponent(paper.doi)}?email=${encodeURIComponent(email)}`,
    { signal },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    best_oa_location?: UnpaywallLocation | null;
    oa_locations?: UnpaywallLocation[] | null;
  };
  const seen = new Set<UnpaywallLocation>();
  const all = [payload.best_oa_location, ...(payload.oa_locations || [])].filter(
    (entry): entry is UnpaywallLocation => Boolean(entry) && !seen.has(entry as UnpaywallLocation) && Boolean(seen.add(entry as UnpaywallLocation)),
  );

  const found: (PaperLocation | null)[] = [];
  for (const location of all) {
    const kind = location.host_type === 'publisher' ? 'publisher' : 'repository';
    const label = clean(location.repository_institution) || undefined;
    const version = clean(location.version) || undefined;
    found.push(locate(location.url_for_pdf, { kind, isPdf: true, via: 'unpaywall', label, version }));
    found.push(
      locate(location.url_for_landing_page || location.url, {
        kind,
        isPdf: false,
        via: 'unpaywall',
        label,
        version,
      }),
    );
  }
  return found.filter((entry): entry is PaperLocation => Boolean(entry));
}

// -------------------------------------------------------------- OpenAlex ----

/**
 * Every location OpenAlex holds, rather than only the one it calls best.
 * `locations` is the full list — the version of record and each repository
 * copy — which is where the long tail of institutional deposits lives.
 */
export function openAlexLocations(work: OpenAlexWork): PaperLocation[] {
  const found: (PaperLocation | null)[] = [];
  const all = [
    ...(work.locations || []),
    work.best_oa_location,
    work.primary_location,
  ].filter(Boolean);

  for (const location of all) {
    if (!location) continue;
    const label = clean(location.source?.display_name) || undefined;
    const kind = location.source?.type === 'repository' ? 'repository' : 'publisher';
    found.push(locate(location.pdf_url, { kind, isPdf: true, via: 'openalex', label, version: location.version ?? undefined }));
    found.push(
      locate(location.landing_page_url, { kind, isPdf: false, via: 'openalex', label, version: location.version ?? undefined }),
    );
  }
  found.push(locate(work.open_access?.oa_url, { kind: 'unknown', isPdf: false, via: 'openalex' }));

  const pmcid = work.ids?.pmcid?.match(/PMC\d+/i)?.[0];
  if (pmcid) {
    found.push(
      locate(`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`, {
        kind: 'repository',
        isPdf: true,
        via: 'pmc',
        label: 'PubMed Central',
      }),
    );
  }
  return found.filter((entry): entry is PaperLocation => Boolean(entry));
}

async function fromOpenAlex(paper: PaperRef, signal?: AbortSignal): Promise<PaperLocation[]> {
  const key = paper.doi
    ? `doi:${paper.doi}`
    : paper.arxivId
      ? `doi:10.48550/arXiv.${paper.arxivId.replace(/v\d+$/, '')}`
      : paper.id.startsWith('https://openalex.org/')
        ? paper.id.split('/').pop()
        : undefined;

  if (key) {
    const response = await fetch(`https://api.openalex.org/works/${encodeURIComponent(key)}`, { signal });
    if (response.ok) return openAlexLocations((await response.json()) as OpenAlexWork);
    if (response.status !== 404) return [];
  }
  if (!paper.title) return [];

  // No identifier — match on the title instead, and only trust an exact match.
  const params = new URLSearchParams({ per_page: '1' });
  params.set('filter', `title.search:${paper.title.replace(/[,:|]+/g, ' ').slice(0, 200)}`);
  const response = await fetch(`https://api.openalex.org/works?${politely(params)}`, { signal });
  if (!response.ok) return [];
  const payload = (await response.json()) as { results?: OpenAlexWork[] };
  const work = (payload.results || [])[0];
  if (!work) return [];
  const same = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (same(clean(work.display_name)) !== same(paper.title)) return [];
  return openAlexLocations(work);
}

// ------------------------------------------------------ Semantic Scholar ----

async function fromSemanticScholar(paper: PaperRef, signal?: AbortSignal): Promise<PaperLocation[]> {
  const key = paper.arxivId
    ? `ARXIV:${paper.arxivId.replace(/v\d+$/, '')}`
    : paper.doi
      ? `DOI:${paper.doi}`
      : paper.id.startsWith('s2:')
        ? paper.id.slice(3)
        : undefined;
  if (!key) return [];
  const response = await fetch(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(key)}?fields=openAccessPdf,externalIds`,
    { signal },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    openAccessPdf?: { url?: string } | null;
    externalIds?: { ArXiv?: string; PubMedCentral?: string } | null;
  };
  const found: (PaperLocation | null)[] = [
    locate(payload.openAccessPdf?.url, { kind: 'repository', isPdf: true, via: 'semanticscholar' }),
  ];
  const arxiv = payload.externalIds?.ArXiv;
  if (arxiv) {
    found.push(
      locate(`https://arxiv.org/pdf/${arxiv}`, { kind: 'preprint', isPdf: true, via: 'arxiv', label: 'arXiv' }),
    );
  }
  const pmc = payload.externalIds?.PubMedCentral;
  if (pmc) {
    found.push(
      locate(`https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${String(pmc).replace(/^PMC/i, '')}/pdf/`, {
        kind: 'repository',
        isPdf: true,
        via: 'pmc',
        label: 'PubMed Central',
      }),
    );
  }
  return found.filter((entry): entry is PaperLocation => Boolean(entry));
}

// -------------------------------------------------------------- Crossref ----

async function fromCrossref(paper: PaperRef, signal?: AbortSignal): Promise<PaperLocation[]> {
  if (!paper.doi) return [];
  const response = await fetch(
    `https://api.crossref.org/works/${encodeURIComponent(paper.doi)}?${politely(new URLSearchParams())}`,
    { signal },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    message?: {
      link?: { URL?: string; 'content-type'?: string }[];
      URL?: string;
      publisher?: string;
    };
  };
  const message = payload.message || {};
  const label = clean(message.publisher) || undefined;
  const found = (message.link || []).map((link) =>
    locate(link.URL, {
      kind: 'publisher',
      isPdf: (link['content-type'] || '').toLowerCase().includes('pdf'),
      via: 'crossref',
      label,
    }),
  );
  found.push(locate(message.URL, { kind: 'publisher', isPdf: false, via: 'crossref', label }));
  return found.filter((entry): entry is PaperLocation => Boolean(entry));
}

// -------------------------------------------------------- Google Scholar ----

/**
 * Scholar's "All 84 versions", which is the longest list of copies of a paper
 * anywhere — it finds departmental pages, course readers and lab mirrors that
 * no index has a record of. It is only asked when the paper came from Scholar
 * in the first place, because the cluster id is the only handle on it, and
 * only when a proxy is there to ask through.
 */
async function fromScholar(paper: PaperRef, signal?: AbortSignal): Promise<PaperLocation[]> {
  if (!hasProxy()) return [];
  const found: (PaperLocation | null)[] = [];
  let cluster = paper.scholarCluster;
  const fromProfile = Boolean(paper.scholarCitation) || paper.source === 'scholar';

  const take = (result: { pdfUrl?: string; pdfHost?: string; url?: string; clusterId?: string } | undefined) => {
    if (!result) return;
    const label = result.pdfHost || undefined;
    found.push(locate(result.pdfUrl, { kind: 'unknown', isPdf: true, via: 'scholar', label }));
    found.push(locate(result.url, { kind: 'publisher', isPdf: false, via: 'scholar' }));
    if (!cluster) cluster = result.clusterId;
  };
  const hasFile = () => found.some((entry) => entry?.isPdf);

  // A paper from a person's profile arrives with no cluster and no file: the
  // list gives neither. Its own page on Scholar gives both — the "[PDF] from
  // bu.edu" beside the title is the copy on the person's own site that no
  // index has a record of — so that page is asked for first, and the cluster
  // it names is what the versions below are asked for.
  if (!cluster && paper.scholarCitation) {
    // A refusal here is not the end of it: the search below is asked next.
    take(await scholarWork(paper.scholarCitation, signal).catch(() => undefined));
  }

  // Scholar refuses its profile pages far more readily than a search — a bare
  // 401 to anything that is not a browser, where the search answers — and a
  // proxy older than this page has no route for the entry at all. The search
  // is the page that is known to answer, and it finds the same record the
  // Papers tab shows, file and cluster included; so it is asked whenever the
  // entry's own page gave neither, which is what keeps a paper opened from a
  // profile in step with the same paper found by its title.
  if (fromProfile && !cluster && !hasFile() && paper.title) {
    take(await scholarLookup(paper.title, signal).catch(() => undefined));
  }
  if (!cluster) return found.filter((entry): entry is PaperLocation => Boolean(entry));

  const versions = await scholarVersions(cluster, signal).catch((error: unknown) => {
    // The entry's own page answered; a refusal on the second ask costs the
    // other copies, not the one it already found.
    if (found.length) return [];
    throw error;
  });
  for (const version of versions) {
    const label = version.pdfHost || undefined;
    found.push(locate(version.pdfUrl, { kind: 'unknown', isPdf: true, via: 'scholar', label }));
    found.push(locate(version.url, { kind: 'unknown', isPdf: false, via: 'scholar', label }));
  }
  return found.filter((entry): entry is PaperLocation => Boolean(entry));
}

// ------------------------------------------------------------- the order ----

/**
 * Which copy to try first. A file beats a landing page, because only a file can
 * be shown; a preprint server beats a repository and a repository beats a
 * publisher, because that is the order in which they answer an anonymous
 * request without a paywall, a cookie banner or a captcha in the way.
 */
const KIND_RANK: Record<PaperLocation['kind'], number> = {
  preprint: 0,
  repository: 1,
  unknown: 2,
  publisher: 3,
};

export function rankLocations(locations: PaperLocation[]): PaperLocation[] {
  return locations
    .map((location, index) => ({ location, index }))
    .sort((a, b) => {
      if (a.location.isPdf !== b.location.isPdf) return a.location.isPdf ? -1 : 1;
      const kind = KIND_RANK[a.location.kind] - KIND_RANK[b.location.kind];
      if (kind) return kind;
      return a.index - b.index;
    })
    .map((entry) => entry.location);
}

/** Folds the same copy reported by several indexes into one entry. */
export function mergeLocations(groups: PaperLocation[][]): PaperLocation[] {
  const byUrl = new Map<string, PaperLocation>();
  for (const group of groups) {
    for (const location of group) {
      const key = fingerprint(location.url);
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, { ...location });
        continue;
      }
      // Whoever knows more wins: a named repository over a bare host, a file
      // over a landing page, a stated version over none.
      if (location.isPdf && !existing.isPdf) existing.isPdf = true;
      if (existing.label === existing.host && location.label !== location.host) existing.label = location.label;
      if (!existing.version && location.version) existing.version = location.version;
      if (KIND_RANK[location.kind] < KIND_RANK[existing.kind]) existing.kind = location.kind;
    }
  }
  return rankLocations(Array.from(byUrl.values()));
}

// ------------------------------------------------------------------ cache ---

const cache = new Map<string, PaperLocation[]>();

const cacheKey = (paper: PaperRef) => paper.id || paper.doi || paper.title;

/**
 * Every location for a paper, from every index that knows about it, ranked by
 * how likely each is to hand over the file.
 *
 * The four lookups run together and each one failing is survivable: a source
 * that is down or rate-limiting costs its own copies, not the whole list.
 */
export async function findLocations(paper: PaperRef, signal?: AbortSignal): Promise<PaperLocation[]> {
  const key = cacheKey(paper);
  const cached = key ? cache.get(key) : undefined;
  if (cached) return cached;

  const settled = await Promise.allSettled([
    fromUnpaywall(paper, signal),
    fromOpenAlex(paper, signal),
    fromSemanticScholar(paper, signal),
    fromCrossref(paper, signal),
    fromScholar(paper, signal),
  ]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const groups = [fromPaper(paper)];
  for (const outcome of settled) if (outcome.status === 'fulfilled') groups.push(outcome.value);

  const merged = mergeLocations(groups);
  if (key) cache.set(key, merged);
  return merged;
}

/** Forgets what was resolved, so a retry actually asks again. */
export function forgetLocations(paper?: PaperRef): void {
  if (!paper) cache.clear();
  else cache.delete(cacheKey(paper));
}

// ---------------------------------------------------------- Scholar links ---

/**
 * Google Scholar cannot be searched from here — no API, terms that forbid it,
 * and a block on datacentre IPs — but a person can, and these are the links
 * that put them on the right page in one click.
 */
export function scholarPaperUrl(paper: PaperRef): string {
  const query = paper.title || paper.doi || paper.id;
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${query}"`)}`;
}

/** Scholar's own "all versions" view, which is the list above from its side. */
export const scholarVersionsUrl = scholarPaperUrl;

export function scholarAuthorUrl(name: string): string {
  return `https://scholar.google.com/citations?hl=en&view_op=search_authors&mauthors=${encodeURIComponent(name)}`;
}

/** Every paper with a name on it, as Scholar reads a name. */
export function scholarAuthorPapersUrl(name: string): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(`author:"${name}"`)}`;
}
