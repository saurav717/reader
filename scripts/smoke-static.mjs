/**
 * Verifies the static (no-proxy) build — the one that goes on GitHub Pages.
 * Serves dist-pages at /reader/ exactly as Pages would, stubs OpenAlex (which
 * the real app calls directly, since it sends CORS headers), and checks the
 * app degrades the way it claims to.
 */
import express from 'express';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SMOKE_OUT || path.join(dirname, '..', '.smoke');
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const app = express();
app.use('/reader', express.static(path.join(dirname, '..', 'dist-pages')));
const server = app.listen(4321);

const OPENALEX = {
  results: [
    {
      id: 'https://openalex.org/W3095748548',
      doi: 'https://doi.org/10.48550/arxiv.2010.08895',
      display_name: 'Fourier Neural Operator for Parametric Partial Differential Equations',
      publication_date: '2020-10-18',
      abstract_inverted_index: {
        'The': [0], classical: [1], solver: [2], discretises: [3], the: [4], domain: [5],
        and: [6], solves: [7], for: [8], one: [9], instance: [10], 'of': [11],
        'coefficients.': [12],
      },
      authorships: [{ author: { display_name: 'Zongyi Li' } }, { author: { display_name: 'Nikola Kovachki' } }],
      primary_location: { pdf_url: null, landing_page_url: 'https://arxiv.org/abs/2010.08895', source: { display_name: 'arXiv' } },
      concepts: [{ display_name: 'Operator learning' }],
    },
  ],
};

const problems = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) problems.push(label);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/api.openalex.org/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OPENALEX) }),
);
// Nothing may reach a same-origin /api on a static host; fail loudly if it does.
let proxyCalls = 0;
await context.route('**/reader/api/**', (route) => {
  proxyCalls += 1;
  return route.fulfill({ status: 404, body: 'no proxy here' });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto('http://localhost:4321/reader/', { waitUntil: 'networkidle' });
check('static build boots at a sub-path', await page.getByRole('heading', { name: /Read papers/i }).isVisible());

await page.getByRole('button', { name: /Skip — keep everything local/i }).click();
await page.getByRole('button', { name: 'Discover papers' }).click();

const chips = await page.locator('.panel .chip').allTextContents();
check('arXiv is hidden as a source', !chips.includes('arXiv'), `chips: ${chips.join(', ')}`);
check('OpenAlex is offered instead', chips.includes('OpenAlex'));
check('the limitation is explained, not hidden', await page.locator('.banner.warn').first().isVisible());

await page.getByLabel('Search papers').fill('fourier neural operator');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result', { timeout: 10000 });
check('OpenAlex search returns results', (await page.locator('article.result h3').count()) === 1);

await page.locator('article.result h3').click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.waitForSelector('.paper-body p');
check('reader falls back to the abstract', (await page.locator('.reader-column .banner.warn').count()) === 1);
check('PDF opens externally instead of in a tab', (await page.locator('.topbar a[href^="https://arxiv.org/pdf/"]').count()) === 1);

await page.evaluate(() => {
  const node = document.querySelector('.paper-body p').firstChild;
  const range = document.createRange();
  range.setStart(node, 4);
  range.setEnd(node, 22);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await page.waitForSelector('.selection-toolbar');
await page.locator('.selection-toolbar button').first().click();
await page.waitForSelector('mark.hl');
check('highlighting still works on the abstract', (await page.locator('mark.hl').count()) === 1);

check('nothing tried to call a same-origin proxy', proxyCalls === 0, `calls=${proxyCalls}`);
await page.screenshot({ path: `${OUT}/static-reader.png` });

const real = errors.filter((m) => !/favicon|ERR_CERT_AUTHORITY_INVALID|fonts\.googleapis|gsi\/client|accounts\.google/.test(m));
check('no uncaught page errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(problems.length ? `\nFAILURES: ${problems.join(', ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
