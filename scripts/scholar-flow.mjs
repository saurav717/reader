/**
 * Searching Google Scholar the way a person does, and reading what comes back.
 *
 *   search Scholar  ->  pick the paper  ->  ask Scholar for every version of it
 *   ->  download from the first host that will part with a file  ->  save it to
 *   Drive  ->  show the saved copy in the viewer.
 *
 * Everything on this side of Scholar is the real thing: the proxy routes in
 * `server/api.js`, the HTML parsing in `server/scholar.js`, the client in
 * `src/lib/scholar.ts`, the merge, the download fall-through, the Drive sync
 * and the viewer. The only thing replaced is the one fetch this repository
 * cannot make — `scripts/fixtures/scholar-*.html` stands in for what
 * scholar.google.com returns, because CI has no route to it and Scholar
 * answers a datacentre with a captcha anyway.
 *
 * So this proves the plumbing, not that Scholar is up. For that, run
 * `node scripts/scholar-live.mjs` from a machine Google trusts.
 *
 *   npm run build && node scripts/scholar-flow.mjs
 */
import express from 'express';
import { chromium } from 'playwright';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import apiRouter, { setScholarFetcher } from '../server/api.js';
import { forgetScholar } from '../server/scholar.js';
import { connectAndEnter, installGoogle, makePdf, reporter } from './fakeGoogle.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SMOKE_OUT || path.join(dirname, '..', '.smoke');
await mkdir(OUT, { recursive: true });

const fixture = (name) => readFile(path.join(dirname, 'fixtures', `${name}.html`), 'utf8');
const SEARCH = await fixture('scholar-search');
const VERSIONS = await fixture('scholar-versions');
const AUTHORS_NONE = await fixture('scholar-authors-none');
const AUTHOR_PAPERS = await fixture('scholar-author-papers');
const CAPTCHA = await fixture('scholar-captcha');

const PDF = makePdf(['Attention Is All You Need', 'Found on Google Scholar, saved to Drive.']);

// ------------------------------------------- Scholar, as far as the fetch ---

/** Which Scholar URLs were asked for, in order. */
const scholarAsked = [];
/** Flipped on to make Scholar refuse, for the last section. */
let refuse = false;

setScholarFetcher(async (url) => {
  scholarAsked.push(url);
  if (refuse) return { status: 200, html: CAPTCHA };
  const parsed = new URL(url);
  if (parsed.searchParams.get('cluster')) return { status: 200, html: VERSIONS };
  if (parsed.searchParams.get('view_op') === 'search_authors') return { status: 200, html: AUTHORS_NONE };
  const query = parsed.searchParams.get('q') || '';
  if (/author:/i.test(query)) return { status: 200, html: AUTHOR_PAPERS };
  return { status: 200, html: SEARCH };
});

// ------------------------------------------------ the app, and its proxy ----

/** Which upstream PDFs the proxy was asked for, in order. */
const proxied = [];

const app = express();
// The real /api router, so the Scholar routes under test are the shipped ones.
app.use('/api', (req, res, next) => {
  if (!req.url.startsWith('/scholar/')) return next();
  return apiRouter(req, res, next);
});
app.get('/api/pdf', (req, res) => {
  const target = String(req.query.url || '');
  proxied.push(target);
  // Publisher links that are really landing pages — what the proxy refuses.
  // Scholar's own direct link is one of these on purpose: it is the first
  // thing tried, and a paper whose first link works would test nothing.
  if (
    target.startsWith('https://papers.example-publisher.com/') ||
    target.startsWith('https://proceedings.neurips.cc/')
  ) {
    return res.status(415).json({ error: 'that link gave a web page rather than a PDF' });
  }
  // A repository link that has rotted, still indexed everywhere.
  if (target.startsWith('https://eprints.example.ac.uk/')) {
    return res.status(404).json({ error: 'the publisher answered 404 for that PDF' });
  }
  return res.set('Content-Type', 'application/pdf').send(PDF);
});
app.get('/api/arxiv/query', (_req, res) =>
  res.set('Content-Type', 'application/atom+xml').send('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'),
);
app.get('/api/arxiv/html', (_req, res) => res.status(404).json({ error: 'no HTML' }));
const BUILD = process.env.BUILD || 'dist';
const SITE_PATH = process.env.SITE_PATH || '/';
const root = path.join(dirname, '..', BUILD);
app.use(SITE_PATH, express.static(root, { index: false }));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));
const server = app.listen(4400);
const BASE = `http://localhost:4400${SITE_PATH}`;

const { check, problems } = reporter();

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const drive = await installGoogle(context, { pdf: PDF });

// The other indexes answer with nothing, so that everything on screen can only
// have come from Scholar.
const empty = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await context.route('**/api.openalex.org/**', (route) => empty(route, { results: [] }));
await context.route('**/api.semanticscholar.org/**', (route) => empty(route, { data: [] }));
await context.route('**/api.crossref.org/**', (route) => empty(route, { message: { items: [] } }));
await context.route('**/api.unpaywall.org/**', (route) => empty(route, {}));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

/** Leaves exactly the named source chips on. */
async function onlySources(names) {
  const chips = page.locator('.discover-panel .chip');
  for (let index = 0; index < (await chips.count()); index += 1) {
    const chip = chips.nth(index);
    const label = ((await chip.textContent()) || '').trim();
    const wanted = names.includes(label);
    if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
  }
}

console.log(`\n== ${BUILD} at ${SITE_PATH} ==`);
await page.goto(BASE, { waitUntil: 'networkidle' });
await connectAndEnter(page);
if (!(await page.locator('.dock .discover-panel').isVisible())) {
  await page.getByRole('button', { name: 'Discover papers' }).click();
}

console.log('\n== Google Scholar is a source you can turn on ==');
const chips = await page.locator('.discover-panel .chip').allTextContents();
check('Scholar is offered as a source', chips.some((chip) => /Google Scholar/i.test(chip)), chips.join(', '));
check('but is not on by default, because it can be refused', (await page.locator('.discover-panel .chip[aria-pressed="true"]').allTextContents()).every((chip) => !/Google Scholar/i.test(chip)));

await onlySources(['Google Scholar']);
check('turning it on explains what it is for', await page.locator('.discover-panel p', { hasText: /publishes no API/i }).isVisible());

console.log('\n== searching Scholar for the paper ==');
await page.getByLabel('Search papers').fill('attention is all you need');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result', { timeout: 15000 });

check('the proxy asked Scholar for the search page', scholarAsked.some((url) => /\/scholar\?.*q=attention/.test(url)), scholarAsked[0] || 'nothing asked');
const titles = await page.locator('article.result h3').allTextContents();
check('Scholar’s results are on screen', titles.length >= 3, `${titles.length}: ${titles[0]}`);
check('the title is not carrying Scholar’s [PDF] tag', titles.every((title) => !title.startsWith('[')), titles.join(' | '));
const meta = await page.locator('article.result').first().locator('.meta').textContent();
check('Scholar’s version count is shown', /84 versions/.test(meta || ''), meta || '');
check('so is its citation count', /145k citations/.test(meta || ''), meta || '');

console.log('\n== every version of it, from Scholar ==');
const result = page.locator('article.result', { hasText: 'Attention is all you need' }).first();
await result.locator('h3').click();
await page.waitForSelector('.locations ul li a', { timeout: 15000 });
check('the proxy asked Scholar for the cluster', scholarAsked.some((url) => /cluster=/.test(url)), scholarAsked.join(' | ').slice(0, 120));
const places = await page.locator('.locations li a').allTextContents();
check(
  'the copies Scholar lists are the ones offered',
  places.some((place) => /example\.edu/.test(place)) && places.some((place) => /example-publisher/.test(place)),
  places.join(', '),
);
await page.screenshot({ path: `${OUT}/scholar-versions.png` });

console.log('\n== download from the first host that will part with a file ==');
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.waitForSelector('.pdf-pane iframe', { timeout: 20000 });

check(
  'the link Scholar put on the result itself was tried first',
  /proceedings\.neurips\.cc/.test(proxied[0] || ''),
  proxied.join(' -> '),
);
check(
  'and when it and the publisher copy both gave back a web page, the versions were tried',
  proxied.some((url) => /example-publisher/.test(url)) && proxied.some((url) => /eprints\.example\.ac\.uk/.test(url)),
  proxied.join(' -> '),
);
check(
  'the copy that answered is the one that was taken',
  /dspace\.example\.edu/.test(proxied[proxied.length - 1] || ''),
  proxied.join(' -> '),
);
check('four copies were tried before one worked', proxied.length === 4, `${proxied.length}: ${proxied.join(' -> ')}`);
check('it went into Drive', drive.uploads.some((name) => name.endsWith('.pdf')), drive.uploads.join(', '));
check('the viewer is showing the copy read back out of Drive', drive.downloads.length >= 1, drive.downloads.join(', '));
const subtitle = await page.locator('.topbar .sub').textContent();
check('and says so', /PDF from your Drive/.test(subtitle || ''), subtitle || '');
await page.screenshot({ path: `${OUT}/scholar-drive-pdf.png` });

console.log('\n== a person Scholar has no profile for ==');
await page.getByRole('button', { name: 'Discover papers' }).click();
await page.getByRole('button', { name: 'Discover papers' }).click();
await page.locator('.discover-panel .segmented button', { hasText: 'Authors' }).click();
await onlySources(['Google Scholar']);
await page.getByLabel('Search for a person').fill('Saurav Chennuri');
await page.getByLabel('Search for a person').press('Enter');
await page.waitForSelector('.discover-panel .author-advice', { timeout: 15000 });

check(
  'Scholar was asked for the profile',
  scholarAsked.some((url) => /view_op=search_authors.*mauthors=Saurav/.test(url)),
  'no profile search',
);
const advice = await page.locator('.discover-panel .author-advice').textContent();
check('no profile is stated as an answer, not a failure', /No index keeps a record under that name/.test(advice || ''), (advice || '').slice(0, 70));
await page.waitForSelector('article.result', { timeout: 15000 });
const byName = await page.locator('article.result h3').allTextContents();
check(
  'and the papers with that name on them are found anyway',
  byName.some((title) => /dexterous manipulation/i.test(title)),
  byName.join(' | '),
);
check(
  'which came from asking Scholar the way a person would',
  scholarAsked.some((url) => /q=author/.test(url)),
  'no author query',
);
await page.screenshot({ path: `${OUT}/scholar-author.png` });

console.log('\n== when Scholar refuses ==');
refuse = true;
forgetScholar();
await page.locator('.discover-panel .segmented button', { hasText: 'Papers' }).click();
await page.getByLabel('Search papers').fill('attention is all you need');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('.discover-panel .banner', { timeout: 15000 });
const banner = await page.locator('.discover-panel .banner').first().textContent();
check('the refusal is reported as what it is', /captcha/i.test(banner || ''), (banner || '').slice(0, 90));
check('it is a warning, not an error — the other sources still work', (await page.locator('.discover-panel .banner.warn').count()) >= 1);
check('and nothing was silently reported as "no results"', !/no results/i.test(banner || ''));
await page.screenshot({ path: `${OUT}/scholar-blocked.png` });

const real = errors.filter(
  (message) => !/favicon|ERR_CERT|ERR_TUNNEL|fonts\.googleapis|gsi\/client|accounts\.google|Failed to load resource/.test(message),
);
check('no uncaught page errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(problems.length ? `\nFAILURES: ${problems.join(', ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
