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

const { layoutPages, renderHtml, readingOrder, tableFromLines, composeAccents, faceOf, plain, entryStarts, linkRuns, linkAddresses, emailsIn, addressOf, tableGrid } = await load('src/lib/pdfLayout.ts');

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

  it('carries a paragraph on over a page after a colon, where it goes on in lower case', () => {
    const first = page(column(54, 100, ['Not every workbook recalculates faster once compiled, least of all one', 'already tuned by hand. The ledger is one, as the timings show:']), [], 0);
    const second = page(column(54, 100, ['against a sheet its author had already vectorized, the compiler only', 'matches it.']), [], 1);
    assert.deepEqual(texts(layoutPages([first, second])), [
      'Not every workbook recalculates faster once compiled, least of all one already tuned by hand. The ledger is one, as the timings show: against a sheet its author had already vectorized, the compiler only matches it.',
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
    assert.match(renderHtml(layout, () => null), /<table><tr><th class="short">Method<\/th><th class="short">s = 85<\/th>/);
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

describe('two columns, side by side', () => {
  // An abstract in 9pt bold down the left column, the body in 10pt, and a
  // figure at the head of the right column beside the abstract: the figure's
  // region once widened over the title to the whole page, and took the
  // abstract's first dozen lines with it.
  const abstract = [
    'Abstract—Latent models are trained to predict transitions, whereas',
    'a planner compares alternative actions from the same state, so a',
    'model can predict well and still rank actions poorly. We add two',
    'objectives that keep actions recoverable from its predictions and',
    'drop their heads at test time, leaving the planner unchanged.',
  ];
  const runs = () => [
    line('A Title Set Large Across the Whole Page', 150, 60, { size: 17, font: 'NimbusRomNo9L-Medi', width: 320 }),
    line('Ada Lindqvist, Tomas Okafor', 240, 90, { size: 11, width: 140 }),
    ...abstract.map((text, index) => line(text, 54, 130 + index * 10, { size: 9, font: 'NimbusRomNo9L-Medi', width: 240 })),
    line('Fig. 1: A teaser, beside the abstract, with its caption under it.', 318, 190, { size: 8, width: 240 }),
    ...column(318, 210, ['The introduction goes on under the figure with a full body line.', 'And a second full line of running text so the body is measured.', 'Then a short one.'], { size: 10 }),
    ...column(54, 200, ['The left column goes on under the abstract with a full body line.', 'And a second full line of running text so the body is measured.', 'A third full line of running text to settle the column width.', 'Then a short one.'], { size: 10 }),
  ];
  const graphics = [{ x0: 330, y0: 110, x1: 540, y1: 180, kind: 'image' }];

  it('keeps every line of an abstract beside a figure', () => {
    const layout = layoutPages([page(runs(), graphics)]);
    const text = texts(layout).join(' | ');
    for (const sentence of abstract) assert.ok(text.includes(sentence.replace(/—/, '—').slice(0, 30)), `"${sentence}" is in the text: ${text}`);
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.ok(figure && figure.crop.x0 >= 300, `the figure stays in its column: ${JSON.stringify(figure?.crop)}`);
  });
});

describe('IEEE conference papers', () => {
  const smallCaps = (numeral, first, rest, x, y) => [
    line(`${numeral} ${first}`, x, y, { size: 10, width: (numeral.length + 2) * 5 }),
    { ...line(rest, x + (numeral.length + 2) * 5, y, { size: 8 }) },
  ];

  it('reads "I. INTRODUCTION" in small capitals, and "A. Name" in italics, as headings', () => {
    const runs = [
      ...smallCaps('I.', 'I', 'NTRODUCTION', 130, 100),
      ...column(54, 116, ['World models learn to predict how an environment evolves under its actions.', 'A second full line of the introduction, so that the body is measured.', 'And a short one.'], { size: 10 }),
      line('A. Residual latent dynamics', 54, 160, { size: 10, font: 'NimbusRomNo9L-ReguItal' }),
      ...column(54, 174, ['The predictor outputs an increment that is added to the current latent.', 'A second full line of the subsection, so that the body is measured.', 'And a short one.'], { size: 10 }),
    ];
    const layout = layoutPages([page(runs)]);
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map((block) => [block.level, plain(block.spans)]);
    assert.deepEqual(headings, [[2, 'I. INTRODUCTION'], [3, 'A. Residual latent dynamics']]);
  });

  it('takes "TABLE IV:" for a caption, and its second line for the caption, not a row', () => {
    const runs = [
      ...column(54, 100, ['A paragraph of running text above the table, a full line wide here.', 'And a second full line of running text, so the body is measured.', 'Then a short last line.'], { size: 10 }),
      line('TABLE IV: Zero-shot results (count/total). Abnormal motion counts', 54, 150, { size: 8, width: 240 }),
      line('adverse events. Bold marks better results.', 54, 159, { size: 8 }),
      line('Protocol', 60, 175, { size: 8 }),
      line('Baseline', 150, 175, { size: 8 }),
      line('Ours', 220, 175, { size: 8, font: 'NimbusRomNo9L-Medi' }),
      line('Basic', 60, 187, { size: 8 }),
      line('19/45', 150, 187, { size: 8 }),
      line('32/45', 220, 187, { size: 8, font: 'NimbusRomNo9L-Medi' }),
      line('Complex', 60, 199, { size: 8 }),
      line('2/10', 150, 199, { size: 8 }),
      line('5/10', 220, 199, { size: 8, font: 'NimbusRomNo9L-Medi' }),
      ...column(54, 230, ['The text goes on under the table with another full body line here.', 'And one more.'], { size: 10 }),
    ];
    const layout = layoutPages([page(runs)]);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.ok(table, 'a table block');
    assert.equal(table.label, 'TABLE IV');
    assert.equal(plain(table.caption), 'TABLE IV: Zero-shot results (count/total). Abnormal motion counts adverse events. Bold marks better results.');
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plain(cell.spans))), [
      ['Protocol', 'Baseline', 'Ours'],
      ['Basic', '19/45', '32/45'],
      ['Complex', '2/10', '5/10'],
    ]);
    assert.match(renderHtml(layout, () => null), /<td class="num"><strong>32\/45<\/strong><\/td>/);
  });

  it('keeps the byline\'s affiliations and notes, and the names only where their marks point there', () => {
    const runs = [
      line('A Paper With Notes Under Its Byline', 150, 60, { size: 17, font: 'NimbusRomNo9L-Medi', width: 300 }),
      line('Ada Lindqvist', 200, 90, { size: 11 }),
      line('1∗', 272, 86, { size: 7 }),
      line(', Omar Haddad', 279, 90, { size: 11 }),
      line('1†', 350.5, 86, { size: 7 }),
      line('1', 220, 101, { size: 7 }),
      line('Northfield University, Canada', 223.5, 104, { size: 11 }),
      line('∗Equal contribution. †Corresponding author.', 200, 118, { size: 11 }),
      line('Abstract—We study a thing, and the abstract goes on at some length.', 54, 150, { size: 9, font: 'NimbusRomNo9L-Medi', width: 240 }),
      ...column(54, 170, ['The introduction goes on under the abstract with a full body line.', 'A second full line of running text, so that the body is measured.', 'And a third.'], { size: 10 }),
    ];
    const layout = layoutPages([page(runs)], { title: 'A Paper With Notes Under Its Byline' });
    assert.deepEqual(layout.byline, {
      authors: [
        { name: 'Ada Lindqvist', marks: ['1', '∗'], affiliations: ['Northfield University, Canada'], notes: ['Equal contribution'], emails: [] },
        { name: 'Omar Haddad', marks: ['1', '†'], affiliations: ['Northfield University, Canada'], notes: ['Corresponding author'], emails: [] },
      ],
      notes: [
        { mark: '∗', text: 'Equal contribution' },
        { mark: '†', text: 'Corresponding author' },
      ],
      affiliations: [{ mark: '1', text: 'Northfield University, Canada' }],
      emails: [],
    });
    assert.match(texts(layout)[0], /^Abstract—We study a thing/);
  });

  it('gives an institution named once, with no mark, to every author, and keeps what it cannot read', () => {
    const runs = [
      line('A Paper With One Institution', 150, 60, { size: 17, font: 'NimbusRomNo9L-Medi', width: 300 }),
      line('Jiabin Qiu', 200, 90, { size: 11 }),
      line('∗', 255, 86, { size: 7 }),
      line(', Jing Huo', 258.5, 90, { size: 11 }),
      line('†', 313.5, 86, { size: 7 }),
      line('Nanjing University', 230, 104, { size: 11 }),
      line('∗', 200, 114, { size: 7 }),
      line('Equal contribution.', 204, 118, { size: 11 }),
      line('†', 310, 114, { size: 7 }),
      line('Corresponding authors.', 314, 118, { size: 11 }),
      line('Preprint, September 2026', 220, 132, { size: 11 }),
      line('Abstract—We study a thing, and the abstract goes on at some length.', 54, 160, { size: 9, font: 'NimbusRomNo9L-Medi', width: 240 }),
      ...column(54, 180, ['The introduction goes on under the abstract with a full body line.', 'A second full line of running text, so that the body is measured.', 'And a third.'], { size: 10 }),
    ];
    const layout = layoutPages([page(runs)], { title: 'A Paper With One Institution' });
    assert.deepEqual(
      layout.byline.authors.map((author) => [author.name, author.affiliations, author.notes]),
      [
        ['Jiabin Qiu', ['Nanjing University'], ['Equal contribution']],
        ['Jing Huo', ['Nanjing University'], ['Corresponding authors']],
      ],
    );
    assert.deepEqual(layout.front.map(plain), ['Preprint, September 2026']);
  });

  it('leaves a subscript on its own line, not on the other column\'s line whose baseline falls nearer', () => {
    const runs = [
      line('The left column carries a line at a baseline between two rows here.', 54, 104.5, { size: 9, width: 240 }),
      line('C. MI weight (λ', 330, 100, { size: 8 }),
      line('inv', 385, 101.5, { size: 6 }),
      line('= 0.1)', 397, 100, { size: 8 }),
      line('0', 330, 109, { size: 8 }),
      line('.005', 360, 109, { size: 8 }),
    ];
    const layout = layoutPages([page(runs)]);
    const text = texts(layout).join(' | ');
    assert.match(text, /C\. MI weight \(λinv = 0\.1\)/);
    assert.doesNotMatch(text, /0inv/);
  });
});

describe('what a real IEEE paper threw up', () => {
  const body = (x, top) => column(x, top, ['A paragraph of running text above the table, a full line wide here.', 'And a second full line of running text, so the body is measured.', 'Then a short last line.'], { size: 10 });

  it('cuts a table set tight into its cells, a subscript kept with its letter', () => {
    const runs = [
      ...body(54, 100),
      line('TABLE IV: Results.', 54, 150, { size: 8 }),
      line('Protocol', 60, 166, { size: 8, width: 30 }),
      line('Metric', 96, 166, { size: 8, width: 22 }),
      line('R', 150, 166, { size: 8, width: 5, font: 'CMMI8' }),
      line('30', 155.2, 167.2, { size: 6, width: 6, font: 'CMR6' }),
      line('Ours', 180, 166, { size: 8, width: 16 }),
      line('Complex', 60, 178, { size: 8, width: 29 }),
      line('Success', 96, 178, { size: 8, width: 27 }),
      line('2/10', 150, 178, { size: 8, width: 14 }),
      line('5/10', 180, 178, { size: 8, width: 14 }),
      ...column(54, 210, ['The text goes on under the table with another full body line here.', 'And one more.'], { size: 10 }),
    ];
    const table = layoutPages([page(runs)]).blocks.find((block) => block.kind === 'table');
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plain(cell.spans))), [
      ['Protocol', 'Metric', 'R30', 'Ours'],
      ['Complex', 'Success', '2/10', '5/10'],
    ]);
  });

  it('keeps a norm\'s superscript and subscript, set one over the other, on their line', () => {
    const runs = column(54, 100, ['The terminal cost is the squared distance to the goal, taken as', 'A second full line of running text, so that the body is measured.', 'And a short one.']);
    runs.push(line('∥z − g∥', 54, 130, { width: 30, font: 'CMSY9' }), line('2', 84, 126.5, { size: 6, width: 3, font: 'CMR6' }), line('2', 84, 132, { size: 6, width: 3, font: 'CMR6' }), line(', which it replans with.', 88, 130, { width: 90 }));
    const text = texts(layoutPages([page(runs)])).join(' | ');
    assert.match(text, /∥z − g∥22 ?, which it replans with\./);
    assert.doesNotMatch(text, /\| 2/);
  });

  it('ends a table where a figure\'s pictures begin under it', () => {
    const runs = [
      ...body(54, 100),
      line('TABLE I: Results.', 54, 150, { size: 8 }),
      line('Method', 60, 166, { size: 8 }),
      line('Score', 150, 166, { size: 8 }),
      line('Ours', 60, 178, { size: 8 }),
      line('0.9', 150, 178, { size: 8 }),
      line('Setup', 70, 200, { size: 7 }),
      line('Camera', 150, 230, { size: 7 }),
      line('Fig. 5: The robot.', 54, 260, { size: 8 }),
      ...column(54, 280, ['The text goes on under the figure with another full body line here.', 'And one more.'], { size: 10 }),
    ];
    const layout = layoutPages([page(runs, [{ x0: 60, y0: 195, x1: 280, y1: 250, kind: 'image' }])]);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plain(cell.spans))), [['Method', 'Score'], ['Ours', '0.9']]);
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.ok(figure && figure.crop.y0 > 185, `the figure starts under the table: ${JSON.stringify(figure?.crop)}`);
  });

  it('does not measure a table beside a full-width caption by that caption', () => {
    const wide = { size: 10, width: 504 };
    const runs = [
      line('TABLE I: A table across the page, whose caption runs on for a second', 54, 60, wide),
      line('line as wide as the page, set in the size of the text.', 54, 72, { size: 10, width: 230 }),
      line('Method', 60, 88, { size: 8 }),
      line('Score', 400, 88, { size: 8 }),
      line('Ours', 60, 100, { size: 8 }),
      line('0.9', 400, 100, { size: 8 }),
      ...column(54, 130, ['The left column reads on under the table with a full line of it.', 'A second full line of running text, so that the body is measured.', 'for Spearman rank correlation.'], { size: 10 }),
      line('TABLE II: Ablations.', 318, 130, { size: 10, width: 240 }),
      line('Variant', 324, 146, { size: 8 }),
      line('HS', 500, 146, { size: 8 }),
      line('LeWM', 324, 158, { size: 8 }),
      line('3.7', 500, 158, { size: 8 }),
      ...column(318, 190, ['The right column goes on under the second table with a full line.', 'And one more line.'], { size: 10 }),
    ];
    const tables = layoutPages([page(runs)]).blocks.filter((block) => block.kind === 'table');
    assert.deepEqual(tables[1].rows.map((row) => row.map((cell) => plain(cell.spans))), [['Variant', 'HS'], ['LeWM', '3.7']]);
  });
});

describe('tables whose cells span', () => {
  const body = (x, top) => column(x, top, ['A paragraph of running text above the table, a full line wide here.', 'And a second full line of running text, so the body is measured.', 'Then a short last line.'], { size: 10 });
  const grid = (layout) => tableGrid(layout.blocks.find((block) => block.kind === 'table').rows);

  it('spreads a heading over the columns the rule under it spans', () => {
    const runs = [
      ...body(54, 100),
      line('TABLE III: Metrics.', 54, 150, { size: 8 }),
      line('Variant', 60, 166, { size: 8, width: 26 }),
      line('Candidate selection', 150, 166, { size: 8, width: 70 }),
      line('CAD', 110, 180, { size: 8, width: 16 }),
      line('R30', 160, 180, { size: 8, width: 14 }),
      line('R̄30', 210, 180, { size: 8, width: 14 }),
      line('LeWM', 60, 194, { size: 8, width: 20 }),
      line('0.460', 108, 194, { size: 8, width: 20 }),
      line('0.074', 158, 194, { size: 8, width: 20 }),
      line('0.298', 208, 194, { size: 8, width: 20 }),
      ...column(54, 230, ['The text goes on under the table with another full body line here.', 'And one more.'], { size: 10 }),
    ];
    // Booktabs's \cmidrule under "Candidate selection", from CAD to R̄30.
    const graphics = [{ x0: 106, y0: 169, x1: 232, y1: 169.4, kind: 'path' }];
    const layout = layoutPages([page(runs, graphics)]);
    assert.deepEqual(grid(layout), [
      ['Variant', 'Candidate selection', '', ''],
      ['', 'CAD', 'R30', 'R̄30'],
      ['LeWM', '0.460', '0.074', '0.298'],
    ]);
  });

  it('spreads a heading centred over blank columns over them, where no rule is drawn', () => {
    const runs = [
      ...body(54, 100),
      line('TABLE III: Metrics.', 54, 150, { size: 8 }),
      line('Variant', 60, 166, { size: 8, width: 26 }),
      line('Candidate selection', 134, 166, { size: 8, width: 70 }),
      line('CAD', 110, 180, { size: 8, width: 16 }),
      line('R30', 160, 180, { size: 8, width: 14 }),
      line('R̄30', 210, 180, { size: 8, width: 14 }),
      line('LeWM', 60, 194, { size: 8, width: 20 }),
      line('0.460', 108, 194, { size: 8, width: 20 }),
      line('0.074', 158, 194, { size: 8, width: 20 }),
      line('0.298', 208, 194, { size: 8, width: 20 }),
      ...column(54, 230, ['The text goes on under the table with another full body line here.', 'And one more.'], { size: 10 }),
    ];
    const table = layoutPages([page(runs)]).blocks.find((block) => block.kind === 'table');
    assert.equal(table.rows[0][1].colspan, 3);
  });

  it('gives a group\'s label all its rows, as far as the rule under the group', () => {
    const runs = [
      ...body(54, 100),
      line('TABLE IV: Results.', 54, 150, { size: 8 }),
      line('Protocol', 60, 166, { size: 8, width: 30 }),
      line('Metric', 110, 166, { size: 8, width: 22 }),
      line('Ours', 190, 166, { size: 8, width: 16 }),
      line('Complex', 60, 180, { size: 8, width: 29 }),
      line('Success', 110, 180, { size: 8, width: 27 }),
      line('5/10', 190, 180, { size: 8, width: 14 }),
      line('Abnormal motion', 110, 190, { size: 8, width: 58 }),
      line('2/10', 190, 190, { size: 8, width: 14 }),
      line('Target', 60, 204, { size: 8, width: 22 }),
      line('Moved', 110, 204, { size: 8, width: 22 }),
      line('21/27', 190, 204, { size: 8, width: 18 }),
      ...column(54, 240, ['The text goes on under the table with another full body line here.', 'And one more.'], { size: 10 }),
    ];
    const graphics = [
      { x0: 58, y0: 170, x1: 210, y1: 170.4, kind: 'path' },
      { x0: 58, y0: 194, x1: 210, y1: 194.4, kind: 'path' },
    ];
    const table = layoutPages([page(runs, graphics)]).blocks.find((block) => block.kind === 'table');
    assert.deepEqual(table.rows.map((row) => row.map((cell) => plain(cell.spans) + (cell.rowspan ? `×${cell.rowspan}` : ''))), [
      ['Protocol', 'Metric', 'Ours'],
      ['Complex×2', 'Success', '5/10'],
      ['Abnormal motion', '2/10'],
      ['Target', 'Moved', '21/27'],
    ]);
    assert.deepEqual(tableGrid(table.rows)[2], ['', 'Abnormal motion', '2/10']);
  });

  it('puts an accent drawn back over its letter on it', () => {
    const runs = [...column(54, 100, ['Elite-mean regret is the second measure we report for every model.', 'A second full line of running text, so that the body is measured.', 'And a short one.'])];
    runs.push(line('R', 54, 140, { width: 6, font: 'CMMI9' }), line('¯', 55.5, 138, { width: 4, font: 'CMR9' }), line('is its bar.', 64, 140, { width: 40 }));
    assert.match(texts(layoutPages([page(runs)])).join(' '), /R̄ is its bar\./);
  });
});

describe('addresses in the byline', () => {
  it('spells out a group of addresses written once for their domain', () => {
    assert.deepEqual(emailsIn('{jqiu, zchen}@nju.edu.cn and gaoy@nju.edu.cn.'), ['jqiu@nju.edu.cn', 'zchen@nju.edu.cn', 'gaoy@nju.edu.cn']);
  });

  it('knows an address by the name in it, and not by a namesake\'s', () => {
    assert.ok(addressOf('Yang Gao', 'gaoy@nju.edu.cn'));
    assert.ok(addressOf('Yang Gao', 'yang.gao@nju.edu.cn'));
    assert.ok(addressOf('Jiabin Qiu', 'jqiu@nju.edu.cn'));
    assert.ok(addressOf('Jing Huo', 'huojing@nju.edu.cn'));
    assert.ok(!addressOf('Jing Huo', 'jiabin.qiu@nju.edu.cn'));
    assert.ok(!addressOf('Yang Gao', 'gaoxiang@nju.edu.cn'));
  });

  it('puts a line of addresses to its authors, and leaves it out of the text', () => {
    const runs = [
      line('A Paper With Addresses', 150, 60, { size: 17, font: 'NimbusRomNo9L-Medi', width: 300 }),
      line('Jiabin Qiu, Yang Gao', 230, 90, { size: 11 }),
      line('Nanjing University', 230, 104, { size: 11 }),
      line('{jqiu, gaoy}@nju.edu.cn', 225, 118, { size: 11 }),
      line('Abstract—We study a thing, and the abstract goes on at some length.', 54, 150, { size: 9, font: 'NimbusRomNo9L-Medi', width: 240 }),
      ...column(54, 170, ['The introduction goes on under the abstract with a full body line.', 'A second full line of running text, so that the body is measured.', 'And a third.'], { size: 10 }),
    ];
    const layout = layoutPages([page(runs)], { title: 'A Paper With Addresses' });
    assert.deepEqual(layout.byline.authors.map((author) => [author.name, author.emails]), [['Jiabin Qiu', ['jqiu@nju.edu.cn']], ['Yang Gao', ['gaoy@nju.edu.cn']]]);
    assert.equal(layout.front, undefined);
  });
});

describe('links', () => {
  it('cuts a run where a link on the page starts and ends, by whole words', () => {
    const run = line('code is at https://ad-wm.github.io/. More soon', 54, 100, { width: 230 });
    const per = 230 / run.str.length;
    const from = run.str.indexOf('https');
    const to = from + 'https://ad-wm.github.io/'.length;
    const pieces = linkRuns([run], [{ x0: 54 + from * per + 3, y0: 92, x1: 54 + to * per - 2, y1: 102, url: 'https://ad-wm.github.io/' }]);
    const linked = pieces.filter((piece) => piece.href);
    assert.deepEqual(linked.map((piece) => piece.str), ['https://ad-wm.github.io/']);
    // Nothing lost or doubled on either side of it.
    assert.equal(pieces.slice().sort((a, b) => a.x - b.x).map((piece) => piece.str).join(''), run.str);
  });

  it('keeps a stop that is the address\'s own, where it breaks across two lines', () => {
    const run = line('Code is at https://example.', 54, 100, { width: 130 });
    const pieces = linkRuns([run], [{ x0: 54 + 11 * (130 / run.str.length), y0: 92, x1: 184, y1: 102, url: 'https://example.org/sparse' }]);
    assert.deepEqual(pieces.filter((piece) => piece.href).map((piece) => piece.str), ['https://example.']);
  });

  it('makes addresses written out in the text links', () => {
    const spans = linkAddresses([{ text: 'See https://example.org/a_b. Mail me at ada@example.org, or www.example.com.' }]);
    assert.deepEqual(
      spans.filter((span) => span.href).map((span) => [span.text, span.href]),
      [
        ['https://example.org/a_b', 'https://example.org/a_b'],
        ['ada@example.org', 'mailto:ada@example.org'],
        ['www.example.com', 'https://www.example.com'],
      ],
    );
    assert.equal(plain(spans), 'See https://example.org/a_b. Mail me at ada@example.org, or www.example.com.');
  });

  it('sets a linked span as a link that opens apart from the reader', () => {
    const layout = layoutPages([
      page(
        column(54, 100, ['Code and videos for the paper are at https://ad-wm.github.io/ for all.', 'A second full line of running text, so that the body is measured.', 'And a short one.']),
        [],
      ),
    ]);
    assert.match(renderHtml(layout, () => null), /<a href="https:\/\/ad-wm\.github\.io\/" target="_blank" rel="noreferrer noopener">https:\/\/ad-wm\.github\.io\/<\/a> for all/);
  });
});

describe('page furniture', () => {
  it('drops a page number set clear under the text, though above the bottom tenth of the page', () => {
    const runs = [...column(54, 100, ['A paragraph of running text on the page, a full line wide here.', 'And a second full line of running text, so the body is measured.', 'Then a short last line.']), line('7', 300, 699)];
    const layout = layoutPages([page(runs)]);
    assert.ok(!texts(layout).includes('7'), texts(layout).join(' | '));
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

// What an ACL paper set with dvips taught the reflow (RoBERTa, arXiv
// 1907.11692): justified lines in footnotes and indented first lines cut
// at their wide spaces, a year taken for an equation's number, headings
// broken over two lines, a footnote carried from one column to the next,
// small capitals broken at a line's end, a byline whose marks lead the
// institutions, a line of text that starts "Table 7.", a heading set
// level with the gap between the two rows of a table's heading, and a
// sentence closed before its footnote's mark.
describe('a paper set with dvips', () => {
  const foot = (str, x, y, options = {}) => line(str, x, y, { size: 7, ...options });
  const body = (x, top, count = 3) => column(x, top, Array.from({ length: count }, (_, index) => (index === count - 1 ? 'The end of it.' : 'Body text of the column runs on for a while here and then')));

  it('mends a footnote line cut at its wide spaces, and a paragraph\'s indented first line', () => {
    const runs = [
      ...body(54, 100),
      line('Devlin et al.', 66, 140, { width: 54 }),
      line('(2019)', 137, 140, { width: 27 }),
      line('originally', 181, 140, { width: 40 }),
      line('trained', 238, 140, { width: 56 }),
      line('BERT for 1M steps with a batch size of 256 sequences.', 54, 150.8, { width: 200 }),
      // The footnotes, in small type at the foot of the page.
      line('6', 54, 697, { size: 5, width: 3 }),
      foot('The datasets are: CoLA (Warstadt et al., 2018), Question NLI', 57, 700, { width: 237 }),
      foot('(QNLI) (Rajpurkar et al., 2016),', 54, 708.4, { width: 130 }),
      foot('Recognizing Textual', 192.5, 708.4, { width: 101.5 }),
      foot('Entailment (RTE) and Winograd NLI (WNLI).', 54, 716.8),
    ];
    const layout = layoutPages([page(runs)]);
    assert.ok(!layout.blocks.some((block) => block.kind === 'equation'));
    assert.ok(texts(layout).includes('Devlin et al. (2019) originally trained BERT for 1M steps with a batch size of 256 sequences.'), texts(layout).join('\n'));
    const notes = layout.blocks.filter((block) => block.kind === 'footnote').map((block) => plain(block.spans));
    assert.deepEqual(notes, ['6The datasets are: CoLA (Warstadt et al., 2018), Question NLI (QNLI) (Rajpurkar et al., 2016), Recognizing Textual Entailment (RTE) and Winograd NLI (WNLI).']);
  });

  it('does not take a year cut from its citation for an equation\'s number', () => {
    const runs = [
      ...body(54, 100),
      line('Devlin et al.', 54, 140, { width: 54 }),
      line('(2019)', 124, 140, { width: 27 }),
      line('trained', 161, 140, { width: 30 }),
      line('BERT for 1M steps with a batch size of 256 sequences.', 54, 150.8, { width: 200 }),
    ];
    const layout = layoutPages([page(runs)]);
    assert.ok(!layout.blocks.some((block) => block.kind === 'equation'), JSON.stringify(layout.blocks));
    assert.ok(texts(layout).some((text) => text.includes('(2019)')));
  });

  it('reads a bold heading broken over two lines as one, and two headings set apart as two', () => {
    const runs = [
      line('Appendix for “A Robustly Optimized', 54, 60, { size: 11, font: 'NimbusRomNo9L-Medi', width: 180 }),
      line('Pretraining Approach”', 54, 73, { size: 11, font: 'NimbusRomNo9L-Medi', width: 110 }),
      line('A Full results on GLUE', 54, 93, { size: 11, font: 'NimbusRomNo9L-Medi', width: 120 }),
      ...body(54, 110),
      line('4.2 Model Input Format and Next Sentence', 54, 150, { font: 'NimbusRomNo9L-Medi', width: 200 }),
      line('Prediction', 80, 161, { font: 'NimbusRomNo9L-Medi', width: 45 }),
      ...body(54, 176),
    ];
    const layout = layoutPages([page(runs)]);
    const headings = layout.blocks.filter((block) => block.kind === 'heading').map((block) => plain(block.spans));
    assert.deepEqual(headings, ['Appendix for “A Robustly Optimized Pretraining Approach”', 'A Full results on GLUE', '4.2 Model Input Format and Next Sentence Prediction']);
  });

  it('carries a footnote broken off at the foot of one column on at the foot of the next', () => {
    const runs = [
      ...body(54, 100, 4),
      ...body(314, 100, 4),
      line('10', 54, 697, { size: 5, width: 6 }),
      foot('While we only use the provided WNLI training data, our', 60.3, 700, { width: 233.7 }),
      foot('results could potentially be improved by augmenting this with', 314, 692, { width: 240 }),
      foot('additional pronoun disambiguation datasets.', 314, 700.4),
    ];
    const layout = layoutPages([page(runs)]);
    const notes = layout.blocks.filter((block) => block.kind === 'footnote').map((block) => plain(block.spans));
    assert.deepEqual(notes, ['10While we only use the provided WNLI training data, our results could potentially be improved by augmenting this with additional pronoun disambiguation datasets.']);
  });

  it('mends a word in small capitals broken at the line\'s end, and a name the paper writes whole', () => {
    const runs = [
      ...column(54, 100, ['BERT is trained on a combination of BOOKCOR-', 'PUS (Zhu et al., 2015) plus English WIKIPEDIA, and XL-', 'Net (Yang et al., 2019) augments its data. The BOOKCORPUS', 'and XLNet are named whole here, and self-', 'attention stays hyphenated: self-attention it is.']),
    ];
    const text = texts(layoutPages([page(runs)]))[0];
    assert.ok(text.includes('of BOOKCORPUS (Zhu'), text);
    assert.ok(text.includes('and XLNet (Yang'), text);
    assert.ok(text.includes('and self-attention stays'), text);
  });

  it('reads an institution led by its mark as the mark\'s, not as a name, and one run over two lines whole', () => {
    const runs = [
      line('A Very Important Paper', 150, 80, { size: 17, font: 'NimbusRomNo9L-Medi', width: 300 }),
      line('Yinhan Liu', 120, 110, { size: 12, font: 'NimbusRomNo9L-Medi', width: 60 }),
      line('∗§', 180, 106, { size: 8, width: 8 }),
      line('Myle Ott', 210, 110, { size: 12, font: 'NimbusRomNo9L-Medi', width: 45 }),
      line('§', 255, 106, { size: 8, width: 4 }),
      line('Mandar Joshi', 290, 110, { size: 12, font: 'NimbusRomNo9L-Medi', width: 70 }),
      line('†', 360, 106, { size: 8, width: 4 }),
      line('†', 160, 142, { size: 8, width: 4 }),
      line('Paul G. Allen School of Computer Science & Engineering,', 166, 146, { size: 12, width: 280 }),
      line('University of Washington, Seattle, WA', 200, 160, { size: 12, width: 190 }),
      line('§', 270, 170, { size: 8, width: 4 }),
      line('Facebook AI', 276, 174, { size: 12, width: 60 }),
      line('Abstract', 54, 210, { size: 11, font: 'NimbusRomNo9L-Medi' }),
      ...body(54, 224),
      line('∗Equal contribution.', 54, 700, { size: 7, width: 60 }),
    ];
    const layout = layoutPages([page(runs)], { title: 'A Very Important Paper' });
    assert.deepEqual(layout.authors, ['Yinhan Liu', 'Myle Ott', 'Mandar Joshi']);
    assert.deepEqual(
      layout.byline.authors.map((author) => [author.name, author.affiliations.join('; '), author.notes.join('; ')]),
      [
        ['Yinhan Liu', 'Facebook AI', 'Equal contribution'],
        ['Myle Ott', 'Facebook AI', ''],
        ['Mandar Joshi', 'Paul G. Allen School of Computer Science & Engineering, University of Washington, Seattle, WA', ''],
      ],
    );
  });

  it('leaves a line of the text that begins "Table 7." in the text', () => {
    const runs = [
      ...column(54, 100, ['Results on the RACE test sets are presented in', 'Table 7. RoBERTa achieves state-of-the-art results', 'on both middle-school and high-school settings.']),
      ...body(54, 140),
    ];
    const layout = layoutPages([page(runs)]);
    assert.ok(!layout.blocks.some((block) => block.kind === 'table'));
    assert.ok(texts(layout)[0].includes('presented in Table 7. RoBERTa achieves'), texts(layout).join('\n'));
  });

  it('reads a heading set level with the gap between the two rows of a table\'s heading as the heading\'s, not a panel\'s title', () => {
    const bold = { font: 'NimbusRomNo9L-Medi' };
    const runs = [
      line('SQuAD 1.1', 150, 76, { ...bold, width: 50 }),
      line('SQuAD 2.0', 220, 76, { ...bold, width: 50 }),
      line('Model', 82, 83, { ...bold, width: 30 }),
      line('EM', 150, 90, { width: 15 }),
      line('F1', 185, 90, { width: 12 }),
      line('EM', 216, 90, { width: 15 }),
      line('F1', 258, 90, { width: 12 }),
      line('Single models on dev', 82, 108, { font: 'NimbusRomNo9L-ReguItal', width: 100 }),
      line('BERT', 82, 122, { width: 40 }),
      line('84.1', 148, 122, { width: 19 }),
      line('90.9', 181, 122, { width: 19 }),
      line('79.0', 215, 122, { width: 19 }),
      line('81.8', 254, 122, { width: 19 }),
      line('RoBERTa', 82, 136, { width: 44 }),
      line('88.9', 148, 136, { width: 19 }),
      line('94.6', 181, 136, { width: 19 }),
      line('86.5', 215, 136, { width: 19 }),
      line('89.4', 254, 136, { width: 19 }),
      line('Table 6: Results on SQuAD.', 54, 165, { size: 8, width: 110 }),
      ...body(54, 200),
    ];
    const graphics = [
      { x0: 76, y0: 63.5, x1: 286, y1: 64, kind: 'path' },
      { x0: 76, y0: 96, x1: 286, y1: 96.5, kind: 'path' },
      { x0: 76, y0: 143, x1: 286, y1: 143.5, kind: 'path' },
    ];
    const layout = layoutPages([page(runs, graphics)]);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.ok(table?.rows, JSON.stringify(layout.blocks));
    const cells = table.rows.map((row) => row.map((cell) => plain(cell.spans)));
    assert.deepEqual(cells[0], ['', 'SQuAD 1.1', 'SQuAD 2.0']);
    assert.deepEqual(table.rows[0].slice(1).map((cell) => cell.colspan), [2, 2]);
    assert.deepEqual(cells[1], ['Model', 'EM', 'F1', 'EM', 'F1']);
    assert.ok(table.rows.slice(0, 2).flat().every((cell) => !plain(cell.spans) || cell.head));
    assert.ok(!table.rows.some((row) => row.some((cell) => cell.panel)));
    assert.deepEqual(cells[2][0], 'Single models on dev');
    assert.deepEqual(cells[3], ['BERT', '84.1', '90.9', '79.0', '81.8']);
  });

  it('does not run a paragraph on after a sentence closed before its footnote\'s mark', () => {
    const runs = [
      ...column(54, 100, ['One unfortunate consequence of this formulation is that we', 'can only make use of the positive training examples, which', 'excludes over half of the provided training examples.']),
      line('10', 262, 118.1, { size: 5, width: 6 }),
      line('Results', 314, 100, { font: 'NimbusRomNo9L-Medi', width: 32 }),
      line('We present our results in Table 5. In the first', 350, 100, { width: 204 }),
      line('setting, RoBERTa achieves state-of-the-art results.', 314, 110.8, { width: 200 }),
    ];
    const layout = layoutPages([page(runs)]);
    assert.deepEqual(texts(layout), [
      'One unfortunate consequence of this formulation is that we can only make use of the positive training examples, which excludes over half of the provided training examples.10',
      'Results We present our results in Table 5. In the first setting, RoBERTa achieves state-of-the-art results.',
    ]);
  });

  it('keeps the hyphen of a word the paper writes hyphenated when its halves are parted by a column break, with no space', () => {
    const runs = [
      ...column(54, 100, ['The end-task performance of the model is measured on', 'each benchmark, and we compare perplexity and end-']),
      ...column(314, 100, ['task performance as we increase the batch size, which', 'is the end of it.']),
    ];
    const text = texts(layoutPages([page(runs)]))[0];
    assert.ok(text.includes('perplexity and end-task performance as'), text);
  });

  it('reads Computer Modern\'s epsilon as one', () => {
    const runs = [
      ...body(54, 100),
      line('Adam with', 54, 140, { width: 40 }),
      line('ǫ', 96, 140, { font: 'KDQHQT+CMMI10', width: 5 }),
      line('= 1e-6 and a weight decay of 0.01 for the whole run.', 103, 140, { width: 191 }),
    ];
    assert.ok(texts(layoutPages([page(runs)])).some((text) => text.includes('Adam with ϵ = 1e-6')));
  });
});

// What an ACM journal paper set with acmart taught the reflow (Hou et al.,
// TOSEM 2026): Linux Libertine and Biolinum name their faces by a letter
// after an "O", the byline sets each line's names in capitals before their
// institution, itemize's dashes stand against their items, a bold line at
// the head of a page is never the paragraph before carried on, a table
// whose groups are parted by rules has a label set on two lines, and its
// rows each carry a figure in a column of figures.
describe('a paper set with acmart', () => {
  const body = (x, top, count = 3) => column(x, top, Array.from({ length: count }, (_, index) => (index === count - 1 ? 'The end of it.' : 'Body text of the column runs on for a while here and then')), { width: 240 });

  it('reads Libertine and Biolinum faces by their letters', () => {
    assert.deepEqual(faceOf('JQQBID+LinBiolinumOB'), { bold: true, italic: false, mono: false, math: false });
    assert.deepEqual(faceOf('YEERXL+LinLibertineOI'), { bold: false, italic: true, mono: false, math: false });
    assert.deepEqual(faceOf('LinLibertineOBI'), { bold: true, italic: true, mono: false, math: false });
    assert.deepEqual(faceOf('LinLibertineOZ'), { bold: true, italic: false, mono: false, math: false });
    assert.equal(faceOf('QNYPEQ+LinLibertineO').bold, false);
    assert.equal(faceOf('URCPWR+LinBiolinumO').italic, false);
  });

  it('reads a bold Biolinum line as a heading, and an itemize dash set against its item as a bullet', () => {
    const runs = [
      line('1', 54, 100, { size: 10, font: 'JQQBID+LinBiolinumOB', width: 5 }),
      line('Introduction', 69, 100, { size: 10, font: 'JQQBID+LinBiolinumOB', width: 58 }),
      ...body(54, 115),
      line('—We provide the first analysis of the MCP ecosystem, detailing its', 66, 150, { width: 228 }),
      line('architecture.', 74, 160.8, { width: 60 }),
      line('—We identify the key components of MCP servers.', 66, 171.6, { width: 200 }),
    ];
    const layout = layoutPages([page(runs)]);
    assert.deepEqual(layout.blocks.filter((block) => block.kind === 'heading').map((block) => plain(block.spans)), ['1 Introduction']);
    const html = renderHtml(layout, () => null);
    assert.match(html, /<ul>\s*<li>We provide the first analysis.*architecture\.<\/li>\s*<li>We identify the key components of MCP servers\.<\/li>\s*<\/ul>/);
  });

  it('reads a byline of names in capitals before their institution, run over two lines, with the abstract under it', () => {
    const runs = [
      line('A Very Important Paper', 54, 80, { size: 14, font: 'JQQBID+LinBiolinumOB', width: 300 }),
      line('XINYI HOU and YANJIE ZHAO,', 54, 110, { size: 10.9, font: 'URCPWR+LinBiolinumO', width: 143 }),
      line('Huazhong University of Science and Technology, Wuhan, China', 200, 110, { size: 9, font: 'QNYPEQ+LinLibertineO', width: 235 }),
      line('SHENAO WANG and HAOYU WANG,', 54, 123, { size: 10.9, font: 'URCPWR+LinBiolinumO', width: 171 }),
      line('Huazhong University of Science and Technology,', 228, 123, { size: 9, font: 'QNYPEQ+LinLibertineO', width: 180 }),
      line('Wuhan, China', 54, 136, { size: 9, font: 'QNYPEQ+LinLibertineO', width: 53 }),
      ...column(54, 170, ['The Model Context Protocol (MCP) is an emerging open standard that', 'defines a unified protocol between AI models and external tools, and', 'this paper studies it.'], { width: 240 }),
      ...body(54, 220),
    ];
    const layout = layoutPages([page(runs)], { title: 'A Very Important Paper' });
    assert.deepEqual(layout.authors, ['Xinyi Hou', 'Yanjie Zhao', 'Shenao Wang', 'Haoyu Wang']);
    assert.deepEqual(
      layout.byline.authors.map((author) => [author.name, author.affiliations.join('; ')]),
      [
        ['Xinyi Hou', 'Huazhong University of Science and Technology, Wuhan, China'],
        ['Yanjie Zhao', 'Huazhong University of Science and Technology, Wuhan, China'],
        ['Shenao Wang', 'Huazhong University of Science and Technology, Wuhan, China'],
        ['Haoyu Wang', 'Huazhong University of Science and Technology, Wuhan, China'],
      ],
    );
    assert.equal(layout.front, undefined);
    assert.match(texts(layout)[0], /^The Model Context Protocol \(MCP\) is an emerging open standard/);
  });

  it('does not carry a paragraph on into a bold line at the head of the next page', () => {
    const first = page([...body(54, 100), ...column(54, 140, ['Additional Key Words and Phrases: Model Context Protocol, MCP,', 'Vision paper, Security'], { width: 240 })], [], 0);
    const second = page(
      [
        line('ACM Reference format:', 54, 100, { font: 'ERHDGH+LinLibertineOB', width: 90 }),
        ...column(54, 110.8, ['Xinyi Hou, Yanjie Zhao, Shenao Wang, and Haoyu Wang. 2026. Model', 'Context Protocol (MCP): Landscape. ACM Trans. Softw. Eng. Methodol.'], { width: 240 }),
        ...body(54, 150),
      ],
      [],
      1,
    );
    const found = texts(layoutPages([first, second]));
    assert.ok(found.includes('Additional Key Words and Phrases: Model Context Protocol, MCP, Vision paper, Security'), found.join('\n'));
    assert.ok(found.some((text) => text.startsWith('ACM Reference format:')), found.join('\n'));
  });

  it('keeps each row of a table whose groups are parted by rules, and joins a group label set on two lines', () => {
    const bold = { font: 'ERHDGH+LinLibertineOB', size: 7 };
    const cell = (str, x, y, options = {}) => line(str, x, y, { size: 7, ...options });
    const rows = [
      ['Namespace Typosquatting', '5.1.1', '(1) Metadata Definition', 'Installation of malicious server'],
      ['Tool Name Conflict', '5.1.2', '(1) Capability Declaration', 'Ambiguity, wrong tool execution'],
      ['Preference Manipulation', '5.1.3', '(1) Capability Declaration', 'Unsafe defaults exploited'],
      ['Tool Poisoning', '5.1.4', '(1) Capability Declaration', 'Hidden malicious payload executed'],
    ];
    const runs = [
      cell('Type', 60, 110, bold),
      cell('Security Risk', 100, 110, bold),
      cell('Section', 200, 110, bold),
      cell('Threat Origin', 240, 110, bold),
      cell('Attack Consequence', 345, 110, bold),
      ...rows.flatMap((cells, index) => [cell(cells[0], 100, 122 + 8 * index), cell(cells[1], 200, 122 + 8 * index), cell(cells[2], 240, 122 + 8 * index), cell(cells[3], 345, 122 + 8 * index)]),
      cell('Malicious', 60, 134), // level with the gap between the second and third rows
      cell('Developer', 60, 142),
      cell('Installer Spoofing', 100, 164),
      cell('5.2.1', 200, 164),
      cell('(2) Installer Deployment', 240, 164),
      cell('Deployment of compromised server', 345, 164),
      cell('Indirect Prompt Injection', 100, 172),
      cell('5.2.2', 200, 172),
      cell('(3) External Resource Access', 240, 172),
      cell('Malicious instructions injected', 345, 172),
      cell('External', 60, 164),
      cell('Attacker', 60, 172),
      line('Table 3. Threats, Origins, and Consequences across Different Attacker Types', 100, 95, { size: 8, width: 300 }),
      ...body(54, 210),
    ];
    const graphics = [
      { x0: 54, y0: 101, x1: 470, y1: 101.5, kind: 'path' },
      { x0: 54, y0: 113, x1: 470, y1: 113.5, kind: 'path' },
      { x0: 54, y0: 155, x1: 470, y1: 155.5, kind: 'path' },
      { x0: 54, y0: 176, x1: 470, y1: 176.5, kind: 'path' },
    ];
    const layout = layoutPages([page(runs, graphics)]);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.ok(table?.rows, JSON.stringify(layout.blocks.map((block) => block.kind)));
    const cells = table.rows.map((row) => row.map((cell) => plain(cell.spans)));
    assert.deepEqual(cells[0], ['Type', 'Security Risk', 'Section', 'Threat Origin', 'Attack Consequence']);
    assert.deepEqual(cells[1], ['Malicious Developer', 'Namespace Typosquatting', '5.1.1', '(1) Metadata Definition', 'Installation of malicious server']);
    assert.equal(table.rows[1][0].rowspan, 4);
    assert.deepEqual(cells.slice(2, 5).map((row) => row[0]), ['Tool Name Conflict', 'Preference Manipulation', 'Tool Poisoning']);
    assert.deepEqual(cells[5], ['External', 'Installer Spoofing', '5.2.1', '(2) Installer Deployment', 'Deployment of compromised server']);
    assert.deepEqual(cells[6], ['Attacker', 'Indirect Prompt Injection', '5.2.2', '(3) External Resource Access', 'Malicious instructions injected']);
  });
});
