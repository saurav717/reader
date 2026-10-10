/**
 * Colab playgrounds on machines of their own, against a stand-in Colab that
 * assigns as Colab does — a runtime per notebook id, each a Jupyter server
 * of its own (a WebSocket kernel server in this script) — with the proxy's
 * Colab routes answered here. Two playgrounds on machines of their own get
 * two machines, of the kinds they asked for, and run at once; one set to
 * share runs on the browser's machine, beside the paper pages; Shut down
 * stops one machine and leaves the other running; and when the tier allows
 * no more machines, a playground shares the browser's and says so. Each
 * state is photographed.
 *
 *   npm run build && npm start &
 *   node scripts/colab-machines-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/colab-machines/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const COLAB_SCOPE = 'https://www.googleapis.com/auth/colaboratory';

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------- the machines ----

const header = (type) => ({ msg_id: `k-${Math.random().toString(36).slice(2)}`, msg_type: type, session: 'kernel', username: 'kernel', version: '5.3', date: new Date().toISOString() });
const send = (socket, type, content, parent, channel = 'iopub') => socket.send(JSON.stringify({ header: header(type), parent_header: { msg_id: parent }, metadata: {}, content, channel, buffers: [] }));

/** The machines Colab has assigned, by notebook id: each its own endpoint, kind and kernel server. */
const machines = new Map();
const stopped = [];
let kernelIds = 0;
/** How many machines the tier allows at once; Infinity until the test lowers it. */
let tierLimit = Infinity;

async function startMachine(notebook, accelerator) {
  const endpoint = `m-s-${notebook.slice(0, 8)}`;
  const server = createServer((_request, response) => response.end('runtime'));
  const sockets = new WebSocketServer({ server });
  const machine = { notebook, endpoint, accelerator, kernels: [], interrupted: false, server };
  sockets.on('connection', (socket) => {
    socket.on('message', async (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message?.header?.msg_type === 'kernel_info_request') return send(socket, 'kernel_info_reply', { status: 'ok' }, message.header.msg_id, 'shell');
      if (message?.header?.msg_type !== 'execute_request') return;
      const parent = message.header.msg_id;
      const code = String(message.content?.code ?? '');
      // What the cell prints: the machine it is on, a slow count, or its print() lines.
      let lines = [];
      let every = 20;
      if (/which_machine/.test(code)) lines = [`machine ${endpoint} ${accelerator}`];
      else if (/time\.sleep/.test(code)) {
        lines = Array.from({ length: 12 }, (_, i) => `step ${i + 1}/12 on ${endpoint}`);
        every = 1000;
      } else if (code.startsWith('import json, os, shutil, subprocess, time')) lines = [JSON.stringify({ gpu: `${accelerator === 'NONE' ? '' : `Tesla ${accelerator}, 0, 400, 15360`}`, cpu: 3, cpus: 2, ram: [1900, 13012], disk: [71, 78] })];
      else lines = [...code.matchAll(/^print\((["'])(.*?)\1\)$/gm)].map((m) => m[2]);
      send(socket, 'status', { execution_state: 'busy' }, parent);
      machine.interrupted = false;
      let cut = false;
      for (const line of lines) {
        if (machine.interrupted) {
          cut = true;
          break;
        }
        send(socket, 'stream', { name: 'stdout', text: `${line}\n` }, parent);
        await sleep(every);
      }
      if (cut) {
        send(socket, 'error', { ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'] }, parent);
        send(socket, 'execute_reply', { status: 'error', execution_count: 1 }, parent, 'shell');
      } else send(socket, 'execute_reply', { status: 'ok', execution_count: 1 }, parent, 'shell');
      send(socket, 'status', { execution_state: 'idle' }, parent);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  machine.url = `http://127.0.0.1:${server.address().port}/`;
  machines.set(notebook, machine);
  return machine;
}
const byUrl = (url) => [...machines.values()].find((machine) => machine.url === url);

// ------------------------------------------------------------ the browser ----

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/api/colab/**', async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^.*\/api\/colab/, '/colab');
  const method = route.request().method();
  const body = JSON.parse(route.request().postData() || '{}');
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (!route.request().headers()['x-google-token']) return json({ error: 'no token' }, 401);
  if (path === '/colab/runtimes' && method === 'POST') {
    let machine = machines.get(body.notebook);
    if (!machine) {
      if (machines.size >= tierLimit) return json({ error: 'Colab says this account already has as many runtimes as its tier allows — stop one in Colab (Runtime → Manage sessions) and try again', limit: true }, 412);
      machine = await startMachine(body.notebook, body.accelerator);
    }
    return json({ runtime: { endpoint: machine.endpoint, accelerator: machine.accelerator === 'NONE' ? null : machine.accelerator, highMem: false, proxy: { url: machine.url, token: 'proxy-token', expiresAt: Date.now() + 3_600_000 } } });
  }
  if (path === '/colab/runtimes/stop') {
    stopped.push(body.endpoint);
    for (const [notebook, machine] of machines) if (machine.endpoint === body.endpoint) machines.delete(notebook);
    return json({ ok: true });
  }
  if (path === '/colab/units') return json({ balance: 40 });
  const machine = byUrl(body.proxy?.url);
  if (path === '/colab/kernels/list') return json({ kernels: (machine?.kernels ?? []).map((id) => ({ id })) });
  if (path === '/colab/kernels' && method === 'POST') {
    kernelIds += 1;
    machine?.kernels.push(`kernel-${kernelIds}`);
    return json({ kernel: { id: `kernel-${kernelIds}` } });
  }
  if (path === '/colab/kernels/interrupt') {
    if (machine) machine.interrupted = true;
    return json({ ok: true });
  }
  if (path === '/colab/kernels/restart') return json({ ok: true });
  if (path === '/colab/contents') return json({ path: body.path ?? '', entries: [] });
  return json({ error: `unexpected ${method} ${path}` }, 500);
});
await context.addInitScript((scope) => {
  if (sessionStorage.getItem('smoke.init')) return;
  sessionStorage.setItem('smoke.init', '1');
  sessionStorage.setItem('reader.google.session', JSON.stringify({ accessToken: 'ya29.smoke', expiresAt: Date.now() + 3_600_000, scopes: ['openid', 'email', scope], user: { email: 'reader@example.org', name: 'Reader' } }));
  localStorage.setItem('reader.welcomed', 'true');
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, googleClientId: 'smoke-client-id.apps.googleusercontent.com', theme: 'light', glass: false }));
}, COLAB_SCOPE);
const page = await context.newPage();
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('dialog', (dialog) => void dialog.accept());
const shot = async (name) => {
  await sleep(300);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  shot  ${name}`);
};
const toHome = async () => {
  await page.locator('.rail-playground').click();
  await page.waitForSelector('.pg-hero');
};
/** A notebook on Colab: its own machine of `kind`, or the shared one. */
async function colabNotebook(title, kind, shared = false) {
  if (!(await page.locator('.pg-hero').count())) await toHome();
  await page.getByRole('button', { name: /Blank notebook/ }).click();
  await page.waitForSelector('.pg-sheet');
  await page.locator('.pg-title-field input').fill(title);
  await page.locator('.pg-mode').first().click();
  await page.getByRole('radiogroup', { name: 'Where the files are kept' }).getByRole('radio', { name: /The Colab runtime/ }).click();
  await page.getByRole('radiogroup', { name: 'Colab machine' }).getByRole('radio', { name: new RegExp(kind) }).click();
  await page.getByRole('radiogroup', { name: 'Its own Colab machine, or shared' }).getByRole('radio', { name: shared ? /Shared/ : /A machine of its own/ }).click();
  if (title === 'Colab A') await shot('1-where');
  await page.locator('.pg-sheet-foot .btn.primary').click();
  await page.waitForSelector('.pg-bar');
}
async function runCode(code) {
  const cell = page.locator('.nb-cell').filter({ has: page.locator('textarea') }).last();
  await cell.locator('textarea').fill(code);
  await cell.locator('textarea').press('Shift+Enter');
}
/** A row of the home's list, by its title exactly ("Colab A" is in "Colab A100" too). */
const row = (title) => page.locator('.pg-row').filter({ has: page.locator('.pg-row-main > b', { hasText: new RegExp(`^${title}$`) }) });
const printed = async (pattern) => {
  await page.waitForFunction((source) => new RegExp(source).test(document.body.innerText), pattern.source, { timeout: 30_000 }).catch(() => undefined);
  return pattern.exec(await page.locator('body').innerText());
};

console.log('two playgrounds, each on a machine of its own');
await page.goto(`${BASE}/playground`);
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click({ timeout: 8000 }).catch(() => undefined);
await page.locator('.rail-playground').click();
await page.waitForSelector('.pg-hero');
await colabNotebook('Colab A', 'T4');
await runCode('import time\nfor i in range(12):\n    time.sleep(1)');
const a = await printed(/step \d+\/12 on (m-s-\w+)/);
check('the first runs, on a machine', Boolean(a), a?.[0]);
await colabNotebook('Colab B', 'A100');
await runCode('which_machine()');
const b = await printed(/machine (m-s-\w+) (\w+)/);
check('the second is on another machine', Boolean(a && b && a[1] !== b[1]), `${a?.[1]} / ${b?.[1]}`);
check('…of the kind it asked for', b?.[2] === 'A100', b?.[2]);
check('Colab was asked for two machines, one a T4 and one an A100', machines.size === 2 && [...machines.values()].map((m) => m.accelerator).sort().join() === 'A100,T4', [...machines.values()].map((m) => `${m.endpoint}:${m.accelerator}`).join(' '));
await page.getByRole('button', { name: 'Library' }).click();
await page.waitForSelector('.pr-dock');
check('the first is still running, on its own machine, while the second ran', /step \d+\/12 on m-s-/.test(await page.locator('.pr-dock').innerText()));
await shot('2-dock');

console.log('one set to share');
await colabNotebook('Colab shared', 'T4', true);
await runCode('which_machine()');
const c = await printed(/machine (m-s-\w+) (\w+)/);
check('a shared one is on a third machine — the browser’s, not either playground’s', Boolean(c && c[1] !== a?.[1] && c[1] !== b?.[1]), c?.[1]);
check('three machines in all', machines.size === 3);

console.log('Shut down stops one machine, not the others');
await toHome();
await page.waitForFunction(() => !/Running/.test(document.querySelector('.pg-row:has(b)')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => undefined);
await page.waitForSelector('.pr-toast:has-text("Colab A finished")', { timeout: 30_000 }).catch(() => undefined);
const rowB = row('Colab B');
check('the second is idle, its machine up', (await rowB.locator('.pr-pill').innerText()).includes('Idle'), await rowB.locator('.pr-pill').innerText());
await shot('3-home');
await rowB.getByRole('button', { name: 'Shut down' }).click();
await page.waitForFunction(() => document.querySelectorAll('.pr-pill').length && ![...document.querySelectorAll('.pg-row')].find((row) => row.textContent.includes('Colab B'))?.querySelector('.pr-pill')?.textContent?.includes('Idle'), null, { timeout: 10_000 }).catch(() => undefined);
check('its machine, and only its, was stopped', stopped.length === 1 && stopped[0] === b?.[1], stopped.join());
check('the first’s machine is still up', [...machines.values()].some((m) => m.endpoint === a?.[1]));
check('the first is still idle with its variables', (await row('Colab A').locator('.pr-pill').innerText()).includes('Idle'));

console.log('the tier allows no more: it shares, and says so');
tierLimit = machines.size;
await colabNotebook('Colab D', 'T4');
await runCode('which_machine()');
const d = await printed(/machine (m-s-\w+) (\w+)/);
check('with no machine left, it runs on the browser’s', Boolean(d && d[1] === c?.[1]), d?.[1]);
check('…and says why', (await page.locator('.pg-banner').innerText().catch(() => '')).includes('shares your other Colab machine'));
await shot('4-shared-for-now');

await browser.close();
for (const machine of machines.values()) machine.server.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
process.exit(0);
