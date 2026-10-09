// The computers an account has connected (worker/devices.js): that a Companion
// claims a row with a page's pass and keeps it current with the secret it got;
// that only that account's pass lists it, with no secret hash; that a beat
// with the wrong secret, or for another account, changes nothing; and that
// /me says whose a pass is. Cloudflare's storage is a Map here.
//
//   node --test scripts/devices.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { Devices, safeUrl } = await import('../worker/devices.js');
const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix))),
  };
}

/** A DEVICES binding: one real Devices object per name, over memory storage. */
function devicesBinding() {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) objects.set(name, new Devices({ storage: memoryStorage() }));
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
}

const SECRET = 'owner-token';
const env = () => ({ READER_TOKEN: SECRET, DEVICES: devicesBinding() });
const call = (e, path, { pass, body, origin } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil() {} },
  );

describe('devices', () => {
  it('says whose a pass is, and nobody’s without one', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    assert.deepEqual(await (await call(e, '/me', { pass })).json(), { email: 'a@gmail.com' });
    assert.equal((await call(e, '/me')).status, 401);
  });

  it('lists a claimed computer for its account only, as its beats say, with no secret', async () => {
    const e = env();
    const a = await issuePass('a@gmail.com', SECRET);
    const b = await issuePass('b@gmail.com', SECRET);
    const claimed = await (await call(e, '/devices/claim', { pass: a, body: { id: 'abcdef0123456789', name: 'Mac', hardware: 'Apple Silicon (mps)' } })).json();
    assert.equal(claimed.email, 'a@gmail.com');
    assert.match(claimed.secret, /^[0-9a-f]{64}$/);

    const beat = (body) => call(e, '/devices/beat', { body: { email: 'a@gmail.com', id: 'abcdef0123456789', ...body } });
    assert.equal((await beat({ secret: 'wrong', url: 'https://x.trycloudflare.com/', token: 't' })).status, 403);
    assert.equal((await beat({ secret: claimed.secret, url: 'https://x.trycloudflare.com/', local: 'http://127.0.0.1:47321/', token: 'tok' })).status, 200);
    // Another account's list has no such row to beat.
    assert.equal((await call(e, '/devices/beat', { body: { email: 'b@gmail.com', id: 'abcdef0123456789', secret: claimed.secret } })).status, 403);

    const mine = (await (await call(e, '/devices', { pass: a })).json()).devices;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].url, 'https://x.trycloudflare.com/');
    assert.equal(mine[0].local, 'http://127.0.0.1:47321/');
    assert.equal(mine[0].token, 'tok');
    assert.equal(mine[0].online, true);
    assert.equal('secretHash' in mine[0], false);
    assert.deepEqual((await (await call(e, '/devices', { pass: b })).json()).devices, []);
    assert.equal((await call(e, '/devices')).status, 401);

    await beat({ secret: claimed.secret, off: true, url: 'https://x.trycloudflare.com/', token: 'tok' });
    assert.equal((await (await call(e, '/devices', { pass: a })).json()).devices[0].online, false);

    // Released on the computer: the Companion takes itself off the list with its secret.
    assert.equal((await beat({ secret: 'wrong', forget: true })).status, 403);
    assert.equal((await (await call(e, '/devices', { pass: a })).json()).devices.length, 1);
    assert.equal((await beat({ secret: claimed.secret, forget: true })).status, 200);
    assert.deepEqual((await (await call(e, '/devices', { pass: a })).json()).devices, []);

    await call(e, '/devices/forget', { pass: a, body: { id: 'abcdef0123456789' } });
    assert.deepEqual((await (await call(e, '/devices', { pass: a })).json()).devices, []);
  });

  it('keeps only an https address or this computer’s own', () => {
    assert.equal(safeUrl('https://x.trycloudflare.com/'), 'https://x.trycloudflare.com/');
    assert.equal(safeUrl('http://127.0.0.1:47321/'), 'http://127.0.0.1:47321/');
    assert.equal(safeUrl('http://evil.example/'), '');
    assert.equal(safeUrl('javascript:alert(1)'), '');
  });

  it('says so when the Worker has no DEVICES object', async () => {
    const pass = await issuePass('a@gmail.com', SECRET);
    assert.equal((await call({ READER_TOKEN: SECRET }, '/devices', { pass })).status, 501);
  });
});
