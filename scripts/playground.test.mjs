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
    [{ view: { kind: 'collection', id: 'c-1' } }, '/reader/collection/c-1'],
    [{ view: { kind: 'paper', id: 'arxiv:2010.08895' } }, '/reader/paper/arxiv%3A2010.08895'],
    [{ view: { kind: 'paper', id: 'doi:10.1145/3442188.3445922' } }, '/reader/paper/doi%3A10.1145%2F3442188.3445922'],
    [{ view: { kind: 'playground' } }, '/reader/playground'],
    [{ view: { kind: 'playground', id: 'a8c4d48f' } }, '/reader/playground/a8c4d48f'],
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
    assert.equal(route.pathFor({ view: { kind: 'playground', id: 'x' } }, '/'), '/playground/x');
    assert.deepEqual(route.placeFor('/paper/arxiv%3A1', '/').view, { kind: 'paper', id: 'arxiv:1' });
    assert.equal(route.basePath('reader'), '/reader/');
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
