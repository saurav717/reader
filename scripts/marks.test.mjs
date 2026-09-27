// Highlights made in one mode found in the other: the reflowed text and the
// PDF's text layer hold the same words, spaced, hyphenated and spelt apart.
//
//   node --test scripts/marks.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const anchor = await load('src/lib/anchor.ts');
const marks = await load('src/lib/pdfMarks.ts');

after(cleanup);

// The PDF's text layer: lines run together, a word broken with its hyphen, a ligature.
const PAGES = [
  'Introduction We study the oracle se-lection problem, where theﬁnal model is chosen',
  'with the test set. The oracle selection upper bound is never reached in practice.',
];
// The same words, reflowed.
const REFLOW = 'Introduction\nWe study the oracle selection problem, where the final model is chosen with the test set. The oracle selection upper bound is never reached in practice.';

const highlight = (selector, extra = {}) => ({ id: 'h1', paperId: 'p', color: 'yellow', tags: [], createdAt: '', ...selector, ...extra });

describe('a highlight made in Reflow mode, on the PDF', () => {
  it('is found across the hyphen, the ligature and the missing spaces', () => {
    const start = REFLOW.indexOf('oracle selection problem');
    const selector = { exact: 'oracle selection problem, where the final model', prefix: 'We study the ', suffix: ' is chosen', hint: start };
    const pdf = marks.pdfText(PAGES);
    const placed = marks.placeMarks(pdf, [highlight(selector)]);
    const [mark] = placed.get(1);
    assert.equal(PAGES[0].slice(mark.start, mark.end), 'oracle se-lection problem, where theﬁnal model');
    assert.equal(placed.get(2), undefined);
  });
  it('is cut at the page break when it runs onto the next page', () => {
    const selector = { exact: 'the final model is chosen with the test set', prefix: 'problem, where ', suffix: '. The oracle', hint: 0 };
    const placed = marks.placeMarks(marks.pdfText(PAGES), [highlight(selector)]);
    const [first] = placed.get(1);
    const [second] = placed.get(2);
    assert.equal(PAGES[0].slice(first.start, first.end), 'theﬁnal model is chosen');
    assert.equal(PAGES[1].slice(second.start, second.end), 'with the test set');
  });
  it('picks the repeat its neighbours match', () => {
    const selector = { exact: 'oracle selection', prefix: 'test set. The ', suffix: ' upper bound', hint: 0 };
    const placed = marks.placeMarks(marks.pdfText(PAGES), [highlight(selector)]);
    assert.equal(placed.get(1), undefined);
    const [mark] = placed.get(2);
    assert.equal(PAGES[1].slice(mark.start, mark.end), 'oracle selection');
  });
});

describe('a highlight made on the PDF, in Reflow mode', () => {
  it('keeps the words as a person would quote them', () => {
    assert.equal(marks.readable('oracle se-\nlection  problem,\n where'), 'oracle selection problem, where');
  });
  it('is found in the reflowed text', () => {
    const pdf = marks.pdfText(PAGES);
    const start = pdf.text.indexOf('theﬁnal');
    const end = pdf.text.indexOf('test set') + 'test set'.length;
    const selector = marks.selectorIn(pdf, start, end, 'theﬁnal model is chosen\nwith the test set');
    const at = anchor.resolveSelector({ text: REFLOW }, selector);
    assert.equal(REFLOW.slice(at.start, at.end), 'the final model is chosen with the test set');
  });
  it('is still found exactly where the words are the same', () => {
    const selector = { exact: 'upper bound', prefix: 'oracle selection ', suffix: ' is never', hint: 0 };
    const at = anchor.resolveSelector({ text: REFLOW }, selector);
    assert.equal(REFLOW.slice(at.start, at.end), 'upper bound');
  });
  it('is an orphan when its words are gone', () => {
    assert.equal(anchor.resolveSelector({ text: REFLOW }, { exact: 'not in this paper', prefix: '', suffix: '', hint: 0 }), null);
  });
});

describe('the boxes drawn over the page', () => {
  it('are one a line, however many spans the line was set in', () => {
    const merged = marks.mergeBoxes([
      { left: 10, top: 100, width: 40, height: 12 },
      { left: 53, top: 101, width: 30, height: 11 },
      { left: 10, top: 100, width: 40, height: 12 },
      { left: 10, top: 114, width: 60, height: 12 },
      { left: 90, top: 114, width: 0, height: 12 },
    ]);
    assert.deepEqual(merged, [
      { left: 10, top: 100, width: 73, height: 12 },
      { left: 10, top: 114, width: 60, height: 12 },
    ]);
  });
});
