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

// A real one-page PDF, with a cross-reference table and text on the page, so
// that the browser's viewer actually renders it rather than showing an empty
// pane — the screenshot this test writes is only worth anything if it does.
// The proxy's own rules about what is a PDF are in scripts/pdf-proxy.test.mjs.
const PDF = (() => {
  const page = 'BT /F1 24 Tf 72 700 Td (Fourier Neural Operator) Tj ET\n' +
    'BT /F1 12 Tf 72 670 Td (A stand-in for the real paper.) Tj ET';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${page.length}>>stream\n${page}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj${object}endobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
})();

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

const CROSSREF = {
  message: {
    items: [
      {
        DOI: '10.1000/two',
        title: ['Theorie des operations lineaires'],
        author: [{ given: 'Stefan', family: 'Banach' }],
        issued: { 'date-parts': [[1932, 1, 1]] },
        'container-title': ['Monografie Matematyczne'],
        'is-referenced-by-count': 9001,
        URL: 'https://doi.org/10.1000/two',
      },
    ],
  },
};

const OPENALEX_AUTHORS = {
  results: [
    {
      id: 'https://openalex.org/A1',
      display_name: 'Stefan Banach',
      orcid: null,
      works_count: 58,
      cited_by_count: 41000,
      summary_stats: { h_index: 30 },
      last_known_institutions: [{ display_name: 'Lwow' }],
    },
  ],
};

/**
 * Leaves exactly one source chip switched on. Clicking each chip blind would
 * depend on what the defaults happen to be, which is a thing that changes.
 */
async function selectOnlySource(target, label) {
  const chips = target.locator('.discover-panel .chip');
  for (let index = 0; index < (await chips.count()); index += 1) {
    const chip = chips.nth(index);
    const wanted = ((await chip.textContent()) || '').trim() === label;
    const pressed = (await chip.getAttribute('aria-pressed')) === 'true';
    if (wanted !== pressed) await chip.click();
  }
}

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
  // Authors and works are different endpoints with different shapes. Playwright
  // gives priority to the most recently registered route, so this one has to be
  // registered after the catch-all above rather than before it.
  await target.route('**/api.openalex.org/authors*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OPENALEX_AUTHORS) }),
  );
  await target.route('**/api.crossref.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CROSSREF) }),
  );
  await target.route('**/api.semanticscholar.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
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
check('the Google button asks for both consents at once', await page.getByRole('button', { name: /Sign in and connect Google Drive/i }).first().isVisible());

await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

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
// One hit from each stubbed source, merged into a single ranked list.
check('search merges every source into one list', (await page.locator('article.result h3').count()) === 3);

const arxivResult = page.locator('article.result', { hasText: 'Fourier Neural Operator' });
check('the arXiv result is parsed', (await arxivResult.count()) === 1);
await arxivResult.locator('h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();

console.log('\n== pdf ==');
await page.waitForSelector('.pdf-pane iframe', { timeout: 10000 });
check('a paper opens on its PDF', await page.locator('.pdf-pane iframe').isVisible());
check(
  'the PDF comes from the proxy, not the publisher',
  (await page.locator('.pdf-pane iframe').getAttribute('src'))?.startsWith('blob:'),
);
const download = page.locator('.topbar button[aria-label="Download the PDF"]');
check('a download button sits next to the mode switch', await download.isVisible());
const saved = page.waitForEvent('download', { timeout: 10000 });
await download.click();
check('it saves the file under the paper\'s name', (await saved).suggestedFilename().endsWith('.pdf'));

console.log('\n== reflow ==');
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.paper-body p');
check('the switch brings back the reflowed full text', (await page.locator('.paper-body p').count()) === 3);

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
check(
  'it reopens in the mode you last chose, not the PDF',
  (await page.locator('.pdf-pane').count()) === 0,
);
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
await phone.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await phone.getByRole('button', { name: 'Discover papers' }).click();
await phone.getByLabel('Search papers').fill('fourier');
await phone.getByLabel('Search papers').press('Enter');
await phone.waitForSelector('article.result');
await phone.locator('article.result', { hasText: 'Fourier Neural Operator' }).locator('h3').click();
await phone.getByRole('button', { name: /^Read$/ }).click();
await phone.waitForSelector('.pdf-pane iframe', { timeout: 10000 });
check('the phone opens on the PDF too', await phone.locator('.pdf-pane iframe').isVisible());
await phone.locator('.segmented button', { hasText: 'Reflow' }).click();
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
await oaPage.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await selectOnlySource(oaPage, 'OpenAlex');
await oaPage.getByLabel('Search papers').fill('operators between function spaces');
await oaPage.getByLabel('Search papers').press('Enter');
await oaPage.waitForSelector('article.result');
await oaPage.locator('article.result', { hasText: 'On operators between function spaces' }).locator('h3').click();
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
// The viewer is a browser component inside the frame, and it paints a moment
// after the frame itself is there; without this the screenshot is of an empty
// pane and proves nothing.
await oaPage.waitForTimeout(2500);
await oaPage.screenshot({ path: `${OUT}/pdf.png` });
await oaPage.locator('.segmented button', { hasText: 'Reflow' }).click();
await oaPage.waitForSelector('.paper-body');
check(
  'reflow still offers the abstract, with a way back to the PDF',
  await oaPage.locator('.banner.warn', { hasText: /Read the PDF instead/ }).isVisible(),
);

console.log('\n== the copy in Drive ==');
// Once a paper has been synced, its PDF is in Drive — and Google, unlike arXiv
// and the publishers, answers the browser directly. So the reader should read
// it back from there rather than going through the proxy a second time.
const driveContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(driveContext);

// A stand-in for Google Identity Services that grants the drive.file scope, so
// the app's own Drive code runs for real with no network and no sign-in, plus
// a Drive of sorts: folders, uploads, and the file handed back on request.
// Returns the counters, which is what the checks below are actually about.
async function fakeDrive(context) {
  await context.addInitScript(() => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () =>
              setTimeout(
                () =>
                  config.callback({
                    access_token: 'smoke-token',
                    expires_in: 3600,
                    scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
                  }),
                0,
              ),
          }),
          revoke: (token, done) => done && done(),
        },
      },
    };
  });
  await context.route(/accounts\.google\.com\/gsi\/client/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );

  const drive = { uploads: 0, pdfUploads: 0, downloads: 0, uploadedBytes: 0 };
  await context.route(/googleapis\.com\//, (route) => {
    const request = route.request();
    const url = request.url();
    const json = (body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('fonts.googleapis.com')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (url.includes('/oauth2/v3/userinfo')) return json({ name: 'Smoke', email: 'smoke@example.com' });
    if (url.includes('/upload/drive/v3/files')) {
      drive.uploads += 1;
      const body = request.postData() || '';
      const isPdf = body.includes('application/pdf');
      if (isPdf) {
        drive.pdfUploads += 1;
        drive.uploadedBytes = body.length;
      }
      return json({
        id: isPdf ? 'drive-pdf-id' : 'drive-meta-id',
        name: 'file',
        webViewLink: 'https://drive.google.com/file/d/drive-pdf-id/view',
      });
    }
    if (url.includes('alt=media')) {
      drive.downloads += 1;
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
    }
    // A lookup is a GET with a q=; creating a folder is a POST.
    return request.method() === 'POST' ? json({ id: 'drive-folder-id' }) : json({ files: [] });
  });
  return drive;
}

const drive = await fakeDrive(driveContext);

// Count what the proxy is asked for, on top of the stub's own PDF route.
let proxyPdfHits = 0;
await driveContext.route('**/api/arxiv/pdf*', (route) => {
  proxyPdfHits += 1;
  return route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
});

const drivePage = await driveContext.newPage();
drivePage.on('pageerror', (error) => errors.push(String(error)));
await drivePage.goto(BASE, { waitUntil: 'networkidle' });
await drivePage.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

await drivePage.getByRole('button', { name: /^Settings$/ }).click();
await drivePage.getByPlaceholder(/apps.googleusercontent.com/).fill('smoke.apps.googleusercontent.com');
await drivePage.getByRole('button', { name: /Connect Drive/i }).click();
await drivePage.waitForTimeout(600);
await drivePage.getByRole('button', { name: 'Close settings' }).click();

await drivePage.getByLabel('Search papers').fill('fourier neural operator');
await drivePage.getByLabel('Search papers').press('Enter');
await drivePage.waitForSelector('article.result');
// Search now merges several sources, so be explicit about which result: the
// arXiv one, whose PDF goes through the route this section counts.
await drivePage.locator('article.result h3').first().click();
await drivePage.getByRole('button', { name: /Add to collection/i }).click();
await drivePage.waitForTimeout(2500);
check('adding a paper puts its PDF and sidecar in Drive', drive.uploads >= 2, `uploads=${drive.uploads}`);
const proxyHitsBeforeRead = proxyPdfHits;

await drivePage.getByRole('button', { name: /^Read$/ }).click();
await drivePage.waitForSelector('.pdf-pane iframe', { timeout: 10000 });
await drivePage.waitForTimeout(1500);
check('opening it reads the copy in Drive', drive.downloads >= 1, `downloads=${drive.downloads}`);
check(
  'and does not fetch it through the proxy again',
  proxyPdfHits === proxyHitsBeforeRead,
  `proxy ${proxyHitsBeforeRead} -> ${proxyPdfHits}`,
);
check(
  'the reader says the file came from Drive',
  await drivePage.locator('.topbar .sub', { hasText: /PDF from your Drive/ }).isVisible(),
);
await drivePage.screenshot({ path: `${OUT}/drive.png` });

console.log('\n== a paper collected before Drive was connected ==');
// The case adding-time sync cannot cover: the paper is already in the library
// when Drive is connected, so nothing has ever uploaded it. Opening it should,
// with the copy the viewer fetched rather than a second trip to the publisher.
const lateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(lateContext);
const lateDrive = await fakeDrive(lateContext);

let latePdfHits = 0;
await lateContext.route('**/api/arxiv/pdf*', (route) => {
  latePdfHits += 1;
  return route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
});

const latePage = await lateContext.newPage();
latePage.on('pageerror', (error) => errors.push(String(error)));
await latePage.goto(BASE, { waitUntil: 'networkidle' });
await latePage.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

await latePage.getByLabel('Search papers').fill('fourier neural operator');
await latePage.getByLabel('Search papers').press('Enter');
await latePage.waitForSelector('article.result');
await latePage.locator('article.result h3').first().click();
await latePage.getByRole('button', { name: /Add to collection/i }).click();
await latePage.waitForTimeout(800);
check('nothing is uploaded while Drive is not connected', lateDrive.uploads === 0, `uploads=${lateDrive.uploads}`);

await latePage.getByRole('button', { name: /^Settings$/ }).click();
await latePage.getByPlaceholder(/apps.googleusercontent.com/).fill('smoke.apps.googleusercontent.com');
await latePage.getByRole('button', { name: /Connect Drive/i }).click();
await latePage.waitForTimeout(600);
await latePage.getByRole('button', { name: 'Close settings' }).click();

await latePage.getByRole('button', { name: /^Read$/ }).click();
await latePage.waitForSelector('.pdf-pane iframe', { timeout: 10000 });
await latePage.waitForTimeout(2500);
check('opening it puts the PDF in Drive', lateDrive.pdfUploads === 1, `pdf uploads=${lateDrive.pdfUploads}`);
check('and the sidecar with it', lateDrive.uploads >= 2, `uploads=${lateDrive.uploads}`);
check(
  'the file uploaded is the one on screen, fetched once',
  latePdfHits === 1,
  `proxy pdf fetches=${latePdfHits}`,
);
check(
  'and the top bar links to it in Drive',
  await latePage.locator('.topbar a[href*="drive.google.com"]').isVisible(),
);
await latePage.screenshot({ path: `${OUT}/drive-on-open.png` });
console.log('\n== the connect screen ==');
// The page holds no refresh token — there is no backend to hold one — so a
// visit always starts disconnected, and the app puts the Drive connection in
// front of itself until it is made. This context has connected nothing yet but
// has seen the introduction, which is how a returning reader arrives.
const gateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(gateContext);
await fakeDrive(gateContext);
await gateContext.addInitScript(() => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.settings', JSON.stringify({ googleClientId: 'smoke.apps.googleusercontent.com' }));
});
// What Google is asked for, in the order it is asked.
await gateContext.addInitScript(() => {
  window.__prompts = [];
  const oauth = window.google.accounts.oauth2;
  const initTokenClient = oauth.initTokenClient;
  oauth.initTokenClient = (config) => {
    window.__prompts.push({ prompt: config.prompt, scope: config.scope });
    return initTokenClient(config);
  };
});

const gatePage = await gateContext.newPage();
gatePage.on('pageerror', (error) => errors.push(String(error)));
await gatePage.goto(BASE, { waitUntil: 'networkidle' });
check(
  'a visit with Drive unconnected is asked to connect first',
  await gatePage.getByRole('heading', { name: /Read papers, keep what matters/i }).isVisible(),
);
check('and the app is not yet behind it', (await gatePage.locator('.discover-panel').count()) === 0);
await gatePage.screenshot({ path: `${OUT}/connect-screen.png` });

await gatePage.getByRole('button', { name: /Sign in and connect Google Drive/i }).click();
await gatePage.waitForSelector('.discover-panel', { timeout: 10000 });
check('connecting from it opens the app, with no second click', true);
const firstAsk = (await gatePage.evaluate(() => window.__prompts)).at(-1);
check('one consent covers identity and Drive', /drive\.file$/.test(firstAsk.scope), firstAsk.scope);

await gatePage.reload({ waitUntil: 'networkidle' });
check(
  'the next visit is asked to reconnect, not introduced again',
  await gatePage.getByRole('heading', { name: /Reconnect your Drive/i }).isVisible(),
);
await gatePage.screenshot({ path: `${OUT}/reconnect-screen.png` });
await gatePage.getByRole('button', { name: /Reconnect Google Drive/i }).click();
await gatePage.waitForSelector('.discover-panel', { timeout: 10000 });
const secondAsk = (await gatePage.evaluate(() => window.__prompts)).at(-1);
check(
  'and a grant already given is reused rather than asked for again',
  secondAsk.prompt === '',
  `prompt="${secondAsk.prompt}"`,
);

console.log('\n== authors ==');
// A fresh context, so the author run starts from the same blank slate the
// reading run did rather than from whatever it left in localStorage.
const peopleContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(peopleContext);
const peoplePage = await peopleContext.newPage();
peoplePage.on('pageerror', (error) => errors.push(String(error)));
await peoplePage.goto(BASE, { waitUntil: 'networkidle' });
await peoplePage.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await peoplePage.waitForSelector('.discover-panel');
await peoplePage.getByRole('button', { name: 'Authors', exact: true }).click();
await peoplePage.getByLabel('Search for a person').fill('Banach');
await peoplePage.getByLabel('Search for a person').press('Enter');
await peoplePage.waitForSelector('article.result');
const person = peoplePage.locator('article.result', { hasText: 'Stefan Banach' });
check('author search finds the person', (await person.count()) === 1);
check(
  'and says what is known about them',
  ((await person.textContent()) || '').includes('41k citations'),
  (await person.textContent()) || '',
);
await person.locator('h3').click();
// The "Papers by" header renders as soon as the person is picked, so waiting
// on it alone would race the request that fetches what they wrote.
await peoplePage.waitForSelector('text=Papers by');
await peoplePage.waitForSelector('article.result', { timeout: 10000 });
check(
  'opening a person lists their papers',
  await peoplePage.locator('article.result', { hasText: 'On operators between function spaces' }).isVisible(),
);
await peoplePage.screenshot({ path: `${OUT}/authors.png` });

console.log('\n== console errors ==');
// Google Fonts and the GIS script are external; a sandbox that intercepts TLS
// fails them without anything being wrong with the app.
const real = errors.filter((message) => !/favicon|ERR_CERT_AUTHORITY_INVALID|ERR_INTERNET_DISCONNECTED|gsi\/client|accounts\.google|fonts\.googleapis/.test(message));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILURES (${problems.length}):\n- ${problems.join('\n- ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
