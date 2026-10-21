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
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, json } from '../lib.mjs';

const VENV = path.join(ROOT, '.video/jvenv');
const HOME = path.join(ROOT, '.video/chome');
const NAME = 'Saurav’s MacBook Pro';
const HARDWARE = 'Apple M3 Pro · 12 cores · 36 GB';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let companionUp = false; // hidden from the page until the take "starts" it
let code = '';
let child = null;

function startCompanion() {
  mkdirSync(path.join(HOME, 'Reader'), { recursive: true });
  child = spawn(path.join(VENV, 'bin/reader-companion'), ['--site', 'http://localhost:8080', '--name', NAME, '--root', path.join(HOME, 'Reader'), '--python', path.join(VENV, 'bin/python'), '--no-browser', '--no-tunnel'], {
    env: { ...process.env, HOME, PATH: `${path.join(VENV, 'bin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // gone already
    }
  };
  process.on('exit', kill);
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
  await startCompanion();
  const cors = { 'Access-Control-Allow-Origin': 'http://localhost:8080', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.port === '47331' || !companionUp) return route.abort();
    if (url.pathname === '/companion/show-code') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"shown":true}' });
    if (url.pathname === '/companion/info' || url.pathname === '/companion/pair') {
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (body && typeof body === 'object' && 'name' in body) Object.assign(body, { hardware: HARDWARE, root: '~/Reader' });
      return route.fulfill({ response, body: JSON.stringify(body) });
    }
    return route.fallback();
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

const GPU = { id: 's-a100', name: 'Lab A100', url: 'https://a100.lab.example.org/', token: 'lab', where: 'remote' };

export async function prepare({ page, arrive }) {
  await arrive({ settings: { googleClientId: 'video.apps.googleusercontent.com', proxyBase: 'http://localhost:9/' }, storage: { 'reader.playground.servers': [GPU] } });
  await page.waitForTimeout(800);
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
  await pointer.click(page.locator('.pg-mode', { hasText: 'This PC' }).locator('.pg-mode-top'));
  await hold(page, 2600);

  mark('where-gpu');
  await pointer.click(page.locator('.pg-mode.is-wide .pg-mode-top'));
  await hold(page, 900);
  await pointer.moveTo(page.getByRole('radiogroup', { name: 'Where it runs' }).getByRole('radio', { name: /Lab A100/ }));
  await hold(page, 2400);

  mark('create-on-pc');
  await pointer.click(page.locator('.pg-mode', { hasText: 'This PC' }).locator('.pg-mode-top'));
  await hold(page, 600);
  const title = page.locator('.pg-title-field input');
  await pointer.click(title);
  await page.keyboard.press('Control+a');
  await pointer.type('Transformer from scratch');
  await hold(page, 600);
  await pointer.click(page.locator('.pg-sheet-foot .btn.primary'));

  mark('project');
  await page.locator('.vs-activity').waitFor({ timeout: 20_000 });
  await hold(page, 3500);
  await page.screenshot({ path: path.join(ROOT, '.video/work/companion-project.png') });
}
