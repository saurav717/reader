/**
 * The whole chain, end to end, in a real browser:
 *
 *   search every index  ->  list every copy of the paper  ->  download from
 *   whichever copy answers  ->  put it in Drive  ->  read it back out of Drive
 *   and show it in the viewer.
 *
 * Nothing here touches the network. The indexes (OpenAlex, Semantic Scholar,
 * Crossref, Unpaywall), Google Identity Services and the Drive API are all
 * stubbed in the page, and the PDF proxy is a stand-in that behaves the way
 * `server/api.js` does — including refusing a link that gives back a web page,
 * which is the failure the fall-through exists for.
 *
 * The paper is "Attention Is All You Need", set up the way it really is: a
 * publisher landing page that will not give you a file, a repository copy that
 * will, and an arXiv preprint. The first copy tried fails on purpose.
 *
 *   npm run build && node scripts/versions-drive.mjs
 */
import express from 'express';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { connectAndEnter, installGoogle, makePdf, reporter } from './fakeGoogle.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SMOKE_OUT || path.join(dirname, '..', '.smoke');
await mkdir(OUT, { recursive: true });

// ------------------------------------------------------------- the paper ----

// The conference record rather than the preprint, deliberately: a paper that
// is on arXiv is the easy case this app already handled. This one has to be
// found through the repositories, which is the whole point of the change.
const DOI = '10.5555/3295222.3295349';
const TITLE = 'Attention Is All You Need';

/** A publisher link that claims to be a PDF and gives back a web page. */
const LOCKED = 'https://papers.example-publisher.com/paper/7181-attention.pdf';
/** A repository copy that has rotted — the link is still indexed everywhere. */
const DEAD = 'https://eprints.example.ac.uk/7181/1/attention.pdf';
/** The copy that actually answers. */
const REPO = 'https://dspace.example.edu/bitstream/1721.1/7181/attention.pdf';

const OPENALEX_WORK = {
  id: 'https://openalex.org/W2963403868',
  doi: `https://doi.org/${DOI}`,
  display_name: TITLE,
  publication_date: '2017-06-12',
  abstract_inverted_index: {
    The: [0], dominant: [1], sequence: [2], transduction: [3], models: [4], are: [5],
    based: [6], on: [7], complex: [8], recurrent: [9], or: [10], convolutional: [11],
    neural: [12], networks: [13], 'in': [14], an: [15], 'encoder-decoder': [16],
    configuration: [17],
  },
  authorships: [
    { author: { display_name: 'Ashish Vaswani' } },
    { author: { display_name: 'Noam Shazeer' } },
    { author: { display_name: 'Niki Parmar' } },
  ],
  primary_location: {
    pdf_url: null,
    landing_page_url: 'https://papers.example-publisher.com/paper/7181',
    source: { display_name: 'Advances in Neural Information Processing Systems', type: 'conference' },
    version: 'publishedVersion',
  },
  best_oa_location: {
    pdf_url: LOCKED,
    landing_page_url: 'https://papers.example-publisher.com/paper/7181',
    source: { display_name: 'Example Publisher', type: 'conference' },
  },
  locations: [
    {
      pdf_url: LOCKED,
      landing_page_url: 'https://papers.example-publisher.com/paper/7181',
      source: { display_name: 'Example Publisher', type: 'conference' },
      version: 'publishedVersion',
    },
    {
      pdf_url: DEAD,
      landing_page_url: 'https://eprints.example.ac.uk/7181/',
      source: { display_name: 'Example College EPrints', type: 'repository' },
      version: 'acceptedVersion',
    },
    {
      pdf_url: REPO,
      landing_page_url: 'https://dspace.example.edu/handle/1721.1/7181',
      source: { display_name: 'Example University DSpace', type: 'repository' },
      version: 'acceptedVersion',
    },
  ],
  concepts: [{ display_name: 'Transformer' }],
  cited_by_count: 112000,
};

const UNPAYWALL = {
  best_oa_location: {
    url_for_pdf: LOCKED,
    host_type: 'publisher',
    version: 'publishedVersion',
  },
  oa_locations: [
    { url_for_pdf: LOCKED, host_type: 'publisher' },
    {
      url_for_pdf: DEAD,
      host_type: 'repository',
      repository_institution: 'Example College EPrints',
      version: 'acceptedVersion',
    },
    {
      url_for_pdf: REPO,
      url_for_landing_page: 'https://dspace.example.edu/handle/1721.1/7181',
      host_type: 'repository',
      repository_institution: 'Example University',
      version: 'acceptedVersion',
    },
  ],
};

const S2_PAPER = {
  paperId: 'abc123',
  title: TITLE,
  abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
  venue: 'NeurIPS',
  year: 2017,
  publicationDate: '2017-06-12',
  citationCount: 112000,
  authors: [{ name: 'Ashish Vaswani' }],
  externalIds: { DOI: DOI },
  openAccessPdf: { url: REPO },
};

const CROSSREF_ITEM = {
  DOI,
  title: [TITLE],
  author: [{ given: 'Ashish', family: 'Vaswani' }],
  issued: { 'date-parts': [[2017, 6, 12]] },
  'container-title': ['NeurIPS'],
  'is-referenced-by-count': 112000,
  URL: `https://doi.org/${DOI}`,
  publisher: 'Example Publisher',
  link: [{ URL: LOCKED, 'content-type': 'application/pdf' }],
};

const PDF = makePdf(['Attention Is All You Need', 'Saved to Drive from Example University DSpace.']);

// ------------------------------------------------------ the app, and a proxy --

/** What the proxy was asked for, so the test can say which copy won. */
const proxied = [];

const app = express();
app.get('/api/pdf', (req, res) => {
  const target = String(req.query.url || '');
  proxied.push(target);
  // Exactly what server/api.js answers for a link that is really a web page.
  if (target.startsWith('https://papers.example-publisher.com/')) {
    res.status(415).json({ error: 'that link gave a web page rather than a PDF' });
    return;
  }
  if (target.startsWith('https://eprints.example.ac.uk/')) {
    res.status(404).json({ error: 'the publisher answered 404 for that PDF' });
    return;
  }
  res.set('Content-Type', 'application/pdf').send(PDF);
});
app.get('/api/arxiv/pdf', (req, res) => {
  proxied.push(`arxiv:${req.query.id}`);
  res.set('Content-Type', 'application/pdf').send(PDF);
});
app.get('/api/arxiv/query', (_req, res) =>
  res.set('Content-Type', 'application/atom+xml').send('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'),
);
app.get('/api/arxiv/html', (_req, res) => res.status(404).json({ error: 'no HTML' }));
// The same checks run against either build: `dist` served at the root, the way
// `npm start` does, or `dist-pages` served under /reader/, the way GitHub Pages
// does for the deployed site.
//
//   BUILD=dist-pages SITE_PATH=/reader/ node scripts/versions-drive.mjs
const BUILD = process.env.BUILD || 'dist';
const SITE_PATH = process.env.SITE_PATH || '/';
const root = path.join(dirname, '..', BUILD);
app.use(SITE_PATH, express.static(root, { index: false }));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));
const server = app.listen(4399);
const BASE = `http://localhost:4399${SITE_PATH}`;
console.log(`\n== ${BUILD} at ${SITE_PATH} ==`);

const { check, problems } = reporter();

// ------------------------------------------------------------ a fake Drive ---

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const drive = await installGoogle(context, { pdf: PDF });

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// The indexes. The catch-all goes first; Playwright gives priority to the most
// recently registered route, so the specific ones are registered after it.
await context.route('**/api.openalex.org/**', (route) => json(route, { results: [OPENALEX_WORK] }));
await context.route('**/api.openalex.org/works/**', (route) => json(route, OPENALEX_WORK));
await context.route('**/api.openalex.org/authors*', (route) => json(route, { results: [] }));
await context.route('**/api.semanticscholar.org/**', (route) => json(route, { data: [S2_PAPER] }));
await context.route('**/api.semanticscholar.org/graph/v1/paper/DOI:**', (route) =>
  json(route, { openAccessPdf: { url: REPO }, externalIds: { DOI } }),
);
await context.route('**/api.semanticscholar.org/graph/v1/author/search*', (route) => json(route, { data: [] }));
await context.route('**/api.crossref.org/works?**', (route) => json(route, { message: { items: [CROSSREF_ITEM] } }));
await context.route('**/api.crossref.org/works/**', (route) => json(route, { message: CROSSREF_ITEM }));
await context.route('**/api.unpaywall.org/**', (route) => json(route, UNPAYWALL));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

// ------------------------------------------------------------------ run it ---

console.log('\n== connect ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await connectAndEnter(page);
check('Drive connects with the stubbed grant', await page.locator('.discover-panel, .library-panel').first().isVisible());

if (!(await page.locator('.dock .discover-panel').isVisible())) {
  await page.getByRole('button', { name: 'Discover papers' }).click();
}

console.log('\n== search every index, not just arXiv ==');
await page.getByLabel('Search papers').fill('attention is all you need');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result', { timeout: 15000 });
const titles = await page.locator('article.result h3').allTextContents();
check('the paper is found', titles.some((title) => /Attention Is All You Need/i.test(title)), titles.join(' | '));

const result = page.locator('article.result', { hasText: 'Attention Is All You Need' }).first();
await result.locator('h3').click();
await page.waitForSelector('.locations ul li a', { timeout: 15000 });

const places = await page.locator('.locations li a').allTextContents();
check('every copy is listed, not just one link', places.length >= 4, `${places.length}: ${places.join(', ')}`);
check(
  'the repository deposit is named, not just its host',
  places.some((place) => /Example University/i.test(place)),
  places.join(', '),
);
check(
  'the publisher copy is listed too',
  places.some((place) => /Example Publisher|example-publisher/i.test(place)),
  places.join(', '),
);
check('a Google Scholar link is offered for the paper', (await page.locator('.locations .loc-scholar').count()) >= 1);
const summary = await page.locator('.locations .eyebrow').first().textContent();
check('the count is stated in the panel', /Readable in \d+ places/.test(summary || ''), summary || '');
await page.screenshot({ path: `${OUT}/versions.png` });

console.log('\n== add it: download from whichever copy answers, save it to Drive, open it ==');
// One press does the whole chain. There is no separate "save" step to find:
// adding a paper to a collection is what puts it in Drive and opens it.
check('there is no second button to press for Drive', (await page.getByRole('button', { name: /Save to Drive/i }).count()) === 0);
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.waitForSelector('.pdf-pane iframe', { timeout: 20000 });
check('the paper is in the collection', await result.locator('.pill-added', { hasText: /In Reading list/ }).isVisible());
check('adding says nothing went wrong', (await result.locator('.banner').count()) === 0, (await result.locator('.banner').allTextContents()).join(' | '));

check('the best-ranked copy was tried first', proxied[0] === DEAD, proxied.join(' -> '));
check('a rotted link did not end it', proxied.includes(REPO), proxied.join(' -> '));
check(
  'and the copy that answered is the one that was saved',
  proxied[proxied.length - 1] === REPO,
  proxied.join(' -> '),
);
check('the PDF was uploaded to Drive', drive.uploads.some((name) => name.endsWith('.pdf')), drive.uploads.join(', '));
check('the sidecar went up beside it', drive.uploads.some((name) => name.endsWith('.json')), drive.uploads.join(', '));
check(
  'each paper gets its own folder under Papers_collection',
  drive.folders.has('Papers_collection') && drive.folders.size >= 2,
  Array.from(drive.folders.keys()).join(' / '),
);

console.log('\n== the viewer shows the copy that is in Drive ==');
check('the PDF pane is open', await page.locator('.pdf-pane iframe').isVisible());
check(
  'the bytes came back out of Drive',
  drive.downloads.length >= 1,
  `downloads: ${drive.downloads.join(', ')}`,
);
const subtitle = await page.locator('.topbar .sub').textContent();
check('the reader says the copy is from Drive', /PDF from your Drive/.test(subtitle || ''), subtitle || '');
check(
  'the viewer is showing a file it holds, not a publisher URL',
  (await page.locator('.pdf-pane iframe').getAttribute('src'))?.startsWith('blob:'),
);
check('there is a link straight to the file in Drive', (await page.locator('.topbar a[href*="drive.google.com"]').count()) === 1);
await page.screenshot({ path: `${OUT}/drive-pdf.png` });

// The two ways the chain can end without the file in Drive, each of which
// used to end in silence: the paper was in the library, the sync log behind
// Settings knew why, and the panel the reader was looking at said nothing.
console.log('\n== when no copy will hand over the file ==');
const noFile = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const noFileDrive = await installGoogle(noFile, { pdf: PDF });
await noFile.route('**/api.openalex.org/**', (route) => json(route, { results: [OPENALEX_WORK] }));
await noFile.route('**/api.openalex.org/works/**', (route) => json(route, OPENALEX_WORK));
await noFile.route('**/api.semanticscholar.org/**', (route) => json(route, { data: [] }));
await noFile.route('**/api.crossref.org/**', (route) => json(route, { message: { items: [] } }));
await noFile.route('**/api.unpaywall.org/**', (route) => json(route, UNPAYWALL));
// Every copy is a login wall today.
await noFile.route('**/api/pdf*', (route) =>
  route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'that link gave a web page rather than a PDF' }) }),
);
const noFilePage = await noFile.newPage();
noFilePage.on('pageerror', (error) => errors.push(String(error)));
await noFilePage.goto(BASE, { waitUntil: 'networkidle' });
await connectAndEnter(noFilePage);
if (!(await noFilePage.locator('.dock .discover-panel').isVisible())) {
  await noFilePage.getByRole('button', { name: 'Discover papers' }).click();
}
await noFilePage.getByLabel('Search papers').fill('attention is all you need');
await noFilePage.getByLabel('Search papers').press('Enter');
await noFilePage.waitForSelector('article.result', { timeout: 15000 });
const noFileResult = noFilePage.locator('article.result', { hasText: 'Attention Is All You Need' }).first();
await noFileResult.locator('h3').click();
await noFilePage.waitForSelector('.locations ul li a', { timeout: 15000 });
await noFilePage.getByRole('button', { name: /Add to collection/i }).click();
await noFilePage.waitForSelector('.topbar .title', { timeout: 20000 });
await noFilePage.waitForSelector('article.result .banner', { timeout: 20000 });
const noFileSaid = (await noFileResult.locator('.banner').first().textContent()) || '';
check('the paper is still added', await noFileResult.locator('.pill-added').isVisible());
check('and still opened', await noFilePage.locator('.topbar .title', { hasText: /Attention/ }).isVisible());
check(
  'and the result says the file is not in Drive, and why',
  /not in Drive/.test(noFileSaid) && /would hand over a PDF/.test(noFileSaid),
  noFileSaid,
);
// The sidecar may still follow — the reader saves metadata on open — but
// there was never a file to send.
check('no PDF was uploaded for it', !noFileDrive.uploads.some((name) => name.endsWith('.pdf')), noFileDrive.uploads.join(', '));
await noFilePage.screenshot({ path: `${OUT}/add-no-file.png` });
await noFile.close();

console.log('\n== when Drive refuses the upload ==');
const refused = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await installGoogle(refused, { pdf: PDF });
await refused.route('**/api.openalex.org/**', (route) => json(route, { results: [OPENALEX_WORK] }));
await refused.route('**/api.openalex.org/works/**', (route) => json(route, OPENALEX_WORK));
await refused.route('**/api.semanticscholar.org/**', (route) => json(route, { data: [] }));
await refused.route('**/api.crossref.org/**', (route) => json(route, { message: { items: [] } }));
await refused.route('**/api.unpaywall.org/**', (route) => json(route, UNPAYWALL));
// What Drive answers when the API is not enabled on the Cloud project.
await refused.route('**/www.googleapis.com/upload/drive/v3/files*', (route) =>
  route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Google Drive API has not been used in project 308274983351 before or it is disabled.' } }) }),
);
const refusedPage = await refused.newPage();
refusedPage.on('pageerror', (error) => errors.push(String(error)));
await refusedPage.goto(BASE, { waitUntil: 'networkidle' });
await connectAndEnter(refusedPage);
if (!(await refusedPage.locator('.dock .discover-panel').isVisible())) {
  await refusedPage.getByRole('button', { name: 'Discover papers' }).click();
}
await refusedPage.getByLabel('Search papers').fill('attention is all you need');
await refusedPage.getByLabel('Search papers').press('Enter');
await refusedPage.waitForSelector('article.result', { timeout: 15000 });
const refusedResult = refusedPage.locator('article.result', { hasText: 'Attention Is All You Need' }).first();
await refusedResult.locator('h3').click();
await refusedPage.waitForSelector('.locations ul li a', { timeout: 15000 });
await refusedPage.getByRole('button', { name: /Add to collection/i }).click();
await refusedPage.waitForSelector('article.result .banner.error', { timeout: 20000 });
await refusedPage.waitForSelector('.pdf-pane iframe', { timeout: 20000 });
const refusedSaid = (await refusedResult.locator('.banner.error').textContent()) || '';
check('the result says Drive refused, with Google’s own reason', /Drive would not take it/.test(refusedSaid) && /403/.test(refusedSaid) && /Drive API/.test(refusedSaid), refusedSaid);
check('the paper still opens, on the copy that was fetched', await refusedPage.locator('.pdf-pane iframe').isVisible());
const refusedSub = (await refusedPage.locator('.topbar .sub').textContent()) || '';
check('and says where that copy came from', /PDF from Example University/.test(refusedSub), refusedSub);
await refusedPage.screenshot({ path: `${OUT}/add-drive-refused.png` });
await refused.close();

console.log('\n== a person nobody indexes ==');
await page.getByRole('button', { name: 'Discover papers' }).click();
await page.getByRole('button', { name: 'Discover papers' }).click();
await page.locator('.discover-panel .segmented button', { hasText: 'Authors' }).click();
await page.getByLabel('Search for a person').fill('Saurav Chennuri');
await page.getByLabel('Search for a person').press('Enter');
await page.waitForSelector('.discover-panel .loc-scholar', { timeout: 15000 });
const advice = await page.locator('.discover-panel .author-advice').textContent();
check(
  'an unindexed name says so rather than showing an empty panel',
  /No index keeps a record under that name/.test(advice || ''),
  (advice || '').slice(0, 80),
);
check(
  'and offers Google Scholar for the person',
  (await page.locator('.discover-panel a.loc-scholar[href*="scholar.google.com"]').count()) >= 1,
);
await page.screenshot({ path: `${OUT}/author-fallback.png` });

const real = errors.filter(
  (message) => !/favicon|ERR_CERT|fonts\.googleapis|gsi\/client|accounts\.google|Failed to load resource/.test(message),
);
check('no uncaught page errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(problems.length ? `\nFAILURES: ${problems.join(', ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
