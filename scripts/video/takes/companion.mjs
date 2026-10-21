/**
 * "Your computer, connected": the Playground's Connect this computer card
 * (the Koios app, the command line, VS Code), then the real Companion
 * (companion/, run from .video/jvenv) found, paired with the code it
 * prints, and listed under Your compute as "Saurav’s MacBook Pro"; where
 * code runs (Colab, this PC, code here and compute on a GPU box); a
 * project made on this computer, with a terminal there; and Settings →
 * Compute & playgrounds, and Updates, with the computer in them.
 *
 * Needs, once:  python3 -m venv .video/jvenv && .video/jvenv/bin/pip install jupyter_server ipykernel terminado numpy -e companion
 * The Companion runs with HOME at .video/chome (its config and ~/Reader there), on 127.0.0.1:47321.
 * Its own answers pass through; only its name of the hardware and folder are put as a Mac would say them,
 * show-code says it showed the code, and it stays hidden (as if not started yet) until the take starts it.
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { ROOT, json } from '../lib.mjs';

const VENV = path.join(ROOT, '.video/jvenv');
const HOME = path.join(ROOT, '.video/chome');
// The lab's A100 box: a real Jupyter server on this computer (port 8899, its own HOME and folder), reached by the page and
// by the Companion as a100.lab.example.org (scripts/video/stage/sitecustomize.py, and the routes below). Its nvidia-smi is
// .video/a100/bin's stand-in: this computer has no GPU.
const A100 = path.join(ROOT, '.video/a100');
const A100_HOST = 'a100.lab.example.org';
const A100_PORT = 8899;
const A100_TOKEN = 'lab-a100-token';
const STAGE = path.join(ROOT, 'scripts/video/stage');
const stageEnv = { PYTHONPATH: STAGE, KOIOS_STAGE_HOSTS: `${A100_HOST}=${A100_PORT}` };
const NAME = 'Saurav’s MacBook Pro';
const HARDWARE = 'Apple M3 Pro · 12 cores · 36 GB';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** A small training run: steps and a falling loss, the GPU it found, and a checkpoint under checkpoints/ (left to the data place). */
const TRAIN = `import os, re, subprocess, time
import numpy as np

found = re.search(r'NVIDIA [A-Z0-9][\\w-]+', subprocess.run(['nvidia-smi'], capture_output=True, text=True).stdout)
gpu = found.group(0) if found else 'cpu'
print(f"device: {gpu}")
rng = np.random.default_rng(0)
w = rng.normal(size=(64, 8))
loss = 2.9
for step in range(0, 1200, 200):
    loss *= 0.86 + 0.02 * rng.random()
    print(f"step {step:5d}  loss {loss:.3f}  expert load {0.9 + 0.08 * rng.random():.2f}", flush=True)
    time.sleep(0.45)
os.makedirs('checkpoints', exist_ok=True)
np.save('checkpoints/router.npy', w)
os.replace('checkpoints/router.npy', 'checkpoints/router.pt')
print("saved checkpoints/router.pt")
`;

let companionUp = false; // hidden from the page until the take "starts" it
let code = '';
let child = null;

function killOnExit(proc) {
  process.on('exit', () => {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      // gone already
    }
  });
}

/** A mount of the folder on the A100 box (its daemon outlives the kernel that started it): stopped, and let go of. */
function cleanMounts() {
  const root = path.join(A100, 'root');
  try {
    execSync(`pkill -f "koios_mount.py serve .*--at=${root}/"`, { stdio: 'ignore' });
  } catch {
    // none running
  }
  for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
    const at = line.split(' ')[1]?.replace(/\\040/g, ' ');
    if (at?.startsWith(`${root}/`)) execSync(`umount -l "${at}"`, { stdio: 'ignore' });
  }
}

/** The A100 box's Jupyter server, fresh each take. */
function startA100() {
  cleanMounts();
  process.on('exit', cleanMounts);
  rmSync(path.join(A100, 'root'), { recursive: true, force: true });
  mkdirSync(path.join(A100, 'root'), { recursive: true });
  const proc = spawn(path.join(VENV, 'bin/jupyter'), ['server', '--ServerApp.ip=127.0.0.1', `--ServerApp.port=${A100_PORT}`, '--ServerApp.port_retries=0', `--IdentityProvider.token=${A100_TOKEN}`, `--ServerApp.root_dir=${path.join(A100, 'root')}`, '--ServerApp.allow_origin=http://localhost:8080', '--ServerApp.allow_remote_access=True', '--ServerApp.open_browser=False', '--allow-root'], {
    env: { ...process.env, ...stageEnv, HOME: A100, SHELL: '/bin/bash', VIRTUAL_ENV_DISABLE_PROMPT: '1', PATH: `${path.join(A100, 'bin')}:${path.join(VENV, 'bin')}:${process.env.PATH}` },
    cwd: path.join(A100, 'root'),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  killOnExit(proc);
  return (async () => {
    for (let i = 0; i < 120; i++) {
      const ok = await fetch(`http://127.0.0.1:${A100_PORT}/api`).then((r) => r.ok).catch(() => false);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('the A100 stand-in did not start');
  })();
}

function startCompanion() {
  mkdirSync(path.join(HOME, 'Reader'), { recursive: true });
  rmSync(path.join(HOME, 'Reader/playgrounds'), { recursive: true, force: true });
  // The code the split project is made around, already in its folder on the Mac.
  mkdirSync(path.join(HOME, 'Reader/playgrounds/moe-router'), { recursive: true });
  writeFileSync(path.join(HOME, 'Reader/playgrounds/moe-router/train.py'), TRAIN);
  child = spawn(path.join(VENV, 'bin/reader-companion'), ['--site', 'http://localhost:8080', '--name', NAME, '--root', path.join(HOME, 'Reader'), '--python', path.join(VENV, 'bin/python'), '--no-browser', '--no-tunnel'], {
    env: { ...process.env, ...stageEnv, KOIOS_STAGE_TUNNEL: 'http://127.0.0.1:47321/', HOME, SHELL: '/bin/bash', VIRTUAL_ENV_DISABLE_PROMPT: '1', PATH: `${path.join(VENV, 'bin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  killOnExit(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Companion did not start in 60 s')), 60_000);
    const read = (chunk) => {
      const text = String(chunk);
      // The first code, then each new one after a pairing.
      for (const match of text.matchAll(/code (?:\u001b\[[0-9;]*m)*([A-Z0-9]{3}-[A-Z0-9]{3})/g)) code = match[1];
      if (code) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (status) => reject(new Error(`the Companion exited (${status})`)));
  });
}

export async function setup(context) {
  await Promise.all([startCompanion(), startA100()]);
  const cors = { 'Access-Control-Allow-Origin': 'http://localhost:8080', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.port === '47331' || !companionUp) return route.abort();
    if (url.pathname === '/companion/show-code') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"shown":true}' });
    // A Mac with VS Code, the Koios extension in it.
    if (url.pathname === '/companion/vscode' && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ editors: [{ name: 'Visual Studio Code', installed: true }] }) });
    if (url.pathname === '/companion/info' || url.pathname === '/companion/pair') {
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (body && typeof body === 'object' && 'name' in body) Object.assign(body, { hardware: HARDWARE, root: '~/Reader' });
      return route.fulfill({ response, body: JSON.stringify(body) });
    }
    return route.fallback();
  });
  // The lab's A100 box, by its name: the page's calls and sockets passed to the Jupyter server standing in for it.
  const a100 = (url) => url.replace(/^(http|ws)s?:\/\/a100\.lab\.example\.org/, (_, scheme) => `${scheme}://127.0.0.1:${A100_PORT}`);
  await context.route(/^https?:\/\/a100\.lab\.example\.org\//, async (route) => {
    const response = await route.fetch({ url: a100(route.request().url()) }).catch(() => null);
    if (!response) return route.abort();
    return route.fulfill({ response });
  });
  await context.routeWebSocket(/^wss?:\/\/a100\.lab\.example\.org\//, (ws) => {
    const server = new WebSocket(a100(ws.url()), { headers: { Origin: 'http://localhost:8080' } });
    const waiting = [];
    server.on('open', () => waiting.splice(0).forEach((message) => server.send(message)));
    server.on('message', (data, binary) => ws.send(binary ? data : data.toString()));
    server.on('close', () => ws.close());
    server.on('error', () => ws.close());
    ws.onMessage((message) => (server.readyState === WebSocket.OPEN ? server.send(message) : waiting.push(message)));
    ws.onClose(() => server.close());
  });
  // The Koios app's newest release, as GitHub lists it: a signed .dmg for this Mac, and the others.
  const asset = (name) => ({ name, browser_download_url: `https://github.com/saurav717/reader/releases/download/v0.20.0/${name}` });
  await context.route('https://api.github.com/repos/**/releases*', (route) =>
    route.fulfill(json([{ tag_name: 'v0.20.0', draft: false, prerelease: false, assets: ['Koios-0.20.0.dmg', 'Koios-Setup-0.20.0.exe', 'Koios-0.20.0-x86_64.AppImage', 'koios_0.20.0_amd64.deb', 'koios-0.20.0.x86_64.rpm'].map(asset) }])),
  );
  // A Mac's browser, so the card offers the Mac download.
  await context.addInitScript((ua) => {
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => ua });
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
  }, MAC_UA);
}

const GPU = { id: 's-a100', name: 'Lab A100', url: `http://${A100_HOST}/`, token: A100_TOKEN, where: 'remote' };

export async function prepare({ page, arrive }) {
  await arrive({ settings: { googleClientId: 'video.apps.googleusercontent.com', proxyBase: 'http://localhost:9/' }, storage: { 'reader.playground.servers': [GPU] } });
  await page.waitForTimeout(800);
  // Home's search box takes the focus; P is the Playground only outside a field.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

const hold = (page, ms) => page.waitForTimeout(ms);

export default async function ({ page, pointer, mark }) {
  await hold(page, 1500);

  mark('playground');
  await pointer.key('p', 'P');
  await page.locator('.pg-hero').waitFor();
  await hold(page, 1800);
  const card = page.locator('.pg-companion');
  await pointer.moveTo(card.locator('.pg-section-head'));
  await hold(page, 1200);

  mark('download-app');
  await pointer.moveTo(card.locator('.pg-companion-way').first());
  await page.mouse.wheel(0, 260);
  await hold(page, 900);
  await pointer.moveTo(card.locator('.pg-companion-download').first());
  await hold(page, 2600);

  mark('command-line');
  await pointer.click(card.locator('.pg-companion-way').nth(1));
  await hold(page, 900);
  await pointer.moveTo(card.locator('pre, .copy-block, code').first());
  await hold(page, 2200);

  mark('vscode');
  await pointer.click(card.getByRole('radio', { name: 'VS Code' }));
  await hold(page, 2600);

  mark('found');
  companionUp = true;
  await page.mouse.wheel(0, -400);
  await card.locator('.pg-companion-found').waitFor({ timeout: 10_000 });
  await pointer.moveTo(card.locator('.pg-companion-found'));
  await hold(page, 2800);

  mark('pairing');
  await pointer.click(card.getByRole('button', { name: 'Show the code on this computer' }));
  await hold(page, 1200);
  await pointer.click(card.locator('.pg-companion-code input'));
  await pointer.type(code, { delay: 110 });
  await hold(page, 900);
  await pointer.click(card.getByRole('button', { name: 'Connect', exact: true }));

  mark('connected');
  const row = page.locator('.pg-side .pg-machine', { hasText: NAME });
  await row.waitFor({ timeout: 10_000 });
  await pointer.moveTo(row.locator('.pg-machine-head'));
  await hold(page, 3200);

  mark('where');
  await pointer.click(page.locator('.pg-start', { hasText: 'Blank project' }));
  await page.locator('.pg-sheet').waitFor();
  await hold(page, 2600);

  mark('where-pc');
  await pointer.click(page.locator('.pg-mode-top', { has: page.locator('b', { hasText: /^This PC$/ }) }));
  await hold(page, 2600);

  mark('where-gpu');
  await pointer.click(page.locator('.pg-mode.is-wide .pg-mode-top'));
  await hold(page, 900);
  await pointer.moveTo(page.getByRole('radiogroup', { name: 'Where it runs' }).getByRole('radio', { name: /Lab A100/ }));
  await hold(page, 2400);

  mark('create-on-pc');
  await pointer.click(page.locator('.pg-mode-top', { has: page.locator('b', { hasText: /^This PC$/ }) }));
  await hold(page, 600);
  const title = page.locator('.pg-title-field input');
  await pointer.click(title);
  await page.keyboard.press('Control+a');
  await pointer.type('Transformer from scratch');
  await hold(page, 600);
  await pointer.click(page.locator('.pg-sheet-foot .btn.primary'));

  mark('project');
  await page.locator('.vs-activity').waitFor({ timeout: 20_000 });
  await hold(page, 3000);

  mark('terminal');
  const term = page.locator('.xterm').first();
  await term.waitFor({ timeout: 15_000 });
  await pointer.click(term);
  await pointer.type('ls');
  await pointer.key('Enter', '⏎', 900);
  await pointer.type('python -c "import numpy; print(numpy.__version__)"', { delay: 35 });
  await pointer.key('Enter', '⏎', 600);
  await hold(page, 2800);

  mark('machine-menu');
  await pointer.click(page.locator('.pg-chip').first());
  await hold(page, 2800);
  await pointer.click(page.getByText('Run on more machines…'));
  await hold(page, 3000);
  await page.screenshot({ path: path.join(ROOT, '.video/work/companion-chip.png') });

  mark('settings-compute');
  await pointer.click(page.getByRole('button', { name: 'Settings', exact: true }));
  await pointer.click(page.getByRole('tab', { name: /Compute & playgrounds/ }));
  await hold(page, 800);
  await pointer.moveTo(page.locator('#settings-compute .cp-row', { hasText: 'MacBook' }));
  await hold(page, 3000);
  await page.screenshot({ path: path.join(ROOT, '.video/work/companion-settings.png') });

  mark('settings-updates');
  await pointer.click(page.getByRole('tab', { name: /Updates/ }));
  await hold(page, 3200);
  await page.screenshot({ path: path.join(ROOT, '.video/work/companion-updates.png') });
}

/** For trying beats out of the take (.video/work/probe.mjs): the Companion shown, and its code now. */
export const stage = { up: () => (companionUp = true), code: () => code };
