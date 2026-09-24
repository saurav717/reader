/**
 * The library: the list and the cards, selecting papers with their tick
 * boxes and doing things to them all at once — filing them in a collection,
 * marking them read, moving them to Junk — and Junk itself, where a removed
 * paper waits to be put back. Seeds a library of seven papers and writes
 * screenshots of each state to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/library-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const day = (ago) => new Date(Date.now() - ago * 24 * 3600 * 1000).toISOString();
const paper = (id, title, authors, extra) => ({
  id,
  source: 'scholar',
  title,
  authors,
  abstract: '',
  published: '',
  categories: [],
  addedAt: day(0),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0,
  ...extra,
});
const PAPERS = [
  paper('scholar:1', 'Fusion of medical imaging and electronic health records using deep learning: a systematic review and implementation guidelines', ['SC Huang', 'A Pareek', 'S Seyyedi', 'I Banerjee', 'MP Lungren'], { venue: 'NPJ digital medicine', published: '2020-01-01', addedAt: day(0) }),
  paper('books:bishop', 'Pattern Recognition and Machine Learning', ['Christopher M. Bishop'], { source: 'books', published: '2016-01-01', addedAt: day(0), landingUrl: 'https://openlibrary.org/works/OL1' }),
  paper('scholar:2', 'The utility of lesion classification in predicting language and treatment outcomes in chronic stroke-induced aphasia', ['EL Meier', 'JP Johnson', 'Y Pan', 'S Kiran'], { venue: 'Brain imaging and behavior', published: '2019-01-01', addedAt: day(1), progress: 0.01, lastOpenedAt: day(0) }),
  paper('scholar:3', 'Achieving sub-millimetre precision with a solid-state full-field heterodyning range imaging camera', ['AA Dorrington', 'MJ Cree', 'AD Payne', 'RM Conroy'], { venue: 'Measurement Science and Technology', published: '2007-01-01', addedAt: day(3) }),
  paper('scholar:4', 'Pattern recognition and machine learning', ['CM Bishop', 'NM Nasrabadi'], { venue: 'Journal of electronic imaging', published: '2006-01-01', addedAt: day(3) }),
  paper('scholar:5', 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data', ['S Chennuri', 'S Lai', 'A Billot', 'M Varkanitsa', 'S Kiran'], { venue: 'Proceedings of the IEEE/CVF International Conference on Computer Vision', published: '2023-01-01', addedAt: day(12), progress: 0.08, lastOpenedAt: day(1) }),
  paper('arxiv:2503.07137', 'A comprehensive survey of mixture-of-experts: Algorithms, theory, and applications', ['S Mu', 'S Lin'], { source: 'arxiv', arxivId: '2503.07137', published: '2025-03-10', addedAt: day(40), progress: 0.63, lastOpenedAt: day(2) }),
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
// Nothing leaves the machine but the fonts.
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

async function seed(settings) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ papers, settings }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), ...settings }));
      localStorage.setItem('reader.view', JSON.stringify({ kind: 'all' }));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('reader', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const put = (store, value, key) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value, key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      const clear = (store) =>
        new Promise((resolve) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).clear();
          tx.oncomplete = resolve;
        });
      await clear('papers');
      await clear('collections');
      await clear('kv');
      await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
      await put('collections', { id: 'c-stroke', name: 'Aphasia & stroke', color: '#b0643c', createdAt: new Date().toISOString() });
      await put('collections', { id: 'c-ml', name: 'Machine learning', color: '#5b63b7', createdAt: new Date().toISOString() });
      for (const paper of papers) await put('papers', paper);
      await put('highlights', { id: 'h1', paperId: 'scholar:5', color: 'yellow', exact: 'aphasia', prefix: '', suffix: '', hint: 0, tags: [], createdAt: new Date().toISOString() });
      await put('highlights', { id: 'h2', paperId: 'scholar:5', color: 'green', exact: 'severity', prefix: '', suffix: '', hint: 0, tags: [], createdAt: new Date().toISOString() });
      db.close();
    },
    { papers: PAPERS, settings },
  );
  await reload();
}

/** A reload, past the welcome's offer to connect Drive. */
async function reload() {
  await page.reload({ waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForSelector('.library-panel .nav-item', { timeout: 15000 });
}

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
/** Discover out of the way, so the list has the room it would have. */
async function closeDiscover() {
  const close = page.locator('.dock').getByRole('button', { name: /close/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

console.log('\n== the list, dark glass ==');
await seed({ theme: 'dark', glass: true, glassWall: 'spotlight', libraryLayout: undefined });
await page.evaluate(() => { localStorage.removeItem('reader.libraryView'); localStorage.setItem('reader.libraryLayout', 'list'); });
await reload();
await closeDiscover();
check('seven papers in the list', (await page.locator('.lib-row').count()) === 7);
check('grouped by when they were added', (await page.locator('.lib-group').allTextContents()).map((text) => text.replace(/\d+$/, '')).join('|').startsWith('Today|Yesterday|This week'));
check('Junk is in the side pane', (await page.locator('.library-panel .nav-item', { hasText: 'Junk' }).count()) === 1);
await page.locator('.lib-row').nth(2).hover();
await shot('library-list-dark');

console.log('\n== the cards ==');
await page.getByRole('button', { name: 'Show as cards' }).click();
await page.waitForSelector('.lib-card');
check('the same papers as cards', (await page.locator('.lib-card').count()) === 7);
await page.locator('.lib-card').nth(1).hover();
await shot('library-cards-dark');
await page.getByRole('button', { name: 'Show as a list' }).click();

console.log('\n== selecting ==');
await page.locator('.lib-row').nth(0).locator('.cover').click();
await page.locator('.lib-row').nth(3).locator('.cover').click({ modifiers: ['Shift'] });
check('shift-click selects the range', (await page.locator('.lib-row.is-selected').count()) === 4, String(await page.locator('.lib-row.is-selected').count()));
check('the selection bar says so', ((await page.locator('.selection-count').textContent()) || '').startsWith('4 selected'));
await page.getByRole('button', { name: 'Add to' }).click();
await shot('library-selection-dark');
await page.locator('.menu button', { hasText: 'Machine learning' }).click();
await page.waitForSelector('.lib-toast');
check('added to the collection', ((await page.locator('.library-panel .nav-item', { hasText: 'Machine learning' }).locator('.count').textContent()) || '') === '4');
check('the selection is let go after', (await page.locator('.selection-bar').count()) === 0);

await page.locator('.lib-row').nth(4).locator('.cover').click();
await page.getByRole('button', { name: 'Mark as' }).click();
await page.locator('.menu button', { hasText: 'Finished' }).click();
await page.waitForTimeout(300);
check('marked finished', ((await page.locator('.library-panel .nav-item', { hasText: 'Finished' }).locator('.count').textContent()) || '') === '1');

console.log('\n== to Junk and back ==');
await page.keyboard.press('Control+a');
check('⌘A / Ctrl+A selects the whole list', (await page.locator('.lib-row.is-selected').count()) === 7);
await page.keyboard.press('Escape');
await page.locator('.lib-row').nth(0).locator('.cover').click();
await page.locator('.lib-row').nth(1).locator('.cover').click();
await page.locator('.selection-bar').getByRole('button', { name: 'Move to Junk' }).click();
await page.getByRole('button', { name: 'Move 2 to Junk' }).click();
await page.waitForFunction(() => document.querySelectorAll('.lib-row').length === 5, null, { timeout: 5000 }).catch(() => {});
check('two papers leave the list', (await page.locator('.lib-row').count()) === 5);
check('Junk counts them', ((await page.locator('.library-panel .nav-item', { hasText: 'Junk' }).locator('.count').textContent()) || '') === '2');
await page.locator('.library-panel .nav-item', { hasText: 'Junk' }).click();
await page.waitForSelector('.lib-row.is-junk');
check('Junk lists them', (await page.locator('.lib-row.is-junk').count()) === 2);
await shot('library-junk-dark');
await page.locator('.lib-row.is-junk').first().getByRole('button', { name: /Restore/ }).click();
await page.waitForFunction(() => document.querySelectorAll('.lib-row.is-junk').length === 1, null, { timeout: 5000 }).catch(() => {});
check('Restore puts one back', ((await page.locator('.library-panel .nav-item', { hasText: 'All papers' }).locator('.count').textContent()) || '') === '6');
await page.locator('.lib-row.is-junk').first().getByRole('button', { name: /Delete .* forever/ }).click();
await page.locator('.sheet').getByRole('button', { name: 'Delete forever' }).click();
await page.waitForTimeout(300);
check('Delete forever empties Junk', (await page.locator('.lib-row.is-junk').count()) === 0);

console.log('\n== after a reload ==');
await reload();
await page.locator('.library-panel .nav-item', { hasText: 'All papers' }).click();
await page.waitForSelector('.lib-row');
check('the restored paper is still there', (await page.locator('.lib-row').count()) === 6);
check('Junk stays empty', ((await page.locator('.library-panel .nav-item', { hasText: 'Junk' }).locator('.count').textContent()) || '') === '0');

console.log('\n== the View menu ==');
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.waitForSelector('.view-menu');
await page.locator('.view-menu').getByRole('menuitemradio', { name: 'Compact table' }).click();
await page.locator('.view-menu').getByRole('menuitemradio', { name: 'Reading status' }).click();
await page.locator('.view-menu').getByRole('menuitemradio', { name: 'Title' }).click();
await shot('library-view-menu-dark');
check('the menu stays open while choosing', await page.locator('.view-menu').isVisible());
await page.keyboard.press('Escape');
check('the compact table has a line a paper', (await page.locator('.lib-table .lib-line').count()) === 6, String(await page.locator('.lib-table .lib-line').count()));
const statusGroups = (await page.locator('.lib-group').allTextContents()).map((text) => text.replace(/\d+$/, ''));
check('grouped by reading status', statusGroups.join('|') === 'Reading now|Not started|Finished', statusGroups.join('|'));
const firstGroup = await page.locator('.lib-table').first().locator('.lib-line-text').allTextContents();
check('sorted by title within a group', JSON.stringify(firstGroup) === JSON.stringify([...firstGroup].sort((a, b) => a.localeCompare(b))), firstGroup.join(' / '));
await shot('library-compact-dark');
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.locator('.view-menu').getByRole('menuitemcheckbox', { name: 'Authors' }).click();
await page.keyboard.press('Escape');
check('a detail can be hidden', (await page.locator('.lib-line-head span', { hasText: 'Authors' }).count()) === 0);
await reload();
await page.locator('.library-panel .nav-item', { hasText: 'All papers' }).click();
check('the choice is remembered', (await page.locator('.lib-table .lib-line').count()) === 6 && (await page.locator('.lib-line-head span', { hasText: 'Authors' }).count()) === 0);
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.locator('.view-menu').getByRole('menuitem', { name: 'Reset to default' }).click();
await page.keyboard.press('Escape');
check('Reset to default brings back the list', (await page.locator('.lib-row').count()) === 6);

console.log('\n== light ==');
await seed({ theme: 'light', glass: false });
await page.evaluate(() => { localStorage.removeItem('reader.libraryView'); localStorage.setItem('reader.libraryLayout', 'list'); });
await reload();
await closeDiscover();
await shot('library-list-light');
await page.getByRole('button', { name: 'Show as cards' }).click();
await shot('library-cards-light');
await page.getByRole('button', { name: 'Show as a list' }).click();

console.log('\n== a phone ==');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await closeDiscover();
const libraryClose = page.getByRole('button', { name: 'Close the library panel' });
if (await libraryClose.isVisible().catch(() => false)) await libraryClose.click();
await page.locator('.lib-row').nth(2).locator('.cover').click();
await page.waitForTimeout(200);
await shot('library-phone');

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
