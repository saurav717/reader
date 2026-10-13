/** The database that belongs to no account. */
export const GUEST_DB = 'reader';
const DB_VERSION = 1;
/** The database an account's copy of its library lives in. */
export function accountDbName(email) {
    const key = (email || '').trim().toLowerCase();
    return key ? `${GUEST_DB}:${key}` : GUEST_DB;
}
let current = GUEST_DB;
let dbPromise = null;
function openNamed(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('papers'))
                db.createObjectStore('papers', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('collections'))
                db.createObjectStore('collections', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('highlights')) {
                const store = db.createObjectStore('highlights', { keyPath: 'id' });
                store.createIndex('paperId', 'paperId', { unique: false });
            }
            if (!db.objectStoreNames.contains('kv'))
                db.createObjectStore('kv');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function open() {
    dbPromise ??= openNamed(current);
    return dbPromise;
}
/**
 * Point every read and write from here on at `email`'s database, or at the
 * one that belongs to nobody for null. Whatever was open is closed once the
 * requests already made on it have finished.
 */
export function switchDb(email) {
    const name = accountDbName(email);
    if (name === current)
        return;
    const previous = dbPromise;
    current = name;
    dbPromise = null;
    void previous?.then((db) => db.close()).catch(() => undefined);
}
export function currentDbName() {
    return current;
}
function run(store, mode, body) {
    return open().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = body(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}
/** Every record of one store, all at once, in a single transaction. */
function replaceAll(store, items) {
    return open().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        const objects = transaction.objectStore(store);
        objects.clear();
        for (const item of items)
            objects.put(item);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    }));
}
/** A read of a database other than the current one, closed again after. */
async function readOther(name, read) {
    const other = await openNamed(name);
    try {
        return await read(other);
    }
    finally {
        other.close();
    }
}
function getAllFrom(db, store) {
    return new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function entriesFrom(db) {
    return new Promise((resolve, reject) => {
        const found = [];
        const request = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor)
                return resolve(found);
            found.push([String(cursor.key), cursor.value]);
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
}
export const db = {
    allPapers: () => run('papers', 'readonly', (s) => s.getAll()),
    allCollections: () => run('collections', 'readonly', (s) => s.getAll()),
    allHighlights: () => run('highlights', 'readonly', (s) => s.getAll()),
    putPaper: (paper) => run('papers', 'readwrite', (s) => s.put(paper)),
    deletePaper: (id) => run('papers', 'readwrite', (s) => s.delete(id)),
    putCollection: (collection) => run('collections', 'readwrite', (s) => s.put(collection)),
    deleteCollection: (id) => run('collections', 'readwrite', (s) => s.delete(id)),
    putHighlight: (highlight) => run('highlights', 'readwrite', (s) => s.put(highlight)),
    deleteHighlight: (id) => run('highlights', 'readwrite', (s) => s.delete(id)),
    /** The whole library at once — what came down from Drive takes the place of the copy here. */
    replaceLibrary: (library) => Promise.all([
        replaceAll('papers', library.papers),
        replaceAll('collections', library.collections),
        replaceAll('highlights', library.highlights),
    ]).then(() => undefined),
    getKv: (key) => run('kv', 'readonly', (s) => s.get(key)),
    setKv: (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)),
    deleteKv: (key) => run('kv', 'readwrite', (s) => s.delete(key)),
    /** Every value whose key starts with `prefix`, with its key. */
    kvWithPrefix: (prefix) => open().then((db) => new Promise((resolve, reject) => {
        const found = [];
        const request = db.transaction('kv', 'readonly').objectStore('kv').openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor)
                return resolve(found);
            found.push([String(cursor.key), cursor.value]);
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    })),
    /** What the database that belongs to nobody holds — the library from before it was tied to an account. */
    guestContents: () => readOther(GUEST_DB, async (guest) => {
        const [papers, collections, highlights, kv] = await Promise.all([
            getAllFrom(guest, 'papers'),
            getAllFrom(guest, 'collections'),
            getAllFrom(guest, 'highlights'),
            entriesFrom(guest),
        ]);
        return { papers, collections, highlights, kv };
    }),
    /** Takes papers out of the database that belongs to nobody, once an account has taken them. */
    forgetGuestPapers: (ids, highlightIds, kvKeys) => readOther(GUEST_DB, (guest) => new Promise((resolve, reject) => {
        const transaction = guest.transaction(['papers', 'highlights', 'kv'], 'readwrite');
        for (const id of ids)
            transaction.objectStore('papers').delete(id);
        for (const id of highlightIds)
            transaction.objectStore('highlights').delete(id);
        for (const key of kvKeys)
            transaction.objectStore('kv').delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    })),
};
