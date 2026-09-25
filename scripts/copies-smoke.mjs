/**
 * Reading a different copy of a paper. The paper has three copies: arXiv's,
 * which hands over the poster shown at the conference; a repository's, which
 * is the paper; and a publisher's, behind Cloudflare's check for a person.
 * The test checks that the poster is passed over for the paper, that the
 * list of copies says why, that any copy can be picked by hand, that a copy
 * that refuses leaves the one on screen where it is and offers the way
 * round, and that the pick is what the paper opens on next time.
 *
 *   npm run build && npm start &
 *   node scripts/copies-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const TITLE = 'Fourier Neural Operator for Parametric Partial Differential Equations';
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2010.08895v3</id>
    <published>2020-10-18T00:00:00Z</published>
    <title>${TITLE}</title>
    <summary>We introduce a new class of deep learning models that learn mappings between function spaces.</summary>
    <author><name>Zongyi Li</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2010.08895v3"/>
    <category term="cs.LG"/>
  </entry>
</feed>`;

// Every index answers with the same work: two copies besides arXiv's.
const WORK = {
  id: 'https://openalex.org/W3',
  title: TITLE,
  display_name: TITLE,
  publication_date: '2020-10-18',
  authorships: [{ author: { display_name: 'Zongyi Li' } }],
  locations: [
    { pdf_url: 'https://repo.example.edu/fno.pdf', source: { display_name: 'Caltech Repository', type: 'repository' }, version: 'acceptedVersion' },
    { pdf_url: 'https://walled.example.com/fno.pdf', source: { display_name: 'Walled Press', type: 'journal' }, version: 'publishedVersion' },
  ],
};

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// Both files printed by Chromium: the poster one page of 48×36 in, the paper
// four pages of Letter.
const printer = await browser.newPage();
await printer.setContent(`<h1 style="font-size:120px">${TITLE}</h1><p style="font-size:60px">The poster.</p>`);
const POSTER = await printer.pdf({ width: '48in', height: '36in' });
await printer.setContent(
  `<h1>${TITLE}</h1>` + Array.from({ length: 4 }, (_, page) => `<p style="page-break-after:always">Page ${page + 1} of the paper. ${'Operator learning. '.repeat(40)}</p>`).join(''),
);
const PAPER = await printer.pdf({ format: 'Letter' });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const asked = [];
await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
await context.route('**/api/arxiv/pdf*', (route) => {
  asked.push('arxiv.org');
  return route.fulfill({ status: 200, contentType: 'application/pdf', body: POSTER });
});
await context.route('**/api/pdf*', (route) => {
  const target = new URL(route.request().url()).searchParams.get('url') || '';
  asked.push(new URL(target).hostname);
  if (target.includes('repo.example.edu')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: PAPER });
  return route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'walled.example.com checks for a person before it hands out the file', botCheck: true, host: 'walled.example.com', where: 'cloudflare' }),
  });
});
await context.route('**/api.openalex.org/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...WORK, results: [WORK] }) }),
);
await context.route('**/api.crossref.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":{"items":[]}}' }));
await context.route('**/api.semanticscholar.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
await context.route('**/api.unpaywall.org/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await context.route('**/api/scholar*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));

async function selectOnlySource(target, label) {
  const chips = target.locator('.discover-panel .chip');
  for (let index = 0; index < (await chips.count()); index += 1) {
    const chip = chips.nth(index);
    const wanted = ((await chip.textContent()) || '').trim() === label;
    const pressed = (await chip.getAttribute('aria-pressed')) === 'true';
    if (wanted !== pressed) await chip.click();
  }
}

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`${message.type()}: ${message.text()}`);
});

const bar = page.locator('.copy-bar');
const current = page.locator('.copy-current');

console.log('\n== the poster is passed over ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await selectOnlySource(page, 'arXiv');
await page.getByLabel('Search papers').fill('fourier neural operator');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result', { hasText: 'Fourier Neural Operator' }).locator('h3').click();
await page.getByRole('button', { name: /^Read$/ }).click();
const pdfMode = page.locator('.segmented button', { hasText: 'PDF' });
await pdfMode.waitFor({ timeout: 15000 });
await pdfMode.click();
await page.waitForSelector('.pdf-pane :is(iframe, .pdf-scroll-slot)', { timeout: 20000 });
await bar.waitFor({ timeout: 10000 });
check('arXiv, the best-ranked copy, was asked', asked.includes('arxiv.org'), asked.join(', '));
check('the paper opens on the repository copy, not the poster', ((await current.textContent()) || '').includes('Caltech Repository'), await current.textContent());

await current.click();
const picker = page.locator('.copy-picker');
await picker.waitFor();
const arxivRow = picker.locator('.copy-option[title="https://arxiv.org/pdf/2010.08895v3"]');
// arXiv's file and its abstract page, the repository's file, the publisher's.
check('every copy is in the list', (await picker.locator('.copy-option').count()) === 4, String(await picker.locator('.copy-option').count()));
check('the poster says why it was passed over', ((await arxivRow.textContent()) || '').includes('looks like a poster'), await arxivRow.textContent());
check('the copy on screen says so', ((await picker.locator('.copy-option.showing').textContent()) || '').includes('Caltech Repository'));
await page.screenshot({ path: `${OUT}/copies-picker.png` });

console.log('\n== a copy behind Cloudflare, picked by hand ==');
await picker.locator('.copy-option', { hasText: 'Walled Press' }).click();
const failure = page.locator('.copy-error');
await failure.waitFor({ timeout: 10000 });
check('the refusal is said', ((await failure.textContent()) || '').includes('Walled Press would not hand over the PDF'), await failure.textContent());
check('the paper stays on screen meanwhile', await page.locator('.pdf-pane :is(iframe, .pdf-scroll)').first().isVisible());
check('it points at a tab of your own, at that copy', (await failure.locator('a[href="https://walled.example.com/fno.pdf"]').count()) === 1);
await page.screenshot({ path: `${OUT}/copies-refused.png` });
// As a person would: opened in a tab of their own, passed the check, dropped the file here.
await failure.locator('input[type=file]').setInputFiles({ name: 'fno.pdf', mimeType: 'application/pdf', buffer: PAPER });
await page.waitForFunction(() => document.querySelector('.copy-current')?.textContent?.includes('from your file'), null, { timeout: 10000 });
check('the file handed over is what is read', true);
check('and the refusal is gone', (await failure.count()) === 0);

console.log('\n== the poster, picked by hand ==');
await current.click();
await arxivRow.click();
await page.waitForFunction(() => document.querySelector('.copy-current')?.textContent?.includes('arXiv'), null, { timeout: 10000 });
check('a copy picked by hand is shown whatever it looks like', ((await current.textContent()) || '').includes('arXiv'), await current.textContent());
check('with no doubt raised about it', (await page.locator('.copy-status.doubtful').count()) === 0);

console.log('\n== the pick is remembered ==');
asked.length = 0;
await page.reload({ waitUntil: 'networkidle' });
const gate = page.getByRole('button', { name: /Start reading|Not now — keep everything in this browser/i }).first();
if (await gate.isVisible().catch(() => false)) await gate.click();
await page.waitForSelector('.pdf-pane :is(iframe, .pdf-scroll-slot)', { timeout: 20000 });
await bar.waitFor({ timeout: 10000 });
check('the paper reopens on the copy picked', ((await current.textContent()) || '').includes('arXiv'), await current.textContent());
check('asked first, and alone', asked[0] === 'arxiv.org' && !asked.includes('repo.example.edu'), asked.join(', '));
await current.click();
check('which the list marks as the one showing', ((await picker.locator('.copy-option.showing').getAttribute('title')) || '').includes('arxiv.org/pdf'));
check('and offers to forget', (await picker.getByRole('button', { name: 'Forget my pick' }).count()) === 1);
await page.screenshot({ path: `${OUT}/copies-remembered.png` });

const real = errors.filter((error) => !/favicon|net::ERR_|Failed to load resource/.test(error));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
