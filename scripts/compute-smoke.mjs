/**
 * Turning compute on and off, each way Settings offers: Settings → Compute,
 * the switches where a project's code is set up, and the chip in the rail;
 * Colab turned off and left out of "Where should it run?". Also the paper
 * window's bar, which leaves room to drag it, and the Overleaf Open-in menu,
 * solid under glass. Stands in for this computer's Companion, and writes
 * screenshots to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/compute-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const PAPERS = [
  { id: 'arxiv:1706.03762', source: 'arxiv', arxivId: '1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], abstract: 'The dominant sequence transduction models…', published: '2017-06-12', categories: [], addedAt: new Date().toISOString(), collectionIds: ['p-tp'], tags: [], progress: 0.14, lastOpenedAt: new Date().toISOString() },
  { id: 'arxiv:2101.03961', source: 'arxiv', arxivId: '2101.03961', title: 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', authors: ['William Fedus'], abstract: '…', published: '2021-01-11', categories: [], addedAt: new Date().toISOString(), collectionIds: ['p-tp'], tags: [], progress: 0 },
];
const SERVERS = [
  { id: 's-mac', name: 'Saurav’s MacBook Air', url: 'http://127.0.0.1:47321/', token: 'pc-token', where: 'pc', companionId: 'mac-1' },
  { id: 's-gpu', name: 'Lab A100', url: 'https://gpu.example.org/', token: 't', where: 'remote' },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
// This computer's Companion, standing in: it answers, and Stop shuts it down.
let companionUp = true;
await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if (url.port === '47331') return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  if (!companionUp) return route.abort();
  if (url.pathname === '/companion/info') return json({ app: 'reader-companion', version: '0.9.0', id: 'mac-1', name: 'Saurav’s MacBook Air', hardware: '', root: '' });
  if (url.pathname === '/companion/shutdown') {
    companionUp = false;
    return json({ ok: true });
  }
  return json({ error: 'no' }, 404);
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function seed(settings, address) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ papers, settings, servers }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), ...settings }));
      localStorage.setItem('reader.playground.servers', JSON.stringify(servers));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('reader', 1);
        request.onupgradeneeded = () => {
          const made = request.result;
          for (const store of ['papers', 'collections']) if (!made.objectStoreNames.contains(store)) made.createObjectStore(store, { keyPath: 'id' });
          if (!made.objectStoreNames.contains('highlights')) made.createObjectStore('highlights', { keyPath: 'id' }).createIndex('paperId', 'paperId', { unique: false });
          if (!made.objectStoreNames.contains('kv')) made.createObjectStore('kv');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const run = (store, act) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite');
          act(tx.objectStore(store));
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      for (const store of ['papers', 'collections', 'kv']) await run(store, (s) => s.clear());
      await run('collections', (s) =>
        s.put({ id: 'p-tp', name: 'Test Project', color: '#1f5e52', createdAt: new Date().toISOString(), project: { question: '', startedAt: new Date().toISOString(), roles: {}, todos: [], overleaf: { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', account: 'saurav07@bu.edu' } } }),
      );
      for (const paper of papers) await run('papers', (s) => s.put(paper));
      db.close();
    },
    { papers: PAPERS, settings, servers: SERVERS },
  );
  await go(address);
}

/** A page, past the welcome's offer to connect Drive. */
async function go(address) {
  await page.goto(`${BASE}${address}`, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

const base = { googleClientId: 'test.apps.googleusercontent.com', proxyBase: 'http://localhost:9/', navStyle: 'labelled' };

console.log('the project card: a switch on each place to run (the default)');
await page.evaluate?.(() => undefined);
await seed(base, '/project/?id=p-tp&view=workspace');
await page.evaluate(() => localStorage.setItem('reader.project.layout', 'code'));
await go('/project/?id=p-tp&view=workspace');
await page.locator('.pj-ready').waitFor({ timeout: 15000 }).catch(async () => (await shot('compute-fail'), console.log(errors, (await page.locator('body').innerText()).slice(0, 300))));
const switches = page.locator('.pj-ready [role=switch]');
check('Colab and each of your computers have a switch', (await switches.count()) === 2, String(await switches.count()));
check('the card links to Settings → Compute', (await page.getByRole('button', { name: /Manage compute/ }).count()) === 1);
await page.locator('.pj-ready').getByRole('switch', { name: /Colab: on/ }).click();
check('Colab off: the card says so', /turned off/.test(await page.locator('.pj-ready li').first().innerText()));
await shot('compute-card');
await page.getByRole('button', { name: /Start the project’s code/ }).click();
await page.locator('.pg-sheet').waitFor({ timeout: 5000 });
const chosen = await page.locator('.pg-mode.is-on').innerText();
check('Where should it run? starts on your computer, not Colab, while Colab is off', !/Colab, in the browser/.test(chosen), chosen.split('\n')[0]);
await page.locator('.pg-mode', { hasText: 'Colab, in the browser' }).click();
check('picked anyway, Colab says it is off, with a way to turn it on', (await page.locator('.pg-mode.is-on').getByRole('button', { name: 'Turn it on' }).count()) === 1);
await page.keyboard.press('Escape');
await page.locator('.pg-sheet .icon-btn[aria-label=Close]').click().catch(() => {});

console.log('the paper window: room on its bar to drag it');
const chip = page.locator('.pj-strip-chip').first();
await chip.click();
await page.getByRole('button', { name: 'Float over the code' }).click();
const bar = page.locator('.paper-win .win-bar');
await bar.waitFor({ timeout: 5000 });
const barBox = await bar.boundingBox();
const pickBox = await page.locator('.paper-win-pick').boundingBox();
const ctlBox = await page.locator('.paper-win .win-ctl').boundingBox();
const free = ctlBox.x - (pickBox.x + pickBox.width);
check('the paper picker is as wide as its title, and leaves the bar free to grab', pickBox.width < barBox.width * 0.6 && free > 60, `picker ${Math.round(pickBox.width)} of ${Math.round(barBox.width)}, ${Math.round(free)}px free`);
const before = await page.locator('.paper-win').boundingBox();
await page.mouse.move(pickBox.x + pickBox.width + free / 2, barBox.y + barBox.height / 2);
await page.mouse.down();
await page.mouse.move(pickBox.x + pickBox.width + free / 2 - 120, barBox.y + barBox.height / 2 + 60, { steps: 8 });
await page.mouse.up();
const after = await page.locator('.paper-win').boundingBox();
check('dragging the free part of the bar moves the window', Math.abs(after.x - before.x) > 60 || Math.abs(after.y - before.y) > 30, `${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(after.x)},${Math.round(after.y)}`);
await shot('paper-window-bar');

console.log('Settings → Compute');
await seed(base, '/project/?id=p-tp');
await page.evaluate(() => window.dispatchEvent(new Event('reader:open-settings')));
const list = page.locator('#settings-compute .cp-list');
await list.waitFor({ timeout: 5000 });
await list.scrollIntoViewIfNeeded();
await page.locator('#settings-compute .cp-row', { hasText: 'MacBook' }).getByText('running').waitFor({ timeout: 8000 }).catch(() => {});
const rows = await page.locator('#settings-compute .cp-row').allInnerTexts();
check('it lists Colab, this computer (running) and the server (not answering)', rows.length === 3 && /running/.test(rows[1]) && /not answering/.test(rows[2]), rows.map((r) => r.replace(/\s+/g, ' ')).join(' | '));
const choices = page.getByRole('radiogroup', { name: /Where compute is turned on and off/ });
check('four ways to have it, Everywhere the default', (await choices.getByRole('radio').count()) === 4 && /default/.test(await choices.getByRole('radio').first().innerText()) && (await choices.getByRole('radio').first().getAttribute('aria-checked')) === 'true');
await shot('compute-settings');
await page.locator('#settings-compute .cp-row', { hasText: 'MacBook' }).getByRole('button', { name: 'Stop' }).click();
await page.locator('#settings-compute .cp-row', { hasText: 'MacBook' }).getByRole('button', { name: 'Start' }).waitFor({ timeout: 8000 }).catch(() => {});
check('Stop shuts the Companion down, and offers Start', !companionUp && (await page.locator('#settings-compute .cp-row', { hasText: 'MacBook' }).getByRole('button', { name: 'Start' }).count()) === 1);
companionUp = true;
await choices.getByRole('radio', { name: /Only in Settings/ }).click();
await page.keyboard.press('Escape');

console.log('Only in Settings: no switches on the card, no chip');
await go('/project/?id=p-tp&view=workspace');
await page.locator('.pj-ready').waitFor({ timeout: 15000 });
check('no switches on the card', (await page.locator('.pj-ready [role=switch]').count()) === 0);
check('no chip in the rail', (await page.locator('.cp-chip').count()) === 0);

console.log('the rail chip (default)');
await seed({ ...base, computeControls: 'everywhere' }, '/project/?id=p-tp');
const railChip = page.locator('.cp-chip');
await railChip.waitFor({ timeout: 10000 });
await railChip.click();
await page.locator('.cp-pop .cp-row').first().waitFor({ timeout: 5000 });
check('the chip opens the list, a switch for each place', (await page.locator('.cp-pop [role=switch]').count()) === 3);
await shot('compute-rail');
await page.keyboard.press('Escape');

console.log('the Overleaf menu under glass');
await seed({ ...base, glass: true, theme: 'dark' }, '/project/?id=p-tp');
await page.locator('.ol-card .ol-open-more').click();
await page.locator('.ol-menu').waitFor({ timeout: 5000 });
await page.waitForTimeout(1600);
const solid = await page.evaluate(() => {
  const menu = document.querySelector('.ol-menu');
  const box = menu.getBoundingClientRect();
  const top = document.elementFromPoint(box.left + box.width / 2, box.bottom - 12);
  const alpha = (getComputedStyle(menu).backgroundColor.match(/[\d.]+/g) || []).map(Number)[3] ?? 1;
  return { onTop: menu.contains(top), alpha };
});
check('the menu is on top of the cards below it', solid.onTop);
check('and nearly solid', solid.alpha >= 0.9, String(solid.alpha));
await page.locator('.ol-menu').scrollIntoViewIfNeeded();
await shot('overleaf-menu-glass');

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
