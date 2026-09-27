// Reflow on a review set as Springer sets its "Current … Reports" journals
// (after "Neurobiology of Insomnia", Current Sleep Medicine Reports, 2026),
// made up run by run as pdf.js reads them. Its abstract, set across both
// columns, is in parts each led by a heading run into its text — "Purpose
// of review", "Recent findings", "Summary" — and the last two came out as
// one paragraph: the line before "Summary" stopped well short of the
// abstract's edge, but not of a column's. Its running head puts the
// article's number in a box before "Page 2 of 3", and that number was
// read as a note's number hung beside its text: kept, it came out as a
// paragraph of "44" that cut the paragraph running on to the page in two,
// and at the head of a page the bibliography ran on to, the last word of a
// reference. The corresponding author, under an envelope drawn rather than
// set, was a footnote in the middle of the text; and a key reference
// running on to the next page was two.
//
//   node --test scripts/pdf-reflow-springer-review.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const ROMAN = 'TimesNewRomanPSMT';
const HEAD = 'MyriadPro-SemiboldSemiCn';
const run = (str, x, y, { size = 10, font = ROMAN, width } = {}) => ({ str, x, y, width: width ?? str.length * size * 0.45, size, font });

// Two columns, 51–296 and 306–541; the abstract across both.
const LEFT = 51;
const RIGHT = 306;
const COLUMN = 235;
const WIDE = 490;
const LEADING = 12.5;

/** Justified lines of a column from `top`, the last one short: each a sentence of filler. */
function lines(x, top, count, words, { width = COLUMN, last = 0.5 } = {}) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const final = index === count - 1;
    out.push(run(`${words} ${index + 1} of the same paragraph set in the column${final ? '.' : ''}`, x, top + index * LEADING, { width: final ? width * last : width }));
  }
  return out;
}

/** A line led by a heading run into its text, in bold. */
const runIn = (label, text, x, y, width) => {
  const labelWidth = label.length * 4.6;
  return [run(label, x, y, { font: HEAD, width: labelWidth }), run(text, x + labelWidth + 5, y, { width: width - labelWidth - 5 })];
};

const page = (index, runs, graphics = []) => ({ index, width: 595, height: 792, runs, graphics });

let layout;

before(() => {
  const first = [
    run('Current Sleep Medicine Reports', LEFT, 40, { size: 8.5, font: 'MyriadPro-SemiCn' }),
    run('Neurobiology of Wakefulness', LEFT, 120, { size: 16, font: HEAD }),
    run('Ada Lindqvist', LEFT, 149, { font: 'MyriadPro-Semibold' }),
    run('1', 110, 145, { size: 7, font: HEAD }),
    run('· Tomas Okafor', 116, 149, { font: 'MyriadPro-Semibold' }),
    run('1', 186, 145, { size: 7, font: HEAD }),
    run('Abstract', LEFT, 218, { font: 'MyriadPro-Bold' }),
    ...runIn('Purpose of review', 'In this review we summarise what is known of the neurobiology of wakefulness at night and', LEFT, 230.5, WIDE),
    run('by day, in each area of study, noting the early work, what has been added of late, and the most recent summaries of it all.', LEFT, 243, { width: WIDE }),
    run('It closes on the whole of it.', LEFT, 255.5, { width: 120 }),
    ...runIn('Recent findings', 'While the heritability of wakefulness is marked, many genes are involved in it, and no one', LEFT, 268, WIDE),
    run('region of the brain stands out either; what is found most often across the methods of study is arousal, and the regulation', LEFT, 280.5, { width: WIDE }),
    // Short of the abstract's edge, but as long as a column is.
    run('of emotion, which may still inform the therapy chosen.', LEFT, 293, { width: 238 }),
    ...runIn('Summary', 'Despite promising advances in method, studies of groups converge on unspecific terms such as', LEFT, 305.5, WIDE),
    run('arousal, and the mechanisms are underreported; subgroups better told apart should yield more in the future.', LEFT, 318, { width: 420 }),
    run('Keywords', LEFT, 342, { font: HEAD, width: 40 }),
    run('Sleep medicine · Neurobiology · Wakefulness', 96, 342, { width: 200 }),
    run('Introduction', LEFT, 380, { size: 12, font: 'MyriadPro-Bold' }),
    ...lines(LEFT, 400, 14, 'Introductory line'),
    run('Known Areas', RIGHT, 380, { size: 12, font: 'MyriadPro-Bold' }),
    ...lines(RIGHT, 400, 13, 'Area line'),
    // The paragraph that runs on to the next page: no stop at its end.
    run('and the subjective loss of sleep obtained from it', RIGHT, 400 + 13 * LEADING, { width: COLUMN }),
    // The corresponding author, under an envelope drawn as a path, and the institution.
    run('Tomas Okafor', 65.2, 618, { size: 8.5 }),
    run('tomas.okafor@northfield.example.edu', 65.2, 628, { size: 8.5 }),
    run('1', LEFT, 644.6, { size: 5.95 }),
    run('Department of Psychiatry, Northfield University, Northfield, Germany', 65.2, 648, { size: 8.5 }),
  ];
  const envelope = [{ x0: 51, y0: 611, x1: 59, y1: 617, kind: 'path' }];

  const headLeft = [
    run('44', 56.4, 40.4, { size: 8.5, font: 'MyriadPro-Regular', width: 8.8 }),
    run('Page 2 of 3', 84.9, 40.4, { size: 8.5, font: 'MyriadPro-SemiCn', width: 40 }),
    run('Current Sleep Medicine Reports', 346.5, 40.4, { size: 8.5, font: 'MyriadPro-SemiCn', width: 100 }),
    run('(2026) 12:44', 474.6, 40.4, { size: 8.5, font: 'MyriadPro-SemiCn', width: 40 }),
  ];
  const second = [
    ...headLeft,
    ...lines(LEFT, 70.5, 20, 'Continued line'),
    ...lines(RIGHT, 70.5, 12, 'Right column line'),
    run('Key References', RIGHT, 250, { size: 12, font: 'MyriadPro-Bold' }),
    run('●', RIGHT, 275, { font: 'Tahoma', width: 7 }),
    run('Lindqvist A, Okafor T. A first key paper on arousal. Sleep.', 321.1, 275, { width: 220 }),
    run('2020;1:1–10.', 321.1, 287.5, { width: 60 }),
    run('●', RIGHT, 312.5, { font: 'Tahoma', width: 7 }),
    run('Castell M, Lindqvist A, Okafor T, Brandt K, Moreau L,', 321.1, 312.5, { width: 220 }),
    // Broken off at the page's end, in the middle of a name.
    run('Varga P, Sato H, Nkemelu O, Duarte R, Hale M', 321.1, 325, { width: 220 }),
  ];

  const third = [
    run('Current Sleep Medicine Reports', LEFT, 40.4, { size: 8.5, font: 'MyriadPro-SemiCn', width: 100 }),
    run('(2026) 12:44', 179.1, 40.4, { size: 8.5, font: 'MyriadPro-SemiCn', width: 40 }),
    run('Page 3 of 3', 469.2, 40.4, { size: 8.5, font: 'MyriadPro-SemiCn', width: 40 }),
    run('44', 524.3, 40.4, { size: 8.5, font: 'MyriadPro-Regular', width: 8.8 }),
    // The key reference's last lines, at its text's indent.
    run('C, Ward S, Pike J. Brain health from the sleep EEG. Sleep', 66, 70.5, { width: 220 }),
    run('Adv. 2026;3:1–9.', 66, 83, { width: 80 }),
    run('Author Contributions', LEFT, 120, { size: 11, font: 'MyriadPro-Bold', width: 110 }),
    ...lines(LEFT, 140, 4, 'Contributions line'),
    run('References', RIGHT, 70.5, { size: 12, font: 'MyriadPro-Bold', width: 60 }),
    run('1. American Association. Diagnostic manual of disorders.', RIGHT, 90, { size: 8.5, width: 235 }),
    run('Washington, DC: APA Publishing; 2013.', 323, 100, { size: 8.5, width: 160 }),
    run('2. Spielman AJ, Glovinsky PB. The varied nature of wakeful-', RIGHT, 110, { size: 8.5, width: 235 }),
    run('ness. New York: Plenum; 1991.', 323, 120, { size: 8.5, width: 130 }),
  ];

  layout = layoutPages([page(0, first, envelope), page(1, second), page(2, third)], { title: 'Neurobiology of Wakefulness' });
});

const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const starting = (words) => layout.blocks.filter((block) => text(block).startsWith(words));

describe('a review set as Springer sets its Reports journals', () => {
  it('reads each part of a structured abstract, led by its heading run into it, as a paragraph of its own', () => {
    const parts = ['Purpose of review', 'Recent findings', 'Summary', 'Keywords'].map((label) => starting(label));
    for (const found of parts) assert.equal(found.length, 1);
    assert.match(text(parts[1][0]), /inform the therapy chosen\.$/);
    assert.match(text(parts[2][0]), /^Summary Despite promising advances/);
  });

  it('keeps the lines of each part of the abstract together', () => {
    assert.ok(!layout.blocks.some((block) => text(block).startsWith('by day')));
  });

  it('drops the article\'s number set beside the running head, whichever side of the page it is on', () => {
    assert.deepEqual(layout.blocks.filter((block) => /^\s*44\s*$/.test(text(block))).map(text), []);
    assert.ok(!layout.blocks.some((block) => /\b44$/.test(text(block))));
  });

  it('carries the paragraph over the page break, with no footnote or number between', () => {
    const [carried] = starting('Area line 1');
    assert.ok(carried);
    assert.match(text(carried), /obtained from it Continued line 1 of the same paragraph/);
    assert.equal(starting('Continued line 1').length, 0);
  });

  it('puts the corresponding author, under an envelope drawn rather than set, to the byline and not in a footnote', () => {
    assert.deepEqual(layout.blocks.filter((block) => block.kind === 'footnote').map(text), []);
    const okafor = layout.byline.authors.find((one) => one.name === 'Tomas Okafor');
    assert.deepEqual(okafor.emails, ['tomas.okafor@northfield.example.edu']);
    assert.ok(okafor.notes.includes('Corresponding author'));
  });

  it('carries a list item over the page break at its text\'s indent, and not the text after the list', () => {
    const [item] = starting('● Castell M');
    assert.ok(item);
    assert.match(text(item), /Hale M C, Ward S, Pike J\. Brain health/);
    assert.equal(starting('C, Ward S').length, 0);
    assert.ok(!text(item).includes('Contributions line'));
    assert.equal(starting('Contributions line 1').length, 1);
  });
});

describe('a list followed by text', () => {
  it('keeps a paragraph after a list its own, though it be indented as far as the list\'s text', () => {
    const runs = [
      ...lines(LEFT, 100, 10, 'Body line'),
      run('●', LEFT, 240, { font: 'Tahoma', width: 7 }),
      run('An item of the list whose text runs on to a second line', 66, 240, { width: 220 }),
      run('and ends without a stop', 66, 252.5, { width: 100 }),
      // Space over it, and its first line indented as far as the item's text.
      run('A paragraph after the list begins with an indent here', 66, 280, { width: 220 }),
      ...lines(LEFT, 292.5, 3, 'After line'),
    ];
    const blocks = layoutPages([page(0, runs)]).blocks;
    const item = blocks.find((block) => text(block).startsWith('● An item'));
    assert.match(text(item), /ends without a stop$/);
    assert.ok(blocks.some((block) => text(block).startsWith('A paragraph after the list')));
  });
});
