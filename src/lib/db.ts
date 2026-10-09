// A very small IndexedDB wrapper. Collections and highlights outgrow the 5 MB
// localStorage budget quickly once a library has a few hundred papers.
//
// The database is one per Google account: what is kept here is that account's
// copy of its library, the one in its Drive (library.json, see
// driveLibrary.ts) being the record. Signed out, the app reads the database
// it always used, `reader`, which belongs to nobody — on a build behind the
// sign-in it is never shown, and what it still holds from before libraries
// were tied to accounts is offered to an account only once that account can
// show it is its own (see `strays` in store.tsx).
import type { Collection, Highlight, Paper } from '../types';

/** The database that belongs to no account. */
export const GUEST_DB = 'reader';
const DB_VERSION = 1;

type StoreName = 'papers' | 'collections' | 'highlights' | 'kv';

/** The database an account's copy of its library lives in. */
export function accountDbName(email: string | null | undefined): string {
  const key = (email || '').trim().toLowerCase();
  return key ? `${GUEST_DB}:${key}` : GUEST_DB;
}

let current = GUEST_DB;
let dbPromise: Promise<IDBDatabase> | null = null;

function openNamed(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('papers')) db.createObjectStore('papers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('highlights')) {
        const store = db.createObjectStore('highlights', { keyPath: 'id' });
        store.createIndex('paperId', 'paperId', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open(): Promise<IDBDatabase> {
  dbPromise ??= openNamed(current);
  return dbPromise;
}

/**
 * Point every read and write from here on at `email`'s database, or at the
 * one that belongs to nobody for null. Whatever was open is closed once the
 * requests already made on it have finished.
 */
export function switchDb(email: string | null | undefined): void {
  const name = accountDbName(email);
  if (name === current) return;
  const previous = dbPromise;
  current = name;
  dbPromise = null;
  void previous?.then((db) => db.close()).catch(() => undefined);
}

export function currentDbName(): string {
  return current;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = body(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

/** Every record of one store, all at once, in a single transaction. */
function replaceAll<T>(store: 'papers' | 'collections' | 'highlights', items: T[]): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        const objects = transaction.objectStore(store);
        objects.clear();
        for (const item of items) objects.put(item);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

/** A read of a database other than the current one, closed again after. */
async function readOther<T>(name: string, read: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const other = await openNamed(name);
  try {
    return await read(other);
  } finally {
    other.close();
  }
}

function getAllFrom<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function entriesFrom(db: IDBDatabase): Promise<[string, unknown][]> {
  return new Promise((resolve, reject) => {
    const found: [string, unknown][] = [];
    const request = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(found);
      found.push([String(cursor.key), cursor.value]);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export interface GuestContents {
  papers: Paper[];
  collections: Collection[];
  highlights: Highlight[];
  kv: [string, unknown][];
}

export const db = {
  allPapers: () => run<Paper[]>('papers', 'readonly', (s) => s.getAll() as IDBRequest<Paper[]>),
  allCollections: () => run<Collection[]>('collections', 'readonly', (s) => s.getAll() as IDBRequest<Collection[]>),
  allHighlights: () => run<Highlight[]>('highlights', 'readonly', (s) => s.getAll() as IDBRequest<Highlight[]>),

  putPaper: (paper: Paper) => run('papers', 'readwrite', (s) => s.put(paper)),
  deletePaper: (id: string) => run('papers', 'readwrite', (s) => s.delete(id)),

  putCollection: (collection: Collection) => run('collections', 'readwrite', (s) => s.put(collection)),
  deleteCollection: (id: string) => run('collections', 'readwrite', (s) => s.delete(id)),

  putHighlight: (highlight: Highlight) => run('highlights', 'readwrite', (s) => s.put(highlight)),
  deleteHighlight: (id: string) => run('highlights', 'readwrite', (s) => s.delete(id)),

  /** The whole library at once — what came down from Drive takes the place of the copy here. */
  replaceLibrary: (library: { papers: Paper[]; collections: Collection[]; highlights: Highlight[] }) =>
    Promise.all([
      replaceAll('papers', library.papers),
      replaceAll('collections', library.collections),
      replaceAll('highlights', library.highlights),
    ]).then(() => undefined),

  getKv: <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  setKv: (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key)),
  deleteKv: (key: string) => run('kv', 'readwrite', (s) => s.delete(key)),
  /** Every value whose key starts with `prefix`, with its key. */
  kvWithPrefix: <T>(prefix: string) =>
    open().then(
      (db) =>
        new Promise<[string, T][]>((resolve, reject) => {
          const found: [string, T][] = [];
          const request = db.transaction('kv', 'readonly').objectStore('kv').openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve(found);
            found.push([String(cursor.key), cursor.value as T]);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        }),
    ),

  /** What the database that belongs to nobody holds — the library from before it was tied to an account. */
  guestContents: (): Promise<GuestContents> =>
    readOther(GUEST_DB, async (guest) => {
      const [papers, collections, highlights, kv] = await Promise.all([
        getAllFrom<Paper>(guest, 'papers'),
        getAllFrom<Collection>(guest, 'collections'),
        getAllFrom<Highlight>(guest, 'highlights'),
        entriesFrom(guest),
      ]);
      return { papers, collections, highlights, kv };
    }),

  /** Takes papers out of the database that belongs to nobody, once an account has taken them. */
  forgetGuestPapers: (ids: string[], highlightIds: string[], kvKeys: string[]) =>
    readOther(
      GUEST_DB,
      (guest) =>
        new Promise<void>((resolve, reject) => {
          const transaction = guest.transaction(['papers', 'highlights', 'kv'], 'readwrite');
          for (const id of ids) transaction.objectStore('papers').delete(id);
          for (const id of highlightIds) transaction.objectStore('highlights').delete(id);
          for (const key of kvKeys) transaction.objectStore('kv').delete(key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        }),
    ),
};
