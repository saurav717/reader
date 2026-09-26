// Reflow on a single-column paper in NeurIPS's layout, read with pdf.js as
// the app reads it (scripts/fixtures/neurips-single-column.tex, made up):
// what a real one — MINITRON, arXiv:2407.14679 — was read badly in. Its
// tables are captioned under them, one over another, so each caption took
// the table below it; its group labels are set sideways and were lost; its
// byline parts names with wide spaces and puts its notes in a footnote;
// its links are boxed, and the boxes, with a figure's background drawn
// larger than the figure, swallowed the paragraph and the heading over it.
//
//   node --test scripts/pdf-reflow-neurips.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, renderHtml, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const TITLE = 'Small Models by Pruning and Distillation';
let layout;
let html;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/neurips-single-column.pdf', import.meta.url)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) pages.push(await extractPage(await doc.getPage(number)));
  await task.destroy();
  layout = layoutPages(pages, { title: TITLE });
  html = renderHtml(layout, (crop) => `crop-${crop.id}.png`);
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const table = (label) => layout.blocks.find((block) => block.kind === 'table' && block.label === label);
const cells = (block) => block.rows.map((row) => row.map((cell) => plain(cell.spans) + (cell.colspan ? `{${cell.colspan}}` : '') + (cell.rowspan ? `[${cell.rowspan}]` : '')));

describe('a single-column NeurIPS-style paper', () => {
  it('reads the byline parted by wide spaces, its footnoted note, its institution and its addresses', () => {
    assert.deepEqual(
      layout.byline.authors.map((author) => [author.name, author.marks.join(), author.affiliations.join(), author.notes.join(), author.emails.join()]),
      [
        ['Ada Lindqvist', '∗', 'Northfield Labs', 'Equal contribution', 'adal@northfield.example.org'],
        ['Tomas Okafor', '∗', 'Northfield Labs', 'Equal contribution', 'tomaso@northfield.example.org'],
        ['Mira Castell', '', 'Northfield Labs', '', 'mcastell@northfield.example.org'],
        ['Ravi Anand', '', 'Northfield Labs', '', 'ranand@northfield.example.org'],
        ['Lena Ferris', '', 'Northfield Labs', '', 'lferris@northfield.example.org'],
        ['Omar Haddad', '', 'Northfield Labs', '', 'ohaddad@northfield.example.org'],
      ],
    );
    // The address group is no institution, and the footnote is the byline's, not the text's.
    assert.deepEqual(layout.byline.affiliations.map((place) => place.text), ['Northfield Labs']);
    assert.equal(layout.front, undefined);
    assert.ok(!layout.blocks.some((block) => block.kind === 'footnote' && /Equal contribution/.test(text(block))));
  });

  it('keeps a paragraph over a figure clipped out of a larger drawing, and the heading over it', () => {
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map(text);
    assert.deepEqual(headings.slice(0, 5), ['Abstract', '1 Introduction', '1.1 Importance', '2 Results', 'A Appendix']);
    assert.ok(layout.blocks.some((block) => /^Estimating the importance of neurons, heads and layers is well studied/.test(text(block))));
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.ok(figure.crop.y1 - figure.crop.y0 < 200, `the figure is its clip, not the drawing it was cut from: ${JSON.stringify(figure.crop)}`);
  });

  it('keeps two-level scripts in the line they are set in', () => {
    const line = layout.blocks.find((block) => /We define the layer/.test(text(block)));
    assert.match(text(line), /∈ R\s*dhidden×dmodel\s*, and dmodel and dhidden are the embedding and hidden dimensions/);
    assert.equal(layout.blocks.filter((block) => block.kind === 'equation').length, 0);
  });

  it('gives each caption set under a table the table over it, not the one under it', () => {
    assert.deepEqual(cells(table('Table 1'))[1], ['', 'Benchmark', 'Metric', 'Base', 'Mistral', 'Ours']);
    assert.deepEqual(cells(table('Table 2')), [
      ['Benchmark', 'Phi', 'Gemma', 'Ours'],
      ['MMLU (5)', '57.5', '42.0', '58.6'],
      ['HellaSwag (10)', '75.2', '72.0', '75.0'],
    ]);
  });

  it('spreads a heading over the columns its rule spans, and gives labels set sideways their rows', () => {
    assert.deepEqual(cells(table('Table 1')), [
      ['', 'Models{5}'],
      ['', 'Benchmark', 'Metric', 'Base', 'Mistral', 'Ours'],
      ['', '# Parameters', '', '8B', '7.3B', '8.3B'],
      ['', '# Tokens', '', '15T', '8T', '94B'],
      ['Logic[2]', 'winogrande (5)', 'acc', '77.6', '78.5', '79.0'],
      ['MMLU (5)', 'acc', '65.3', '64.1', '63.8'],
      ['Code[2]', 'MBPP (0)', 'pass@1', '42.4', '38.8', '35.2'],
      ['HumanEval (0)', 'pass@1', '28.1', '28.7', '31.6'],
    ]);
  });

  it('keeps tables set side by side apart, and a heading cell on three lines one cell', () => {
    assert.deepEqual(cells(table('Table 3')), [
      ['Model', 'Non-Emb. Params', 'Total'],
      ['Ours-instruct', '2.6B', '6.46'],
      ['Phi-chat', '2.5B', '4.29'],
    ]);
    assert.deepEqual(cells(table('Table 4')), [
      ['Model', 'Avg.'],
      ['Ours-instruct', '53.09'],
      ['Gemma-it', '41.63'],
      ['Llama-instruct', '50.51'],
    ]);
  });

  it('keeps a label across four columns in its row', () => {
    assert.deepEqual(cells(table('Table 5')).at(-1), ['Train from scratch (random init){4}', '12.27 → 2.34', '3.953']);
  });

  it('keeps a bold heading, its number an em from its title, out of the table under it', () => {
    assert.ok(layout.blocks.some((block) => block.kind === 'heading' && text(block) === 'A.1 One-shot vs. Iterative Pruning'));
    assert.deepEqual(cells(table('Table 6'))[0], ['Loss components', 'LM loss']);
  });

  it('sets the tables as tables', () => {
    assert.match(html, /<th colspan="5"[^>]*>Models<\/th>/);
    assert.match(html, /<td rowspan="2"[^>]*>Logic<\/td>/);
  });
});
