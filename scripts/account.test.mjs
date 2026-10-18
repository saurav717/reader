// "Delete my account" (worker/account.js, the /account route in
// worker/index.js): that GET says what is kept about the account signed in;
// that deleting takes a Google token for the same account, not a pass alone;
// and that it then leaves nothing of that account anywhere — a room it owned
// closed and off everyone's list, someone else's room without it and without
// its address on what it wrote, the ledger, the tally, its computers and its
// GitHub record gone — while the other person's things stay. Cloudflare's
// storage, KV and Google's tokeninfo are stand-ins here.
//
//   node --test scripts/account.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { default: worker } = await import('../worker/index.js');
const { ProjectRoom } = await import('../worker/projectRoom.js');
const { Invites } = await import('../worker/invites.js');
const { Usage } = await import('../worker/usage.js');
const { Devices } = await import('../worker/devices.js');
const { issuePass } = await import('../server/passes.js');
const { secretsKey } = await import('../worker/secrets.js');

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (keys) => {
      for (const key of [keys].flat()) map.delete(key);
    },
    deleteAll: async () => map.clear(),
    list: async ({ prefix = '', end } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end)).map(([key, value]) => [key, structuredClone(value)])),
  };
}

function binding(Class) {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) {
        const sockets = [];
        objects.set(name, new Class({ storage: memoryStorage(), acceptWebSocket: (socket) => sockets.push(socket), getWebSockets: () => sockets }, {}));
      }
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)), object };
    },
  };
}

function kv() {
  const map = new Map();
  return { map, get: async (key) => map.get(key) ?? null, put: async (key, value) => void map.set(key, value), delete: async (key) => void map.delete(key) };
}

const SECRET = 'owner-token';
const CLIENT_ID = 'client.apps.googleusercontent.com';
const ORIGIN = 'https://koios.dev';
const env = () => ({ READER_TOKEN: SECRET, GOOGLE_CLIENT_ID: CLIENT_ID, SECRETS_KEY: 'k'.repeat(44), SESSIONS: kv(), ROOMS: binding(ProjectRoom), INVITES: binding(Invites), USAGE: binding(Usage), DEVICES: binding(Devices) });
const call = (e, path, { pass, body, method, google } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { Origin: ORIGIN, ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(google ? { 'X-Google-Token': google } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil() {} },
  );

// Google's tokeninfo: a token named "google:<email>" is that account's, for this app.
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const asked = new URL(String(url));
    if (asked.hostname === 'oauth2.googleapis.com' || asked.hostname === 'www.googleapis.com') {
      const token = asked.searchParams.get('access_token') || '';
      if (!token.startsWith('google:')) return new Response('{}', { status: 400 });
      return Response.json({ aud: CLIENT_ID, email: token.slice('google:'.length), email_verified: 'true', expires_in: '3000' });
    }
    return realFetch(url, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const project = (id, name) => ({ id, name, color: '#1f5e52', question: 'Why?', startedAt: '2026-01-01T00:00:00.000Z', papers: [], todos: [] });

/** Two people, each in the other's shared project, with a note, a tally, a computer and a GitHub record. */
async function twoPeople() {
  const e = env();
  const omar = await issuePass('omar@x.org', SECRET);
  const dana = await issuePass('dana@x.org', SECRET);
  const share = async (pass, proj, invitee) => {
    const room = (await (await call(e, '/rooms', { pass, body: { project: proj, name: 'n' } })).json()).room;
    await call(e, `/rooms/${room}/invite`, { pass, body: { email: invitee, role: 'editor' } });
    return room;
  };
  const omarsRoom = await share(omar, project('p1', 'Omar’s project'), 'dana@x.org');
  await call(e, `/rooms/${omarsRoom}/join`, { pass: dana, body: { name: 'Dana' } });
  await call(e, `/rooms/${omarsRoom}/log`, { pass: dana, body: { op: 'note', note: { id: 'n1', title: 'Standup', start: '2026-10-01T09:00:00.000Z', attendees: ['dana@x.org', 'omar@x.org'], markdown: 'notes' } } });
  const danasRoom = await share(dana, project('p2', 'Dana’s project'), 'omar@x.org');
  await call(e, `/rooms/${danasRoom}/join`, { pass: omar, body: { name: 'Omar' } });
  const usage = e.USAGE.get('usage');
  for (const email of ['dana@x.org', 'omar@x.org']) await usage.fetch('https://usage/record', { method: 'POST', body: JSON.stringify({ email, counts: { signin: 1 } }) });
  await call(e, '/devices/claim', { pass: dana, body: { id: 'abcdef0123456789', name: 'Mac' } });
  await e.SESSIONS.put(await secretsKey(e, 'github', 'dana@x.org'), JSON.stringify({ via: 'token' }));
  await e.SESSIONS.put(await secretsKey(e, 'github', 'omar@x.org'), JSON.stringify({ via: 'token' }));
  return { e, omar, dana, omarsRoom, danasRoom };
}

describe('deleting an account', () => {
  it('says first what is kept about the account', async () => {
    const { e, dana } = await twoPeople();
    const summary = await (await call(e, '/account', { pass: dana })).json();
    assert.equal(summary.email, 'dana@x.org');
    assert.deepEqual(summary.owned.map((r) => r.project), ['Dana’s project']);
    assert.deepEqual(summary.joined.map((r) => r.project), ['Omar’s project']);
    assert.equal(summary.devices, 1);
    assert.equal(summary.usageDays, 1);
    assert.equal(summary.invitationsSent, 1);
    assert.equal(summary.github, true);
    assert.equal(summary.overleaf, false);
  });

  it('takes a Google token for the same account, not a pass alone', async () => {
    const { e, dana } = await twoPeople();
    assert.equal((await call(e, '/account', { pass: dana, method: 'DELETE' })).status, 403);
    assert.equal((await call(e, '/account', { pass: dana, method: 'DELETE', google: 'google:omar@x.org' })).status, 403);
    assert.equal((await call(e, '/account', { method: 'DELETE', google: 'google:dana@x.org' })).status, 401);
    assert.equal((await call(e, '/account', { pass: dana, method: 'DELETE', google: 'google:dana@x.org' })).status, 200);
  });

  it('then leaves nothing of the account, and the other person’s things as they were', async () => {
    const { e, omar, dana, omarsRoom, danasRoom } = await twoPeople();
    const done = await (await call(e, '/account', { pass: dana, method: 'DELETE', google: 'google:dana@x.org' })).json();
    assert.equal(done.ok, true);
    assert.equal(done.closed, 1);
    assert.equal(done.left, 1);

    // Dana's own room is closed, for Omar too, and off his list.
    assert.equal((await call(e, `/rooms/${danasRoom}`, { pass: omar })).status, 404);
    const omarsRooms = await (await call(e, '/rooms/mine', { pass: omar })).json();
    assert.deepEqual(omarsRooms.rooms.map((r) => r.room), [omarsRoom]);

    // Omar's room goes on without her; her note stays, without her address.
    const state = await (await call(e, `/rooms/${omarsRoom}`, { pass: omar })).json();
    assert.deepEqual(state.members.map((m) => m.email), ['omar@x.org']);
    const log = await (await call(e, `/rooms/${omarsRoom}/log`, { pass: omar })).json();
    assert.equal(log.notes[0].by, '');
    assert.deepEqual(log.notes[0].attendees, ['omar@x.org']);
    const roomStore = JSON.stringify([...e.ROOMS.objects.get(`room:${omarsRoom}`).state.storage.map]);
    assert.doesNotMatch(roomStore, /dana@x\.org/);

    // Nothing in the ledger, the tally, her computers or KV names her.
    assert.doesNotMatch(JSON.stringify([...e.INVITES.objects.get('invites').state.storage.map]), /dana@x\.org/);
    const usage = JSON.stringify([...e.USAGE.objects.get('usage').state.storage.map]);
    assert.doesNotMatch(usage, /dana@x\.org/);
    assert.match(usage, /omar@x\.org/);
    assert.equal(e.DEVICES.objects.get('devices:dana@x.org').state.storage.map.size, 0);
    assert.equal(await e.SESSIONS.get(await secretsKey(e, 'github', 'dana@x.org')), null);
    assert.notEqual(await e.SESSIONS.get(await secretsKey(e, 'github', 'omar@x.org')), null);

    // And a second time there is nothing left to do.
    const again = await (await call(e, '/account', { pass: dana })).json();
    assert.deepEqual([again.owned, again.joined, again.devices, again.usageDays, again.github], [[], [], 0, 0, false]);
  });
});
