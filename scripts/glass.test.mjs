// The glass wallpapers: every one offered in Settings has a gradient in the
// stylesheet for both themes, and a rule that puts it behind the glass.
//
//   node --test scripts/glass.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanup, load } from './bundle.mjs';

const { GLASS_WALLS } = await load('src/types.ts');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

after(cleanup);

describe('glass wallpapers', () => {
  it('offers each one once, Spotlight first', () => {
    const ids = GLASS_WALLS.map((wall) => wall.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], 'spotlight');
  });

  for (const { id } of GLASS_WALLS) {
    it(`has ${id} in light and dark, and a rule to use it`, () => {
      const defined = css.match(new RegExp(`--wall-${id}:`, 'g')) || [];
      assert.equal(defined.length, 2, `--wall-${id} should be set once for light and once for dark`);
      assert.ok(css.includes(`[data-wall='${id}'] { --wall: var(--wall-${id}); }`));
    });
  }

  it('falls back to Spotlight when no wallpaper is set', () => {
    assert.ok(css.includes(":root[data-glass='on'] { --wall: var(--wall-spotlight); }"));
  });
});
