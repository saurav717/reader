/**
 * The hover cards in Reflow mode. The proxy is stubbed to hand the reader a
 * paper printed by Chromium — citations in its text, a numbered
 * bibliography — and OpenAlex and Scholar are stubbed to know its authors
 * and what it cites. The test hovers over an author's name and over the
 * citations and checks what the cards say.
 *
 *   npm run build && npm start &
 *   node scripts/hover-smoke.mjs         # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2010.08895v3</id>
    <published>2020-10-18T00:00:00Z</published>
    <title>Fourier Neural Operator for Parametric Partial Differential Equations</title>
    <summary>We introduce a new class of deep learning models that learn mappings between function spaces.</summary>
    <author><name>Zongyi Li</name></author>
    <author><name>Nikola Kovachki</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2010.08895v3"/>
    <category term="cs.LG"/>
  </entry>
</feed>`;

const sentence =
  'Neural operators learn mappings between function spaces, so one trained model answers a whole family of parametric problems.';
const prose = (count) => Array.from({ length: count }, () => sentence).join(' ');

const PAPER = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: letter; margin: 0.75in 0.6in; }
body { font-family: 'Liberation Serif', 'Times New Roman', serif; font-size: 10pt; line-height: 1.2; text-align: justify; }
h1 { text-align: center; font-size: 17pt; margin: 0 0 14pt; }
h2 { font-size: 12pt; margin: 10pt 0 4pt; }
p { margin: 0 0 4pt; }
.ref { font-size: 9pt; text-indent: -1.2em; padding-left: 1.2em; }
</style></head><body>
<h1>Fourier Neural Operator for Parametric Partial Differential Equations</h1>
<h2>1 Introduction</h2>
<p>${prose(3)} Graph kernel networks [1] came first, and operator networks [2, 3] learn the same maps.</p>
<p>${prose(4)}</p>
<h2>References</h2>
<p class="ref">[1] Z. Li, N. Kovachki, and A. Anandkumar. Neural operator: Graph kernel network for partial differential equations. In ICLR Workshop, 2020.</p>
<p class="ref">[2] L. Lu, P. Jin, and G. E. Karniadakis. Learning nonlinear operators via DeepONet based on the universal approximation theorem. Nature Machine Intelligence, 2021.</p>
<p class="ref">[3] K. Bhattacharya, B. Hosseini, N. Kovachki, and A. Stuart. Model reduction and neural networks for parametric PDEs. SMAI Journal, 2021.</p>
</body></html>`;

/** OpenAlex, as far as this paper goes: the paper's own record, two people, and the cited works. */
const WORK = {
  id: 'https://openalex.org/W1',
  topics: [{ display_name: 'Neural operators', field: { display_name: 'Computer Science' } }],
  title: 'Fourier Neural Operator for Parametric Partial Differential Equations',
  authorships: [
    { author: { id: 'https://openalex.org/A1', display_name: 'Zongyi Li' }, institutions: [{ display_name: 'California Institute of Technology' }] },
    { author: { id: 'https://openalex.org/A2', display_name: 'Nikola B. Kovachki' }, institutions: [{ display_name: 'California Institute of Technology' }] },
  ],
};
const AUTHOR = {
  id: 'https://openalex.org/A1',
  display_name: 'Zongyi Li',
  orcid: 'https://orcid.org/0000-0000-0000-0001',
  works_count: 42,
  cited_by_count: 9876,
  summary_stats: { h_index: 21, i10_index: 30 },
  last_known_institutions: [{ display_name: 'Massachusetts Institute of Technology' }],
  topics: [{ display_name: 'Neural operators' }, { display_name: 'Scientific machine learning' }],
};
/** The record OpenAlex files the second author under: a namesake in another field altogether. */
const NAMESAKE = {
  id: 'https://openalex.org/A2',
  display_name: 'Nikola Kovachki',
  orcid: null,
  works_count: 193,
  cited_by_count: 2000,
  summary_stats: { h_index: 19, i10_index: 44 },
  last_known_institutions: [{ display_name: 'Victoria University of Wellington' }],
  topics: [
    { display_name: 'Music Technology and Sound Studies', count: 40, field: { display_name: 'Engineering' } },
    { display_name: 'Advanced Optical Sensing Technologies', count: 30, field: { display_name: 'Physics and Astronomy' } },
  ],
};
const cited = (title, year, cites, extra = {}) => ({
  id: `https://openalex.org/W${Math.abs(title.length * 7919)}`,
  doi: null,
  display_name: title,
  publication_date: `${year}-01-01`,
  abstract_inverted_index: { A: [0], short: [1], abstract: [2] },
  authorships: [{ author: { display_name: 'Someone Else' } }],
  primary_location: { pdf_url: null, landing_page_url: 'https://example.org/paper', source: { display_name: 'Venue' } },
  concepts: [],
  cited_by_count: cites,
  ...extra,
});
const GRAPH = cited('Neural Operator: Graph Kernel Network for Partial Differential Equations', 2020, 812);
const DEEPONET = cited('Learning nonlinear operators via DeepONet based on the universal approximation theorem of operators', 2021, 2400);

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const printer = await browser.newPage();
await printer.setContent(PAPER);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await context.route('**/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/arxiv/html*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
await context.route('**/arxiv/pdf*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
await context.route('**/api.crossref.org/**', (route) => json(route, { message: { items: [] } }));
await context.route('**/api.semanticscholar.org/**', (route) => json(route, { data: [] }));
await context.route('**/api.unpaywall.org/**', (route) => route.fulfill({ status: 404, body: '' }));
// Playwright asks the last route first, so the catch-all goes in ahead of the one it stands behind.
await context.route('**/scholar/*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
await context.route('**/scholar/authors*', (route) =>
  json(route, {
    results: [
      { name: 'Zongyi Li', userId: 'abcDEF123', profileUrl: 'https://scholar.google.com/citations?user=abcDEF123', affiliation: 'MIT', citedBy: 12345, interests: ['Machine learning', 'PDEs'], verifiedEmail: 'mit.edu' },
      { name: 'Zongyi Li', userId: 'zzzOTHER9', profileUrl: 'https://scholar.google.com/citations?user=zzzOTHER9', affiliation: 'Somewhere Else', citedBy: 10 },
    ],
  }),
);
// Open Library has no book of the paper's title, so nobody is found elsewhere.
await context.route('**/openlibrary.org/**', (route) => json(route, { docs: [] }));
const asked = [];
await context.route('**/api.openalex.org/**', (route) => {
  const url = new URL(route.request().url());
  asked.push(`${url.pathname}?${Array.from(url.searchParams, ([key, value]) => `${key}=${value}`).join('&')}`);
  if (url.pathname.startsWith('/works/doi:')) return json(route, WORK);
  if (url.pathname === '/authors/A1') return json(route, AUTHOR);
  if (url.pathname === '/authors/A2') return json(route, NAMESAKE);
  if (url.pathname === '/works') {
    const filter = url.searchParams.get('filter') || '';
    if (url.searchParams.has('group_by')) return json(route, { group_by: [{ key: '2019', count: 3 }, { key: '2020', count: 4 }] });
    if (filter.startsWith('author.id:A1')) return json(route, { results: [DEEPONET, GRAPH] });
    if (filter.startsWith('author.id:A2')) return json(route, { results: [cited('Achieving sub-millimetre precision with a range imaging camera', 2007, 72)] });
    if (filter.startsWith('raw_author_name.search:')) {
      return json(route, {
        results: [
          { ...cited('Neural operator: Learning maps between function spaces', 2021, 1500), authorships: [{ author: { display_name: 'Nikola B. Kovachki' } }] },
        ],
      });
    }
    if (/graph kernel/i.test(filter)) return json(route, { results: [GRAPH] });
    if (/deeponet/i.test(filter)) return json(route, { results: [DEEPONET] });
  }
  return json(route, { results: [] });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = ((await chip.textContent()) || '').trim() === 'arXiv';
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('fourier neural operator');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result', { hasText: 'Fourier Neural Operator' }).locator('h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.paper-body h2', { timeout: 30000 });

console.log('\n== citations are marked ==');
const cites = await page.locator('.paper-body .cite').allTextContents();
check('each citation in the text is marked', JSON.stringify(cites) === JSON.stringify(['[1]', '[2, 3]']), JSON.stringify(cites));
check('the bibliography entries are numbered', (await page.locator('.paper-body .ref-entry').count()) === 3);

console.log('\n== an author ==');
await page.locator('.paper-authors .author-name', { hasText: 'Zongyi Li' }).hover();
await page.waitForSelector('.hover-card .hc-stats', { timeout: 10000 });
await page.waitForSelector('.hover-card .hc-scholar a', { timeout: 10000 });
const person = (await page.locator('.hover-card').textContent()) || '';
check('the card names them and where they were', person.includes('Zongyi Li') && person.includes('California Institute of Technology'), person.slice(0, 120));
check('and where they are now', person.includes('Now at Massachusetts Institute of Technology'));
check('with their counts', person.includes('9.9k') && person.includes('21') && person.includes('30'));
check(
  'and the Scholar profile at their institution, not the namesake',
  (await page.locator('.hover-card .hc-scholar a').getAttribute('href')) === 'https://scholar.google.com/citations?user=abcDEF123',
);
check('with their interests from Scholar', person.includes('Machine learning'));
check('and their most cited papers', person.includes('DeepONet'));
await page.screenshot({ path: `${OUT}hover-author.png` });

await page.mouse.move(700, 4);
await page.waitForSelector('.hover-card', { state: 'detached', timeout: 3000 });
check('the card goes when the pointer leaves', (await page.locator('.hover-card').count()) === 0);

console.log('\n== an author OpenAlex mistakes for a namesake ==');
await page.locator('.paper-authors .author-name', { hasText: 'Nikola Kovachki' }).hover();
await page.waitForSelector('.hover-card .hc-works', { timeout: 10000 });
const other = (await page.locator('.hover-card').textContent()) || '';
check('the namesake’s counts are not shown', (await page.locator('.hover-card .hc-stats').count()) === 0);
check('nor where the namesake is', !other.includes('Now at Victoria University of Wellington'), other.slice(0, 160));
check('the card says the record is someone else’s', other.includes('that is not them') && other.includes('Engineering'));
check('and that there is no Scholar profile', other.includes('No Google Scholar profile'));
check('nor a profile anywhere', other.includes('No registered profile of theirs was found'));
check('and lists other work under the name', other.includes('Learning maps between function spaces') && other.includes('some may be a namesake'));
await page.screenshot({ path: `${OUT}hover-author-nowhere.png` });

await page.mouse.move(700, 4);
await page.waitForSelector('.hover-card', { state: 'detached', timeout: 3000 });

console.log('\n== a citation ==');
await page.locator('.paper-body .cite', { hasText: '[1]' }).hover();
await page.waitForSelector('.hover-card .hc-title', { timeout: 10000 });
const one = (await page.locator('.hover-card').textContent()) || '';
check('the card shows the entry as printed', one.includes('Z. Li, N. Kovachki, and A. Anandkumar'));
check('and the paper it is', ((await page.locator('.hover-card .hc-title').textContent()) || '').startsWith('Neural Operator: Graph Kernel Network'));
check('with how often it is cited', one.includes('cited by 812'));
await page.screenshot({ path: `${OUT}hover-citation.png` });

await page.mouse.move(700, 4);
await page.waitForSelector('.hover-card', { state: 'detached', timeout: 3000 });
await page.locator('.paper-body .cite', { hasText: '[2, 3]' }).hover();
await page.waitForSelector('.hover-card .hc-tabs', { timeout: 10000 });
check('a citation of two has a tab for each', JSON.stringify(await page.locator('.hover-card .hc-tabs button').allTextContents()) === '["2","3"]');
await page.waitForSelector('.hover-card .hc-title', { timeout: 10000 });
check('the first is looked up', ((await page.locator('.hover-card .hc-title').textContent()) || '').includes('DeepONet'));
await page.locator('.hover-card .hc-tabs button', { hasText: '3' }).hover();
await page.waitForSelector('.hover-card .hc-note', { timeout: 10000 });
check('one nobody knows says so', ((await page.locator('.hover-card .hc-note').textContent()) || '').includes('None of the indexes'));

await page.locator('.hover-card .hc-action', { hasText: 'In the bibliography' }).click();
await page.waitForTimeout(400);
check('"In the bibliography" goes to the entry', (await page.locator('.paper-body .ref-flash').count()) === 1);

console.log('\n== a reference asked twice is asked once ==');
check('the entry was searched for once', asked.filter((line) => /graph kernel/i.test(line)).length === 1, asked.join('\n    '));

check('no page errors', errors.length === 0, errors.join('\n  '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
