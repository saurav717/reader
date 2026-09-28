/**
 * Home: what R on the rail opens, and where a visit starts. Seeds a library
 * with a paper printed by Chromium, reads it as a PDF to page 3, and checks
 * that R brings Home up with that page on it and a line where the screen
 * began; that Enter goes back into the paper; that the same is true read
 * reflowed; that a new tab starts on Home while a reload stays put; and that
 * Home's other views — Today, Projects, Inbox — are a key away, with the
 * one it opens on chosen from its menu. Writes
 * screenshots of each state to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/home-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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

const TITLE = 'Fourier Neural Operator for Parametric Partial Differential Equations';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a six-page paper ==');
const printer = await browser.newPage();
const para = (n, i) =>
  `<p>In section ${n}, paragraph ${i}: the neural operator is formulated as an iterative architecture in which each update composes a non-local integral operator with a local, nonlinear activation function, so that the same parameters can be evaluated on any discretisation of the domain.</p>`;
const section = (n) =>
  `<section style="break-after: page"><h2>${n} Section ${n}</h2>${[1, 2, 3].map((i) => para(n, i)).join('')}<p style="text-align:center;font-style:italic">(K(φ)v)(x) = F⁻¹(R · (Fv))(x) &nbsp; (${n})</p>${[4, 5, 6, 7].map((i) => para(n, i)).join('')}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 12pt; line-height: 1.45; margin: 0 1in"><h1 style="text-align:center">${TITLE}</h1><p style="text-align:center">Zongyi Li · Nikola Kovachki</p>${[1, 2, 3, 4, 5, 6].map(section).join('')}</body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.8in', bottom: '0.8in' } });
await printer.close();
check('Chromium printed a PDF', PDF.subarray(0, 4).toString() === '%PDF', `${PDF.length} bytes`);

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
// Nothing else leaves the machine but the fonts.
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
let page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const paper = (id, title, authors, extra) => ({
  id,
  source: 'scholar',
  title,
  authors,
  abstract: '',
  published: '',
  categories: [],
  addedAt: ago(24 * 10),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0,
  ...extra,
});
const PAPERS = [
  paper('scholar:fno', TITLE, ['Zongyi Li', 'Nikola Kovachki', 'Kamyar Azizzadenesheli'], {
    venue: 'ICLR',
    published: '2021-01-01',
    pdfUrl: 'https://example.org/fno.pdf',
    abstract: 'We formulate a new neural operator by parameterizing the integral kernel directly in Fourier space.',
    progress: 0.1,
    lastOpenedAt: ago(2),
  }),
  paper('scholar:moe', 'A comprehensive survey of mixture-of-experts: Algorithms, theory, and applications', ['S Mu', 'S Lin'], { published: '2025-01-01', progress: 0.63, lastOpenedAt: ago(50) }),
  paper('scholar:op', 'Neural Operator: Learning Maps Between Function Spaces', ['N Kovachki', 'Z Li'], { published: '2023-01-01', progress: 0.18, lastOpenedAt: ago(24 * 4) }),
  paper('scholar:aph', 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data', ['S Chennuri', 'S Kiran'], { published: '2023-01-01', progress: 0.08, lastOpenedAt: ago(24 * 8) }),
  paper('scholar:pinn', 'Physics-informed neural networks', ['M Raissi', 'P Perdikaris', 'GE Karniadakis'], { published: '2019-01-01', addedAt: ago(20) }),
  paper('scholar:don', 'DeepONet: Learning nonlinear operators', ['L Lu', 'P Jin'], { published: '2021-01-01', addedAt: ago(70) }),
];

async function seed(settings = {}) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ papers, settings }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), ...settings }));
      localStorage.setItem('reader.view', JSON.stringify({ kind: 'all' }));
      localStorage.removeItem('reader.spots');
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
      await clear('highlights');
      await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
      for (const paper of papers) await put('papers', paper);
      const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
      await put('highlights', { id: 'h1', paperId: 'scholar:fno', color: 'green', exact: 'the same parameters can be evaluated on any discretisation of the domain', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(30), note: 'Where does this come from?' });
      await put('highlights', { id: 'h2', paperId: 'scholar:moe', color: 'blue', exact: 'sparse gating selects the top-k experts per token', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(3000) });
      await put('highlights', { id: 'h3', paperId: 'scholar:op', color: 'pink', exact: 'Does truncation lose shock fronts?', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(6000) });
      db.close();
    },
    { papers: PAPERS, settings },
  );
}

/** A new tab on the same browser: a new visit. */
async function newVisit() {
  await page.close();
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const home = page => page.locator('.main.home');
async function closePanels() {
  for (const label of [/close the library panel/i]) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  const close = page.locator('.dock').getByRole('button', { name: /close/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  // The panes slide away.
  await page.waitForTimeout(500);
}

console.log('\n== a new visit opens on Home ==');
await seed();
await newVisit();
await home(page).waitFor({ timeout: 15000 });
check('Home is showing', await home(page).isVisible());
check('R is a button, marked as the page you are on', (await page.locator('.rail button.brand').getAttribute('aria-current')) === 'page');
check('the paper to carry on with is the last one opened', ((await page.locator('.home-continue-title').textContent()) || '').includes('Fourier Neural Operator'));
check('the others in progress are beside it', (await page.locator('.home-side .home-row').count()) >= 3);
check('a paper left for a week is said to have stalled', ((await page.locator('.home-side').textContent()) || '').includes('not opened for 8 days'));
check('the latest highlights are there', (await page.locator('.home-hl').count()) === 3);
check('with no page kept yet, the abstract stands in', await page.locator('.home-peek-abstract').isVisible());
await closePanels();
await shot('home-first');

console.log('\n== read it as a PDF to page 3, and come back ==');
await page.keyboard.press('Enter');
await page.waitForSelector('.main[data-paper-id="scholar:fno"]', { timeout: 15000 });
check('Enter opened the paper', true);
await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
const scroller = page.locator('.pdf-scroll');
await scroller.evaluate((element) => {
  const third = element.querySelector('[data-slot="3"]');
  element.scrollTop += third.getBoundingClientRect().top - element.getBoundingClientRect().top + third.getBoundingClientRect().height * 0.4;
});
await page.waitForSelector('.pdf-book-page[data-page="3"]:not(.drawing)', { timeout: 15000 });
await page.waitForTimeout(1800);
const progressBefore = await page.evaluate(() => document.querySelector('.pdf-scroll')?.scrollTop ?? 0);
await page.locator('.rail button.brand').click();
await home(page).waitFor({ timeout: 10000 });
check('R went Home', await home(page).isVisible());
const where = (await page.locator('.home-peek-where').textContent()) || '';
check('Home says the page you were on', /page 3 of 6/.test(where), where);
check('and shows it', await page.locator('.home-peek-pdf img').isVisible());
const at = Number(await page.locator('.home-peek-pdf').evaluate((element) => getComputedStyle(element).getPropertyValue('--at')));
check('with the line where the screen began, 40% down it', Math.abs(at - 0.4) < 0.05, String(at));
check('the page read above it is dimmed', await page.locator('.home-peek-read').isVisible());
await shot('home-pdf');

console.log('\n== Enter goes back in, at the same place ==');
await page.keyboard.press('Enter');
await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
await page.waitForTimeout(1200);
const progressAfter = await page.evaluate(() => document.querySelector('.pdf-scroll')?.scrollTop ?? 0);
check('the PDF opens where it was left', Math.abs(progressAfter - progressBefore) < 60, `${progressBefore} → ${progressAfter}`);

console.log('\n== read reflowed ==');
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 60000 });
await page.locator('.reader-scroll').evaluate((element) => {
  const heading = Array.from(element.querySelectorAll('.paper-body h2'))[2];
  element.scrollTop += heading.getBoundingClientRect().top - element.getBoundingClientRect().top + 40;
});
await page.waitForTimeout(1800);
await page.locator('.rail button.brand').click();
await home(page).waitFor({ timeout: 10000 });
check('Home shows the paragraphs', await page.locator('.home-peek-reflow').isVisible());
check('with the ones scrolled past dimmed', (await page.locator('.home-peek-reflow .is-read').count()) >= 1);
check('and a line where the screen began', await page.locator('.home-peek-reflow .home-stop').isVisible());
check('says Reflow', ((await page.locator('.home-chip').textContent()) || '').includes('Reflow'));
await shot('home-reflow');

console.log('\n== a reload stays where it was; a new tab starts on Home ==');
await page.locator('.home-row').first().click();
await page.waitForSelector('.main[data-paper-id]', { timeout: 10000 });
await page.reload({ waitUntil: 'networkidle' });
// Past the offer to connect Drive, which a reload makes again.
const skipAgain = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await skipAgain.isVisible().catch(() => false)) await skipAgain.click();
await page.waitForSelector('.main[data-paper-id]', { timeout: 10000 }).catch(() => {});
check('a reload keeps the paper open', (await page.locator('.main[data-paper-id]').count()) === 1);
await newVisit();
check('a new tab opens on Home', await home(page).isVisible().catch(() => false));

console.log('\n== the views: Today, Projects, Inbox ==');
// The visit before this one was two days ago: what was added since is new.
await page.evaluate(() => localStorage.setItem('reader.visit.at', new Date(Date.now() - 48 * 3600 * 1000).toISOString()));
await newVisit();
await home(page).waitFor({ timeout: 10000 });
await closePanels();
// Back to the paper read as a PDF, so it is the one to carry on with.
await page.locator('.home-row', { hasText: 'Fourier Neural Operator' }).click();
await page.locator('.segmented button', { hasText: 'PDF' }).click({ timeout: 20000 });
await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
await page.waitForTimeout(2800);
await page.locator('.rail button.brand').click();
await home(page).waitFor({ timeout: 10000 });
const tabs = page.locator('.home-tabs .home-tab[aria-pressed]');
check('four views, as tabs', (await tabs.count()) === 4, (await tabs.allTextContents()).join(' | '));
check('Continue reading is the default', ((await tabs.first().textContent()) || '').includes('default'));
check('the Inbox counts what is new', ((await tabs.nth(3).textContent()) || '').includes('1'), (await tabs.nth(3).textContent()) || '');
await page.keyboard.press('2');
await page.locator('.home-today').waitFor({ timeout: 5000 });
const plan = await page.locator('.home-plan .home-row-title').allTextContents();
check('2 is Today, a plan from the library', plan.length >= 4, plan.join(' | '));
check('it starts with carrying on', (plan[0] || '').startsWith('Carry on with Fourier Neural Operator'), plan[0]);
check('and picks up what stalled', plan.some((title) => title.startsWith('Pick back up: Fusion approaches')));
check('the strip keeps where you stopped in reach', await page.locator('.home-strip').isVisible());
await shot('home-today');
await page.keyboard.press('3');
await page.locator('.home-projects').waitFor({ timeout: 5000 });
check('3 is Projects, the collection in three lanes', (await page.locator('.home-lane').count()) === 3);
check('its papers set out by how far you are', (await page.locator('.home-lane').nth(1).locator('.home-lane-card').count()) === 4);
await shot('home-projects');
await page.keyboard.press('4');
await page.locator('.home-inbox').waitFor({ timeout: 5000 });
const fresh = await page.locator('.home-inbox .home-card').first().locator('.home-row-title').allTextContents();
check('4 is the Inbox, with what was added since the last visit', fresh.length === 1 && fresh[0].startsWith('Physics-informed'), fresh.join(' | '));
check('and what is still waiting from before', ((await page.locator('.home-inbox').textContent()) || '').includes('DeepONet'));
await shot('home-inbox');

console.log('\n== choose the view Home opens on ==');
await page.getByRole('button', { name: "Choose Home's views" }).click();
await page.locator('.home-menu').waitFor({ timeout: 5000 });
await shot('home-menu');
await page.locator('.home-menu-opt', { hasText: 'Today' }).click();
await page.keyboard.press('Escape');
await newVisit();
await page.locator('.home-today').waitFor({ timeout: 10000 }).catch(() => {});
check('a new visit opens on the view chosen', await page.locator('.home-today').isVisible());
check('which the tabs now mark as the default', ((await page.locator('.home-tab.is-on').textContent()) || '').includes('default'));
await page.getByRole('button', { name: "Choose Home's views" }).click();
await page.locator('.home-menu-opt', { hasText: 'Continue reading' }).click();
await page.keyboard.press('Escape');
await page.keyboard.press('1');

console.log('\n== dark glass, and a phone ==');
await page.evaluate(() => {
  const settings = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...settings, readingMode: 'pdf', theme: 'dark', glass: true, glassWall: 'spotlight' }));
});
await newVisit();
await home(page).waitFor({ timeout: 10000 });
await closePanels();
await shot('home-dark-glass');
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('.rail button.brand').click();
await page.waitForTimeout(400);
const wide = await page.evaluate(() => document.documentElement.scrollWidth);
check('nothing runs off the side on a phone', wide <= 390, String(wide));
await shot('home-phone');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
