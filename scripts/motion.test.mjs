// A scene, without a browser: how a motion block's JSON is read, laid out,
// and resolved at a step — and how a paragraph picks a step.
//
//   node --test scripts/motion.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const motion = await load('src/lib/motion.ts');
after(cleanup);

const SCENE = `{"nodes":[{"id":"x","kind":"input","label":"x","at":[50,92]},
  {"id":"teacher","kind":"stack","label":"teacher","layers":6,"at":[28,52],"frozen":true,"tone":"blue"},
  {"id":"student","kind":"stack","label":"student","layers":3,"at":[72,58]},
  {"id":"p","kind":"dist","label":"softmax(z_T / T)","at":[28,12],"values":[0.7,0.2,0.1],"labels":["cat","dog","car"]},
  {"id":"q","kind":"dist","label":"softmax(z_S / T)","at":[72,20],"values":[0.4,0.3,0.3],"labels":["cat","dog","car"]},
  {"id":"T","kind":"slider","label":"T","min":1,"max":20,"values":1}],
 "edges":[{"from":"x","to":"teacher","flow":"forward"},{"from":"x","to":"student","flow":"forward"},
  {"id":"kl","from":"p","to":"q","kind":"compare","label":"T²·KL","step":1},
  {"id":"back","from":"q","to":"student","flow":"backward","step":2}],
 "steps":[{"caption":"The same batch runs through both networks."},
  {"caption":"Only the two softened outputs are compared.","highlight":["p","q"],"set":{"T":4}},
  {"caption":"Gradients reach the student only.","dim":["teacher"],"set":{"q.values":[0.65,0.22,0.13],"p.label":"teacher, frozen"}}]}`;

describe('reading a scene', () => {
  const spec = motion.parseMotion(SCENE);
  it('reads the nodes, edges and steps', () => {
    assert.equal(spec.nodes.length, 6);
    assert.equal(spec.edges.length, 4);
    assert.equal(spec.steps.length, 3);
    assert.equal(spec.nodes[1].layers, 6);
    assert.equal(spec.nodes[1].frozen, true);
    assert.deepEqual(spec.nodes[3].values, [0.7, 0.2, 0.1]);
  });
  it('forgives a trailing comma, a comment and a fence left in', () => {
    const forgiven = motion.parseMotion('```motion\n// the scene\n{"nodes":[{"id":"a","kind":"box","label":"A",},],"steps":[{"caption":"one",}]}\n```');
    assert.equal(forgiven.nodes[0].label, 'A');
    assert.equal(forgiven.steps[0].caption, 'one');
  });
  it('is null while the JSON is half streamed, or not JSON', () => {
    assert.equal(motion.parseMotion('{"nodes":[{"id":"a","kind":"bo'), null);
    assert.equal(motion.parseMotion('<svg></svg>'), null);
    assert.equal(motion.parseMotion('{"nodes":[]}'), null);
  });
  it('drops what it cannot draw: an unknown kind becomes a box, an edge to nowhere goes, a duplicate id goes', () => {
    const spec = motion.parseMotion('{"nodes":[{"id":"a","kind":"blob"},{"id":"a","kind":"box"},{"id":"b","kind":"text","label":"b"}],"edges":[{"from":"a","to":"zz"},{"from":"a","to":"b"}],"steps":[]}');
    assert.equal(spec.nodes.length, 2);
    assert.equal(spec.nodes[0].kind, 'box');
    assert.equal(spec.edges.length, 1);
    assert.equal(spec.steps.length, 1);
  });
});

describe('laying it out', () => {
  const spec = motion.parseMotion(SCENE);
  const boxes = motion.layoutMotion(spec);
  it('places every node inside the scene', () => {
    for (const node of spec.nodes) {
      const box = boxes.get(node.id);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= motion.SCENE_W && box.y + box.h <= motion.SCENE_H, node.id);
    }
  });
  it('sizes a stack by its layers', () => {
    assert.ok(boxes.get('teacher').h > boxes.get('student').h);
  });
  it('spreads nodes with no place of their own along the middle', () => {
    const loose = motion.parseMotion('{"nodes":[{"id":"a","kind":"box"},{"id":"b","kind":"box"},{"id":"c","kind":"box"}],"steps":[]}');
    const placed = motion.layoutMotion(loose);
    assert.ok(placed.get('a').x < placed.get('b').x && placed.get('b').x < placed.get('c').x);
  });
  it('joins boxes side to side or top to bottom, whichever is nearer', () => {
    const a = { x: 0, y: 0, w: 50, h: 20 }, b = { x: 200, y: 5, w: 50, h: 20 };
    const side = motion.anchors(a, b);
    assert.equal(side.x1, 50);
    assert.equal(side.x2, 200);
    const below = motion.anchors(a, { x: 0, y: 100, w: 50, h: 20 });
    assert.equal(below.y1, 20);
    assert.equal(below.y2, 100);
  });
});

describe('the state at a step', () => {
  const spec = motion.parseMotion(SCENE);
  it('shows an edge from its step on', () => {
    assert.equal(motion.stateAt(spec, 0).visible.has('kl'), false);
    assert.equal(motion.stateAt(spec, 1).visible.has('kl'), true);
    assert.equal(motion.stateAt(spec, 2).visible.has('back'), true);
  });
  it('carries a set value forward and tweens between steps', () => {
    assert.deepEqual(motion.stateAt(spec, 1).values.get('q'), [0.4, 0.3, 0.3]);
    assert.deepEqual(motion.stateAt(spec, 2).values.get('q'), [0.65, 0.22, 0.13]);
    assert.equal(motion.stateAt(spec, 2).values.get('T'), 4);
    assert.equal(motion.stateAt(spec, 2).labels.get('p'), 'teacher, frozen');
    const half = motion.mix([0.4, 0.3, 0.3], [0.6, 0.3, 0.1], 0.5);
    assert.deepEqual(half.map((v) => Math.round(v * 100) / 100), [0.5, 0.3, 0.2]);
    assert.equal(motion.mix(1, 3, 0.25), 1.5);
  });
  it('highlights and dims what the step names', () => {
    assert.ok(motion.stateAt(spec, 1).highlight.has('p'));
    assert.ok(motion.stateAt(spec, 2).dim.has('teacher'));
    assert.equal(motion.stateAt(spec, 2).highlight.size, 0);
  });
});

describe('the paragraph picks the step', () => {
  const spec = motion.parseMotion(SCENE);
  it('in order, spread over the section, the last paragraph reaching the last step', () => {
    assert.deepEqual([0, 1, 2].map((p) => motion.stepForParagraph(spec, p, 3)), [0, 1, 2]);
    assert.deepEqual([0, 1, 2, 3, 4].map((p) => motion.stepForParagraph(spec, p, 5)), [0, 0, 1, 1, 2]);
    assert.deepEqual([0, 1].map((p) => motion.stepForParagraph(spec, p, 2)), [0, 2]);
  });
  it('by name when the steps say which paragraph is theirs', () => {
    const named = motion.parseMotion('{"nodes":[{"id":"a","kind":"box"}],"steps":[{"caption":"a","paragraph":0},{"caption":"b","paragraph":3},{"caption":"c","paragraph":5}]}');
    assert.deepEqual([0, 2, 3, 4, 5, 9].map((p) => motion.stepForParagraph(named, p, 10)), [0, 0, 1, 1, 2, 2]);
  });
});

describe('the scene as words', () => {
  it('is its title and its captions', () => {
    const spec = motion.parseMotion(SCENE);
    assert.match(motion.motionText('The loss', spec), /^\[Scene: The loss\]\n1\. The same batch/);
    assert.equal(motion.motionText('', null), '[Scene]');
  });
  it('tells the model the block, the kinds and the rules', () => {
    assert.match(motion.MOTION_FORMAT, /```motion title=/);
    assert.match(motion.MOTION_FORMAT, /Node kinds: box, input, text, stack/);
    assert.match(motion.MOTION_FORMAT, /Each step is one paragraph of the section/);
  });
});
