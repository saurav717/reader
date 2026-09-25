// The notes export, as Markdown: a kept code cell is fenced so that nothing
// inside it can close the fence, and a label is one line of bold however it
// arrived. No browser: the export is a pure function of the pieces.
//
//   node --test scripts/notes.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { notesMarkdown } = await load('src/lib/notes.ts');

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
