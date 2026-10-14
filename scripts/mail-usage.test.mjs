// The Usage page's Email tab (worker/mailUsage.js): the plan's limits, the
// site's own log summed by day, and each provider's answers read into one
// shape — a provider refusing blanks only its part.
//
//   node --test scripts/mail-usage.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { brevoAccount, lastDays, mailLimits, mailLog, mailOverview, senderAddress, unblockAddress } = await import('../worker/mailUsage.js');

const NOW = Date.parse('2026-10-14T15:00:00Z');
const BREVO = { MAIL_API_KEY: 'xkeysib-abc', MAIL_FROM: 'Reader <Me@Example.org>' };

/** A fetch that answers by the URL's path, and remembers what it was asked. */
function fakeFetch(routes) {
  const asked = [];
  const fetcher = async (url, init = {}) => {
    asked.push({ url, init });
    const path = new URL(url).pathname;
    const answer = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (!answer) return new Response('{"message":"no"}', { status: 404 });
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { fetcher, asked };
}

describe('the limits', () => {
  it('are the free plan’s, or the ones set', () => {
    assert.deepEqual([mailLimits({}, 'brevo').daily, mailLimits({}, 'brevo').monthly], [300, null]);
    assert.deepEqual([mailLimits({}, 'resend').daily, mailLimits({}, 'resend').monthly], [100, 3000]);
    assert.deepEqual([mailLimits({}, 'postmark').daily, mailLimits({}, 'postmark').monthly], [null, 100]);
    const set = mailLimits({ MAIL_DAILY_LIMIT: '2000' }, 'brevo');
    assert.deepEqual([set.daily, set.monthly, set.source], [2000, null, 'setting']);
  });
  it('the sender is the address in MAIL_FROM', () => {
    assert.equal(senderAddress('Reader <Me@Example.org>'), 'me@example.org');
    assert.equal(senderAddress('me@example.org'), 'me@example.org');
  });
});

describe('the site’s log', () => {
  it('sums sends and refusals by day, today and this month', () => {
    const entries = [
      { id: 'a', at: NOW - 60_000, kind: 'project', to: 'a@x.org', ok: true },
      { id: 'b', at: NOW - 120_000, kind: 'try', to: 'b@x.org', ok: false, error: 'the mail provider answered 402' },
      { id: 'c', at: NOW - 3 * 86_400_000, kind: 'try', to: 'c@x.org', ok: true },
      { id: 'd', at: Date.parse('2026-09-30T10:00:00Z'), kind: 'test', to: 'd@x.org', ok: true },
    ];
    const log = mailLog(entries, NOW);
    assert.deepEqual(log.today, { sent: 1, failed: 1 });
    assert.deepEqual(log.month, { sent: 2, failed: 1 });
    assert.equal(log.daily.length, 30);
    assert.deepEqual(log.daily.at(-1), { day: '2026-10-14', sent: 1, failed: 1 });
    assert.equal(log.daily.find((row) => row.day === '2026-09-30').sent, 1);
    assert.equal(log.recent[0].id, 'a');
    assert.equal(log.lastFailure.id, 'b');
    assert.deepEqual(log.byKind.map((item) => item.sent), [1, 1, 0]);
  });
});

describe('Brevo', () => {
  it('reads the plan’s credits', () => {
    const account = brevoAccount({ email: 'me@example.org', companyName: 'Me', plan: [{ type: 'free', credits: 287, creditsType: 'sendLimit' }] });
    assert.deepEqual([account.plan, account.credits, account.name], ['free', 287, 'Me']);
  });

  it('fills the overview: credits, days, events, blocked and the sender', async () => {
    const days = lastDays(NOW);
    const { fetcher, asked } = fakeFetch({
      '/v3/account': { email: 'me@example.org', plan: [{ type: 'free', credits: 290, creditsType: 'sendLimit' }] },
      '/v3/smtp/statistics/reports': { reports: [{ date: days.at(-1), requests: 10, delivered: 8, hardBounces: 1, softBounces: 0, blocked: 1, invalid: 0, spamReports: 0, uniqueOpens: 4, uniqueClicks: 2 }] },
      '/v3/smtp/statistics/events': { events: [{ email: 'a@x.org', date: '2026-10-14T14:00:00Z', event: 'hardBounces', reason: 'no such user', subject: 'Hi' }] },
      '/v3/smtp/blockedContacts': { count: 1, contacts: [{ email: 'a@x.org', reason: { code: 'hardBounce', message: 'Hard bounce' }, blockedAt: '2026-10-14T14:00:00Z' }] },
      '/v3/senders': { senders: [{ email: 'me@example.org', active: true }] },
    });
    const log = [{ id: 'a', at: NOW - 1000, kind: 'project', to: 'a@x.org', ok: true }];
    const overview = await mailOverview(BREVO, { fetcher, now: NOW, log });
    assert.equal(overview.configured, true);
    assert.equal(overview.provider, 'brevo');
    assert.equal(overview.account.credits, 290);
    assert.equal(overview.daily.at(-1).sent, 10);
    assert.equal(overview.daily.at(-1).bounced, 1);
    assert.equal(overview.used.today, 10, 'the provider’s count, higher than the log’s');
    assert.equal(overview.used.measuredBy, 'provider');
    assert.equal(overview.events[0].event, 'hardBounces');
    assert.equal(overview.blocked.contacts[0].reason, 'Hard bounce');
    assert.equal(overview.sender.verified, true);
    assert.ok(asked.every((call) => call.init.headers['api-key'] === 'xkeysib-abc'));
  });

  it('a refused part is that part’s error, the rest filled in', async () => {
    const { fetcher } = fakeFetch({
      '/v3/account': new Response('{"message":"Key not found"}', { status: 401 }),
      '/v3/smtp/statistics/reports': { reports: [] },
      '/v3/smtp/statistics/events': { events: [] },
      '/v3/smtp/blockedContacts': { count: 0, contacts: [] },
      '/v3/senders': { senders: [] },
    });
    const overview = await mailOverview(BREVO, { fetcher, now: NOW, log: [] });
    assert.match(overview.account.error, /401: Key not found/);
    assert.equal(overview.daily.length, 30);
    assert.equal(overview.sender.verified, false, 'not among the senders');
  });

  it('takes an address off the blocked list', async () => {
    const { fetcher, asked } = fakeFetch({ '/v3/smtp/blockedContacts/': new Response(null, { status: 204 }) });
    assert.deepEqual(await unblockAddress(BREVO, 'A@x.org', fetcher), { ok: true, email: 'a@x.org' });
    assert.equal(asked[0].init.method, 'DELETE');
    assert.match(asked[0].url, /blockedContacts\/a%40x\.org$/);
    await assert.rejects(unblockAddress({ MAIL_API_KEY: 're_x', MAIL_FROM: 'a@b.org' }, 'a@x.org', fetcher), /only Brevo/);
  });
});

describe('the other providers', () => {
  it('SendGrid: credits and the days', async () => {
    const days = lastDays(NOW);
    const { fetcher } = fakeFetch({
      '/v3/user/credits': { remain: 80, total: 100, used: 20, next_reset: '2026-10-15', reset_frequency: 'daily' },
      '/v3/stats': [{ date: days.at(-1), stats: [{ metrics: { requests: 20, delivered: 19, bounces: 1 } }] }],
    });
    const overview = await mailOverview({ MAIL_API_KEY: 'SG.x', MAIL_FROM: 'a@b.org' }, { fetcher, now: NOW });
    assert.equal(overview.account.credits, 80);
    assert.equal(overview.daily.at(-1).sent, 20);
    assert.equal(overview.used.month, 20);
  });

  it('Resend: the site’s log alone, against 100 a day and 3,000 a month', async () => {
    const overview = await mailOverview({ MAIL_API_KEY: 're_x', MAIL_FROM: 'a@b.org' }, { fetcher: () => assert.fail('nothing to ask'), now: NOW, log: [{ id: 'a', at: NOW, kind: 'try', to: 'x@y.org', ok: true }] });
    assert.equal(overview.daily, null);
    assert.equal(overview.used.today, 1);
    assert.equal(overview.used.measuredBy, 'site');
    assert.deepEqual([overview.limits.daily, overview.limits.monthly], [100, 3000]);
  });

  it('not set up: says so, asks nobody', async () => {
    const overview = await mailOverview({}, { fetcher: () => assert.fail('nothing to ask'), now: NOW, log: [] });
    assert.equal(overview.configured, false);
    assert.equal(overview.account, null);
  });
});
