/**
 * Where a record came from. `books` is Open Library and the Internet Archive
 * together — books and texts no paper index keeps — and a PDF pasted in by
 * its link, which is a record of its own.
 */
export type SourceId = 'arxiv' | 'openalex' | 'semanticscholar' | 'crossref' | 'scholar' | 'books';

/**
 * The order a person's papers are listed in: newest first, which is how a
 * profile reads, or most cited first, which is how it is judged.
 */
export type PaperOrder = 'newest' | 'cited';

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
  /** Scholar's profile id, and the page it opens — Scholar records only. */
  scholarUserId?: string;
  scholarProfileUrl?: string;
  /** What Scholar lists under a name on their profile. */
  interests?: string[];
  /** `google.com` where Scholar says "Verified email at google.com". */
  verifiedEmail?: string;
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
  via: 'arxiv' | 'unpaywall' | 'openalex' | 'semanticscholar' | 'crossref' | 'pmc' | 'paper' | 'scholar';
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
  /**
   * Scholar's id for the group of copies this paper belongs to — what its
   * "All 84 versions" link points at, and the only way to ask for that list.
   */
  scholarCluster?: string;
  /** How many copies Scholar says there are. */
  scholarVersions?: number;
  /**
   * The entry on a Scholar profile this came from, as `<user>:<code>` — the
   * handle for its own page, which is where Scholar shows the file it found
   * for it and the cluster it belongs to. Only set for a profile's works,
   * which carry neither in the list.
   */
  scholarCitation?: string;
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
  /**
   * The copy of the paper picked by hand in the reader — its URL, one of the
   * paper's locations. Asked first the next time the paper opens, ahead of
   * the ranking, and never second-guessed for looking like a poster.
   */
  pdfChoice?: string;
  drive?: DriveRecord;
  github?: GitHubRecord;
}

/**
 * A paper taken out of the library, kept so that it can be put back: the
 * record as it was, its highlights, and what became of its copy in Drive.
 */
export interface JunkEntry {
  paper: Paper;
  highlights: Highlight[];
  removedAt: string;
  /** `junked`: its Drive folder went to the Junk folder there, and comes back out with it. */
  drive: 'junked' | 'not-in-drive' | 'not-connected' | 'kept';
}

export interface Collection {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  /**
   * Set on a collection that is a project: a piece of research with a
   * question, papers in roles, a to-do list and code of its own. Its papers
   * are the collection's — membership, not copies — so a paper can be in
   * several projects, and Drive keeps a project as it keeps any collection.
   */
  project?: ProjectInfo;
}

/** What a paper is to a project. */
export type PaperRole = 'core' | 'baseline' | 'method' | 'related';

export interface ProjectTodo {
  id: string;
  text: string;
  done: boolean;
}

export interface ProjectInfo {
  /** The question the project is asking, in a sentence; may be empty. */
  question: string;
  startedAt: string;
  /** A paper's role here, by paper id; a paper with none is unsorted. */
  roles: Record<string, PaperRole>;
  /** The playground that holds the project's code, once it has some. */
  playgroundId?: string;
  todos: ProjectTodo[];
  /** The Overleaf project the work is being written up in, once linked. */
  overleaf?: OverleafLink;
}

/**
 * A project's paper, being written in Overleaf. Overleaf has no API of its
 * own, so the link is all the page has of it — unless the paper is also in
 * a GitHub repository (Overleaf's GitHub sync), which the page can read and
 * write with the GitHub token from Settings.
 */
export interface OverleafLink {
  /** The project's address in Overleaf, as it opens there. */
  url: string;
  /** owner/repo that Overleaf syncs the paper with, if it does. */
  repo?: string;
  /** Its branch; main when empty. */
  branch?: string;
  /** The folder in the repository the paper is in; the top when empty. */
  folder?: string;
}

/**
 * The three ways into projects: every project side by side, one project's
 * overview, or its workspace — a paper beside its code.
 */
export type ProjectView = 'board' | 'overview' | 'workspace';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/** A passage painted over, or a line drawn under it. */
export type HighlightStyle = 'highlight' | 'underline';

/**
 * A W3C-Web-Annotation-shaped text quote selector. `hint` is only used to
 * break ties between identical quotes — never as the primary anchor.
 */
export interface Highlight {
  id: string;
  paperId: string;
  color: HighlightColor;
  /** Absent on highlights made before underlining was offered: they are highlights. */
  style?: HighlightStyle;
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
  /**
   * The proxy's token, when it has one: what lets this browser drive the
   * browser inside the reader, keep a sign-in and ask Scholar through the
   * proxy's SerpApi account. Set on the proxy as READER_TOKEN; sent only
   * to the proxy, as a header.
   */
  proxyToken: string;
  theme: 'light' | 'dark';
  /**
   * The glass material: the window's panes turn into frosted, nearly clear
   * sheets over a soft wash of colour, in either theme. Off, every surface is
   * the solid paper it has always been.
   */
  glass: boolean;
  /** How frosted the glass is, 0 (as clear as stays readable) to 1 (milky). */
  glassFrost: number;
  /** What is behind the glass. */
  glassWall: GlassWall;
  /**
   * How strongly the glass catches the light that follows the pointer: 0 turns
   * it off, 1 is the standard sheen, 2 twice as bright.
   */
  glassLight: number;
  /**
   * How solid Explain's page is over the paper behind it, 0.2 (mostly see-through)
   * to 1 (opaque). `null` leaves it to the material: opaque paper when solid,
   * frosted when glass.
   */
  explainOpacity: number | null;
  /** Which view a paper opens in when both are available. */
  readingMode: ReadingMode;
  /**
   * How the app's navigation is laid out (src/components/Nav.tsx): pages and
   * the panels beside them told apart in different ways, or the one rail of
   * icons it had before.
   */
  navStyle: NavStyle;
  /** How the projects are reached from the rail (not the sidebar, which names them all, or the classic rail). */
  projectNav: ProjectNav;
  /** Where a project's paper is written with Overleaf: OVERLEAF_VIEWS. */
  overleafView: OverleafView;
  /** What a project opens on from the rail and the board: its overview, or its workspace. */
  projectOpensOn: Exclude<ProjectView, 'board'>;
  /**
   * What falls over the page when a side pane is brought out in zen mode: a
   * shadow cast from the pane, a frosted mist, or a glow in the accent colour.
   */
  zenHaze: ZenHaze;
  /** How a passage Ask Claude points at is marked on the page. */
  passageLook: PassageLook;
  /** How bold words and links to passages are marked in Ask Claude's answers; `auto` suits each theme. */
  chatMarks: ChatMarks;
  /** How playgrounds that are running, or can be picked back up, are shown around the app — any of them, or none. */
  runningShows: RunningShows;
  /** What the Playground shows of a project whose code is on another computer — any of them, or none. */
  awayShows: AwayShows;
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

/**
 * The ways running playgrounds are shown, each on or off:
 * - shelf: on the Playground's home, a "Running now" shelf, and each playground's state in the list;
 * - dock: on every page, a count on the rail's Playground button, a dock of what runs, and a toast when one ends;
 * - switcher: P opens a switcher, running first, instead of going straight to the Playground;
 * - tabs: the playgrounds opened in this tab, as tabs across the top of every page;
 * - peek: on a paper's page, the live cells of a playground that cites it, at the side, to run there.
 */
export interface RunningShows {
  shelf: boolean;
  dock: boolean;
  switcher: boolean;
  tabs: boolean;
  peek: boolean;
}

/**
 * The ways a project whose code is on another computer is shown, each on or off (src/lib/away.ts):
 * - group: the Playground's list grouped by where each project's code is, with a filter for what opens here;
 * - card: in the editor's place, which computer has the code, when it was seen, and what to do;
 * - snapshot: a read-only copy of the code kept in Drive by the computer that has it, to open elsewhere;
 * - bring: copy the project here, or move it to Drive so it opens on every computer.
 */
export interface AwayShows {
  group: boolean;
  card: boolean;
  snapshot: boolean;
  bring: boolean;
}

export type GlassWall = 'spotlight' | 'sage' | 'paper' | 'mist' | 'graphite' | 'lavender' | 'dusk' | 'ocean' | 'spectrum';

/**
 * The wallpapers, calmest first: the order is how little each pulls the eye
 * from the page — measured as the colourfulness of what is round the page
 * (Hasler & Süsstrunk's metric) over a reading screen in both themes.
 */
export const GLASS_WALLS: { id: GlassWall; label: string; note: string }[] = [
  { id: 'spotlight', label: 'Spotlight', note: 'Warm paper, the edges dimmed and the page lit. The calmest to read in.' },
  { id: 'sage', label: 'Sage', note: 'The accent green, washed out. Calm, with a little colour.' },
  { id: 'paper', label: 'Paper', note: 'Cream and tan, like a desk under a book.' },
  { id: 'mist', label: 'Mist', note: 'Cool blue-grey, barely any colour.' },
  { id: 'graphite', label: 'Graphite', note: 'Neutral grey, no hue at all. Calmest in light, but flat.' },
  { id: 'lavender', label: 'Lavender', note: 'Soft violet and rose.' },
  { id: 'dusk', label: 'Dusk', note: 'Peach and amber, like evening light.' },
  { id: 'ocean', label: 'Ocean', note: 'Blue and teal, the most saturated.' },
  { id: 'spectrum', label: 'Spectrum', note: 'The accent and the four highlight colours. The liveliest, and the busiest.' },
];

/**
 * - labelled: a rail of named pages; the panels are switches in a bar at the top of the page;
 * - zones: one rail, the pages at the top and the panels in a tray at the bottom;
 * - sidebar: a wide sidebar, pages as a list (projects under Projects) and panels as switches;
 * - edge: a rail of pages; the panels are tabs on the page's right edge;
 * - classic: the one rail of icons, pages and panels alike.
 */
export type NavStyle = 'labelled' | 'zones' | 'sidebar' | 'edge' | 'classic';

export const NAV_STYLES: { id: NavStyle; label: string; note: string }[] = [
  { id: 'labelled', label: 'Labelled', note: 'A rail of named pages. Library, Discover, Notes and Ask AI are switches at the top of the page.' },
  { id: 'zones', label: 'Two zones', note: 'One narrow rail: pages at the top, the panels in a tray at the bottom.' },
  { id: 'sidebar', label: 'Sidebar', note: 'A wide sidebar: pages by name with your projects under Projects, the panels as switches. Folds to a narrow rail.' },
  { id: 'edge', label: 'Edge tabs', note: 'A rail of pages; the panels are tabs on the right edge of the page, pulled out like drawers.' },
  { id: 'classic', label: 'Classic', note: 'The one rail of icons as it was: pages and panels side by side.' },
];

/**
 * - switcher: a tile under the brand naming the project you are in, opening a list of the others;
 * - menu: one Projects item with a count, opening a menu of every project by name;
 * - current: under Projects, only the project you are in (or were in last), named;
 * - dots: a row of colour dots under Projects;
 * - folder: Projects opens and folds a list of named projects in place;
 * - marks: a mark for each project, stacked under Projects.
 */
export type ProjectNav = 'switcher' | 'menu' | 'current' | 'dots' | 'folder' | 'marks';

export const PROJECT_NAVS: { id: ProjectNav; label: string; note: string }[] = [
  { id: 'switcher', label: 'Switcher at the top', note: 'A tile under the R shows the project you are in, by name. Click it for the others.' },
  { id: 'menu', label: 'Menu from Projects', note: 'One Projects item with a count; it opens a menu of every project by name.' },
  { id: 'current', label: 'Just the current one', note: 'Under Projects, only the project you are in, or were in last, with its name.' },
  { id: 'dots', label: 'Colour dots', note: 'A row of small dots under Projects, one a project; hover one for its name.' },
  { id: 'folder', label: 'Opens like a folder', note: 'Projects opens a list of your projects by name right in the rail, and folds it again.' },
  { id: 'marks', label: 'Stacked marks', note: 'A lettered mark for each project, stacked under Projects.' },
];

/**
 * Where a project's paper is written, once it is linked to Overleaf. The
 * overview has the paper's card in every one of them.
 * - beside: Overleaf in a window of its own, beside the reader, with the cite keys and BibTeX a click away;
 * - write: a Write layout in the workspace, the paper being read beside the .tex files;
 * - dock: a Draft tab in the dock, beside whatever paper is open;
 * - overview: the card on the overview and nothing else; Overleaf opens in a tab.
 */
export type OverleafView = 'beside' | 'write' | 'dock' | 'overview';

export const OVERLEAF_VIEWS: { id: OverleafView; label: string; note: string }[] = [
  { id: 'beside', label: 'Overleaf beside', note: 'Overleaf opens in a window beside the reader; cite keys and BibTeX are a click away. Works on any Overleaf plan.' },
  { id: 'write', label: 'Write in the workspace', note: 'The workspace gets a Write layout: the paper you read beside the .tex files, \\cite from the project’s papers.' },
  { id: 'dock', label: 'Draft in the dock', note: 'A Draft tab beside Discover and Notes, next to whatever paper is open: cite it or quote it into the draft.' },
  { id: 'overview', label: 'Just the overview', note: 'Only the paper’s card on the overview — sections, what is cited, what is read and not. Overleaf opens in a tab.' },
];

/** The PDF as the publisher set it, or the reflowed text you can highlight. */
export type ReadingMode = 'pdf' | 'reflow';

export type ZenHaze = 'shadow' | 'mist' | 'glow';

export type PassageLook = 'marker' | 'spotlight' | 'outline';

export type ChatMarks = 'auto' | 'fill' | 'glow' | 'underline' | 'tint' | 'outline';

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
