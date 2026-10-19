// A project's files moved by the machines at each end (worker/moves.js, docs/storage-moves.md): that a move is
// started by the page with its pass and nobody else's; that parts go into R2 as one multipart upload, put together
// when the source says it is packed, and read back whole or from a Range; that the machines answer with the move's
// key and a second machine on the same step is told to stop; that a computer with the Companion is told to unpack
// by the Worker itself; that the archive goes once it is unpacked, and everything on cancel. And then the real
// mover (companion/reader_companion/mover.py), packing a folder through the real Worker and unpacking it elsewhere.
// R2 and Cloudflare's storage are Maps.
//
//   node --test scripts/moves.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const { ProjectMove, tellDestination, removeSource } = await import('../worker/moves.js');
const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    deleteAll: async () => void map.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => undefined,
  };
}

/** An R2 bucket: objects in a Map, multipart uploads put together on complete. */
function bucket() {
  const objects = new Map();
  const uploads = new Map();
  const bytesOf = async (body) => new Uint8Array(await new Response(body).arrayBuffer());
  return {
    objects,
    uploads,
    async createMultipartUpload(key) {
      const uploadId = `u-${uploads.size + 1}`;
      uploads.set(uploadId, { key, parts: new Map(), aborted: false });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = uploads.get(uploadId);
      return {
        async uploadPart(n, body) {
          upload.parts.set(n, await bytesOf(body));
          return { partNumber: n, etag: `e${n}` };
        },
        async complete(parts) {
          const all = parts.map((p) => upload.parts.get(p.partNumber));
          const joined = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
          let at = 0;
          for (const b of all) joined.set(b, (at += b.length) - b.length);
          objects.set(key, joined);
        },
        async abort() {
          if (upload) upload.aborted = true;
        },
      };
    },
    async put(key, value) {
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : await bytesOf(value));
    },
    async get(key, { range } = {}) {
      const data = objects.get(key);
      if (!data) return null;
      const slice = data.subarray(range?.offset ?? 0);
      return { body: new Blob([slice]).stream(), size: data.length };
    },
    async delete(keys) {
      for (const key of [].concat(keys)) objects.delete(key);
    },
  };
}

function binding(envRef) {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) objects.set(name, new ProjectMove({ storage: memoryStorage() }, envRef()));
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
}

const SECRET = 'owner-token';
function env() {
  const e = { READER_TOKEN: SECRET, MOVES: bucket() };
  e.PROJECT_MOVES = binding(() => e);
  return e;
}
const page = (e, path, { pass, body } = {}) =>
  worker.fetch(
    new Request(`https://api.example${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: 'https://koios.dev', ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil() {} },
  );
const machine = (e, path, key, { method = 'GET', body, headers = {} } = {}) =>
  worker.fetch(new Request(`https://api.example${path}`, { method, headers: { 'X-Move-Key': key, ...headers }, body }), e, { waitUntil() {} });

const ID = 'c'.repeat(32);
const start = { id: ID, project: 'p1', title: 'Trying Automatic Generation', plan: 'archive', from: { kind: 'machine', label: 'Colab · T4' }, to: { kind: 'server', label: 'My laptop', deviceId: 'abcdef0123', root: 'playgrounds/p1' } };

describe('a move on the Worker', () => {
  it('is started by the page with its pass, and hands the machines a key', async () => {
    const e = env();
    assert.equal((await page(e, '/moves/start', { body: start })).status, 401);
    const pass = await issuePass('a@gmail.com', SECRET);
    const started = await (await page(e, '/moves/start', { pass, body: start })).json();
    assert.match(started.key, /^[0-9a-f]{48}$/);
    assert.equal(started.api, 'https://api.example');
    assert.equal(started.move.status, 'started');
    assert.equal(started.move.key, undefined);
    const theirs = await page(e, `/moves/status?id=${ID}`, { pass: await issuePass('b@gmail.com', SECRET) });
    assert.equal(theirs.status, 403);
    assert.equal((await machine(e, `/moves/token?id=${ID}`, 'wrong')).status, 403);
  });

  it('keeps the parts, puts them together when packed, and serves them whole or from a Range', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const { key } = await (await page(e, '/moves/start', { pass, body: start })).json();
    for (const [n, text] of [[1, 'hello '], [2, 'world']]) {
      const put = await machine(e, `/moves/part?id=${ID}&n=${n}`, key, { method: 'PUT', body: text, headers: { 'Content-Length': String(text.length) } });
      assert.equal(put.status, 200);
    }
    await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'packed', runner: 'r1', files: 2, bytes: 11, manifest: [{ path: 'a.py', size: 1, sha256: 'x' }] }) });
    assert.equal(await (await machine(e, `/moves/archive?id=${ID}`, key)).text(), 'hello world');
    const ranged = await machine(e, `/moves/archive?id=${ID}`, key, { headers: { Range: 'bytes=6-' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'world');
    assert.deepEqual((await (await machine(e, `/moves/manifest?id=${ID}`, key)).json()).files, [{ path: 'a.py', size: 1, sha256: 'x' }]);
    const status = (await (await page(e, `/moves/status?id=${ID}`, { pass })).json()).move;
    assert.equal(status.status, 'packed');
    assert.equal(status.manifestFiles, 1);
    // Unpacked: done, and the archive is gone from R2.
    await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'unpacking', runner: 'r2' }) });
    await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'unpacked', runner: 'r2', verified: 1 }) });
    assert.equal((await (await page(e, `/moves/status?id=${ID}`, { pass })).json()).move.status, 'done');
    assert.equal(e.MOVES.objects.has(`moves/${ID}/archive.tar.gz`), false);
  });

  it('shows the files found while a machine lists them, before the totals are known', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const { key } = await (await page(e, '/moves/start', { pass, body: start })).json();
    const listed = await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'listing', runner: 'r', files: 140, bytes: 5_000, totalFiles: 0, totalBytes: 0 }) });
    assert.equal(listed.status, 200);
    const status = (await (await page(e, `/moves/status?id=${ID}`, { pass })).json()).move;
    assert.equal(status.status, 'listing');
    assert.deepEqual(status.progress, { files: 140, bytes: 5_000, totalFiles: 0, totalBytes: 0 });
  });

  it('tells a second machine on the same step to stop', async () => {
    const e = env();
    const { key } = await (await page(e, '/moves/start', { pass: await issuePass('a@gmail.com', SECRET), body: start })).json();
    await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'unpacking', runner: 'first' }) });
    const second = await (await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'unpacking', runner: 'second' }) })).json();
    assert.equal(second.cancelled, true);
    assert.equal(second.duplicate, true);
  });

  it('keeps the Google token for the machines and renews it from the page', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const { key } = await (await page(e, '/moves/start', { pass, body: { ...start, plan: 'drive-pull', from: { kind: 'drive', label: 'Google Drive', folder: 'f1' }, token: 'ya29.one' } })).json();
    assert.equal((await (await machine(e, `/moves/token?id=${ID}`, key)).json()).token, 'ya29.one');
    await page(e, '/moves/drive-token', { pass, body: { id: ID, token: 'ya29.two' } });
    assert.equal((await (await machine(e, `/moves/token?id=${ID}`, key)).json()).token, 'ya29.two');
    // The status the page reads never has it.
    assert.equal((await (await page(e, `/moves/status?id=${ID}`, { pass })).json()).move.token, undefined);
  });

  it('stops everything on cancel, and the machines are told', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const { key } = await (await page(e, '/moves/start', { pass, body: start })).json();
    await machine(e, `/moves/part?id=${ID}&n=1`, key, { method: 'PUT', body: 'x', headers: { 'Content-Length': '1' } });
    await page(e, '/moves/cancel', { pass, body: { id: ID } });
    const refused = await machine(e, `/moves/part?id=${ID}&n=2`, key, { method: 'PUT', body: 'y', headers: { 'Content-Length': '1' } });
    assert.equal(refused.status, 409);
    assert.equal((await (await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'packing' }) })).json()).cancelled, true);
    assert.equal([...e.MOVES.uploads.values()][0].aborted, true);
  });

  it('tells a computer with the Companion to unpack, through its tunnel', async () => {
    const devices = { get: () => ({ fetch: async () => Response.json({ devices: [{ id: 'abcdef0123', url: 'https://laptop.trycloudflare.com/', token: 'jt', online: true, version: '0.16.0' }] }) }), idFromName: (n) => n };
    const older = { get: () => ({ fetch: async () => Response.json({ devices: [{ id: 'abcdef0123', url: 'https://laptop.trycloudflare.com/', token: 'jt', online: true, version: '0.15.0' }] }) }), idFromName: (n) => n };
    const calls = [];
    // A Companion whose mover would write over an old copy there isn't told: the page offers it the update.
    assert.equal(await tellDestination({ DEVICES: older }, { id: ID, key: 'k', api: 'https://api.example', email: 'a@gmail.com', origin: 'https://koios.dev', to: start.to }, new Request('https://x'), async () => (calls.push('older'), new Response('{}'))), false);
    assert.deepEqual(calls, []);
    const told = await tellDestination({ DEVICES: devices }, { id: ID, key: 'k', api: 'https://api.example', email: 'a@gmail.com', origin: 'https://koios.dev', to: start.to }, new Request('https://x'), async (url, init) => (calls.push({ url, init }), new Response('{}')));
    assert.equal(told, true);
    assert.equal(calls[0].url, 'https://laptop.trycloudflare.com/companion/move');
    assert.equal(calls[0].init.headers.Authorization, 'token jt');
    assert.equal(calls[0].init.headers.Origin, 'https://koios.dev');
    assert.deepEqual(JSON.parse(calls[0].init.body), { mode: 'unpack', api: 'https://api.example', id: ID, key: 'k', root: 'playgrounds/p1' });
  });

  it('removes the old copy once every file is checked, when asked to: Drive to the bin, a computer through its Companion', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => (calls.push({ url, init }), new Response('{}'));
    const devices = { get: () => ({ fetch: async () => Response.json({ devices: [{ id: 'abcdef0123', url: 'https://laptop.trycloudflare.com/', token: 'jt', online: true }] }) }), idFromName: (n) => n };
    const fromDrive = await removeSource({}, { email: 'a@gmail.com', token: 'ya29.x', from: { kind: 'drive', folder: 'F1' }, to: start.to }, new Request('https://x'), fetchImpl);
    assert.equal(fromDrive.state, 'removed');
    assert.equal(calls[0].url, 'https://www.googleapis.com/drive/v3/files/F1?fields=id');
    assert.deepEqual(JSON.parse(calls[0].init.body), { trashed: true });
    const fromLaptop = await removeSource({ DEVICES: devices }, { email: 'a@gmail.com', origin: 'https://koios.dev', from: { kind: 'server', deviceId: 'abcdef0123', root: 'playgrounds/p1' }, to: { kind: 'drive', folder: 'F2' } }, new Request('https://x'), fetchImpl);
    assert.equal(fromLaptop.state, 'removed');
    assert.deepEqual(JSON.parse(calls[1].init.body), { mode: 'remove', root: 'playgrounds/p1' });
    // Colab's disk, or a computer that is off: left for the page.
    assert.equal((await removeSource({ DEVICES: devices }, { email: 'a@gmail.com', from: { kind: 'machine', root: 'playgrounds/p1' }, to: start.to }, new Request('https://x'), fetchImpl)).state, 'pending');
    // Never the folder the files just went to.
    const same = await removeSource({ DEVICES: devices }, { email: 'a@gmail.com', from: { kind: 'server', deviceId: 'abcdef0123', root: 'p' }, to: { kind: 'server', deviceId: 'abcdef0123', root: 'p' } }, new Request('https://x'), fetchImpl);
    assert.equal(same.state, 'failed');
    assert.equal(calls.length, 2);
  });

  it('keeps what met an older copy, and whether the old copy is still to go', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const { key } = await (await page(e, '/moves/start', { pass, body: { ...start, from: { kind: 'machine', label: 'Colab', root: 'playgrounds/p1' }, removeOld: true } })).json();
    await machine(e, `/moves/report?id=${ID}`, key, { method: 'POST', body: JSON.stringify({ step: 'unpacked', runner: 'r', verified: 3, conflicts: 1, conflictPaths: ['both.py'], kept: 2, keptPaths: ['a.md', 'b.md'], stale: 1 }) });
    const move = (await (await page(e, `/moves/status?id=${ID}`, { pass })).json()).move;
    assert.deepEqual(move.met, { conflicts: 1, conflictPaths: ['both.py'], kept: 2, keptPaths: ['a.md', 'b.md'], stale: 1 });
    assert.equal(move.removeOld, true);
    assert.equal(move.oldCopy, 'pending');
  });

  it('says what to set up where there is no bucket', async () => {
    const e = env();
    delete e.MOVES;
    const answer = await page(e, '/moves/start', { pass: await issuePass('a@gmail.com', SECRET), body: start });
    assert.equal(answer.status, 501);
    assert.equal((await answer.json()).setup, true);
  });
});

// The real mover, on this machine, through the real Worker served on 127.0.0.1.
const python = spawnSync('python3', ['--version']).status === 0;
describe('the mover through the Worker', { skip: !python && 'no python3' }, () => {
  it('packs a folder into R2 in parts and unpacks it elsewhere, byte for byte', async () => {
    const e = env();
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const answer = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body }), e, { waitUntil() {} });
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${server.address().port}`;
    try {
      const pass = await issuePass('a@gmail.com', SECRET);
      const { key } = await (await page(e, '/moves/start', { pass, body: start })).json();
      const dir = mkdtempSync(join(tmpdir(), 'move-'));
      const from = join(dir, 'from');
      mkdirSync(join(from, 'envtrans'), { recursive: true });
      writeFileSync(join(from, 'main.py'), 'print("hi")\n');
      const blob = randomBytes(200_000);
      writeFileSync(join(from, 'envtrans', 'weights.bin'), blob);
      const run = (mode, root) =>
        new Promise((resolve, reject) => {
          const config = join(dir, `${mode}.json`);
          writeFileSync(config, JSON.stringify({ mode, api, id: ID, key, root }));
          const child = spawn('python3', ['companion/reader_companion/mover.py', config]);
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (code) => {
            if (code !== 0) return reject(new Error(err));
            assert.equal(existsSync(config), false, 'the config, with its key, is deleted once read');
            resolve(JSON.parse(out.trim().split('\n').pop()));
          });
        });
      const packed = await run('pack', from);
      assert.equal(packed.files, 2);
      const to = join(dir, 'to');
      await run('unpack', to);
      assert.deepEqual(readFileSync(join(to, 'envtrans', 'weights.bin')), blob);
      assert.equal(readFileSync(join(to, 'main.py'), 'utf8'), 'print("hi")\n');
      assert.equal((await (await page(e, `/moves/status?id=${ID}`, { pass })).json()).move.status, 'done');
    } finally {
      server.close();
    }
  });
});
