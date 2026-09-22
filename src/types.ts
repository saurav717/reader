export type SourceId = 'arxiv' | 'openalex' | 'semanticscholar';

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
}

export interface DriveRecord {
  folderId?: string;
  pdfFileId?: string;
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

export interface Settings {
  googleClientId: string;
  driveFolderName: string;
  autoSync: boolean;
  savePdf: boolean;
  theme: 'light' | 'dark';
}

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
