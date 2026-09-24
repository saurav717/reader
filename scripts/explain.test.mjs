// Explain, without a browser or a key: how Claude's page is read into
// sections, figures, cells and caveats, how it becomes a notebook, and how a
// request from the bar at the top — answered as edits to sections — is
// applied, including halfway through its stream.
//
//   node --test scripts/explain.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const explain = await load('src/lib/explain.ts', { external: ['@anthropic-ai/sdk'] });
const PAGE = await readFile(new URL('./fixtures/explain-attention.md', import.meta.url), 'utf8');

after(cleanup);

describe('reading the page', () => {
  const sections = explain.parseExplanation(PAGE);
  it('finds every section', () => {
    assert.equal(sections.length, 8);
    assert.equal(sections[0].title, 'At a glance');
    assert.equal(sections.at(-1).title, 'Since then');
  });
  it('pairs each cell with its output', () => {
    const cells = sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'code');
    assert.equal(cells.length, 4);
    assert.ok(cells.every((cell) => cell.output && !cell.open));
  });
  it('reads caveats with their verdicts', () => {
    const verdicts = explain.caveatsOf(sections).map((c) => c.verdict);
    assert.deepEqual(verdicts, ['refined', 'holds', 'refined', 'superseded', 'superseded', 'refined']);
  });
  it('keeps a fence still streaming open', () => {
    const [section] = explain.parseExplanation('## A\n```python title="x"\nprint(1)');
    assert.equal(section.blocks[0].open, true);
  });
  it('turns the cells into a notebook', () => {
    const book = JSON.parse(explain.notebook('Attention', sections));
    assert.equal(book.cells.filter((c) => c.cell_type === 'code').length, 4);
  });
});

describe('applying a request', () => {
  const base = '## At a glance\nold glance\n\n## Multi-head attention\nold heads\n\n## Since then\ntable';
  it('replaces a section by its title, loosely matched', () => {
    const out = explain.applyEdits(base, '<<<replace: multi-head attention>>>\n## Multi-head attention\nsimpler heads\n<<<note>>>\nMade it simpler.');
    assert.match(out.content, /simpler heads/);
    assert.doesNotMatch(out.content, /old heads/);
    assert.deepEqual(out.touched, ['Multi-head attention']);
    assert.equal(out.note, 'Made it simpler.');
  });
  it('inserts a new section after the one named', () => {
    const out = explain.applyEdits(base, '<<<insert after: At a glance>>>\n## Why √d?\nbecause variance');
    assert.deepEqual(explain.sectionTitles(out.content), ['At a glance', 'Why √d?', 'Multi-head attention', 'Since then']);
  });
  it('puts a section with no place found before "Since then"', () => {
    const out = explain.applyEdits(base, '<<<insert after: Nowhere>>>\n## Extra\ntext');
    assert.deepEqual(explain.sectionTitles(out.content), ['At a glance', 'Multi-head attention', 'Extra', 'Since then']);
  });
  it('deletes', () => {
    const out = explain.applyEdits(base, '<<<delete: At a glance>>>');
    assert.deepEqual(explain.sectionTitles(out.content), ['Multi-head attention', 'Since then']);
  });
  it('keeps a reply with no markers, after the section asked about', () => {
    const out = explain.applyEdits(base, 'It is because the variance grows with d.', 'At a glance');
    assert.deepEqual(explain.sectionTitles(out.content), ['At a glance', 'Your question', 'Multi-head attention', 'Since then']);
  });
  it('shows a half-streamed replacement in place', () => {
    const out = explain.applyEdits(base, '<<<replace: Multi-head attention>>>\n## Multi-head attention\nsimpl');
    assert.match(out.content, /## Multi-head attention\nsimpl/);
    assert.equal(explain.sectionTitles(out.content).length, 3);
  });
  it('ignores a heading inside a code fence', () => {
    const page = '## A\n```python title="x"\n## not a heading\n```\n\n## B\nb';
    assert.deepEqual(explain.sectionTitles(page), ['A', 'B']);
  });
});

describe('a revision halfway through a figure', () => {
  it('keeps the sections after it, and the figure still open', () => {
    const base = '## A\na\n\n## B\nb\n\n## C\nc';
    const out = explain.applyEdits(base, '<<<replace: A>>>\n## A\nnew\n```figure caption="x"\n<svg viewBox="0 0 10 10">');
    const sections = explain.parseExplanation(out.content);
    assert.deepEqual(sections.map((s) => s.title), ['A', 'B', 'C']);
    assert.equal(sections[0].blocks.find((b) => b.kind === 'figure').open, true);
  });
});

describe('the copy in Drive', async () => {
  const file = await load('src/lib/explainDrive.ts', { external: ['@anthropic-ai/sdk'] });
  const paper = { id: 'arxiv:1706.03762', title: 'Attention Is All You Need', arxivId: '1706.03762' };
  const page = {
    paperId: paper.id,
    content: PAGE,
    model: 'claude-opus-5',
    created: Date.parse('2026-09-24T10:00:00Z'),
    updated: Date.parse('2026-09-24T11:30:00Z'),
    requests: ['Explain "this" more simply', 'Use PyTorch'],
  };
  it('is named after the paper, beside its PDF and sidecar', () => {
    assert.equal(file.explanationFileName(paper), 'Attention Is All You Need (arXiv 1706.03762) — explained by Claude.md');
  });
  it('reads back as it was written', () => {
    const back = file.fromMarkdownFile(file.toMarkdownFile(paper, page), paper.id);
    assert.equal(back.content, PAGE.trim());
    assert.equal(back.model, 'claude-opus-5');
    assert.equal(back.created, page.created);
    assert.equal(back.updated, page.updated);
    assert.deepEqual(back.requests, page.requests);
  });
  it('takes a file edited by hand, with no front matter', () => {
    const back = file.fromMarkdownFile('## At a glance\nhello', paper.id);
    assert.equal(back.content, '## At a glance\nhello');
    assert.equal(back.model, 'unknown');
  });
  it('turns an empty file into nothing', () => {
    assert.equal(file.fromMarkdownFile('---\nmodel: "x"\n---\n\n', paper.id), null);
  });
});
