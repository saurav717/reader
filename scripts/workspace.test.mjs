// The local workspace on the proxy (server/workspace.js): what it refuses to
// write, what it writes, what it leaves alone, and a command run in the
// project with its output streamed to a response.
//
//   node --test scripts/workspace.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

let root;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-workspace-'));
  process.env.READER_WORKSPACE = root;
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const workspace = await import('../server/workspace.js');

/** A response that collects what is written to it, and says when it ended. */
function fakeResponse() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableEnded = false;
  res.head = null;
  res.writeHead = (status, headers) => (res.head = { status, headers });
  res.write = (chunk) => res.chunks.push(String(chunk));
  res.ended = new Promise((resolve) => {
    res.end = () => {
      res.writableEnded = true;
      res.emit('close');
      resolve();
    };
  });
  return res;
}

describe('nvidia-smi', () => {
  it('reads a card a line', () => {
    assert.deepEqual(workspace.parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n'), [
      { name: 'NVIDIA GeForce RTX 4090', vramGb: 24 },
      { name: 'NVIDIA GeForce RTX 4090', vramGb: 24 },
    ]);
    assert.deepEqual(workspace.parseNvidiaSmi(''), []);
  });
});

describe('the workspace', () => {
  it('is on when READER_WORKSPACE names a directory', async () => {
    assert.equal(workspace.available(), true);
    assert.equal(workspace.root(), root);
    const status = await workspace.status();
    assert.equal(status.available, true);
    assert.equal(status.root, root);
    assert.ok(status.machine.ramGb > 0);
    assert.ok(Array.isArray(status.machine.gpus));
  });

  it('writes a project’s files under one folder, and nothing outside it', async () => {
    const result = await workspace.writeScaffold({
      slug: 'minitron',
      files: { 'src/a.py': 'print(1)\n', 'README.md': '# hi\n', '../escape.txt': 'no', '/etc/passwd': 'no', 'ok/../../up.txt': 'no' },
    });
    assert.equal(result.dir, join(root, 'minitron'));
    assert.deepEqual(result.written, ['src/a.py', 'README.md']);
    assert.deepEqual(result.refused, ['../escape.txt', '/etc/passwd', 'ok/../../up.txt']);
    assert.equal(await readFile(join(root, 'minitron', 'src', 'a.py'), 'utf8'), 'print(1)\n');
  });

  it('leaves a file the person changed alone, unless told to replace it', async () => {
    await writeFile(join(root, 'minitron', 'README.md'), '# mine\n');
    const kept = await workspace.writeScaffold({ slug: 'minitron', files: { 'README.md': '# hi\n', 'src/a.py': 'print(1)\n' } });
    assert.deepEqual(kept.skipped, ['README.md']);
    assert.deepEqual(kept.written, ['src/a.py'], 'an unchanged file is written again without fuss');
    assert.equal(await readFile(join(root, 'minitron', 'README.md'), 'utf8'), '# mine\n');
    const replaced = await workspace.writeScaffold({ slug: 'minitron', files: { 'README.md': '# hi\n' }, overwrite: true });
    assert.deepEqual(replaced.written, ['README.md']);
    assert.equal(await readFile(join(root, 'minitron', 'README.md'), 'utf8'), '# hi\n');
  });

  it('refuses a folder name that is a path', async () => {
    await assert.rejects(workspace.writeScaffold({ slug: '../x', files: {} }), /folder name/);
    await assert.rejects(workspace.writeScaffold({ slug: 'Fine Name', files: {} }), /folder name/);
  });

  it('lists the projects', async () => {
    const projects = await workspace.projects();
    assert.deepEqual(
      projects.map((p) => p.slug),
      ['minitron'],
    );
  });

  it('runs a command in the project and streams its output', async () => {
    const res = fakeResponse();
    const req = new EventEmitter();
    workspace.run({ slug: 'minitron', command: 'ls src && echo "$READER_PROJECT"' }, res, req);
    await res.ended;
    const text = res.chunks.join('');
    assert.equal(res.head.status, 200);
    assert.match(text, /^\$ ls src/);
    assert.match(text, /a\.py/);
    assert.ok(text.includes(join(root, 'minitron')), 'the project directory is in the environment');
    assert.match(text, /\[reader\] exit 0/);
  });

  it('stops the command when the response closes', async () => {
    const res = fakeResponse();
    const req = new EventEmitter();
    const child = workspace.run({ slug: 'minitron', command: 'sleep 30' }, res, req);
    await new Promise((resolve) => setTimeout(resolve, 150));
    req.emit('close');
    await res.ended;
    assert.ok(child.killed || child.exitCode !== null);
    assert.match(res.chunks.join(''), /stopped \(SIGTERM\)/);
  });

  it('refuses an empty command and an unknown project name', () => {
    const res = fakeResponse();
    assert.throws(() => workspace.run({ slug: 'minitron', command: '   ' }, res, new EventEmitter()), /no command/);
    assert.throws(() => workspace.run({ slug: '../x', command: 'ls' }, res, new EventEmitter()), /folder name/);
  });
});

describe('without READER_WORKSPACE', () => {
  it('is off, and says so', async () => {
    const saved = process.env.READER_WORKSPACE;
    process.env.READER_WORKSPACE = '';
    try {
      assert.equal(workspace.available(), false);
      const status = await workspace.status();
      assert.equal(status.available, false);
      assert.match(status.reason, /READER_WORKSPACE/);
      await assert.rejects(workspace.writeScaffold({ slug: 'x', files: {} }), /READER_WORKSPACE/);
    } finally {
      process.env.READER_WORKSPACE = saved;
    }
  });
});
