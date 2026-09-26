// Reflow on a real PDF, read with pdf.js as the app reads it: an IEEE
// conference paper (scripts/fixtures/ieee-two-column.tex, made up) whose
// layout the reader once took apart — a figure at the head of the right
// column that swallowed the abstract beside it, tables captioned "TABLE II"
// read as loose words, small-capital headings read as list items, links
// that were not links, and the byline's affiliations and notes dropped.
//
//   node --test scripts/pdf-reflow-ieee.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, renderHtml, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const TITLE = 'ORB-NET: Orbit-Aware Planning Models for Sample-Efficient Robot Control';
let layout;
let html;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/ieee-two-column.pdf', import.meta.url)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) pages.push(await extractPage(await doc.getPage(number)));
  await task.destroy();
  layout = layoutPages(pages, { title: TITLE });
  html = renderHtml(layout, (crop) => `crop-${crop.id}.png`);
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const cells = (block) => block.rows.map((row) => row.map((cell) => plain(cell.spans)));

describe('an IEEE two-column paper', () => {
  it('keeps the whole abstract, first line to last, though a figure sits beside it', () => {
    const abstract = layout.blocks[0];
    assert.equal(abstract.kind, 'paragraph');
    assert.match(text(abstract), /^Abstract—Planning models are usually trained to predict what happens next/);
    assert.match(text(abstract), /from 3\.7% to 52\.0% over a matched baseline/);
    assert.match(text(abstract), /Videos and code are at https:\/\/orb-net\.example\.org\/\.$/);
    assert.equal(layout.blocks.filter((block) => /Planning models are usually/.test(text(block))).length, 1);
  });

  it('reads the byline whole: each name\'s marks, what they stand for, and the institution', () => {
    const { byline } = layout;
    assert.deepEqual(
      byline.authors.map((author) => [author.name, author.marks.join(','), author.affiliations.join('; '), author.notes.join('; ')]),
      [
        ['Ada Lindqvist', '1,∗', 'Northfield University, Northfield, Canada', 'Equal contribution'],
        ['Tomas Okafor', '1,∗', 'Northfield University, Northfield, Canada', 'Equal contribution'],
        ['Mira Castell', '1', 'Northfield University, Northfield, Canada', ''],
        ['Ravi Anand', '1', 'Northfield University, Northfield, Canada', ''],
        ['Lena Ferris', '1', 'Northfield University, Northfield, Canada', ''],
        ['Omar Haddad', '1,†', 'Northfield University, Northfield, Canada', 'Corresponding author: haddad@northfield.example.org'],
      ],
    );
    assert.deepEqual(byline.notes.map((note) => note.mark), ['∗', '†']);
    // All of it is in the reader's heading now, and nothing is left over for the text.
    assert.equal(layout.front, undefined);
    assert.doesNotMatch(html, /pdf-front/);
    assert.deepEqual(layout.authors, ['Ada Lindqvist', 'Tomas Okafor', 'Mira Castell', 'Ravi Anand', 'Lena Ferris', 'Omar Haddad']);
  });

  it('reads small-capital and italic headings as headings, at their levels', () => {
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map((block) => [block.level, text(block)]);
    assert.deepEqual(headings, [
      [2, 'I. INTRODUCTION'],
      [3, 'A. Residual latent dynamics'],
      [2, 'II. EXPERIMENTS'],
      [2, 'III. CONCLUSION AND LIMITATIONS'],
      [2, 'REFERENCES'],
    ]);
    assert.doesNotMatch(html, /<ol>/);
  });

  it('finds the figure and both tables by their captions', () => {
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.match(text(figure), /^Fig\. 1: Factual prediction versus counterfactual selection/);
    const [first, second] = layout.blocks.filter((block) => block.kind === 'table');
    assert.match(text(first), /^TABLE I: Cube ablations .* HS averages P00–P04\.$/);
    assert.match(text(second), /^TABLE II: Zero-shot UR5 results \(count\/total\)\. Abnormal motion counts adverse events\. Bold marks better results\.$/);
  });

  it('reads a table in Roman numerals row by row, bold cells bold', () => {
    const table = layout.blocks.filter((block) => block.kind === 'table')[1];
    assert.deepEqual(cells(table), [
      ['Protocol', 'Metric', 'Baseline', 'ORB-NET'],
      ['Basic', 'Success ↑', '19/45', '32/45'],
      ['Complex', 'Success ↑', '2/10', '5/10'],
      ['', 'Abnormal motion ↓', '6/10', '2/10'],
      ['Target', 'Target moved ↑', '14/27', '21/27'],
      ['', 'Lift-and-place ↑', '9/27', '17/27'],
    ]);
    assert.match(html, /<td class="num"><strong>32\/45<\/strong><\/td>/);
  });

  it('splits a table into its panels, and keeps the note under it', () => {
    const table = layout.blocks.find((block) => block.kind === 'table');
    const rows = cells(table);
    assert.deepEqual(rows[0], ['A. Component contributions']);
    assert.deepEqual(rows[2], ['Base', '73.3 ± 2.5', '3.7 ± 1.4']);
    assert.deepEqual(rows[5], ['C. MI weight (λinv = 0.1)']);
    assert.deepEqual(rows[6], ['λMI', '0', '.005', '.01', '.015', '.03', '.05']);
    assert.deepEqual(rows[8], ['HS', '37.1', '50.9', '52.0', '60.4', '65.2', '61.5']);
    assert.equal(table.rows[0][0].colspan, 7);
    assert.match(plain(table.notes), /^MI-enabled variants in A use λ\s*MI = 0\.01\. Encoded endpoints remove only the direct Inv gradient through the predicted successor\.$/);
  });

  it('makes the links links, an address broken across two lines included', () => {
    assert.match(html, /<a href="https:\/\/orb-net\.example\.org\/" target="_blank" rel="noreferrer noopener">https:\/\/orb-net\.example\.org\/<\/a>\./);
    assert.match(html, /<a href="https:\/\/github\.com\/orb-net\/orb-net" [^>]*>https:\/\/github\.com\/orb-net\/orb-net<\/a> for code/);
  });

  it('puts the equation where it is set, between the lines around it', () => {
    const at = layout.blocks.findIndex((block) => block.kind === 'equation');
    assert.match(text(layout.blocks[at - 1]), /added to the current latent, so that$/);
    assert.match(text(layout.blocks[at + 1]), /^where fθ is a transformer/);
  });

  it('keeps the references one entry each', () => {
    const start = layout.blocks.findIndex((block) => block.kind === 'heading' && text(block) === 'REFERENCES');
    assert.deepEqual(layout.blocks.slice(start + 1).map(text), [
      '[1] A. Author, “A path towards planning with learned models,” OpenReview, 2022.',
      '[2] B. Writer et al., “Self-supervised video models enable understanding, prediction and planning,” arXiv preprint arXiv:2501.00001, 2025.',
    ]);
  });
});
