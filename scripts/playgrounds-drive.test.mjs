// The playgrounds kept in Drive (src/lib/playgroundsDrive.ts): two browsers'
// lists merged — the newer record of each wins, a deletion carries over unless
// the playground changed after it — and a stray file read as nothing.
//
//   node --test scripts/playgrounds-drive.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const { mergeCopies, mergePlaygrounds, parsePlaygrounds, serialisePlaygrounds } = await load('src/lib/playgroundsDrive.ts');
after(cleanup);

const pg = (id, updated, extra = {}) => ({ id, title: id, updated, ...extra });

describe('playgrounds in Drive', () => {
  it('keeps the newer record of each playground, and both browsers’ new ones', () => {
    const here = { playgrounds: [pg('a', 5, { title: 'mine' }), pg('b', 1)], deleted: {} };
    const drive = { playgrounds: [pg('a', 3, { title: 'old' }), pg('c', 2)], deleted: {} };
    const merged = mergePlaygrounds(here, drive);
    assert.deepEqual(merged.playgrounds.map((p) => p.id), ['a', 'c', 'b']);
    assert.equal(merged.playgrounds[0].title, 'mine');
  });

  it('carries a deletion over, unless the playground changed after it', () => {
    const here = { playgrounds: [pg('b', 9)], deleted: { a: 10 } };
    const drive = { playgrounds: [pg('a', 4), pg('b', 4)], deleted: { b: 6 } };
    const merged = mergePlaygrounds(here, drive);
    assert.deepEqual(merged.playgrounds.map((p) => p.id), ['b']);
    assert.deepEqual(merged.deleted, { a: 10, b: 6 });
  });

  it('writes the same text for the same set, whatever the order', () => {
    const one = { playgrounds: [pg('a', 1), pg('b', 2)], deleted: { x: 1, y: 2 } };
    const two = { playgrounds: [pg('b', 2), pg('a', 1)], deleted: { y: 2, x: 1 } };
    assert.equal(serialisePlaygrounds(one), serialisePlaygrounds(two));
  });

  it('reads a file it wrote, and nothing from a stray one', () => {
    const text = JSON.stringify({ generator: 'reader', version: 1, playgrounds: [pg('a', 1), { nope: true }], deleted: { z: 3, bad: 'x' } });
    assert.deepEqual(parsePlaygrounds(text), { playgrounds: [pg('a', 1)], deleted: { z: 3 } });
    assert.equal(parsePlaygrounds('{"papers": []}'), null);
    assert.equal(parsePlaygrounds('not json'), null);
  });

  it('reads every copy of the file as one, and says when they differ', () => {
    const file = (playgrounds, deleted = {}) => JSON.stringify({ generator: 'reader', version: 1, playgrounds, deleted });
    // Two browsers that each wrote a copy of their own: both lists, merged.
    const apart = mergeCopies([file([pg('web', 2)]), file([pg('app', 3)], { gone: 1 }), 'not json']);
    assert.deepEqual(apart.playgrounds.map((p) => p.id), ['app', 'web']);
    assert.deepEqual(apart.deleted, { gone: 1 });
    assert.equal(apart.copiesAgree, false);
    // One copy, or copies that say the same: nothing to bring together.
    assert.equal(mergeCopies([file([pg('a', 1)]), file([pg('a', 1)])]).copiesAgree, true);
    assert.equal(mergeCopies(['{"papers": []}']), null);
    assert.equal(mergeCopies([]), null);
  });
});
