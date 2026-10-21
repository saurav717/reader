// draft — exploration
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, json } from '../lib.mjs';

const WORK = path.join(ROOT, '.video/simwork');
const VENV = path.join(ROOT, '.video/jvenv');
const HOME = path.join(WORK, 'home');
const PORT = 47341;
const TOKEN = 'video-sim-token-0123456789abcdefABCDEF';
const CID = 'a1b2c3d4e5f60718';
const NAME = 'Saurav’s MacBook Pro';
const HARDWARE = 'Apple M3 Pro · 12 cores · 36 GB';
const SHOTS = path.join(WORK, 'shots');

let child = null;
function startCompanion() {
  rmSync(path.join(HOME, 'Reader'), { recursive: true, force: true });
  mkdirSync(path.join(HOME, 'Reader'), { recursive: true });
  mkdirSync(path.join(HOME, '.reader-companion'), { recursive: true });
  writeFileSync(path.join(HOME, '.reader-companion/config.json'), JSON.stringify({ token: TOKEN, id: CID, root: path.join(HOME, 'Reader'), site: 'http://localhost:8080', name: NAME, python: path.join(VENV, 'bin/python'), tunnel: false, port: PORT, tls_port: PORT + 10 }));
  child = spawn(path.join(VENV, 'bin/reader-companion'), ['--no-browser', '--no-tunnel'], {
    env: { ...process.env, HOME, SHELL: '/bin/bash', READER_COMPANION_HOME: path.join(HOME, '.reader-companion'), PATH: `${path.join(VENV, 'bin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  process.on('exit', () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
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

export async function setup(context) {
  await startCompanion();
  await context.route(/^https?:\/\/127\.0\.0\.1:(47321|47331)\//, (route) => route.abort());
  await context.route(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/companion/info`), async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (body && typeof body === 'object' && 'name' in body) Object.assign(body, { hardware: HARDWARE, root: '~/Reader' });
    return route.fulfill({ response, body: JSON.stringify(body) });
  });
  await context.route('https://gymnasium.farama.org/_images/*.gif', (route) => {
    const file = path.join(WORK, 'previews', path.basename(new URL(route.request().url()).pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/gif', body: readFileSync(file) });
  });
}

const SERVER = { id: 's-mac', name: NAME, url: `http://127.0.0.1:${PORT}/`, token: TOKEN, where: 'pc', companionId: CID };

export async function prepare({ page, arrive }) {
  await arrive({ storage: { 'reader.playground.servers': [SERVER] } });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

const hold = (page, ms) => page.waitForTimeout(ms);
const shot = (page, name) => (mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));

export default async function ({ page, pointer, mark }) {
  mark('playground');
  await pointer.key('p', 'P');
  await page.locator('.pg-hero').waitFor();
  await hold(page, 1500);
  await shot(page, '01-playground');
  const card = page.locator('.pg-start', { hasText: 'A simulation' });
  await pointer.click(card);
  await page.locator('.sim-picker').waitFor();
  await hold(page, 1000);
  await shot(page, '02-picker');
  await pointer.click(page.locator('.sim-card', { hasText: 'MuJoCo (Gymnasium)' }));
  await hold(page, 2500);
  await shot(page, '03-mujoco');
  await pointer.click(page.locator('.sim-picker-list label', { hasText: 'HalfCheetah' }));
  await hold(page, 1500);
  await shot(page, '04-cheetah');
  await pointer.click(page.locator('.sim-picker-list label', { hasText: 'PPO (one file)' }));
  await pointer.click(page.getByRole('button', { name: 'Next: where it runs' }));
  await hold(page, 1500);
  await shot(page, '05-where');
  await pointer.click(page.locator('.pg-mode-top', { has: page.locator('b', { hasText: /^This PC$/ }) }));
  await hold(page, 800);
  await shot(page, '06-pc');
  await pointer.click(page.locator('.pg-sheet-foot .btn.primary'));
  await page.locator('.vs-activity').waitFor({ timeout: 20_000 });
  await hold(page, 4000);
  await shot(page, '07-workspace');
  await pointer.click(page.getByRole('button', { name: 'Simulation' }));
  await hold(page, 4000);
  await shot(page, '08-sim');
  console.log(readdirSync(path.join(HOME, 'Reader'), { recursive: true }).slice(0, 40));
}
