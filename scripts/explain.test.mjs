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

describe('the instructions', () => {
  it('marks figures worth animating, and writes a scene only when asked', () => {
    assert.match(explain.EXPLAIN_SYSTEM, /animate="yes"/);
    assert.match(explain.EXPLAIN_SYSTEM, /Do NOT write\s+a scene unless the reader asks/);
    assert.match(explain.EXPLAIN_SYSTEM, /SCENES — a figure can be animated on request/);
  });
  it('asks for maths as LaTeX, explained, never as code', () => {
    assert.match(explain.EXPLAIN_SYSTEM, /write every formula, symbol and variable name as LaTeX/);
    assert.match(explain.EXPLAIN_SYSTEM, /Never put maths in `code` spans/);
    assert.match(explain.EXPLAIN_SYSTEM, /Teach the maths/);
    assert.doesNotMatch(explain.EXPLAIN_SYSTEM, /not LaTeX/);
  });
});

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
  it('reads a figure marked as worth animating, and the scene written for it', () => {
    const page = `## A\n\`\`\`figure caption="The loss" animate="yes"\n<svg viewBox="0 0 10 10"></svg>\n\`\`\`\n\`\`\`motion title="The loss, in motion" figure="The loss"\n{"nodes":[{"id":"a","kind":"box","label":"a"}],"steps":[{"caption":"one"},{"caption":"two"}]}\n\`\`\`\nText.`;
    const [section] = explain.parseExplanation(page);
    assert.equal(section.blocks[0].kind, 'figure');
    assert.equal(section.blocks[0].animate, true);
    const scene = section.blocks[1];
    assert.equal(scene.kind, 'motion');
    assert.equal(scene.title, 'The loss, in motion');
    assert.equal(scene.figure, 'The loss');
    assert.equal(scene.spec.steps.length, 2);
    assert.equal(explain.motionOf(section), scene);
    const plain = explain.parseExplanation('## A\n```figure caption="x"\n<svg/>\n```')[0].blocks[0];
    assert.equal(plain.animate, undefined);
  });
  it('has no scene for a motion block still streaming', () => {
    const [section] = explain.parseExplanation('## A\n```motion title="x"\n{"nodes":[{"id":"a","kind":"bo');
    assert.equal(section.blocks[0].kind, 'motion');
    assert.equal(section.blocks[0].open, true);
    assert.equal(section.blocks[0].spec, null);
  });
  it('asks for a scene as a request the bar could take', () => {
    assert.match(explain.sceneRequest('The loss', 'Two networks'), /^Animate the figure “Two networks” in the section “The loss”: add a motion block/);
    assert.match(explain.sceneRequest('The loss'), /Animate the key figure in the section/);
  });
  it('keeps a fence still streaming open', () => {
    const [section] = explain.parseExplanation('## A\n```python title="x"\nprint(1)');
    assert.equal(section.blocks[0].open, true);
  });
  it('turns the cells into a notebook', () => {
    const book = JSON.parse(explain.notebook('Attention', sections));
    assert.equal(book.cells.filter((c) => c.cell_type === 'code').length, 4);
  });
  it('signs the notebook’s header with the model that wrote the page', () => {
    const header = (writer) => JSON.parse(explain.notebook('Attention', sections, writer)).cells[0].source.join('');
    assert.match(header(), /Explained by Claude in Reader/);
    assert.match(header('DeepSeek Flash'), /Explained by DeepSeek Flash in Reader\. The outputs under each cell were written by DeepSeek Flash, not run/);
    assert.doesNotMatch(header('DeepSeek Flash'), /Claude/);
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
  it('does not take a file that names another paper, whichever folder it was found in', () => {
    const other = { ...paper, id: 'arxiv:2402.00001' };
    assert.equal(file.fromMarkdownFile(file.toMarkdownFile(other, { ...page, paperId: other.id }), paper.id), null);
    assert.ok(file.fromMarkdownFile(file.toMarkdownFile(paper, page), paper.id), 'a file that names this paper is read');
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

describe("the paper's own figures", async () => {
  const figures = await load('src/lib/paperFigures.ts');
  const kept = [
    { ref: 'Figure 1', kind: 'figure', caption: 'Figure 1: The Transformer - model architecture.', data: 'AAAA', width: 400, height: 600 },
    { ref: 'Figure 2', kind: 'figure', caption: 'Figure 2: (left) Scaled Dot-Product Attention.', data: 'BBBB', width: 600, height: 300 },
    { ref: 'Table 2', kind: 'table', caption: 'Table 2: BLEU scores.', data: 'CCCC', width: 800, height: 300 },
  ];
  it('asks for them by name, only from the list it is given', () => {
    assert.match(explain.EXPLAIN_SYSTEM, /```paper-figure ref="Figure 3"/);
    assert.match(explain.EXPLAIN_SYSTEM, /Use ONLY names from that list/);
  });
  it('reads a paper-figure block, and a figure named as Ask Claude names one', () => {
    const page = [
      '## How it works',
      'The encoder is on the left.',
      '```paper-figure ref="Figure 1" caption="The encoder and decoder stacks"',
      'The **left** column is the encoder.',
      '```',
      'Then attention.',
      '![The attention block](figure:2)',
    ].join('\n');
    const [section] = explain.parseExplanation(page);
    const placed = section.blocks.filter((b) => b.kind === 'paperFigure');
    assert.deepEqual(placed.map((b) => [b.ref, b.caption]), [['Figure 1', 'The encoder and decoder stacks'], ['Figure 2', 'The attention block']]);
    assert.equal(placed[0].md, 'The **left** column is the encoder.');
    assert.equal(placed[0].open, false);
    assert.match(explain.notebook('T', [section]), /Figure 1 of the paper — The encoder and decoder stacks/);
  });
  it('a figure named in the middle of a sentence stays in the prose', () => {
    const [section] = explain.parseExplanation('## A\nSee ![x](figure:1) here.');
    assert.equal(section.blocks.some((b) => b.kind === 'paperFigure'), false);
  });
  it('matches a name however it is written', () => {
    assert.equal(figures.figureKey('Fig. 2'), 'figure:2');
    assert.equal(figures.figureKey('figure:2'), 'figure:2');
    assert.equal(figures.figureKey('Tab. 2'), 'table:2');
    assert.equal(figures.findFigure(kept, 'Figure 2b')?.data, 'BBBB', 'a panel is found in its figure');
    assert.equal(figures.findFigure(kept, 'Table 2')?.data, 'CCCC');
    assert.equal(figures.findFigure(kept, 'Figure 7'), undefined);
    assert.deepEqual(figures.refFromCaption('Fig. 4. Results on ImageNet'), { ref: 'Figure 4', kind: 'figure' });
    assert.equal(figures.refFromCaption('The figure shows'), null);
  });
  it('lists them for the model by name and caption', () => {
    const list = figures.figureList(kept);
    assert.match(list, /^- Figure 1: The Transformer - model architecture\.$/m);
    assert.match(list, /^- Table 2: BLEU scores\.$/m);
  });
  it('shows a model that can see the pictures, each named, before the ask', () => {
    const screen = { where: 'x', paper: { id: 'p', title: 'T', authors: [] }, fullText: 'text' };
    const content = explain.firstMessage(screen, kept, 'claude-sonnet-5');
    assert.ok(Array.isArray(content));
    assert.equal(content.filter((part) => part.type === 'image').length, 3);
    assert.equal(content[0].text.startsWith('Figure 1 of the paper'), true);
    assert.match(content.at(-1).text, /Write the explanation page/);
    assert.deepEqual(content.at(-1).cache_control, { type: 'ephemeral' });
    assert.equal(explain.firstMessage(screen, [], 'claude-sonnet-5'), 'Write the explanation page for this paper.');
  });
});
