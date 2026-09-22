// A very small IndexedDB wrapper. Collections and highlights outgrow the 5 MB
// localStorage budget quickly once a library has a few hundred papers.
import type { Collection, Highlight, Paper } from '../types';

const DB_NAME = 'reader';
const DB_VERSION = 1;

type StoreName = 'papers' | 'collections' | 'highlights' | 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
  return dbPromise;
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

  getKv: <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  setKv: (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key)),
};
