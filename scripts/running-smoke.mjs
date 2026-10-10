/**
 * Running playgrounds, in a browser, against two real Jupyter servers (as
 * playground-smoke.mjs runs them): a notebook runs a slow cell on "this PC",
 * and the page is left while it runs. The rail's count and the dock follow it
 * to the library; the Playground's home shelves it with its last line; a
 * second playground on "the GPU box" waits for it rather than cutting it
 * off; a toast says when it ends, and the home's list says it finished. Then
 * the other two ways are chosen — P's switcher and the tabs — and Stop from
 * the dock ends a run. Each state is photographed.
 *
 *   npx vite --port 5173 &
 *   jupyter server … --ServerApp.port=8888 --IdentityProvider.token=smoketoken &   (see playground-smoke.mjs)
 *   jupyter server … --ServerApp.port=8889 --IdentityProvider.token=remotetoken &
 *   node scripts/running-smoke.mjs        # SMOKE_THEME=dark SMOKE_GLASS=1 for the dark glass look
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5173';
const PC = process.env.SMOKE_PC || 'http://localhost:8888/?token=smoketoken';
const GPU = process.env.SMOKE_GPU || 'http://localhost:8889/?token=remotetoken';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/running/', import.meta.url).pathname;
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
page.on('dialog', (dialog) => void dialog.accept(dialog.defaultValue() || ''));
const shot = async (name) => {
  await sleep(300);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  shot  ${name}`);
};
const toHome = async () => {
  await page.locator('.rail-playground').click();
  await page.waitForSelector('.pg-hero');
};
const newNotebook = async (title, machine) => {
  if (!(await page.locator('.pg-hero').count())) await toHome();
  await page.getByRole('button', { name: /Blank notebook/ }).click();
  await page.waitForSelector('.pg-sheet');
  await page.locator('.pg-title-field input').fill(title);
  if (machine === 'GPU box') {
    // Files on this PC, the code run on the GPU box.
    await page.locator('.pg-mode.is-wide').click();
    await page.getByRole('radiogroup', { name: 'Where it runs' }).getByRole('radio', { name: /GPU box/ }).click();
  } else await page.locator('.pg-mode').nth(1).click();
  await page.locator('.pg-sheet-foot .btn.primary').click();
  await page.waitForSelector('.pg-bar');
};
const slow = (word, n = 20) => `import time\nfor i in range(1, ${n + 1}):\n    print(f"${word} {i}/${n} loss={1/i:.3f}", flush=True)\n    time.sleep(1)\nprint("done")`;
const runCode = async (code) => {
  const cell = page.locator('.nb-cell').filter({ has: page.locator('textarea') }).last();
  await cell.locator('textarea').fill(code);
  await cell.locator('textarea').press('Shift+Enter');
};

console.log('two machines');
await page.goto(`${BASE}/playground`);
await page.waitForSelector('.pg-hero');
// A paper in the library, for the peek beside it.
const PAPER = 'arxiv:1706.03762';
await page.evaluate(async (id) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('reader', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('papers', 'readwrite');
    tx.objectStore('papers').put({ id, source: 'arxiv', arxivId: '1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose the Transformer, based solely on attention mechanisms.', published: '2017-06-12', categories: ['cs.CL'], addedAt: new Date().toISOString(), collectionIds: [], tags: [], progress: 0.2 });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}, PAPER);
await page.reload();
await page.waitForSelector('.pg-hero');
await page.getByRole('button', { name: '+ Add a server' }).click();
await page.locator('.pg-server-form input').nth(1).fill(PC);
await page.getByRole('button', { name: 'Test and save' }).click();
await page.waitForSelector('.pg-machine-head:has-text("This PC")');
await page.getByRole('button', { name: '+ Add a server' }).click();
await page.getByRole('radio', { name: 'Another machine' }).click();
await page.locator('.pg-server-form input').nth(0).fill('GPU box');
await page.locator('.pg-server-form input').nth(1).fill(GPU);
await page.getByRole('button', { name: 'Test and save' }).click();
await page.waitForSelector('.pg-machine-head:has-text("GPU box")');

console.log('a slow cell, and the page left while it runs');
await newNotebook('Loss sweep', 'This PC');
await runCode(slow('step'));
await page.waitForFunction(() => document.body.innerText.includes('step 2/20'), null, { timeout: 30_000 });
await page.getByRole('button', { name: 'Library' }).click();
await page.waitForSelector('.pr-dock', { timeout: 5000 }).catch(() => undefined);
check('the dock follows the run to another page', (await page.locator('.pr-dock').count()) === 1);
check('the dock names it', (await page.locator('.pr-dock').innerText().catch(() => '')).includes('Loss sweep'));
check('the rail’s Playground button counts it', (await page.locator('.rail-run .pr-badge').innerText().catch(() => '')) === '1');
await page.waitForFunction(() => /step ([3-9]|1\d)\/20/.test(document.querySelector('.pr-dock')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => undefined);
check('the run goes on off its page: its output keeps coming', /step ([3-9]|1\d)\/20/.test(await page.locator('.pr-dock').innerText().catch(() => '')));
await page.locator('.rail-run').hover();
await shot('1-dock-elsewhere');

console.log('the home’s shelf');
await toHome();
check('Running now shelves it', (await page.locator('.pr-shelf .pr-card:has-text("Loss sweep")').count()) === 1);
check('its card has its last line', /step \d+\/20/.test(await page.locator('.pr-card .pr-tail').innerText()));
check('its row says it is running', (await page.locator('.pg-row:has-text("Loss sweep") .pr-pill').innerText()).includes('Running'));
await shot('2-home-shelf');

console.log('two more alongside it: one on another machine, one on the same — each its own kernel');
await newNotebook('GPU check', 'GPU box');
check('nothing waits: no banner', (await page.locator('.pg-banner:has-text("is running")').count()) === 0);
await runCode(slow('gpu', 12));
await page.waitForFunction(() => document.body.innerText.includes('gpu 2/12'), null, { timeout: 30_000 }).catch(() => undefined);
check('it runs on its own machine while the first still runs', (await page.locator('body').innerText()).includes('gpu 2/12') && (await page.locator('.pg-chip').innerText()).includes('GPU box'), await page.locator('.pg-chip').innerText());
await newNotebook('Same PC', 'This PC');
await runCode('import os\nprint("alongside", 6 * 7, os.getpid())');
await page.waitForFunction(() => /alongside 42 \d+/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => undefined);
check('a second playground on the same machine runs at once, in its own kernel', /alongside 42 \d+/.test(await page.locator('body').innerText()));
await page.getByRole('button', { name: 'Library' }).click();
await page.waitForSelector('.pr-dock');
check('the dock has both long runs at once', (await page.locator('.pr-dock .pr-job').count()) === 2, String(await page.locator('.pr-dock .pr-job').count()));
check('the rail counts two', (await page.locator('.rail-run .pr-badge').innerText().catch(() => '')) === '2');
await shot('3-alongside');
await page.waitForSelector('.pr-toast:has-text("GPU check finished")', { timeout: 30_000 }).catch(() => undefined);
check('a toast says the GPU one finished', (await page.locator('.pr-toast:has-text("GPU check finished")').count()) === 1);
await page.waitForSelector('.pr-toast:has-text("Loss sweep finished")', { timeout: 30_000 }).catch(() => undefined);
check('…and the first', (await page.locator('.pr-toast:has-text("Loss sweep finished")').count()) === 1);
await shot('4-toast');

console.log('the list says how each ended');
await toHome();
const sweepRow = page.locator('.pg-row:has-text("Loss sweep")');
const gpuRow = page.locator('.pg-row:has-text("GPU check")');
// Each kept its kernel on its own server: both can be picked back up, variables and all.
check('the GPU one is idle, its variables kept', (await gpuRow.locator('.pr-pill').innerText()).includes('Idle'));
check('…with Shut down beside it', (await gpuRow.getByRole('button', { name: 'Shut down' }).count()) === 1);
check('the first is idle too, and says its run finished', (await sweepRow.locator('.pr-pill').innerText()).includes('Idle') && (await sweepRow.locator('.pr-row-state small').innerText()).includes('ran'), await sweepRow.locator('.pr-row-state').innerText());
await shot('5-home-states');
await sweepRow.getByRole('button', { name: 'Shut down' }).click();
await page.waitForFunction(() => document.querySelector('.pg-row')?.parentElement?.textContent?.includes('Finished'), null, { timeout: 10_000 }).catch(() => undefined);
check('shut down, the first says it finished', (await sweepRow.locator('.pr-pill').innerText()).includes('Finished'), await sweepRow.locator('.pr-pill').innerText());
await sweepRow.getByRole('button', { name: 'Results' }).click();
await page.waitForSelector('.pg-bar');
check('its outputs were kept with the notebook while its page was closed', (await page.locator('body').innerText()).includes('done'));

console.log('the other two ways, chosen');
await toHome();
await page.getByRole('button', { name: 'Show running as…' }).click();
await page.locator('.pr-choose-pop .pr-choose-row:has-text("P opens a switcher") input').check();
await page.locator('.pr-choose-pop .pr-choose-row:has-text("Tabs across the top") input').check();
await shot('6-chooser');
await page.locator('.pr-choose-pop').getByRole('button', { name: 'Close' }).click();
await page.locator('.pg-row:has-text("Loss sweep")').getByRole('button', { name: /Open|Results/ }).click();
await page.waitForSelector('.pg-bar');
await runCode(slow('again'));
await page.waitForFunction(() => document.body.innerText.includes('again 2/20'), null, { timeout: 30_000 });
await page.getByRole('button', { name: 'Library' }).click();
await page.waitForSelector('.pr-tabs');
check('the tabs are above the library', (await page.locator('.pr-tabs .pr-tab').count()) >= 2);
check('the running one’s tab is live', (await page.locator('.pr-tab:has-text("Loss sweep") .pr-dot.is-run').count()) === 1);
await shot('7-tabs');
await page.locator('body').click({ position: { x: 700, y: 400 } }).catch(() => undefined);
await page.keyboard.press('p');
await page.waitForSelector('.pr-switch', { timeout: 3000 }).catch(() => undefined);
check('P opens the switcher', (await page.locator('.pr-switch').count()) === 1);
check('running first', (await page.locator('.pr-switch-group').first().innerText()).includes('Loss sweep'));
await shot('8-switcher');
await page.keyboard.press('Escape');

console.log('Stop, from the dock');
await page.locator('.pr-dock').getByRole('button', { name: 'Stop' }).click();
await page.waitForSelector('.pr-toast.is-stopped', { timeout: 15_000 }).catch(() => undefined);
check('Stop ends it, and a toast says so', (await page.locator('.pr-toast.is-stopped').count()) === 1);
check('the dock goes when nothing runs', (await page.locator('.pr-dock').count()) === 0);
await shot('9-stopped');

console.log('E: beside the paper');
await toHome();
await page.getByRole('button', { name: 'Show running as…' }).click();
await page.locator('.pr-choose-pop .pr-choose-row:has-text("Beside the paper") input').check();
await page.locator('.pr-choose-pop').getByRole('button', { name: 'Close' }).click();
await page.getByRole('button', { name: /From a paper/ }).click();
await page.locator('.pg-papers button:has-text("Attention Is All You Need")').click();
await page.waitForSelector('.pg-sheet');
await page.locator('.pg-title-field input').fill('Attention, tried');
await page.locator('.pg-mode').nth(1).click();
await page.locator('.pg-sheet-foot .btn.primary').click();
await page.waitForSelector('.pg-bar');
const addCode = async () => {
  await page.getByRole('button', { name: '+ Code' }).first().click();
  await page.waitForTimeout(300);
};
await addCode();
await runCode(slow('attn', 10));
await addCode();
await page.locator('.nb-cell').filter({ has: page.locator('textarea') }).last().locator('textarea').fill('print("from the peek", 6 * 7)');
await page.waitForFunction(() => document.body.innerText.includes('attn 2/10'), null, { timeout: 30_000 }).catch(() => undefined);
// To the paper's page, in the app (a reload would end this tab's kernels' connections).
await page.evaluate((id) => {
  history.pushState(null, '', `${location.pathname.replace(/playground.*$/, '')}paper/?id=${encodeURIComponent(id)}`);
  dispatchEvent(new PopStateEvent('popstate'));
}, PAPER);
await page.waitForSelector('.pk', { timeout: 15_000 }).catch(() => undefined);
check('on the paper’s page, the playground that cites it is beside it', (await page.locator('.pk-title').innerText().catch(() => '')).includes('Attention, tried'));
await page.waitForFunction(() => /attn \d+\/10/.test(document.querySelector('.pk-cell.is-running')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => undefined);
check('its running cell is live there', /attn \d+\/10/.test(await page.locator('.pk-cell.is-running').innerText().catch(() => '')));
await shot('10-peek-running');
await page.waitForSelector('.pk-cell.is-running', { state: 'detached', timeout: 30_000 }).catch(() => undefined);
await page.locator('.pk-cell:has-text("from the peek")').getByRole('button', { name: 'Run' }).click();
await page.waitForFunction(() => document.querySelector('.pk')?.textContent?.includes('from the peek 42'), null, { timeout: 30_000 }).catch(() => undefined);
check('Run in the peek runs the cell in the playground’s kernel, from the paper', (await page.locator('.pk').innerText()).includes('from the peek 42'));
check('…and the page is still the paper', new URL(page.url()).pathname.includes('/paper'));
await shot('11-peek-ran');
await page.locator('body').click({ position: { x: 600, y: 450 } }).catch(() => undefined);
await page.keyboard.press('p');
await page.waitForSelector('.pr-switch', { timeout: 3000 }).catch(() => undefined);
await page.locator('.pr-switch-q input').fill('GPU check');
await page.keyboard.press('Control+Enter');
await page.waitForFunction(() => document.querySelector('.pk-title')?.textContent?.includes('GPU check'), null, { timeout: 5000 }).catch(() => undefined);
check('⌘↵ in the switcher puts any playground beside the paper', (await page.locator('.pk-title').innerText().catch(() => '')).includes('GPU check'));
await page.getByRole('button', { name: 'Close the peek' }).click();
check('closed, the one citing the paper is back', (await page.locator('.pk-title').innerText().catch(() => '')).includes('Attention, tried'));

console.log('none of them');
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.waitForSelector('.pr-choose');
for (const row of ['Running now, on the Playground', 'A dock and a count', 'P opens a switcher', 'Tabs across the top', 'Beside the paper']) {
  const box = page.locator(`.pr-choose-row:has-text("${row}") input`);
  if (await box.isChecked()) await box.uncheck();
}
await page.locator('.scrim').click({ position: { x: 5, y: 5 } });
await toHome();
check('with none chosen, the home has no shelf and no states', (await page.locator('.pr-shelf, .pr-pill').count()) === 0);
check('…and no tabs', (await page.locator('.pr-tabs').count()) === 0);

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
