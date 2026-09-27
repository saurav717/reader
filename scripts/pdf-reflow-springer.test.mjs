// Reflow on a two-column paper set as a Springer journal sets one, read
// with pdf.js as the app reads it (scripts/fixtures/springer-two-column.tex,
// made up, after "The utility of lesion classification in predicting
// language and treatment outcomes", Brain Imaging and Behavior, 2019).
// There the byline's numbers were said nowhere near it — the institutions
// sit in a footnote block, each number hung in the margin apart from its
// text, and the author to write to under an envelope — and all of it came
// out as loose footnotes: "1", "2", an address, a paragraph of places. Its
// captions, "Fig. 1" in a sans bold with the caption straight after, were
// not captions; a table captioned in the margin beside it was prose; a
// table across both columns was cut at the first; a fraction set in a line
// broke it; the acknowledgments, set small under a heading, were footnotes;
// and each reference was cut at its first line.
//
//   node --test scripts/pdf-reflow-springer.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');
const { placeOnly, rolesOnPaper, whereTheyAre } = await load('src/lib/byline.ts');

after(cleanup);

const TITLE = 'Lesion classes predict aphasia outcomes';
let layout;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/springer-two-column.pdf', import.meta.url)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) pages.push(await extractPage(await doc.getPage(number)));
  await task.destroy();
  layout = layoutPages(pages, { title: TITLE });
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const author = (name) => layout.byline.authors.find((one) => one.name === name);
const BOSTON = 'Aphasia Research Laboratory, Department of Speech, Northfield University, 635 Commonwealth Avenue, Northfield, MA 02215, USA';

describe('a paper set as a Springer journal sets one', () => {
  it('reads the names parted by bullets, and their numbers', () => {
    assert.deepEqual(
      layout.byline.authors.map((one) => [one.name, one.marks.join()]),
      [
        ['Ada Lindqvist', '1,2,✉'],
        ['Tomas Okafor', '1,3'],
        ['Mira Castell', '1'],
      ],
    );
    // The date under the names is no one's institution.
    assert.ok(!layout.byline.affiliations.some((place) => /Published/.test(place.text)));
  });

  it('reads the footnote block of the first page into the byline: the institutions, the present addresses, the author to write to', () => {
    assert.deepEqual(layout.byline.affiliations, [{ mark: '1', text: BOSTON }]);
    assert.deepEqual(author('Mira Castell').affiliations, [BOSTON]);
    assert.deepEqual(author('Ada Lindqvist').notes, ['Corresponding author', 'Present address: Neurology Department, Eastmoor University, 600 N. Wolfe Street, Eastmoor, USA']);
    assert.deepEqual(author('Tomas Okafor').notes, ['Present address: Heart and Lung Research Institute, Westfield University, Westfield, USA']);
    assert.deepEqual(author('Ada Lindqvist').emails, ['adal@northfield.example.edu']);
    // Nothing of it is left over as a footnote.
    assert.deepEqual(layout.blocks.filter((block) => block.kind === 'footnote').map(text), []);
  });

  it('shows the paper\'s institution without its street, and where they had moved to as that, not as a role', () => {
    assert.equal(placeOnly(BOSTON), 'Aphasia Research Laboratory, Department of Speech, Northfield University, Northfield, USA');
    assert.deepEqual(rolesOnPaper(author('Ada Lindqvist'), 0), ['First author', 'Corresponding author']);
    const { then } = whereTheyAre({ onPaper: author('Tomas Okafor') });
    assert.equal(then.place, 'Aphasia Research Laboratory, Department of Speech, Northfield University, Northfield, USA');
    assert.equal(then.moved, 'Heart and Lung Research Institute, Westfield University, Westfield, USA');
  });

  it('reads a caption whose label is set apart in a face of its own, with no stop after it', () => {
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.equal(text(figure), 'Fig. 1 Anatomical masks. Gray matter regions of interest, including DLPFC and iFrontal');
  });

  it('reads a table captioned in the margin beside it, and keeps its note under it', () => {
    const table = layout.blocks.find((block) => block.kind === 'table' && block.label === 'Table 1');
    assert.equal(text(table), 'Table 1 Regions of interest included in large gray matter masks');
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plain(cell.spans))), [
      ['Number', 'ROI mask', 'Atlas ROI'],
      ['1', 'DLPFC', 'Superior frontal gyrus'],
      ['2', 'DLPFC', 'Middle frontal gyrus'],
      ['3', 'iFrontal', 'Inferior frontal gyrus'],
      ['4', 'iFrontal', 'Insula'],
    ]);
    assert.equal(plain(table.notes), 'DLPFC dorsolateral prefrontal cortex');
  });

  it('reads a table across both columns under a caption as short as one', () => {
    const table = layout.blocks.find((block) => block.kind === 'table' && block.label === 'Table 2');
    assert.deepEqual(table.rows[0].map((cell) => plain(cell.spans)), ['ID', 'Sex', 'Hand', 'Age', 'MPO', 'Education', 'Lesion Volume (cc)', 'WAB-R AQ (/100)', 'PMG']);
    assert.deepEqual(table.rows.at(-1).map((cell) => plain(cell.spans)), ['P3', 'F', 'R', '63', '62', '16', '175.38', '52.0', '0.36']);
  });

  it('keeps a fraction set in a line of text in the line, read as one', () => {
    const paragraph = layout.blocks.find((block) => /^Aphasia is one of the most common/.test(text(block)));
    assert.match(text(paragraph), /using the following for-?mula: \(AVG Post−AVG Pre\)\/\(n items−AVG Pre\) ?, where AVG Pre and AVG Post denote the averaged accuracy/);
    assert.match(text(paragraph), /in the years beyond stroke onset with targeted treatment\.$/);
  });

  it('keeps small type under a heading at the foot of a column in the text', () => {
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map(text);
    assert.deepEqual(headings, ['Abstract', 'Introduction', 'Methods', 'Compliance with ethical standards', 'References']);
    const at = layout.blocks.findIndex((block) => text(block) === 'Compliance with ethical standards');
    assert.match(text(layout.blocks[at - 1]), /^Acknowledgments This work was supported/);
    assert.match(text(layout.blocks[at + 1]), /^Conflicts of interest This study was funded/);
  });

  it('keeps each reference one entry, its turnover lines hung under it', () => {
    const at = layout.blocks.findIndex((block) => text(block) === 'References');
    const entries = layout.blocks.slice(at + 1).map(text);
    assert.equal(entries.length, 3);
    assert.match(entries[0], /^Basilakos, A\., Fillmore, P\. T\., Rorden, C\., Guo, D\., Bonilha, L\., & Fridriksson, J\. \(2014\)\./);
    assert.match(entries[1], /^Beeson, P\. M\., & Robey, R\. R\. \(2006\)\. Evaluating single-subject treatment research/);
    assert.match(entries[2], /^Boehme, A\. K\., Martin-Schild, S\., Marshall, R\. S\., & Lazar, R\. M\. \(2016\)\./);
    assert.match(text(layout.blocks[at + 1]), /Frontiers in Human Neuroscience, 8\.$/);
  });
});
