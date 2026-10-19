// Simulation: the catalogue of simulators (src/lib/simulators.ts), the projects made from it
// (src/lib/simProject.ts), the Sim pane's reading of a run (src/lib/simTelemetry.ts), and the Python
// module that writes the runs (src/sim/koios_telemetry.py), run for real when python3 is there, so the
// two sides are checked against each other: the events one writes the other reads, the findings match.
//
//   node --test scripts/simulation.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cleanup, load } from './bundle.mjs';

const sims = await load('src/lib/simulators.ts');
const project = await load('src/lib/simProject.ts');
const tele = await load('src/lib/simTelemetry.ts');
after(cleanup);

const MODULE = resolve('src/sim/koios_telemetry.py');
const python = (() => {
  const found = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[:2] >= (3, 9))'], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim() === 'True' ? 'python3' : null;
})();
const hasNumpy = python ? spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' }).status === 0 : false;
const py = (code, cwd, env = {}) => spawnSync(python, ['-c', code], { cwd, encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('src/sim'), KOIOS_HEADLESS: '0', ...env } });

describe('the catalogue', () => {
  it('has many simulators, each with a way in', () => {
    assert.ok(sims.SIMULATORS.length >= 30);
    const ids = new Set();
    for (const sim of sims.SIMULATORS) {
      assert.ok(!ids.has(sim.id), `${sim.id} twice`);
      ids.add(sim.id);
      assert.ok(sim.install.length, `${sim.id} has no install line`);
      assert.match(sim.docs, /^https:\/\//, sim.id);
      assert.ok(sim.envs.length, `${sim.id} has no environment`);
      assert.ok(sims.FAMILIES.some((f) => f.id === sim.family), sim.id);
      if (sim.api === 'native' && sim.id !== 'isaaclab') assert.ok(sim.native, `${sim.id} is native with no starter`);
      assert.ok(sims.templatesFor(sim).length, `${sim.id} has no template`);
    }
    // Every family has something in it, and there are hands to pick.
    for (const family of sims.FAMILIES) assert.ok(sims.SIMULATORS.some((s) => s.family === family.id), family.id);
    assert.ok(sims.SIMULATORS.filter((s) => s.envs.some((e) => e.hand)).length >= 5);
  });

  it('names the same import for each simulator as the doctor does', () => {
    const text = readFileSync(MODULE, 'utf8');
    const block = text.slice(text.indexOf('SIMULATORS = {'), text.indexOf('}', text.indexOf('SIMULATORS = {')));
    const doctor = Object.fromEntries([...block.matchAll(/"([\w]+)": "([\w.]+)"/g)].map((m) => [m[1], m[2]]));
    for (const sim of sims.SIMULATORS) assert.equal(doctor[sim.id], sim.module, `${sim.id}: the doctor imports ${doctor[sim.id]}, the catalogue ${sim.module}`);
  });

  it('offers the templates that fit the environment', () => {
    const gym = sims.simulatorById('gymnasium');
    assert.deepEqual(sims.templatesFor(gym, gym.envs.find((e) => e.id === 'CartPole-v1')), ['random', 'ppo', 'sb3', 'world-model']);
    assert.ok(sims.templatesFor(gym, gym.envs.find((e) => e.id === 'Pendulum-v1')).includes('sac'));
    assert.deepEqual(sims.templatesFor(sims.simulatorById('isaaclab')), ['isaaclab']);
    assert.equal(sims.templatesFor(sims.simulatorById('brax'))[0], 'native');
    assert.ok(sims.templatesFor(sims.simulatorById('dm_control')).includes('dreamerv3'));
    assert.ok(sims.templatesFor(sims.simulatorById('dm_control')).includes('tdmpc2'));
  });

  it('maps environments to DreamerV3 and TD-MPC2 tasks', () => {
    const ale = sims.simulatorById('ale');
    assert.deepEqual(sims.dreamerTask(ale, { id: 'ALE/Pong-v5' }), { configs: 'atari', task: 'atari_pong' });
    assert.equal(sims.dreamerTask(ale, { id: 'ALE/SpaceInvaders-v5' }).task, 'atari_space_invaders');
    assert.equal(sims.dreamerTask(sims.simulatorById('dm_control'), { id: 'walker-walk' }).task, 'dmc_walker_walk');
    assert.equal(sims.tdmpcTask(sims.simulatorById('metaworld'), { id: 'drawer-open-v3' }), 'mw-drawer-open');
    assert.equal(sims.dreamerTask(sims.simulatorById('mujoco')), null);
  });

  it('warns before an RTX-only or GPU-only simulator lands on Colab', () => {
    assert.match(sims.placeWarning(sims.simulatorById('isaaclab'), true), /RTX/);
    assert.match(sims.placeWarning(sims.simulatorById('brax'), true), /GPU runtime/);
    assert.equal(sims.placeWarning(sims.simulatorById('gymnasium'), true), null);
  });
});

describe('a project', () => {
  it('has the briefing, the setup, the telemetry and the template', () => {
    const sim = sims.simulatorById('mujoco');
    const made = project.simProject(sim, sim.envs.find((e) => e.id === 'Ant-v5'), 'sac', 'Ant');
    for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'LEARNING.md', 'setup.sh', 'koios_telemetry.py', 'env.py', 'sac.py']) assert.ok(made.files[file], file);
    assert.equal(made.files['CLAUDE.md'], '@AGENTS.md\n');
    assert.match(made.files['AGENTS.md'], /Telemetry is required/);
    assert.match(made.files['AGENTS.md'], /LEARNING\.md/);
    assert.match(made.files['setup.sh'], /gymnasium\[mujoco\]/);
    assert.match(made.files['setup.sh'], /koios_telemetry\.py doctor/);
    assert.match(made.files['env.py'], /ENV_ID = "Ant-v5"/);
    // The renderer is chosen at the telemetry's import, so it comes before any simulator's.
    assert.ok(made.files['env.py'].indexOf('import koios_telemetry') < made.files['env.py'].indexOf('import gymnasium'));
    assert.equal(made.pending, 'bash setup.sh && python sac.py');
  });

  it('puts the environment into a native starter, and its telemetry first', () => {
    for (const sim of sims.SIMULATORS.filter((s) => s.native)) {
      const made = project.simProject(sim, sim.envs[0], 'native', sim.name);
      assert.ok(!made.files['main.py'].includes('__ENV__'), sim.id);
      const main = made.files['main.py'];
      // The first import of anything but the standard library's (pettingzoo imports its simulator inside main()).
      const first = main.search(/^import (?!argparse|functools|importlib|queue)\w+|^from (?!koios_telemetry)\w+/m);
      assert.ok(main.includes('from koios_telemetry import Run'), sim.id);
      assert.ok(first === -1 || main.indexOf('from koios_telemetry import Run') < first, `${sim.id}: the telemetry is imported after a simulator`);
    }
  });

  it('bridges the repositories it runs', () => {
    const made = project.simProject(sims.simulatorById('dm_control'), { id: 'walker-walk', label: 'walker-walk', space: 'continuous' }, 'dreamerv3', 'Dreamer');
    assert.match(made.files['run_dreamer.sh'], /--task dmc_walker_walk/);
    assert.match(made.files['run_dreamer.sh'], /koios_telemetry\.py bridge "\$LOGDIR\/metrics\.jsonl".*--until-pid \$TRAIN/);
    const isaac = project.simProject(sims.simulatorById('isaaclab'), sims.simulatorById('isaaclab').envs[2], 'isaaclab', 'Allegro');
    assert.match(isaac.files['train_isaaclab.sh'], /Isaac-Repose-Cube-Allegro-Direct-v0/);
    assert.match(isaac.files['train_isaaclab.sh'], /--videos IsaacLab\/logs\/rsl_rl/);
  });

  it('writes Python that parses', { skip: !python && 'no python3' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-project-'));
    for (const sim of sims.SIMULATORS) {
      for (const template of sims.templatesFor(sim)) {
        const made = project.simProject(sim, sim.envs[0], template, sim.name);
        for (const [path, text] of Object.entries(made.files)) {
          if (!path.endsWith('.py')) continue;
          const file = join(dir, `${sim.id}-${template}-${path}`);
          writeFileSync(file, text);
          const parsed = spawnSync(python, ['-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', file], { encoding: 'utf8' });
          assert.equal(parsed.status, 0, `${sim.id}/${template}/${path}: ${parsed.stderr}`);
        }
      }
    }
  });
});

// ------------------------------------------------------------- reading ----

const line = (event) => JSON.stringify(event);
const t0 = 1_700_000_000;
function events({ returns = [], scalars = {}, dreams = [], end, notes = [], lastT } = {}) {
  const out = [line({ kind: 'start', t: t0, name: 'x' })];
  returns.forEach((r, i) => out.push(line({ kind: 'episode', t: t0 + i, step: (i + 1) * 100, index: i, return: r, length: 10 })));
  const longest = Math.max(0, ...Object.values(scalars).map((v) => v.length));
  for (let i = 0; i < longest; i++) {
    const values = Object.fromEntries(Object.entries(scalars).filter(([, v]) => i < v.length).map(([k, v]) => [k, v[i]]));
    out.push(line({ kind: 'scalars', t: t0 + i, step: (i + 1) * 100, values }));
  }
  dreams.forEach((error, i) => out.push(line({ kind: 'dream', t: t0 + i, step: (i + 1) * 1000, name: 'dream', path: `media/d${i}.mp4`, type: 'video', error, context: 2 })));
  notes.forEach((text, i) => out.push(line({ kind: 'note', t: t0 + i, step: i * 100, text, by: 'agent' })));
  if (lastT) out.push(line({ kind: 'heartbeat', t: lastT, step: 0, sps: 10 }));
  if (end) out.push(line({ kind: 'end', t: (lastT ?? t0) + 1, ...end }));
  return `${out.join('\n')}\n`;
}

const rising = Array.from({ length: 60 }, (_, i) => i + (i % 3));
const flat = Array.from({ length: 60 }, (_, i) => 10 + ((i * 7) % 5));
const peaked = [...Array.from({ length: 40 }, (_, i) => i * 5), ...Array.from({ length: 40 }, () => 5)];

const CASES = {
  improving: { returns: rising, end: { status: 'finished' } },
  'no-learning': { returns: flat, end: { status: 'finished' } },
  collapse: { returns: peaked, end: { status: 'finished' } },
  nan: { scalars: { 'loss/policy': [0.5, 0.4, 'nan', 0.3] }, end: { status: 'finished' } },
  'entropy-collapse': { scalars: { entropy: [1, 1, 1, 0.5, 0.2, 0.1, 0.05, 0.01, 0.01, 0.01, 0.01] }, end: { status: 'finished' } },
  'loss-explode': { scalars: { 'loss/value': [1, 1, 1, 1, 1, 10, 100, 1000, 500, 800] }, end: { status: 'finished' } },
  crashed: { end: { status: 'crashed', error: 'Traceback\nValueError: boom' } },
  stalled: { lastT: t0 + 10 },
  'dream-drift': { dreams: [[0, 0, 0.01, 0.01, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]], end: { status: 'finished' } },
  'dream-stuck': { dreams: [[0, 0, 0.1, 0.1], [0, 0, 0.1, 0.1], [0, 0, 0.1, 0.1], [0, 0, 0.1, 0.1]], end: { status: 'finished' } },
};
const NOW = t0 + 1000;

describe('reading a run', () => {
  it('parses every kind of event, and NaN where the module writes it', () => {
    const run = tele.parseRun('runs/a', { name: 'a', status: 'running' }, events({ returns: [1, 2, 3], scalars: { 'loss/policy': [0.5, 'nan'], 'loss/value': [1, 2] }, dreams: [[0, 0, 0.1]], notes: ['lr down'], end: { status: 'finished' } }) + 'not json\n');
    assert.equal(run.episodes.length, 3);
    assert.equal(run.status, 'finished');
    assert.ok(Number.isNaN(run.scalars.get('loss/policy')[1].y));
    assert.equal(run.dreams[0].context, 2);
    assert.equal(run.notes[0].by, 'agent');
    assert.equal(run.step, 1000);
  });

  it('knows where a run’s live 3D view is', () => {
    const run = tele.parseRun('r', {}, `${line({ kind: 'live3d', t: t0, step: 0, grpc_port: 41737, web_port: 42911, rrd_port: 40001, rrd: 'scene.rrd', sdk: '0.39.0' })}\n`);
    assert.deepEqual(run.live3d, { grpcPort: 41737, webPort: 42911, rrdPort: 40001, rrd: 'scene.rrd', sdk: '0.39.0' });
    assert.equal(tele.parseRun('r', {}, events({ returns: [1] })).live3d, undefined);
  });

  it('reads a file in pieces as it would read it whole', () => {
    const text = events({ returns: rising, scalars: { loss: [3, 2, 1] }, end: { status: 'finished' } });
    const whole = tele.parseRun('r', {}, text);
    const piecewise = tele.newRun('r');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 7) tele.applyEvents(piecewise, `${lines.slice(i, i + 7).join('\n')}\n`);
    assert.deepEqual(piecewise.episodes, whole.episodes);
    assert.deepEqual([...piecewise.scalars], [...whole.scalars]);
  });

  it('draws returns with their running mean, and groups the numbers by prefix', () => {
    const run = tele.parseRun('r', {}, events({ returns: rising, scalars: { 'loss/policy': [1, 2], 'loss/value': [1, 2], entropy: [1, 1] } }));
    const [raw, mean] = tele.returnSeries(run);
    assert.equal(raw.points.length, 60);
    assert.match(mean.name, /mean of 6/);
    const charts = tele.scalarCharts(run);
    assert.deepEqual(charts.map((c) => c.title), ['loss', 'entropy']);
    assert.deepEqual(charts[0].series.map((s) => s.name), ['policy', 'value']);
    assert.deepEqual(tele.scalarCharts(run, 'entr').map((c) => c.title), ['entropy']);
    // Series of a prefix that differ by orders of magnitude get charts of their own: SB3's train/value_loss and train/learning_rate.
    const sb3 = tele.parseRun('r', {}, events({ scalars: { 'train/value_loss': [900, 1100], 'train/learning_rate': [3e-4, 3e-4], 'train/approx_kl': [0.01, 0.02], 'train/clip_fraction': [0.1, 0.12] } }));
    assert.deepEqual(tele.scalarCharts(sb3).map((c) => c.series.map((s) => s.name)), [['train/value_loss'], ['train/learning_rate'], ['approx_kl', 'clip_fraction']]);
  });

  it('labels each chart’s axes as the run says, and points out the ones it does not', () => {
    const t0 = 1_700_000_000;
    const text = [
      line({ kind: 'axes', t: t0, step: 0, x: 'batch size', axes: { 'throughput/sps': { y: 'env steps / s' }, loss: 'loss' } }),
      line({ kind: 'axes', t: t0, step: 0, axes: { speedup: { y: '× Python', x: 'seed' } } }),
      events({ scalars: { 'throughput/sps': [1, 2], speedup: [3, 4], 'loss/policy': [1, 2], 'loss/value': [1, 2], batch: [512, 512] } }),
    ].join('\n');
    const run = tele.parseRun('r', {}, text);
    const byTitle = Object.fromEntries(tele.scalarCharts(run).map((c) => [c.title, [c.yLabel, c.xLabel]]));
    assert.deepEqual(byTitle['throughput/sps'], ['env steps / s', 'batch size']);
    assert.deepEqual(byTitle.speedup, ['× Python', 'seed']);
    assert.deepEqual(byTitle.loss, ['loss', 'batch size']);
    assert.deepEqual(byTitle.batch, [undefined, 'batch size']);
    assert.deepEqual(tele.unlabelled(run), ['batch']);
    assert.ok(tele.diagnose(run, t0).some((f) => f.id === 'unlabelled' && /batch/.test(f.detail)));
    // With nothing said, the x axis is the step, as before.
    assert.equal(tele.scalarCharts(tele.parseRun('r', {}, events({ scalars: { loss: [1, 2] } })))[0].xLabel, 'step');
  });

  it('has the module label axes, warn about the numbers it was not told about, and agree with the pane', { skip: !python }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'koios-axes-'));
    const out = py(
      [
        'import glob, json, koios_telemetry as k',
        'r = k.Run("t", x_label="batch size", live3d=False)',
        'r.axes("throughput/sps", y="env steps / s")',
        'r.log({"throughput/sps": 1, "speedup": 2}, step=0)',
        'r.axes({"loss": "loss"})',
        'r.log({"loss/policy": 1}, step=1)',
        'r.finish()',
        'run = k.read_run(glob.glob("runs/*")[0])',
        'print(json.dumps({"axes": run["axes"], "x": run["x_label"], "ids": [d["id"] for d in k.diagnose(run)]}))',
      ].join('\n'),
      dir,
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[koios\] no axis label for speedup/);
    assert.match(out.stdout, /\[koios\] charts with no axis labels: speedup\./);
    const said = JSON.parse(out.stdout.trim().split('\n').pop());
    assert.deepEqual(said, { axes: { 'throughput/sps': { y: 'env steps / s' }, loss: { y: 'loss' } }, x: 'batch size', ids: ['unlabelled'] });
    const runDir = join(dir, 'runs', readdirSync(join(dir, 'runs'))[0]);
    const run = tele.parseRun(runDir, {}, readFileSync(join(runDir, 'events.jsonl'), 'utf8'));
    assert.deepEqual(tele.unlabelled(run), ['speedup']);
  });

  it('calls a quiet running run stalled', () => {
    assert.equal(tele.shownStatus('running', NOW - 500, NOW), 'stalled');
    assert.equal(tele.shownStatus('running', NOW - 5, NOW), 'running');
    assert.equal(tele.shownStatus('finished', NOW - 5000, NOW), 'finished');
  });

  for (const [id, spec] of Object.entries(CASES)) {
    it(`finds ${id}`, () => {
      const run = tele.parseRun('r', {}, events(spec));
      assert.ok(tele.diagnose(run, NOW).some((f) => f.id === id), `${id} not in ${tele.diagnose(run, NOW).map((f) => f.id)}`);
    });
  }

  it('makes the same findings as the Python summary', { skip: !python && 'no python3' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-runs-'));
    for (const [id, spec] of Object.entries(CASES)) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, 'events.jsonl'), events(spec));
    }
    const got = py(`import json, os, koios_telemetry as k\nprint(json.dumps({d: [f["id"] for f in k.diagnose(k.read_run(os.path.join(${JSON.stringify(root)}, d)), ${NOW})] for d in os.listdir(${JSON.stringify(root)})}))`, root);
    assert.equal(got.status, 0, got.stderr);
    const fromPython = JSON.parse(got.stdout.trim().split('\n').pop());
    for (const [id, spec] of Object.entries(CASES)) {
      const fromHere = tele.diagnose(tele.parseRun('r', {}, events(spec)), NOW).map((f) => f.id);
      assert.deepEqual(fromHere, fromPython[id], id);
    }
  });
});

describe('an evaluation against the paper', () => {
  it('knows which way is better, from what the run said or the metric’s name, and sizes the gap', () => {
    assert.equal(tele.higherIsBetter('return', undefined), true);
    assert.equal(tele.higherIsBetter('loss/model', undefined), false);
    assert.equal(tele.higherIsBetter('return', false), false);
    assert.equal(tele.higherIsBetter('loss', { loss: true }), true);
    const rows = tele.evaluationRows({ metrics: { return: 900, loss: 0.3, length: 50, extra: 1 }, paper: { return: 1000, loss: 0.2, length: 50 } });
    assert.deepEqual(rows[0], { metric: 'return', ours: 900, paper: 1000, delta: { abs: -100, pct: -10, better: false } });
    assert.deepEqual(rows[1], { metric: 'loss', ours: 0.3, paper: 0.2, delta: { abs: 0.3 - 0.2, pct: (100 * (0.3 - 0.2)) / 0.2, better: false } });
    assert.deepEqual(rows[2].delta, { abs: 0, pct: 0, better: null });
    assert.deepEqual(rows[3], { metric: 'extra', ours: 1 });
    const latest = tele.latestEvaluations([{ name: 'a', step: 1 }, { name: 'b', step: 2 }, { name: 'a', step: 3 }]);
    assert.deepEqual(latest.map((e) => [e.name, e.step]), [['a', 3], ['b', 2]]);
  });
});

describe('the Python module', { skip: !python && 'no python3' }, () => {
  it('writes a run the pane reads, and records its crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-run-'));
    const code = `
from koios_telemetry import Run
run = Run("t", config={"lr": 3e-4, "nested": {"a": [1, 2]}}, sim="test/env", video_every=2)
for i in range(5):
    run.episode(float(i), 10, step=i * 10, success=i > 2)
    run.log({"loss/policy": 1.0 / (i + 1), "bad": float("nan") if i == 4 else 0.0}, step=i * 10)
run.note("changed something", by="agent")
run.evaluation({"return": 812.5, "success": 0.9, "loss": 0.2}, step=40, episodes=10, protocol="10 episodes, seeds 0-9", paper={"return": 850.0, "success": 0.95, "source": "Table 1"}, higher_is_better={"loss": False})

class Env:
    def __init__(self):
        self.n = 0
    def reset(self, seed=None):
        self.n = 0
        return [0.0], {}
    def step(self, action):
        self.n += 1
        return [float(self.n)], 1.0, self.n >= 3, False, {"is_success": self.n >= 3}
    def close(self):
        pass

run.evaluate(lambda **kw: Env(), lambda obs: 0, episodes=4, seed=7, video=False, step=41)
raise RuntimeError("boom")
`;
    const ran = py(code, dir);
    assert.notEqual(ran.status, 0);
    const [runDir] = readdirSync(join(dir, 'runs'));
    const meta = JSON.parse(readFileSync(join(dir, 'runs', runDir, 'run.json'), 'utf8'));
    assert.equal(meta.status, 'crashed');
    assert.equal(meta.config.lr, 3e-4);
    const run = tele.parseRun(runDir, meta, readFileSync(join(dir, 'runs', runDir, 'events.jsonl'), 'utf8'));
    assert.equal(run.episodes.length, 5);
    assert.equal(run.episodes[4].success, true);
    assert.equal(run.status, 'crashed');
    assert.match(run.error, /RuntimeError: boom/);
    assert.equal(run.notes[0].text, 'changed something');
    // The evaluations: the one written by hand, with the paper's numbers, and the default protocol's on a fake env.
    assert.equal(run.evaluations.length, 2);
    assert.deepEqual(run.evaluations[0].metrics, { return: 812.5, success: 0.9, loss: 0.2 });
    assert.deepEqual(run.evaluations[0].paper, { return: 850, success: 0.95 });
    assert.equal(run.evaluations[0].source, 'Table 1');
    assert.deepEqual(run.evaluations[0].higherIsBetter, { loss: false });
    assert.equal(run.evaluations[0].protocol, '10 episodes, seeds 0-9');
    const auto = run.evaluations[1];
    assert.equal(auto.name, 'eval');
    assert.equal(auto.episodes, 4);
    assert.deepEqual(auto.metrics, { return: 3, return_std: 0, length: 3, success: 1 });
    assert.match(auto.protocol, /^4 episodes, seeds 7-10, deterministic actions \(Koios default protocol/);
    const ids = tele.diagnose(run, run.lastT).map((f) => f.id);
    assert.ok(ids.includes('crashed') && ids.includes('nan'), ids.join());
    const summary = spawnSync(python, [MODULE, 'summary', '.'], { cwd: dir, encoding: 'utf8', env: { ...process.env, KOIOS_HEADLESS: '0' } });
    assert.match(summary.stdout, /\[crashed\]/);
    assert.match(summary.stdout, /note @ \d+: \[agent\] changed something/);
    assert.match(summary.stdout, /evaluation 'eval' @ 40: return=812\.5, success=0\.9, loss=0\.2 · return: paper 850, success: paper 0\.95 · 10 episodes, seeds 0-9/);
  });

  it('keeps a run’s folder and its checkpoints in the project’s data place as it goes (the local plan)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-data-'));
    const place = join(dir, 'place');
    const pylib = join(dir, '.reader', 'pylib');
    mkdirSync(join(pylib, 'koios'), { recursive: true });
    writeFileSync(join(pylib, 'koios_data.py'), readFileSync(resolve('companion/reader_companion/koios_data.py')));
    const { KOIOS_PY } = await load('src/lib/koiosHelper.ts');
    writeFileSync(join(pylib, 'koios', '__init__.py'), KOIOS_PY);
    const code = `
import os, koios_data
from koios_telemetry import Run
import koios
assert koios_data.enabled() and "a box" in koios_data.where(), koios_data.where()
p = koios_data.path("datasets/tiny.txt")
open(p, "w").write("data")
run = Run("d", config={"lr": 1})
run.log({"loss": 0.5}, step=1)
ck = koios.checkpoint("checkpoints", every_steps=1)
ck.on_save(lambda path: open(path, "w").write("weights"))
ck.step(1)
run.finish()
print(run.dir)
print(sorted(x["path"] for x in koios_data.ls()))
`;
    const ran = py(code, dir, { KOIOS_DATA: `local|${place}|a box`, PYTHONPATH: `${resolve('src/sim')}:${pylib}` });
    assert.equal(ran.status, 0, ran.stderr);
    const [runDir, listed] = ran.stdout.trim().split('\n').slice(-2);
    const runName = runDir.split('/').pop();
    const paths = JSON.parse(listed.replace(/'/g, '"'));
    // The dataset where path() put it, the run's events and run.json pushed at the end, the checkpoint and its sidecars copied as they were saved.
    assert.ok(paths.includes('datasets/tiny.txt'), listed);
    assert.ok(paths.includes(`runs/${runName}/events.jsonl`) && paths.includes(`runs/${runName}/run.json`), listed);
    assert.ok(paths.includes('checkpoints/step-00000001.pt') && paths.includes('checkpoints/latest.json') && paths.includes('checkpoints/step-00000001.pt.koios.json'), listed);
    assert.match(JSON.parse(readFileSync(join(place, 'runs', runName, 'run.json'), 'utf8')).status, /finished/);
    const run = tele.parseRun(runName, {}, readFileSync(join(place, 'runs', runName, 'events.jsonl'), 'utf8'));
    assert.match(run.notes[0].text, /^run folder kept in a box/);
    assert.equal(run.notes[0].tag, 'data');
    // Without a data place set, nothing of this happens and nothing is said.
    const bare = py('from koios_telemetry import Run\nr = Run("b")\nr.finish()\nimport koios_data\nprint(koios_data.enabled())', mkdtempSync(join(tmpdir(), 'sim-bare-')), { PYTHONPATH: `${resolve('src/sim')}:${pylib}` });
    assert.equal(bare.stdout.trim().split('\n').pop(), 'False', bare.stderr);
  });

  it('keeps data on a computer of yours through the Companion’s contents API, in pieces (the server plan)', async () => {
    const { createServer } = await import('node:http');
    const files = new Map();
    const dirs = new Set(['']);
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://x');
      const path = decodeURIComponent(url.pathname.replace(/^\/api\/contents\/?/, '')).replace(/\/$/, '');
      const say = (status, body) => (response.writeHead(status, { 'Content-Type': 'application/json' }), response.end(JSON.stringify(body)));
      if (request.headers.authorization !== 'token t-1') return say(403, { message: 'no' });
      if (request.method === 'GET') {
        if (dirs.has(path)) {
          const content = url.searchParams.get('content') === '1' ? [...[...dirs].filter((d) => d && d.slice(0, d.lastIndexOf('/') + 1).replace(/\/$/, '') === path && d !== path).map((d) => ({ name: d.split('/').pop(), path: d, type: 'directory' })), ...[...files.entries()].filter(([f]) => f.slice(0, f.lastIndexOf('/')) === path).map(([f, data]) => ({ name: f.split('/').pop(), path: f, type: 'file', size: data.length }))] : null;
          return say(200, { type: 'directory', path, content });
        }
        if (files.has(path)) return say(200, { type: 'file', path, size: files.get(path).length, last_modified: new Date().toISOString(), format: 'base64', content: url.searchParams.get('content') === '1' ? files.get(path).toString('base64') : null });
        return say(404, { message: 'not found' });
      }
      if (request.method === 'PUT') {
        let raw = '';
        request.on('data', (c) => (raw += c));
        request.on('end', () => {
          const body = JSON.parse(raw);
          if (body.type === 'directory') return (dirs.add(path), say(201, { type: 'directory', path }));
          const piece = Buffer.from(body.content, 'base64');
          if (body.chunk === undefined || body.chunk === 1) files.set(path, piece);
          else files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), piece]));
          say(201, { type: 'file', path, size: files.get(path).length });
        });
        return;
      }
      say(405, {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sim-server-'));
      const code = `
import os, koios_data
koios_data._Server.PIECE = 1024
assert koios_data.where().startswith("Ann's Mac · koios-data/p1"), koios_data.where()
big = koios_data.path("datasets/big.bin")
open(big, "wb").write(bytes(range(256)) * 10)   # 2560 bytes: three pieces
koios_data.save(big, "datasets/big.bin")
os.makedirs("runs/r", exist_ok=True); open("runs/r/events.jsonl", "w").write("{}")
s = koios_data.sync("runs"); print(s.now()); s.stop.set()
print(sorted(x["path"] for x in koios_data.ls()))
os.remove(big)
print(open(koios_data.fetch("datasets/big.bin"), "rb").read() == bytes(range(256)) * 10)
`;
      // Spawned, not spawnSync: the fake server lives on this event loop and has to answer while Python runs.
      // no_proxy: a container's HTTP proxy would otherwise be asked for 127.0.0.1 and never answer.
      const { spawn } = await import('node:child_process');
      const ran = await new Promise((done) => {
        const child = spawn(python, ['-c', code], { cwd: dir, env: { ...process.env, PYTHONPATH: `${resolve('src/sim')}:${resolve('companion/reader_companion')}`, KOIOS_HEADLESS: '0', KOIOS_DATA: `server|http://127.0.0.1:${port}|t-1|koios-data/p1|Ann's Mac`, no_proxy: '127.0.0.1,localhost', NO_PROXY: '127.0.0.1,localhost' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('close', (status) => done({ status, stdout, stderr }));
      });
      assert.equal(ran.status, 0, ran.stderr);
      const lines = ran.stdout.trim().split('\n');
      assert.equal(lines[0], '1');
      assert.deepEqual(JSON.parse(lines[1].replace(/'/g, '"')), ['datasets/big.bin', 'runs/r/events.jsonl']);
      assert.equal(lines[2], 'True');
      assert.equal(files.get('koios-data/p1/datasets/big.bin').length, 2560);
      assert.ok(dirs.has('koios-data/p1/runs/r'));
    } finally {
      server.close();
    }
  });

  it('writes videos and dreams the pane can play', { skip: !hasNumpy && 'no numpy' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-media-'));
    const code = `
import numpy as np
from koios_telemetry import Run
run = Run("m")
frames = [np.full((30, 40, 3), i * 20, np.uint8) for i in range(8)]
run.video("v", frames, step=5)
run.dream("d", frames, [f // 2 for f in frames], step=6, context=2)
run.finish()
`;
    const ran = py(code, dir);
    assert.equal(ran.status, 0, ran.stderr);
    const [runDir] = readdirSync(join(dir, 'runs'));
    const run = tele.parseRun(runDir, {}, readFileSync(join(dir, 'runs', runDir, 'events.jsonl'), 'utf8'));
    assert.equal(run.media.length, 1);
    assert.ok(['video', 'gif', 'frames'].includes(run.media[0].type));
    assert.equal(run.dreams[0].error.length, 8);
    assert.equal(run.dreams[0].error[0], 0, 'the context frames match');
    assert.ok(run.dreams[0].error[7] > 0);
    assert.ok(readdirSync(join(dir, 'runs', runDir, 'media')).length >= 2);
  });

  it('bridges another codebase’s metrics, as DreamerV3 and TD-MPC2 write them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-bridge-'));
    writeFileSync(join(dir, 'metrics.jsonl'), `${[{ step: 100, 'episode/score': 3, 'episode/length': 50 }, { step: 200, 'train/loss/model': 1.5 }, { step: 300, 'episode/score': 7, 'episode/length': 60 }].map(line).join('\n')}\n{"step": 400, "partial`);
    writeFileSync(join(dir, 'eval.csv'), 'step,episode_reward,episode_success\n1000,12.5,0\n2000,30.1,1\n');
    for (const [source, episodes] of [['metrics.jsonl', 2], ['eval.csv', 2]]) {
      const ran = spawnSync(python, [MODULE, 'bridge', source, '--name', 'b'], { cwd: dir, encoding: 'utf8', env: { ...process.env, KOIOS_HEADLESS: '0' } });
      assert.equal(ran.status, 0, ran.stderr);
      const runDir = ran.stdout.match(/bridged into (\S+)/)[1];
      const run = tele.parseRun(runDir, {}, readFileSync(join(dir, runDir, 'events.jsonl'), 'utf8'));
      assert.equal(run.episodes.length, episodes, source);
      if (source === 'eval.csv') assert.deepEqual(run.episodes.map((e) => e.success), [false, true]);
      else assert.ok(run.scalars.has('train/loss/model'));
    }
  });

  it('adds a note from the terminal, as an agent would', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-note-'));
    mkdirSync(join(dir, 'r'));
    writeFileSync(join(dir, 'r', 'events.jsonl'), events({ returns: [1, 2] }));
    const ran = spawnSync(python, [MODULE, 'note', 'r', 'lr 3e-4 -> 1e-4', '--by', 'agent'], { cwd: dir, encoding: 'utf8', env: { ...process.env, KOIOS_HEADLESS: '0' } });
    assert.equal(ran.status, 0, ran.stderr);
    const run = tele.parseRun('r', {}, readFileSync(join(dir, 'r', 'events.jsonl'), 'utf8'));
    assert.deepEqual(run.notes.map((n) => [n.text, n.by, n.step]), [['lr 3e-4 -> 1e-4', 'agent', 200]]);
  });

  it('runs the doctor without a simulator installed', () => {
    const ran = spawnSync(python, [MODULE, 'doctor', '--json', '--no-render'], { encoding: 'utf8', env: { ...process.env, KOIOS_HEADLESS: '0' } });
    assert.equal(ran.status, 0, ran.stderr);
    const d = JSON.parse(ran.stdout.trim().split('\n').pop());
    assert.equal(typeof d.installed.gymnasium, 'boolean');
    assert.ok(Array.isArray(d.gpus));
  });
});

describe('the code the pane runs on the machine', { skip: !python && 'no python3' }, () => {
  it('lists the runs and reads the focused one from an offset, whole lines only', () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-read-'));
    mkdirSync(join(root, 'runs', 'a'), { recursive: true });
    mkdirSync(join(root, '.reader', 'skip'), { recursive: true });
    writeFileSync(join(root, '.reader', 'skip', 'events.jsonl'), '{}\n');
    const text = events({ returns: [1, 2, 3] });
    writeFileSync(join(root, 'runs', 'a', 'events.jsonl'), `${text}{"kind": "epis`);
    writeFileSync(join(root, 'runs', 'a', 'run.json'), JSON.stringify({ name: 'a', status: 'running', argv: ['x'] }));
    const first = JSON.parse(py(tele.READ_CODE(root, { dir: join('runs', 'a'), offset: 0 })).stdout.trim());
    assert.deepEqual(first.runs.map((r) => r.dir), [join('runs', 'a')]);
    assert.equal(first.runs[0].meta.argv, undefined);
    assert.equal(first.focus.text, text);
    const second = JSON.parse(py(tele.READ_CODE(root, { dir: join('runs', 'a'), offset: first.focus.to })).stdout.trim());
    assert.equal(second.focus.text, '');
  });

  it('fetches media in pieces, and nothing outside the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-media-read-'));
    mkdirSync(join(root, 'runs', 'a', 'media'), { recursive: true });
    writeFileSync(join(root, 'runs', 'a', 'media', 'v.mp4'), Buffer.from([0, 1, 2, 255]));
    const got = JSON.parse(py(tele.MEDIA_CODE(root, join('runs', 'a'), 'media/v.mp4', 1)).stdout.trim());
    assert.equal(got.size, 4);
    assert.deepEqual([...Buffer.from(got.data, 'base64')], [1, 2, 255]);
    const outside = py(tele.MEDIA_CODE(root, join('runs', 'a'), '../../../../etc/passwd', 0));
    assert.notEqual(outside.status, 0);
  });
});

describe('the Companion’s port ticket', () => {
  it('is the one the Companion computes (extension.port_ticket; its test pins the same vector)', async () => {
    const { portTicket, portUrl } = await load('src/lib/companion.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
    assert.equal(await portTicket('t', 9090), '5c42279cfbe380ac8195601bb240a93b1448e359');
    assert.notEqual(await portTicket('t', 9091), await portTicket('t', 9090));
    assert.equal(portUrl({ url: 'https://pc.example' }, 'abc', 9090, 'proxy'), 'https://pc.example/companion/ports/abc/9090/proxy');
  });
});

describe('sync and binary files', () => {
  it('leaves videos, images and weights where they are', async () => {
    const { isBinaryPath } = await load('src/lib/playground.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
    for (const path of ['runs/a/media/x.mp4', 'out.png', 'model.pt', 'w.safetensors', 'd.npz']) assert.ok(isBinaryPath(path), path);
    for (const path of ['runs/a/events.jsonl', 'run.json', 'main.py', 'results.csv']) assert.ok(!isBinaryPath(path), path);
  });
});
