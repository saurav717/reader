// The Explain tab's pieces (src/lib/projectExplainer.ts), the idle stop's question to the machine (src/lib/idleWork.ts),
// and the Sim pane's reading of runs kept in the project's own folder (src/lib/simTelemetry.ts).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, load } from './bundle.mjs';

const explainer = await load('src/lib/projectExplainer.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
const sim = await load('src/lib/simTelemetry.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
const idle = await load('src/lib/idleWork.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
after(cleanup);

describe('the explainer', () => {
  it('cuts the answer at its illustrations', () => {
    const blocks = explainer.parseExplainer(
      [
        '## In short',
        'A PPO agent for LunarLander.',
        '```figure caption="The loop"',
        '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>',
        '```',
        '```chart',
        'run: runs/ppo-1',
        'metric: returns',
        'title: Return per episode',
        '```',
        '```media',
        'path: `runs/ppo-1/videos/ep100.mp4`',
        'caption: The lander at episode 100',
        '```',
        '```python file="train.py"',
        'loss = -adv * ratio',
        '```',
        '```chart',
        'console: all',
        'metric: loss',
        '```',
        'And the rest, still being written: ```chart',
      ].join('\n'),
    );
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['text', 'figure', 'chart', 'media', 'code', 'chart', 'text'],
    );
    assert.equal(blocks[1].caption, 'The loop');
    assert.deepEqual(blocks[2], { kind: 'chart', run: 'runs/ppo-1', console: false, metric: 'returns', title: 'Return per episode' });
    assert.deepEqual(blocks[3], { kind: 'media', path: 'runs/ppo-1/videos/ep100.mp4', caption: 'The lander at episode 100' });
    assert.equal(blocks[4].file, 'train.py');
    assert.equal(blocks[5].console, true);
    assert.equal(blocks[5].title, 'loss');
  });

  it('charts a run by its returns or a logged scalar, and the console by a printed name', () => {
    const events = [
      { t: 1, kind: 'episode', step: 100, return: 10, length: 50 },
      { t: 2, kind: 'episode', step: 200, return: 30, length: 60 },
      { t: 3, kind: 'scalars', step: 200, values: { 'loss/policy': 0.5 } },
      { t: 4, kind: 'scalars', step: 300, values: { 'loss/policy': 0.25 } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const run = sim.parseRun('runs/a', { name: 'a' }, `${events}\n`);
    const series = { returns: sim.returnSeries, success: sim.successSeries, length: sim.lengthSeries };
    assert.ok(explainer.runChartSeries(run, 'returns', series).length >= 1);
    const scalar = explainer.runChartSeries(run, 'loss/policy', series);
    assert.ok(scalar.length >= 1, 'the logged scalar is charted');
    const printed = explainer.consoleChartSeries([{ label: '$ python train.py', text: 'step 1 loss 0.9\nstep 2 loss 0.5\nstep 3 loss 0.3\n' }], 'loss');
    assert.equal(printed[0]?.name, '$ python train.py');
  });

  it('reads an answer to the ask bar: a question’s note, or a change’s note and the page, as it streams', () => {
    assert.deepEqual(explainer.readAskReply('<note>It trains for **2M** steps.</note>'), { note: 'It trains for **2M** steps.', page: null, pageDone: false });
    assert.deepEqual(explainer.readAskReply('<note>Made it simpler.</note>\n<explainer>\n## In short\nA lander'), { note: 'Made it simpler.', page: '## In short\nA lander', pageDone: false });
    assert.equal(explainer.readAskReply('<note>x</note><explainer>## A\nb</explainer>').pageDone, true);
    assert.equal(explainer.readAskReply('Plain words, no tags').note, 'Plain words, no tags');
    const message = explainer.askMessage({ where: 'w', listing: [], files: [], agents: '', console: [], runs: [], metrics: [], media: [] }, '## In short\nold', 'simpler', 'In short');
    assert.match(message, /<explainer_now>/);
    assert.match(message, /<request section="In short">\s*simpler\s*<\/request>/);
    assert.doesNotMatch(message, /Write the Explainer for this project/);
  });

  it('gives a run in a few lines, with what looks wrong', () => {
    const run = sim.parseRun('runs/a', { name: 'lander', sim: 'gymnasium/LunarLander-v3' }, `${JSON.stringify({ t: 1, kind: 'episode', step: 10, return: -100 })}\n`);
    const digest = explainer.runDigest(run, 10);
    assert.match(digest, /name: lander; simulator: gymnasium\/LunarLander-v3/);
    assert.match(digest, /findings:/);
  });
});

/** A FileHost over a plain object of files, for the kept-copy readers. */
function memoryHost(files) {
  const entries = (dir) => {
    const prefix = dir ? `${dir}/` : '';
    const names = new Map();
    for (const [path, body] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [name, ...more] = rest.split('/');
      names.set(name, more.length ? { name, path: prefix + name, type: 'directory', size: null, modified: null } : { name, path: prefix + name, type: 'file', size: body.length, modified: '2026-10-20T10:00:00Z' });
    }
    return [...names.values()];
  };
  return {
    label: 'Laptop',
    list: async (dir = '') => entries(dir),
    read: async (path) => (path in files ? files[path] : null),
    write: async () => undefined,
    readBase64: async (path) => (path in files ? Buffer.from(files[path]).toString('base64') : null),
  };
}

describe('runs kept in the project folder', () => {
  const host = memoryHost({
    'train.py': 'print(1)\n',
    'runs/ppo-1/events.jsonl': `${JSON.stringify({ t: 1, kind: 'episode', step: 5, return: 2 })}\n${JSON.stringify({ t: 2, kind: 'episode', step: 9, return: 4 })}\n`,
    'runs/ppo-1/run.json': JSON.stringify({ name: 'ppo-1', status: 'finished' }),
    'runs/ppo-1/videos/ep.mp4': 'not really a video',
    'data/big/events.jsonl': 'left out: data/ is pruned\n',
  });

  it('lists them, reads one whole, and then only what is new', async () => {
    const runs = await sim.listKeptRuns(host);
    assert.deepEqual(
      runs.map((r) => [r.dir, r.meta.name, r.kept]),
      [['runs/ppo-1', 'ppo-1', true]],
    );
    const first = await sim.readKeptRun(host, { dir: 'runs/ppo-1', offset: 0 });
    assert.equal(sim.parseRun('runs/ppo-1', {}, first.text).episodes.length, 2);
    const again = await sim.readKeptRun(host, { dir: 'runs/ppo-1', offset: first.to });
    assert.equal(again.text, '');
  });

  it('hands over a kept run’s video from the folder, not the machine', async () => {
    sim.readRunsFrom('playgrounds/p', host, ['runs/ppo-1']);
    const blob = await sim.readMedia('playgrounds/p', 'runs/ppo-1', 'videos/ep.mp4');
    assert.equal(blob.type, 'video/mp4');
    assert.equal(await blob.text(), 'not really a video');
    sim.readRunsFrom('playgrounds/p', null);
  });
});

describe('the idle stop asks the machine', () => {
  const probe = join(mkdtempSync(join(tmpdir(), 'probe-')), 'probe.py');
  writeFileSync(probe, idle.WORK_PROBE);
  const ask = () => JSON.parse(spawnSync('python3', [probe], { encoding: 'utf8' }).stdout.trim().split('\n').pop());

  it('sees a process busy on the CPU', () => {
    const busy = spawnSync('python3', ['-c', 'import subprocess,sys; p=subprocess.Popen([sys.executable,"-c","while True: pass"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); import time; time.sleep(0.3); print(p.pid)'], { encoding: 'utf8' });
    const pid = Number(busy.stdout.trim());
    try {
      assert.ok(ask().some((line) => line.includes('while True') && line.includes('busy on the CPU')));
    } finally {
      process.kill(pid);
    }
  });
});

describe('finding runs in a big folder', () => {
  it('walks runs/ first and never into a run’s own videos, replays or checkpoints', async () => {
    const files = { 'README.md': '#' };
    for (let r = 0; r < 30; r++) {
      files[`runs/run-${r}/events.jsonl`] = '{}\n';
      for (let k = 0; k < 50; k++) files[`runs/run-${r}/replays/battle-${k}/log.txt`] = 'x';
      files[`runs/run-${r}/media/clip.mp4`] = 'v';
    }
    for (let c = 0; c < 200; c++) files[`checkpoints/step-${c}/model.pt`] = 'w';
    const listed = [];
    const host = memoryHost(files);
    const counting = { ...host, list: async (path = '') => (listed.push(path), host.list(path)) };
    const runs = await sim.listKeptRuns(counting);
    assert.equal(runs.length, 30);
    assert.ok(!listed.some((p) => /replays|media|checkpoints\//.test(p)), `walked ${listed.filter((p) => /replays|media|checkpoints\//.test(p)).slice(0, 3)}`);
    assert.ok(listed.length <= 40, `listed ${listed.length} folders`);
  });
});
