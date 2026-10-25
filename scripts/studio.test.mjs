// A Studio scene, without a browser: how a studio block's JSON is read, where
// the walk is at any point of it, what the state looks like there, and what
// the readouts say — and how the block is read out of a page.
//
//   node --test scripts/studio.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const studio = await load('src/lib/studio.ts');
const explain = await load('src/lib/explain.ts', { external: ['@anthropic-ai/sdk'] });
after(cleanup);

const SCENE = `{"state":"the image x_t","unit":"step",
 "slots":["t=1000","t=800","t=600","t=400","t=200","t=0"],
 "show":{"kind":"noise","base":[[0.9,0.9,0.8,0.9],[0.9,0.7,0.6,0.9],[0.3,0.3,0.3,0.4],[0.2,0.3,0.2,0.2]],"level":[1,0.9,0.7,0.45,0.2,0]},
 "steps":[{"title":"Pick up the noise","equation":"x_T \\\\sim \\\\mathcal{N}(0, I)","note":"No picture in it yet."},
          {"title":"Carry it one step","equation":"x_{t-1} = \\\\ldots","at":0.1},
          {"title":"Watch what settles"},
          {"title":"Set it down as x_0","at":0.92}],
 "readouts":[{"label":"t","values":[1000,800,600,400,200,0]},{"label":"ᾱ_t","values":[0.002,0.05,0.26,0.62,0.9,1],"decimals":3},{"label":"what settles","values":["tone","tone","shapes","shapes","edges","edges"]}],
 "tries":["Walk two seeds side by side."],
 "ask":"Why does the sky settle before the hills?"}`;

describe('reading a scene', () => {
  const spec = studio.parseStudio(SCENE);
  it('reads the state, the slots, the show, the steps and the readouts', () => {
    assert.equal(spec.state, 'the image x_t');
    assert.equal(spec.unit, 'step');
    assert.equal(spec.slots.length, 6);
    assert.equal(spec.show.kind, 'noise');
    assert.equal(spec.show.base.length, 4);
    assert.deepEqual(spec.show.level, [1, 0.9, 0.7, 0.45, 0.2, 0]);
    assert.equal(spec.steps.length, 4);
    assert.equal(spec.steps[0].equation, 'x_T \\sim \\mathcal{N}(0, I)');
    assert.equal(spec.readouts.length, 3);
    assert.equal(spec.readouts[1].decimals, 3);
    assert.deepEqual(spec.tries, ['Walk two seeds side by side.']);
    assert.equal(spec.ask, 'Why does the sky settle before the hills?');
  });
  it('forgives a trailing comma, a comment and a fence left in, and refuses what is not a scene', () => {
    const forgiven = studio.parseStudio('```studio\n// the scene\n{"slots":["a","b",],"show":{"kind":"bars","values":[[1,2],[2,1],],},"steps":[{"title":"one",}]}\n```');
    assert.equal(forgiven.slots.length, 2);
    assert.equal(forgiven.show.kind, 'bars');
    assert.equal(studio.parseStudio('{"slots":["a","b"]}'), null, 'no show');
    assert.equal(studio.parseStudio('{"slots":["a"],"show":{"kind":"bars","values":[[1]]}}'), null, 'one slot is not a walk');
    assert.equal(studio.parseStudio('{"slots":["a","b"],"show":{"kind":"grid","frames":[]}}'), null, 'no frames');
    assert.equal(studio.parseStudio('not json'), null);
    assert.equal(studio.parseStudio('{"slots":["a","b"],"show":{"kind":"hologram"}}'), null, 'an unknown kind');
  });
  it('gives a scene with no steps one, and keeps the steps in the order written', () => {
    const bare = studio.parseStudio('{"state":"the belief","slots":["t=0","t=1"],"show":{"kind":"density","mean":[0.5,0.6]}}');
    assert.equal(bare.steps.length, 1);
    assert.match(bare.steps[0].title, /the belief/);
    assert.deepEqual(bare.show.spread, [0.2, 0.2], 'a spread when none is given');
    const backwards = studio.parseStudio('{"slots":["a","b"],"show":{"kind":"bars","values":[[1]]},"steps":[{"title":"one","at":0.5},{"title":"two","at":0.2},{"title":"three","at":0.8}]}');
    assert.deepEqual(
      backwards.steps.map((s) => s.at),
      [0.5, undefined, 0.8],
    );
  });
  it('pads a ragged grid and clamps its values', () => {
    const ragged = studio.parseStudio('{"slots":["a","b"],"show":{"kind":"grid","frames":[[[2,-1],[0.5]]]}}');
    assert.deepEqual(ragged.show.frames[0], [
      [1, 0],
      [0.5, 0.5],
    ]);
  });
});

describe('the walk', () => {
  it('lifts the state at the start, carries it between the slots, and sets it down at the end', () => {
    assert.equal(studio.walkAt(0, 6).phase, 'pickup');
    assert.equal(studio.walkAt(0, 6).lift, 0);
    assert.equal(studio.walkAt(0.03, 6).phase, 'pickup');
    assert.equal(studio.walkAt(0.5, 6).phase, 'carry');
    assert.equal(studio.walkAt(0.5, 6).lift, 1);
    assert.equal(studio.walkAt(0.97, 6).phase, 'setdown');
    assert.equal(studio.walkAt(1, 6).lift, 0);
  });
  it('says which slot it is at and how far to the next', () => {
    const mid = studio.walkAt(0.5, 6);
    assert.equal(mid.position, 2.5);
    assert.equal(mid.slot, 2);
    assert.equal(mid.next, 3);
    assert.equal(mid.between, 0.5);
    const end = studio.walkAt(1, 6);
    assert.equal(end.slot, 5);
    assert.equal(end.next, 5);
    assert.equal(end.between, 0);
    assert.equal(studio.walkAt(2, 6).position, 5, 'past the end is the end');
    assert.equal(studio.walkAt(NaN, 6).position, 0);
  });
  it('spreads the lesson steps that have no start between the ones that do, and picks the step at a point', () => {
    const spec = studio.parseStudio(SCENE);
    assert.deepEqual(studio.stepStarts(spec), [0, 0.1, 0.51, 0.92]);
    assert.equal(studio.stepAt(spec, 0), 0);
    assert.equal(studio.stepAt(spec, 0.3), 1);
    assert.equal(studio.stepAt(spec, 0.6), 2);
    assert.equal(studio.stepAt(spec, 1), 3);
    const none = { steps: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] };
    assert.deepEqual(studio.stepStarts(none), [0, 0.25, 0.5, 0.75]);
  });
});

describe('the frames', () => {
  const spec = studio.parseStudio(SCENE);
  it('draws a noised picture as its base with a share of noise, the same noise every time', () => {
    const start = studio.frameAt(spec, 0);
    const end = studio.frameAt(spec, 1);
    assert.equal(start.kind, 'grid');
    assert.deepEqual(end.grid, spec.show.base, 'no noise at the end');
    assert.notDeepEqual(start.grid, spec.show.base, 'all noise at the start');
    assert.deepEqual(studio.frameAt(spec, 0.3).grid, studio.frameAt(spec, 0.3).grid);
    assert.notDeepEqual(studio.frameAt(spec, 0.3, 2).grid, studio.frameAt(spec, 0.3, 1).grid, 'another seed is other noise');
    for (const row of start.grid) for (const v of row) assert.ok(v >= 0 && v <= 1);
  });
  it('tweens between the frames of a grid show, and spreads a short list over the slots', () => {
    const grid = studio.parseStudio('{"slots":["a","b","c","d","e"],"show":{"kind":"grid","frames":[[[0,0]],[[1,1]]]}}');
    assert.deepEqual(studio.frameAt(grid, 0).grid, [[0, 0]]);
    assert.deepEqual(studio.frameAt(grid, 1).grid, [[1, 1]]);
    assert.deepEqual(studio.frameAt(grid, 0.5).grid, [[0.5, 0.5]]);
    assert.deepEqual(studio.frameAtSlot(grid, 2).grid, [[0.5, 0.5]]);
  });
  it('tweens a density and its mark, and a row of bars', () => {
    const density = studio.parseStudio('{"slots":["a","b"],"show":{"kind":"density","mean":[0.2,0.6],"spread":[0.4,0.1],"mark":[0.3,0.5]}}');
    const half = studio.frameAt(density, 0.5);
    assert.equal(half.kind, 'density');
    assert.ok(Math.abs(half.mean - 0.4) < 1e-9);
    assert.ok(Math.abs(half.spread - 0.25) < 1e-9);
    assert.ok(Math.abs(half.mark - 0.4) < 1e-9);
    assert.ok(Math.abs(studio.bell(half, 0.4) - 1) < 1e-9, 'the bell peaks at the mean');
    const bars = studio.parseStudio('{"slots":["a","b"],"show":{"kind":"bars","values":[[1,0],[0,1,2]],"labels":["x","y","z"]}}');
    assert.deepEqual(studio.frameAt(bars, 0.5).values, [0.5, 0.5, 1]);
    assert.deepEqual(studio.frameAt(bars, 0.5).labels, ['x', 'y', 'z']);
  });
  it('reads the numbers off between the slots, and the words from the nearer one', () => {
    assert.deepEqual(studio.readoutsAt(spec, 0), [
      { label: 't', value: '1000' },
      { label: 'ᾱ_t', value: '0.002' },
      { label: 'what settles', value: 'tone' },
    ]);
    const mid = studio.readoutsAt(spec, 0.5);
    assert.equal(mid[0].value, '500');
    assert.equal(mid[1].value, '0.440');
    assert.equal(mid[2].value, 'shapes');
  });
});

describe('in a page', () => {
  it('is a block of its own, read once its fence closes', () => {
    const page = `## The walk\n\nProse.\n\n\`\`\`studio title="From noise to a picture"\n${SCENE}\n\`\`\`\n\nMore prose.`;
    const sections = explain.parseExplanation(page);
    const block = sections[0].blocks[1];
    assert.equal(block.kind, 'studio');
    assert.equal(block.title, 'From noise to a picture');
    assert.equal(block.spec.slots.length, 6);
    assert.equal(explain.studioOf(sections), block);
    const streaming = explain.parseExplanation(`## The walk\n\n\`\`\`studio title="Half"\n{"slots":["a","b"],`);
    assert.equal(streaming[0].blocks[0].kind, 'studio');
    assert.equal(streaming[0].blocks[0].open, true);
    assert.equal(streaming[0].blocks[0].spec, null);
    assert.equal(explain.studioOf(streaming), undefined, 'not until it is written');
  });
  it('is told to the model as what it is, and asked for in its own words', () => {
    const spec = studio.parseStudio(SCENE);
    assert.match(studio.studioText('From noise', spec), /the image x_t, one step at a time from t=1000 to t=0: Pick up the noise → /);
    assert.match(studio.studioText('From noise', null), /Studio scene: From noise/);
    assert.match(studio.studioRequest('Sampling'), /studio block.*“Sampling”/);
    assert.match(studio.STUDIO_FORMAT, /```studio title=/);
    assert.match(studio.STUDIO_FORMAT, /"kind":"noise"/);
    assert.match(studio.STUDIO_FORMAT, /"kind":"density"/);
  });
});
