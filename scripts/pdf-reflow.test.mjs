// What the reflow makes of a PDF's glyphs: columns read in order, lines
// mended into paragraphs, headings told from body text, captions given
// their figures and tables, and the text checked for being text at all.
// No pdf.js here: the pages are made up, run by run, which is the point of
// keeping the layout apart from the library that reads the file.
//
//   node --test scripts/pdf-reflow.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { layoutPages, renderHtml, readingOrder, tableFromLines, composeAccents, faceOf, plain, entryStarts } = await load('src/lib/pdfLayout.ts');

after(cleanup);

/** A line of text at a place, as pdf.js would report it: one run, 9pt, 5pt per character. */
const line = (str, x, y, options = {}) => ({
  str,
  x,
  y,
  width: options.width ?? str.length * (options.size ?? 9) * 0.5,
  size: options.size ?? 9,
  font: options.font ?? 'NimbusRomNo9L-Regu',
});

/** A column of justified body text: full lines, and a short last one. */
function column(x, top, sentences, options = {}) {
  const runs = [];
  let y = top;
  for (const [index, sentence] of sentences.entries()) {
    const last = index === sentences.length - 1;
    runs.push(line(sentence, x, y, { width: last ? undefined : 240, ...options }));
    y += 10.8;
  }
  return runs;
}

const page = (runs, graphics = [], index = 0) => ({ index, width: 612, height: 792, runs, graphics });

const texts = (layout) => layout.blocks.map((block) => ('spans' in block ? plain(block.spans) : block.label));

describe('reading order', () => {
  it('reads a page of two columns down the left column first', () => {
    const boxes = [
      { x0: 54, y0: 100, x1: 294, y1: 110, name: 'L1' },
      { x0: 314, y0: 100, x1: 554, y1: 110, name: 'R1' },
      { x0: 54, y0: 112, x1: 294, y1: 122, name: 'L2' },
      { x0: 314, y0: 112, x1: 554, y1: 122, name: 'R2' },
    ];
    assert.deepEqual(readingOrder(boxes).map((box) => box.name), ['L1', 'L2', 'R1', 'R2']);
  });

  it('reads a full-width title before the columns under it', () => {
    const boxes = [
      { x0: 54, y0: 112, x1: 294, y1: 122, name: 'L1' },
      { x0: 314, y0: 112, x1: 554, y1: 122, name: 'R1' },
      { x0: 100, y0: 60, x1: 500, y1: 80, name: 'Title' },
      { x0: 54, y0: 124, x1: 294, y1: 134, name: 'L2' },
      { x0: 314, y0: 124, x1: 554, y1: 134, name: 'R2' },
    ];
    assert.deepEqual(readingOrder(boxes).map((box) => box.name), ['Title', 'L1', 'L2', 'R1', 'R2']);
  });

  it('keeps a column together across a gap that happens to line up in both columns', () => {
    const boxes = [
      { x0: 54, y0: 100, x1: 294, y1: 110, name: 'L1' },
      { x0: 314, y0: 100, x1: 554, y1: 110, name: 'R1' },
      // A section gap in both columns at the same height.
      { x0: 54, y0: 130, x1: 294, y1: 140, name: 'L2' },
      { x0: 314, y0: 130, x1: 554, y1: 140, name: 'R2' },
    ];
    assert.deepEqual(readingOrder(boxes).map((box) => box.name), ['L1', 'L2', 'R1', 'R2']);
  });
});

describe('paragraphs', () => {
  it('joins the lines of a paragraph, mends a word broken at the line end, and starts a new paragraph at an indent', () => {
    const runs = [
      ...column(54, 100, ['Dynamic languages such as JavaScript are more difficult to com-', 'pile than statically typed ones. Since no concrete type infor-', 'mation is available, compilers emit generic code.']),
      line('The second paragraph starts with an indent and goes on for a', 66, 132.4, { width: 228 }),
      line('while before it ends.', 54, 143.2),
    ];
    const layout = layoutPages([page(runs)]);
    assert.deepEqual(texts(layout), [
      'Dynamic languages such as JavaScript are more difficult to compile than statically typed ones. Since no concrete type information is available, compilers emit generic code.',
      'The second paragraph starts with an indent and goes on for a while before it ends.',
    ]);
  });

  it('keeps the hyphen of a word the paper writes hyphenated elsewhere', () => {
    const runs = [
      ...column(54, 100, ['The cost of the method is quasi-linear in the resolution, and', 'stays that way. A second sentence says again that it is quasi-', 'linear. And a broken word like infor-', 'mation is mended.']),
    ];
    const text = texts(layoutPages([page(runs)]))[0];
    assert.ok(text.includes('it is quasi-linear.'), text);
    assert.ok(text.includes('like information is mended.'), text);
  });

  it('carries a paragraph over from the end of one column to the top of the next', () => {
    const runs = [
      ...column(54, 100, ['The left column ends in the middle of a sentence that carries on', 'in the right column, where it']),
      ...column(314, 100, ['finishes.', 'A new paragraph then begins here and runs on for a bit more text.']),
    ];
    // The second column's first line is short and lowercase; the paragraph after it is a fresh one.
    runs[2] = line('finishes.', 314, 100);
    runs[3] = line('A new paragraph then begins here and runs on for a bit more text.', 326, 110.8, { width: 228 });
    const layout = layoutPages([page(runs)]);
    assert.deepEqual(texts(layout), [
      'The left column ends in the middle of a sentence that carries on in the right column, where it finishes.',
      'A new paragraph then begins here and runs on for a bit more text.',
    ]);
  });

  it('keeps a superscript with its line and marks it up', () => {
    const runs = [
      line('A claim with a footnote', 54, 100, { width: 100 }),
      line('1', 154, 96.5, { size: 6, width: 3 }),
      line('and then more words to make the line body-sized and full.', 158, 100, { width: 136 }),
      line('The next line of the same paragraph carries on below it here.', 54, 110.8, { width: 240 }),
    ];
    const html = renderHtml(layoutPages([page(runs)]), () => null);
    assert.match(html, /footnote<sup>1<\/sup> ?and then/);
  });

  it('turns bullets into a list', () => {
    const runs = [
      ...column(54, 100, ['This paper makes the following contributions, in order:']),
      line('• We explain an algorithm for forming trace trees to cover a', 60, 110.8, { width: 234 }),
      line('program, representing nested loops as nested trace trees.', 70, 121.6),
      line('• We validate the technique in an implementation.', 60, 132.4),
    ];
    const html = renderHtml(layoutPages([page(runs)]), () => null);
    assert.match(html, /<ul>\s*<li>We explain an algorithm.*nested trace trees\.<\/li>\s*<li>We validate/);
  });
});

describe('headings and front matter', () => {
  it('makes headings of bold and larger lines, with levels from their numbering', () => {
    const runs = [
      line('1. Introduction', 54, 100, { size: 11, font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 114, ['Body text follows the heading and is long enough to be body text.', 'It goes on for a second line, and a third, so that the size of the', 'body is not in doubt at all.']),
      line('1.1 A subsection', 54, 150, { font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 164, ['More body text under the subsection heading, again a full line.', 'And another full line of body text to keep the measure honest.', 'End.']),
    ];
    const layout = layoutPages([page(runs)]);
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map((block) => [block.level, plain(block.spans)]);
    assert.deepEqual(headings, [
      [2, '1. Introduction'],
      [3, '1.1 A subsection'],
    ]);
  });

  it('drops the title block above the abstract, which the reader shows itself', () => {
    const runs = [
      line('A Very Important Paper', 150, 80, { size: 17, font: 'NimbusRomNo9L-Medi', width: 300 }),
      line('Ada Lovelace, Charles Babbage', 200, 100, { size: 11, width: 200 }),
      line('Abstract', 54, 140, { size: 11, font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 154, ['The abstract of the paper runs for a couple of lines of body text', 'and then a third, which is short.', 'End.']),
    ];
    const layout = layoutPages([page(runs)], { title: 'A Very Important Paper' });
    assert.equal(texts(layout)[0], 'Abstract');
    assert.ok(!texts(layout).some((text) => text.includes('Lovelace')));
  });

  it('reads every author off the first page, past affiliations and addresses', () => {
    const runs = [
      line('Fusion Approaches to Predict Post-stroke Aphasia Severity from', 100, 70, { size: 14, font: 'NimbusRomNo9L-Medi', width: 400 }),
      line('Multimodal Neuroimaging Data', 200, 88, { size: 14, font: 'NimbusRomNo9L-Medi', width: 200 }),
      line('Saurav Chennuri, Sha Lai, Anne Billot, Maria Varkanitsa, Emily J. Braun, Swathi Kiran,', 80, 120, { size: 11, width: 440 }),
      line('Archana Venkataraman, Janusz Konrad, Prakash Ishwar, and Margrit Betke', 110, 134, { size: 11, width: 380 }),
      line('Boston University', 250, 148, { size: 11, width: 90 }),
      line('{saurav07,lais823,abillot,mvarkan,ejbraun,kirans,archanav,jkonrad,pi,betke}@bu.edu', 90, 162, { size: 9, font: 'NimbusMonL-Regu', width: 420 }),
      line('Abstract', 54, 200, { size: 11, font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 214, ['The abstract of the paper runs for a couple of lines of body text', 'and then a third, which is short.', 'End.']),
    ];
    const layout = layoutPages([page(runs)], { title: 'Fusion Approaches to Predict Post-stroke Aphasia Severity from Multimodal Neuroimaging Data' });
    assert.deepEqual(layout.authors, [
      'Saurav Chennuri', 'Sha Lai', 'Anne Billot', 'Maria Varkanitsa', 'Emily J. Braun', 'Swathi Kiran',
      'Archana Venkataraman', 'Janusz Konrad', 'Prakash Ishwar', 'Margrit Betke',
    ]);
  });

  it('drops the superscript marks that point at affiliations', () => {
    const runs = [
      line('A Very Important Paper', 150, 80, { size: 17, font: 'NimbusRomNo9L-Medi', width: 300 }),
      line('Ada Lovelace', 150, 100, { size: 11, width: 60 }),
      line('1', 211, 96, { size: 7, width: 3 }),
      line(', Charles Babbage', 215, 100, { size: 11, width: 80 }),
      line('1,2', 296, 96, { size: 7, width: 8 }),
      line('1', 150, 114, { size: 7, width: 3 }),
      line('University of London', 154, 118, { size: 11, width: 100 }),
      line('Abstract', 54, 140, { size: 11, font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 154, ['The abstract of the paper runs for a couple of lines of body text', 'and then a third, which is short.', 'End.']),
    ];
    assert.deepEqual(layoutPages([page(runs)], { title: 'A Very Important Paper' }).authors, ['Ada Lovelace', 'Charles Babbage']);
  });
});

describe('the bibliography', () => {
  const body = column(54, 100, [
    'Body text comes first and is long enough to be taken for body text.',
    'It goes on for a second line, and a third, so that the size of the',
    'body is not in doubt at all, and then it stops here.',
  ]);

  it('gives each numbered entry a paragraph of its own, however the lines ran', () => {
    // Entries run on from one to the next inside a line, and are cut at the
    // wrong places by the lines' indents — as a reflow of an IOP paper was.
    const refs = [
      ['[1] Dorrington A A, Carnegie D A and Cree M J 2006 Towards 1-mm depth', 54],
      ['precision Proc. SPIE 6068 60680K [2] Besl P J 1988 Active range', 64],
      ['imaging sensors Mach. Vis. Appl. 1 127-52 [3] Blais F 2004 Review', 54],
      ['of 20 years of range sensor development J. Electron. Imag-', 64],
      ['ing 13 231-40 [4] Marr D and Poggio T 1976 Cooperative computation', 54],
      ['of stereo disparity Science 194 282-7', 64],
    ];
    const runs = [
      ...body,
      line('References', 54, 150, { font: 'NimbusRomNo9L-Medi' }),
      ...refs.map(([text, x], index) => line(text, x, 164 + index * 9.5, { size: 8, width: 230 - (x - 54) })),
    ];
    const layout = layoutPages([page(runs)]);
    const at = texts(layout).indexOf('References');
    assert.deepEqual(texts(layout).slice(at + 1), [
      '[1] Dorrington A A, Carnegie D A and Cree M J 2006 Towards 1-mm depth precision Proc. SPIE 6068 60680K',
      '[2] Besl P J 1988 Active range imaging sensors Mach. Vis. Appl. 1 127-52',
      '[3] Blais F 2004 Review of 20 years of range sensor development J. Electron. Imaging 13 231-40',
      '[4] Marr D and Poggio T 1976 Cooperative computation of stereo disparity Science 194 282-7',
    ]);
  });

  it('keeps two lines of small type apart when a line of the column beside them sits between their baselines', () => {
    const left = Array.from({ length: 40 }, (_, i) =>
      line('Body text in the left column, set larger than the references are.', 57, 105.7 + i * 12, { size: 10, width: 240 }),
    );
    const runs = [
      ...left,
      line('References', 309, 490, { font: 'NimbusRomNo9L-Medi', size: 10 }),
      line('[8]', 309.3, 520.5, { size: 8.5, width: 9.9 }),
      line('Stann B, Giza M, Robinson D, Ruff W, Sarama S, Simon D', 326.3, 520.5, { size: 8.5, width: 213.7 }),
      line('and Sztankay Z 1999 A scannerless imaging ladar', 326.3, 531, { size: 8.5, width: 190 }),
      line('[9] Kawakita M et al 2004 High-definition real-time depth-mapping TV camera', 309.3, 541.5, { size: 8.5, width: 230 }),
    ];
    const layout = layoutPages([{ ...page(runs), width: 595, height: 842 }]);
    assert.ok(texts(layout).includes('[8] Stann B, Giza M, Robinson D, Ruff W, Sarama S, Simon D and Sztankay Z 1999 A scannerless imaging ladar'), texts(layout).join('\n'));
  });

  it('finds where entries start by counting up from the first', () => {
    assert.deepEqual(entryStarts('[1] A 2001 [3] cited [2] B 2002'), [0, 21]);
    assert.deepEqual(entryStarts('1. Smith J. One. Nature 12. 2001. 2. Jones K. Two.'), [0, 34]);
    assert.deepEqual(entryStarts('Smith J 2001 One [1]'), []);
  });

  it('leaves a list without numbers as it was', () => {
    const runs = [
      ...body,
      line('References', 54, 150, { font: 'NimbusRomNo9L-Medi' }),
      line('Smith J 2001 A first paper about things that goes on', 54, 164, { size: 8, width: 230 }),
      line('for a while Nature 1 1-2', 64, 173.5, { size: 8 }),
      line('Jones K 2002 A second paper Science 2 3-4', 54, 183, { size: 8 }),
    ];
    const layout = layoutPages([page(runs)]);
    const at = texts(layout).indexOf('References');
    assert.equal(texts(layout).length - at - 1, 2);
  });
});

describe('figures, tables and equations', () => {
  const body = (x, top) =>
    column(x, top, ['A paragraph of running text above the figure, a full line wide.', 'And a second full line of running text, so the body is measured.', 'Then a short last line.']);

  it('gives a figure caption the drawing above it, and takes its labels out of the text', () => {
    const runs = [
      ...body(54, 100),
      line('x axis', 150, 210, { size: 7 }),
      line('Figure 1. The plot, with a caption below it that runs on for', 54, 230, { font: 'NimbusRomNo9L-Medi', width: 240 }),
      line('a second line.', 54, 240.8, { font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 260, ['The text goes on under the caption with another full body line.', 'And one more.']),
    ];
    const graphics = [{ x0: 60, y0: 140, x1: 280, y1: 205, kind: 'path' }];
    const layout = layoutPages([page(runs, graphics)]);
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.ok(figure, 'a figure block');
    assert.equal(plain(figure.caption), 'Figure 1. The plot, with a caption below it that runs on for a second line.');
    assert.ok(figure.crop.y0 <= 140 && figure.crop.y1 >= 211, `the crop covers the drawing and its label: ${JSON.stringify(figure.crop)}`);
    assert.ok(!texts(layout).some((text) => text.includes('x axis')), 'the axis label is in the picture, not the text');
    const html = renderHtml(layout, (crop) => `crop-${crop.id}.png`);
    assert.match(html, /<figure class="pdf-figure"><img class="pdf-crop" src="crop-0.png"[^>]*><figcaption>Figure 1\./);
  });

  it('reads a ruled table under its caption into rows and cells', () => {
    const runs = [
      ...body(54, 100),
      line('Table 1: Error at three resolutions.', 54, 150, { font: 'NimbusRomNo9L-Medi' }),
      line('Method', 60, 166, { size: 8 }),
      line('s = 85', 120, 166, { size: 8 }),
      line('s = 141', 180, 166, { size: 8 }),
      line('FNO', 60, 178, { size: 8 }),
      line('0.0108', 120, 178, { size: 8 }),
      line('0.0109', 180, 178, { size: 8 }),
      line('UNet', 60, 190, { size: 8 }),
      line('0.0212', 120, 190, { size: 8 }),
      line('0.0338', 180, 190, { size: 8 }),
      ...column(54, 220, ['The text goes on under the table with another full body line here.', 'And one more.']),
    ];
    const graphics = [
      { x0: 56, y0: 157, x1: 240, y1: 157.5, kind: 'path' },
      { x0: 56, y0: 170, x1: 240, y1: 170.5, kind: 'path' },
      { x0: 56, y0: 194, x1: 240, y1: 194.5, kind: 'path' },
    ];
    const layout = layoutPages([page(runs, graphics)]);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.ok(table, 'a table block');
    assert.deepEqual(
      table.rows.map((row) => row.map((cell) => plain(cell.spans))),
      [
        ['Method', 's = 85', 's = 141'],
        ['FNO', '0.0108', '0.0109'],
        ['UNet', '0.0212', '0.0338'],
      ],
    );
    assert.match(renderHtml(layout, () => null), /<table><tr><th>Method<\/th><th>s = 85<\/th>/);
  });

  it('paints a numbered display equation rather than reading it', () => {
    const runs = [
      ...body(54, 100),
      line('(Kv)(x) = F', 120, 150, { font: 'CMMI9' }),
      line('−1', 175, 146, { size: 6, font: 'CMSY6' }),
      line('(R · Fv)(x)', 185, 150, { font: 'CMMI9' }),
      line('(1)', 280, 150, { font: 'CMR9' }),
      ...column(54, 170, ['where R is the learned weight, and the text carries on as before.', 'And one more line.']),
    ];
    const layout = layoutPages([page(runs)]);
    const equation = layout.blocks.find((block) => block.kind === 'equation');
    assert.ok(equation, 'an equation block');
    assert.equal(equation.label, 'Equation (1)');
    assert.ok(!texts(layout).some((text) => text.includes('Kv')), 'the formula is in the picture, not the text');
    // In its place in the flow: after the text above it, before "where".
    const kinds = layout.blocks.map((block) => block.kind);
    assert.deepEqual(kinds, ['paragraph', 'equation', 'paragraph']);
  });
});

describe('tables from cells', () => {
  it('gives a cell that spans two columns a colspan', () => {
    const cell = (text, x0, x1, baseline) => ({
      text,
      x0,
      x1,
      baseline,
      size: 8,
      top: baseline - 6.4,
      bottom: baseline + 1.8,
      page: 0,
      runs: [{ str: text, x: x0, y: baseline, width: x1 - x0, size: 8, font: '', bold: false, italic: false, mono: false, math: false }],
      allBold: false,
      allItalic: false,
      mathShare: 0,
      monoShare: 0,
    });
    const rows = tableFromLines([
      cell('Resolution', 120, 200, 100),
      cell('Method', 60, 90, 112),
      cell('85', 120, 135, 112),
      cell('141', 165, 185, 112),
      cell('FNO', 60, 80, 124),
      cell('0.01', 120, 140, 124),
      cell('0.02', 165, 185, 124),
    ]);
    assert.deepEqual(
      rows.map((row) => row.map((c) => [plain(c.spans), c.colspan])),
      [
        [['', undefined], ['Resolution', 2]],
        [['Method', undefined], ['85', undefined], ['141', undefined]],
        [['FNO', undefined], ['0.01', undefined], ['0.02', undefined]],
      ],
    );
  });
});

describe('text that is not text', () => {
  it('is flagged when the fonts carried no letters', () => {
    const runs = column(54, 100, Array.from({ length: 30 }, () => '!"# $!"# %!"# &!"# \'!"# (!"# )!"# *!"# +!"# ,!"# $!!"# -!"#'));
    assert.equal(layoutPages([page(runs)]).readable, false);
  });

  it('is flagged when the spaces were lost', () => {
    const runs = column(54, 100, Array.from({ length: 30 }, () => 'OverviewoftheTechnologyAcceptanceModelOriginsDevelopmentsandFutureDirections'));
    assert.equal(layoutPages([page(runs)]).readable, false);
  });

  it('and ordinary prose is not', () => {
    const runs = column(54, 100, Array.from({ length: 30 }, () => 'Ordinary prose, with words of a sane length and punctuation, reads as text.'));
    assert.equal(layoutPages([page(runs)]).readable, true);
  });
});

describe('glyphs', () => {
  it('puts TeX accents back on their letters', () => {
    assert.equal(composeAccents('na¨ıve'), 'naïve');
    assert.equal(composeAccents('Schr¨odinger and Poincar´e'), 'Schrödinger and Poincaré');
    assert.equal(composeAccents('plain'), 'plain');
  });

  it('tells a face from a font name', () => {
    assert.deepEqual(faceOf('TACTGM+NimbusRomNo9L-Medi'), { bold: true, italic: false, mono: false, math: false });
    assert.deepEqual(faceOf('FCXRUF+NimbusRomNo9L-ReguItal'), { bold: false, italic: true, mono: false, math: false });
    assert.deepEqual(faceOf('RRLDLB+CMTT9'), { bold: false, italic: false, mono: true, math: false });
    assert.deepEqual(faceOf('AZLOMJ+CMMI9'), { bold: false, italic: true, mono: false, math: true });
    assert.equal(faceOf('LiberationSerif-Bold').bold, true);
  });
});
