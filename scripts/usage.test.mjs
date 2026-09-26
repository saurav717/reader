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

const { Usage, addTo, aiCounts, report } = await import('../worker/usage.js');
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
    const zero = { claude: 0, claude_in: 0, claude_out: 0, claude_cost: 0, deepseek: 0, deepseek_in: 0, deepseek_out: 0, deepseek_cost: 0, gemini: 0, gemini_in: 0, gemini_out: 0, gemini_cost: 0 };
    assert.deepEqual(days['a@gmail.com'], { signin: 0, scholar: 2, serply: 3, serpapi: 0, browser: 0, pdf: 0, ...zero, last: 2000 });
  });

  it('prices an AI answer from its tokens, in millionths of a dollar', () => {
    // Opus 5: 1,000 in at $5, 2,000 read from the cache at $0.50, 500 written at $6.25, 400 out at $25 per million.
    assert.deepEqual(aiCounts({ provider: 'claude', model: 'claude-opus-5', input: 1000, cacheRead: 2000, cacheWrite: 500, output: 400 }), {
      claude: 1,
      claude_in: 3500,
      claude_out: 400,
      claude_cost: 5000 + 1000 + 3125 + 10000,
      models: { 'claude-opus-5': { n: 1, in: 3500, out: 400, cost: 19125 } },
    });
    assert.equal(aiCounts({ provider: 'deepseek', model: 'deepseek-flash', input: 1_000_000, output: 0 }).deepseek_cost, 280_000);
    assert.equal(aiCounts({ provider: 'deepseek', model: 'unknown', input: 1_000_000 }).deepseek_cost, 280_000, 'an unknown model at the provider’s first price');
    assert.equal(aiCounts({ provider: 'deepseek', input: -5, output: 'x' }).deepseek_in, 0);
    // Gemini: thinking comes in as output; a cached read at a tenth of the input.
    assert.equal(aiCounts({ provider: 'gemini', model: 'gemini-3.8-flash', input: 1_000_000, output: 1_000_000 }).gemini_cost, 4_500_000);
    assert.equal(aiCounts({ provider: 'gemini', model: 'gemini-3.1-pro-preview', cacheRead: 1_000_000 }).gemini_cost, 200_000);
    assert.equal(aiCounts({ provider: 'openai', input: 1 }), null);
  });

  it('keeps each model apart — the variant picked, else the model, else the provider’s "other"', () => {
    const models = (body) => Object.keys(aiCounts({ input: 10, output: 5, ...body }).models);
    assert.deepEqual(models({ provider: 'deepseek', model: 'deepseek-flash', variant: 'deepseek-flash-fast' }), ['deepseek-flash-fast']);
    assert.deepEqual(models({ provider: 'deepseek', model: 'deepseek-flash' }), ['deepseek-flash']);
    assert.deepEqual(models({ provider: 'claude', model: 'claude-sonnet-5', variant: 'made-up' }), ['claude-sonnet-5']);
    assert.deepEqual(models({ provider: 'claude', model: 'anything/at all' }), ['claude-other']);

    const days = {};
    addTo(days, 'a@gmail.com', aiCounts({ provider: 'claude', model: 'claude-haiku-4-5', input: 100, output: 10 }), 1);
    addTo(days, 'a@gmail.com', aiCounts({ provider: 'claude', model: 'claude-haiku-4-5', input: 50, output: 20 }), 2);
    addTo(days, 'a@gmail.com', aiCounts({ provider: 'claude', model: 'claude-opus-5', input: 10, output: 1 }), 3);
    addTo(days, 'a@gmail.com', { scholar: 1, models: { 'bad key!': { n: 5 } } }, 4);
    assert.deepEqual(days['a@gmail.com'].models, {
      'claude-haiku-4-5': { n: 2, in: 150, out: 30, cost: 150 + 150 },
      'claude-opus-5': { n: 1, in: 10, out: 1, cost: 50 + 25 },
    });
    assert.equal(days['a@gmail.com'].claude, 3);

    const now = Date.UTC(2026, 8, 26, 12);
    const out = report({ '2026-09-26': days, '2026-09-25': { 'b@gmail.com': { claude: 1, models: { 'claude-opus-5': { n: 1, in: 5, out: 5, cost: 7 } } } } }, { days: 7, now });
    assert.deepEqual(out.models['claude-opus-5'], { n: 2, in: 15, out: 6, cost: 82 });
    assert.deepEqual(out.people.find((p) => p.email === 'a@gmail.com').daily[0].models['claude-haiku-4-5'].n, 2);
    assert.deepEqual(out.people.find((p) => p.email === 'b@gmail.com').models, { 'claude-opus-5': { n: 1, in: 5, out: 5, cost: 7 } });
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

  it('tallies an AI answer the app reports, priced here — for someone signed in, from this app, and nobody else', async () => {
    const { env } = setup();
    const { pass } = await (await ask(env, '/auth/google', { method: 'POST', headers: { 'X-Google-Token': 'g' } })).json();
    const report = (token, body, origin = SITE) =>
      worker.fetch(
        new Request('https://proxy.example/usage/ai', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
    const answer = { provider: 'deepseek', model: 'deepseek-flash', input: 1000, cacheRead: 9000, output: 500 };
    assert.equal((await report(pass, answer)).status, 200);
    assert.equal((await report(pass, { ...answer, provider: 'claude', model: 'claude-sonnet-5' })).status, 200);
    assert.equal((await report(null, answer)).status, 401);
    assert.equal((await report(pass, answer, 'https://elsewhere.example')).status, 403);
    assert.equal((await report(pass, { provider: 'nobody' })).status, 400);
    await settle();

    const out = await (await usage(env, 'owner-token')).json();
    const labmate = out.people.find((person) => person.email === 'labmate@gmail.com').total;
    assert.equal(labmate.deepseek, 1);
    assert.equal(labmate.deepseek_in, 10000);
    assert.equal(labmate.deepseek_out, 500);
    assert.equal(labmate.deepseek_cost, 280 + 252 + 210);
    assert.equal(labmate.claude, 1);
    assert.equal(labmate.claude_cost, 2000 + 1800 + 5000);
    assert.equal(out.totals.deepseek, 1);
    assert.deepEqual(Object.keys(labmate.models ?? {}), [], 'totals carry no models; the person does');
    const person = out.people.find((p) => p.email === 'labmate@gmail.com');
    assert.deepEqual(Object.keys(person.models).sort(), ['claude-sonnet-5', 'deepseek-flash']);
    assert.equal(out.models['deepseek-flash'].n, 1);
  });
});

const balance = await import('../worker/deepseekBalance.js');

describe('the DeepSeek balance', () => {
  const answer = (total, extra = {}) =>
    Response.json({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '99.00', granted_balance: '0.00', topped_up_balance: '99.00' },
        { currency: 'USD', total_balance: total, granted_balance: '1.00', topped_up_balance: '9.00', ...extra },
      ],
    });

  it('reads the USD balance, in millionths, with the key as a bearer token', async () => {
    const calls = [];
    const read = await balance.readBalance('sk-owner', async (url, init) => {
      calls.push([url, init.headers.Authorization]);
      return answer('10.25');
    });
    assert.deepEqual(calls, [['https://api.deepseek.com/user/balance', 'Bearer sk-owner']]);
    assert.deepEqual(read, { available: true, currency: 'USD', total: 10_250_000, granted: 1_000_000, toppedUp: 9_000_000 });
  });

  it('says why when DeepSeek refuses the key', async () => {
    await assert.rejects(
      balance.readBalance('bad', async () => Response.json({ error: { message: 'Authentication Fails' } }, { status: 401 })),
      /Authentication Fails/,
    );
  });

  it('counts a fall as spent and a rise as added, on the day of the later snapshot', () => {
    const at = (h) => Date.UTC(2026, 8, 26, h);
    const snap = (total) => ({ available: true, currency: 'USD', total, granted: 0, toppedUp: total });
    let stored = balance.addSnapshot(undefined, snap(10_000_000), at(1));
    stored = balance.addSnapshot(stored, snap(9_700_000), at(2));
    stored = balance.addSnapshot(stored, snap(9_650_000), at(3));
    stored = balance.addSnapshot(stored, snap(19_650_000), at(4));
    stored = balance.addSnapshot(stored, snap(19_600_000), at(30));
    assert.deepEqual(stored.days, { '2026-09-26': { spent: 350_000, added: 10_000_000 }, '2026-09-27': { spent: 50_000, added: 0 } });
    assert.equal(stored.last.total, 19_600_000);
    const report = balance.balanceReport(stored, { days: 3, now: at(30) });
    assert.deepEqual(report.days, [
      { day: '2026-09-25', spent: 0, added: 0 },
      { day: '2026-09-26', spent: 350_000, added: 10_000_000 },
      { day: '2026-09-27', spent: 50_000, added: 0 },
    ]);
    // Another currency starts over rather than reading as spending.
    const other = balance.addSnapshot(stored, { ...snap(1), currency: 'CNY' }, at(31));
    assert.deepEqual(other.days, stored.days);
  });
});

describe('the Worker, with DEEPSEEK_KEY', () => {
  const realFetch = globalThis.fetch;
  const SITE = 'https://saurav717.github.io';
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const setup = (totals) => {
    const USAGE = usageBinding();
    const env = { READER_TOKEN: 'owner-token', DEEPSEEK_KEY: 'sk-owner', USAGE };
    const asked = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://api.deepseek.com/user/balance') {
        asked.push(init.headers?.Authorization);
        const total = totals.shift();
        if (total === 'refuse') return Response.json({ error: { message: 'Authentication Fails' } }, { status: 401 });
        return Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: total, granted_balance: '0', topped_up_balance: total }] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    return { env, asked };
  };
  const account = (env, token = 'owner-token') =>
    worker.fetch(new Request('https://proxy.example/usage/deepseek?days=7', { headers: { Origin: SITE, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }), env);

  it('shows the owner the balance, and what it fell by — from the cron and the page alike', async () => {
    const { env, asked } = setup(['5.00', '4.40', '4.10']);
    await worker.scheduled({}, env, { waitUntil() {} });
    await worker.scheduled({}, env, { waitUntil() {} });
    const out = await (await account(env)).json();
    assert.deepEqual(asked, ['Bearer sk-owner', 'Bearer sk-owner', 'Bearer sk-owner']);
    assert.equal(out.configured, true);
    assert.equal(out.balance.total, 4_100_000);
    assert.equal(out.days.length, 7);
    assert.equal(out.days.at(-1).spent, 900_000);
    assert.equal(out.error, undefined);
  });

  it('is the owner’s alone, says when there is no key, and passes on DeepSeek’s refusal', async () => {
    const { env } = setup(['refuse']);
    assert.equal((await account(env, null)).status, 401);
    const refused = await (await account(env)).json();
    assert.equal(refused.configured, true);
    assert.match(refused.error, /Authentication Fails/);
    assert.equal(refused.balance, null);
    delete env.DEEPSEEK_KEY;
    assert.deepEqual(await (await account(env)).json(), { configured: false });
    await worker.scheduled({}, env, { waitUntil() {} }); // nothing to do, and no error
  });
});
