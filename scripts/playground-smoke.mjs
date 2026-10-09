/**
 * The Playground, in a browser, against two real Jupyter servers — one
 * standing in for this PC, one for a GPU machine elsewhere — and the page's
 * addresses: every page has its own path, Back goes where you were, and a
 * reload stays. A server is added and tested; a notebook playground runs a
 * cell on "this PC"; a project playground keeps its files on "this PC" and
 * runs a command on "the GPU machine", copying the folder there first and
 * bringing what the run wrote back. Each state is photographed.
 *
 *   npx vite --port 5173 &
 *   pip install jupyter_server ipykernel
 *   jupyter server --ServerApp.allow_origin=http://localhost:5173 --ServerApp.port=8888 --IdentityProvider.token=smoketoken --ServerApp.root_dir=/tmp/pc &
 *   jupyter server --ServerApp.allow_origin=http://localhost:5173 --ServerApp.port=8889 --IdentityProvider.token=remotetoken --ServerApp.root_dir=/tmp/gpu &
 *   node scripts/playground-smoke.mjs        # SMOKE_BASE=http://localhost:5173
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5173';
const PC = process.env.SMOKE_PC || 'http://localhost:8888/?token=smoketoken';
const GPU = process.env.SMOKE_GPU || 'http://localhost:8889/?token=remotetoken';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/playground/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((theme) => {
  if (sessionStorage.getItem('smoke.init')) return;
  sessionStorage.setItem('smoke.init', '1');
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme, glass: false }));
}, process.env.SMOKE_THEME || 'light');
const page = await context.newPage();
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('dialog', (dialog) => void dialog.accept(dialog.defaultValue() || 'train.py'));
const shot = async (name) => {
  await sleep(300);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  shot  ${name}`);
};
const path = () => new URL(page.url()).pathname;

console.log('the addresses');
await page.goto(`${BASE}/`);
await page.waitForSelector('.rail');
check('Home is /', path() === '/', path());
await page.getByRole('button', { name: 'Playground', exact: true }).click();
await page.waitForSelector('.pg-hero');
check('the rail’s Playground button goes to /playground', path() === '/playground', path());
check('the tab is titled for it', (await page.title()).startsWith('Playground'), await page.title());
await page.goBack();
await page.waitForSelector('.rail');
check('Back from the Playground is Home again', path() === '/', path());
await page.goForward();
await page.waitForSelector('.pg-hero');
check('Forward is the Playground again', path() === '/playground', path());
await page.goto(`${BASE}/library`);
await page.waitForSelector('.rail');
check('/library opens the library and stays there', path() === '/library', path());
await page.keyboard.press('p');
await page.waitForSelector('.pg-hero');
check('P goes to the Playground', path() === '/playground', path());
await shot('1-home');

console.log('a server of one’s own');
await page.getByRole('button', { name: '+ Add a server' }).click();
await page.locator('.pg-server-form input').nth(1).fill(PC);
await shot('2-server-form');
await page.getByRole('button', { name: 'Test and save' }).click();
await page.waitForSelector('.pg-machine-head:has-text("This PC")');
check('the PC server is tested and kept', await page.locator('.pg-machine-head:has-text("This PC")').count() === 1);
await page.getByRole('button', { name: '+ Add a server' }).click();
await page.getByRole('radio', { name: 'Another machine' }).click();
await page.locator('.pg-server-form input').nth(0).fill('GPU box');
await page.locator('.pg-server-form input').nth(1).fill(GPU);
await page.getByRole('button', { name: 'Test and save' }).click();
await page.waitForSelector('.pg-machine-head:has-text("GPU box")');
check('the GPU server is kept as a remote one', await page.locator('.pg-machine-head:has-text("GPU box") .pg-mark.is-gpu').count() === 1);

console.log('a notebook on this PC');
await page.getByRole('button', { name: /Blank notebook/ }).click();
await page.waitForSelector('.pg-sheet');
await page.locator('.pg-mode').nth(1).click();
await shot('3-where');
await page.locator('.pg-sheet-foot .btn.primary').click();
await page.waitForSelector('.pg-bar');
check('a new playground has its own address', /^\/playground\/[\w-]+$/.test(path()), path());
const notebookUrl = page.url();
const cell = page.locator('.nb-cell').filter({ has: page.locator('textarea') }).last();
await cell.locator('textarea').click();
await page.keyboard.type('import sys, platform\nprint("hello from", platform.node() or "here", sys.version.split()[0])');
await page.keyboard.press('Shift+Enter');
await page.waitForFunction(() => document.body.innerText.includes('hello from'), null, { timeout: 30_000 }).catch(() => undefined);
check('the cell ran on the Jupyter server, and printed', (await page.locator('body').innerText()).includes('hello from'));
check('the chip names the machine', (await page.locator('.pg-chip').innerText()).includes('This PC'), await page.locator('.pg-chip').innerText());
await page.getByRole('button', { name: 'Runtime', exact: true }).click();
await sleep(2500);
await shot('4-notebook-pc');
await page.reload();
await page.waitForSelector('.pg-bar');
check('a reload stays on the playground', page.url() === notebookUrl, page.url());
check('what the cell printed is still under it', (await page.locator('body').innerText()).includes('hello from'));

console.log('a project: files on this PC, code on the GPU box');
await page.getByRole('button', { name: /Playground$/ }).first().click();
await page.waitForSelector('.pg-hero');
check('the bar’s Playground goes back to /playground', path() === '/playground', path());
await page.getByRole('button', { name: /Blank project/ }).click();
await page.waitForSelector('.pg-sheet');
await page.locator('.pg-title-field input').fill('Split smoke');
await page.locator('.pg-mode').nth(2).click();
await page.locator('.pg-split .pg-opt:has-text("GPU box")').click();
await shot('5-where-split');
await page.locator('.pg-sheet-foot .btn.primary').click();
await page.waitForSelector('.pg-files');
await page.waitForSelector('.pg-entry:has-text("main.py")');
check('the project’s files are in the folder on this PC', await page.locator('.pg-entry:has-text("main.py")').count() >= 1);
await page.locator('.pg-entry:has-text("README.md")').first().click();
await page.waitForSelector('.pg-editor textarea');
// A script that writes a result where the bring-back rules look.
await page.locator('.pg-tree-head button[title="A new file"]').click();
await page.waitForSelector('.pg-tab:has-text("train.py")');
await page.locator('.pg-editor textarea').fill('import os, json, socket\nos.makedirs("results", exist_ok=True)\njson.dump({"ran_in": os.getcwd()}, open("results/score.json", "w"))\nprint("step 1 loss=0.9\\nstep 2 loss=0.5\\nstep 3 loss=0.31")\nprint("ran in", os.getcwd())\n');
await page.keyboard.press('Control+s');
await sleep(500);
await page.locator('.pg-console-input input').fill('python train.py');
await page.locator('.pg-console-input button[type=submit]').click();
await page.waitForFunction(() => document.querySelector('.pg-console-log')?.textContent?.includes('ran in'), null, { timeout: 40_000 }).catch(() => undefined);
const log = await page.locator('.pg-console-log').innerText();
check('the command ran on the GPU box, in the copied folder', /ran in .*jremote|ran in .*playgrounds\/split-smoke/.test(log), log.slice(-200));
await page.waitForSelector('.pg-sync .pg-ok:has-text("brought back")', { timeout: 15_000 }).catch(() => undefined);
await page.waitForSelector('.pg-entry:has-text("results")', { timeout: 10_000 }).catch(() => undefined);
check('what it wrote under results/ came back to this PC', await page.locator('.pg-tree-part').first().locator('.pg-entry:has-text("results")').count() === 1);
await shot('6-project-split');
await page.getByRole('button', { name: 'Metrics', exact: true }).click();
await sleep(500);
await shot('7-metrics');

await page.getByRole('button', { name: /Playground$/ }).first().click();
await page.waitForSelector('.pg-row');
check('the home lists both playgrounds, with where each runs', (await page.locator('.pg-row').count()) === 2 && (await page.locator('.pg-row .pg-where:has-text("GPU box")').count()) === 1);
await shot('8-home-list');
await page.locator('.pg-row').first().getByRole('button', { name: 'Open' }).click();
await page.waitForSelector('.pg-bar');
await page.locator('.pg-chip').click();
await page.getByRole('menuitem', { name: 'Change where it runs…' }).click();
await page.waitForSelector('.pg-sheet');
await page.locator('.pg-mode').first().click();
await shot('9-where-colab');
await page.keyboard.press('Escape');

await page.goto(`${BASE}/playground/nothing-here`);
await page.waitForSelector('.pg-missing');
check('an unknown playground says so', await page.locator('.pg-missing').count() === 1);

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
