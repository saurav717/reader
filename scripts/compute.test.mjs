// Turning compute on and off: which places to run are on, the list kept in
// Settings, and where the controls show for each choice.
//
//   node --test scripts/compute.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const c = await load('src/lib/compute.ts');

after(cleanup);

describe('on and off', () => {
  it('is on unless turned off, whatever Settings came back as', () => {
    assert.equal(c.isOn({ computeOff: [] }, 'colab'), true);
    assert.equal(c.isOn({ computeOff: ['colab'] }, 'colab'), false);
    assert.equal(c.isOn({ computeOff: undefined }, 'colab'), true);
    assert.equal(c.isOn({ computeOff: 'colab' }, 'x'), true);
  });

  it('turns a place on and off without doubling it', () => {
    assert.deepEqual(c.switched([], 'colab', false), ['colab']);
    assert.deepEqual(c.switched(['colab'], 'colab', false), ['colab']);
    assert.deepEqual(c.switched(['colab', 'mac'], 'colab', true), ['mac']);
    assert.deepEqual(c.switched(undefined, 'mac', true), []);
  });

  it('knows a server by its Companion, and keeps the one a playground is on', () => {
    const servers = [{ id: 's1', companionId: 'mac' }, { id: 's2' }, { id: 's3', companionId: 'pc' }];
    assert.equal(c.computeId(servers[0]), 'mac');
    assert.equal(c.computeId(servers[1]), 's2');
    assert.deepEqual(c.serversOn({ computeOff: ['mac', 's2'] }, servers).map((s) => s.id), ['s3']);
    assert.deepEqual(c.serversOn({ computeOff: ['mac', 's2'] }, servers, 's1').map((s) => s.id), ['s1', 's3']);
  });
});

describe('where the controls show', () => {
  it('is everywhere by default, and as chosen otherwise', () => {
    const at = (computeControls) => [c.switchesOnCards({ computeControls }), c.chipInRail({ computeControls })];
    assert.deepEqual(at('everywhere'), [true, true]);
    assert.deepEqual(at('settings'), [false, false]);
    assert.deepEqual(at('cards'), [true, false]);
    assert.deepEqual(at('rail'), [false, true]);
    assert.deepEqual(at('nonsense'), [true, true]);
  });
});
