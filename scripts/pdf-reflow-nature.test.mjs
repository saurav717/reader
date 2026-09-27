// Reflow on a two-column review set as Nature's npj journals set one, read
// with pdf.js as the app reads it (scripts/fixtures/nature-review.tex, made
// up, after "Fusion of medical imaging and electronic health records using
// deep learning", npj Digital Medicine, 2020). With no "Abstract" over its
// abstract, the byline was never read: its numbers were left in the text as
// citations, and the footnote that says what they stand for was left under
// it. Its subsections, headed in the text's own type, ran into their
// paragraphs; its table of studies, set sideways on a page of its own, was
// not read at all, and read, each study's cells ran on to rows of their
// own; and its Author Contributions named the authors by initials only.
//
//   node --test scripts/pdf-reflow-nature.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const TITLE = 'Fusion of imaging and health records in Northfield';
let layout;
let pages;
let standing;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/nature-review.pdf', import.meta.url)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) pages.push(await extractPage(await doc.getPage(number)));
  standing = await extractPage(await doc.getPage(2), { turn: false });
  await task.destroy();
  layout = layoutPages(pages, { title: TITLE });
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const author = (name) => layout.byline.authors.find((one) => one.name === name);

describe('a review set as an npj journal sets one', () => {
  it('reads the byline though no "Abstract" is over the abstract, the marks set apart by a badge included', () => {
    assert.deepEqual(
      layout.byline.authors.map((one) => [one.name, one.marks.join()]),
      [
        ['Ada Lindqvist', '1,2,4,✉'],
        ['Tomas Okafor', '2,4'],
        ['Mira Castell', '1,3'],
      ],
    );
    // The byline is the reader's heading, not a paragraph with citations in it; the abstract comes first.
    assert.match(text(layout.blocks[0]), /^Advancements in deep learning carry the potential/);
    assert.ok(!layout.blocks.some((block) => /Ada Lindqvist/.test(text(block)) && block.kind === 'paragraph' && !/A\.L\./.test(text(block))));
    assert.deepEqual(layout.front.map(plain), ['REVIEW ARTICLE']);
  });

  it('reads the footnote of institutions, notes and the address to write to into the byline', () => {
    assert.deepEqual(author('Ada Lindqvist').affiliations, ['Department of Biomedical Data Science, Northfield University, Northfield, USA', 'Center for Imaging, Northfield University, Northfield, USA']);
    assert.deepEqual(author('Mira Castell').affiliations, ['Department of Biomedical Data Science, Northfield University, Northfield, USA', 'Department of Radiology, Eastmoor University, Eastmoor, USA']);
    assert.deepEqual(author('Ada Lindqvist').notes, ['Corresponding author: adal@northfield.example.org', 'These authors contributed equally: Ada Lindqvist, Tomas Okafor']);
    assert.deepEqual(author('Tomas Okafor').notes, ['These authors contributed equally: Ada Lindqvist, Tomas Okafor']);
    assert.deepEqual(author('Ada Lindqvist').emails, ['adal@northfield.example.org']);
    assert.deepEqual(layout.blocks.filter((block) => block.kind === 'footnote').map(text), []);
  });

  it('gives each author the clauses of the Author Contributions that name them by their initials', () => {
    assert.deepEqual(author('Mira Castell').contributions, ['Concept and design: A.L., T.O. and M.C.', 'Supervision: M.C.']);
    assert.deepEqual(author('Tomas Okafor').contributions, [
      'A.L. and T.O. are co-first authors who contributed equally to this study.',
      'Concept and design: A.L., T.O. and M.C.',
      'Study selection: A.L. and T.O.',
    ]);
  });

  it('reads subsections headed in the text\'s own type as headings under the sections', () => {
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map((block) => [block.level, text(block)]);
    assert.deepEqual(headings, [
      [2, 'INTRODUCTION'],
      [3, 'Early fusion'],
      [3, 'Late fusion'],
      [2, 'AUTHOR CONTRIBUTIONS'],
    ]);
    assert.ok(layout.blocks.some((block) => /^The majority of the studies that remained/.test(text(block))));
  });

  it('reads a table set sideways on its page, turning the page to read it', () => {
    assert.equal(pages[1].turned, 90);
    // Where the page's boxes are laid over the page as it stands, it is read so.
    assert.equal(standing.turned, undefined);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.equal(text(table), 'Table 1. Overview of studies included in the review.');
    assert.equal(table.crop.turned, 90);
  });

  it('keeps each record of a table whose cells run on to lines of their own one row', () => {
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plain(cell.spans))), [
      ['Fusion strategy', 'Year', 'Author', 'Outcome', 'Input: non-imaging data', 'Number of samples', 'Model performance'],
      ['Early', '2017', 'Thung et al.', 'Diagnosis of Alzheimer’s disease', 'Patient data (age, sex, education) Genetic data (APOE4)', '805', 'Fusion: 63.6% Accuracy MRI: 58.0% Accuracy'],
      ['Early', '2018', 'An et al.', 'Glaucoma classification', 'Patient data (age, sex, spherical equivalent)', '163', 'Fusion: 87.8% Accuracy'],
      ['Late', '2018', 'Reda et al.', 'Prostate cancer diagnosis', 'PSA blood test', '18', 'Fusion: 94.4% Accuracy MRI: 88.89% Accuracy'],
    ]);
  });
});
