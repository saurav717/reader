// The explanation and the implementation plan, kept in the browser's database
// across the sign-in: the app opens on nobody's database and moves to the
// account's once the sign-in comes back, and a page read or written before
// that move is not lost behind it.
//
//   node --test scripts/explain-kept.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadTogether } from './bundle.mjs';

// Just enough of IndexedDB for the key-value store: one Map per database.
const databases = new Map();
const later = (request, result) => setTimeout(() => ((request.result = result), request.onsuccess?.()), 0);
globalThis.indexedDB = {
  open(name) {
    const request = {};
    setTimeout(() => {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const stores = databases.get(name);
      request.result = {
        objectStoreNames: { contains: (store) => stores.has(store) },
        createObjectStore: (store) => (stores.set(store, new Map()), { createIndex() {} }),
        close() {},
        transaction: (store) => ({
          objectStore: () => ({
            get: (key) => {
              const req = {};
              later(req, structuredClone(stores.get(store).get(key)));
              return req;
            },
            put: (value, key) => {
              const req = {};
              stores.get(store).set(key, structuredClone(value));
              later(req, key);
              return req;
            },
          }),
        }),
      };
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);
    return request;
  },
};
globalThis.window ??= globalThis;

const lib = await loadTogether(['src/lib/db.ts', 'src/lib/explain.ts', 'src/lib/implement.ts'], { external: ['@anthropic-ai/sdk'] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

after(cleanup);

const page = (paperId, content, updated) => ({ paperId, content, model: 'claude-opus-5-5', created: 1, updated });

describe('a page kept in the account’s database', () => {
  it('is read when the database moves to the account after the page was first looked for', async () => {
    lib.switchDb('reader@example.com');
    await lib.db.setKv('explain:p1', page('p1', '# Kept explanation', 100));
    await lib.db.setKv('implement:p1', page('p1', '# Kept plan', 100));

    // Explain opened before the sign-in came back: nobody's database has nothing.
    lib.switchDb(null);
    assert.equal(await lib.loadExplanation('p1'), undefined);
    assert.equal(await lib.loadImplementation('p1'), undefined);

    // The sign-in comes back; the page is looked for again.
    lib.switchDb('reader@example.com');
    assert.equal((await lib.loadExplanation('p1'))?.content, '# Kept explanation');
    assert.equal((await lib.loadImplementation('p1'))?.content, '# Kept plan');
  });

  it('takes the account’s copy over an older one read from nobody’s database', async () => {
    lib.switchDb(null);
    await lib.db.setKv('implement:p2', page('p2', '# Old plan', 50));
    assert.equal((await lib.loadImplementation('p2'))?.content, '# Old plan');

    lib.switchDb('reader@example.com');
    await lib.db.setKv('implement:p2', page('p2', '# Newer plan', 200));
    assert.equal((await lib.loadImplementation('p2'))?.content, '# Newer plan');
  });
});

describe('a page written before the sign-in came back', () => {
  it('is written into the account’s database too, rather than left behind in nobody’s', async () => {
    lib.switchDb(null);
    lib.putImplementation(page('p3', '# Written while signed out'));
    await settle();

    lib.switchDb('reader@example.com');
    assert.equal((await lib.loadImplementation('p3'))?.content, '# Written while signed out');
    await settle();
    assert.equal((await lib.db.getKv('implement:p3'))?.content, '# Written while signed out');
  });
});
