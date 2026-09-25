// The notes board's geometry: where an arrow leaves a card, how a moved
// card snaps into line, how a tidy frames each section, and a curve's
// middle for an arrow's label. No browser: these are pure functions.
//
//   node --test scripts/board.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { edgePoint, snap, curve, tidyBySection, inside } = await load('src/lib/board.ts');
const { captioned, withoutLabel } = await load('src/lib/notes.ts');

after(cleanup);

describe('arrows', () => {
  it('leave a card at its edge, toward the other card', () => {
    assert.deepEqual(edgePoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 25 }), { x: 100, y: 25 });
    assert.deepEqual(edgePoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: -200 }), { x: 50, y: 0 });
  });

  it('curve along the way they mostly run, the label at the middle', () => {
    const { d, mid } = curve({ x: 0, y: 0 }, { x: 200, y: 100 });
    assert.match(d, /^M 0 0 C 100 0, 100 100, 200 100$/);
    assert.deepEqual(mid, { x: 100, y: 50 });
  });
});

describe('snapping a moved card into line', () => {
  const other = { x: 100, y: 100, w: 200, h: 80 };
  it('pulls its left edge onto another card\'s, within reach', () => {
    const { x, guides } = snap({ x: 104, y: 300, w: 200, h: 80 }, [other], 7);
    assert.equal(x, 100);
    assert.equal(guides.find((guide) => guide.axis === 'x')?.at, 100);
  });

  it('leaves it be out of reach', () => {
    const { x, y, guides } = snap({ x: 120, y: 330, w: 120, h: 60 }, [other], 7);
    assert.deepEqual({ x, y }, { x: 120, y: 330 });
    assert.equal(guides.length, 0);
  });

  it('lines up middles too', () => {
    const { y } = snap({ x: 400, y: 113, w: 100, h: 60 }, [other], 7);
    assert.equal(y + 30, 140);
  });
});

describe('a tidy', () => {
  const clip = (id, section, page) => ({ id, kind: 'clip', label: 'Figure 1', html: '', text: '', source: { from: 'paper', section, page }, at: '' });
  const text = (id) => ({ id, kind: 'text', md: 'x', at: '' });
  it('frames each section round its cards, with the page it starts on', () => {
    const blocks = [clip('a', '3.2 Attention', 2), text('b'), clip('c', '4 Why', 3)];
    const heights = { a: 100, b: 60, c: 100 };
    const { places, frames } = tidyBySection(blocks, heights, {});
    assert.deepEqual(frames.map((frame) => [frame.title, frame.page]), [['3.2 Attention', 2], ['4 Why', 3]]);
    for (const id of ['a', 'b']) assert.ok(inside(frames[0], { ...places[id], h: heights[id] }), id);
    assert.ok(inside(frames[1], { ...places.c, h: 100 }));
    assert.ok(frames.every((frame) => frame.auto));
  });

  it('keeps a card\'s colour', () => {
    const { places } = tidyBySection([text('b')], { b: 60 }, { b: { x: 900, y: 900, w: 300, z: 1, color: 'pink' } });
    assert.equal(places.b.color, 'pink');
  });
});

describe('a kept figure\'s words', () => {
  it('name the figure once', () => {
    assert.equal(captioned('Figure 1', 'Figure 1: Results for MINITRON.'), '[Figure 1: Results for MINITRON.]');
    assert.equal(captioned('Figure 1', 'Results for MINITRON.'), '[Figure 1: Results for MINITRON.]');
    assert.equal(captioned('Table 2', ''), '[Table 2]');
  });

  it('are shown without the name said again, however they were kept', () => {
    assert.equal(withoutLabel('Figure 1', '[Figure 1: Figure 1: Results for MINITRON.]'), 'Results for MINITRON.');
  });
});
