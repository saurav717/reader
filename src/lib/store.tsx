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
import { COLLECTION_COLORS } from '../types';
import { db } from './db';
import { tidyByline } from './byline';
import { ROOT_FOLDER, driveFolderUrl, isInDrive, junkPaperInDrive, restorePaperInDrive, syncPaperToDrive } from './driveSync';
import { FINISHED_AT, type ReadingStatus } from './status';
import { pathFor, syncPapersToGitHub, targetFrom } from './github';
import { setContactEmail } from './contact';
import { setProxyBase } from './api';
import * as google from './google';

const SETTINGS_KEY = 'reader.settings';
/**
 * That Drive was connected once, which is all a page with no backend may
 * remember: the token itself lives in memory and dies with the tab. It is what
 * lets a return visit offer to reconnect, and reconnect without asking for
 * consent a second time.
 */
const DRIVE_KEY = 'reader.drive.connected';

const defaultSettings: Settings = {
  googleClientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '',
  driveFolderName: ROOT_FOLDER,
  autoSync: true,
  savePdf: true,
  syncOnOpen: true,
  proxyBase: '',
  theme: 'light',
  glass: false,
  glassFrost: 0.5,
  glassWall: 'spotlight',
  readingMode: 'pdf',
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
    const saved = { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
    // Anyone who opened the app before it had a client ID compiled in has an
    // empty one saved, which would otherwise shadow the new default forever.
    // An empty string here means "not set", not "deliberately blank".
    if (!saved.googleClientId) saved.googleClientId = defaultSettings.googleClientId;
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
  deleteCollection: (id: string) => Promise<void>;

  addHighlight: (highlight: Omit<Highlight, 'id' | 'createdAt'>) => Promise<Highlight>;
  updateHighlight: (id: string, patch: Partial<Highlight>) => Promise<void>;
  deleteHighlight: (id: string) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => void;

  signIn: () => Promise<void>;
  connectDrive: () => Promise<void>;
  /** Drive was connected on an earlier visit, so reconnecting is one click. */
  driveRemembered: boolean;
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
  }, []);
  const [settings, setSettings] = useState<Settings>(readSettings);
  // A sign-in outlives the page load: the token is kept in this browser for
  // the hour Google gives it, so a reload comes back signed in and connected.
  const [user, setUser] = useState<GoogleUser | null>(google.restoredUser);
  const [driveConnected, setDriveConnected] = useState(google.hasDriveAccess);
  const [driveRemembered, setDriveRemembered] = useState(() => localStorage.getItem(DRIVE_KEY) === 'true');
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<SyncEntry[]>([]);
  const [githubLog, setGithubLog] = useState<SyncEntry[]>([]);
  const [githubPending, setGithubPending] = useState(0);

  // Latest-state mirrors so the background sync runner never reads a stale
  // closure while it is working through the queue.
  const latest = useRef({ papers, collections, highlights, settings });
  latest.current = { papers, collections, highlights, settings };

  const queue = useRef<string[]>([]);
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
      if (loadedCollections.length) {
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
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    if (settings.glass) root.dataset.glass = 'on';
    else delete root.dataset.glass;
    root.style.setProperty('--frost', String(settings.glassFrost));
    root.dataset.wall = settings.glassWall;
    setContactEmail(settings.contactEmail);
    setProxyBase(settings.proxyBase);
  }, [settings]);

  const githubConnected = Boolean(targetFrom(settings));

  const note = useCallback((paperId: string, state: SyncState, message?: string) => {
    setSyncLog((entries) => {
      const rest = entries.filter((entry) => entry.paperId !== paperId);
      return [{ paperId, state, message, at: new Date().toISOString() }, ...rest].slice(0, 60);
    });
  }, []);

  const savePaper = useCallback(async (paper: Paper) => {
    await db.putPaper(paper);
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

      await db.deletePaper(id);
      latest.current.papers = latest.current.papers.filter((item) => item.id !== id);
      setPapers((items) => items.filter((item) => item.id !== id));
      const toRemove = latest.current.highlights.filter((highlight) => highlight.paperId === id);
      await Promise.all(toRemove.map((highlight) => db.deleteHighlight(highlight.id)));
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
      await Promise.all(entry.highlights.map((highlight) => db.putHighlight(highlight)));
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
        if (paper) void db.putPaper({ ...paper, progress });
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
    await db.putCollection(collection);
    setCollections((current) => [...current, collection]);
    latest.current.collections = [...latest.current.collections, collection];
    return collection;
  }, []);

  const renameCollection = useCallback(async (id: string, name: string) => {
    const collection = latest.current.collections.find((item) => item.id === id);
    if (!collection) return;
    const updated = { ...collection, name: name.trim() || collection.name };
    await db.putCollection(updated);
    setCollections((current) => current.map((item) => (item.id === id ? updated : item)));
  }, []);

  const deleteCollection = useCallback(async (id: string) => {
    await db.deleteCollection(id);
    setCollections((current) => current.filter((item) => item.id !== id));
    const affected = latest.current.papers.filter((paper) => paper.collectionIds.includes(id));
    await Promise.all(
      affected.map((paper) =>
        db.putPaper({ ...paper, collectionIds: paper.collectionIds.filter((item) => item !== id) }),
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
      await db.putHighlight(highlight);
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
      await db.putHighlight(updated);
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
      await db.deleteHighlight(id);
      setHighlights((current) => current.filter((item) => item.id !== id));
      latest.current.highlights = latest.current.highlights.filter((item) => item.id !== id);
      if (highlight) queueGitHub(highlight.paperId);
    },
    [queueGitHub],
  );

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const signIn = useCallback(async () => {
    setAuthError(null);
    const clientId = latest.current.settings.googleClientId.trim();
    if (!clientId) {
      setAuthError('Add your Google OAuth client ID in Settings first.');
      return;
    }
    try {
      setUser(await google.signIn(clientId));
      setDriveConnected(google.hasDriveAccess());
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const connectDrive = useCallback(async () => {
    setAuthError(null);
    const clientId = latest.current.settings.googleClientId.trim();
    if (!clientId) {
      setAuthError('Add your Google OAuth client ID in Settings first.');
      return;
    }
    const quiet = localStorage.getItem(DRIVE_KEY) === 'true';
    try {
      setUser(await google.connectDrive(clientId, quiet));
      setDriveConnected(google.hasDriveAccess());
      localStorage.setItem(DRIVE_KEY, 'true');
      setDriveRemembered(true);
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
  }, []);

  const signOut = useCallback(() => {
    google.signOut();
    setUser(null);
    setDriveConnected(false);
    localStorage.removeItem(DRIVE_KEY);
    setDriveRemembered(false);
  }, []);

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
      authError,
      syncLog,
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
      ready, papers, collections, highlights, settings, user, driveConnected, authError, syncLog,
      addPaper, removePaper, setPaperCollections, setReadingStatus, junk, restorePaper, purgeJunk, togglePaperTag, setProgress, markOpened, setPaperPdfUrl, setPaperPdfChoice, setPaperDriveFile, setPaperAuthors,
      createCollection, renameCollection, deleteCollection, addHighlight, updateHighlight,
      deleteHighlight, updateSettings, signIn, connectDrive, driveRemembered, signOut, syncPaper, syncPaperNow, syncAll, syncStateFor,
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
