/**
 * Home: what R on the rail opens, and where a visit starts. Seeds a library
 * with a paper printed by Chromium, reads it as a PDF to page 3, and checks
 * that R brings Home up with that page on it and a line where the screen
 * began; that Enter goes back into the paper; that the same is true read
 * reflowed; that a new tab starts on Home while a reload stays put; and that
 * Home's other views — Today, Projects, Inbox — are a key away, with the
 * one it opens on chosen from its menu; that a new reader starts on Find
 * papers, which saves a result to a collection in one step, by its button,
 * its picker or a drag, with Undo; that the Collections view takes a paper
 * straight into a column and moves one between them; that R, reading, lays
 * the papers in progress out as a desk; and that the side panels are put away
 * on Home and come back after. Writes
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
// Searching: Scholar through the proxy, OpenAlex for what Home suggests.
const HITS = [
  ['moe-survey', 'A comprehensive survey of mixture-of-experts: Algorithms, theory, and applications', ['S Mu', 'S Lin']],
  ['switch', 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', ['W Fedus', 'B Zoph', 'N Shazeer']],
  ['expert-choice', 'Mixture-of-Experts with Expert Choice Routing', ['Y Zhou', 'T Lei']],
  ['routed', 'Unified Scaling Laws for Routed Language Models', ['A Clark', 'D de las Casas']],
];
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ results: HITS.map(([id, title, authors]) => ({ id, clusterId: id, title, url: `https://example.org/${id}`, pdfUrl: `https://example.org/${id}.pdf`, authors, snippet: '' })) }),
  }),
);
await context.route('**/api.openalex.org/works*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        ['W1', 'Geometry-Informed Neural Operator for Large-Scale 3D PDEs', 'Z Li', 210],
        ['W2', 'Adaptive Fourier Neural Operators: Efficient Token Mixers for Transformers', 'J Guibas', 480],
        ['W3', 'Physics-Informed Neural Operator for Learning Partial Differential Equations', 'Z Li', 900],
      ].map(([id, title, author, cited]) => ({ id: `https://openalex.org/${id}`, display_name: title, publication_date: '2023-01-01', authorships: [{ author: { display_name: author } }], cited_by_count: cited })),
    }),
  }),
);
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
      // The first half is about Continue reading: Home opens on it, as it did.
      localStorage.setItem('reader.home', JSON.stringify({ opensOn: 'continue', tabs: ['search', 'continue', 'today', 'projects', 'inbox', 'board'], last: 'continue', clearPanels: true, v: 2 }));
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
// Where in the paper, as a fraction: the panels coming back can change the page's scale, not the place.
const fraction = () => page.evaluate(() => { const el = document.querySelector('.pdf-scroll'); return el ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0; });
const progressBefore = await fraction();
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
const progressAfter = await fraction();
check('the PDF opens where it was left', Math.abs(progressAfter - progressBefore) < 0.01, `${progressBefore.toFixed(3)} → ${progressAfter.toFixed(3)}`);

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
check('six views, as tabs', (await tabs.count()) === 6, (await tabs.allTextContents()).join(' | '));
check('Continue reading is the default here', ((await tabs.nth(1).textContent()) || '').includes('default'));
check('the Inbox counts what is new', ((await tabs.nth(4).textContent()) || '').includes('1'), (await tabs.nth(4).textContent()) || '');
await page.keyboard.press('3');
await page.locator('.home-today').waitFor({ timeout: 5000 });
const plan = await page.locator('.home-plan .home-row-title').allTextContents();
check('3 is Today, a plan from the library', plan.length >= 4, plan.join(' | '));
check('it starts with carrying on', (plan[0] || '').startsWith('Carry on with Fourier Neural Operator'), plan[0]);
check('and picks up what stalled', plan.some((title) => title.startsWith('Pick back up: Fusion approaches')));
check('the strip keeps where you stopped in reach', await page.locator('.home-strip').isVisible());
await shot('home-today');
await page.keyboard.press('4');
await page.locator('.home-projects').waitFor({ timeout: 5000 });
check('4 is Projects, the collection in three lanes', (await page.locator('.home-lane').count()) === 3);
check('its papers set out by how far you are', (await page.locator('.home-lane').nth(1).locator('.home-lane-card').count()) === 4);
await shot('home-projects');
await page.keyboard.press('5');
await page.locator('.home-inbox').waitFor({ timeout: 5000 });
const fresh = await page.locator('.home-inbox .home-card').first().locator('.home-row-title').allTextContents();
check('5 is the Inbox, with what was added since the last visit', fresh.length === 1 && fresh[0].startsWith('Physics-informed'), fresh.join(' | '));
check('and what is still waiting from before', ((await page.locator('.home-inbox').textContent()) || '').includes('DeepONet'));
await shot('home-inbox');

console.log('\n== choose the view Home opens on ==');
await page.getByRole('button', { name: "Choose Home's views" }).click();
await page.locator('.home-menu').waitFor({ timeout: 5000 });
await shot('home-menu');
await page.locator('.home-menu-opt', { hasText: 'A short plan' }).click();
await page.keyboard.press('Escape');
await newVisit();
await page.locator('.home-today').waitFor({ timeout: 10000 }).catch(() => {});
check('a new visit opens on the view chosen', await page.locator('.home-today').isVisible());
check('which the tabs now mark as the default', ((await page.locator('.home-tab.is-on').textContent()) || '').includes('default'));
await page.getByRole('button', { name: "Choose Home's views" }).click();
await page.locator('.home-menu-opt', { hasText: 'The page you stopped on' }).click();
await page.keyboard.press('Escape');
await page.keyboard.press('2');

console.log('\n== a new reader: Home opens on Find papers ==');
await page.evaluate(() => localStorage.removeItem('reader.home'));
await newVisit();
page.on('dialog', (dialog) => dialog.accept('LLM scaling'));
await page.locator('.find').waitFor({ timeout: 10000 });
check('Find papers is the default for a new reader', ((await page.locator('.home-tab.is-on').textContent()) || '').includes('Find papers') && ((await page.locator('.home-tab.is-on').textContent()) || '').includes('default'));
check('the search box has the cursor', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search for papers'));
check('the library and the dock are put away on Home', (await page.locator('.library-panel').count()) === 0 && (await page.locator('.dock').count()) === 0);
await page.locator('.find-why').first().waitFor({ timeout: 10000 });
check('it suggests papers near the one being read, saying why', ((await page.locator('.find-why').first().textContent()) || '').startsWith('Related to'));
check('continue reading is a row of small cards', (await page.locator('.find-carry-card').count()) >= 2);
await shot('home-find');

console.log('\n== search, and save to a collection ==');
const count = async (name) => Number((await page.locator('.find-coll', { hasText: name }).locator('.find-coll-count').textContent()) || 0);
await page.getByLabel('Search for papers').fill('mixture of experts');
await page.getByLabel('Search for papers').press('Enter');
await page.locator('.find-row .find-title', { hasText: 'Switch Transformers' }).waitFor({ timeout: 10000 });
check('the results replace the suggestions', (await page.locator('.find-row').count()) === 4);
await page.locator('.find-row .find-title', { hasText: 'Switch Transformers' }).click();
await page.locator('.find-detail .locations').waitFor({ timeout: 5000 });
check('clicking a result shows everywhere it can be read, as Discover does', await page.locator('.find-detail .locations').isVisible());
check('with Save, Read and Source under it', (await page.locator('.find-detail-actions').getByRole('button', { name: /Save to Reading list/ }).count()) === 1 && (await page.locator('.find-detail-actions a', { hasText: 'Source' }).count()) === 1);
await page.locator('.find-detail .locations .eyebrow').first().filter({ hasNotText: 'Looking' }).waitFor({ timeout: 10000 }).catch(() => {});
await shot('home-find-detail');
await page.locator('.find-row .find-title', { hasText: 'Switch Transformers' }).click();
check('and clicking it again folds it away', (await page.locator('.find-detail').count()) === 0);
check('one already in the library says so', ((await page.locator('.find-row', { hasText: 'comprehensive survey' }).locator('.find-have').textContent()) || '').includes('In Reading list'));
const before = await count('Reading list');
await page.locator('.find-row', { hasText: 'Switch Transformers' }).getByRole('button', { name: /Reading list/ }).click();
await page.locator('.find-toast').waitFor({ timeout: 5000 });
check('+ saves it to the collection chosen', (await count('Reading list')) === before + 1, `${before} → ${await count('Reading list')}`);
check('and says so, with Undo', ((await page.locator('.find-toast').textContent()) || '').includes('Added Switch Transformers'));
await page.locator('.find-toast').getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(300);
check('Undo takes it out again', (await count('Reading list')) === before);
await page.locator('.find-colls').getByRole('button', { name: /New collection/ }).click();
await page.locator('.find-coll', { hasText: 'LLM scaling' }).waitFor({ timeout: 5000 });
check('a new collection is made from here, and becomes where things are saved', ((await page.locator('.find-dest select').inputValue()) || '') !== '' && ((await page.locator('.find-coll.is-target').textContent()) || '').includes('LLM scaling'));
await page.locator('.find-row', { hasText: 'Expert Choice' }).getByRole('button', { name: 'Save to another collection' }).click();
await page.locator('.find-pick').waitFor({ timeout: 5000 });
await shot('home-find-results');
await page.keyboard.press('1');
await page.locator('.find-toast', { hasText: 'Expert Choice' }).waitFor({ timeout: 5000 });
check('the picker saves to another collection by its number', ((await page.locator('.find-toast').textContent()) || '').includes('to Reading list'));
await page.locator('.find-row', { hasText: 'Routed Language Models' }).dragTo(page.locator('.find-coll', { hasText: 'LLM scaling' }));
await page.locator('.find-toast', { hasText: 'Routed' }).waitFor({ timeout: 5000 }).catch(() => {});
check('a result dropped on a collection is saved there', ((await page.locator('.find-toast').textContent()) || '').includes('Routed Language Models to LLM scaling'), (await page.locator('.find-toast').textContent()) || '');

console.log('\n== Collections: add straight into a column, move between them ==');
await page.locator('.home-tab', { hasText: 'Collections' }).click();
await page.locator('.cb').waitFor({ timeout: 5000 });
const column = (name) => page.locator('.cb-col', { hasText: name }).first();
const inColumn = async (name) => Number(((await column(name).locator('.cb-count').textContent()) || '0').split(' ')[0]);
check('a column for each collection', (await page.locator('.cb-col:not(.cb-new)').count()) === 2);
const llm = await inColumn('LLM scaling');
await column('LLM scaling').getByLabel('Add a paper to LLM scaling').fill('switch transformers');
await column('LLM scaling').locator('.cb-found button.is-first').waitFor({ timeout: 10000 });
await shot('home-board');
await column('LLM scaling').getByLabel('Add a paper to LLM scaling').press('Enter');
await page.waitForTimeout(400);
check('the box at a column\'s foot adds the paper found into it', (await inColumn('LLM scaling')) === llm + 1, `${llm} → ${await inColumn('LLM scaling')}`);
const reading = await inColumn('Reading list');
await column('Reading list').locator('.cb-card', { hasText: 'Fourier Neural Operator' }).dragTo(column('LLM scaling'));
await page.waitForTimeout(400);
check('a card dragged to another column moves the paper', (await inColumn('Reading list')) === reading - 1 && (await inColumn('LLM scaling')) === llm + 2);

console.log('\n== reading: R lays out the desk ==');
await page.locator('.home-tab', { hasText: 'Find papers' }).click();
await page.locator('.find-carry-card', { hasText: 'Fourier Neural Operator' }).click();
await page.waitForSelector('.pdf-book-page:not(.drawing) canvas', { timeout: 30000 });
check('the side panels come back as they were', (await page.locator('.library-panel').count()) === 1);
await page.waitForTimeout(1500);
await page.keyboard.press('r');
await page.locator('.desk-scrim').waitFor({ timeout: 5000 });
check('R opens the desk, the paper being read first', ((await page.locator('.desk-card').first().textContent()) || '').includes('Fourier Neural Operator') && (await page.locator('.desk-card.is-now').count()) === 1);
check('with the others in progress beside it, at their pages', (await page.locator('.desk-card').count()) === 4);
check('this one shown where it is', await page.locator('.desk-card.is-now .home-peek-pdf img').isVisible());
await shot('home-desk');
await page.keyboard.press('Escape');
check('Esc puts it away', (await page.locator('.desk-scrim').count()) === 0);
await page.keyboard.press('r');
await page.keyboard.press('2');
await page.waitForSelector('.main[data-paper-id]:not([data-paper-id="scholar:fno"])', { timeout: 10000 });
check('2 goes to the second paper on it', (await page.locator('.desk-scrim').count()) === 0);
await page.keyboard.press('r');
await page.keyboard.press('g');
await home(page).waitFor({ timeout: 5000 });
check('G goes Home from the desk', await home(page).isVisible());

console.log('\n== between Home and the paper: G, and a button either side ==');
check('Home says which paper G goes back to', ((await page.locator('.home-back').textContent()) || '').includes('Back to reading'), (await page.locator('.home-back').textContent()) || '');
check('and the rail has a way back under R', await page.locator('.rail-return').isVisible());
const backTitle = ((await page.locator('.home-back b').textContent()) || '').replace('…', '');
await shot('home-back');
await page.keyboard.press('g');
await page.waitForSelector('.main[data-paper-id]', { timeout: 10000 });
await page.waitForFunction((start) => (document.querySelector('.reader-head .title')?.textContent || '').startsWith(start), backTitle.slice(0, 20), { timeout: 5000 }).catch(() => {});
check('G on Home goes back into that paper', ((await page.locator('.reader-head .title').textContent()) || '').startsWith(backTitle.slice(0, 20)), `pill: ${backTitle} | opened: ${await page.locator('.reader-head .title').textContent()}`);
check('whose top bar has a Home button', await page.locator('.topbar-home').isVisible());
await page.keyboard.press('g');
await home(page).waitFor({ timeout: 5000 });
check('G in the paper goes Home', await home(page).isVisible());
await page.locator('.rail-return').click();
await page.waitForSelector('.main[data-paper-id]', { timeout: 10000 });
check('the button under R goes back too', (await page.locator('.main.home').count()) === 0);
await page.locator('.topbar-home').click();
await home(page).waitFor({ timeout: 5000 });
check('and the Home button in the top bar goes Home', await home(page).isVisible());

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
