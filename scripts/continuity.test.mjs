// Picking a project up from another computer (src/lib/continuity.ts): the
// bounds a row's runs are kept to, and what a browser is called.
//
//   node --test scripts/continuity.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const lib = await load('src/lib/continuity.ts');

after(cleanup);

describe('the runs a row keeps', () => {
  const run = (startedAt, state = 'done', ms = 0) => ({ startedAt, state, ms, msgId: 'm', kernelId: 'k', where: 'w' });
  it('lets done runs go after half a day, keeps running ones, and keeps the newest past the cap', () => {
    const now = Date.now();
    const runs = { old: run(now - lib.DONE_KEPT_MS - 10_000), going: run(now - 2 * lib.DONE_KEPT_MS, 'running'), fresh: run(now - 60_000) };
    const kept = lib.pruneRuns(runs, now);
    assert.deepEqual(Object.keys(kept).sort(), ['fresh', 'going']);
    const many = Object.fromEntries(Array.from({ length: lib.MAX_RUNS + 5 }, (_, i) => [`r${i}`, run(now - i * 1000)]));
    const bounded = lib.pruneRuns(many, now);
    assert.equal(Object.keys(bounded).length, lib.MAX_RUNS);
    assert.ok(bounded.r0);
    assert.equal(bounded[`r${lib.MAX_RUNS + 4}`], undefined);
  });
});

describe('which browser wrote the row', () => {
  it('names the browser and the system in a few words', () => {
    assert.equal(lib.browserWords('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'), 'Chrome on a Mac');
    assert.equal(lib.browserWords('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'), 'Firefox on Windows');
  });
});
