// Reflow on a real PDF, read with pdf.js as the app reads it: a paper with
// an appendix of tables, listings and an algorithm (scripts/fixtures/
// appendix-listings.tex, made up), set as papers whose layout the reader
// once took apart are set — a heading in bold sans, its number an em apart,
// read into the notes or the last row of the table over it; numbered
// paragraphs cut after their first line; listings run together as prose;
// a prompt set small at the foot of the page read as footnotes; and an
// algorithm's steps read as headings and paragraphs, its caption with them.
//
//   node --test scripts/pdf-reflow-appendix.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, renderHtml, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const TITLE = 'Compiling Spreadsheet Formulas to Vector Code';
let layout;
let html;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/appendix-listings.pdf', import.meta.url)));
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
const code = (block) => block.spans.map((span) => span.text).join('');

describe('an appendix of tables, listings and an algorithm', () => {
  it('keeps each heading whole, though a table and its notes are set straight over it', () => {
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map((block) => [block.level, text(block)]);
    assert.deepEqual(headings, [
      [4, 'Abstract'],
      [2, '1 Introduction'],
      [2, 'A Supplementary Details'],
      [3, 'A.1 Workbook Corpus'],
      [3, 'A.2 Interpreter Comparison Details'],
      [3, 'A.3 Hardware Comparison'],
      [3, 'A.4 Compilation Metrics'],
      [2, 'B Optimization Guide'],
      [3, 'B.1 Recalculation Prompt'],
    ]);
  });

  it('leaves the heading out of the table over it: its notes, and its rows', () => {
    const [corpus, throughput] = layout.blocks.filter((block) => block.kind === 'table');
    assert.equal(plain(corpus.notes), '§Volatile functions recomputed each time. †Not timed.');
    assert.deepEqual(cells(throughput), [
      ['Machine', 'Cells/s', 'vs. Interpreter'],
      ['Laptop', '13.1M', '29×'],
      ['Server', '1.4B', '23×'],
    ]);
  });

  it('reads a numbered paragraph led by a run-in heading as one, its lines turning over to the margin', () => {
    const numbered = layout.blocks.filter((block) => block.kind === 'paragraph' && block.list === 'number').map(text);
    assert.equal(numbered.length, 3);
    assert.match(numbered[0], /^1\. Fixed-width columns\. The compiler needs every column’s type known in advance\. Replace mixed columns .* sentinel value\.$/);
    assert.match(numbered[1], /^2\. Branchless conditionals with np\.where\. Replace each IF with np\.where\(condition, if_true, if_false\), .* to branch:$/);
    assert.match(numbered[2], /^3\. Cache the compiled kernels\. .* when the workbook is opened\.$/);
    // Taken up again after the listing between them, the list goes on from its number.
    assert.match(html, /<ol>\s*<li><strong>Fixed-width columns\.<\/strong> The compiler/);
    assert.match(html, /<ol start="3">\s*<li><strong>Cache the compiled kernels\.<\/strong>/);
  });

  it('keeps a listing\'s lines and their indents, apart from the text', () => {
    const listings = layout.blocks.filter((block) => block.kind === 'paragraph' && block.code);
    assert.equal(listings.length, 2);
    assert.equal(code(listings[0]), ['total = np.where(paid, amount, 0.0)', 'column = compile_column(', '    formula,', '    dtype=np.float64', ')'].join('\n'));
    assert.match(html, /<pre class="pdf-code"><code>total = np\.where\(paid, amount, 0\.0\)<\/code>\n<code>column = compile_column\(<\/code>\n/);
  });

  it('reads a prompt set small at the foot of the page as a listing, its bold labels in it, and no footnote', () => {
    const prompt = layout.blocks.filter((block) => block.kind === 'paragraph' && block.code)[1];
    const lines = code(prompt).split('\n');
    assert.deepEqual(lines.slice(0, 4), [
      'The compiled sheet agrees with the interpreter. Now make it',
      'faster without changing any result.',
      'Target:  Fewer seconds per recalculation, every check passing.',
      'Constraints:',
    ]);
    assert.match(lines[4], /^ {2}- Every comparison must still pass afterwards$/);
    assert.match(lines[6], /^ {4}values\)$/);
    assert.ok(prompt.spans.some((span) => span.bold && span.text === 'Constraints:'));
    assert.equal(layout.blocks.filter((block) => block.kind === 'footnote').length, 0);
  });

  it('paints an algorithm ruled off under its caption, and reads none of its steps as text', () => {
    const algorithm = layout.blocks.find((block) => block.kind === 'figure');
    assert.equal(algorithm.label, 'Algorithm 1');
    assert.equal(text(algorithm), 'Algorithm 1 Column-by-column compilation.');
    // From the rule under the caption to the rule that closes it: all eight steps.
    assert.ok(algorithm.crop.y1 - algorithm.crop.y0 > 100, JSON.stringify(algorithm.crop));
    assert.ok(!layout.blocks.some((block) => block.kind !== 'figure' && /Phase 1|Compare|end for/.test(text(block))));
    assert.equal(text(layout.blocks[layout.blocks.length - 1]), 'Algorithm 1 sets out the loop the compiler runs, column by column, until every comparison passes.');
  });
});
