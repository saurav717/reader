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

const ARTICLE = {
  source: 'arxiv',
  base: 'https://arxiv.org/html/2010.08895',
  html: `<html><body><div class="ltx_page_content">
    <h2>1 Introduction</h2>
    <p>A classical solver discretises the domain and then solves for one instance of the coefficients.</p>
    <h2>2 Learning operators</h2>
    <p>An operator learning method fits a map between infinite-dimensional function spaces, so a single trained model answers a whole family of parametric problems.</p>
    <p>The Fourier neural operator parameterises the integral kernel directly in Fourier space and truncates the higher modes.</p>
  </div></body></html>`,
};

// Enough of a PDF for the app to accept it and hand it to the viewer; the
// proxy's own rules about what is a PDF are tested in scripts/pdf-proxy.test.mjs.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

// The lookup box calls three keyless, CORS-open services. Stubbing them keeps
// the smoke test offline and its assertions stable.
const DEFINITION = [
  {
    word: 'operator',
    phonetic: '/ˈɒpəreɪtə/',
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [{ definition: 'A mapping from one function space to another.', example: 'a linear operator' }],
        synonyms: ['map'],
      },
    ],
    sourceUrls: ['https://en.wiktionary.org/wiki/operator'],
  },
];

const WIKI_SEARCH = {
  pages: [{ key: 'Operator_(mathematics)', title: 'Operator (mathematics)', description: 'mathematical mapping' }],
};

const WIKI_SUMMARY = {
  extract: 'In mathematics, an operator is generally a mapping between two function spaces.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Operator_(mathematics)' } },
};

const OPENALEX = {
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/one',
      display_name: 'On operators between function spaces',
      publication_date: '1932-04-01',
      abstract_inverted_index: null,
      authorships: [{ author: { display_name: 'S Banach' } }],
      primary_location: { pdf_url: null, landing_page_url: 'https://example.org/one', source: null },
      best_oa_location: { pdf_url: 'https://repository.example.org/one.pdf', landing_page_url: null, source: null },
      open_access: { is_oa: true, oa_url: 'https://repository.example.org/one.pdf' },
      concepts: [],
      cited_by_count: 4211,
    },
  ],
};

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

async function stub(target) {
  await target.route('**/api/arxiv/query*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }),
  );
  await target.route('**/api/arxiv/html*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ARTICLE) }),
  );
  await target.route('**/api/arxiv/pdf*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }),
  );
  await target.route('**/api/pdf*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }),
  );
  await target.route('**/api.dictionaryapi.dev/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFINITION) }),
  );
  await target.route('**/en.wikipedia.org/w/rest.php/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WIKI_SEARCH) }),
  );
  await target.route('**/en.wikipedia.org/api/rest_v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WIKI_SUMMARY) }),
  );
  await target.route('**/api.openalex.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OPENALEX) }),
  );
}
await stub(context);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

console.log('\n== boot ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
check('welcome screen renders', await page.getByRole('heading', { name: /Read papers/i }).isVisible());
check('sign in with Google button present', await page.getByRole('button', { name: /Sign in with Google/i }).first().isVisible());

await page.getByRole('button', { name: /Skip — keep everything local/i }).click();

console.log('\n== layout ==');
check('the library sits on the left of the reading column', await page.evaluate(() => {
  const library = document.querySelector('.library-panel');
  const main = document.querySelector('.main');
  return Boolean(library && main && library.getBoundingClientRect().right <= main.getBoundingClientRect().left + 1);
}));

check('discover opens on the right of the reading column', await page.evaluate(() => {
  const dock = document.querySelector('.dock');
  const main = document.querySelector('.main');
  return Boolean(dock && main && dock.getBoundingClientRect().left >= main.getBoundingClientRect().right - 1);
}));
check('discover is inside the right-hand dock', (await page.locator('.dock .discover-panel').count()) === 1);
await page.getByRole('button', { name: 'Discover papers' }).click();
check('the rail closes the dock', (await page.locator('.dock').count()) === 0);
await page.getByRole('button', { name: 'Discover papers' }).click();

console.log('\n== search and add ==');
await page.getByLabel('Search papers').fill('fourier neural operator');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
check('search returns a parsed result', (await page.locator('article.result h3').count()) === 1);

await page.locator('article.result h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.waitForSelector('.paper-body p');
check('reader shows the fetched full text', (await page.locator('.paper-body p').count()) === 3);

console.log('\n== highlight ==');
await page.evaluate(() => {
  const paragraph = document.querySelectorAll('.paper-body p')[1];
  const node = paragraph.firstChild;
  const text = node.data;
  const start = text.indexOf('fits a map');
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + 'fits a map between infinite-dimensional function spaces'.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await page.waitForSelector('.selection-toolbar');
check('selection toolbar appears', true);
await page.locator('.selection-toolbar button').first().click();
await page.waitForSelector('mark.hl');
const marked = await page.locator('mark.hl').first().textContent();
check('highlight painted over the exact quote', marked === 'fits a map between infinite-dimensional function spaces', `got "${marked}"`);
check('the highlights pane lists the highlight', (await page.locator('.note-card').count()) === 1);
check('the highlights pane groups by section', (await page.locator('.notes-rail .eyebrow').first().textContent())?.includes('2 Learning operators'));

console.log('\n== library status ==');
check(
  'the left panel groups papers by reading status',
  (await page.locator('.library-panel .status-head', { hasText: 'Not started' }).count()) === 1,
);
check('the paper appears under its status', (await page.locator('.library-panel .paper-row').count()) === 1);
check(
  'the left panel counts what is not started',
  (await page.locator('.library-panel .nav-item', { hasText: 'Not started' }).locator('.count').textContent()) === '1',
);

console.log('\n== pdf ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click();
await page.waitForSelector('.pdf-pane iframe', { timeout: 10000 });
check('the PDF opens in the reader', await page.locator('.pdf-pane iframe').isVisible());
check(
  'the PDF comes from the proxy, not the publisher',
  (await page.locator('.pdf-pane iframe').getAttribute('src'))?.startsWith('blob:'),
);
const download = page.locator('.topbar button[aria-label="Download the PDF"]');
check('a download button sits next to the mode switch', await download.isVisible());
const saved = page.waitForEvent('download', { timeout: 10000 });
await download.click();
check('it saves the file under the paper\'s name', (await saved).suggestedFilename().endsWith('.pdf'));
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.paper-body p');

console.log('\n== lookup box ==');
await page.evaluate(() => {
  const paragraph = document.querySelectorAll('.paper-body p')[2];
  const node = paragraph.firstChild;
  const text = node.data;
  const start = text.indexOf('integral kernel');
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + 'integral kernel'.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
});
await page.waitForSelector('.lookup');
check('right-click opens the lookup box', true);
check('the box has three panes', (await page.locator('.lookup-pane').count()) === 3);
await page.waitForSelector('.lookup-word');
check('the dictionary pane resolves a definition', (await page.locator('.lookup-pane ol li').first().textContent())?.includes('function space'));
check(
  'the origins pane traces the phrase',
  (await page.locator('.lookup-papers a').first().textContent())?.includes('operators between function spaces'),
);
check(
  'all three panes are visible side by side on a wide screen',
  (await page.locator('.lookup-pane:visible').count()) === 3,
);
await page.locator('#lookup-comment').fill('Where does this kernel parameterisation come from?');
await page.waitForSelector('mark.hl[data-has-note="true"]');
const commented = await page.locator('mark.hl[data-has-note="true"]').first().textContent();
check('commenting highlights the passage as you type', commented === 'integral kernel', `got "${commented}"`);
await page.screenshot({ path: `${OUT}/lookup.png` });
await page.keyboard.press('Escape');
await page.waitForSelector('.lookup', { state: 'detached' });
check('escape closes the lookup box', true);
check('the comment is kept as a highlight', (await page.locator('mark.hl').count()) === 2);

console.log('\n== note ==');
await page.locator('.note-card').filter({ hasText: 'fits a map' }).locator('.quote').click();
await page
  .locator('.note-card')
  .filter({ hasText: 'fits a map' })
  .locator('textarea')
  .fill('Is the win from the FFT or the global receptive field?');
await page.waitForTimeout(300);

console.log('\n== persistence and re-anchoring ==');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.paper-body p', { timeout: 10000 }).catch(() => {});
check('reader reopens on the paper you were reading', (await page.locator('.paper-body p').count()) === 3);
const afterReloadMarks = await page.locator('mark.hl').count();
check('highlights re-anchor after a reload', afterReloadMarks === 2, `marks=${afterReloadMarks}`);
const noteText = await page
  .locator('.note-card')
  .filter({ hasText: 'fits a map' })
  .locator('textarea')
  .inputValue()
  .catch(() => '');
check('note survives the reload', noteText.includes('global receptive field'), `got "${noteText}"`);

console.log('\n== keyboard palette ==');
await page.keyboard.press('Control+k');
await page.waitForSelector('.palette');
check('command palette opens on ctrl/cmd-K', true);
await page.keyboard.press('Escape');

console.log('\n== settings ==');
await page.getByRole('button', { name: /^Settings$/ }).click();
await page.waitForSelector('.sheet');
check('settings sheet opens', await page.getByRole('heading', { name: 'Settings' }).isVisible());
check('Drive connect control present', await page.getByRole('button', { name: /Connect Drive/i }).isVisible());
check('client ID field present', await page.getByPlaceholder(/apps.googleusercontent.com/).isVisible());
await page.screenshot({ path: `${OUT}/settings.png` });
await page.getByRole('button', { name: 'Close settings' }).click();

console.log('\n== screenshots ==');
await page.screenshot({ path: `${OUT}/reader-light.png` });
await page.locator('.topbar button[aria-label="Switch to the dark theme"]').click();
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/reader-dark.png` });
await page.locator('.topbar button[aria-label="Switch to the light theme"]').click();
await page.locator('.library-panel .nav-item', { hasText: 'All papers' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/collection.png` });
if (!(await page.locator('.dock .discover-panel').isVisible())) {
  await page.getByRole('button', { name: 'Discover papers' }).click();
}
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/discover.png` });

console.log('\n== mobile ==');
const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
await stub(phoneContext);
const phone = await phoneContext.newPage();
await phone.goto(BASE, { waitUntil: 'networkidle' });
check('phone opens with no panel covering the page', await phone.getByRole('heading', { name: /Read papers/i }).isVisible());
await phone.screenshot({ path: `${OUT}/mobile.png` });
await phone.getByRole('button', { name: /Skip — keep everything local/i }).click();
await phone.getByRole('button', { name: 'Discover papers' }).click();
await phone.getByLabel('Search papers').fill('fourier');
await phone.getByLabel('Search papers').press('Enter');
await phone.waitForSelector('article.result');
await phone.locator('article.result h3').click();
await phone.getByRole('button', { name: /^Read$/ }).click();
await phone.waitForSelector('.paper-body p');
check('phone reader opens with the panel dismissed', (await phone.locator('.panel').count()) === 0);
await phone.screenshot({ path: `${OUT}/mobile-reader.png` });

await phone.evaluate(() => {
  const paragraph = document.querySelectorAll('.paper-body p')[2];
  const node = paragraph.firstChild;
  const start = node.data.indexOf('integral kernel');
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + 'integral kernel'.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 400 }));
});
await phone.waitForSelector('.lookup');
check('the lookup box falls back to tabs on a phone', await phone.locator('.lookup-tabs').isVisible());
check('one pane at a time on a phone', (await phone.locator('.lookup-pane:visible').count()) === 1);
check(
  'the box stays on screen',
  await phone.evaluate(() => {
    const box = document.querySelector('.lookup').getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1;
  }),
);
await phone.locator('.lookup-tabs button', { hasText: 'Comment' }).click();
check('the comment pane opens from the tabs', await phone.locator('#lookup-comment').isVisible());
await phone.screenshot({ path: `${OUT}/mobile-lookup.png` });

console.log('\n== a paper that is not on arXiv ==');
// The case this is really about: OpenAlex and Semantic Scholar give an
// abstract and a link to a PDF somewhere else. A fresh context so none of the
// state above is in the way.
const oaContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(oaContext);
const oaPage = await oaContext.newPage();
oaPage.on('pageerror', (error) => errors.push(String(error)));
await oaPage.goto(BASE, { waitUntil: 'networkidle' });
await oaPage.getByRole('button', { name: /Skip — keep everything local/i }).click();
await oaPage.locator('.chip', { hasText: 'OpenAlex' }).click();
await oaPage.locator('.chip', { hasText: 'arXiv' }).click();
await oaPage.getByLabel('Search papers').fill('operators between function spaces');
await oaPage.getByLabel('Search papers').press('Enter');
await oaPage.waitForSelector('article.result');
await oaPage.locator('article.result h3').click();
await oaPage.getByRole('button', { name: /Add to collection/i }).click();
await oaPage.getByRole('button', { name: /^Read$/ }).click();
await oaPage.waitForSelector('.pdf-pane iframe', { timeout: 10000 });
check('an OpenAlex paper opens on its PDF rather than the abstract', await oaPage.locator('.pdf-pane iframe').isVisible());
check(
  'its PDF is fetched through the proxy',
  (await oaPage.locator('.pdf-pane iframe').getAttribute('src'))?.startsWith('blob:'),
);
check(
  'the download button is there for it too',
  await oaPage.locator('.topbar button[aria-label="Download the PDF"]').isVisible(),
);
await oaPage.screenshot({ path: `${OUT}/pdf.png` });
await oaPage.locator('.segmented button', { hasText: 'Reflow' }).click();
await oaPage.waitForSelector('.paper-body');
check(
  'reflow still offers the abstract, with a way back to the PDF',
  await oaPage.locator('.banner.warn', { hasText: /Read the PDF instead/ }).isVisible(),
);

console.log('\n== console errors ==');
// Google Fonts and the GIS script are external; a sandbox that intercepts TLS
// fails them without anything being wrong with the app.
const real = errors.filter((message) => !/favicon|ERR_CERT_AUTHORITY_INVALID|ERR_INTERNET_DISCONNECTED|gsi\/client|accounts\.google|fonts\.googleapis/.test(message));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILURES (${problems.length}):\n- ${problems.join('\n- ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
