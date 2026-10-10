/**
 * Where a found paper is saved: a collection, never a project unless asked.
 * Home's "Save to" and its menus list collections only, even when a project
 * was the target before; Discover adds to a collection on a project's page,
 * and to the project only from that project's own "Add papers".
 *
 *   npm run build && npm start &
 *   node scripts/save-target-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  localStorage.setItem('reader.welcomed', 'true');
  // Before: a project was the search's target.
  localStorage.setItem('reader.home', JSON.stringify({ opensOn: 'search', tabs: ['search', 'continue', 'today', 'projects', 'inbox', 'board'], last: 'search', clearPanels: false, saveTo: 'p-test', v: 2 }));
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
  await run('collections', (s) => s.put({ id: 'p-test', name: 'Test Project', color: '#1f5e52', createdAt: '2026-01-01T00:00:00.000Z', project: { question: '', startedAt: '2026-01-01T00:00:00.000Z', roles: {}, todos: [] } }));
  await run('collections', (s) => s.put({ id: 'c-reading', name: 'Reading', color: '#2f7d6d', createdAt: '2026-01-02T00:00:00.000Z' }));
  await run('papers', (s) => s.put({ id: 'arxiv:1706.03762', source: 'arxiv', arxivId: '1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], abstract: '', published: '2017-06-12', categories: [], addedAt: '2026-01-03T00:00:00.000Z', collectionIds: ['p-test'], tags: [], progress: 0.1, lastOpenedAt: '2026-01-04T00:00:00.000Z' }));
  db.close();
});
await page.goto(BASE, { waitUntil: 'networkidle' });

console.log('Home: Save to');
const saveTo = page.getByRole('combobox', { name: 'Save to collection' });
await saveTo.waitFor({ timeout: 15000 });
const options = await saveTo.locator('option').allInnerTexts();
check('Save to lists collections, not projects', !options.includes('Test Project') && options.includes('Reading'), options.join(' | '));
check('a project that was the target before gives way to a collection', (await saveTo.inputValue()) === 'c-reading');
const side = await page.locator('.find-colls').innerText();
check('the side list of collections to drop on has no project', !/Test Project/.test(side) && /Reading/.test(side), side.replace(/\s+/g, ' ').slice(0, 120));
await page.screenshot({ path: `${OUT}/save-target-home.png` });

console.log('Discover on a project’s page');
await page.goto(`${BASE}/project/?id=p-test`, { waitUntil: 'networkidle' });
const discoverTab = page.locator('.dock-tabs').getByRole('tab', { name: 'Discover' });
if (await discoverTab.isVisible().catch(() => false)) await discoverTab.click();
else await page.getByRole('button', { name: /Discover/ }).first().click();
const addTo = page.locator('#discover-target');
await addTo.waitFor({ timeout: 10000 });
check('open beside a project, it adds to a collection', (await addTo.inputValue()) === 'c-reading', await addTo.inputValue());
check('and offers no project', !(await addTo.locator('option').allInnerTexts()).some((text) => /Test Project/.test(text)));
await page.getByRole('button', { name: /Add papers/ }).first().click();
await page.waitForTimeout(300);
check('the project’s own Add papers adds to the project', (await addTo.inputValue()) === 'p-test', await addTo.inputValue());
await page.screenshot({ path: `${OUT}/save-target-discover.png` });

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
