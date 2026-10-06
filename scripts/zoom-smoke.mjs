/**
 * Zooming the PDF: a pinch (⌘ with the wheel) draws the pages larger round
 * the pointer and puts the minimap up, 0 fits them again, + and − step; L
 * is the loupe, a glass over the page that follows the pointer; C, or
 * ⌥-click on one, is a close-up of a figure, table or equation, which Tab
 * steps through and Esc closes. Checked scrolled and as a book, in zen mode,
 * on a two-column paper. Writes screenshots of each state to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/zoom-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const PDF = await readFile(new URL('./fixtures/ieee-two-column.pdf', import.meta.url));
const TITLE = 'ORB-NET: Orbit-Aware Planning Models for Sample-Efficient Robot Control';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
// Nothing else leaves the machine but the fonts.
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const PAPER = {
  id: 'scholar:orb',
  source: 'scholar',
  title: TITLE,
  authors: ['A Author', 'B Author'],
  abstract: '',
  published: '2022-01-01',
  categories: [],
  addedAt: ago(240),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0.1,
  lastOpenedAt: ago(2),
  pdfUrl: 'https://example.org/orb.pdf',
};

let page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async ({ paper }) => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme: 'dark', readingMode: 'pdf' }));
  localStorage.setItem('reader.view', JSON.stringify({ kind: 'paper', id: paper.id }));
  localStorage.setItem('reader.zen', 'true');
  localStorage.removeItem('reader.spots');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('reader', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const put = (store, value) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  const clear = (store) =>
    new Promise((resolve) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = resolve;
    });
  for (const store of ['papers', 'collections', 'highlights']) await clear(store);
  await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
  await put('papers', paper);
  db.close();
}, { paper: PAPER });
await page.reload({ waitUntil: 'networkidle' });
const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await skip.isVisible().catch(() => false)) await skip.click();

const shot = (name) => page.screenshot({ path: `${OUT}/zoom-${name}.png` });
const settle = (ms = 600) => page.waitForTimeout(ms);
const drawn = () => page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
const pageWidth = () => page.locator('.pdf-book-page').first().evaluate((element) => element.getBoundingClientRect().width);
const pageBox = () => page.locator('.pdf-book-page[data-page="1"]').evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
/** A pinch, as the browser reports it: a wheel with ctrl held, at a point. */
const pinch = (x, y, deltaY) =>
  page.evaluate(
    ({ x, y, deltaY }) => {
      document.elementFromPoint(x, y)?.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { x, y, deltaY },
  );
const zoomPct = async () => Number(((await page.locator('.pdf-zoom-pct').textContent()) || '0').replace('%', ''));

console.log('\n== the paper, scrolled, in zen mode ==');
await page.waitForSelector('.main[data-paper-id="scholar:orb"]', { timeout: 15000 });
await drawn();
await settle(1000);
check('the app is in zen mode', (await page.locator('.app.is-zen').count()) === 1);
check('the PDF is scrolled', (await page.locator('.pdf-scroll').count()) === 1);
check('the zoom reads 100%', (await zoomPct()) === 100);
check('no minimap while the page fits', (await page.locator('.pdf-minimap').count()) === 0);
const fitWidth = await pageWidth();
await shot('0-fit');

console.log('\n== a pinch zooms round the pointer ==');
let box = await pageBox();
const under = { x: box.x + box.width * 0.72, y: 420 };
// The point of the page under the pointer, as a fraction of it, before.
const before = { fx: (under.x - box.x) / box.width, fy: (under.y - box.y) / box.height };
await page.mouse.move(under.x, under.y);
for (let i = 0; i < 6; i++) {
  await pinch(under.x, under.y, -40);
  await page.waitForTimeout(40);
}
await settle(900);
await drawn();
const zoomedWidth = await pageWidth();
check('the page is drawn larger', zoomedWidth > fitWidth * 1.5, `${Math.round(fitWidth)} → ${Math.round(zoomedWidth)}px`);
check('the zoom reads more than 100%', (await zoomPct()) > 150, `${await zoomPct()}%`);
check('the frame is marked zoomed', (await page.locator('.pdf-book-spread.is-zoomed').count()) === 1);
check('the page is drawn sharp at the new size', await page.locator('.pdf-book-page canvas').first().evaluate((canvas) => canvas.width >= canvas.getBoundingClientRect().width * 1.9));
box = await pageBox();
const after = { fx: (under.x - box.x) / box.width, fy: (under.y - box.y) / box.height };
// Sideways it can drift a little at first: while the page is still narrower than the frame it is centred, and cannot be scrolled to the pointer.
check('the point under the pointer stayed put', Math.abs(after.fx - before.fx) < 0.06 && Math.abs(after.fy - before.fy) < 0.02, `${before.fx.toFixed(2)},${before.fy.toFixed(2)} → ${after.fx.toFixed(2)},${after.fy.toFixed(2)}`);
check('the minimap is up', (await page.locator('.pdf-minimap').count()) === 1);
check('the minimap marks the part on screen', await page.locator('.pdf-minimap-window').evaluate((el) => parseFloat(el.style.width) > 10 && parseFloat(el.style.width) < 100));
await shot('1-pinched');

console.log('\n== the minimap goes elsewhere; 0 fits the page again ==');
const scrolledBefore = await page.locator('.pdf-scroll').evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
const map = await page.locator('.pdf-minimap').boundingBox();
await page.mouse.click(map.x + map.width * 0.2, map.y + map.height * 0.5);
await settle(300);
const scrolledAfter = await page.locator('.pdf-scroll').evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
check('a click on the minimap scrolls the frame', scrolledAfter.left !== scrolledBefore.left || scrolledAfter.top !== scrolledBefore.top, JSON.stringify({ scrolledBefore, scrolledAfter }));
await page.keyboard.press('0');
await settle(800);
check('0 fits the page again', Math.abs((await pageWidth()) - fitWidth) < 2 && (await zoomPct()) === 100);
check('the minimap goes with it', (await page.locator('.pdf-minimap').count()) === 0);
await page.keyboard.press('+');
await settle(500);
check('+ zooms in a step', (await zoomPct()) === 125);
await page.keyboard.press('-');
await settle(500);
check('− zooms back out', (await zoomPct()) === 100);
check('the nav has the zoom buttons', (await page.locator('.pdf-zoom-ctl button').count()) === 3);

console.log('\n== L is a loupe over the page ==');
await page.keyboard.press('l');
await page.mouse.move(under.x + 3, under.y + 3);
await settle(900);
check('the loupe is out, under the pointer', (await page.locator('.pdf-loupe').count()) === 1);
const lens = await page.locator('.pdf-loupe').boundingBox();
check('the glass is centred on the pointer', lens && Math.abs(lens.x + lens.width / 2 - (under.x + 3)) < 2 && Math.abs(lens.y + lens.height / 2 - (under.y + 3)) < 2);
check('it shows something', await page.locator('.pdf-loupe canvas').evaluate((canvas) => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4 * 97) if (data[i] < 128) dark++;
  return dark > 20;
}));
check('its chip says the magnification', /Loupe\s*2\.2×/.test((await page.locator('.pdf-loupe-chip').textContent()) || ''));
check('the Loupe button is pressed', (await page.locator('.loupe-btn').getAttribute('aria-pressed')) === 'true');
await shot('2-loupe');
await page.keyboard.press('+');
await settle(200);
check('+ magnifies the glass, not the page', /2\.7×/.test((await page.locator('.pdf-loupe-chip').textContent()) || '') && (await zoomPct()) === 100);
await page.mouse.move(20, 450);
await settle(200);
check('off the page the glass is away', (await page.locator('.pdf-loupe').count()) === 0);
await page.keyboard.press('l');
await page.mouse.move(under.x, under.y);
await settle(200);
check('L puts it away', (await page.locator('.pdf-loupe').count()) === 0);

console.log('\n== C is a close-up of a figure, table or equation ==');
await page.keyboard.press('c');
await page.waitForSelector('.pdf-closeup-card.is-drawn', { timeout: 30000 });
await settle(400);
const title1 = (await page.locator('.pdf-closeup-title').textContent()) || '';
check('a close-up is up', /page 1/.test(title1), title1);
check('the dots count the blocks on the page', (await page.locator('.pdf-closeup-dots i').count()) >= 2);
check('the picture is large', await page.locator('.pdf-closeup-card canvas').evaluate((canvas) => canvas.getBoundingClientRect().width > 700));
await shot('3-closeup');
await page.keyboard.press('Tab');
await page.waitForSelector('.pdf-closeup-card.is-drawn', { timeout: 30000 });
await settle(300);
const title2 = (await page.locator('.pdf-closeup-title').textContent()) || '';
check('Tab goes on to the next', title2 !== title1, `${title1} → ${title2}`);
check('the page did not turn under it', (await page.locator('.book-folio').textContent() || '').startsWith('Page 1'));
await page.keyboard.press('Escape');
await settle(300);
check('Esc puts the page back', (await page.locator('.pdf-closeup').count()) === 0);

console.log('\n== ⌥-click a table for its close-up ==');
box = await pageBox();
await page.keyboard.down('Alt');
await page.mouse.click(box.x + box.width * 0.72, box.y + box.height * 0.62);
await page.keyboard.up('Alt');
await page.waitForSelector('.pdf-closeup-card.is-drawn', { timeout: 30000 });
const title3 = (await page.locator('.pdf-closeup-title').textContent()) || '';
check('the table under the pointer is the one shown', /Table/i.test(title3), title3);
check('its caption is under it', ((await page.locator('.pdf-closeup-caption').textContent()) || '').length > 20);
await shot('4-closeup-table');
await page.locator('.pdf-closeup-back').click({ position: { x: 20, y: 20 } });
await settle(300);
check('a click beside it puts the page back', (await page.locator('.pdf-closeup').count()) === 0);

console.log('\n== as a book, the same ==');
// The top bar is away in zen mode: the pointer at the top edge brings it out.
await page.mouse.move(720, 450);
await settle(400);
await page.mouse.move(720, 3, { steps: 4 });
await settle(800);
await page.getByRole('button', { name: /Read as a book/i }).click();
await page.waitForSelector('.pdf-book-spread:not(.pdf-scroll)', { timeout: 15000 });
await drawn();
await settle(800);
const bookFit = await pageWidth();
await page.mouse.move(720, 450);
await page.keyboard.press('+');
await page.keyboard.press('+');
await settle(900);
await drawn();
check('+ draws the book\'s pages larger', (await pageWidth()) > bookFit * 1.4, `${Math.round(bookFit)} → ${Math.round(await pageWidth())}px`);
check('the spread scrolls over them', await page.locator('.pdf-book-spread').evaluate((el) => el.scrollWidth > el.clientWidth + 10 || el.scrollHeight > el.clientHeight + 10));
check('the minimap is up', (await page.locator('.pdf-minimap').count()) === 1);
await shot('5-book-zoomed');
// One page at a time, so there is a page to turn to in a two-page paper.
await page.locator('.pdf-pages-choice button', { hasText: '1 page' }).click();
await settle(600);
await page.keyboard.press('ArrowRight');
await settle(600);
check('the arrow keys still turn the page', (await page.locator('.book-folio').textContent() || '').startsWith('Page 2'), (await page.locator('.book-folio').textContent()) || '');
await page.keyboard.press('0');
await settle(600);
check('0 fits the spread again', Math.abs((await pageWidth()) - bookFit) < 2);

check('no errors on the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nAll good.');
process.exit(problems.length ? 1 : 0);
