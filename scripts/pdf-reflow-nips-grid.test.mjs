// Reflow on a paper set as NIPS 2017 set "Attention Is All You Need"
// (arXiv:1706.03762), read with pdf.js as the app reads it
// (scripts/fixtures/nips-grid-byline.tex, made up). Its byline is a grid —
// each name over its institution and its address — which was read as one
// list of institutions and addresses nobody's; a notice over the title was
// taken for an institution; the footnote on every name, which says who did
// what, was cut at its first line and the rest of it put under the
// abstract, and its every sentence shown on every author's card; its
// paragraphs, parted by space rather than an indent, were run together; a
// sum in a footnote was taken for an equation; a table of O(n)s was read
// as one row; and a figure's label that its clip leaves out was a heading.
//
//   node --test scripts/pdf-reflow-nips-grid.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');
const { rolesOnPaper } = await load('src/lib/byline.ts');

after(cleanup);

const TITLE = 'Attention Is What Northfield Needs';
let layout;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/nips-grid-byline.pdf', import.meta.url)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) pages.push(await extractPage(await doc.getPage(number)));
  await task.destroy();
  layout = layoutPages(pages, { title: TITLE });
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const author = (name) => layout.byline.authors.find((one) => one.name === name);

describe('a paper whose byline is a grid', () => {
  it('reads each column: the name, the institution under it, the address under that', () => {
    assert.deepEqual(
      layout.byline.authors.map((one) => [one.name, one.marks.join(), one.affiliations.join(), one.emails.join()]),
      [
        ['Ada Lindqvist', '∗', 'Northfield Brain', 'adal@nf.example.com'],
        ['Tomas Okafor', '∗', 'Northfield Research', 'tko@nf.example.com'],
        ['Mira Castell', '∗,†', 'University of Eastmoor', 'mira@eastmoor.example.edu'],
        ['Łukasz Borowski', '∗', 'Northfield Brain', 'lukaszb@nf.example.com'],
        ['Ravi Anand', '∗,‡', '', 'ravi.anand@mail.example.org'],
      ],
    );
    assert.deepEqual(layout.byline.affiliations.map((place) => place.text), ['Northfield Brain', 'Northfield Research', 'University of Eastmoor']);
  });

  it('keeps a notice set over the title out of the byline', () => {
    assert.match(plain(layout.front[0]), /^Provided proper attribution is provided, Northfield Research grants permission/);
    assert.ok(!layout.byline.affiliations.some((place) => /permission/.test(place.text)));
  });

  it('reads the footnote on the names whole, and gives each author the sentences about them', () => {
    const note = layout.byline.notes.find((one) => one.mark === '∗');
    assert.equal(note.text, 'Equal contribution. Listing order is random');
    assert.deepEqual(author('Ada Lindqvist').contributions, ['Ada, with Ravi, designed and implemented the first models and has been crucially involved in every aspect of this work.']);
    assert.deepEqual(author('Mira Castell').contributions, [
      'Mira proposed replacing recurrence with attention and started the effort to evaluate this idea.',
      'Lukasz and Mira spent countless long days designing various parts of the codebase.',
    ]);
    // "Lukasz" in the note is Łukasz on the byline.
    assert.deepEqual(author('Łukasz Borowski').contributions, ['Lukasz and Mira spent countless long days designing various parts of the codebase.']);
    assert.deepEqual(author('Ravi Anand').notes, ['Equal contribution. Listing order is random', 'Work performed while at Northfield Research']);
    assert.ok(!layout.blocks.some((block) => /Listing order|crucially involved/.test(text(block))));
  });

  it('names no first author where the order is random, and makes a chip of each sentence', () => {
    assert.deepEqual(rolesOnPaper(author('Ada Lindqvist'), 0), ['Equal contribution', 'Listing order is random']);
  });

  it('keeps the statement whole for a reader, the Author Contributions section with it', () => {
    assert.match(layout.byline.statement, /^∗Equal contribution\. Listing order is random\. Mira proposed/);
    assert.match(layout.byline.statement, /A\.L\. and R\.A\. wrote the first implementation\. T\.O\. ran the translation experiments\./);
  });

  it('parts paragraphs set apart by space, not by an indent', () => {
    const paragraphs = layout.blocks.filter((block) => block.kind === 'paragraph').map(text);
    assert.ok(paragraphs.some((one) => /^We call our particular attention/.test(one) && /weights on the values\.$/.test(one)));
    assert.ok(paragraphs.some((one) => /^In practice, we compute the attention function/.test(one)));
    assert.ok(paragraphs.some((one) => /^While for small values of dk/.test(one) && /multiply those weights by √dmodel as well\.$/.test(one)));
  });

  it('keeps a sum in a footnote in the footnote', () => {
    const notes = layout.blocks.filter((block) => block.kind === 'footnote').map(text);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^4To illustrate why the dot products get large, assume that the components of q and k are independent random variables .* q · k = ∑.*qiki, has mean 0 and variance dk\.$/);
    assert.equal(layout.blocks.filter((block) => block.kind === 'equation').length, 0);
  });

  it('reads a table of O(n)s row by row', () => {
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.deepEqual(
      table.rows.map((row) => row.map((cell) => plain(cell.spans))),
      [
        ['Layer Type', 'Complexity per Layer', 'Sequential', 'Maximum Path Length'],
        ['Self-Attention', 'O(n2 · d)', 'O(1)', 'O(1)'],
        ['Recurrent', 'O(n · d2)', 'O(n)', 'O(n)'],
        ['Convolutional', 'O(k · n · d2)', 'O(1)', 'O(logk(n))'],
      ],
    );
  });

  it('leaves out a label the figure\'s clip leaves out', () => {
    assert.deepEqual(
      layout.blocks.filter((block) => block.kind === 'heading').map(text),
      ['Abstract', '1 Model', 'Author Contributions', 'Attention Visualizations'],
    );
    assert.ok(!layout.blocks.some((block) => /Hidden-Layer/.test(text(block))));
  });
});
