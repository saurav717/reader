// The kernels and runs an account has going (worker/kernels.js): that a
// browser's row is kept per scope under the account's pass and read back by
// another browser of the same account, and by no one else; that the newest
// word wins when two browsers write; that a row is bounded and cleaned; and
// that dropping and erasing take rows away. Cloudflare's storage is a Map.
//
//   node --test scripts/kernels.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { Kernels, cleanRecord, MAX_RUNS, STALE_MS } = await import('../worker/kernels.js');
const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    deleteAll: async () => void map.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix))),
  };
}

/** A KERNELS binding: one real Kernels object per name, over memory storage. */
function kernelsBinding() {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) objects.set(name, new Kernels({ storage: memoryStorage() }));
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
}

const SECRET = 'owner-token';
const env = () => ({ READER_TOKEN: SECRET, KERNELS: kernelsBinding() });
const call = (e, path, { pass, body } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil() {} },
  );

const row = (scope, extra = {}) => ({
  scope,
  endpoint: 'https://colab.example/tun/abc',
  kernels: { [scope]: 'k-1', '#monitor': 'k-m' },
  runs: { 'pgsh:p1:c1': { startedAt: Date.now() - 60_000, state: 'running', msgId: 'm-1', kernelId: 'k-1', where: 'Colab · T4', log: '/content/playgrounds/x/.reader/runs/c1.log' } },
  updatedAt: Date.now(),
  by: 'Chrome on a Mac',
  ...extra,
});

describe('the account’s kernels', () => {
  it('keeps a row per scope for the account, and another browser of the account reads it back', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const put = await call(e, '/kernels/put', { pass, body: row('p1') });
    assert.equal(put.status, 200);
    const other = await issuePass('a@gmail.com', SECRET);
    const list = await (await call(e, '/kernels', { pass: other })).json();
    assert.equal(list.kernels.length, 1);
    assert.equal(list.kernels[0].scope, 'p1');
    assert.deepEqual(list.kernels[0].kernels, { p1: 'k-1', '#monitor': 'k-m' });
    assert.equal(list.kernels[0].runs['pgsh:p1:c1'].msgId, 'm-1');
    assert.equal(list.kernels[0].runs['pgsh:p1:c1'].log, '/content/playgrounds/x/.reader/runs/c1.log');
  });

  it('shows nothing to another account, and nothing without a pass', async () => {
    const e = env();
    await call(e, '/kernels/put', { pass: await issuePass('a@gmail.com', SECRET), body: row('p1') });
    const theirs = await (await call(e, '/kernels', { pass: await issuePass('b@gmail.com', SECRET) })).json();
    assert.deepEqual(theirs.kernels, []);
    assert.equal((await call(e, '/kernels')).status, 401);
    assert.equal((await call(e, '/kernels/put', { body: row('p1') })).status, 401);
  });

  it('lets the newest word win when two browsers write the same scope', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const now = Date.now();
    await call(e, '/kernels/put', { pass, body: row('p1', { updatedAt: now, kernels: { p1: 'new' } }) });
    const older = await (await call(e, '/kernels/put', { pass, body: row('p1', { updatedAt: now - 5000, kernels: { p1: 'old' } }) })).json();
    assert.equal(older.kept.kernels.p1, 'new');
    const list = await (await call(e, '/kernels', { pass })).json();
    assert.equal(list.kernels[0].kernels.p1, 'new');
  });

  it('drops a row on request, and every row when the account is erased', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/kernels/put', { pass, body: row('p1') });
    await call(e, '/kernels/put', { pass, body: row('p1#m1') });
    await call(e, '/kernels/drop', { pass, body: { scope: 'p1#m1' } });
    assert.equal((await (await call(e, '/kernels', { pass })).json()).kernels.length, 1);
    const object = e.KERNELS.get('kernels:a@gmail.com');
    const erased = await (await object.fetch('https://kernels/erase', { method: 'POST', body: '{}' })).json();
    assert.equal(erased.scopes, 1);
    assert.deepEqual((await (await call(e, '/kernels', { pass })).json()).kernels, []);
  });

  it('forgets a row nobody has touched in two days', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/kernels/put', { pass, body: row('p1', { updatedAt: Date.now() - STALE_MS - 1 }) });
    assert.deepEqual((await (await call(e, '/kernels', { pass })).json()).kernels, []);
  });
});

describe('what a row may hold', () => {
  it('refuses a row with no scope or no machine, and keeps strings bounded', () => {
    assert.equal(cleanRecord({ endpoint: 'x' }), null);
    assert.equal(cleanRecord({ scope: 'p1' }), null);
    assert.equal(cleanRecord({ scope: 'bad scope!', endpoint: 'x' }), null);
    const cleaned = cleanRecord({ scope: 'p1#m1', endpoint: 'e', kernels: { p1: 'k'.repeat(500) }, runs: {}, by: 'b'.repeat(500) });
    assert.equal(cleaned.kernels.p1.length, 120);
    assert.equal(cleaned.by.length, 80);
  });

  it('keeps the newest runs only, and only what a run is made of', () => {
    const runs = {};
    for (let i = 0; i < MAX_RUNS + 10; i += 1) runs[`k${i}`] = { startedAt: 1000 + i, state: 'done', msgId: `m${i}`, kernelId: 'k', where: 'w', secret: 'no' };
    const cleaned = cleanRecord({ scope: 'p1', endpoint: 'e', runs });
    assert.equal(Object.keys(cleaned.runs).length, MAX_RUNS);
    assert.ok(cleaned.runs[`k${MAX_RUNS + 9}`]);
    assert.equal(cleaned.runs.k0, undefined);
    assert.equal('secret' in cleaned.runs[`k${MAX_RUNS + 9}`], false);
    // A run that never started is no run.
    assert.deepEqual(cleanRecord({ scope: 'p1', endpoint: 'e', runs: { x: { state: 'running' } } }).runs, {});
  });
});
