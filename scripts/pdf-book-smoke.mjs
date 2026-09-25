/**
 * A Scholar paper read as a PDF book. The proxy is stubbed as an older one
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
  `<section style="break-after: page"><h2>Section ${n}</h2>${'<p>Stroke recovery varies from patient to patient, and predicting who will respond to treatment is hard. </p>'.repeat(18)}<p>End of page ${n}.</p></section>`;
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

console.log('\n== find the paper on Scholar and open it ==');
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
const result = page.locator('article.result', { hasText: 'utility of lesion' });
check('the result lists the four authors, not the venue', !((await result.textContent()) || '').includes('KiranBrain'), (await result.textContent()) || '');
await result.locator('h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();

// Reflow first, where the header is.
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-authors', { timeout: 30000 });
const names = await page.locator('.paper-authors .author-name').allTextContents();
check('the byline is the four authors', JSON.stringify(names) === JSON.stringify(['EL Meier', 'JP Johnson', 'Y Pan', 'S Kiran']), JSON.stringify(names));
const venue = page.locator('.venue-name');
check('the venue is shown apart from them', ((await venue.textContent()) || '') === 'Brain imaging and behavior', (await venue.textContent()) || '');

console.log('\n== the card over the venue ==');
// Once the PDF is reflowed: the text arriving moves the page, and a card closes when the page moves.
await page.waitForSelector('.paper-body h2', { timeout: 30000 }).catch(() => {});
await venue.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await venue.click();
await page.waitForSelector('.hover-card', { timeout: 5000 }).catch(() => {});
await page.waitForSelector('.hover-card .hc-stats', { timeout: 10000 }).catch(() => {});
const card = page.locator('.hover-card');
const said = (await card.textContent()) || '';
check('names the journal as the index writes it', said.includes('Brain Imaging and Behavior'), said);
check('says who publishes it, and where', said.includes('Springer Science+Business Media') && said.includes('United States'));
check('says where in it the paper is', said.includes('Vol. 13, issue 6, pp. 1510–1525'));
check('links to its homepage and ISSN record', (await card.locator('a[href="https://www.springer.com/journal/11682"]').count()) === 1 && (await card.locator('a[href*="portal.issn.org"]').count()) === 1);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/venue-card.png` });
await page.keyboard.press('Escape');

console.log('\n== the PDF as a book ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click();
await page.waitForSelector('.pdf-scroll .pdf-book-page', { timeout: 30000 });
await page.getByRole('button', { name: /Read as a book/i }).click();
await page.waitForSelector('.pdf-book-page:not(.drawing)', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('.pdf-book-page:not(.drawing)').length === 2, null, { timeout: 15000 }).catch(() => {});
check('two pages side by side', (await page.locator('.pdf-book-page').count()) === 2);
const folio = () => page.locator('.pdf-book .book-folio').textContent();
check('the folio reads pages 1–2', ((await folio()) || '').includes('Pages 1–2 of'), (await folio()) || '');
const inked = await page.locator('.pdf-book-page canvas').first().evaluate((canvas) => {
  const context = canvas.getContext('2d');
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let dark = 0;
  for (let index = 0; index < data.length; index += 4) if (data[index] < 128) dark += 1;
  return dark;
});
check('the page is drawn, not blank', inked > 500, `${inked} dark pixels`);
await page.waitForSelector('.pdf-text span', { timeout: 10000 }).catch(() => {});
check('its text is laid over it to select', (await page.locator('.pdf-book-page').first().locator('.pdf-text span').count()) > 5);
await page.screenshot({ path: `${OUT}/pdf-book.png` });
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => document.querySelector('.pdf-book .book-folio')?.textContent?.includes('Pages 3–4'), null, { timeout: 5000 }).catch(() => {});
check('the arrow key turns to pages 3–4', ((await folio()) || '').includes('Pages 3–4'), (await folio()) || '');
await page.setViewportSize({ width: 700, height: 900 });
await page.waitForFunction(() => document.querySelectorAll('.pdf-book-page').length === 1, null, { timeout: 5000 }).catch(() => {});
check('a narrow window shows one page', (await page.locator('.pdf-book-page').count()) === 1, (await folio()) || '');
await page.screenshot({ path: `${OUT}/pdf-book-narrow.png` });
await page.setViewportSize({ width: 1920, height: 1080 });
await page.getByRole('button', { name: /Read as one scrolling page/i }).click();
await page.waitForSelector('.pdf-scroll .pdf-book-page', { timeout: 10000 });
// Scrolled, the PDF is still drawn by the reader — so it can be selected, snipped and pinned.
check('the scroll view is one column of the PDF’s own pages', (await page.locator('.pdf-scroll-slot').count()) > 1 && (await page.locator('.pdf-pane iframe').count()) === 0);

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
