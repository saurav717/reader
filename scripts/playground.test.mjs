// The Playground and the page's addresses, without a browser: which path a
// page has and which page a path names, under the app's base; and the
// Playground's own reading — a Jupyter server's address, a repository's, a
// Hugging Face id — its sync rules, its shell cells, and a sync between two
// stand-in hosts.
//
//   node --test scripts/playground.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const route = await load('src/lib/route.ts');
const pg = await load('src/lib/playground.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });

after(cleanup);

describe('the addresses', () => {
  const cases = [
    [{ view: { kind: 'home' } }, '/reader/'],
    [{ view: { kind: 'all' } }, '/reader/library'],
    [{ view: { kind: 'reading' } }, '/reader/reading'],
    [{ view: { kind: 'junk' } }, '/reader/junk'],
    [{ view: { kind: 'collection', id: 'c-1' } }, '/reader/collection/?id=c-1'],
    [{ view: { kind: 'paper', id: 'arxiv:2010.08895' } }, '/reader/paper/?id=arxiv%3A2010.08895'],
    [{ view: { kind: 'paper', id: 'doi:10.1145/3442188.3445922' } }, '/reader/paper/?id=doi%3A10.1145%2F3442188.3445922'],
    [{ view: { kind: 'playground' } }, '/reader/playground'],
    [{ view: { kind: 'playground', id: 'a8c4d48f' } }, '/reader/playground/?id=a8c4d48f'],
    [{ view: { kind: 'home' }, usage: true }, '/reader/usage'],
  ];
  for (const [place, path] of cases) {
    it(`${JSON.stringify(place)} is ${path}, and back`, () => {
      assert.equal(route.pathFor(place, '/reader/'), path);
      const back = route.placeFor(path, '/reader/');
      assert.deepEqual(back.view, place.view);
      assert.equal(Boolean(back.usage), Boolean(place.usage));
    });
  }
  it('takes the base with or without its slash, a trailing slash and index.html', () => {
    assert.deepEqual(route.placeFor('/reader', '/reader/').view, { kind: 'home' });
    assert.deepEqual(route.placeFor('/reader/playground/', '/reader/').view, { kind: 'playground' });
    assert.deepEqual(route.placeFor('/reader/playground/index.html', '/reader/').view, { kind: 'playground' });
    assert.deepEqual(route.placeFor('/reader/index.html', '/reader/').view, { kind: 'home' });
  });
  it('knows nothing outside its base, or a path it does not name', () => {
    assert.equal(route.placeFor('/publications/', '/reader/'), null);
    assert.equal(route.placeFor('/reader/nowhere', '/reader/'), null);
    assert.equal(route.placeFor('/reader/paper', '/reader/'), null);
    assert.equal(route.placeFor('/reader/library/extra', '/reader/'), null);
  });
  it('works at the root too, as in dev', () => {
    assert.equal(route.pathFor({ view: { kind: 'playground', id: 'x' } }, '/'), '/playground/?id=x');
    assert.deepEqual(route.placeFor('/paper/arxiv%3A1', '/').view, { kind: 'paper', id: 'arxiv:1' });
    assert.equal(route.basePath('reader'), '/reader/');
  });
  it('still reads an id in the path, for links made before it moved to the query', () => {
    assert.deepEqual(route.placeFor('/reader/playground/a8c4d48f', '/reader/').view, { kind: 'playground', id: 'a8c4d48f' });
    assert.deepEqual(route.placeFor('/reader/paper/arxiv%3A1', '/reader/').view, { kind: 'paper', id: 'arxiv:1' });
  });
  it('reads ?id= only where a page has one, and keeps the rest of a query', () => {
    assert.deepEqual(route.placeFor('/reader/library?id=x', '/reader/').view, { kind: 'all' });
    assert.equal(route.placeFor('/reader/paper/?code=1', '/reader/'), null);
    assert.equal(route.addressWith('/reader/playground/?id=a', '?code=1&id=b'), '/reader/playground/?code=1&id=a');
    assert.equal(route.addressWith('/reader/library', '?id=b'), '/reader/library');
  });
});

describe('a Jupyter server’s address', () => {
  it('lifts the token out of the address Jupyter prints', () => {
    assert.deepEqual(pg.parseServerUrl('http://localhost:8888/tree?token=abc123'), { url: 'http://localhost:8888/', token: 'abc123' });
    assert.deepEqual(pg.parseServerUrl('http://127.0.0.1:8888/lab?token=t'), { url: 'http://127.0.0.1:8888/', token: 't' });
  });
  it('keeps a base path, and takes a bare host', () => {
    assert.deepEqual(pg.parseServerUrl('https://abc-8888.proxy.runpod.net/jupyter/?token=x'), { url: 'https://abc-8888.proxy.runpod.net/jupyter/', token: 'x' });
    assert.deepEqual(pg.parseServerUrl('localhost:8890'), { url: 'http://localhost:8890/', token: undefined });
  });
  it('refuses what is not http(s)', () => {
    assert.equal(pg.parseServerUrl('ftp://example.com'), null);
    assert.equal(pg.parseServerUrl(''), null);
  });
});

describe('the starts', () => {
  it('reads a repository from a link or owner/name', () => {
    assert.equal(pg.repoUrlOf('https://github.com/karpathy/nanoGPT/tree/master'), 'https://github.com/karpathy/nanoGPT.git');
    assert.equal(pg.repoUrlOf('karpathy/nanoGPT'), 'https://github.com/karpathy/nanoGPT.git');
    assert.equal(pg.repoUrlOf('http://github.com/a/b'), null);
    assert.equal(pg.repoNameOf('https://github.com/karpathy/nanoGPT.git'), 'nanoGPT');
  });
  it('reads a Hugging Face id from a link or as typed', () => {
    assert.equal(pg.modelIdOf('https://huggingface.co/meta-llama/Llama-3.2-1B/tree/main'), 'meta-llama/Llama-3.2-1B');
    assert.equal(pg.modelIdOf('datasets/stanfordnlp/imdb'), 'datasets/stanfordnlp/imdb');
    assert.equal(pg.modelIdOf('gpt2'), null);
  });
  it('writes a model card’s cells that load it on the GPU when there is one', () => {
    const cells = pg.modelCells('Qwen/Qwen2.5-0.5B');
    assert.equal(cells[0].type, 'markdown');
    assert.ok(cells.some((cell) => cell.source.includes('pipeline(model="Qwen/Qwen2.5-0.5B"')));
    assert.ok(pg.modelCells('datasets/stanfordnlp/imdb').some((cell) => cell.source.includes('load_dataset("stanfordnlp/imdb")')));
  });
  it('names a folder from a title', () => {
    assert.equal(pg.slugOf('LoRA rank sweep on Llama-3.2!'), 'lora-rank-sweep-on-llama-32');
    assert.equal(pg.slugOf('!!!'), 'playground');
  });
});

describe('the sync rules', () => {
  const yes = (rule, path) => assert.ok(pg.matchesRule(rule, path), `${rule} should match ${path}`);
  const no = (rule, path) => assert.ok(!pg.matchesRule(rule, path), `${rule} should not match ${path}`);
  it('a folder rule matches the folder anywhere, and what is in it', () => {
    yes('data/', 'data');
    yes('data/', 'data/train.bin');
    yes('__pycache__/', 'src/__pycache__/x.pyc');
    no('data/', 'metadata.py');
  });
  it('a star stays within a name; ** crosses folders; / anchors', () => {
    yes('*.ckpt', 'ckpt/step-100.ckpt');
    no('*.ckpt', 'model.ckpt.py');
    yes('runs/**/events*', 'runs/a/b/events.out');
    yes('/README.md', 'README.md');
    no('/README.md', 'docs/README.md');
  });
  it('ignores comments and blank lines', () => {
    assert.equal(pg.matchesAny('# a comment\n\n', 'anything'), false);
  });
});

describe('the console', () => {
  it('runs a command in a bash cell, in the folder, quoting it', () => {
    assert.equal(pg.shellCell("/root/pg/it's", 'python main.py'), "%%bash\nmkdir -p '/root/pg/it'\\''s' && cd '/root/pg/it'\\''s' || exit 1\npython main.py");
  });
});

describe('a file for the kernel', () => {
  it('is base64 a slice at a time, so a 2 MB file does not overflow the stack', () => {
    const bytes = new Uint8Array(2_000_000).map((_, i) => i % 251);
    const encoded = pg.base64Of(bytes);
    assert.equal(Buffer.from(encoded, 'base64').equals(Buffer.from(bytes)), true);
  });
});

describe('a sync between two hosts', () => {
  const memory = (files) => ({
    label: 'memory',
    files,
    async list(path = '') {
      const prefix = path ? `${path}/` : '';
      const seen = new Map();
      for (const [name, text] of Object.entries(files)) {
        if (!name.startsWith(prefix)) continue;
        const [head, ...rest] = name.slice(prefix.length).split('/');
        seen.set(head, rest.length ? { name: head, path: prefix + head, type: 'directory', size: null, modified: null } : { name: head, path: name, type: 'file', size: text.length, modified: null });
      }
      return [...seen.values()];
    },
    async read(path) {
      return files[path] ?? null;
    },
    async write(path, text) {
      files[path] = text;
    },
  });
  it('walks a host, skipping what the rules leave out', async () => {
    const host = memory({ 'main.py': 'x', 'data/big.bin': 'y', 'src/a.py': 'z', 'src/__pycache__/a.pyc': 'w' });
    const found = await pg.walk(host, (path) => pg.matchesAny(pg.DEFAULT_IGNORE, path));
    assert.deepEqual(found.map((f) => f.path).sort(), ['main.py', 'src/a.py']);
  });
});

describe('a playground names its computer by its Companion', () => {
  it('takes the computer’s id, and follows it to another entry for the same computer', async () => {
    const first = pg.saveServer({ name: 'Mac', where: 'pc', url: 'http://127.0.0.1:47321/', token: 't', companionId: 'mac123' });
    const made = await pg.createPlayground({ title: 'Rebind', kind: 'project', compute: { kind: 'server', serverId: first.id }, home: { kind: 'server', serverId: first.id, root: 'playgrounds/rebind' }, start: 'blank' });
    assert.equal(made.compute.deviceId, 'mac123');
    assert.equal(made.home.deviceId, 'mac123');
    // Another browser's list: the same computer under another id (the account's list, synced).
    pg.removeServer(first.id);
    const second = pg.saveServer({ name: 'Mac', where: 'remote', url: 'https://x.trycloudflare.com/', token: 't2', companionId: 'mac123' });
    const now = pg.playgroundById(made.id);
    assert.equal(now.compute.serverId, second.id);
    assert.equal(now.home.serverId, second.id);
    assert.equal(now.home.root, 'playgrounds/rebind');
  });

  it('opens its notebook from the cells its record carries, in a browser that has none', async () => {
    const made = await pg.createPlayground({ title: 'Cells', kind: 'notebook', compute: { kind: 'colab', machine: { accelerator: 'NONE' } }, home: { kind: 'browser' }, start: 'blank' });
    pg.updatePlayground(made.id, { cells: [{ type: 'markdown', source: '# Hi' }, { type: 'code', source: 'print(1)' }] });
    const seed = pg.takeSeed(made.id);
    assert.deepEqual(seed.map((cell) => [cell.type, cell.source]), [['markdown', '# Hi'], ['code', 'print(1)']]);
  });
});

describe('where a playground’s code is, and what opening it takes', () => {
  const names = { pc: 'Saurav’s MacBook Air', gpu: 'GPU box' };
  const ctx = (extra = {}) => ({ serverName: (id) => names[id], down: () => false, browserHasFiles: true, ...extra });
  const onPc = { kind: 'server', serverId: 'pc', root: 'playgrounds/cifar', deviceId: 'd-pc' };
  const colab = { kind: 'colab', machine: {} };
  it('names the computer with the code, where it last ran, and that it needs that computer', () => {
    const at = pg.reachOf({ kind: 'project', home: onPc, compute: { kind: 'server', serverId: 'pc', deviceId: 'd-pc' } }, ctx());
    assert.equal(at.code, 'Saurav’s MacBook Air · playgrounds/cifar');
    assert.match(at.ran, /^Saurav’s MacBook Air, where its code is — or any machine of yours can run it/);
    assert.match(at.needs, /^Saurav’s MacBook Air specifically/);
    assert.equal(at.blocked, undefined);
    assert.match(pg.reachOf({ kind: 'project', home: onPc, compute: { kind: 'server', serverId: 'gpu' } }, ctx()).ran, /^GPU box, with the folder copied there/);
  });
  it('names a computer this browser has never seen by the name its record carries, and says how to reach it', () => {
    const away = { ...onPc, serverId: 'other-browser-id', name: 'Saurav’s MacBook Air' };
    const at = pg.reachOf({ kind: 'project', home: away, compute: { kind: 'server', serverId: 'other-browser-id', name: 'Saurav’s MacBook Air', deviceId: 'd-pc' } }, ctx());
    assert.equal(at.code, 'Saurav’s MacBook Air · playgrounds/cifar');
    assert.match(at.blocked, /Its code is on Saurav’s MacBook Air, which isn’t connected to this browser\. Connect Saurav’s MacBook Air here/);
    assert.match(at.blocked, /any machine can run it/);
  });
  it('says which browser holds files kept in a browser, and opens a notebook anywhere', () => {
    const kept = pg.reachOf({ kind: 'project', home: { kind: 'browser', browser: 'Chrome on a Mac' }, compute: colab }, ctx({ browserHasFiles: false }));
    assert.equal(kept.code, 'Chrome on a Mac');
    assert.match(kept.blocked, /kept in Chrome on a Mac, not in this one/);
    assert.equal(pg.reachOf({ kind: 'notebook', home: { kind: 'browser' }, compute: colab }, ctx({ browserHasFiles: false })).blocked, undefined);
  });
  it('warns, without blocking, when the computer with its code is off', () => {
    const at = pg.reachOf({ kind: 'project', home: onPc, compute: { kind: 'server', serverId: 'pc' } }, ctx({ down: () => true }));
    assert.equal(at.blocked, undefined);
    assert.match(at.warn, /isn’t answering now/);
  });
  it('labels a browser in a few words', () => {
    assert.equal(pg.browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'), 'Safari on a Mac');
    assert.equal(pg.browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0'), 'Edge on Windows');
    assert.equal(pg.browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'), 'Chrome on a Mac');
  });
});
