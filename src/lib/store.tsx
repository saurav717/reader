import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Collection, GoogleUser, Highlight, HighlightColor, JunkEntry, Paper, PaperRef, Settings } from '../types';
import { COLLECTION_COLORS, WRITE_DEFAULTS } from '../types';
import { forgetNotes } from './notes';
import { db, switchDb } from './db';
import {
  emptyLibrary,
  libraryMark,
  mergeLibraries,
  readLibraryFromDrive,
  rebuildFromSidecars,
  serialise,
  visibleInDrive,
  writeLibraryToDrive,
  LIBRARY_FILE,
  type Library,
  type RemoteMark,
} from './driveLibrary';
import { tidyByline } from './byline';
import { ROOT_FOLDER, driveFolderUrl, isInDrive, junkPaperInDrive, restorePaperInDrive, syncPaperToDrive } from './driveSync';
import { FINISHED_AT, type ReadingStatus } from './status';
import { pathFor, syncPapersToGitHub, targetFrom } from './github';
import { setContactEmail } from './contact';
import { isPass, passEmail, passExpires, passForGoogle, proxyHealth, setProxyBase, setProxyToken, SignInRefused } from './api';
import * as google from './google';

const SETTINGS_KEY = 'reader.settings';
/**
 * That Drive was connected once, which is all a page with no backend may
 * remember for long: the token itself lives in `sessionStorage`, so it
 * outlasts a reload but not the tab. It is what lets a return visit in a new
 * tab offer to reconnect, and reconnect without asking for consent a second
 * time.
 */
const DRIVE_KEY = 'reader.drive.connected';
/**
 * The account that first signed in on this browser once libraries were tied
 * to accounts. What the browser still held from before then, and could not be
 * shown to be another account's, is offered to this account and no other.
 */
const GUEST_CLAIM_KEY = 'reader.guest.claimedBy';

/** Kept beside an account's copy of its library: where library.json is, and whether a change here has not reached it yet. */
const REMOTE_KEY = 'library:remote';
const DIRTY_KEY = 'library:dirty';
/** How long the library waits after a change before it is written to Drive. */
const LIBRARY_DEBOUNCE_MS = 1500;

/** The account a Google user's library belongs to, as the database is named. */
const accountOf = (user: GoogleUser | null | undefined) => user?.email?.trim().toLowerCase() || null;

const defaultSettings: Settings = {
  googleClientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '',
  driveFolderName: ROOT_FOLDER,
  autoSync: true,
  savePdf: true,
  syncOnOpen: true,
  proxyBase: '',
  proxyToken: '',
  theme: 'light',
  glass: false,
  glassFrost: 0.5,
  glassWall: 'spotlight',
  glassLight: 1,
  explainOpacity: null,
  readingMode: 'pdf',
  projectOpensOn: 'overview',
  navStyle: 'labelled',
  projectNav: 'switcher',
  overleafView: 'tab',
  write: WRITE_DEFAULTS,
  computeControls: 'everywhere',
  computeOff: [],
  zenHaze: 'shadow',
  passageLook: 'marker',
  chatMarks: 'auto',
  runningShows: { shelf: true, dock: true, switcher: false, tabs: false, peek: false },
  awayShows: { group: true, card: true, snapshot: false, bring: true },
  contactEmail: '',
  githubRepo: '',
  githubBranch: 'main',
  githubToken: '',
  githubSync: false,
};

/**
 * How long a change waits before it is pushed. Highlighting a paragraph is a
 * dozen state changes in a few seconds; without this they would be a dozen
 * commits saying nothing.
 */
const GITHUB_DEBOUNCE_MS = 8000;

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const stored = JSON.parse(raw) as Partial<Settings>;
    const saved = { ...defaultSettings, ...stored };
    // Anyone who opened the app before it had a client ID compiled in has an
    // empty one saved, which would otherwise shadow the new default forever.
    // An empty string here means "not set", not "deliberately blank".
    if (!saved.googleClientId) saved.googleClientId = defaultSettings.googleClientId;
    // Saved before a choice was added to it: the new choice starts at its default.
    saved.runningShows = { ...defaultSettings.runningShows, ...saved.runningShows };
    saved.awayShows = { ...defaultSettings.awayShows, ...saved.awayShows };
    // Settings from before the Write tab: Overleaf beside was only the default then, and the Write tab is now.
    if (!stored.write && stored.overleafView === 'beside') saved.overleafView = 'tab';
    saved.write = { ...defaultSettings.write, ...(stored.write && typeof stored.write === 'object' ? stored.write : {}) };
    return saved;
  } catch {
    return defaultSettings;
  }
}

export type SyncState = 'idle' | 'queued' | 'running' | 'done' | 'error';

export interface SyncEntry {
  paperId: string;
  state: SyncState;
  message?: string;
  at: string;
}

/**
 * How one paper's trip to Drive ended, for a caller that waited on it.
 * `done` may still carry a message: the sidecar went up but the PDF did not,
 * and the message says why — which is the one thing a caller that just
 * pressed "add" needs to be able to show.
 */
export interface SyncOutcome {
  state: 'done' | 'error' | 'skipped';
  message?: string;
}

/**
 * What removing a paper did about its copy in Drive. `kept` is the one the
 * caller asked for — remove the entry, leave Drive alone — or the one Drive
 * forced, by not being connected.
 */
/** Where the library stands with the copy in Drive. */
export interface LibrarySync {
  state: 'local' | 'loading' | 'saving' | 'saved' | 'error';
  message?: string;
  at?: string;
}

export interface RemoveOutcome {
  drive: 'junked' | 'not-in-drive' | 'not-connected' | 'kept';
  junkFolderLink?: string;
}

interface StoreValue {
  ready: boolean;
  papers: Paper[];
  collections: Collection[];
  highlights: Highlight[];
  settings: Settings;
  user: GoogleUser | null;
  driveConnected: boolean;
  authError: string | null;
  syncLog: SyncEntry[];
  /** How the library itself — library.json in the account's Drive — stands. */
  librarySync: LibrarySync;
  /**
   * Papers this browser kept from before libraries were tied to an account,
   * that could not be shown to be this account's. Offered to the first
   * account to sign in here, and to no other.
   */
  strays: number;
  adoptStrays: () => Promise<void>;
  discardStrays: () => Promise<void>;

  /**
   * `sync: false` for a caller that is going to put the paper in Drive itself
   * — without it the automatic sync starts fetching the same PDF in parallel,
   * and the paper comes down the wire twice.
   */
  addPaper: (ref: PaperRef, collectionId?: string, options?: { sync?: boolean }) => Promise<Paper>;
  /**
   * Takes the paper out of the library, highlights and all, and — unless
   * `junkInDrive` is false — moves its copy in Drive to the Junk folder first.
   * Drive refusing the move is thrown, and the paper stays in the library:
   * the entry is the only record of where the files are, so it must not go
   * until they have.
   */
  removePaper: (id: string, options?: { junkInDrive?: boolean }) => Promise<RemoveOutcome>;
  setPaperCollections: (id: string, collectionIds: string[]) => Promise<void>;
  /**
   * Puts papers where a reading status says they are: back to the start, in
   * progress (where they were, or just begun), or finished.
   */
  setReadingStatus: (ids: string[], status: ReadingStatus) => Promise<void>;

  /** What has been removed, most recently first, with what it takes to put it back. */
  junk: JunkEntry[];
  /**
   * Puts a removed paper back in the library, highlights and collections and
   * all, and — where its Drive folder went to Junk and Drive is connected —
   * moves the folder back out. Drive refusing is thrown, and it stays in Junk.
   */
  restorePaper: (id: string) => Promise<void>;
  /** Forgets removed papers for good. Their copies in Drive's Junk folder are left alone. */
  purgeJunk: (ids: string[]) => Promise<void>;
  togglePaperTag: (id: string, tag: string) => Promise<void>;
  setProgress: (id: string, progress: number) => void;
  markOpened: (id: string) => void;
  /** Remember a PDF link we had to go and find, so the next open is instant. */
  setPaperPdfUrl: (id: string, pdfUrl: string) => Promise<void>;
  /** Remember which copy of the paper was picked by hand, or forget it with undefined. */
  setPaperPdfChoice: (id: string, url: string | undefined) => Promise<void>;
  /**
   * Record a copy of the paper the reader found in Drive by name — saved from
   * another browser, say — so the next open goes straight to it by id.
   */
  setPaperDriveFile: (id: string, found: { folderId: string; pdfFileId: string; pdfLink?: string }) => Promise<void>;
  setPaperAuthors: (id: string, authors: string[]) => Promise<void>;

  createCollection: (name: string) => Promise<Collection>;
  renameCollection: (id: string, name: string) => Promise<void>;
  /** Change a collection in place — its colour, or the project it is (src/lib/projects.ts). */
  updateCollection: (id: string, change: Partial<Collection> | ((collection: Collection) => Partial<Collection>)) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;

  addHighlight: (highlight: Omit<Highlight, 'id' | 'createdAt'>) => Promise<Highlight>;
  updateHighlight: (id: string, patch: Partial<Highlight>) => Promise<void>;
  deleteHighlight: (id: string) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => void;

  signIn: () => Promise<void>;
  connectDrive: () => Promise<void>;
  /** Drive was connected on an earlier visit, so reconnecting is one click. */
  driveRemembered: boolean;
  /** A new tab is asking the open tabs for their sign-in (a moment, as the page loads): the reconnect screen waits for the answer. */
  askingTabs: boolean;
  signOut: () => void;

  /**
   * `pdf` is a copy the caller already has; it is uploaded as-is. With
   * `replacePdf` it goes over the file Drive already holds — a different copy
   * of the paper, picked by hand — rather than being skipped because Drive has one.
   */
  syncPaper: (id: string, options?: { pdf?: Blob; replacePdf?: boolean }) => void;
  /**
   * The same, but it resolves once that paper has been through the queue — for
   * the callers that need Drive to hold the file before they go on, such as
   * opening a paper on the copy that was just saved.
   */
  syncPaperNow: (id: string, options?: { pdf?: Blob; replacePdf?: boolean }) => Promise<SyncOutcome>;
  syncAll: () => void;
  syncStateFor: (id: string) => SyncState;

  /** True once a repository and a token are both configured. */
  githubConnected: boolean;
  githubLog: SyncEntry[];
  githubPending: number;
  /** Flush whatever is queued now, rather than waiting for the debounce. */
  pushToGitHub: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

/** Where the removed papers are kept, in the key-value store. */
const JUNK_KEY = 'junk';

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [junk, setJunk] = useState<JunkEntry[]>([]);
  const junkNow = useRef<JunkEntry[]>([]);
  const keepJunk = useCallback((next: JunkEntry[]) => {
    junkNow.current = next;
    setJunk(next);
    void db.setKv(JUNK_KEY, next).catch(() => undefined);
    touchRef.current();
  }, []);
  const [settings, setSettings] = useState<Settings>(readSettings);
  // A sign-in outlives the page load: the token is kept in this browser for
  // the hour Google gives it, so a reload comes back signed in and connected.
  const [user, setUser] = useState<GoogleUser | null>(google.restoredUser);
  const [driveConnected, setDriveConnected] = useState(google.hasDriveAccess);
  const [driveRemembered, setDriveRemembered] = useState(() => localStorage.getItem(DRIVE_KEY) === 'true');
  // A tab opened beside a signed-in one takes its sign-in rather than asking the person again (google.ts).
  const [askingTabs, setAskingTabs] = useState(() => !google.restoredUser() && typeof BroadcastChannel !== 'undefined');
  /**
   * Whose library is open: the signed-in account's, or — signed out — the one
   * this browser keeps for nobody. It follows `user` into an account, and on
   * the way out (sign-out, or another account) the page is reloaded, so
   * nothing one account had open is left in memory for the next.
   */
  const [account, setAccount] = useState<string | null>(() => accountOf(google.restoredUser()));
  const [librarySync, setLibrarySync] = useState<LibrarySync>({ state: 'local' });
  const [strays, setStrays] = useState(0);
  /** The account whose copy here has been read into the page — Drive is read only after it, or would be overwritten by it. */
  const [loadedAccount, setLoadedAccount] = useState<string | null | undefined>(undefined);
  const accountNow = useRef(account);
  accountNow.current = account;
  /** Marks the library changed, and has it written to Drive once the changes stop for a moment. Set below. */
  const touchRef = useRef<() => void>(() => undefined);
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<SyncEntry[]>([]);
  const [githubLog, setGithubLog] = useState<SyncEntry[]>([]);
  const [githubPending, setGithubPending] = useState(0);

  // Latest-state mirrors so the background sync runner never reads a stale
  // closure while it is working through the queue.
  const latest = useRef({ papers, collections, highlights, settings });
  latest.current = { papers, collections, highlights, settings };

  const queue = useRef<string[]>([]);

  /** Whether this account's library has been read from Drive since it was opened here. */
  const pulled = useRef(false);
  /** The library as it was last read from or written to Drive, to tell whether there is anything to write. */
  const lastPushed = useRef<string | null>(null);
  const remoteMark = useRef<RemoteMark | null>(null);
  const dirty = useRef(false);
  const libraryTimer = useRef<number | undefined>(undefined);
  const pushing = useRef<Promise<void> | null>(null);
  /**
   * PDFs the reader has already fetched, waiting to be uploaded with them —
   * `replace` when it is a copy picked by hand, which goes over the one
   * Drive already holds rather than being skipped because there is one.
   */
  const queuedPdfs = useRef<Map<string, { blob: Blob; replace: boolean }>>(new Map());
  /** Callers waiting to hear that a particular paper has finished syncing. */
  const waiters = useRef<Map<string, ((outcome: SyncOutcome) => void)[]>>(new Map());
  const running = useRef(false);
  /** The paper whose sync is in flight right now, for a removal to wait on. */
  const active = useRef<string | null>(null);

  // GitHub is batched rather than queued one at a time: everything that
  // changed within the debounce window lands in a single commit.
  const githubQueue = useRef<Set<string>>(new Set());
  const githubTimer = useRef<number | undefined>(undefined);
  const githubRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;
    switchDb(account);
    pulled.current = false;
    setReady(false);
    (async () => {
      const [loadedPapers, loadedCollections, loadedHighlights, loadedJunk] = await Promise.all([
        db.allPapers(),
        db.allCollections(),
        db.allHighlights(),
        db.getKv<JunkEntry[]>(JUNK_KEY).catch(() => undefined),
      ]);
      if (cancelled) return;
      junkNow.current = Array.isArray(loadedJunk) ? loadedJunk : [];
      setJunk(junkNow.current);
      // Records saved with a Scholar byline the older parser misread are put right, once.
      const tidied = loadedPapers.map((paper) => tidyByline(paper));
      tidied.forEach((paper, index) => {
        if (paper !== loadedPapers[index]) void db.putPaper(paper).catch(() => undefined);
      });
      setPapers(tidied);
      setHighlights(loadedHighlights);
      if (loadedCollections.length || account) {
        // An account's first collection is whatever its Drive says, once it
        // has been read; seeding one here would add a second to it.
        setCollections(loadedCollections);
      } else {
        const seed: Collection = {
          id: newId(),
          name: 'Reading list',
          color: COLLECTION_COLORS[0],
          createdAt: new Date().toISOString(),
        };
        await db.putCollection(seed);
        setCollections([seed]);
      }
      setLoadedAccount(account);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    if (settings.glass) root.dataset.glass = 'on';
    else delete root.dataset.glass;
    root.style.setProperty('--frost', String(settings.glassFrost));
    root.style.setProperty('--light', String(settings.glassLight));
    root.dataset.wall = settings.glassWall;
    setContactEmail(settings.contactEmail);
    setProxyBase(settings.proxyBase);
    setProxyToken(settings.proxyToken);
  }, [settings]);

  // Signed in with Google, the proxy is asked for a pass in place of a pasted
  // token — nobody pastes anything. A pass nearing its end is renewed; a
  // token pasted by hand is never replaced. See passForGoogle in api.ts.
  useEffect(() => {
    if (!user) return;
    const current = settings.proxyToken.trim();
    if (current && !isPass(current)) return;
    // A pass is someone's: one left from another Google account (signed in here before, as someone
    // else) is not this sign-in's, however long it has left, and is swapped at once, not renewed.
    const theirs = Boolean(current) && passEmail(current)?.toLowerCase() !== user.email?.trim().toLowerCase();
    if (current && !theirs && passExpires(current) - Date.now() > 7 * 86_400_000) return;
    const googleToken = google.liveAccessToken();
    if (!googleToken) return;
    let cancelled = false;
    void passForGoogle(googleToken, current && !theirs ? current : undefined)
      .then((pass) => {
        if (!cancelled && pass) setSettings((latestSettings) => ({ ...latestSettings, proxyToken: pass }));
      })
      .catch((error) => {
        // The proxy turned the sign-in away — too many from this address, or
        // the captcha unsolved — so it is not a sign-in: back to the sign-in
        // screen, saying why. Drive's grant is kept, so trying again is one click.
        if (cancelled || !(error instanceof SignInRefused)) return;
        google.dropSignIn();
        setUser(null);
        setDriveConnected(false);
        setAuthError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [user, settings.proxyToken, settings.proxyBase]);


  // ------------------------------------------------------- the library in Drive ---

  const driveNow = useRef(driveConnected);
  driveNow.current = driveConnected;

  /** Every write to the library goes through here, so that each one is also written to Drive. */
  const lib = useMemo(() => {
    const touched = <A extends unknown[], R>(write: (...args: A) => Promise<R>) => (...args: A) => {
      touchRef.current();
      return write(...args);
    };
    return {
      putPaper: touched(db.putPaper),
      deletePaper: touched(db.deletePaper),
      putCollection: touched(db.putCollection),
      deleteCollection: touched(db.deleteCollection),
      putHighlight: touched(db.putHighlight),
      deleteHighlight: touched(db.deleteHighlight),
    };
  }, []);

  const currentLibrary = useCallback(
    (): Library => ({
      papers: latest.current.papers,
      collections: latest.current.collections,
      highlights: latest.current.highlights,
      junk: junkNow.current,
    }),
    [],
  );

  /** Puts a whole library in place of the one open: in the page, and in this account's copy here. */
  const applyLibrary = useCallback(async (next: Library) => {
    latest.current = { ...latest.current, papers: next.papers, collections: next.collections, highlights: next.highlights };
    junkNow.current = next.junk;
    setPapers(next.papers);
    setCollections(next.collections);
    setHighlights(next.highlights);
    setJunk(next.junk);
    await Promise.all([db.replaceLibrary(next), db.setKv(JUNK_KEY, next.junk)]).catch(() => undefined);
  }, []);

  /**
   * Writes the library to Drive, if it differs from what Drive was last
   * known to hold. Another browser may have written in the meantime: what it
   * added is folded in first, so the write does not take it away again.
   */
  const pushLibrary = useCallback(async () => {
    const owner = accountNow.current;
    if (!owner || !pulled.current || !driveNow.current) return;
    while (pushing.current) await pushing.current;
    const run = (async () => {
      const library = currentLibrary();
      if (serialise(library) === lastPushed.current) {
        if (dirty.current) {
          dirty.current = false;
          await db.setKv(DIRTY_KEY, false).catch(() => undefined);
        }
        return;
      }
      const { googleClientId, driveFolderName } = latest.current.settings;
      setLibrarySync((was) => ({ state: 'saving', message: was.state === 'error' ? undefined : was.message }));
      try {
        let toWrite = library;
        const now = await libraryMark(googleClientId, driveFolderName);
        if (now && now.modifiedTime !== remoteMark.current?.modifiedTime) {
          const remote = await readLibraryFromDrive(googleClientId, driveFolderName);
          if (remote) {
            toWrite = mergeLibraries(library, remote.library);
            await applyLibrary(toWrite);
          }
        }
        if (accountNow.current !== owner) return;
        const mark = await writeLibraryToDrive(googleClientId, driveFolderName, toWrite, {
          account: owner,
          fileId: now?.fileId ?? remoteMark.current?.fileId,
        });
        remoteMark.current = mark;
        lastPushed.current = serialise(toWrite);
        // Anything changed while the write was in flight is still to go.
        dirty.current = serialise(currentLibrary()) !== lastPushed.current;
        await Promise.all([db.setKv(REMOTE_KEY, mark), db.setKv(DIRTY_KEY, dirty.current)]).catch(() => undefined);
        setLibrarySync((was) => ({ state: 'saved', at: new Date().toISOString(), message: was.message }));
      } catch (error) {
        setLibrarySync({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    pushing.current = run;
    try {
      await run;
    } finally {
      if (pushing.current === run) pushing.current = null;
    }
  }, [applyLibrary, currentLibrary]);

  touchRef.current = () => {
    if (!accountNow.current) return;
    if (!dirty.current) {
      dirty.current = true;
      void db.setKv(DIRTY_KEY, true).catch(() => undefined);
    }
    window.clearTimeout(libraryTimer.current);
    libraryTimer.current = window.setTimeout(() => void pushLibrary(), LIBRARY_DEBOUNCE_MS);
  };

  /**
   * What this browser kept from before libraries belonged to accounts, taken
   * into the open one. With `onlyProven`, only the papers whose folder this
   * account's Drive can open — which no other account's can. Otherwise all
   * that is left, and only for the account that claimed them: the first to
   * prove a paper its own, or the first to sign in at all where none of them
   * was ever saved to Drive.
   */
  const takeFromGuest = useCallback(async (onlyProven: boolean): Promise<Library> => {
    const owner = accountNow.current;
    if (!owner) return emptyLibrary();
    const guest = await db.guestContents().catch(() => null);
    if (!guest?.papers.length) return emptyLibrary();
    const claimant = localStorage.getItem(GUEST_CLAIM_KEY);
    const driveIdOf = (paper: Paper) => paper.drive?.folderId || paper.drive?.metaFileId || paper.drive?.pdfFileId;
    let taking: Paper[];
    if (onlyProven) {
      const ids = guest.papers.map(driveIdOf).filter((id): id is string => Boolean(id));
      const seen = await visibleInDrive(latest.current.settings.googleClientId, ids).catch(() => new Set<string>());
      taking = guest.papers.filter((paper) => {
        const id = driveIdOf(paper);
        return Boolean(id && seen.has(id));
      });
      if (!claimant && (taking.length || !ids.length)) localStorage.setItem(GUEST_CLAIM_KEY, owner);
    } else {
      if (claimant !== owner) return emptyLibrary();
      taking = guest.papers;
    }
    if (!taking.length) return emptyLibrary();
    const ids = new Set(taking.map((paper) => paper.id));
    const highlights = guest.highlights.filter((highlight) => ids.has(highlight.paperId));
    const used = new Set(taking.flatMap((paper) => paper.collectionIds));
    const collections = guest.collections.filter((collection) => used.has(collection.id));
    // Notes, explanations, boards: everything kept against one of these papers goes with it.
    const kv = guest.kv.filter(([key]) => taking.some((paper) => key.endsWith(`:${paper.id}`)));
    for (const [key, value] of kv) await db.setKv(key, value).catch(() => undefined);
    await db.forgetGuestPapers([...ids], highlights.map((highlight) => highlight.id), kv.map(([key]) => key)).catch(() => undefined);
    return { papers: taking, collections, highlights, junk: [] };
  }, []);

  const countStrays = useCallback(async () => {
    const owner = accountNow.current;
    if (!owner || localStorage.getItem(GUEST_CLAIM_KEY) !== owner) return setStrays(0);
    const guest = await db.guestContents().catch(() => null);
    setStrays(guest?.papers.length ?? 0);
  }, []);

  /**
   * Reads this account's library from its Drive into the page. Drive's copy
   * wins, unless a change made here never reached it: then, if Drive has not
   * changed either, this copy is the newer one; if both have, the two are put
   * together. An account with no library file yet has one made from what it
   * already has — its paper folders' sidecars, and whatever of this
   * browser's older library is provably its own.
   */
  const pullLibrary = useCallback(async () => {
    const owner = accountNow.current;
    if (!owner || pulled.current) return;
    const { googleClientId, driveFolderName } = latest.current.settings;
    setLibrarySync({ state: 'loading' });
    try {
      const [remote, wasDirty, knownMark] = await Promise.all([
        readLibraryFromDrive(googleClientId, driveFolderName),
        db.getKv<boolean>(DIRTY_KEY).catch(() => false),
        db.getKv<RemoteMark>(REMOTE_KEY).catch(() => undefined),
      ]);
      if (accountNow.current !== owner) return;
      const local = currentLibrary();
      let next: Library;
      let restored: string | undefined;
      if (remote?.mark) {
        next = !wasDirty
          ? remote.library
          : knownMark?.modifiedTime === remote.mark.modifiedTime
            ? local
            : mergeLibraries(local, remote.library);
        remoteMark.current = remote.mark;
        lastPushed.current = serialise(remote.library);
        void db.setKv(REMOTE_KEY, remote.mark).catch(() => undefined);
        if (remote.source === 'trash') restored = `${LIBRARY_FILE} was in Drive's trash, and has been put back.`;
      } else if (remote) {
        // The file itself is gone, and the spare copy stands in for it: it is
        // put together with the copy here, and written back where it was.
        next = mergeLibraries(local, remote.library);
        remoteMark.current = null;
        lastPushed.current = null;
        restored = `${LIBRARY_FILE} was missing from Drive, and has been restored from the spare copy.`;
      } else {
        next = mergeLibraries(local, await takeFromGuest(true));
        next = mergeLibraries(next, await rebuildFromSidecars(googleClientId, driveFolderName, newId));
        remoteMark.current = null;
        lastPushed.current = null;
      }
      if (accountNow.current !== owner) return;
      if (!next.collections.length) {
        next = {
          ...next,
          collections: [{ id: newId(), name: 'Reading list', color: COLLECTION_COLORS[0], createdAt: new Date().toISOString() }],
        };
      }
      pulled.current = true;
      dirty.current = Boolean(wasDirty) || !remote?.mark;
      await applyLibrary(next);
      setLibrarySync({ state: 'saved', at: new Date().toISOString(), message: restored });
      void countStrays();
      void pushLibrary();
    } catch (error) {
      setLibrarySync({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [applyLibrary, countStrays, currentLibrary, pushLibrary, takeFromGuest]);

  // Drive is read once the copy here has been: the other way round, the copy
  // here would land on top of what came from Drive.
  useEffect(() => {
    if (ready && account && loadedAccount === account && driveConnected && !pulled.current) void pullLibrary();
  }, [ready, account, loadedAccount, driveConnected, pullLibrary]);

  // Leaving the tab writes what is waiting rather than leaving it to the
  // debounce; coming back looks for a change another browser has written.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (dirty.current) {
          window.clearTimeout(libraryTimer.current);
          void pushLibrary();
        }
        return;
      }
      if (!pulled.current || dirty.current || !driveNow.current || !accountNow.current) return;
      const { googleClientId, driveFolderName } = latest.current.settings;
      void libraryMark(googleClientId, driveFolderName)
        .then((mark) => {
          if (!mark) {
            // Gone from Drive while this tab was away: written again from here.
            if (remoteMark.current) {
              remoteMark.current = null;
              lastPushed.current = null;
              void pushLibrary();
            }
            return;
          }
          if (mark.modifiedTime !== remoteMark.current?.modifiedTime && !dirty.current) {
            pulled.current = false;
            void pullLibrary();
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pullLibrary, pushLibrary]);

  const adoptStrays = useCallback(async () => {
    const taken = await takeFromGuest(false);
    if (!taken.papers.length) return setStrays(0);
    const next = mergeLibraries(currentLibrary(), taken);
    await applyLibrary(next);
    setStrays(0);
    touchRef.current();
  }, [applyLibrary, currentLibrary, takeFromGuest]);

  const discardStrays = useCallback(async () => {
    const guest = await db.guestContents().catch(() => null);
    if (guest) {
      const ids = guest.papers.map((paper) => paper.id);
      const kv = guest.kv.filter(([key]) => ids.some((id) => key.endsWith(`:${id}`))).map(([key]) => key);
      await db.forgetGuestPapers(ids, guest.highlights.map((highlight) => highlight.id), kv).catch(() => undefined);
    }
    setStrays(0);
  }, []);

  /**
   * Into the library of whoever just signed in. From nobody's library that is
   * done in place; from another account's the page starts again, so nothing
   * the last one had open — notes, explanations, a notebook — stays in memory.
   */
  const enterAccount = useCallback((next: GoogleUser) => {
    const key = accountOf(next);
    if (!key || key === accountNow.current) return;
    if (accountNow.current) {
      window.location.reload();
      return;
    }
    setAccount(key);
  }, []);

  // Another tab's sign-in, handed over when this one opened or renewed while it is open; another tab's sign-out.
  useEffect(() => {
    const take = () => {
      const handed = google.restoredUser();
      if (!handed) return;
      setUser(handed);
      const drive = google.hasDriveAccess();
      setDriveConnected(drive);
      if (drive) {
        localStorage.setItem(DRIVE_KEY, 'true');
        setDriveRemembered(true);
      }
      enterAccount(handed);
    };
    const stop = google.onSessionChange((change) => {
      if (change === 'token') take();
      // Signed out elsewhere: start again with nobody's library here too, as the tab that signed out does.
      else if (accountNow.current) window.location.reload();
      else setUser(null);
    });
    if (askingTabs) void google.askOtherTabs().then(() => setAskingTabs(false));
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterAccount]);

  const githubConnected = Boolean(targetFrom(settings));

  const note = useCallback((paperId: string, state: SyncState, message?: string) => {
    setSyncLog((entries) => {
      const rest = entries.filter((entry) => entry.paperId !== paperId);
      return [{ paperId, state, message, at: new Date().toISOString() }, ...rest].slice(0, 60);
    });
  }, []);

  const savePaper = useCallback(async (paper: Paper) => {
    await lib.putPaper(paper);
    setPapers((current) => {
      const index = current.findIndex((item) => item.id === paper.id);
      if (index === -1) return [paper, ...current];
      const next = current.slice();
      next[index] = paper;
      return next;
    });
  }, []);

  /** Releases whoever was waiting on this paper, whether it worked or not. */
  const settle = useCallback((paperId: string, outcome: SyncOutcome) => {
    const pending = waiters.current.get(paperId);
    waiters.current.delete(paperId);
    for (const resolve of pending || []) resolve(outcome);
  }, []);

  const drainQueue = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const paperId = queue.current.shift() as string;
        const queued = queuedPdfs.current.get(paperId);
        queuedPdfs.current.delete(paperId);
        const paper = latest.current.papers.find((item) => item.id === paperId);
        if (!paper) {
          settle(paperId, { state: 'skipped', message: 'That paper is no longer in the library.' });
          continue;
        }
        note(paperId, 'running');
        active.current = paperId;
        try {
          const result = await syncPaperToDrive(paper, {
            collections: latest.current.collections,
            highlights: latest.current.highlights,
            settings: latest.current.settings,
            pdf: queued?.blob,
            replacePdf: queued?.replace,
          });
          // Removed while the upload was in flight: saving the result would
          // put the paper straight back in the library.
          if (!latest.current.papers.some((item) => item.id === paperId)) {
            settle(paperId, { state: 'skipped', message: 'That paper is no longer in the library.' });
            continue;
          }
          const updated: Paper = {
            ...paper,
            drive: {
              folderId: result.folderId,
              folderName: result.folderName,
              folderLink: result.folderLink,
              pdfFileId: result.pdfFileId,
              pdfLink: result.pdfLink,
              metaFileId: result.metaFileId,
              syncedAt: result.syncedAt,
              error: undefined,
            },
          };
          await savePaper(updated);
          // The next entry in the queue reads this mirror, and may be the same
          // paper again: without this it would not know the PDF is now in
          // Drive, and would fetch and upload the whole thing a second time.
          latest.current.papers = latest.current.papers.map((item) =>
            item.id === updated.id ? updated : item,
          );
          note(paperId, 'done', result.notice);
          settle(paperId, { state: 'done', message: result.notice });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = latest.current.papers.find((item) => item.id === paperId);
          if (current) await savePaper({ ...current, drive: { ...(current.drive || {}), error: message } });
          note(paperId, 'error', message);
          settle(paperId, { state: 'error', message });
        } finally {
          active.current = null;
        }
      }
    } finally {
      running.current = false;
      // A paper that never made it into the queue — Drive disconnected
      // mid-flight, say — would otherwise leave its caller waiting forever.
      for (const paperId of Array.from(waiters.current.keys())) {
        if (!queue.current.includes(paperId)) settle(paperId, { state: 'skipped' });
      }
    }
  }, [note, savePaper, settle]);

  const syncPaper = useCallback(
    (id: string, options: { pdf?: Blob; replacePdf?: boolean } = {}) => {
      if (!driveConnected) return;
      // The reader hands over the copy it is showing, so the upload is the
      // file already on screen rather than a second trip to the publisher.
      // A copy picked by hand stays a replacement even if a later file for the
      // same paper is queued before the first one has gone up.
      if (options.pdf) {
        const replace = Boolean(options.replacePdf || queuedPdfs.current.get(id)?.replace);
        queuedPdfs.current.set(id, { blob: options.pdf, replace });
      }
      if (!queue.current.includes(id)) queue.current.push(id);
      note(id, 'queued');
      void drainQueue();
    },
    [driveConnected, drainQueue, note],
  );

  /**
   * Sync, and say how it went. Used where the next step needs the file to be
   * in Drive already: adding a paper from search opens it on the copy in
   * Drive, and that copy has to exist first — and where the caller is the one
   * place the reader is looking, so a failure has to come back to it rather
   * than only into the sync log.
   */
  const syncPaperNow = useCallback(
    (id: string, options: { pdf?: Blob; replacePdf?: boolean } = {}) => {
      if (!driveConnected) {
        return Promise.resolve<SyncOutcome>({ state: 'skipped', message: 'Drive is not connected.' });
      }
      return new Promise<SyncOutcome>((resolve) => {
        waiters.current.set(id, [...(waiters.current.get(id) || []), resolve]);
        syncPaper(id, options);
      });
    },
    [driveConnected, syncPaper],
  );

  const syncAll = useCallback(() => {
    if (!driveConnected) return;
    for (const paper of latest.current.papers) {
      if (!queue.current.includes(paper.id)) queue.current.push(paper.id);
      note(paper.id, 'queued');
    }
    void drainQueue();
  }, [driveConnected, drainQueue, note]);

  const githubNote = useCallback((paperId: string, state: SyncState, message?: string) => {
    setGithubLog((entries) => {
      const rest = entries.filter((entry) => entry.paperId !== paperId);
      return [{ paperId, state, message, at: new Date().toISOString() }, ...rest].slice(0, 60);
    });
  }, []);

  const flushGitHub = useCallback(async () => {
    if (githubRunning.current) return;
    const ids = Array.from(githubQueue.current);
    if (!ids.length) return;
    if (!targetFrom(latest.current.settings)) return;

    githubQueue.current.clear();
    setGithubPending(0);
    githubRunning.current = true;
    const papers = ids
      .map((id) => latest.current.papers.find((paper) => paper.id === id))
      .filter((paper): paper is Paper => Boolean(paper));

    try {
      if (!papers.length) return;
      for (const paper of papers) githubNote(paper.id, 'running');
      const result = await syncPapersToGitHub(papers, {
        collections: latest.current.collections,
        highlights: latest.current.highlights,
        library: latest.current.papers,
        settings: latest.current.settings,
      });
      for (const paper of papers) {
        const current = latest.current.papers.find((item) => item.id === paper.id);
        if (!current) continue;
        const updated: Paper = {
          ...current,
          github: {
            repo: latest.current.settings.githubRepo,
            path: `${pathFor(current, latest.current.collections)}.md`,
            commit: result.commit ?? current.github?.commit,
            syncedAt: result.syncedAt,
            error: undefined,
          },
        };
        await savePaper(updated);
        latest.current.papers = latest.current.papers.map((item) => (item.id === updated.id ? updated : item));
        githubNote(paper.id, 'done', result.commit ? undefined : 'Already up to date.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const paper of papers) {
        const current = latest.current.papers.find((item) => item.id === paper.id);
        if (current) {
          await savePaper({ ...current, github: { ...(current.github || {}), error: message } });
        }
        githubNote(paper.id, 'error', message);
      }
    } finally {
      githubRunning.current = false;
      // Anything queued while the commit was in flight goes in the next one.
      if (githubQueue.current.size) {
        githubTimer.current = window.setTimeout(() => void flushGitHub(), GITHUB_DEBOUNCE_MS);
      }
    }
  }, [githubNote, savePaper]);

  const queueGitHub = useCallback(
    (id: string) => {
      if (!latest.current.settings.githubSync || !targetFrom(latest.current.settings)) return;
      githubQueue.current.add(id);
      setGithubPending(githubQueue.current.size);
      githubNote(id, 'queued');
      window.clearTimeout(githubTimer.current);
      githubTimer.current = window.setTimeout(() => void flushGitHub(), GITHUB_DEBOUNCE_MS);
    },
    [flushGitHub, githubNote],
  );

  const pushToGitHub = useCallback(() => {
    if (!targetFrom(latest.current.settings)) return;
    // An explicit push is "write everything", not "write what changed".
    for (const paper of latest.current.papers) githubQueue.current.add(paper.id);
    setGithubPending(githubQueue.current.size);
    window.clearTimeout(githubTimer.current);
    void flushGitHub();
  }, [flushGitHub]);

  // A commit that is still waiting out its debounce when the tab closes would
  // simply be lost, so the queue is flushed on the way out.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && githubQueue.current.size) void flushGitHub();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flushGitHub]);

  const addPaper = useCallback(
    async (ref: PaperRef, collectionId?: string, options: { sync?: boolean } = {}) => {
      const existing = latest.current.papers.find((paper) => paper.id === ref.id);
      const collectionIds = collectionId
        ? Array.from(new Set([...(existing?.collectionIds || []), collectionId]))
        : existing?.collectionIds || [];
      // A search result carries every field, set or not, and spreading an
      // unset one over the stored paper would erase it — the PDF link the
      // reader resolved and kept on the last open, most of all. Only what the
      // result actually says is taken over what is stored.
      const said = Object.fromEntries(Object.entries(ref).filter(([, value]) => value !== undefined)) as PaperRef;
      const paper: Paper = {
        ...ref,
        ...(existing || {}),
        ...said,
        addedAt: existing?.addedAt || new Date().toISOString(),
        collectionIds,
        tags: existing?.tags || [],
        progress: existing?.progress ?? 0,
        lastOpenedAt: existing?.lastOpenedAt,
        drive: existing?.drive,
      };
      await savePaper(paper);
      latest.current.papers = [paper, ...latest.current.papers.filter((item) => item.id !== paper.id)];
      // Added again from a search: it is back, and no longer waiting in Junk.
      if (junkNow.current.some((item) => item.paper.id === paper.id)) keepJunk(junkNow.current.filter((item) => item.paper.id !== paper.id));
      if (options.sync !== false && settings.autoSync && driveConnected) syncPaper(paper.id);
      queueGitHub(paper.id);
      return paper;
    },
    [driveConnected, keepJunk, queueGitHub, savePaper, settings.autoSync, syncPaper],
  );

  const removePaper = useCallback(
    async (id: string, options: { junkInDrive?: boolean } = {}): Promise<RemoveOutcome> => {
      const paper = latest.current.papers.find((item) => item.id === id);

      // A sync still waiting its turn would put the folder straight back in
      // the root after it had been moved, so it is dropped; one already in
      // flight is let finish, so the move sees the folder as it will end up.
      queue.current = queue.current.filter((item) => item !== id);
      queuedPdfs.current.delete(id);
      if (active.current === id) {
        await new Promise<SyncOutcome>((resolve) => {
          waiters.current.set(id, [...(waiters.current.get(id) || []), resolve]);
        });
      }

      let outcome: RemoveOutcome = { drive: 'kept' };
      const current = latest.current.papers.find((item) => item.id === id) ?? paper;
      if (!current || !isInDrive(current)) {
        outcome = { drive: 'not-in-drive' };
      } else if (options.junkInDrive === false) {
        outcome = { drive: 'kept' };
      } else if (!driveConnected) {
        outcome = { drive: 'not-connected' };
      } else {
        const moved = await junkPaperInDrive(current, latest.current.settings);
        outcome = { drive: moved.moved === 'nothing' ? 'not-in-drive' : 'junked', junkFolderLink: moved.junkFolderLink };
      }

      if (current) {
        const kept = latest.current.highlights.filter((highlight) => highlight.paperId === id);
        const entry: JunkEntry = { paper: current, highlights: kept, removedAt: new Date().toISOString(), drive: outcome.drive };
        keepJunk([entry, ...junkNow.current.filter((item) => item.paper.id !== id)]);
      }

      await lib.deletePaper(id);
      latest.current.papers = latest.current.papers.filter((item) => item.id !== id);
      setPapers((items) => items.filter((item) => item.id !== id));
      const toRemove = latest.current.highlights.filter((highlight) => highlight.paperId === id);
      await Promise.all(toRemove.map((highlight) => lib.deleteHighlight(highlight.id)));
      latest.current.highlights = latest.current.highlights.filter((highlight) => highlight.paperId !== id);
      setHighlights((items) => items.filter((highlight) => highlight.paperId !== id));
      return outcome;
    },
    [driveConnected, keepJunk],
  );

  const restorePaper = useCallback(
    async (id: string) => {
      const entry = junkNow.current.find((item) => item.paper.id === id);
      if (!entry) return;
      if (entry.drive === 'junked' && driveConnected) await restorePaperInDrive(entry.paper, latest.current.settings);
      // Collections deleted in the meantime are not come back to.
      const known = new Set(latest.current.collections.map((collection) => collection.id));
      const paper: Paper = { ...entry.paper, collectionIds: entry.paper.collectionIds.filter((item) => known.has(item)) };
      await savePaper(paper);
      latest.current.papers = [paper, ...latest.current.papers.filter((item) => item.id !== id)];
      await Promise.all(entry.highlights.map((highlight) => lib.putHighlight(highlight)));
      latest.current.highlights = [...latest.current.highlights.filter((highlight) => highlight.paperId !== id), ...entry.highlights];
      setHighlights((items) => [...items.filter((highlight) => highlight.paperId !== id), ...entry.highlights]);
      keepJunk(junkNow.current.filter((item) => item.paper.id !== id));
      // A folder left in Junk because Drive was not connected is written again where it belongs.
      if (settings.autoSync && driveConnected && entry.drive !== 'junked') syncPaper(id);
      queueGitHub(id);
    },
    [driveConnected, keepJunk, queueGitHub, savePaper, settings.autoSync, syncPaper],
  );

  const purgeJunk = useCallback(
    async (ids: string[]) => {
      const gone = new Set(ids);
      // Deleted for good, a paper's notes go with it; while it was only in Junk they waited for it.
      ids.forEach(forgetNotes);
      keepJunk(junkNow.current.filter((item) => !gone.has(item.paper.id)));
    },
    [keepJunk],
  );

  const setReadingStatus = useCallback(
    async (ids: string[], status: ReadingStatus) => {
      for (const id of ids) {
        const paper = latest.current.papers.find((item) => item.id === id);
        if (!paper) continue;
        const progress =
          status === 'unread' ? 0 : status === 'finished' ? 1 : paper.progress > 0 && paper.progress < FINISHED_AT ? paper.progress : 0.01;
        if (progress === paper.progress) continue;
        const updated = { ...paper, progress };
        await savePaper(updated);
        latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
        queueGitHub(id);
      }
    },
    [queueGitHub, savePaper],
  );

  const setPaperCollections = useCallback(
    async (id: string, collectionIds: string[]) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper) return;
      const updated = { ...paper, collectionIds };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
      if (settings.autoSync && driveConnected) syncPaper(id);
      queueGitHub(id);
    },
    [driveConnected, queueGitHub, savePaper, settings.autoSync, syncPaper],
  );

  const togglePaperTag = useCallback(
    async (id: string, tag: string) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper) return;
      const tags = paper.tags.includes(tag) ? paper.tags.filter((item) => item !== tag) : [...paper.tags, tag];
      const updated = { ...paper, tags };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
      queueGitHub(id);
    },
    [queueGitHub, savePaper],
  );

  const progressTimer = useRef<Record<string, number>>({});
  const setProgress = useCallback(
    (id: string, progress: number) => {
      setPapers((current) =>
        current.map((paper) => (paper.id === id ? { ...paper, progress } : paper)),
      );
      window.clearTimeout(progressTimer.current[id]);
      progressTimer.current[id] = window.setTimeout(() => {
        const paper = latest.current.papers.find((item) => item.id === id);
        if (paper) void lib.putPaper({ ...paper, progress });
      }, 800);
    },
    [],
  );

  const markOpened = useCallback(
    (id: string) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper) return;
      void savePaper({ ...paper, lastOpenedAt: new Date().toISOString() });
    },
    [savePaper],
  );

  const setPaperPdfUrl = useCallback(
    async (id: string, pdfUrl: string) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper || paper.pdfUrl === pdfUrl) return;
      const updated = { ...paper, pdfUrl };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
    },
    [savePaper],
  );

  const setPaperPdfChoice = useCallback(
    async (id: string, url: string | undefined) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper || paper.pdfChoice === url) return;
      const updated: Paper = { ...paper, pdfChoice: url };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
    },
    [savePaper],
  );

  /** The byline read off the PDF, where it names more people, or names them in full. */
  const setPaperAuthors = useCallback(
    async (id: string, authors: string[]) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper || paper.authors.join('\n') === authors.join('\n')) return;
      const updated: Paper = { ...paper, authors };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
    },
    [savePaper],
  );

  const setPaperDriveFile = useCallback(
    async (id: string, found: { folderId: string; pdfFileId: string; pdfLink?: string }) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper || paper.drive?.pdfFileId === found.pdfFileId) return;
      const updated: Paper = {
        ...paper,
        drive: {
          ...(paper.drive || {}),
          folderId: found.folderId,
          folderLink: driveFolderUrl(found.folderId),
          pdfFileId: found.pdfFileId,
          pdfLink: found.pdfLink,
          error: undefined,
        },
      };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
    },
    [savePaper],
  );

  const createCollection = useCallback(async (name: string) => {
    const collection: Collection = {
      id: newId(),
      name: name.trim() || 'Untitled collection',
      color: COLLECTION_COLORS[latest.current.collections.length % COLLECTION_COLORS.length],
      createdAt: new Date().toISOString(),
    };
    await lib.putCollection(collection);
    setCollections((current) => [...current, collection]);
    latest.current.collections = [...latest.current.collections, collection];
    return collection;
  }, []);

  const renameCollection = useCallback(async (id: string, name: string) => {
    const collection = latest.current.collections.find((item) => item.id === id);
    if (!collection) return;
    const updated = { ...collection, name: name.trim() || collection.name };
    await lib.putCollection(updated);
    setCollections((current) => current.map((item) => (item.id === id ? updated : item)));
  }, []);

  const updateCollection = useCallback(
    async (id: string, change: Partial<Collection> | ((collection: Collection) => Partial<Collection>)) => {
      const collection = latest.current.collections.find((item) => item.id === id);
      if (!collection) return;
      const updated: Collection = { ...collection, ...(typeof change === 'function' ? change(collection) : change), id };
      latest.current.collections = latest.current.collections.map((item) => (item.id === id ? updated : item));
      setCollections((current) => current.map((item) => (item.id === id ? updated : item)));
      await lib.putCollection(updated);
    },
    [],
  );

  const deleteCollection = useCallback(async (id: string) => {
    await lib.deleteCollection(id);
    setCollections((current) => current.filter((item) => item.id !== id));
    const affected = latest.current.papers.filter((paper) => paper.collectionIds.includes(id));
    await Promise.all(
      affected.map((paper) =>
        lib.putPaper({ ...paper, collectionIds: paper.collectionIds.filter((item) => item !== id) }),
      ),
    );
    setPapers((current) =>
      current.map((paper) =>
        paper.collectionIds.includes(id)
          ? { ...paper, collectionIds: paper.collectionIds.filter((item) => item !== id) }
          : paper,
      ),
    );
  }, []);

  const addHighlight = useCallback(
    async (input: Omit<Highlight, 'id' | 'createdAt'>) => {
      const highlight: Highlight = { ...input, id: newId(), createdAt: new Date().toISOString() };
      await lib.putHighlight(highlight);
      setHighlights((current) => [...current, highlight]);
      latest.current.highlights = [...latest.current.highlights, highlight];
      if (settings.autoSync && driveConnected) syncPaper(highlight.paperId);
      queueGitHub(highlight.paperId);
      return highlight;
    },
    [driveConnected, queueGitHub, settings.autoSync, syncPaper],
  );

  const updateHighlight = useCallback(
    async (id: string, patch: Partial<Highlight>) => {
      const highlight = latest.current.highlights.find((item) => item.id === id);
      if (!highlight) return;
      const updated = { ...highlight, ...patch };
      await lib.putHighlight(updated);
      setHighlights((current) => current.map((item) => (item.id === id ? updated : item)));
      latest.current.highlights = latest.current.highlights.map((item) => (item.id === id ? updated : item));
      if (settings.autoSync && driveConnected) syncPaper(updated.paperId);
      queueGitHub(updated.paperId);
    },
    [driveConnected, queueGitHub, settings.autoSync, syncPaper],
  );

  const deleteHighlight = useCallback(
    async (id: string) => {
      const highlight = latest.current.highlights.find((item) => item.id === id);
      await lib.deleteHighlight(id);
      setHighlights((current) => current.filter((item) => item.id !== id));
      latest.current.highlights = latest.current.highlights.filter((item) => item.id !== id);
      if (!highlight) return;
      // Drive's copy loses it too, as it gained it: the sidecar is written afresh.
      if (settings.autoSync && driveConnected) syncPaper(highlight.paperId);
      queueGitHub(highlight.paperId);
    },
    [driveConnected, queueGitHub, settings.autoSync, syncPaper],
  );

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  // No client ID here (none typed in this browser, and a build without one): the site's own, from its proxy —
  // the one it checks sign-ins against — so signing in, Drive and Colab work in any browser, as the same account.
  useEffect(() => {
    if (settings.googleClientId.trim()) return;
    let live = true;
    void proxyHealth().then((health) => {
      if (live && health?.googleClientId) updateSettings({ googleClientId: health.googleClientId });
    });
    return () => {
      live = false;
    };
  }, [settings.googleClientId, settings.proxyBase, updateSettings]);

  const signIn = useCallback(async () => {
    setAuthError(null);
    const clientId = latest.current.settings.googleClientId.trim();
    if (!clientId) {
      setAuthError('Add your Google OAuth client ID in Settings first.');
      return;
    }
    try {
      // One window asks for both: who you are, and Drive — the library lives there.
      const signedIn = await google.signIn(clientId);
      setUser(signedIn);
      const drive = google.hasDriveAccess();
      setDriveConnected(drive);
      if (drive) {
        localStorage.setItem(DRIVE_KEY, 'true');
        setDriveRemembered(true);
      }
      enterAccount(signedIn);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }, [enterAccount]);

  const connectDrive = useCallback(async () => {
    setAuthError(null);
    const clientId = latest.current.settings.googleClientId.trim();
    if (!clientId) {
      setAuthError('Add your Google OAuth client ID in Settings first.');
      return;
    }
    const quiet = localStorage.getItem(DRIVE_KEY) === 'true';
    try {
      const signedIn = await google.connectDrive(clientId, quiet);
      setUser(signedIn);
      setDriveConnected(google.hasDriveAccess());
      localStorage.setItem(DRIVE_KEY, 'true');
      setDriveRemembered(true);
      enterAccount(signedIn);
    } catch (error) {
      // A quiet reconnect leans on a grant Google may have let go of. Forget
      // it, so the next click asks for consent properly rather than failing
      // the same way again.
      if (quiet) {
        localStorage.removeItem(DRIVE_KEY);
        setDriveRemembered(false);
      }
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }, [enterAccount]);

  const signOut = useCallback(() => {
    void (async () => {
      // What has not reached Drive yet goes now, while there is a token to send it with.
      if (dirty.current) {
        window.clearTimeout(libraryTimer.current);
        await pushLibrary().catch(() => undefined);
      }
      google.signOut();
      // The proxy pass was this sign-in's; it goes with it. A pasted token stays.
      const current = latest.current.settings;
      const next = isPass(current.proxyToken.trim()) ? { ...current, proxyToken: '' } : current;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      localStorage.removeItem(DRIVE_KEY);
      // The page starts again with nobody's library, so nothing of this
      // account's — in the page or in memory — is left for whoever is next.
      window.location.reload();
    })();
  }, [pushLibrary]);

  const syncStateFor = useCallback(
    (id: string) => syncLog.find((entry) => entry.paperId === id)?.state ?? 'idle',
    [syncLog],
  );

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      papers,
      collections,
      highlights,
      settings,
      user,
      driveConnected,
      driveRemembered,
      askingTabs,
      authError,
      syncLog,
      librarySync,
      strays,
      adoptStrays,
      discardStrays,
      addPaper,
      removePaper,
      setPaperCollections,
      setReadingStatus,
      junk,
      restorePaper,
      purgeJunk,
      togglePaperTag,
      setProgress,
      markOpened,
      setPaperPdfUrl,
      setPaperPdfChoice,
      setPaperDriveFile,
      setPaperAuthors,
      createCollection,
      renameCollection,
      updateCollection,
      deleteCollection,
      addHighlight,
      updateHighlight,
      deleteHighlight,
      updateSettings,
      signIn,
      connectDrive,
      signOut,
      syncPaper,
      syncPaperNow,
      syncAll,
      syncStateFor,
      githubConnected,
      githubLog,
      githubPending,
      pushToGitHub,
    }),
    [
      ready, papers, collections, highlights, settings, user, driveConnected, authError, syncLog, librarySync, strays, adoptStrays, discardStrays,
      addPaper, removePaper, setPaperCollections, setReadingStatus, junk, restorePaper, purgeJunk, togglePaperTag, setProgress, markOpened, setPaperPdfUrl, setPaperPdfChoice, setPaperDriveFile, setPaperAuthors,
      createCollection, renameCollection, updateCollection, deleteCollection, addHighlight, updateHighlight,
      deleteHighlight, updateSettings, signIn, connectDrive, driveRemembered, askingTabs, signOut, syncPaper, syncPaperNow, syncAll, syncStateFor,
      githubConnected, githubLog, githubPending, pushToGitHub,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}

export type { HighlightColor };
