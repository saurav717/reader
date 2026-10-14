// The Cloudflare tab of the Usage page (worker/cloudflare.js): that each
// dataset is asked of Cloudflare's GraphQL API on its own and summed by day
// against the Free plan's allowances, that one Cloudflare refuses blanks only
// its own meters, that the browser's time is counted from its sessions across
// midnight UTC, and that the route is the owner's alone. Cloudflare is a fake.
//
//   node --test scripts/cloudflare.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const cloudflare = await import('../worker/cloudflare.js');
const { default: worker } = await import('../worker/index.js');

const NOW = Date.parse('2026-10-14T15:00:00Z');
const ENV = { CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'acc123', BROWSER: {} };

const rows = (list) => Response.json({ data: { viewer: { accounts: [{ rows: list }] } } });

/** A fake GraphQL endpoint: answers by the dataset each query names. */
function fakeCloudflare(answers) {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    const dataset = /rows: (\w+)/.exec(body.query)[1];
    asked.push({ url: String(url), dataset, variables: body.variables, auth: init.headers.Authorization });
    const answer = answers[dataset];
    return typeof answer === 'function' ? answer(body) : rows(answer || []);
  };
  return { fetcher, asked };
}

const driver = (history = [], sessions = [], limits = { activeSessions: [], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 3, timeUntilNextAllowedBrowserAcquisition: 0 }) => ({
  history: async () => history,
  sessions: async () => sessions,
  limits: async () => limits,
});

const ANSWERS = {
  workersInvocationsAdaptive: [
    { sum: { requests: 40_000, errors: 3 }, dimensions: { date: '2026-10-14' } },
    { sum: { requests: 1_000, errors: 0 }, dimensions: { date: '2026-10-13' } },
    { sum: { requests: 2_000, errors: 0 }, dimensions: { date: '2026-10-14' } },
  ],
  durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 500 }, dimensions: { date: '2026-10-14' } }],
  durableObjectsPeriodicGroups: [{ sum: { activeTime: 80_000_000, rowsRead: 1000, rowsWritten: 95_000 }, dimensions: { date: '2026-10-14' } }],
  durableObjectsStorageGroups: [{ max: { storedBytes: 2048 }, dimensions: { date: '2026-10-13' } }],
  kvOperationsAdaptiveGroups: [
    { sum: { requests: 900 }, dimensions: { date: '2026-10-14', actionType: 'write' } },
    { sum: { requests: 70 }, dimensions: { date: '2026-10-14', actionType: 'read' } },
  ],
  kvStorageAdaptiveGroups: [
    { max: { byteCount: 100 }, dimensions: { date: '2026-10-14', namespaceId: 'a' } },
    { max: { byteCount: 50 }, dimensions: { date: '2026-10-14', namespaceId: 'b' } },
  ],
};

const byId = (overview) => Object.fromEntries(overview.meters.map((meter) => [meter.id, meter]));

describe('cloudflareOverview', () => {
  it('asks each dataset for the last seven days, with the token, and sums each meter by day', async () => {
    const { fetcher, asked } = fakeCloudflare(ANSWERS);
    const overview = await cloudflare.cloudflareOverview(ENV, fetcher, NOW, driver());
    assert.equal(overview.configured, true);
    assert.equal(overview.day, '2026-10-14');
    assert.equal(overview.resetsInMs, 9 * 3600_000);
    assert.equal(asked.length, 6);
    for (const ask of asked) {
      assert.equal(ask.url, 'https://api.cloudflare.com/client/v4/graphql');
      assert.equal(ask.auth, 'Bearer cf-token');
      assert.deepEqual(ask.variables, { account: 'acc123', since: '2026-10-08', until: '2026-10-14' });
    }
    const meters = byId(overview);
    assert.equal(meters['workers.requests'].used, 42_000);
    assert.equal(meters['workers.requests'].limit, 100_000);
    assert.equal(meters['workers.requests'].daily.length, 7);
    assert.match(meters['workers.requests'].detail, /3 errors/);
    assert.equal(meters['do.requests'].used, 500);
    assert.equal(meters['do.duration'].used, 10); // 80 s at 128 MB
    assert.equal(meters['do.rowsWritten'].used, 95_000);
    assert.equal(meters['do.storage'].used, 2048, 'storage is the latest day that reported, not today');
    assert.equal(meters['kv.write'].used, 900);
    assert.equal(meters['kv.read'].used, 70);
    assert.equal(meters['kv.delete'].used, 0);
    assert.equal(meters['kv.storage'].used, 150);
  });

  it('blanks only the meters of a dataset Cloudflare refuses, and falls back to today when the range is too long', async () => {
    const { fetcher } = fakeCloudflare({
      ...ANSWERS,
      durableObjectsPeriodicGroups: () => Response.json({ errors: [{ message: 'unknown field rowsRead' }] }),
      kvOperationsAdaptiveGroups: (body) =>
        body.variables.since === body.variables.until ? rows(ANSWERS.kvOperationsAdaptiveGroups) : Response.json({ errors: [{ message: 'time range is too large' }] }),
    });
    const meters = byId(await cloudflare.cloudflareOverview(ENV, fetcher, NOW, driver()));
    for (const id of ['do.duration', 'do.rowsRead', 'do.rowsWritten']) {
      assert.equal(meters[id].used, null);
      assert.match(meters[id].error, /rowsRead/);
    }
    assert.equal(meters['kv.write'].used, 900);
    assert.equal(meters['workers.requests'].used, 42_000);
  });

  it('asks nothing of the API without a token, and still reports the browser', async () => {
    const { fetcher, asked } = fakeCloudflare(ANSWERS);
    const overview = await cloudflare.cloudflareOverview({ BROWSER: {} }, fetcher, NOW, driver([{ startTime: NOW - 120_000, endTime: NOW - 60_000 }]));
    assert.equal(overview.configured, false);
    assert.equal(asked.length, 0);
    assert.deepEqual(overview.meters.map((meter) => meter.id), ['browser.time']);
    assert.equal(overview.meters[0].used, 60);
    assert.equal(overview.browser.max, 3);
  });
});

describe('browserSeconds', () => {
  it('counts closed sessions, open ones until now, and splits one across midnight UTC', () => {
    const days = ['2026-10-13', '2026-10-14'];
    const midnight = Date.parse('2026-10-14T00:00:00Z');
    const daily = cloudflare.browserSeconds(
      [
        { startTime: midnight - 30_000, endTime: midnight + 90_000 },
        { startTime: NOW - 200_000, endTime: NOW - 100_000 },
        { startTime: 'garbage', endTime: NOW },
      ],
      [{ startTime: NOW - 45_000 }],
      days,
      NOW,
    );
    assert.deepEqual(daily, [
      { day: '2026-10-13', n: 30 },
      { day: '2026-10-14', n: 90 + 100 + 45 },
    ]);
  });
});

describe('/usage/cloudflare', () => {
  it('is the owner’s alone', async () => {
    const response = await worker.fetch(new Request('https://proxy/usage/cloudflare'), { READER_TOKEN: 'secret' }, {});
    assert.equal(response.status, 401);
  });

  it('answers the owner, with READER_TOKEN', async () => {
    const response = await worker.fetch(
      new Request('https://proxy/usage/cloudflare', { headers: { Authorization: 'Bearer secret' } }),
      { READER_TOKEN: 'secret' },
      {},
    );
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.configured, false);
    assert.equal(answer.meters[0].id, 'browser.time');
    assert.match(answer.meters[0].error, /BROWSER/);
  });
});
