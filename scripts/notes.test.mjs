// The notes export, as Markdown: a kept code cell is fenced so that nothing
// inside it can close the fence, and a label is one line of bold however it
// arrived. No browser: the export is a pure function of the pieces.
//
//   node --test scripts/notes.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { notesMarkdown, summarise, allNotesMarkdown } = await load('src/lib/notes.ts');

after(cleanup);

const clip = (label, text, note) => ({ id: 'n1', kind: 'clip', label, text, html: '', note, at: '', source: { from: 'explain', section: 'Setup' } });

describe('the export as Markdown', () => {
  it('fences code with more backticks than the longest run inside it', () => {
    const out = notesMarkdown([clip('Code', 'x = "````"\nprint(x)')]);
    assert.match(out, /^`````\nx = "````"\nprint\(x\)\n`````$/m);
    assert.doesNotMatch(out, /^```\n/m);
  });

  it('uses a plain triple fence when the code has none', () => {
    const out = notesMarkdown([clip('Output', 'hello')]);
    assert.match(out, /^```\nhello\n```$/m);
  });

  it('cannot be closed by a fence at the start of a line inside the cell', () => {
    const out = notesMarkdown([clip('Code', '```\nescaped\n```')]);
    const fences = out.split('\n').filter((line) => /^`+$/.test(line));
    assert.deepEqual(fences, ['````', '```', '```', '````']);
  });

  it('keeps a label on one line', () => {
    const out = notesMarkdown([clip('Passage\n\n## not a heading', 'words')]);
    assert.match(out, /^\*\*Passage ## not a heading\*\* — Explain · Setup$/m);
  });
});

describe("each paper's notes, summed up", () => {
  const text = (id, md, at) => ({ id, kind: 'text', md, at });

  it('has nothing to say of a paper with no notes', () => {
    assert.equal(summarise('p1', []), null);
  });

  it('counts what was written, what was kept, and the pictures among it', () => {
    const picture = { ...clip('Figure', 'Figure 1'), id: 'n2', html: '<figure><img src="data:image/png;base64,AA"></figure>', at: '2026-01-02T00:00:00Z' };
    const summary = summarise('p1', [text('n1', 'First   thought\nabout it', '2026-01-01T00:00:00Z'), picture, { ...clip('Passage', 'words'), id: 'n3', at: '2026-01-01T12:00:00Z' }]);
    assert.equal(summary.count, 3);
    assert.equal(summary.written, 1);
    assert.equal(summary.kept, 2);
    assert.equal(summary.pictures, 1);
    assert.equal(summary.preview, 'First thought about it');
    assert.equal(summary.updated, '2026-01-02T00:00:00Z');
  });

  it('is as new as its last change, not only its newest piece', () => {
    const summary = summarise('p1', [text('n1', 'x', '2026-01-01T00:00:00Z')], '2026-03-01T00:00:00Z');
    assert.equal(summary.updated, '2026-03-01T00:00:00Z');
  });

  it('exports every paper under a heading of its own, skipping those with none', () => {
    const out = allNotesMarkdown([
      { title: 'Attention\nIs All You Need', blocks: [text('n1', 'Self-attention, everywhere', '')] },
      { title: 'Empty', blocks: [] },
      { title: 'BERT', blocks: [text('n2', 'Masked words', '')] },
    ]);
    assert.match(out, /^## Attention Is All You Need\n\nSelf-attention, everywhere$/m);
    assert.match(out, /^## BERT\n\nMasked words$/m);
    assert.doesNotMatch(out, /## Empty/);
  });
});
