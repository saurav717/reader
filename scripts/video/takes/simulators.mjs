/**
 * "Simulators": the Playground's "A simulation" start — the picker of 31
 * simulators by family (a few families lit), MuJoCo picked, HalfCheetah-v5
 * and the one-file PPO template, placed on this computer (the Companion) —
 * then the project made, with setup and the first run waiting in the
 * console; the Sim pane on a PPO run as it goes (findings, the episode
 * return climbing, the recorded videos, the live view), a world-model run's
 * dream (real · imagined · difference, and the error over the horizon); the
 * PPO run ending and filed by itself, and its record in the project's
 * Logbook → Experiments, with notes.
 *
 * Real: the app, the real Companion (companion/, run from .video/jvenv, as in
 * companion.mjs) on 127.0.0.1:47341 with HOME at .video/simwork/home, its
 * kernel reading the runs off disk, the filing (copies to the Companion's
 * experiments/ folder and the logbook in IndexedDB). The runs themselves are
 * real runs of this project's own ppo.py and world_model.py (made by the
 * app's simProject, run on this machine's CPU with MuJoCo/OSMesa in
 * .video/simvenv; see .video/simwork/cheetah), REPLAYED into the new
 * project's runs/ folder by this take: a run that is already part-way
 * along when the pane opens, the rest of its lines written over ~40 s (the
 * last part of training sped up), its videos copied as their lines land,
 * and the live view fed with frames of its last recorded video.
 *
 * Stood in for: the notes Ask AI's model writes (api.anthropic.com, a fixed
 * text streamed, written from the run's real numbers); the Companion's name
 * and hardware put as a Mac would say them (continuity with companion.mjs);
 * a research Project ("Learning to run") seeded in the library, linked to the
 * playground made on camera (its id fixed for that one create).
 *
 * Needs, once: python3 -m venv .video/simvenv && .video/simvenv/bin/pip install "gymnasium[mujoco]" imageio imageio-ffmpeg torch (cpu),
 * apt-get install libosmesa6, and the recorded runs in .video/simwork/cheetah/runs (python ppo.py --total-steps 400000; python world_model.py).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib.mjs';

const WORK = path.join(ROOT, '.video/simwork');
const VENV = path.join(ROOT, '.video/jvenv');
const HOME = path.join(ROOT, '.video/shome'); // short: the kernel's ipc socket paths must fit
const RECORDED = path.join(WORK, 'cheetah/runs');
const PORT = 47341;
// The kernels' sockets: a path under the repository is longer than a Unix socket's name may be.
const RUNTIME = '/tmp/koios-sim-video';
const TOKEN = 'video-sim-token-0123456789abcdefABCDEF';
const CID = 'a1b2c3d4e5f60718';
const NAME = 'Saurav’s MacBook Pro';
const HARDWARE = 'Apple M3 Pro · 12 cores · 36 GB';
const PG_ID = 'c4ee7a01';
const PROJECT_ID = 'p-run';
const PROJECT_NAME = 'Learning to run';
const FOLDER = path.join(HOME, 'Reader/playgrounds/mujoco-halfcheetah-v5');

// ------------------------------------------------------------ the Companion ---

let child = null;
function startCompanion() {
  rmSync(path.join(HOME, 'Reader'), { recursive: true, force: true });
  mkdirSync(RUNTIME, { recursive: true });
  mkdirSync(path.join(HOME, 'Reader'), { recursive: true });
  mkdirSync(path.join(HOME, '.reader-companion'), { recursive: true });
  writeFileSync(path.join(HOME, '.reader-companion/config.json'), JSON.stringify({ token: TOKEN, id: CID, root: path.join(HOME, 'Reader'), site: 'http://localhost:8080', name: NAME, python: path.join(VENV, 'bin/python'), tunnel: false, port: PORT, tls_port: PORT + 10 }));
  child = spawn(path.join(VENV, 'bin/reader-companion'), ['--no-browser', '--no-tunnel'], {
    env: { ...process.env, HOME, SHELL: '/bin/bash', READER_COMPANION_HOME: path.join(HOME, '.reader-companion'), JUPYTER_RUNTIME_DIR: RUNTIME, VIRTUAL_ENV_DISABLE_PROMPT: '1', PATH: `${path.join(VENV, 'bin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  process.on('exit', () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // gone already
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Companion did not start in 60 s')), 60_000);
    let log = '';
    const read = (chunk) => {
      log += String(chunk);
      if (log.includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (status) => reject(new Error(`the Companion exited (${status}): ${log.slice(-800)}`)));
  });
}

// ------------------------------------------------------------ the replays ---

const now = () => Date.now() / 1000;
const runDir = (prefix) => readdirSync(RECORDED).filter((d) => d.startsWith(prefix)).sort().at(-1);

/** A recorded run, written into the project's runs/ as if it were going now. */
class Replay {
  constructor(prefix, { leave = [] } = {}) {
    this.id = runDir(prefix);
    this.src = path.join(RECORDED, this.id);
    this.dst = path.join(FOLDER, 'runs', this.id);
    this.lines = readFileSync(path.join(this.src, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((text) => ({ text, e: JSON.parse(text) })).filter((l) => !leave.includes(l.e.kind));
    this.meta = JSON.parse(readFileSync(path.join(this.src, 'run.json'), 'utf8'));
    this.at = 0;
    this.lastStep = 0;
  }

  /** Lines up to the first one past `fraction` of the run's steps, written at once, the newest at about `ago` seconds ago. */
  prime(fraction, ago = 1) {
    const maxStep = Math.max(...this.lines.map((l) => l.e.step ?? 0));
    let cut = this.lines.findIndex((l) => (l.e.step ?? 0) > maxStep * fraction);
    if (cut < 0) cut = this.lines.length - 1;
    // Never past the end line.
    cut = Math.min(cut, this.endAt());
    this.shift = now() - ago - this.lines[cut - 1].e.t;
    mkdirSync(path.join(this.dst, 'media'), { recursive: true });
    this.writeMeta('running');
    this.write(this.lines.slice(0, cut), (e) => e.t + this.shift);
    this.at = cut;
  }

  endAt() {
    const at = this.lines.findIndex((l) => l.e.kind === 'end');
    return at < 0 ? this.lines.length : at;
  }

  writeMeta(status) {
    const meta = { ...this.meta, started: this.meta.started + this.shift, status };
    delete meta.ended;
    if (status !== 'running') meta.ended = now();
    writeFileSync(path.join(this.dst, 'run.json'), JSON.stringify(meta, null, 2));
  }

  write(lines, time) {
    let text = '';
    for (const { e } of lines) {
      for (const key of ['path']) if (typeof e[key] === 'string' && existsSync(path.join(this.src, e[key]))) copyFileSync(path.join(this.src, e[key]), path.join(this.dst, e[key]));
      const out = { ...e, t: +time(e).toFixed(3) };
      if (typeof e.step === 'number') this.lastStep = e.step;
      text += `${JSON.stringify(out)}\n`;
    }
    if (text) writeFileSync(path.join(this.dst, 'events.jsonl'), text, { flag: 'a' });
  }

  /** The rest (up to `fraction` of the lines left, or to the end), over `seconds`, a batch every half second. */
  play(seconds, { until = 1, onEnd } = {}) {
    const from = this.at;
    const end = this.endAt();
    const to = until >= 1 ? this.lines.length : Math.min(end, from + Math.round((end - from) * until));
    const t0 = this.lines[from].e.t;
    const t1 = this.lines[to - 1].e.t;
    const started = now();
    return new Promise((resolve) => {
      const tick = () => {
        const due = t0 + ((now() - started) / seconds) * (t1 - t0);
        let i = this.at;
        while (i < to && this.lines[i].e.t <= due) i++;
        if (i > this.at) {
          this.write(this.lines.slice(this.at, i), () => now());
          this.at = i;
        }
        if (this.at >= to) {
          if (this.lines[to - 1].e.kind === 'end') {
            this.writeMeta(this.lines[to - 1].e.status ?? 'finished');
            onEnd?.();
          }
          clearInterval(this.timer);
          resolve();
        }
      };
      this.timer = setInterval(tick, 500);
      tick();
    });
  }

  /** The live view, while the pane asks for it (live.want fresh): frames of the run's newest recorded video. */
  feedLive(frames) {
    let n = 0;
    let index = 0;
    this.live = setInterval(() => {
      try {
        const want = path.join(this.dst, 'live.want');
        if (!existsSync(want) || now() - Number(readFileSync(want, 'utf8')) > 10) return;
        n++;
        index = (index + 1) % frames.length;
        writeFileSync(path.join(this.dst, 'live.jpg'), frames[index]);
        writeFileSync(path.join(this.dst, 'live.json'), JSON.stringify({ t: now(), step: this.lastStep, frame: n, episode: this.lines.slice(0, this.at).filter((l) => l.e.kind === 'episode').length, info: { ret: +(index * 2.9).toFixed(1), length: index * 2 } }));
      } catch {
        // next frame
      }
    }, 80);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.live);
  }
}

/** The frames of the PPO run's last video, as JPEGs, for its live view. */
function liveFrames(replay) {
  const videos = replay.lines.filter((l) => l.e.kind === 'media').map((l) => l.e.path);
  const last = path.join(replay.src, videos.at(-1));
  const out = path.join(WORK, 'live');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-i', last, '-vf', 'fps=12', '-q:v', '3', path.join(out, 'f%04d.jpg')]);
  return readdirSync(out).sort().map((f) => readFileSync(path.join(out, f)));
}

// ------------------------------------------------------------- the notes ---

const NOTES = `**What was tried.** PPO from \`ppo.py\` as it comes — 8 environments, 256 steps each per update, lr 3e-4 — on MuJoCo's HalfCheetah-v5, 400k environment steps on this computer's CPU.

**What happened.** __RETURNS__ The policy's entropy fell slowly (8.5 → 7.6 nats) and approx_kl stayed far under 0.05, so the updates were steady. The critic's explained variance swings between 0.2 and 0.97: the value function is the weak part.

**Trust it?** One seed, so treat the shape as real and the exact number as rough.

**Next.** Run three seeds to see the spread, then go to 1M steps: published PPO numbers for HalfCheetah are at 1M, and the curve is still climbing here.`;

function standIns({ notes }) {
  try {
    localStorage.setItem('reader.anthropic-key', 'sk-ant-video-stand-in');
  } catch {
    // the notes will say they failed
  }
  // The playground made on camera gets the id the seeded Project links to: armed just before Create, used once.
  const uuid = crypto.randomUUID.bind(crypto);
  crypto.randomUUID = () => {
    const forced = window.__forceUuid;
    if (forced) {
      window.__forceUuid = null;
      return forced;
    }
    return uuid();
  };
  const enc = new TextEncoder();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
    if ((init?.method || 'GET') === 'OPTIONS') return new Response(null, { status: 204 });
    const body = JSON.parse(init?.body ?? '{}');
    const prompt = JSON.stringify(body.messages ?? '');
    const returns = prompt.match(/Return:\*\* first (-?[\d.]+) → last (-?[\d.]+) · best (-?[\d.]+)/);
    const text = notes.replace('__RETURNS__', returns ? `The episode return climbed from ${Math.round(+returns[1])} in the first episodes to ${Math.round(+returns[2])} at the end (best ${Math.round(+returns[3])}): the cheetah learned to run forward instead of flailing.` : 'The episode return climbed steadily.');
    return new Response(
      new ReadableStream({
        async start(controller) {
          const ev = (type, data) => controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
          await wait(700);
          ev('message_start', { message: { id: 'msg_v', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          for (const piece of text.match(/\S+\s*|\s+/g) || []) {
            ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
            await wait(18);
          }
          ev('content_block_stop', { index: 0 });
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } });
          ev('message_stop', {});
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
}

// ----------------------------------------------------------------- setup ---

export async function setup(context) {
  await startCompanion();
  // Only this take's Companion: nothing found on the usual port (another take's may be there).
  await context.route(/^https?:\/\/127\.0\.0\.1:(47321|47331)\//, (route) => route.abort());
  await context.route(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/companion/info`), async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (body && typeof body === 'object' && 'name' in body) Object.assign(body, { hardware: HARDWARE, root: '~/Reader' });
    return route.fulfill({ response, body: JSON.stringify(body) });
  });
  // The picker's clips, as fetched once from the Gymnasium docs.
  await context.route('https://gymnasium.farama.org/_images/*.gif', (route) => {
    const file = path.join(WORK, 'previews', path.basename(new URL(route.request().url()).pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/gif', body: readFileSync(file) });
  });
  await context.addInitScript(standIns, { notes: NOTES });
}

const SERVER = { id: 's-mac', name: NAME, url: `http://127.0.0.1:${PORT}/`, token: TOKEN, where: 'pc', companionId: CID };

export async function prepare({ page, arrive }) {
  await arrive({ storage: { 'reader.playground.servers': [SERVER], 'reader.experiments': { autoFile: true, notes: 'model', where: { serverId: 's-mac' } } } });
  await page.evaluate(
    async ({ PROJECT_ID, PROJECT_NAME, PG_ID }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('reader', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('collections', 'readwrite');
        const at = new Date(Date.now() - 3 * 86400_000).toISOString();
        tx.objectStore('collections').put({ id: PROJECT_ID, name: PROJECT_NAME, color: '#2f7d6d', createdAt: at, project: { question: 'How fast can PPO teach a simulated cheetah to run — and can a world model predict what it sees?', startedAt: at, roles: {}, todos: [], playgroundId: PG_ID } });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { PROJECT_ID, PROJECT_NAME, PG_ID },
  );
  await page.reload({ waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

// ------------------------------------------------------------------ take ---

const hold = (page, ms) => page.waitForTimeout(ms);
const SHOTS = path.join(WORK, 'shots');
const shot = (page, name) => (process.env.SHOTS ? (mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: path.join(SHOTS, `${name}.png`) })) : undefined);

export default async function ({ page, pointer, mark, spot, unspot }) {
  // Its final evaluation is left out: ppo.py evaluates without the observation normalisation it trained with (see the report).
  const ppo = new Replay('ppo-', { leave: ['evaluation'] });
  const wm = new Replay('world-model-');
  const frames = liveFrames(ppo);
  try {
    await hold(page, 1200);

    mark('playground');
    await pointer.key('p', 'P');
    await page.locator('.pg-hero').waitFor();
    const card = page.locator('.pg-start', { hasText: 'A simulation' });
    await card.scrollIntoViewIfNeeded();
    await hold(page, 1200);

    mark('sim-card');
    await spot(card);
    await pointer.moveTo(card);
    await hold(page, 2800);

    mark('picker');
    await pointer.click(card);
    const picker = page.locator('.sim-picker');
    await picker.waitFor();
    await spot(page.locator('.sim-picker-grid'));
    await pointer.moveTo(page.getByRole('radio', { name: /^All · / }));
    await hold(page, 2800);

    for (const [beat, label] of [
      ['family-locomotion', 'Physics & locomotion'],
      ['family-hands', 'Arms & hands'],
      ['family-games', 'Games & open worlds'],
      ['family-driving', 'Driving'],
    ]) {
      mark(beat);
      await pointer.click(picker.getByRole('radio', { name: label, exact: true }), { pause: 300 });
      await spot([picker.getByRole('radio', { name: label, exact: true }), page.locator('.sim-picker-grid')]);
      await hold(page, 2300);
    }

    mark('mujoco');
    await pointer.click(picker.getByRole('radio', { name: /^All · / }), { pause: 400 });
    const mujoco = page.locator('.sim-card', { hasText: 'MuJoCo (Gymnasium)' });
    await pointer.click(mujoco);
    await page.locator('.sim-preview img').waitFor();
    await spot([mujoco, page.locator('.sim-picker-side')]);
    await hold(page, 3000);

    mark('environment');
    const cheetah = page.locator('.sim-picker-list label', { hasText: 'HalfCheetah' });
    await spot([page.locator('.sim-preview'), page.getByRole('radiogroup', { name: 'Environment' })]);
    await pointer.click(cheetah);
    await hold(page, 2400);

    mark('template');
    const templates = page.getByRole('radiogroup', { name: 'Template' });
    await templates.scrollIntoViewIfNeeded();
    await spot(templates);
    await pointer.click(templates.locator('label', { hasText: 'PPO (one file)' }));
    await hold(page, 2800);

    mark('where');
    await pointer.click(page.getByRole('button', { name: 'Next: where it runs' }));
    const sheet = page.locator('.pg-sheet');
    await sheet.waitFor();
    const pc = page.locator('.pg-mode', { has: page.locator('.pg-mode-top b', { hasText: /^This PC$/ }) });
    await pointer.click(pc.locator('.pg-mode-top'));
    await spot([page.locator('.pg-title-field'), pc]);
    await hold(page, 2600);

    mark('create');
    await page.evaluate((id) => (window.__forceUuid = `${id}-0000-4000-8000-000000000000`), PG_ID);
    await pointer.click(page.locator('.pg-sheet-foot .btn.primary'));
    await page.locator('.vs-activity').waitFor({ timeout: 20_000 });
    unspot();
    const pgFile = path.join(FOLDER, '.reader/playground.json');
    for (let i = 0; i < 40 && !existsSync(pgFile); i++) await hold(page, 250);
    if (!existsSync(pgFile) || !readFileSync(pgFile, 'utf8').includes(PG_ID)) console.log('  ! the playground did not get the fixed id: the logbook beat will fail');
    // The runs: the world model's already along, PPO's at a third.
    wm.prime(Number(process.env.WM_FRAC || 0.45), 20);
    ppo.prime(0.3, 1);
    ppo.feedLive(frames);
    await hold(page, 900);
    // The kernel on this computer, started: the pane and the filing read the runs through it.
    await pointer.click(page.locator('.pg-chip').first(), { pause: 500 });
    await pointer.click(page.getByRole('menuitem', { name: 'Connect now' }), { pause: 300 });
    await page.locator('.pg-chip', { hasText: 'idle' }).first().waitFor({ timeout: 30_000 });
    await spot(page.locator('.pg-tree.vs-sidebar'));
    await hold(page, 1600);

    mark('console');
    await pointer.click(page.getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name: /console/i }));
    await hold(page, 600);
    await spot(page.locator('.pg-console, .vs-panel').first());
    await hold(page, 2600);
    await shot(page, 'console');

    mark('sim-pane');
    await pointer.click(page.getByRole('button', { name: 'Simulation' }));
    const pane = page.locator('.sim-pane');
    await pane.locator('.sim-status').waitFor({ timeout: 20_000 });
    const playing = ppo.play(42, { onEnd: () => mark('ppo-ended') });
    await spot(page.locator('.sim-status'));
    await hold(page, 1500);
    await shot(page, 'sim');

    mark('returns');
    const returns = pane.locator('.chart, figure, section').filter({ hasText: 'Episode return' }).first();
    await spot(returns);
    await pointer.moveTo(returns);
    await hold(page, 4000);
    await shot(page, 'returns');

    mark('findings');
    await spot(pane.locator('.sim-findings'));
    await hold(page, 2800);

    mark('videos');
    const videos = pane.locator('.sim-section-open', { hasText: 'Videos' });
    await videos.scrollIntoViewIfNeeded();
    await videos.locator('video').waitFor({ timeout: 15_000 });
    await spot(videos);
    await hold(page, 3200);
    await shot(page, 'videos');

    mark('live');
    await pane.evaluate((el) => el.closest('[class*="scroll"], .pg-right, aside')?.scrollTo?.({ top: 0, behavior: 'smooth' }));
    await page.locator('.sim-live-start').scrollIntoViewIfNeeded();
    await pointer.click(page.locator('.sim-live-start'));
    await page.locator('.sim-live-frame img').waitFor({ timeout: 15_000 });
    await spot(page.locator('.sim-live'));
    await hold(page, 3500);
    await shot(page, 'live');

    mark('world-model');
    await pointer.click(page.locator('.sim-live-stop'), { pause: 300 });
    const select = pane.getByRole('combobox', { name: 'Run' });
    await pointer.moveTo(select);
    await select.selectOption(`runs/${wm.id}`);
    void wm.play(60, { until: 0.4 });
    const dream = pane.locator('.sim-section-open', { hasText: 'World model' });
    await dream.waitFor({ timeout: 20_000 });
    await dream.scrollIntoViewIfNeeded();
    await dream.locator('video').waitFor({ timeout: 15_000 });
    await spot(dream);
    await hold(page, 4500);
    await shot(page, 'dream');

    mark('filed');
    await playing;
    const toast = page.locator('.xp-toast');
    await toast.waitFor({ timeout: 40_000 });
    await spot(toast);
    await pointer.moveTo(toast);
    await toast.getByText(/notes written/).waitFor({ timeout: 20_000 }).catch(() => undefined);
    await hold(page, 2600);
    await shot(page, 'toast');

    mark('logbook');
    await pointer.click(toast.getByRole('button', { name: new RegExp(`${PROJECT_NAME}.s logbook`) }));
    const row = page.locator('.xp-item').first();
    await row.waitFor({ timeout: 20_000 });
    unspot();
    await hold(page, 1000);
    await spot(row);
    await hold(page, 2400);

    mark('experiment');
    await pointer.click(row.locator('.xp-row'));
    await row.locator('.xp-body').waitFor();
    await spot(row);
    await hold(page, 3500);
    await shot(page, 'experiment');
    await page.mouse.wheel(0, 300);
    await hold(page, 2500);
    unspot();
    await hold(page, 1000);
  } finally {
    ppo.stop();
    wm.stop();
  }
}
