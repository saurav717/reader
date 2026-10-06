// Reflow on a PDF as dvips makes one — the ACL and many an older arXiv
// paper: Type 1 text, and every rule of a table drawn as an image mask a
// pixel high and wide, stretched to a line. pdf.js paints such a mask as a
// solid unit square, and the reader once saw no rules at all in these
// papers: the header of each table was read as the text's, a group's
// label in italics as wide as a line ended the table, and the heading
// words that came round at the head of page after page — "Model",
// "MNLI-m", each table setting them where its columns fell — were dropped
// as a running head. The page here is written out by hand, with the fonts
// every PDF reader has, so that the test needs no TeX.
//
//   node --test scripts/pdf-reflow-dvips.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { extractPage } = await load('src/lib/pdfExtract.ts', { external: ['pdfjs-dist'], imports: true });
const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

/** A rule as dvips draws one: a 1×1 image mask, scaled by the matrix to a line. pdf.js paints it as a solid colour. */
const rule = (x, y, width, height) => `q ${width} 0 0 ${height} ${x} ${y} cm BI /W 1 /H 1 /IM true /BPC 1 ID \x00 EI Q\n`;
const text = (x, y, size, str, font = 'F1') => `BT /${font} ${size} Tf ${x} ${y} Td (${str.replace(/[()\\]/g, '\\$&')}) Tj ET\n`;
const BODY = 'Body text runs on across the column here';

/** A table of four columns at the head of a column, captioned under it, its rules as dvips draws them. */
function table(x) {
  let out = '';
  out += rule(x - 8, 760, 220, 0.8);
  out += text(x, 745, 10, 'Model', 'F2') + text(x + 62, 745, 10, 'SQuAD 2.0', 'F2') + text(x + 132, 745, 10, 'MNLI-m', 'F2') + text(x + 186, 745, 10, 'SST-2', 'F2');
  out += rule(x - 8, 738, 220, 0.5);
  out += text(x, 725, 10, 'reference') + text(x + 72, 725, 10, '76.3') + text(x + 137, 725, 10, '84.3') + text(x + 189, 725, 10, '92.8');
  out += text(x, 710, 10, 'Our reimplementation (without NSP loss):', 'F3');
  out += text(x, 695, 10, 'static') + text(x + 72, 695, 10, '78.3') + text(x + 137, 695, 10, '84.3') + text(x + 189, 695, 10, '92.5');
  out += text(x, 680, 10, 'dynamic') + text(x + 72, 680, 10, '78.7') + text(x + 137, 680, 10, '84.0') + text(x + 189, 680, 10, '92.9');
  out += rule(x - 8, 672, 220, 0.8);
  out += text(x - 8, 655, 9, 'Table 1: Comparison between static and dynamic') + text(x - 8, 644, 9, 'masking. Reference results are from Yang et al.');
  return out;
}

/** The two pages: the table in the right column of the first, in the left column of the second, and a running head on both. */
function pages() {
  const head = text(72, 800, 9, 'Preprint. Under review.');
  const first = head + table(320) + Array.from({ length: 8 }, (_, i) => text(312, 620 - i * 12, 10, BODY)).join('') + Array.from({ length: 20 }, (_, i) => text(72, 745 - i * 12, 10, BODY)).join('');
  const second = head + table(80) + Array.from({ length: 8 }, (_, i) => text(72, 620 - i * 12, 10, BODY)).join('') + Array.from({ length: 20 }, (_, i) => text(312, 745 - i * 12, 10, BODY)).join('');
  return [first, second];
}

/** The PDF, written out object by object with its cross-reference table. */
function pdfOf(contents) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${contents.length} >>`,
  ];
  for (const content of contents) {
    const page = objects.length + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${3 + 2 * contents.length} 0 R /F2 ${4 + 2 * contents.length} 0 R /F3 ${5 + 2 * contents.length} 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

let inputs;
let layout;

before(async () => {
  const task = getDocument({ data: pdfOf(pages()), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  inputs = [];
  for (let number = 1; number <= doc.numPages; number += 1) inputs.push(await extractPage(await doc.getPage(number)));
  await task.destroy();
  layout = layoutPages(inputs);
});

const cells = (block) => block.rows.map((row) => row.map((cell) => plain(cell.spans)));

describe('a PDF whose rules are image masks', () => {
  it('reads each rule as a drawn line, not a picture', () => {
    for (const page of inputs) {
      const rules = page.graphics.filter((box) => box.y1 - box.y0 < 1.5 && box.x1 - box.x0 > 200);
      assert.equal(rules.length, 3, JSON.stringify(page.graphics));
      assert.ok(rules.every((box) => box.kind === 'path'));
    }
  });

  it('reads the table whole: its heading row, the italic label of a group of rows, and its caption', () => {
    const tables = layout.blocks.filter((block) => block.kind === 'table');
    assert.equal(tables.length, 2);
    for (const found of tables) {
      assert.match(plain(found.caption), /^Table 1: Comparison between static and dynamic masking\. Reference results are from Yang et al\./);
      assert.deepEqual(cells(found)[0], ['Model', 'SQuAD 2.0', 'MNLI-m', 'SST-2']);
      assert.ok(found.rows[0].every((cell) => cell.head));
      assert.deepEqual(cells(found).slice(1).map((row) => row[0]), ['reference', 'Our reimplementation (without NSP loss):', 'static', 'dynamic']);
      assert.deepEqual(cells(found)[4], ['dynamic', '78.7', '84.0', '92.9']);
    }
  });

  it('drops the running head, set in the same place on every page, and keeps the heading words that come round in different places', () => {
    const texts = layout.blocks.filter((block) => 'spans' in block).map((block) => plain(block.spans));
    assert.ok(!texts.some((text) => /Preprint/.test(text)), texts.join('\n'));
    assert.ok(!texts.some((text) => /Model|MNLI-m|SST-2|reference|dynamic/.test(text)), texts.join('\n'));
    const paragraphs = layout.blocks.filter((block) => block.kind === 'paragraph');
    assert.ok(paragraphs.length >= 1);
    assert.ok(paragraphs.every((block) => /^(Body text runs on across the column here ?)+$/.test(plain(block.spans))), texts.join('\n'));
  });
});
