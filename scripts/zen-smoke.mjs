/**
 * Zen mode. A paper is opened, then Z hides the rail, the library and the
 * dock; the page takes the window. The pointer at the left edge brings the
 * rail and the library out, at the right edge the dock, each with its haze
 * over the page, and moving back onto the page puts them away. Each haze
 * (shadow, mist, glow) is photographed, in Reflow and in the PDF as a book,
 * and once more in the dark glass theme.
 *
 *   npm run build && npm start &
 *   node scripts/zen-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const TITLE = 'Reading at the Speed of Thought: Sparse Attention over Long Documents';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a paper ==');
const printer = await browser.newPage();
const para =
  'Long documents strain every reader, human or machine. We study how attention can be spent sparingly: most of a page is context that only needs to be skimmed, and a few passages carry the argument. ';
const section = (n, name) =>
  `<section style="break-after: page"><h2>${n}. ${name}</h2>${`<p>${para.repeat(3)}</p>`.repeat(5)}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <p style="text-align:center">A. Researcher, B. Scholar, C. Student</p>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    ${section(1, 'Introduction')}${section(2, 'Related work')}${section(3, 'Method')}${section(4, 'Experiments')}
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: W, height: H } });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        {
          id: '1001',
          clusterId: '1001',
          title: TITLE,
          url: 'https://example.org/sparse-reading',
          pdfUrl: 'https://example.org/sparse-reading.pdf',
          authors: ['A Researcher', 'B Scholar', 'C Student'],
          snippet: 'Long documents strain every reader.',
        },
      ],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open a paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('sparse attention long documents');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result h3').first().click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/zen-0-before.png` });

const visible = (selector) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).visibility === 'visible');
const settle = () => page.waitForTimeout(700);

console.log('\n== Z goes into zen mode ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('z');
await settle();
check('the app is in zen mode', (await page.locator('.app.is-zen').count()) === 1);
check('the rail is hidden', !(await visible('.rail')));
check('the library is hidden', !(await visible('.library-panel')));
check('the dock is hidden', !(await visible('.dock')));
const mainWidth = await page.locator('.main').evaluate((el) => el.getBoundingClientRect().width);
check('the page has the whole window', mainWidth >= W - 2, `${mainWidth}px`);
await page.screenshot({ path: `${OUT}/zen-1-reflow.png` });

async function peek(side, name) {
  await page.mouse.move(W / 2, H / 2);
  await settle();
  await page.mouse.move(side === 'left' ? 4 : W - 4, H / 2, { steps: 4 });
  await settle();
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

console.log('\n== the left edge ==');
await peek('left', 'zen-2-left-shadow');
check('the rail comes out', await visible('.rail'));
check('the library comes out', await visible('.library-panel'));
check('the dock stays away', !(await visible('.dock')));
check('the haze is over the page', (await page.locator('.zen-haze').evaluate((el) => Number(getComputedStyle(el).opacity))) > 0.9);
await page.mouse.move(W / 2, H / 2, { steps: 4 });
await settle();
check('back on the page, the panes go away', !(await visible('.rail')) && !(await visible('.library-panel')));

console.log('\n== the right edge ==');
await peek('right', 'zen-3-right-shadow');
check('the dock comes out', await visible('.dock'));
check('the rail stays away', !(await visible('.rail')));

async function setSettings(patch) {
  await page.evaluate((next) => {
    const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
    localStorage.setItem('reader.settings', JSON.stringify({ ...saved, ...next }));
  }, patch);
  await page.reload({ waitUntil: 'networkidle' });
  // A reload asks about Drive again, in front of the paper.
  const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForSelector('.app.is-zen', { state: 'attached', timeout: 15000 });
}

console.log('\n== mist and glow ==');
await setSettings({ zenHaze: 'mist', readingMode: 'reflow' });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
check('zen mode survives a reload', (await page.locator('.app.is-zen').count()) === 1);
await peek('left', 'zen-4-left-mist');
await peek('right', 'zen-5-right-mist');
await setSettings({ zenHaze: 'glow' });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await peek('left', 'zen-6-left-glow');
await peek('right', 'zen-7-right-glow');

console.log('\n== the PDF as a book ==');
await setSettings({ zenHaze: 'shadow' });
await page.locator('.segmented button', { hasText: 'PDF' }).click({ timeout: 20000 });
await page.waitForSelector('.pdf-pane iframe', { timeout: 30000 });
await page.getByRole('button', { name: /Read as a book/i }).click();
await page.waitForSelector('.pdf-book-page:not(.drawing)', { timeout: 30000 });
await page.waitForTimeout(800);
await page.mouse.move(W / 2, H / 2);
await settle();
await page.screenshot({ path: `${OUT}/zen-8-pdf.png` });
await peek('left', 'zen-9-pdf-left-shadow');
check('the left edge works over the PDF', await visible('.library-panel'));
await peek('right', 'zen-10-pdf-right-shadow');
check('the right edge works over the PDF', await visible('.dock'));

// The book layout is not kept across a reload, so it is chosen again after each.
async function openBook() {
  await page.waitForSelector('.pdf-pane iframe, .pdf-book-page', { timeout: 30000 });
  const book = page.getByRole('button', { name: /Read as a book/i });
  if (await book.isVisible().catch(() => false)) await book.click();
  await page.waitForSelector('.pdf-book-page:not(.drawing)', { timeout: 30000 });
  await page.waitForTimeout(800);
}

console.log('\n== dark glass ==');
await setSettings({ theme: 'dark', glass: true, glassWall: 'dusk', zenHaze: 'glow', readingMode: 'pdf' });
await openBook();
await peek('left', 'zen-11-dark-glass-left-glow');
await setSettings({ zenHaze: 'shadow' });
await openBook();
await peek('right', 'zen-12-dark-glass-right-shadow');

console.log('\n== Z leaves it ==');
await page.mouse.move(W / 2, H / 2);
await settle();
await page.keyboard.press('z');
await settle();
check('out of zen mode', (await page.locator('.app.is-zen').count()) === 0);
check('the rail is back in its place', await visible('.rail'));

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
