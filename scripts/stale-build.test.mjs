// A page left open across a publish: the pieces of its build that are gone are told apart from other failures.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const lib = await load('src/lib/staleBuild.ts');
after(cleanup);

describe('a stale build', () => {
  it('is Safari’s, Chrome’s and Firefox’s word for a piece of the old build that is gone', () => {
    assert.equal(lib.isStaleBuild(new TypeError('Importing a module script failed.')), true);
    assert.equal(lib.isStaleBuild(new TypeError('Failed to fetch dynamically imported module: https://koios.dev/assets/Terminal-abc.js')), true);
    assert.equal(lib.isStaleBuild(new TypeError('error loading dynamically imported module')), true);
    assert.equal(lib.isStaleBuild({ message: 'Unable to preload CSS for /assets/x.css' }), true);
  });
  it('and nothing else', () => {
    assert.equal(lib.isStaleBuild(new Error('The shell ended')), false);
    assert.equal(lib.isStaleBuild('Colab answered 503'), false);
    assert.equal(lib.isStaleBuild(undefined), false);
  });
});
