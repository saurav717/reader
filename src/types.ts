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
  /** How the paper is cited: its key, and the BibTeX entries found for it (src/lib/citeRecord.ts). */
  citation?: CitationRecord;
}

/**
 * Where a BibTeX entry for a paper came from. `crossref` is the publisher's
 * record by DOI, `acl` the ACL Anthology's, `openreview` the venue's own,
 * `dblp` the CS bibliography's, `arxiv` the preprint's own export,
 * `datacite` the DOI registry's record of the preprint, `semanticscholar`
 * its index's, `pasted` one put in by hand, and `generated` the one made
 * here from the paper's record — kept only for a paper no source had.
 */
export type CitationSource = 'crossref' | 'acl' | 'openreview' | 'dblp' | 'arxiv' | 'datacite' | 'semanticscholar' | 'pasted' | 'generated';

/** One BibTeX entry for a paper, tagged by where it came from. */
export interface CitationVariant {
  source: CitationSource;
  bibtex: string;
  fetchedAt: string;
  /** What it was fetched by: the DOI, the arXiv id, dblp's key. */
  of?: string;
  /** Where it was fetched from, as evidence: the address that answered. */
  url?: string;
}

/**
 * What the library keeps of how a paper is cited. The entries are kept as
 * variants, each by source, so the one a draft takes is a choice — made
 * per paper here, or by Settings → Citations for every paper — and never
 * a fetch at the moment of citing.
 */
export interface CitationRecord {
  /** The cite key the paper goes by in every project; absent, the key style in Settings makes one. */
  key?: string;
  /** The variant to use, by source; absent, the preference in Settings picks. */
  chosen?: CitationSource;
  variants: CitationVariant[];
  /** The DOI of the published version of a preprint, where an index links them. */
  publishedDoi?: string;
  /** Where the published version is: `JMLR 23 (2022)`. */
  publishedIn?: string;
  /** When the indexes were last asked. */
  lookedAt?: string;
  /** What the last look said when it found nothing: a network error, say. */
  error?: string;
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
  /** The GitHub repository the project's code is pushed to, once set up from the workspace. */
  codeRepo?: CodeRepo;
  /** The meetings tagged with this project on the Calendar page, by the key the page tags them under (lib/calendar.ts, `tagKeys`). */
  meetings?: Record<string, MeetingTag>;
  /** Shared with the people you work with: the room on the Worker that holds its members and where each is (docs/live-collaboration.md). */
  shared?: SharedWith;
}

/** A project's room, as each member's copy of the project points at it. */
export interface SharedWith {
  /** The room's id on the Worker (worker/projectRoom.js). */
  room: string;
  /** The owner's Google email: whose project it is. */
  owner: string;
  /** This account's part in it. */
  role: 'owner' | 'editor' | 'viewer';
}

/** A meeting on the Calendar page tagged as a project's: its title when it was tagged, for the project's own record. */
export interface MeetingTag {
  title: string;
  taggedAt: string;
}

/** Where a project's code goes on GitHub: one commit of its files each time Sync to GitHub is pressed. */
export interface CodeRepo {
  /** owner/name. */
  repo: string;
  branch: string;
  /** The last push: when, its commit, how many files. */
  pushedAt?: string;
  commit?: string;
  files?: number;
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
  /**
   * The paper's folder on each computer, by its Companion's id, for the Write
   * tab: a clone of Overleaf's Git (or a GitHub repository), or a folder
   * Dropbox keeps in step with Overleaf.
   */
  folders?: Record<string, PaperFolder>;
  /** The compiler, as the Overleaf project is set to (Menu → Compiler): pdfLaTeX when unset, as in Overleaf. */
  compiler?: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';
  /** The main document, as Overleaf's Menu → Main document: the file with \documentclass when unset. */
  main?: string;
  /**
   * The paper kept in Google Drive rather than on any computer: its folder
   * under Papers_collection/ (Projects/<project>-<id>/LaTeX). Edited in the
   * browser, compiled on Cloud Run, synced with Overleaf by Reader's server.
   * Set, it wins over `folders` unless `keep` says the computers.
   */
  drive?: { folder: string };
  /**
   * Where the paper is kept, as last chosen for the project, and when: Google
   * Drive (the default, also when unset), or a folder on each computer — a
   * clone of the Overleaf project there. The newest choice wins on every device.
   */
  keep?: { where: 'drive' | 'computer'; at: string };
  /** The Overleaf account (connected to Reader's server) the project last synced with: tried first. */
  gitAccount?: string;
  /**
   * The folders of the Overleaf projects this one was linked to before, by
   * their address: switching back to one opens its folder again, with what
   * changed in Overleaf meanwhile taken in, rather than cloning it afresh.
   */
  earlier?: Record<string, Record<string, PaperFolder>>;
  /**
   * The LaTeX projects in the paper's Drive folder that have an Overleaf link of
   * their own, by their folder there ('sub/dir'): each one its own Overleaf
   * project, or none (url ''). A folder with no entry is part of the nearest
   * one above it that has one, or of the top's (this link's own url) — so a
   * folder that came in from Overleaf stays in that Overleaf project.
   */
  latex?: Record<string, LatexLink>;
}

/** A LaTeX project's own Overleaf link: '' when it is kept off Overleaf. Paths are relative to its folder. */
export interface LatexLink {
  url: string;
  gitAccount?: string;
  main?: string;
  compiler?: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';
}

export interface PaperFolder {
  /** Relative to the Companion's folder (~/Reader): papers/loss-free-routing, linked/Overleaf-paper. */
  path: string;
  /** git: synced from here (Overleaf's Git or GitHub); dropbox: Dropbox syncs it; folder: not synced. */
  sync: 'git' | 'dropbox' | 'folder' | 'drive';
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
  /** `system` follows the operating system between light and dark; `koios` is the night, a theme of its own. */
  theme: 'light' | 'dark' | 'system' | 'koios';
  /** Set once the theme has been picked by hand; until then it follows the site's look (lib/store.tsx, readSettings). */
  themeChosen?: boolean;
  /** Under Koios: a faint sky, the glow and a few stars, behind the pages. Off, the ground is plain slate. */
  koiosSky?: boolean;
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
  /** Where compute is turned on and off: COMPUTE_CONTROLS. */
  computeControls: ComputeControls;
  /**
   * The places to run code that are turned off: 'colab', or a server's
   * Companion id (its id in this browser when it has none). Off is not
   * removed — it is left out of every choice of where to run, until turned on.
   */
  computeOff: string[];
  /** Where a project's paper is written with Overleaf: OVERLEAF_VIEWS. */
  overleafView: OverleafView;
  /** How the Write tab compiles, lays out, syncs and cites: WRITE_OPTIONS. */
  write: WriteOptions;
  /** How papers are cited everywhere: which entry, which key, the Write tab's helper: CITATION_OPTIONS. */
  citations: CitationOptions;
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
  /** The person's own Zoom room (zoom.us/my/…, or a standing meeting's link): "Use my room" in the Calendar's editor. */
  zoomRoom: string;
  /**
   * A Granola API key (Granola → Settings → API): what reads back the notes of
   * meetings Granola took, to file them with their project (src/lib/granola.ts).
   * Held in this browser, sent only to the proxy, which passes it to Granola.
   */
  granolaKey: string;
  /** In the Reader app: start taking notes by itself when a meeting set to Reader notes opens (src/lib/notetaker.ts). */
  notesAuto: boolean;
  /** In the Reader app: offer to take notes of any other meeting found on the computer. */
  notesOffer: boolean;
  /**
   * In the Reader app, how a meeting joined from the calendar is recorded: `app` finds the meeting's window (Zoom, Meet in
   * Chrome, Teams, Slack) and knows who spoke, falling back to the computer's sound when none is found; `computer` records the
   * computer's sound and the microphone from the start, whatever app or browser the call is in.
   */
  notesSource: 'app' | 'computer';
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
 * Where compute — Colab, your computers, servers you added — is turned on and
 * off. Settings → Compute has it in every one of them.
 * - everywhere: Settings, a switch on each place to run where code is set up, and a chip in the rail with what runs;
 * - settings: Settings → Compute alone;
 * - cards: Settings, and the switches where code is set up;
 * - rail: Settings, and the chip in the rail.
 */
export type ComputeControls = 'everywhere' | 'settings' | 'cards' | 'rail';

export const COMPUTE_CONTROLS: { id: ComputeControls; label: string; note: string }[] = [
  { id: 'everywhere', label: 'Everywhere', note: 'Settings → Compute, a switch on each place to run where a project’s code is set up, and a chip in the rail that lights while Colab runs.' },
  { id: 'settings', label: 'Only in Settings', note: 'Everything in Settings → Compute, and nothing anywhere else.' },
  { id: 'cards', label: 'Settings and the cards', note: 'Settings, and the switches where you choose where code runs. No chip in the rail.' },
  { id: 'rail', label: 'Settings and the rail', note: 'Settings, and the chip in the rail with what runs and Stop. No switches on the cards.' },
];

/**
 * Where a project's paper is written, once it is linked to Overleaf. The
 * overview has the paper's card in every one of them.
 * - tab: a Write tab on the project, the whole page an editor with the compiled PDF beside it;
 * - beside: Overleaf in a window of its own, beside the reader, with the cite keys and BibTeX a click away;
 * - write: a Write layout in the workspace, the paper being read beside the .tex files;
 * - dock: a Draft tab in the dock, beside whatever paper is open;
 * - overview: the card on the overview and nothing else; Overleaf opens in a tab.
 */
export type OverleafView = 'tab' | 'beside' | 'write' | 'dock' | 'overview';

export const OVERLEAF_VIEWS: { id: OverleafView; label: string; note: string }[] = [
  { id: 'tab', label: 'Just the Write tab', note: 'The paper card’s Continue writing opens the Write tab where you left off: the files, the LaTeX and its PDF. Synced with Overleaf when you link one.' },
  { id: 'beside', label: 'Write tab + Overleaf beside', note: 'As the Write tab, and Open in Overleaf puts Overleaf in a window beside the reader, cite keys and BibTeX a click away.' },
  { id: 'write', label: 'Write tab + the workspace', note: 'As the Write tab, and the workspace gets a Write layout: the paper you read beside the .tex files (needs Overleaf’s GitHub sync).' },
  { id: 'dock', label: 'Write tab + the dock', note: 'As the Write tab, and a Draft tab beside Discover and Notes, next to whatever paper is open (needs Overleaf’s GitHub sync).' },
  { id: 'overview', label: 'Write tab + Overleaf in a tab', note: 'As the Write tab, and Open in Overleaf opens it in a new browser tab.' },
];

export interface WriteOptions {
  /** When the PDF is made again: after a pause in typing, on ⌘S, or with Recompile only. */
  compile: 'pause' | 'save' | 'manual';
  /** What makes it: latexmk when TeX is installed else Tectonic, or one of the two. */
  engine: 'auto' | 'latexmk' | 'tectonic';
  /** Where the PDF is: beside the source, under it, or a tab of its own. */
  layout: 'side' | 'stacked' | 'tabs';
  /** When edits go to Overleaf (with Git): seconds after a pause, on ⌘S, or with Sync only. */
  sync: 'pause' | 'save' | 'manual';
  /** A drawer of the project's papers to cite, or none. */
  citations: 'drawer' | 'off';
  /** On an error: keep going, as Overleaf does, or stop at the first (Overleaf's "Stop on first error"). */
  errors: 'continue' | 'halt';
  /** Where the PDF is made: on this computer, by Reader's compiler on GitHub Actions or Cloud Run, or by Overleaf (the PDF is in Overleaf's window). */
  pdf: 'here' | 'github' | 'cloudrun' | 'overleaf';
}

export const WRITE_DEFAULTS: WriteOptions = { compile: 'pause', engine: 'auto', layout: 'side', sync: 'pause', citations: 'drawer', errors: 'continue', pdf: 'here' };

/** Each of the Write tab's choices, the default first. */
export const WRITE_OPTIONS: { key: keyof WriteOptions; label: string; choices: { id: string; label: string; note: string }[] }[] = [
  {
    key: 'pdf',
    label: 'Compile on',
    choices: [
      { id: 'here', label: 'This computer', note: 'The Companion compiles it with the TeX installed here, and the PDF is beside the source.' },
      { id: 'github', label: 'GitHub Actions', note: 'Reader’s own compiler, not a sync: GitHub Actions compiles it with all of TeX Live and the PDF comes back here, in a minute or two. Nothing to install or set up; the files are never kept.' },
      { id: 'cloudrun', label: 'Cloud Run', note: 'Reader’s own compiler on Google Cloud Run, with all of TeX Live: the PDF comes back here in seconds once it is warm. Nothing to install or set up; the files are never kept.' },
      { id: 'overleaf', label: 'By Overleaf', note: 'Nothing to install: edits go to Overleaf a moment after you stop typing, and the PDF is in Overleaf’s window, beside.' },
    ],
  },
  {
    key: 'compile',
    label: 'Compile',
    choices: [
      { id: 'pause', label: 'As you type', note: 'A second after you stop typing, as Overleaf’s auto-compile does.' },
      { id: 'save', label: 'On save', note: 'When you press ⌘S.' },
      { id: 'manual', label: 'By hand', note: 'Only with Recompile.' },
    ],
  },
  {
    key: 'errors',
    label: 'On an error',
    choices: [
      { id: 'continue', label: 'Keep going', note: 'As Overleaf does: the PDF is made as far as TeX can, and the errors are listed.' },
      { id: 'halt', label: 'Stop at the first', note: 'Overleaf’s “Stop on first error”: no PDF until it is fixed.' },
    ],
  },
  {
    key: 'engine',
    label: 'TeX',
    choices: [
      { id: 'auto', label: 'Whichever is here', note: 'latexmk when TeX Live or MacTeX is installed, else Tectonic.' },
      { id: 'latexmk', label: 'latexmk', note: 'Your TeX installation, run as Overleaf runs it, with the project’s compiler and main document.' },
      { id: 'tectonic', label: 'Tectonic', note: 'One small program that fetches the packages a paper uses; the Companion can download it. Always XeLaTeX, so not quite Overleaf’s pdfLaTeX.' },
    ],
  },
  {
    key: 'layout',
    label: 'The PDF',
    choices: [
      { id: 'side', label: 'Beside the source', note: 'Source on the left, PDF on the right, as in Overleaf.' },
      { id: 'stacked', label: 'Under the source', note: 'For a tall, narrow window.' },
      { id: 'tabs', label: 'A tab of its own', note: 'Source or PDF, one at a time, full width.' },
    ],
  },
  {
    key: 'sync',
    label: 'Sync with Overleaf',
    choices: [
      { id: 'pause', label: 'As you type', note: 'A few seconds after you stop: Overleaf shows it, and what coauthors wrote comes in.' },
      { id: 'save', label: 'On save', note: 'When you press ⌘S.' },
      { id: 'manual', label: 'By hand', note: 'Only with Sync.' },
    ],
  },
  {
    key: 'citations',
    label: 'Citations',
    choices: [
      { id: 'drawer', label: 'A drawer of papers', note: 'The project’s papers on the left, under the files: click one to \\cite it, with its BibTeX added.' },
      { id: 'off', label: 'None', note: 'Just the files.' },
    ],
  },
];

/**
 * How papers are cited, everywhere a citation is made: the mirror's
 * references.bib, a draft's .bib, Copy citation, the Write tab's helper.
 */
export interface CitationOptions {
  /** Which BibTeX entry a draft takes: the official one where there is one, dblp's, or the one made from the record. */
  prefer: 'official' | 'dblp' | 'generated';
  /** How a cite key is made: lecun2015deep, lecun:2015:deep, Lecun2015, or dblp's own key where there is one. */
  keyStyle: 'scholar' | 'colon' | 'authorYear' | 'dblp';
  /** The Write tab's helper: a card as the caret rests at a sentence end, only when asked (⌘⇧C, \cite{?}), or none. */
  helper: 'auto' | 'ask' | 'off';
  /** Sentences that read like claims with no \cite nearby: counted at the foot of the Write tab, or left alone. */
  claims: 'count' | 'off';
  /** A preprint whose published version an index knows: switch its entry as it is found, say so and wait, or keep the preprint. */
  published: 'ask' | 'switch' | 'keep';
  /** When the official entries are looked for: as a paper is added, or only when asked. */
  fetch: 'auto' | 'manual';
  /** What Copy citation copies with one click. */
  copy: 'bibtex' | 'biblatex' | 'ris' | 'apa' | 'ieee' | 'chicago' | 'markdown';
}

export const CITATION_DEFAULTS: CitationOptions = { prefer: 'official', keyStyle: 'scholar', helper: 'auto', claims: 'count', published: 'ask', fetch: 'auto', copy: 'bibtex' };

/** Each of the citation choices, the default first. */
export const CITATION_OPTIONS: { key: keyof CitationOptions; label: string; choices: { id: string; label: string; note: string }[] }[] = [
  {
    key: 'prefer',
    label: 'The entry a draft takes',
    choices: [
      { id: 'official', label: 'The official one', note: 'Fetched from the source that publishes it: the publisher’s record by DOI (Crossref), the ACL Anthology’s, OpenReview’s, dblp’s, arXiv’s own export, DataCite’s, Semantic Scholar’s — in that order. One is made here only for a paper no source had.' },
      { id: 'dblp', label: 'dblp first', note: 'dblp’s entry where it has one — the form most CS papers cite — then the official order.' },
      { id: 'generated', label: 'Made from the record', note: 'Always the entry made here from the paper’s title, authors, year and venue, even when a source has one. For a bibliography you keep uniform by hand.' },
    ],
  },
  {
    key: 'keyStyle',
    label: 'Cite keys',
    choices: [
      { id: 'scholar', label: 'lecun2015deep', note: 'Google Scholar’s: first author, year, first long word of the title.' },
      { id: 'colon', label: 'lecun:2015:deep', note: 'The same three, with colons.' },
      { id: 'authorYear', label: 'Lecun2015', note: 'Author and year, a letter added when two collide.' },
      { id: 'dblp', label: 'dblp’s own', note: 'DBLP:conf/nips/Vaswani17 where dblp has the paper; Scholar’s otherwise.' },
    ],
  },
  {
    key: 'helper',
    label: 'The Write tab’s helper',
    choices: [
      { id: 'auto', label: 'As you write', note: 'When the caret rests at the end of a sentence, a card names the project’s papers that fit it — your highlights first. ↵ cites one.' },
      { id: 'ask', label: 'When asked', note: 'Only on ⌘⇧C, or inside \\cite{?}.' },
      { id: 'off', label: 'None', note: 'Just \\cite{ completion.' },
    ],
  },
  {
    key: 'claims',
    label: 'Claims without a citation',
    choices: [
      { id: 'count', label: 'Counted', note: 'Sentences that read like claims (“has been shown”, “state of the art”, a number) with no \\cite nearby, counted at the foot of the Write tab; click for each.' },
      { id: 'off', label: 'Left alone', note: 'Nothing is counted.' },
    ],
  },
  {
    key: 'published',
    label: 'A preprint since published',
    choices: [
      { id: 'ask', label: 'Say so', note: 'The drawer and the bibliography flag it, with Switch. The entry stays the preprint’s until you switch.' },
      { id: 'switch', label: 'Switch to it', note: 'The published version’s entry is used as soon as it is found, under the same key.' },
      { id: 'keep', label: 'Keep the preprint', note: 'Nothing is flagged.' },
    ],
  },
  {
    key: 'fetch',
    label: 'Official entries',
    choices: [
      { id: 'auto', label: 'Fetched as a paper is added', note: 'arXiv, Crossref, the ACL Anthology, OpenReview, dblp, DataCite and Semantic Scholar are asked once, and every answer kept with the paper.' },
      { id: 'manual', label: 'Only when asked', note: 'Fetch official citations in the bibliography, or on the drawer.' },
    ],
  },
  {
    key: 'copy',
    label: 'Copy citation copies',
    choices: [
      { id: 'bibtex', label: 'BibTeX', note: 'The entry a draft takes.' },
      { id: 'biblatex', label: 'BibLaTeX', note: 'The same, as biblatex writes it.' },
      { id: 'ris', label: 'RIS', note: 'For Zotero, Mendeley, EndNote.' },
      { id: 'apa', label: 'APA 7', note: 'Text.' },
      { id: 'ieee', label: 'IEEE', note: 'Text.' },
      { id: 'chicago', label: 'Chicago', note: 'Text.' },
      { id: 'markdown', label: 'Markdown link', note: 'For notes.' },
    ],
  },
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
