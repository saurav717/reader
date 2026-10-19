// Experiments: a run digested into the logbook's record (src/lib/experiments.ts), the Worker's cleaning of it
// (worker/logbook.js), the logbook reading it back (src/lib/logbookStore.ts, logbookOf), and the telemetry
// module's `use` and `simulators` commands writing a project's env.py and setup.sh from the catalogue the page
// hands the machine (src/lib/simulators.ts, catalogueJson) — the same env.py the page writes, byte for byte.
//
//   node --test scripts/experiments.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cleanup, load } from './bundle.mjs';

const xp = await load('src/lib/experiments.ts');
const tele = await load('src/lib/simTelemetry.ts');
const sims = await load('src/lib/simulators.ts');
const worker = await import('../worker/logbook.js');
after(cleanup);

const python = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[:2] >= (3, 9))'], { encoding: 'utf8' }).stdout?.trim() === 'True' ? 'python3' : null;
const MODULE = resolve('src/sim/koios_telemetry.py');

const t0 = 1_700_000_000;
const line = (event) => JSON.stringify(event);
function run({ returns = [], scalars = {}, media = [], notes = [], status = 'finished', live3d = false }) {
  const out = [line({ kind: 'start', t: t0, name: 'ppo', sim: 'mujoco/Ant-v5', config: { lr: 3e-4, env: 'Ant-v5' } })];
  if (live3d) out.push(line({ kind: 'live3d', t: t0, step: 0, grpc_port: 1, web_port: 2, rrd_port: 3, rrd: 'scene.rrd' }));
  returns.forEach((r, i) => out.push(line({ kind: 'episode', t: t0 + i, step: (i + 1) * 100, index: i, return: r, length: 10, success: r > 50 })));
  Object.entries(scalars).forEach(([k, vs]) => vs.forEach((v, i) => out.push(line({ kind: 'scalars', t: t0 + i, step: (i + 1) * 100, values: { [k]: v } }))));
  media.forEach((m, i) => out.push(line({ kind: 'media', t: t0 + i, step: i * 100, name: 'rollout', path: m.path, type: 'video', bytes: m.bytes })));
  notes.forEach((text, i) => out.push(line({ kind: 'note', t: t0 + i, step: i * 100, text, by: 'agent' })));
  out.push(line({ kind: 'end', t: t0 + 100, status, step: 6000, episodes: returns.length, elapsed: 100 }));
  return tele.parseRun('runs/ppo-1', { id: 'ppo-1', name: 'ppo', sim: 'mujoco/Ant-v5', config: { lr: 3e-4 }, started: t0, ended: t0 + 100, status, host: { gpu: 'T4' } }, `${out.join('\n')}\n`);
}
const rising = Array.from({ length: 60 }, (_, i) => i * 2);

describe('the record', () => {
  it('digests a run: returns first, last and best, success, last values, findings, notes, config', () => {
    const r = run({ returns: rising, scalars: { 'loss/policy': [0.5, 0.4, 0.3], entropy: [1, 0.9, 0.8] }, notes: ['lr down', 'clip tighter'] });
    const d = xp.digestOf(r, { playgroundId: 'pg1', playground: 'Ant', by: 'me@example.org' }, t0 + 200);
    assert.equal(d.id, 'ppo-1');
    assert.equal(d.sim, 'mujoco/Ant-v5');
    assert.equal(d.status, 'finished');
    assert.deepEqual(d.returns, { first: 5, last: 113, best: 118 });
    assert.equal(d.success, 68);
    assert.deepEqual(d.last, { 'loss/policy': 0.3, entropy: 0.8 });
    assert.ok(d.findings.some((f) => f.id === 'improving'));
    assert.deepEqual(d.notes.map((n) => n.text), ['lr down', 'clip tighter']);
    assert.equal(d.config.lr, 3e-4);
    assert.equal(d.machine, 'T4');
    assert.equal(d.episodes, 60);
  });

  it('files the newest media within the caps, and says what it left out', () => {
    const r = run({ media: [{ path: 'media/a.mp4', bytes: 1000 }, { path: 'media/b.mp4', bytes: 9 * 1024 * 1024 }, { path: 'media/c.mp4', bytes: 2000 }], live3d: true });
    const plan = xp.filesToFile(r, 500);
    assert.deepEqual(plan.take.map((f) => f.path), ['media/a.mp4', 'media/c.mp4', 'scene.rrd']);
    assert.deepEqual(plan.leftOut, ['media/b.mp4']);
    assert.equal(xp.filesToFile(r, null).take.some((f) => f.kind === 'scene'), false);
  });

  it('writes the record as a page, and a prompt for the notes', () => {
    const r = run({ returns: rising, scalars: { 'loss/policy': [0.5] } });
    const d = { ...xp.digestOf(r, { playgroundId: 'pg1', playground: 'Ant', by: 'me' }, t0 + 200), where: { kind: 'drive', label: 'Google Drive', path: 'Experiments/ant-p1/ppo-1', link: 'https://drive.google.com/x' }, files: [{ path: 'media/a.mp4', bytes: 1000, kind: 'video' }], leftOut: [] };
    const md = xp.experimentMarkdown(d);
    assert.match(md, /^# ppo\n/);
    assert.match(md, /\*\*Return:\*\* first 5 → last 113 · best 118/);
    assert.match(md, /Return is climbing/);
    assert.match(md, /media\/a\.mp4 \(1 KB\)/);
    const prompt = xp.notesPrompt(d, '# Learning notes\n\n- tried a lower lr');
    assert.ok(prompt.includes('LEARNING.md') && prompt.includes('tried a lower lr'));
    assert.match(xp.cliNotesRequest(d, 'runs/ppo-1'), /runs\/ppo-1\/summary\.md/);
    assert.equal(xp.toneOf(d), 'good');
    assert.match(xp.experimentLine(d), /Ant-v5 · 5 → 113 · 68% success · finished/);
  });

  it('keeps one record a run, newest first', () => {
    const a = { id: 'a', playgroundId: 'p', ended: '2026-01-01T00:00:00Z', at: '1' };
    const b = { id: 'b', playgroundId: 'p', ended: '2026-02-01T00:00:00Z', at: '1' };
    const list = xp.withExperiment(xp.withExperiment([a], b), { ...a, at: '2' });
    assert.deepEqual(list.map((e) => `${e.id}:${e.at}`), ['b:1', 'a:2']);
  });
});

describe('the Worker and the store', () => {
  it('cleans a record and refuses one without a run or a playground', () => {
    const raw = { id: 'ppo-1', playgroundId: 'pg1', title: 'x'.repeat(500), sim: 'mujoco/Ant-v5', status: 'odd', started: 'nonsense', ended: '2026-01-01T00:00:00Z', steps: 12.7, episodes: -3, returns: { first: 1, last: 2, best: 'nan' }, success: 140, last: { a: 1, b: 'x' }, findings: [{ id: 'improving', level: 'loud', title: 't', detail: 'd', try: 'y' }], notes: [{ step: 3, by: 'agent', text: 'n' }], config: { lr: 1 }, where: { kind: 'server', label: 'Lab', path: 'experiments/x', serverId: 's1', link: 'javascript:alert(1)' }, files: [{ path: 'a.mp4', bytes: 5, kind: 'weird' }], leftOut: ['b'], summary: { text: 'notes', by: 'Claude', at: 'x' } };
    const clean = worker.cleanExperiment(raw, 'me@example.org');
    assert.equal(clean.title.length, 200);
    assert.equal(clean.status, 'finished');
    assert.equal(clean.steps, 12);
    assert.equal(clean.episodes, 0);
    assert.equal(clean.returns, undefined, 'a NaN best drops the returns');
    assert.equal(clean.success, 100);
    assert.deepEqual(clean.last, { a: 1 });
    assert.equal(clean.findings[0].level, 'info');
    assert.deepEqual(clean.where, { kind: 'server', label: 'Lab', path: 'experiments/x', serverId: 's1' });
    assert.equal(clean.files[0].kind, 'video');
    assert.equal(clean.summary.by, 'Claude');
    assert.equal(clean.by, 'me@example.org');
    assert.equal(worker.cleanExperiment({ id: 'x' }, 'me'), null);
    assert.equal(worker.cleanExperiment({ id: 'x', playgroundId: 'bad id!' }, 'me'), null);
  });

  it('keeps and removes experiments in the room, and reads them back newest first', async () => {
    const storage = new Map();
    const api = { get: async (k) => storage.get(k), put: async (k, v) => void storage.set(k, v), delete: async (k) => void storage.delete(k), list: async ({ prefix }) => new Map([...storage].filter(([k]) => k.startsWith(prefix))) };
    const who = 'me@example.org';
    const a = { id: 'a', playgroundId: 'p', ended: '2026-01-01T00:00:00Z' };
    const b = { id: 'b', playgroundId: 'p', ended: '2026-02-01T00:00:00Z' };
    assert.equal((await worker.changeLog(api, who, { op: 'experiment', experiment: a })).status, 200);
    assert.equal((await worker.changeLog(api, who, { op: 'experiment', experiment: b })).status, 200);
    assert.deepEqual((await worker.readLog(api)).experiments.map((e) => e.id), ['b', 'a']);
    const gone = await worker.changeLog(api, who, { op: 'unexperiment', keys: ['p:b'] });
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.broadcast, { type: 'log', op: 'unexperiment', keys: ['p:b'] });
    assert.deepEqual((await worker.readLog(api)).experiments.map((e) => e.id), ['a']);
    assert.equal((await worker.changeLog(api, who, { op: 'experiment', experiment: { id: 'x' } })).status, 400);
    assert.ok((await worker.logKeys(api)).includes('experiment:p:a'));
  });

  it('reads a logbook with experiments, and one from before them', async () => {
    const { logbookOf } = await load('src/lib/logbookStore.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
    assert.deepEqual(logbookOf({ notes: [], links: [] }).experiments, []);
    const log = logbookOf({ experiments: [{ id: 'a', playgroundId: 'p', ended: '2026-01-01T00:00:00Z', at: '1' }, { id: 'b', playgroundId: 'p', ended: '2026-02-01T00:00:00Z', at: '1' }, { broken: true }] });
    assert.deepEqual(log.experiments.map((e) => e.id), ['b', 'a']);
  });
});

describe('the catalogue on the machine', { skip: !python && 'no python3' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-use-'));
  copyFileSync(MODULE, join(dir, 'koios_telemetry.py'));
  writeFileSync(join(dir, 'koios_simulators.json'), sims.catalogueJson());
  const py = (...args) => spawnSync(python, ['koios_telemetry.py', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, KOIOS_HEADLESS: '0' } });

  it('lists the simulators, and finds one by a word', () => {
    const all = py('simulators');
    assert.equal(all.status, 0, all.stderr);
    assert.ok(all.stdout.includes('mujoco_playground') && all.stdout.includes('isaaclab'));
    const atari = py('simulators', 'atari');
    assert.ok(atari.stdout.includes('ALE/Pong-v5') && !atari.stdout.includes('isaaclab'));
  });

  it('writes the same env.py the page writes, and setup.sh, for a Gymnasium simulator', () => {
    const used = py('use', 'mujoco', 'HalfCheetah-v5');
    assert.equal(used.status, 0, used.stderr);
    assert.match(used.stdout, /wrote env\.py, setup\.sh/);
    const sim = sims.simulatorById('mujoco');
    assert.equal(readFileSync(join(dir, 'env.py'), 'utf8'), sims.envPy(sim, 'HalfCheetah-v5'));
    const setup = readFileSync(join(dir, 'setup.sh'), 'utf8');
    assert.match(setup, /gymnasium\[mujoco\]/);
    assert.match(setup, /rerun-sdk/);
    assert.match(setup, /koios_telemetry\.py doctor/);
    const parsed = spawnSync(python, ['-c', 'import ast; ast.parse(open("env.py").read())'], { cwd: dir, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  });

  it('writes a native starter where the simulator has one, and keeps setup.sh unless forced', () => {
    const used = py('use', 'brax', 'ant');
    assert.equal(used.status, 0, used.stderr);
    assert.match(used.stdout, /Needs a GPU/);
    const main = readFileSync(join(dir, 'main.py'), 'utf8');
    assert.ok(main.includes('ENV_ID = "ant"') && !main.includes('__ENV__'));
    assert.match(readFileSync(join(dir, 'setup.sh'), 'utf8'), /gymnasium\[mujoco\]/, 'the earlier setup.sh stays');
    const forced = py('use', 'brax', 'ant', '--force');
    assert.match(readFileSync(join(dir, 'setup.sh'), 'utf8'), /pip install brax/);
    assert.equal(forced.status, 0);
    assert.notEqual(py('use', 'nothing-of-the-sort').status, 0);
  });
});
