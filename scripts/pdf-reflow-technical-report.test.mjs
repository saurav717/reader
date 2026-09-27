// Reflow on a long technical report, as DeepSeek set "DeepSeek LLM: Scaling
// Open-Source Language Models with Longtermism" (arXiv 2401.02954), made up
// run by run as pdf.js reads it. Its byline of 86 names was dropped whole
// for being longer than sixty, and the one institution under them, marked
// "∗", was no one's; the note that the names are in alphabetical order,
// set as large as the text at the foot of the page, was a paragraph of it.
// The appendix's example prompts, each a box of text between rules under
// "Table 18 | An example of AGIEval", came out as headings, bullets and
// footnotes. A display of three lines lost its last, set mostly in its
// scripts; "budget𝐶" lost its space; a reference justified wide was read
// out of order; tables whose headings are set centred on two lines were
// split into rows of halves; and a licence's address set a letter at a
// time came out "h tt p : / / c r eati v ecom m o n s".
//
//   node --test scripts/pdf-reflow-technical-report.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const ROMAN = 'URWPalladioL-Roma';
const BOLD = 'URWPalladioL-Bold';
const MATH = 'XCharterMathMI';
const SIZE = 10.9;
const LEADING = 13.5;
const LEFT = 71;
const WIDTH = 453;
const run = (str, x, y, { size = SIZE, font = ROMAN, width } = {}) => ({ str, x, y, width: width ?? str.length * size * 0.45, size, font });
const page = (runs, graphics = [], index = 0, links = []) => ({ index, width: 595, height: 842, runs, graphics, links });
const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const rule = (x0, x1, y) => ({ x0, y0: y - 0.2, x1, y1: y + 0.2, kind: 'path' });

/** A paragraph of justified lines from `top`, its first indented, its last short. */
function paragraph(top, count, words, { indent = 17, last = 0.5, x = LEFT } = {}) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const first = index === 0;
    const final = index === count - 1;
    out.push(run(`${words} ${index + 1} of the paragraph set out in full here${final ? '.' : ''}`, x + (first ? indent : 0), top + index * LEADING, { width: final ? WIDTH * last : WIDTH - (first ? indent : 0) }));
  }
  return out;
}

/** A page after the first, whose front matter is read apart. */
const later = (runs, graphics = [], links = []) => layoutPages([page(paragraph(100, 45, 'Opening line')), page(runs, graphics, 1, links)]);

describe('a long byline', () => {
  const FIRST = ['Xiao', 'Deli', 'Guanting', 'Shanhuang', 'Damai', 'Chengqi', 'Honghui', 'Kai', 'Qiushi', 'Zhe'];
  const LAST = ['Bi', 'Chen', 'Chen', 'Chen', 'Dai', 'Deng', 'Ding', 'Dong', 'Du', 'Fu'];
  const names = Array.from({ length: 86 }, (_, index) => `${FIRST[index % 10]} ${LAST[index % 10]}${'abcdefghi'[Math.floor(index / 10)]}`);
  // Six names a line, centred, the last carrying the mark.
  const lines = [];
  for (let at = 0; at < names.length; at += 6) lines.push(names.slice(at, at + 6));
  const runs = [
    run('DeepSeek LLM', 250, 150, { size: 14.3, font: BOLD, width: 100 }),
    run('Scaling Open-Source Language Models with Longtermism', 130, 168, { size: 14.3, font: BOLD, width: 340 }),
    ...lines.flatMap((row, index) => {
      const str = row.join(', ') + (index === lines.length - 1 ? '' : ',');
      return [run(str, 90, 200 + 13 * index, { size: 10, width: 415 })];
    }),
    run('∗', 506, 200 + 13 * (lines.length - 1) - 3.6, { size: 7.3, width: 3.6 }),
    run('*', 255, 200 + 13 * lines.length + 6.4, { size: 9.5, width: 3.7 }),
    run('DeepSeek-AI', 259, 200 + 13 * lines.length + 11, { size: 12.9, font: BOLD, width: 80 }),
    run('Abstract', 270, 440, { size: 14.3, font: BOLD, width: 60 }),
    ...paragraph(465, 12, 'Abstract line'),
    // The note to the names, set at the foot of the page as large as the text.
    run('*Authors are ordered alphabetically by the last name.', 70, 794.7, { width: 258 }),
  ];
  const layout = layoutPages([page(runs)], { title: 'Deepseek llm: Scaling open-source language models with longtermism' });

  it('reads every name of a byline of 86', () => {
    assert.equal(layout.authors?.length, 86);
    assert.equal(layout.byline.authors.length, 86);
  });

  it('puts the one institution under the names, marked, to every name', () => {
    assert.deepEqual(layout.byline.affiliations.map((place) => place.text), ['DeepSeek-AI']);
    assert.ok(layout.byline.authors.every((author) => author.affiliations.join() === 'DeepSeek-AI'));
  });

  it('reads the note that the names are in alphabetical order, set at the foot as large as the text, into the byline, for every name', () => {
    assert.ok(!layout.blocks.some((block) => /ordered alphabetically/.test(text(block))), JSON.stringify(layout.blocks.map(text).slice(-3)));
    assert.ok(layout.byline.authors.every((author) => author.notes.includes('Authors are ordered alphabetically by the last name')));
  });
});

describe('an appendix after the references', () => {
  it('keeps the footnote of the appendix\'s first page a footnote, and the paragraph over it whole', () => {
    const references = [run('References', LEFT, 90, { size: 13, font: BOLD, width: 65 }), ...Array.from({ length: 40 }, (_, index) => run(`A. Author${index}. A paper about things, ${2000 + index}.`, LEFT, 110 + 16 * index, { width: 260 }))];
    const appendix = [
      run('A. Appendix', LEFT, 96, { size: 13, font: BOLD, width: 75 }),
      ...paragraph(120, 5, 'Appendix line', { last: 1 }).map((one, index, all) => (index === all.length - 1 ? { ...one, str: `${one.str.slice(0, -1)}, the` } : one)),
      run('1', 86.3, 753.6, { size: 7.3, width: 3.6 }),
      run('Authors are ordered alphabetically by the last name.', 90, 756.9, { size: 9, width: 208 }),
    ];
    const next = [...paragraph(96, 3, 'curve tends to underestimate', { indent: 0 }), ...paragraph(150, 30, 'Filler line')];
    const blocks = layoutPages([page(paragraph(100, 45, 'Opening line')), page(references, [], 1), page(appendix, [], 2), page(next, [], 3)]).blocks;
    assert.deepEqual(blocks.filter((block) => block.kind === 'footnote').map(text), ['1Authors are ordered alphabetically by the last name.']);
    assert.ok(blocks.some((block) => block.kind === 'paragraph' && /set out in full here, the curve tends to underestimate 1/.test(text(block))));
  });
});

describe('a table that is a box of text', () => {
  // As large as the text, its lines taken for running text; or smaller, its
  // one column no table to be read by columns.
  for (const size of [SIZE, 9.96]) it(`reads an example prompt between rules, captioned under, as a table of one column: its labels heading rows, its options a line each (${size}pt)`, () => {
    const at = (str, y, options = {}) => run(str, 125, y, { size, width: options.width ?? 345, font: options.font ?? ROMAN });
    const runs = [
      ...paragraph(90, 4, 'Body line'),
      at('PROMPT', 160, { font: BOLD, width: 40 }),
      at('Question: Use the information below to answer the question. Cotton is a', 173),
      at('plant product used to make fabric. How would a clothing manufacturer', 186),
      at('separate colors to determine the purity of the dyes?', 199, { width: 240 }),
      at('Answer:', 212, { width: 40 }),
      at('OPTIONS', 234, { font: BOLD, width: 45 }),
      at('- through filtration', 247, { width: 90 }),
      at('- by their boiling points', 260, { width: 110 }),
      at('- through paper chromatography', 273, { width: 150 }),
      run('Table 19 | An example of ARC.', 245, 300, { width: 130 }),
      ...paragraph(330, 5, 'After line'),
    ];
    const graphics = [rule(122, 472, 150), rule(122, 472, 222), rule(122, 472, 283)];
    const blocks = later(runs, graphics).blocks;
    const table = blocks.find((block) => block.kind === 'table');
    assert.equal(table?.label, 'Table 19');
    assert.deepEqual(
      table.rows.map((row) => row.map((cell) => [plain(cell.spans), Boolean(cell.head)])),
      [
        [['PROMPT', true]],
        [['Question: Use the information below to answer the question. Cotton is a plant product used to make fabric. How would a clothing manufacturer separate colors to determine the purity of the dyes? Answer:', false]],
        [['OPTIONS', true]],
        [['- through filtration - by their boiling points - through paper chromatography', false]],
      ],
    );
    // An option a line.
    assert.equal(table.rows[3][0].spans.map((span) => span.text).join(''), '- through filtration\n- by their boiling points\n- through paper chromatography');
    // Nothing of it in the text: no heading, no list, no footnote.
    assert.ok(!blocks.some((block) => block.kind !== 'table' && /PROMPT|OPTIONS|filtration|Cotton/.test(text(block))));
  });
});

describe('mathematics and spacing', () => {
  it('keeps every line of a display whose lines are set mostly in their scripts', () => {
    const line = (y, parts) => parts.map(([str, x, size, font]) => run(str, x, y, { size, font, width: str.length * size * 0.5 }));
    const runs = [
      ...paragraph(90, 4, 'Body line'),
      ...line(292, [['6', 202, SIZE, ROMAN], ['𝑁', 208, 10, MATH], ['1', 215, 8, ROMAN], ['= 72', 222, SIZE, ROMAN], ['𝑛', 250, 10, MATH], ['layer', 256, 8, ROMAN], ['𝑑', 278, 10, MATH], ['model', 284, 8, ROMAN]]),
      ...line(310, [['6', 202, SIZE, ROMAN], ['𝑁', 208, 10, MATH], ['2', 215, 8, ROMAN], ['= 72', 222, SIZE, ROMAN], ['𝑛', 250, 10, MATH], ['layer', 256, 8, ROMAN], ['𝑑', 278, 10, MATH], ['model', 284, 8, ROMAN], ['+ 6', 310, SIZE, ROMAN], ['𝑛', 330, 10, MATH], ['vocab', 336, 8, ROMAN]]),
      run('(2)', 513, 308, { width: 13 }),
      ...line(329, [['𝑀', 210, 10, MATH], ['= 72', 222, SIZE, ROMAN], ['𝑛', 250, 10, MATH], ['layer', 256, 8, ROMAN], ['𝑑', 278, 10, MATH], ['model', 284, 8, ROMAN], ['+ 12', 310, SIZE, ROMAN], ['𝑛', 336, 10, MATH], ['layer', 342, 8, ROMAN], ['𝑙', 366, 10, MATH], ['seq', 372, 8, ROMAN]]),
      ...paragraph(355, 4, 'where the width', { indent: 0 }),
    ];
    const blocks = later(runs).blocks;
    const equations = blocks.filter((block) => block.kind === 'equation');
    assert.equal(equations.length, 1);
    assert.ok(equations[0].crop.y1 >= 331, JSON.stringify(equations[0].crop));
    assert.ok(!blocks.some((block) => block.kind === 'paragraph' && /^𝑀 =|layer/.test(text(block))), JSON.stringify(blocks.map(text)));
  });

  it('keeps a space pdf.js reports as a run of its own, though the word before is measured as reaching the next', () => {
    const runs = [
      ...paragraph(90, 4, 'Body line'),
      run('as: Given a computing budget', LEFT, 160, { width: 151.4 }),
      run(' ', 219.8, 160, { width: 3.1 }),
      run('𝐶', 223, 160, { size: 10, font: MATH, width: 6.1 }),
      run(' = ', 229.1, 160, { width: 13.3 }),
      run('𝑀𝐷', 242.5, 160, { size: 10, font: MATH, width: 16.3 }),
      run(', find the optimal model scale and data scale that minimize the error.', 258.9, 160, { width: 265.6 }),
      run('variance d', LEFT, 173.5, { width: 50 }),
      run('k', 121, 175.5, { size: 7, width: 3.5 }),
      run(' ', 124.5, 173.5, { width: 0.1 }),
      run('.', 124.6, 173.5, { width: 2.7 }),
    ];
    const blocks = later(runs).blocks.map(text);
    assert.ok(blocks.some((block) => block.includes('computing budget 𝐶 = 𝑀𝐷, find')), JSON.stringify(blocks));
    assert.ok(blocks.some((block) => block.endsWith('variance dk.')));
  });

  it('reads a reference justified wide enough to part its words by more than an em as one line, in order', () => {
    // The last entry on the page, nothing under it but its own last line.
    const runs = [
      run('References', LEFT, 90, { size: 13, font: BOLD, width: 65 }),
      ...Array.from({ length: 26 }, (_, index) => run(`A. Author${index}, B. Writer, and C. Scribe. A paper about things and their measures. Journal of Things, ${2000 + index}.`, LEFT, 110 + 23 * index, { width: WIDTH })),
      run('I. Loshchilov and F. Hutter.', LEFT, 723, { width: 146.3 }),
      run('Decoupled weight decay regularization.', 231.4, 723, { width: 206.7 }),
      run('arXiv preprint', 452.3, 723, { width: 71.6 }),
      run('arXiv:1711.05101, 2017.', 81.7, 736.6, { width: 110.9 }),
    ];
    const blocks = later(runs).blocks.map(text);
    assert.ok(blocks.includes('I. Loshchilov and F. Hutter. Decoupled weight decay regularization. arXiv preprint arXiv:1711.05101, 2017.'), JSON.stringify(blocks.slice(0, 4)));
  });

  it('reads an address set a letter at a time, each letter a run with a space pdf.js leads it with, as the address', () => {
    const letters = 'http://creativecommons.org/licenses/by/4.0/';
    let x = 305;
    const runs = [...paragraph(90, 5, 'Body line'), run('holder. To view a copy of this licence, visit', 130, 180, { size: 8.5, width: 170 }), run(' ', 300, 180, { size: 8.5, width: 0.3 })];
    for (const [index, letter] of Array.from(letters).entries()) {
      // Every other letter led by a space that takes no room.
      runs.push(run(index % 2 ? ` ${letter}` : letter, x, 180, { size: 8.5, width: 2.4 }));
      x += 2.4;
    }
    const links = [{ x0: 304, y0: 172, x1: x + 1, y1: 183, url: 'http://creativecommons.org/licenses/by/4.0/' }];
    const blocks = later(runs, [], links).blocks.map(text);
    assert.ok(blocks.some((block) => block.endsWith('visit http://creativecommons.org/licenses/by/4.0/')), JSON.stringify(blocks.slice(-2)));
  });
});

describe('headings of tables set centred', () => {
  const size = 9.96;
  const cell = (str, x, y, width, font = ROMAN) => run(str, x, y, { size, width, font });

  it('reads a heading of two lines beside headings of one, set centred on them, as one row', () => {
    const runs = [
      ...paragraph(80, 4, 'Body line'),
      run('Table 2 | Detailed specs of DeepSeek LLM family of models.', LEFT, 150, { size, width: 260 }),
      cell('Context', 360, 175, 35),
      cell('Learning', 420, 175, 38),
      cell('Params', 110, 182, 30),
      cell('𝑛layers', 170, 182, 30),
      cell('Tokens', 480, 182, 30),
      cell('Length', 362, 189, 30),
      cell('Rate', 427, 189, 20),
      cell('7B', 115, 210, 10),
      cell('30', 175, 210, 10),
      cell('4096', 365, 210, 20),
      cell('4.2e-4', 425, 210, 28),
      cell('2.0T', 485, 210, 20),
      cell('67B', 113, 225, 15),
      cell('95', 175, 225, 10),
      cell('4096', 365, 225, 20),
      cell('3.2e-4', 425, 225, 28),
      cell('2.0T', 485, 225, 20),
      ...paragraph(260, 5, 'After line'),
    ];
    const graphics = [rule(100, 520, 165), rule(100, 520, 198), rule(100, 520, 232)];
    const table = later(runs, graphics).blocks.find((block) => block.kind === 'table');
    assert.deepEqual(table.rows.map((row) => row.map((one) => plain(one.spans))), [
      ['Params', '𝑛layers', 'Context Length', 'Learning Rate', 'Tokens'],
      ['7B', '30', '4096', '4.2e-4', '2.0T'],
      ['67B', '95', '4096', '3.2e-4', '2.0T'],
    ]);
  });

  const table = (heading, graphics) => {
    const runs = [
      ...paragraph(80, 4, 'Body line'),
      run('Table 5 | Main results.', LEFT, 150, { size, width: 100 }),
      ...heading,
      cell('HellaSwag', 120, 225, 45),
      cell('75.6', 305, 225, 18),
      cell('84.0', 385, 225, 18),
      cell('PIQA', 120, 240, 22),
      cell('78.0', 305, 240, 18),
      cell('83.6', 385, 240, 18),
      ...paragraph(270, 5, 'After line'),
    ];
    return later(runs, graphics).blocks.find((block) => block.kind === 'table');
  };
  const rows = (found) => found.rows.map((row) => row.map((one) => plain(one.spans)));

  it('keeps the models\' sizes, set over the rule under the heading, in the heading', () => {
    const found = table([cell('LLaMA2', 300, 185, 35), cell('DeepSeek', 380, 185, 40), cell('Benchmark', 120, 192, 45), cell('7B', 310, 199, 10), cell('67B', 390, 199, 15)], [rule(100, 450, 170), rule(100, 450, 208), rule(100, 450, 247)]);
    assert.deepEqual(rows(found), [
      ['Benchmark', 'LLaMA2 7B', 'DeepSeek 67B'],
      ['HellaSwag', '75.6', '84.0'],
      ['PIQA', '78.0', '83.6'],
    ]);
    assert.deepEqual(found.rows.map((row) => row.some((one) => one.head)), [true, false, false]);
  });

  it('keeps a row of the heading with a cell in every column a row of its own', () => {
    const found = table(
      [cell('DeepSeek-VL', 300, 175, 50), cell('DeepSeek-LLM', 380, 175, 55), cell('Version', 120, 182, 35), cell('1B Chat', 305, 189, 32), cell('7B Chat', 385, 189, 32), cell('Encoder', 120, 203, 35), cell('SigLIP', 305, 203, 28), cell('None', 390, 203, 22)],
      [rule(100, 450, 165), rule(100, 450, 212), rule(100, 450, 247)],
    );
    assert.deepEqual(rows(found), [
      ['Version', 'DeepSeek-VL 1B Chat', 'DeepSeek-LLM 7B Chat'],
      ['Encoder', 'SigLIP', 'None'],
      ['HellaSwag', '75.6', '84.0'],
      ['PIQA', '78.0', '83.6'],
    ]);
  });
});
