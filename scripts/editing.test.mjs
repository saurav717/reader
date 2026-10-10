// The playground's code editor, without a browser: what VS Code's keys do to
// the text — comments, moving, copying and deleting lines, the indent on a
// new line, brackets — and find, replace, the outline and Quick Open's match.
//
//   node --test scripts/editing.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const ed = await load('src/lib/editing.ts');
after(cleanup);

/** An edit applied: the new text and selection. */
const run = (text, edit) => ({ text: text.slice(0, edit.from) + edit.insert + text.slice(edit.to), sel: edit.select });

describe('lines', () => {
  it('comments and uncomments, at the shallowest indent, by language', () => {
    const text = 'def f():\n    x = 1\n    return x\n';
    const on = run(text, ed.toggleComment(text, { start: 9, end: 30 }, '#'));
    assert.equal(on.text, 'def f():\n    # x = 1\n    # return x\n');
    const off = run(on.text, ed.toggleComment(on.text, { start: 9, end: 30 }, '#'));
    assert.equal(off.text, text);
    assert.equal(ed.commentFor('a.py'), '#');
    assert.equal(ed.commentFor('a.ts'), '//');
    assert.equal(ed.commentFor('q.sql'), '--');
  });
  it('moves a line down and up, the selection with it', () => {
    const text = 'a\nb\nc';
    const down = run(text, ed.moveLines(text, { start: 0, end: 0 }, true));
    assert.equal(down.text, 'b\na\nc');
    assert.deepEqual(down.sel, { start: 2, end: 2 });
    const up = run(down.text, ed.moveLines(down.text, down.sel, false));
    assert.equal(up.text, text);
    assert.equal(ed.moveLines(text, { start: 0, end: 0 }, false), null);
    assert.equal(ed.moveLines(text, { start: 4, end: 4 }, true), null);
  });
  it('copies and deletes lines', () => {
    const text = 'a\nb\nc';
    assert.equal(run(text, ed.copyLines(text, { start: 2, end: 2 }, true)).text, 'a\nb\nb\nc');
    assert.equal(run(text, ed.deleteLines(text, { start: 2, end: 2 })).text, 'a\nc');
    assert.equal(run(text, ed.deleteLines(text, { start: 4, end: 4 })).text, 'a\nb');
  });
  it('carries the indent to a new line, one more after a colon or an opening bracket', () => {
    const text = '    if x:';
    assert.equal(run(text, ed.newLine(text, { start: 9, end: 9 })).text, '    if x:\n        ');
    const plain = '    y = 1';
    assert.equal(run(plain, ed.newLine(plain, { start: 9, end: 9 })).text, '    y = 1\n    ');
    const pair = 'f = {}';
    const out = run(pair, ed.newLine(pair, { start: 5, end: 5 }));
    assert.equal(out.text, 'f = {\n    \n}');
    assert.deepEqual(out.sel, { start: 10, end: 10 });
  });
});

describe('brackets', () => {
  it('closes what is opened, wraps a selection, steps over a closer, and deletes a pair', () => {
    assert.equal(run('f', ed.typeBracket('f', { start: 1, end: 1 }, '(')).text, 'f()');
    assert.equal(run('x', ed.typeBracket('x', { start: 0, end: 1 }, '[')).text, '[x]');
    assert.deepEqual(ed.typeBracket('f()', { start: 2, end: 2 }, ')').select, { start: 3, end: 3 });
    assert.equal(ed.typeBracket("don", { start: 3, end: 3 }, "'"), null);
    assert.equal(run('()', ed.deletePair('()', { start: 1, end: 1 })).text, '');
  });
});

describe('find and replace', () => {
  it('finds plain text, whole words, regular expressions, and says when one is broken', () => {
    assert.equal(ed.findAll('a A a', 'a').matches.length, 3);
    assert.equal(ed.findAll('a A a', 'a', { caseSensitive: true }).matches.length, 2);
    assert.equal(ed.findAll('cat catalog', 'cat', { wholeWord: true }).matches.length, 1);
    assert.equal(ed.findAll('x1 x22', 'x\\d+', { regex: true }).matches.length, 2);
    assert.ok(ed.findAll('x', '(', { regex: true }).error);
  });
  it('replaces every match, groups and all', () => {
    assert.deepEqual(ed.replaceAll('a.b a.b', 'a.b', '$&!'), { text: '$&! $&!', count: 2 });
    assert.deepEqual(ed.replaceAll('x1 y2', '([a-z])(\\d)', '$2$1', { regex: true }), { text: '1x 2y', count: 2 });
  });
  it('says where an offset is, and where a line starts', () => {
    assert.deepEqual(ed.lineCol('ab\ncd', 4), { line: 2, col: 2 });
    assert.equal(ed.offsetOfLine('ab\ncd\nef', 3), 6);
    assert.equal(ed.offsetOfLine('ab', 9), 0);
  });
});

describe('the outline', () => {
  it('lists Python classes, methods and functions, and the path to a line', () => {
    const code = 'import os\n\nclass Model:\n    def forward(self, x):\n        return x\n\ndef main():\n    pass\n';
    const symbols = ed.symbolsOf(code, 'm.py');
    assert.deepEqual(symbols.map((s) => [s.name, s.kind, s.line]), [['Model', 'class', 3], ['forward', 'method', 4], ['main', 'function', 7]]);
    assert.deepEqual(ed.symbolPath(symbols, 5).map((s) => s.name), ['Model', 'forward']);
    assert.deepEqual(ed.symbolPath(symbols, 8).map((s) => s.name), ['main']);
  });
  it('lists Markdown headings and JavaScript functions', () => {
    assert.deepEqual(ed.symbolsOf('# A\n## B\n', 'r.md').map((s) => [s.name, s.depth]), [['A', 0], ['B', 1]]);
    assert.deepEqual(ed.symbolsOf('export function go() {}\nconst f = (a) => a;\nclass K {}', 'x.ts').map((s) => s.name), ['go', 'f', 'K']);
  });
});

describe('Quick Open', () => {
  it('matches letters in order, the file’s own name and word starts first', () => {
    assert.equal(ed.fuzzyScore('zz', 'main.py'), null);
    const names = ['data/train_log.txt', 'train.py', 'src/model/transformer.py'];
    const ranked = names.map((name) => [name, ed.fuzzyScore('trn', name)?.score ?? -1]).sort((a, b) => b[1] - a[1]);
    assert.equal(ranked[0][0], 'train.py');
  });
});
