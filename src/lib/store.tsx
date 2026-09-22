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
import type { Collection, GoogleUser, Highlight, HighlightColor, Paper, PaperRef, Settings } from '../types';
import { COLLECTION_COLORS } from '../types';
import { db } from './db';
import { syncPaperToDrive } from './driveSync';
import * as google from './google';

const SETTINGS_KEY = 'reader.settings';

const defaultSettings: Settings = {
  googleClientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '',
  driveFolderName: 'Paper Reader',
  autoSync: true,
  savePdf: true,
  theme: 'light',
};

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
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

  addPaper: (ref: PaperRef, collectionId?: string) => Promise<Paper>;
  removePaper: (id: string) => Promise<void>;
  setPaperCollections: (id: string, collectionIds: string[]) => Promise<void>;
  togglePaperTag: (id: string, tag: string) => Promise<void>;
  setProgress: (id: string, progress: number) => void;
  markOpened: (id: string) => void;
  /** Remember a PDF link we had to go and find, so the next open is instant. */
  setPaperPdfUrl: (id: string, pdfUrl: string) => Promise<void>;

  createCollection: (name: string) => Promise<Collection>;
  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;

  addHighlight: (highlight: Omit<Highlight, 'id' | 'createdAt'>) => Promise<Highlight>;
  updateHighlight: (id: string, patch: Partial<Highlight>) => Promise<void>;
  deleteHighlight: (id: string) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => void;

  signIn: () => Promise<void>;
  connectDrive: () => Promise<void>;
  signOut: () => void;

  syncPaper: (id: string) => void;
  syncAll: () => void;
  syncStateFor: (id: string) => SyncState;
}

const StoreContext = createContext<StoreValue | null>(null);

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [driveConnected, setDriveConnected] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<SyncEntry[]>([]);

  // Latest-state mirrors so the background sync runner never reads a stale
  // closure while it is working through the queue.
  const latest = useRef({ papers, collections, highlights, settings });
  latest.current = { papers, collections, highlights, settings };

  const queue = useRef<string[]>([]);
  const running = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [loadedPapers, loadedCollections, loadedHighlights] = await Promise.all([
        db.allPapers(),
        db.allCollections(),
        db.allHighlights(),
      ]);
      if (cancelled) return;
      setPapers(loadedPapers);
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
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

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

  const drainQueue = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const paperId = queue.current.shift() as string;
        const paper = latest.current.papers.find((item) => item.id === paperId);
        if (!paper) continue;
        note(paperId, 'running');
        try {
          const result = await syncPaperToDrive(paper, {
            collections: latest.current.collections,
            highlights: latest.current.highlights,
            settings: latest.current.settings,
          });
          const updated: Paper = {
            ...paper,
            drive: {
              folderId: result.folderId,
              pdfFileId: result.pdfFileId,
              metaFileId: result.metaFileId,
              syncedAt: result.syncedAt,
              error: undefined,
            },
          };
          await savePaper(updated);
          note(paperId, 'done', result.notice);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = latest.current.papers.find((item) => item.id === paperId);
          if (current) await savePaper({ ...current, drive: { ...(current.drive || {}), error: message } });
          note(paperId, 'error', message);
        }
      }
    } finally {
      running.current = false;
    }
  }, [note, savePaper]);

  const syncPaper = useCallback(
    (id: string) => {
      if (!driveConnected) return;
      if (!queue.current.includes(id)) queue.current.push(id);
      note(id, 'queued');
      void drainQueue();
    },
    [driveConnected, drainQueue, note],
  );

  const syncAll = useCallback(() => {
    if (!driveConnected) return;
    for (const paper of latest.current.papers) {
      if (!queue.current.includes(paper.id)) queue.current.push(paper.id);
      note(paper.id, 'queued');
    }
    void drainQueue();
  }, [driveConnected, drainQueue, note]);

  const addPaper = useCallback(
    async (ref: PaperRef, collectionId?: string) => {
      const existing = latest.current.papers.find((paper) => paper.id === ref.id);
      const collectionIds = collectionId
        ? Array.from(new Set([...(existing?.collectionIds || []), collectionId]))
        : existing?.collectionIds || [];
      const paper: Paper = {
        ...ref,
        ...(existing || {}),
        ...ref,
        addedAt: existing?.addedAt || new Date().toISOString(),
        collectionIds,
        tags: existing?.tags || [],
        progress: existing?.progress ?? 0,
        lastOpenedAt: existing?.lastOpenedAt,
        drive: existing?.drive,
      };
      await savePaper(paper);
      latest.current.papers = [paper, ...latest.current.papers.filter((item) => item.id !== paper.id)];
      if (settings.autoSync && driveConnected) syncPaper(paper.id);
      return paper;
    },
    [driveConnected, savePaper, settings.autoSync, syncPaper],
  );

  const removePaper = useCallback(async (id: string) => {
    await db.deletePaper(id);
    setPapers((current) => current.filter((paper) => paper.id !== id));
    const toRemove = latest.current.highlights.filter((highlight) => highlight.paperId === id);
    await Promise.all(toRemove.map((highlight) => db.deleteHighlight(highlight.id)));
    setHighlights((current) => current.filter((highlight) => highlight.paperId !== id));
  }, []);

  const setPaperCollections = useCallback(
    async (id: string, collectionIds: string[]) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper) return;
      const updated = { ...paper, collectionIds };
      await savePaper(updated);
      latest.current.papers = latest.current.papers.map((item) => (item.id === id ? updated : item));
      if (settings.autoSync && driveConnected) syncPaper(id);
    },
    [driveConnected, savePaper, settings.autoSync, syncPaper],
  );

  const togglePaperTag = useCallback(
    async (id: string, tag: string) => {
      const paper = latest.current.papers.find((item) => item.id === id);
      if (!paper) return;
      const tags = paper.tags.includes(tag) ? paper.tags.filter((item) => item !== tag) : [...paper.tags, tag];
      await savePaper({ ...paper, tags });
    },
    [savePaper],
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
      return highlight;
    },
    [driveConnected, settings.autoSync, syncPaper],
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
    },
    [driveConnected, settings.autoSync, syncPaper],
  );

  const deleteHighlight = useCallback(async (id: string) => {
    await db.deleteHighlight(id);
    setHighlights((current) => current.filter((item) => item.id !== id));
    latest.current.highlights = latest.current.highlights.filter((item) => item.id !== id);
  }, []);

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
    try {
      setUser(await google.connectDrive(clientId));
      setDriveConnected(google.hasDriveAccess());
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const signOut = useCallback(() => {
    google.signOut();
    setUser(null);
    setDriveConnected(false);
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
      authError,
      syncLog,
      addPaper,
      removePaper,
      setPaperCollections,
      togglePaperTag,
      setProgress,
      markOpened,
      setPaperPdfUrl,
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
      syncAll,
      syncStateFor,
    }),
    [
      ready, papers, collections, highlights, settings, user, driveConnected, authError, syncLog,
      addPaper, removePaper, setPaperCollections, togglePaperTag, setProgress, markOpened, setPaperPdfUrl,
      createCollection, renameCollection, deleteCollection, addHighlight, updateHighlight,
      deleteHighlight, updateSettings, signIn, connectDrive, signOut, syncPaper, syncAll, syncStateFor,
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
