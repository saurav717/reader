// Reflow on a real PDF, read with pdf.js as the app reads it: a two-column
// paper in Times, its code in Inconsolata (scripts/fixtures/
// two-column-listings.tex, made up), with listings, numbered paragraphs and
// algorithms set in a column — an algorithm in each of the three ways
// algorithm packages set one: ruled, boxed, and plain — and its byline
// centred across both columns, the second name over the right column.
//
//   node --test scripts/pdf-reflow-two-column-listings.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, renderHtml, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const TITLE = 'Incremental Parsing for Structured Editors';
let layout;
let html;

before(async () => {
  const data = new Uint8Array(await readFile(new URL('./fixtures/two-column-listings.pdf', import.meta.url)));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) pages.push(await extractPage(await doc.getPage(number)));
  await task.destroy();
  layout = layoutPages(pages, { title: TITLE });
  html = renderHtml(layout, (crop) => `crop-${crop.id}.png`);
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const code = (block) => block.spans.map((span) => span.text).join('');
const figures = () => layout.blocks.filter((block) => block.kind === 'figure');

describe('a two-column paper with listings and algorithms in its columns', () => {
  it('reads the headings in order, and no name from the byline among them', () => {
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map(text);
    assert.deepEqual(headings, ['Abstract', '1 Introduction', '2 Method', '3 Checking the Trees', '4 Conclusion']);
    assert.ok(!layout.blocks.some((block) => /Mira Castell|Ravi Anand/.test(text(block))));
  });

  it('reads a numbered paragraph turning over in a narrow column as one', () => {
    const numbered = layout.blocks.filter((block) => block.kind === 'paragraph' && block.list === 'number').map(text);
    assert.deepEqual(numbered, [
      '1. Smallest enclosing node. Walk up from the edited token until the node’s range covers the whole edit and its starting state is one the edit cannot have changed, then reparse that node alone.',
      '2. Splicing. Replace the old node with the new one and shift the ranges of every node after it by the length the edit added:',
    ]);
  });

  it('keeps a listing in a column, set in Inconsolata, a line each and indented', () => {
    const listings = layout.blocks.filter((block) => block.kind === 'paragraph' && block.code);
    assert.equal(listings.length, 1);
    assert.equal(code(listings[0]), ['node = enclosing(tree, edit)', 'fresh = parse(text, node.start)', 'tree.replace(node, fresh)', 'for later in tree.after(node):', '    later.shift(edit.delta)'].join('\n'));
    assert.match(html, /<pre class="pdf-code">/);
  });

  it('paints each algorithm — ruled, boxed and plain — under its caption, and reads none of its steps as text', () => {
    assert.deepEqual(figures().map(text), ['Algorithm 1 Incremental reparse.', 'Algorithm 2: Comparing two trees.', 'Algorithm 3: Visiting every node.']);
    for (const figure of figures()) assert.ok(figure.crop.y1 - figure.crop.y0 > 40, `${figure.label} ${JSON.stringify(figure.crop)}`);
    assert.ok(!layout.blocks.some((block) => block.kind !== 'figure' && /←|end while|push the children|then return|child pair/.test(text(block))), layout.blocks.map(text).join('\n'));
  });

  it('keeps each algorithm in its own column, and the boxed one inside its frame', () => {
    const [ruled, boxed, plainSteps] = figures().map((figure) => figure.crop);
    // Ruled, at the foot of the left column; the other two in the right.
    assert.ok(ruled.x1 < 320 && ruled.y0 > 600, JSON.stringify(ruled));
    assert.ok(boxed.x0 > 300 && plainSteps.x0 > 300, JSON.stringify([boxed, plainSteps]));
    // The frame, and not the caption set under it.
    assert.ok(boxed.y1 - boxed.y0 < 80, JSON.stringify(boxed));
  });

  it('goes on with the text after each algorithm', () => {
    const paragraphs = layout.blocks.filter((block) => block.kind === 'paragraph' && !block.code).map(text);
    for (const start of ['Algorithm 1 is all the parser does on an edit', 'Algorithm 2 compares two trees from the root down', 'Algorithm 3 visits the nodes breadth first']) {
      assert.ok(paragraphs.some((one) => one.startsWith(start)), start);
    }
  });
});
