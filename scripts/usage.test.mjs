// Who uses the Worker's paid accounts, and how much: that the Usage object
// tallies per person per day and reports the last N days; that the Worker
// tallies a sign-in, a Scholar ask (with the requests Serply and SerpApi were
// charged for), the browser opened and a file fetched — for a pass by its
// email, for READER_TOKEN as "owner", and for nobody signed out; and that only
// READER_TOKEN may read the tally. Cloudflare's storage is a Map here.
//
//   node --test scripts/usage.test.mjs

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Usage, addTo, report } = await import('../worker/usage.js');
const { default: worker } = await import('../worker/index.js');
const { forgetSerply } = await import('../server/serply.js');
const { forgetResting } = await import('../server/scholarServices.js');

const here = dirname(fileURLToPath(import.meta.url));
const SCHOLAR = await readFile(join(here, 'fixtures', 'serply-scholar.json'), 'utf8');

/** A Durable Object's storage, in memory: get, put, delete, and list by prefix up to an end. */
function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (keys) => [].concat(keys).forEach((key) => map.delete(key)),
    list: async ({ prefix = '', end } = {}) =>
      new Map([...map.entries()].filter(([key]) => key.startsWith(prefix) && (!end || key < end)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** A USAGE binding whose one object is a real Usage over memory storage. */
function usageBinding() {
  const storage = memoryStorage();
  const object = new Usage({ storage });
  return {
    storage,
    idFromName: (name) => name,
    get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }),
  };
}

const record = (object, body) => object.fetch(new Request('https://usage/record', { method: 'POST', body: JSON.stringify(body) }));

describe('the tally', () => {
  it('adds up per person per day, and keeps when they were last seen', () => {
    const days = {};
    addTo(days, 'a@gmail.com', { scholar: 1, serply: 2 }, 1000);
    addTo(days, 'a@gmail.com', { scholar: 1, serply: 1, nonsense: 5, pdf: -3 }, 2000);
    assert.deepEqual(days['a@gmail.com'], { signin: 0, scholar: 2, serply: 3, serpapi: 0, browser: 0, pdf: 0, last: 2000 });
  });

  it('reports the last N days, with today apart, the busiest first', () => {
    const now = Date.UTC(2026, 8, 26, 12);
    const byDay = {
      '2026-09-26': { 'a@gmail.com': { scholar: 2, serply: 2, last: now }, 'b@gmail.com': { scholar: 5, last: now - 1000 } },
      '2026-09-20': { 'a@gmail.com': { scholar: 10, serply: 12, last: now - 6 * 86400000 } },
      '2026-07-01': { 'a@gmail.com': { scholar: 100 } },
    };
    const out = report(byDay, { days: 30, now });
    assert.equal(out.since, '2026-08-28');
    assert.deepEqual(
      out.people.map((person) => [person.email, person.total.scholar, person.today.scholar, person.days]),
      [
        ['a@gmail.com', 12, 2, 2],
        ['b@gmail.com', 5, 5, 1],
      ],
    );
    assert.equal(out.totals.scholar, 17);
    assert.deepEqual(
      out.people[0].daily.map((day) => [day.day, day.scholar]),
      [
        ['2026-09-26', 2],
        ['2026-09-20', 10],
      ],
      'each day apart, newest first',
    );
    assert.equal(out.totals.serply, 14);
  });

  it('is kept by one object, and days past ninety are dropped', async () => {
    const storage = memoryStorage();
    const object = new Usage({ storage });
    await storage.put('day:2026-01-01', { 'old@gmail.com': { scholar: 1 } });
    await record(object, { email: 'A@Gmail.com', counts: { scholar: 1 }, at: Date.UTC(2026, 8, 26) });
    await record(object, { email: 'a@gmail.com', counts: { scholar: 1, serply: 3 }, at: Date.UTC(2026, 8, 26) });
    assert.equal(storage.map.has('day:2026-01-01'), false);
    assert.deepEqual(storage.map.get('day:2026-09-26')['a@gmail.com'].scholar, 2);
    assert.equal((await record(object, { counts: {} })).status, 400);
  });
});

describe('the Worker, tallying', () => {
  const realFetch = globalThis.fetch;
  const CLIENT = 'client.apps.googleusercontent.com';
  const SITE = 'https://saurav717.github.io';
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const settle = () => Promise.all(pending.splice(0));

  const setup = () => {
    const USAGE = usageBinding();
    const env = { READER_TOKEN: 'owner-token', GOOGLE_CLIENT_ID: CLIENT, SERPLY_KEY: 'k', USAGE };
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return Response.json({ aud: CLIENT, email: 'labmate@gmail.com', email_verified: 'true', expires_in: '3000' });
      }
      if (url.startsWith('https://api.serply.io/')) return new Response(SCHOLAR);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    return { env, USAGE };
  };
  const ask = (env, path, init = {}) => worker.fetch(new Request(`https://proxy.example${path}`, { ...init, headers: { Origin: SITE, ...(init.headers || {}) } }), env, ctx);
  const usage = async (env, token) => ask(env, '/usage?days=7', { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  afterEach(() => {
    globalThis.fetch = realFetch;
    forgetSerply();
    forgetResting();
  });

  it('tallies a sign-in and Scholar asks by email, with the credits they cost — and the owner as "owner"', async () => {
    const { env } = setup();
    const { pass } = await (await ask(env, '/auth/google', { method: 'POST', headers: { 'X-Google-Token': 'g' } })).json();
    await ask(env, '/scholar/search?q=one', { headers: { Authorization: `Bearer ${pass}` } });
    await ask(env, '/scholar/search?q=one', { headers: { Authorization: `Bearer ${pass}` } });
    await ask(env, '/scholar/search?q=two', { headers: { Authorization: 'Bearer owner-token' } });
    await ask(env, '/scholar/search?q=nobody');
    await settle();

    const out = await (await usage(env, 'owner-token')).json();
    const byEmail = Object.fromEntries(out.people.map((person) => [person.email, person.total]));
    assert.deepEqual(Object.keys(byEmail).sort(), ['labmate@gmail.com', 'owner']);
    assert.equal(byEmail['labmate@gmail.com'].signin, 1);
    assert.equal(byEmail['labmate@gmail.com'].scholar, 2);
    assert.equal(byEmail['labmate@gmail.com'].serply, 1, 'the second ask came from the cache, and cost nothing');
    assert.equal(byEmail.owner.scholar, 1);
  });

  it('lets READER_TOKEN alone read the tally — not a pass, not nobody', async () => {
    const { env } = setup();
    const { pass } = await (await ask(env, '/auth/google', { method: 'POST', headers: { 'X-Google-Token': 'g' } })).json();
    await settle();
    assert.equal((await usage(env)).status, 401);
    assert.equal((await usage(env, pass)).status, 401);
    assert.equal((await usage(env, 'owner-token')).status, 200);
  });

  it('lets an owner named in READER_OWNERS read it with their Google sign-in — no token to keep', async () => {
    const { env } = setup();
    const { pass } = await (await ask(env, '/auth/google', { method: 'POST', headers: { 'X-Google-Token': 'g' } })).json();
    await settle();
    assert.equal((await usage({ ...env, READER_OWNERS: 'someone-else@gmail.com' }, pass)).status, 401);
    const answer = await usage({ ...env, READER_OWNERS: 'Labmate@gmail.com' }, pass);
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).people[0].email, 'labmate@gmail.com', 'an owner by sign-in is tallied by their email');
  });

  it('says so when no USAGE object is bound', async () => {
    const { env } = setup();
    delete env.USAGE;
    assert.equal((await usage(env, 'owner-token')).status, 501);
  });
});
