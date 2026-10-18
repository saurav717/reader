// Checkpoints (src/lib/koiosHelper.ts, src/lib/telemetry.ts): the lines the
// koios helper prints as a job saves, read off a run's output; and the
// helper's Python itself, run: saves on a cadence, saves and leaves on
// SIGTERM, resumes from the checkpoint KOIOS_RESUME names, and says so when
// that checkpoint is not on the machine.
//
//   node --test scripts/checkpoints.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, load } from './bundle.mjs';

const telemetry = await load('src/lib/telemetry.ts');
const helper = await load('src/lib/koiosHelper.ts');

after(cleanup);

describe('the checkpoint lines', () => {
  it('reads each save the helper printed, in order, and nothing else', () => {
    const text = [
      'epoch 1 loss 0.9',
      '[koios] checkpoint {"path": "/content/pg/checkpoints/step-00000500.pt", "step": 500, "at": "2026-10-18T10:00:00+0000", "reason": "cadence", "metrics": {"loss": 0.41, "name": "x"}, "rank": 1, "gpu": {"util": 93}}',
      '[koios] stop asked (signal 15): saving a checkpoint at the next step',
      '[koios] checkpoint {"path": "/content/pg/checkpoints/step-00000512.pt", "step": 512, "reason": "stop"}',
      '[koios] saved for the stop; leaving.',
      '[koios] checkpoint not json',
    ].join('\n');
    const all = telemetry.checkpointsOf(text);
    assert.equal(all.length, 2);
    assert.equal(all[0].step, 500);
    assert.deepEqual(all[0].metrics, { loss: 0.41 });
    assert.equal(all[0].gpu.util, 93);
    assert.equal(telemetry.latestCheckpoint(text).reason, 'stop');
    assert.equal(telemetry.latestCheckpoint(text).path, '/content/pg/checkpoints/step-00000512.pt');
    assert.equal(telemetry.latestCheckpoint('nothing here'), undefined);
  });
});

const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

describe('the helper, run', { skip: python ? false : 'no python3 here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'koios-'));
  mkdirSync(join(dir, 'pylib', 'koios'), { recursive: true });
  writeFileSync(join(dir, 'pylib', 'koios', '__init__.py'), helper.KOIOS_PY);
  writeFileSync(
    join(dir, 'train.py'),
    [
      'import koios, time',
      'ck = koios.checkpoint("checkpoints", every_steps=3, every_minutes=None)',
      'state = {"n": 0}',
      'ck.on_save(lambda path: open(path, "w").write(str(state["n"])))',
      'start = ck.resume(lambda path: state.update(n=int(open(path).read())))',
      'print("start", start, flush=True)',
      'for step in range(start, 10000):',
      '    state["n"] = step',
      '    ck.step(step, loss=1.0 / (step + 1))',
      '    time.sleep(0.02)',
      '',
    ].join('\n'),
  );
  const env = { ...process.env, PYTHONPATH: join(dir, 'pylib'), KOIOS_RANK: '1', KOIOS_WORLD: '3', KOIOS_MACHINE: 'test' };
  /** Runs train.py, SIGTERMs it after a while, and gives back what it printed and how it ended. */
  const run = (extra = {}, afterMs = 600) =>
    new Promise((resolve) => {
      const child = spawn(python, ['train.py'], { cwd: dir, env: { ...env, ...extra } });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      setTimeout(() => child.kill('SIGTERM'), afterMs);
      child.on('close', (code) => resolve({ out, code }));
    });

  it('saves on the cadence, then saves and leaves on SIGTERM with a stop save', async () => {
    const { out, code } = await run();
    assert.equal(code, 0);
    const saves = telemetry.checkpointsOf(out);
    assert.ok(saves.length >= 2, out);
    assert.equal(saves[saves.length - 1].reason, 'stop');
    assert.equal(saves[saves.length - 1].rank, 1);
    assert.ok(saves.slice(0, -1).every((s) => s.reason === 'cadence' && s.step % 3 === 0));
    // Three kept, with their sidecars and the pointer to the latest.
    const files = readdirSync(join(dir, 'checkpoints'));
    assert.ok(files.includes('latest.json'));
    assert.equal(files.filter((f) => f.endsWith('.pt')).length, 3);
    assert.equal(files.filter((f) => f.endsWith('.koios.json')).length, 3);
  });

  it('resumes from the checkpoint KOIOS_RESUME names, and says when it is not on the machine', async () => {
    const first = telemetry.latestCheckpoint((await run()).out);
    const { out } = await run({ KOIOS_RESUME: first.path }, 300);
    assert.ok(out.includes(`[koios] resumed `) && out.includes(`"step": ${first.step}}`), out);
    assert.match(out, new RegExp(`^start ${first.step}$`, 'm'));
    const { out: missing } = await run({ KOIOS_RESUME: '/nowhere/step.pt' }, 300);
    assert.match(missing, /resume asked from \/nowhere\/step\.pt, which is not on this machine/);
  });
});
