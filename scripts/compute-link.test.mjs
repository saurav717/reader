// The compute link (src/lib/computeLink.ts): what the page hands the Companion on the files' computer, when it
// renews Colab's pass, and the lines it types into the shell there.
//
//   node --test scripts/compute-link.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { cleanup, load } from './bundle.mjs';

const link = await load('src/lib/computeLink.ts');
after(cleanup);

const laptop = { id: 's1', name: 'Saurav’s MacBook Air', url: 'https://laptop.example', token: 'tok', where: 'pc' };

describe('the compute link', () => {
  it('makes a target of Colab’s runtime and of a server, with the folder and the ignore rules', () => {
    const colab = link.colabTarget({ url: 'https://8080-x.colab.dev/', token: 'p', expiresAt: 99 }, 'Colab · T4', 'playgrounds/p1', 'data/');
    assert.deepEqual(colab, { kind: 'colab', url: 'https://8080-x.colab.dev/', token: 'p', expiresAt: 99, label: 'Colab · T4', folder: 'playgrounds/p1', ignore: 'data/' });
    const server = link.serverTarget({ ...laptop, name: 'Lab GPU box', url: 'https://gpu.example/', token: 'g' }, 'playgrounds/p1', '');
    assert.equal(server.kind, 'jupyter');
    assert.equal(server.expiresAt, 0);
    assert.equal(server.label, 'Lab GPU box');
  });

  it('renews Colab’s pass ten minutes before it runs out, never a server’s', () => {
    const now = 1_000_000_000;
    assert.equal(link.renewAt({ kind: 'colab', expiresAt: now + 60 * 60_000 }, now), now + 50 * 60_000);
    assert.equal(link.renewAt({ kind: 'colab', expiresAt: now + 60_000 }, now), now + 30_000);
    assert.equal(link.renewAt({ kind: 'jupyter', expiresAt: 0 }, now), null);
  });

  it('types a command so the shell there runs it on the compute exactly as written', () => {
    const line = link.remoteLine(`python train.py --name 'run 1' | tee log.txt`);
    assert.equal(line, `koios run --no-push -c 'python train.py --name '\\''run 1'\\'' | tee log.txt'`);
    // What a shell makes of it: the whole line, one argument.
    const echoed = spawnSync('bash', ['-c', line.replace('koios run --no-push -c', 'printf %s')], { encoding: 'utf8' });
    assert.equal(echoed.stdout, `python train.py --name 'run 1' | tee log.txt`);
    assert.equal(link.COMPUTE_SHELL, 'koios shell; exit');
  });

  it('hands the link to the Companion with its token, and says null when the Companion is older', async () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response(JSON.stringify({ linked: true, label: 'Colab · T4' }), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    try {
      const target = link.colabTarget({ url: 'https://c/', token: 'p', expiresAt: 1 }, 'Colab · T4', 'playgrounds/p1', '');
      assert.deepEqual(await link.linkCompute(laptop, 'playgrounds/p1', target), { linked: true, label: 'Colab · T4' });
      assert.equal(calls[0].url, 'https://laptop.example/companion/compute');
      assert.equal(calls[0].init.headers.Authorization, 'token tok');
      assert.deepEqual(JSON.parse(calls[0].init.body), { root: 'playgrounds/p1', compute: target });
      assert.equal(await link.linkCompute(laptop, 'playgrounds/p1', null), null);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('says what went wrong when the Companion couldn’t push', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Colab · T4 is gone' }), { status: 502 });
    try {
      await assert.rejects(link.pushThroughCompanion(laptop, 'playgrounds/p1'), /Colab · T4 is gone/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('the mount (Companion 0.19.0)', () => {
  it('asks the Companion to mount the folder, to stop, and whether a machine has it now', async () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (String(url).includes('?root=')) return new Response(JSON.stringify({ linked: true, mount: { on: true, mode: 'fuse', connected: 1 } }), { status: 200 });
      const body = JSON.parse(init.body);
      if (body.action === 'mount') return new Response(JSON.stringify({ mode: 'fuse', at: '/content/playgrounds/p1', mounted: true, connected: 1, warm: { files: 42, bytes: 9000, seconds: 0.4 } }), { status: 200 });
      return new Response(JSON.stringify({ stopped: true }), { status: 200 });
    };
    try {
      const status = await link.mountThroughCompanion(laptop, 'playgrounds/p1');
      assert.equal(status.mode, 'fuse');
      assert.deepEqual(JSON.parse(calls[0].init.body), { root: 'playgrounds/p1', action: 'mount', mode: 'auto' });
      assert.equal(calls[0].init.headers.Authorization, 'token tok');
      assert.equal(link.mountWords(status, 'Colab · T4'), 'The folder is mounted on Colab · T4 · 42 small files sent ahead in 0.4 s: nothing is copied before a run.');
      assert.deepEqual(await link.unmountThroughCompanion(laptop, 'playgrounds/p1'), { stopped: true });
      assert.deepEqual(JSON.parse(calls[1].init.body), { root: 'playgrounds/p1', action: 'unmount' });
      const state = await link.linkState(laptop, 'playgrounds/p1');
      assert.deepEqual(state.mount, { on: true, mode: 'fuse', connected: 1 });
      assert.equal(calls[2].url, 'https://laptop.example/companion/compute?root=playgrounds%2Fp1');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('says a mirror is a mirror and why, and that an older Companion needs updating', async () => {
    assert.match(link.mountWords({ mode: 'mirror', why: 'this machine has no /dev/fuse' }, 'Lab GPU box'), /mirrored live \(this machine has no \/dev\/fuse\) on Lab GPU box/);
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'compute, or action' }), { status: 400 });
    try {
      await assert.rejects(link.mountThroughCompanion(laptop, 'playgrounds/p1'), /needs Koios Companion 0\.19\.0/);
    } finally {
      globalThis.fetch = real;
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'The mount didn’t start on Colab · T4: fusepy isn’t installed' }), { status: 502 });
    try {
      await assert.rejects(link.mountThroughCompanion(laptop, 'playgrounds/p1'), /fusepy isn’t installed/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
