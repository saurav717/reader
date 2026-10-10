/**
 * What runs outside a playground's cells, followed from any page: a command
 * in its terminal. On a Companion (the real reader_companion extension,
 * whose /companion/terminals reads each pty's foreground job) and on a plain
 * Jupyter server (where the screen says: a prompt at its end, or not). The
 * dock shows the command and its last line on another page; Stop there sends
 * Ctrl-C; a toast says it stopped, or ended on its own.
 *
 *   npx vite --port 5173 &
 *   python3 <a Companion on :8890, token comptoken, site http://localhost:5173/>   (see the PR's notes)
 *   jupyter server --ServerApp.allow_origin=http://localhost:5173 --ServerApp.port=8888 --IdentityProvider.token=smoketoken &
 *   node scripts/running-jobs-smoke.mjs
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5173';
const COMPANION = process.env.SMOKE_COMPANION || 'http://localhost:8890/?token=comptoken';
const PLAIN = process.env.SMOKE_PLAIN || 'http://localhost:8888/?token=smoketoken';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/running-jobs/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(({ theme, glass }) => {
  if (sessionStorage.getItem('smoke.init')) return;
  sessionStorage.setItem('smoke.init', '1');
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme, glass }));
}, { theme: process.env.SMOKE_THEME || 'light', glass: Boolean(process.env.SMOKE_GLASS) });
const page = await context.newPage();
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
const shot = async (name) => {
  await sleep(300);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  shot  ${name}`);
};
const toHome = async () => {
  await page.locator('.rail-playground').click();
  await page.waitForSelector('.pg-hero');
};
const COUNT = 'python3 -c \'import time;[(print(f"tick {i}/30", flush=True), time.sleep(1)) for i in range(1, 31)]\'';

/** A blank project whose code runs on `machine`, its terminal open and at a prompt. */
async function project(title, mode, machine) {
  if (!(await page.locator('.pg-hero').count())) await toHome();
  await page.getByRole('button', { name: /Blank project/ }).click();
  await page.waitForSelector('.pg-sheet');
  await page.locator('.pg-title-field input').fill(title);
  if (mode === 'split') {
    await page.locator('.pg-mode.is-wide').click();
    await page.getByRole('radiogroup', { name: 'Where it runs' }).getByRole('radio', { name: new RegExp(machine) }).click();
  } else await page.locator('.pg-mode').nth(1).click();
  await page.locator('.pg-sheet-foot .btn.primary').click();
  await page.waitForSelector('.pg-files');
  await page.waitForSelector('.pg-terminal-screen .xterm', { timeout: 30_000 });
  await page.waitForFunction(() => /[$#%]\s*$/m.test(document.querySelector('.pg-terminal-screen .xterm-rows')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => undefined);
}
async function typeInTerminal(text) {
  await page.locator('.pg-terminal-screen').click();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Enter');
}

console.log('a Companion, and a plain Jupyter server');
await page.goto(`${BASE}/playground`);
await page.waitForSelector('.pg-hero');
await page.getByRole('button', { name: '+ Add a server' }).click();
await page.locator('.pg-server-form input').nth(1).fill(COMPANION);
await page.getByRole('button', { name: 'Test and save' }).click();
await page.waitForSelector('.pg-machine-head:has-text("This PC")');
await page.getByRole('button', { name: '+ Add a server' }).click();
await page.getByRole('radio', { name: 'Another machine' }).click();
await page.locator('.pg-server-form input').nth(0).fill('Plain box');
await page.locator('.pg-server-form input').nth(1).fill(PLAIN);
await page.getByRole('button', { name: 'Test and save' }).click();
await page.waitForSelector('.pg-machine-head:has-text("Plain box")');

console.log('on the Companion: what the terminal runs, exactly');
await project('Terminal job', 'pc');
await typeInTerminal(COUNT);
await page.waitForFunction(() => (document.querySelector('.pg-terminal-screen .xterm-rows')?.textContent ?? '').includes('tick 2/30'), null, { timeout: 20_000 }).catch(() => undefined);
await page.getByRole('button', { name: 'Library' }).click();
await page.waitForSelector('.pr-dock', { timeout: 15_000 }).catch(() => undefined);
const dock = async () => page.locator('.pr-dock').innerText().catch(() => '');
check('the dock shows the terminal’s command on another page', /terminal · python3 -c/.test(await dock()), (await dock()).slice(0, 200));
await page.waitForFunction(() => /tick \d+\/30/.test(document.querySelector('.pr-dock')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => undefined);
check('…and its last line, still coming', /tick \d+\/30/.test(await dock()));
check('the rail counts it', (await page.locator('.rail-run .pr-badge').innerText().catch(() => '')) === '1');
await shot('1-terminal-dock');
await page.locator('.pr-dock').getByRole('button', { name: 'Stop' }).click();
await page.waitForSelector('.pr-toast.is-stopped', { timeout: 15_000 }).catch(() => undefined);
check('Stop sends Ctrl-C, and a toast says it stopped', (await page.locator('.pr-toast.is-stopped').innerText().catch(() => '')).includes('Terminal job stopped'));
check('the dock goes', (await page.locator('.pr-dock').count()) === 0);
await shot('2-terminal-stopped');

console.log('one that ends on its own');
await toHome();
await page.locator('.pg-row:has-text("Terminal job")').getByRole('button', { name: 'Open', exact: true }).click();
await page.waitForSelector('.pg-terminal-screen .xterm', { timeout: 30_000 });
await sleep(1500);
await typeInTerminal('sleep 6');
await sleep(1500);
await toHome();
check('the shelf has it', (await page.locator('.pr-shelf .pr-card:has-text("Terminal job")').innerText().catch(() => '')).includes('sleep 6'));
await shot('3-terminal-shelf');
await page.waitForSelector('.pr-toast.is-ran', { timeout: 20_000 }).catch(() => undefined);
check('a toast says it ended', (await page.locator('.pr-toast.is-ran').innerText().catch(() => '')).includes('Terminal job finished'));

console.log('on a plain Jupyter server: the screen says');
await project('Plain terminal', 'split', 'Plain box');
await typeInTerminal(COUNT);
await page.waitForFunction(() => (document.querySelector('.pg-terminal-screen .xterm-rows')?.textContent ?? '').includes('tick 2/30'), null, { timeout: 20_000 }).catch(() => undefined);
await page.getByRole('button', { name: 'Library' }).click();
await page.waitForSelector('.pr-dock', { timeout: 15_000 }).catch(() => undefined);
check('the dock shows it, from what was typed', /terminal · python3 -c/.test(await dock()), (await dock()).slice(0, 200));
await shot('4-plain-dock');
await page.locator('.pr-dock').getByRole('button', { name: 'Stop' }).click();
await page.waitForSelector('.pr-toast.is-stopped:has-text("Plain terminal")', { timeout: 15_000 }).catch(() => undefined);
check('Stop ends it there too', (await page.locator('.pr-toast.is-stopped:has-text("Plain terminal")').count()) === 1);

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
