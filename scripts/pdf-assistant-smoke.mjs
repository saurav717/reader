/**
 * Ask Claude over a PDF, and the byline read off it. A Scholar result names
 * six of a paper's ten authors, in initials; the PDF's first page names all
 * ten. The reader has to show all ten once the PDF is read, and Ask Claude —
 * in PDF mode, where the page is a picture — has to send the PDF's text,
 * and in the book layout, the pages in view as images.
 *
 *   npm run build && npm start &
 *   node scripts/pdf-assistant-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const TITLE = 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data';
const FULL = ['Saurav Chennuri', 'Sha Lai', 'Anne Billot', 'Maria Varkanitsa', 'Emily J. Braun', 'Swathi Kiran', 'Archana Venkataraman', 'Janusz Konrad', 'Prakash Ishwar', 'Margrit Betke'];

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print the paper ==');
const printer = await browser.newPage();
const body = '<p>Aphasia is a language impairment that follows a stroke, and the recovery varies from one person to the next. </p>'.repeat(14);
await printer.setContent(`<!doctype html><html><body style="font-family: 'Times New Roman', serif; font-size: 10pt; margin: 0 40px">
  <h1 style="text-align:center; font-size: 16pt">Fusion Approaches to Predict Post-stroke Aphasia Severity from Multimodal Neuroimaging Data</h1>
  <p style="text-align:center; font-size: 12pt; margin: 0">${FULL.slice(0, 6).join(', ')},<br>${FULL.slice(6, 9).join(', ')}, and ${FULL[9]}<br>Boston University</p>
  <p style="text-align:center; font-family: monospace; font-size: 9pt">{saurav07,lais823,abillot,mvarkan,ejbraun,kirans,archanav,jkonrad,pi,betke}@bu.edu</p>
  <h3 style="text-align:center">Abstract</h3>
  ${body}
  <h2 style="break-before: page">1. Introduction</h2>${body}${body}
</body></html>`);
const PDF = await printer.pdf({ format: 'Letter' });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const pattern of ['**/api.crossref.org/**', '**/api.semanticscholar.org/**', '**/dblp.org/**', '**/wikidata.org/**', '**/api.openalex.org/**', '**/api/locate*']) {
  await context.route(pattern, (route) => route.fulfill({ status: 404, body: '' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        {
          id: '42',
          clusterId: '42',
          title: TITLE,
          url: 'https://example.org/fusion',
          pdfUrl: 'https://example.org/fusion.pdf',
          authors: ['S Chennuri', 'S Lai', 'A Billot', 'M Varkanitsa', 'EJ Braun', 'S Kiran'],
          venue: '2023 IEEE/CVF International Conference on Computer Vision Workshops (ICCVW)',
          year: 2023,
          snippet: 'Aphasia.',
        },
      ],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
const requests = [];
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM =
  sse('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'I can see page 1.' } }) +
  sse('content_block_stop', { index: 0 }) +
  sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse('message_stop', {});
await context.route('https://api.anthropic.com/**', (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
  requests.push(JSON.parse(request.postData() || '{}'));
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: STREAM });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.addInitScript(() => localStorage.setItem('reader.anthropic-key', 'sk-ant-test'));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
if (!(await page.getByLabel('Search papers').isVisible())) await page.getByRole('button', { name: 'Discover papers' }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('fusion aphasia');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result').first().locator('h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();

console.log('\n== the byline, in Reflow ==');
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body', { timeout: 30000 });
await page.waitForFunction((n) => document.querySelectorAll('.paper-authors .author-name').length === n, FULL.length, { timeout: 30000 }).catch(() => {});
const names = await page.locator('.paper-authors .author-name').allTextContents();
check('all ten authors, in full', JSON.stringify(names) === JSON.stringify(FULL), JSON.stringify(names));
const venue = (await page.locator('.venue-name').textContent()) || '';
check('the venue does not repeat the year', !venue.startsWith('2023'), venue);
const title = page.locator('.paper-title');
check('the title is balanced', (await title.evaluate((el) => getComputedStyle(el).textWrap || getComputedStyle(el).textWrapStyle)).includes('balance'));
await page.screenshot({ path: `${OUT}/pdf-byline.png`, clip: { x: 0, y: 0, width: 1600, height: 420 } });

async function ask(text) {
  const before = requests.length;
  if (!(await page.locator('.assistant-win').isVisible())) await page.keyboard.press('Control+Backslash');
  await page.getByRole('textbox', { name: 'Ask Claude' }).fill(text);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 100 && requests.length === before; i++) await page.waitForTimeout(100);
  return requests[requests.length - 1];
}
const lastUser = (sent) => sent?.messages?.at(-1)?.content;
const asText = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));

console.log('\n== Ask Claude, PDF in the browser’s viewer ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click();
await page.waitForSelector('.pdf-pane iframe', { timeout: 30000 });
let sent = await ask('What is this paper about?');
check('the paper text goes along', /<paper_text[\s\S]*\[Page 1\][\s\S]*Aphasia is a language impairment/.test(sent?.system?.[1]?.text || ''));
check('page by page', /\[Page 2\][\s\S]*Introduction/.test(sent?.system?.[1]?.text || ''));
check('and Claude is told the view', /Viewing as: PDF, in the browser’s own viewer/.test(asText(lastUser(sent))), asText(lastUser(sent)).match(/Viewing as: .*/)?.[0]);

console.log('\n== Ask Claude, PDF as a book ==');
await page.getByRole('button', { name: /Read as a book/i }).click();
await page.waitForFunction(() => document.querySelectorAll('.pdf-book-page:not(.drawing)').length === 2, null, { timeout: 20000 }).catch(() => {});
sent = await ask('What is on this page?');
const content = lastUser(sent);
const images = Array.isArray(content) ? content.filter((b) => b.type === 'image') : [];
check('the pages in view go as pictures', images.length === 2 && images.every((b) => b.source.media_type === 'image/jpeg' && b.source.data.length > 1000), `${images.length} images`);
check('with the passage in view read from the PDF', /<passage_in_view>\n\[Page 1\]/.test(asText(content)));
check('and the pages named', /pages 1–2 of 2 in view/.test(asText(content)), asText(content).match(/Viewing as: .*/)?.[0]);
check('the screenshot button is there', await page.getByRole('button', { name: 'Attach a screenshot of this tab' }).isVisible());
await page.screenshot({ path: `${OUT}/pdf-assistant.png` });

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
