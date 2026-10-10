// Running playgrounds, without a browser: the last line a run printed (as a
// terminal shows it, tqdm's carriage returns and all), how far a line says it
// has got, whose run a key is, and the words a state is shown with.
//
//   node --test scripts/playground-runs.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const runs = await load('src/lib/playgroundRuns.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });

after(cleanup);

describe('the last line', () => {
  const stream = (text, name = 'stdout') => ({ type: 'stream', name, text });
  it('is the last line printed, trimmed', () => {
    assert.equal(runs.tailOf([stream('step 1\nstep 2\n\n')]), 'step 2');
  });
  it('is what a carriage return left, as a progress bar draws it', () => {
    assert.equal(runs.tailOf([stream(' 10%|█         | 1/10\r 50%|█████     | 5/10\r')]), '50%|█████     | 5/10');
  });
  it('drops colour codes', () => {
    assert.equal(runs.tailOf([stream('\u001b[32mok\u001b[0m\n')]), 'ok');
  });
  it('is the error, when it ended on one', () => {
    assert.equal(runs.tailOf([stream('step 1\n'), { type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: '' }]), 'ZeroDivisionError: division by zero');
  });
  it('skips images, and is nothing when nothing was printed', () => {
    assert.equal(runs.tailOf([stream('loss 0.3\n'), { type: 'image', mime: 'image/png', data: 'x' }]), 'loss 0.3');
    assert.equal(runs.tailOf([]), undefined);
  });
});

describe('how far a line says it has got', () => {
  const cases = [
    ['epoch 6 | step 1840/3000 | loss 0.41', 1840 / 3000],
    [' 42%|████▏     | 42/100 [00:04<00:05]', 0.42],
    ['step 3/14 loss=0.333', 3 / 14],
    ['loss 0.4127', null],
    ['ratio 5/1', null],
    ['done 12/10', null],
    [undefined, null],
  ];
  for (const [line, expected] of cases) {
    it(`${JSON.stringify(line)} → ${expected}`, () => {
      const got = runs.progressIn(line);
      if (expected === null) assert.equal(got, null);
      else assert.ok(Math.abs(got - expected) < 1e-9, `${got}`);
    });
  }
});

describe('whose run it is', () => {
  const list = [{ id: 'aaaa1111' }, { id: 'bbbb2222' }];
  const cells = { aaaa1111: [{ id: 'c1' }, { id: 'c2' }], bbbb2222: [{ id: 'c3' }] };
  it('a console command says so in its key', () => {
    assert.equal(runs.ownerOf('pgsh:bbbb2222:e1', list, () => undefined), 'bbbb2222');
  });
  it('a notebook cell is found in the notebooks', () => {
    assert.equal(runs.ownerOf('nb:c3', list, (id) => cells[id]), 'bbbb2222');
    assert.equal(runs.ownerOf('nb:c1', list, (id) => cells[id]), 'aaaa1111');
  });
  it('a paper page’s cell, or one in no notebook, is nobody’s', () => {
    assert.equal(runs.ownerOf('c9f3a2', list, (id) => cells[id]), undefined);
    assert.equal(runs.ownerOf('nb:nowhere', list, (id) => cells[id]), undefined);
  });
});

describe('the words', () => {
  const base = { id: 'x', title: 'X', kind: 'notebook', where: 'This PC' };
  it('idle says the variables are still there, and how the last run ended', () => {
    assert.equal(runs.phaseLabel({ ...base, phase: 'idle' }), 'Idle · variables kept');
    assert.equal(runs.phaseNote({ ...base, phase: 'idle', detail: '3 cells ran', last: 'ran' }), '3 cells ran · its variables are still in the kernel');
    assert.match(runs.phaseNote({ ...base, where: 'Colab · T4', phase: 'idle' }), /uses units/);
  });
  it('a failure is its error', () => {
    assert.equal(runs.phaseNote({ ...base, phase: 'failed', detail: 'ValueError: no' }), 'ValueError: no');
  });
  it('the clock and the time since', () => {
    assert.equal(runs.clock(12_000), '12 s');
    assert.equal(runs.clock(38 * 60_000), '38 min');
    assert.equal(runs.clock(64 * 60_000), '1 h 4 min');
    assert.equal(runs.ago(1_000_000 - 30_000, 1_000_000), 'just now');
    assert.equal(runs.ago(0, 3 * 3600_000), '3 h ago');
  });
});
