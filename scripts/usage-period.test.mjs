// The AI credits' own period on the Usage page: which days each choice
// covers, and the report cut down to them.
//
//   node --test scripts/usage-period.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { resolvePeriod, sliceReport, daysSpanned } = await load('src/lib/usagePeriod.ts');

after(cleanup);

const today = '2026-09-27';
const at = (preset, extra = {}) => resolvePeriod({ preset, from: '', to: null, ...extra }, 30, today);

describe('resolvePeriod', () => {
  it('follows the page, or counts back from today, up to now', () => {
    assert.deepEqual(at('page'), { since: '2026-08-29', until: today, live: true });
    assert.deepEqual(at('1'), { since: today, until: today, live: true });
    assert.deepEqual(at('7'), { since: '2026-09-21', until: today, live: true });
    assert.equal(daysSpanned(at('90').since, today), 90);
  });

  it('takes this month to now, and last month whole', () => {
    assert.deepEqual(at('month'), { since: '2026-09-01', until: today, live: true });
    assert.deepEqual(at('last-month'), { since: '2026-08-01', until: '2026-08-31', live: false });
    assert.deepEqual(resolvePeriod({ preset: 'last-month', from: '', to: null }, 30, '2026-03-05'), {
      since: '2026-02-01',
      until: '2026-02-28',
      live: false,
    });
  });

  it('takes two days picked, the second of them "now" when left open', () => {
    assert.deepEqual(at('custom', { from: '2026-09-10', to: null }), { since: '2026-09-10', until: today, live: true });
    assert.deepEqual(at('custom', { from: '2026-09-10', to: '2026-09-15' }), { since: '2026-09-10', until: '2026-09-15', live: false });
    // The wrong way round is turned round; a day after today is today.
    assert.deepEqual(at('custom', { from: '2026-09-15', to: '2026-09-10' }), { since: '2026-09-10', until: '2026-09-15', live: false });
    assert.deepEqual(at('custom', { from: '2026-09-20', to: '2026-10-05' }), { since: '2026-09-20', until: today, live: true });
  });

  it('reaches back no further than the tally keeps', () => {
    assert.equal(at('custom', { from: '2025-01-01', to: null }).since, '2026-06-30');
  });
});

describe('sliceReport', () => {
  const report = {
    since: '2026-09-20',
    until: today,
    totals: {},
    people: [
      {
        email: 'a@x',
        last: 1,
        days: 2,
        total: {},
        daily: [
          { day: '2026-09-27', claude: 2, claude_cost: 500, models: { 'claude-sonnet-5': { n: 2, in: 10, out: 5, cost: 500 } } },
          { day: '2026-09-20', claude: 1, claude_cost: 100, models: { 'claude-sonnet-5': { n: 1, in: 3, out: 1, cost: 100 } } },
        ],
      },
      { email: 'b@x', last: 1, days: 1, total: {}, daily: [{ day: '2026-09-21', deepseek: 4, deepseek_cost: 40 }] },
    ],
  };

  it('sums each person and everyone again from the days in the period', () => {
    const cut = sliceReport(report, '2026-09-25', today);
    assert.equal(cut.since, '2026-09-25');
    assert.deepEqual(cut.people.map((person) => person.email), ['a@x']);
    assert.deepEqual(cut.people[0].total, { claude: 2, claude_cost: 500 });
    assert.equal(cut.people[0].days, 1);
    assert.deepEqual(cut.totals, { claude: 2, claude_cost: 500 });
    assert.deepEqual(cut.models, { 'claude-sonnet-5': { n: 2, in: 10, out: 5, cost: 500 } });
  });

  it('keeps everyone over the whole report', () => {
    const cut = sliceReport(report, '2026-09-20', today);
    assert.equal(cut.people.length, 2);
    assert.deepEqual(cut.totals, { claude: 3, claude_cost: 600, deepseek: 4, deepseek_cost: 40 });
  });
});
