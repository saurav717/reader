// Ask AI and the project on screen (src/lib/projectScreen.ts): which files go with a question, in what order, within the budget.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const lib = await load('src/lib/projectScreen.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
after(cleanup);

function host(files) {
  return {
    label: 'Laptop',
    list: async (path = '') => {
      const prefix = path ? `${path}/` : '';
      const names = new Map();
      for (const [p, body] of Object.entries(files)) {
        if (!p.startsWith(prefix)) continue;
        const [name, ...rest] = p.slice(prefix.length).split('/');
        names.set(name, rest.length ? { name, path: prefix + name, type: 'directory', size: null, modified: null } : { name, path: prefix + name, type: 'file', size: body.length, modified: null });
      }
      return [...names.values()];
    },
    read: async (p) => files[p] ?? null,
    write: async () => undefined,
  };
}

describe('the project on screen, for Ask AI', () => {
  it('sends the file in front as edited, the open tabs, then notes and entry points before the rest; never data or runs', async () => {
    const h = host({ 'README.md': '# about', 'main.py': 'print(1)', 'lib/util.py': 'x = 1', 'data/big.csv': '1,2', 'runs/a/events.jsonl': '{}', 'wm.py': 'saved text' });
    const read = await lib.readProjectFiles(h, [{ path: 'wm.py', text: 'edited text', unsaved: true }], 'wm.py');
    assert.deepEqual(read.active, { path: 'wm.py', text: 'edited text', unsaved: true });
    assert.deepEqual(read.files.map((f) => f.path), ['README.md', 'main.py', 'lib/util.py']);
    assert.ok(!read.listing.some((f) => f.path.startsWith('data/') || f.path.startsWith('runs/')));
  });
  it('stops at the budget and says how many were left', async () => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}.py`, 'x'.repeat(12_000)]));
    const read = await lib.readProjectFiles(host(files), [], undefined);
    const total = read.files.reduce((sum, f) => sum + f.text.length, 0);
    assert.ok(total <= lib.TOTAL_CHARS + 500, `read ${total}`);
    assert.ok(read.left > 0);
    assert.equal(read.files.length + read.left, 20);
  });
  it('is nothing when no workspace offers a project', async () => {
    lib.offerProject(null);
    assert.equal(await lib.projectOnScreen(), null);
    lib.offerProject(async () => ({ title: 'P', kind: 'a playground project', where: '', open: [], files: [], listing: [], left: 0 }));
    assert.equal((await lib.projectOnScreen()).title, 'P');
    lib.offerProject(null);
  });
});
