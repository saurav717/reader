// Two sequences compared as Git compares lines (src/lib/textDiff.ts): for the
// compare-with-Overleaf view's files, and the words of its PDF compare.
//
//   node --test scripts/text-diff.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const td = await load('src/lib/textDiff.ts');
after(cleanup);

describe('a diff', () => {
  it('finds the shortest edit, Myers’ own example', () => {
    const parts = td.diffSequences([...'ABCABBA'], [...'CBABAC']);
    const edits = parts.filter((part) => part.kind !== 'same').reduce((sum, part) => sum + part.items.length, 0);
    assert.equal(edits, 5);
  });

  it('gives back both sides, for any two sequences', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 0; round < 1500; round += 1) {
      const make = () => Array.from({ length: Math.floor(random() * 14) }, () => 'abc'[Math.floor(random() * 3)]);
      const a = make();
      const b = make();
      const parts = td.diffSequences(a, b);
      assert.deepEqual(parts.filter((part) => part.kind !== 'added').flatMap((part) => part.items), a);
      assert.deepEqual(parts.filter((part) => part.kind !== 'removed').flatMap((part) => part.items), b);
    }
  });

  it('numbers each line on its side', () => {
    assert.deepEqual(td.diffLines('a\nb\nc', 'a\nx\nc'), [
      { kind: 'same', a: 1, b: 1, text: 'a' },
      { kind: 'removed', a: 2, text: 'b' },
      { kind: 'added', b: 2, text: 'x' },
      { kind: 'same', a: 3, b: 3, text: 'c' },
    ]);
    assert.deepEqual(td.diffLines('same', 'same').map((row) => row.kind), ['same']);
  });
});

describe('a merge, change by change', () => {
  const mine = 'title\nmine one\nsame\nmine two\nend';
  const theirs = 'title\ntheirs one\nsame\nend\nadded';
  const rows = td.diffLines(mine, theirs);

  it('finds each run of changes', () => {
    assert.deepEqual(td.hunksOf(rows).map((hunk) => [hunk.mine, hunk.theirs]), [
      [['mine one'], ['theirs one']],
      [['mine two'], []],
      [[], ['added']],
    ]);
  });

  it('keeps one side in total, or picks across, or both', () => {
    assert.equal(td.mergeLines(rows, ['mine', 'mine', 'mine']), mine);
    assert.equal(td.mergeLines(rows, ['theirs', 'theirs', 'theirs']), theirs);
    assert.equal(td.mergeLines(rows, ['theirs', 'mine', 'theirs']), 'title\ntheirs one\nsame\nmine two\nend\nadded');
    assert.equal(td.mergeLines(rows, ['both', 'theirs', 'mine']), 'title\nmine one\ntheirs one\nsame\nend');
  });
});
