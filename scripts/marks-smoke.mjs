/**
 * Highlighting and underlining on the PDF's own pages and in Reflow mode,
 * each mode showing what was marked in the other; and full screen.
 *
 *   npm run build && npm start &
 *   node scripts/marks-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 *
 * The paper is found and opened as in pdf-book-smoke.mjs.
 */
/**
 * (Set-up shared with pdf-book-smoke.mjs:) a Scholar paper read as a PDF book. The proxy is stubbed as an older one
 * would answer: the byline of Scholar's newer layout misread, the venue run
 * into the last author and the year and host made one more author. The
 * reader has to show the authors and the venue apart; the venue has to open
 * a card about the journal; and the PDF, in the book layout, has to be two
 * of its own pages side by side, turned by the arrow keys, with its text
 * selectable.
 *
 *   npm run build && npm start &
 *   node scripts/pdf-book-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const TITLE = 'The utility of lesion classification in predicting language and treatment outcomes in chronic stroke-induced aphasia';

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a six-page paper ==');
const printer = await browser.newPage();
const pageOf = (n) =>
  `<section style="break-after: page"><h2>Section ${n}</h2>${'<p>Stroke recovery varies from patient to patient, and predicting who will respond to treatment is hard. </p>'.repeat(8)}<p>Marker paragraph ${n}: the lesion classification scheme on page ${n} predicted naming accuracy remarkably well across the whole cohort of participants.</p>${'<p>Stroke recovery varies from patient to patient, and predicting who will respond to treatment is hard. </p>'.repeat(8)}</section>`;
await printer.setContent(`<!doctype html><html><body style="font-family: serif; font-size: 12pt"><h1>${TITLE}</h1>${[1, 2, 3, 4, 5, 6].map(pageOf).join('')}</body></html>`);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();
check('Chromium printed a PDF', PDF.subarray(0, 4).toString() === '%PDF', `${PDF.length} bytes`);

const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
await context.route('**/api.crossref.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":{"items":[]}}' }));
await context.route('**/api.semanticscholar.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
await context.route('**/dblp.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result":{"hits":{}}}' }));
await context.route('**/wikidata.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await context.route('**/api.openalex.org/**', (route) => {
  const url = decodeURIComponent(route.request().url().replace(/\+/g, ' '));
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (/\/sources\/S1/.test(url))
    return json({
      id: 'https://openalex.org/S1',
      display_name: 'Brain Imaging and Behavior',
      type: 'journal',
      issn_l: '1931-7557',
      host_organization_name: 'Springer Science+Business Media',
      country_code: 'US',
      homepage_url: 'https://www.springer.com/journal/11682',
      works_count: 2400,
      cited_by_count: 70000,
      summary_stats: { h_index: 90, '2yr_mean_citedness': 3.1 },
    });
  if (/\/works\?.*title\.search/.test(url) && url.includes('utility of lesion'))
    return json({
      results: [
        {
          id: 'https://openalex.org/W1',
          title: TITLE,
          publication_date: '2019-12-01',
          primary_location: { source: { id: 'https://openalex.org/S1', display_name: 'Brain Imaging and Behavior', type: 'journal', issn_l: '1931-7557' } },
          biblio: { volume: '13', issue: '6', first_page: '1510', last_page: '1525' },
          authorships: [],
        },
      ],
    });
  return json({ results: [] });
});
// An older proxy's answer: the newer byline read with the dash it no longer prints.
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        {
          id: '7339561324566250059',
          clusterId: '7339561324566250059',
          title: TITLE,
          url: 'https://link.springer.com/article/10.1007/s11682-018-9949-1',
          pdfUrl: 'https://example.org/lesion.pdf',
          authors: ['EL Meier', 'JP Johnson', 'Y Pan', 'S KiranBrain imaging and behavior', '2019•Springer'],
          snippet: 'Stroke recovery is variable.',
        },
      ],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));


console.log('\n== open the paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('lesion classification aphasia');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result', { hasText: 'utility of lesion' }).locator('h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();

/** Selects `phrase` inside `root`, as a drag would, and lets go of the mouse over it. */
async function select(rootSelector, phrase) {
  const box = await page.evaluate(
    ([rootSelector, phrase]) => {
      const root = document.querySelector(rootSelector);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let text = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node, start: text.length });
        text += node.data;
      }
      const at = text.indexOf(phrase);
      if (at < 0) return null;
      const find = (offset) => {
        const entry = nodes.filter((item) => item.start <= offset).pop();
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      range.setStart(...find(at));
      range.setEnd(...find(at + phrase.length));
      range.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 4, y: rect.top + rect.height / 2 };
    },
    [rootSelector, phrase],
  );
  if (!box) return false;
  await page.locator(rootSelector).first().dispatchEvent('mouseup', { clientX: box.x, clientY: box.y, button: 0 });
  return true;
}

console.log('\n== highlight on the PDF ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click({ timeout: 20000 });
await page.waitForSelector('.pdf-scroll .pdf-book-page[data-text="ready"]', { timeout: 30000 });
check('the PDF footer offers highlighting', ((await page.locator('.pdf-pane + p, .reader p').allTextContents()).join(' ')).includes('highlight or underline'));
const pdfSelected = await select('.pdf-book-page[data-page="1"] .pdf-text', 'lesion classification scheme on page 1');
check('text on the first page is selected', pdfSelected);
await page.waitForSelector('.pdf-book .selection-toolbar', { timeout: 5000 }).catch(() => {});
check('the toolbar offers the colours and underlining', (await page.locator('.pdf-book .selection-toolbar .mark-style').count()) === 1);
await page.keyboard.press('2');
await page.waitForSelector('.pdf-mark.hl-green', { timeout: 10000 }).catch(() => {});
const pdfMarks = await page.locator('.pdf-book-page[data-page="1"] .pdf-mark.hl-green').count();
check('the passage is highlighted green on its page', pdfMarks >= 1, `${pdfMarks} boxes`);
await page.locator('.pdf-book-page[data-page="1"] .pdf-mark').first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/marks-pdf.png` });

console.log('\n== the same passage in Reflow mode ==');
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.paper-body mark.hl', { timeout: 30000 }).catch(() => {});
const reflowed = (await page.locator('.paper-body mark.hl-green').allTextContents()).join('');
check('Reflow shows it highlighted green', /lesion classification scheme on page\s*1/.test(reflowed), reflowed);

console.log('\n== underline in Reflow mode ==');
check('text in Reflow is selected', await select('.paper-body', 'predicted naming accuracy remarkably well'));
await page.waitForSelector('.selection-toolbar', { timeout: 5000 });
await page.keyboard.press('u');
await page.waitForTimeout(300);
check('U switches the swatches to underlining', (await page.locator('.selection-toolbar .mark-style[aria-pressed="true"]').count()) === 1);
await page.keyboard.press('3');
await page.waitForSelector('.paper-body mark.hl-underline', { timeout: 5000 }).catch(() => {});
const underlined = (await page.locator('.paper-body mark.hl-underline.hl-blue').allTextContents()).join('');
check('Reflow underlines it in blue', underlined.includes('predicted naming accuracy'), underlined);
await page.locator('.paper-body mark.hl-underline').first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/marks-reflow.png` });

console.log('\n== the underline on the PDF ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click();
await page.waitForSelector('.pdf-book-page[data-page="1"][data-text="ready"]', { timeout: 30000 });
await page.waitForSelector('.pdf-book-page[data-page="1"] .pdf-mark.hl-underline', { timeout: 10000 }).catch(() => {});
check('the PDF underlines it in blue', (await page.locator('.pdf-book-page[data-page="1"] .pdf-mark.hl-underline.hl-blue').count()) >= 1);
check('and keeps the green highlight', (await page.locator('.pdf-book-page[data-page="1"] .pdf-mark.hl-green:not(.hl-underline)').count()) >= 1);
await page.locator('.pdf-book-page[data-page="1"] .pdf-mark.hl-underline').first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/marks-pdf-both.png` });
const stored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const open = indexedDB.open('reader');
      open.onsuccess = () => {
        const request = open.result.transaction('highlights').objectStore('highlights').getAll();
        request.onsuccess = () => resolve(request.result.map((item) => `${item.color}/${item.style}`));
      };
      open.onerror = () => resolve([]);
    }),
);
check('both are stored, with their style', stored.includes('green/highlight') && stored.includes('blue/underline'), JSON.stringify(stored));

console.log('\n== full screen ==');
await page.getByRole('button', { name: /Full screen — the paper fills the whole screen/ }).click();
await page.waitForFunction(() => Boolean(document.fullscreenElement), null, { timeout: 5000 }).catch(() => {});
check('the document is full screen', await page.evaluate(() => Boolean(document.fullscreenElement)));
check('and the panes are put away (zen)', (await page.locator('.app.is-zen').count()) === 1);
await page.screenshot({ path: `${OUT}/marks-fullscreen.png` });
await page.keyboard.press('f');
await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 }).catch(() => {});
check('F leaves full screen', await page.evaluate(() => !document.fullscreenElement));
await page.waitForFunction(() => !document.querySelector('.app.is-zen'), null, { timeout: 3000 }).catch(() => {});
check('and zen goes back to how it was', (await page.locator('.app.is-zen').count()) === 0);

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
