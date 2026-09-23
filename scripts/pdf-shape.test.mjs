// Telling a paper from a poster, a deck of slides or a one-page abstract by
// the shape of the PDF, which is how the reader decides a copy's file is
// probably not the paper and asks the other copies before showing it.
//
//   node --test scripts/pdf-shape.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const { pdfShape } = await load('src/lib/pdfShape.ts');
after(cleanup);

const A4 = { width: 595, height: 842 };
const LETTER = { width: 612, height: 792 };

describe('whether a PDF looks like the paper', () => {
  it('takes a paper on A4 or Letter, however long', () => {
    assert.equal(pdfShape({ pages: 12, ...A4 }), null);
    assert.equal(pdfShape({ pages: 8, ...LETTER }), null);
    assert.equal(pdfShape({ pages: 3, ...LETTER }), null);
  });

  it('calls one enormous page a poster', () => {
    // A0 portrait, and 48×36 in landscape — the two sizes conferences ask for.
    assert.match(pdfShape({ pages: 1, width: 2384, height: 3370 }), /poster — one page of 33×47 in/);
    assert.match(pdfShape({ pages: 1, width: 3456, height: 2592 }), /poster — one page of 48×36 in/);
  });

  it('calls a deck of landscape pages slides', () => {
    assert.match(pdfShape({ pages: 24, width: 720, height: 405 }), /slides — 24 landscape pages/);
    assert.match(pdfShape({ pages: 30, width: 960, height: 720 }), /slides/);
  });

  it('doubts a page or two on paper-sized pages: an abstract, not the paper', () => {
    assert.match(pdfShape({ pages: 1, ...A4 }), /only one page/);
    assert.match(pdfShape({ pages: 2, ...LETTER }), /only two pages/);
  });

  it('says nothing about a file it could not measure', () => {
    assert.equal(pdfShape({ pages: 0, width: 0, height: 0 }), null);
  });
});
