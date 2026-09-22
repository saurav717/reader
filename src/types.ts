export type SourceId = 'arxiv' | 'openalex' | 'semanticscholar' | 'crossref';

/** What a query is asking for: papers about something, or a person. */
export type SearchMode = 'papers' | 'authors';

/**
 * A person, as one of the indexes understands them. Author identity is
 * genuinely ambiguous — two people share a name, one person is recorded under
 * three spellings — so this carries whichever identifier the source has and
 * enough context to tell two candidates apart.
 */
export interface AuthorRef {
  /** Stable app-wide id, e.g. "openalex:A5023888391" or "s2:1741101". */
  id: string;
  source: SourceId;
  name: string;
  /** Where they are now, where the source knows. */
  affiliation?: string;
  orcid?: string;
  worksCount?: number;
  citedBy?: number;
  hIndex?: number;
}

/**
 * One place a paper can be read from. Google Scholar's "All N versions" is the
 * same idea: the publisher's copy, the preprint, and every repository deposit
 * in between are all the same paper, and only some of them will actually hand
 * over a PDF. Collecting them all is what makes a paper openable when the
 * first link is a login wall.
 */
export interface PaperLocation {
  /** What to fetch. A PDF where `isPdf`, otherwise a page a person can open. */
  url: string;
  /** The hostname, which is what identifies a copy to a reader at a glance. */
  host: string;
  /** Repository or publisher name where one is known, else the host. */
  label: string;
  /**
   * `unknown` is a link we have no provenance for — the one a search result
   * carried. It is not assumed to be a repository copy, because assuming that
   * puts a publisher's link ahead of copies we know are repository deposits.
   */
  kind: 'preprint' | 'repository' | 'publisher' | 'unknown';
  /** True when the URL is believed to be the file rather than a landing page. */
  isPdf: boolean;
  /** Which index told us about this copy. */
  via: 'arxiv' | 'unpaywall' | 'openalex' | 'semanticscholar' | 'crossref' | 'pmc' | 'paper';
  /** `submittedVersion`, `acceptedVersion`, `publishedVersion`, where known. */
  version?: string;
}

export interface PaperRef {
  /** Stable app-wide id, e.g. "arxiv:2010.08895" or "doi:10.1234/xyz". */
  id: string;
  source: SourceId;
  title: string;
  authors: string[];
  abstract: string;
  /** ISO date, best effort — some sources only give a year. */
  published: string;
  categories: string[];
  arxivId?: string;
  doi?: string;
  pdfUrl?: string;
  landingUrl?: string;
  venue?: string;
  /** Citation count, where the source reports one. */
  citedBy?: number;
}

export interface DriveRecord {
  /** The paper's own folder in Drive; every paper gets one of its own. */
  folderId?: string;
  /** What that folder is called, for the tooltip on the link to it. */
  folderName?: string;
  /** Where the folder opens in Drive, for the link in the collections pane. */
  folderLink?: string;
  pdfFileId?: string;
  /** Where the PDF opens in Drive's own viewer, for the link in the reader. */
  pdfLink?: string;
  metaFileId?: string;
  syncedAt?: string;
  error?: string;
}

export interface Paper extends PaperRef {
  addedAt: string;
  collectionIds: string[];
  tags: string[];
  /** 0..1, how far down the reader the person has scrolled. */
  progress: number;
  lastOpenedAt?: string;
  drive?: DriveRecord;
  github?: GitHubRecord;
}

export interface Collection {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/**
 * A W3C-Web-Annotation-shaped text quote selector. `hint` is only used to
 * break ties between identical quotes — never as the primary anchor.
 */
export interface Highlight {
  id: string;
  paperId: string;
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  hint: number;
  section?: string;
  note?: string;
  tags: string[];
  createdAt: string;
  orphaned?: boolean;
}

export interface GitHubRecord {
  /** owner/repo this paper was last written to. */
  repo?: string;
  /** Path of the JSON sidecar in the repo. */
  path?: string;
  /** Commit the last write landed in. */
  commit?: string;
  syncedAt?: string;
  error?: string;
}

export interface Settings {
  googleClientId: string;
  driveFolderName: string;
  autoSync: boolean;
  savePdf: boolean;
  /** Save a paper to Drive the first time it is opened, not only when added. */
  syncOnOpen: boolean;
  /**
   * A proxy for arXiv and the PDFs — the Cloudflare Worker in `worker/`, or
   * any deployment of `server/api.js`. Empty falls back to whatever the build
   * was compiled with, which on a static host is nothing at all.
   */
  proxyBase: string;
  theme: 'light' | 'dark';
  /** Which view a paper opens in when both are available. */
  readingMode: ReadingMode;
  /**
   * Used for the OpenAlex and Crossref "polite pools" — which are faster and
   * more reliable than the anonymous ones — and required by Unpaywall. Left
   * empty, those calls are made anonymously and Unpaywall is skipped.
   */
  contactEmail: string;
  /** owner/repo the annotation layer is mirrored to. Empty disables it. */
  githubRepo: string;
  githubBranch: string;
  /**
   * A fine-grained personal access token, repository-scoped, Contents:
   * read/write. Held in this browser's localStorage — see Settings for what
   * that means.
   */
  githubToken: string;
  githubSync: boolean;
}

/** The PDF as the publisher set it, or the reflowed text you can highlight. */
export type ReadingMode = 'pdf' | 'reflow';

export interface GoogleUser {
  name: string;
  email: string;
  picture?: string;
}

export const HIGHLIGHT_COLORS: { id: HighlightColor; label: string; swatch: string }[] = [
  { id: 'yellow', label: 'Key claim', swatch: '#F6E27A' },
  { id: 'green', label: 'Method or result I trust', swatch: '#A9D6B8' },
  { id: 'blue', label: 'Definition or notation', swatch: '#9CC2E6' },
  { id: 'pink', label: 'Doubt or disagreement', swatch: '#EBB2B8' },
];

export const COLLECTION_COLORS = ['#1F5E52', '#8A4B2A', '#3B4B8C', '#6B3F6E', '#0F6070', '#7A5C13'];
