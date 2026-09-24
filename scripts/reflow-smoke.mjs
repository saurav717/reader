/**
 * Reflow mode, read out of a PDF. The proxy is stubbed to hand the reader a
 * paper printed by Chromium itself — two columns, a figure, two tables, a
 * numbered equation, a list, footnote and references — and the test checks
 * that what comes back is that paper: the sections in order, the figure
 * and the equation painted from the page, the tables as tables, the text
 * highlightable.
 *
 *   npm run build && npm start &
 *   node scripts/reflow-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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
  <entry>
    <id>http://arxiv.org/abs/1901.00001v1</id>
    <published>2019-01-01T00:00:00Z</published>
    <title>A Scanned Paper With No Text Layer</title>
    <summary>Pages of pixels and nothing else.</summary>
    <author><name>A. Scanner</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/1901.00001v1"/>
    <category term="cs.DL"/>
  </entry>
</feed>`;

const sentences = [
  'Neural operators learn mappings between function spaces, so one trained model answers a whole family of parametric problems.',
  'The classical solver discretises the domain and then solves for one instance of the coefficients, which is expensive when many instances are needed.',
  'We parameterise the integral kernel directly in Fourier space and truncate the higher modes, which keeps the cost quasi-linear in the resolution.',
  'Experiments on Burgers, Darcy flow and Navier-Stokes show a consistent advantage over convolutional baselines at every resolution we tried.',
];
const prose = (count, from = 0) => Array.from({ length: count }, (_, index) => sentences[(from + index) % sentences.length]).join(' ');

/** The paper, as HTML for Chromium to print: what a LaTeX two-column class would produce. */
const PAPER = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: letter; margin: 0.75in 0.6in; }
body { font-family: 'Liberation Serif', 'Times New Roman', serif; font-size: 10pt; line-height: 1.2; column-count: 2; column-gap: 0.25in; text-align: justify; }
h1.title { column-span: all; text-align: center; font-size: 17pt; margin: 0 0 6pt; }
p.authors { column-span: all; text-align: center; font-size: 11pt; margin: 0 0 4pt; }
p.affil { column-span: all; text-align: center; font-size: 9pt; margin: 0 0 14pt; }
h2 { font-size: 12pt; margin: 10pt 0 4pt; }
h3 { font-size: 10.5pt; margin: 8pt 0 3pt; }
p { margin: 0; text-indent: 1em; }
p.first { text-indent: 0; }
figure { margin: 8pt 0; break-inside: avoid; }
figcaption { font-size: 9pt; margin-top: 4pt; }
table { border-collapse: collapse; font-size: 9pt; width: 100%; }
table.ruled th, table.ruled td { border-top: 0.5pt solid #000; border-bottom: 0.5pt solid #000; padding: 2pt 4pt; }
table.plain th, table.plain td { padding: 2pt 6pt; }
.eq { text-align: center; margin: 6pt 0; font-style: italic; }
.eqno { float: right; font-style: normal; }
ul { margin: 4pt 0 4pt 12pt; padding: 0; }
.fn { font-size: 8pt; }
.ref { font-size: 9pt; text-indent: -1.2em; padding-left: 1.2em; }
</style></head><body>
<h1 class="title">Fourier Neural Operator for Parametric Partial Differential Equations</h1>
<p class="authors">Zongyi Li, Nikola Kovachki, Kamyar Azizzadenesheli</p>
<p class="affil">California Institute of Technology</p>
<h2>Abstract</h2>
<p class="first">${prose(3)}</p>
<h2>1 Introduction</h2>
<p class="first">${prose(4)} A self-supervised objective<sup>1</sup> helps.</p>
<p>${prose(3, 1)} We call this the na&iuml;ve approach, after Li <i>et al</i> [1].</p>
<figure><svg width="220" height="110" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="200" height="80" fill="none" stroke="#000"/><polyline points="20,80 60,40 100,60 140,20 200,30" fill="none" stroke="#c00" stroke-width="2"/><text x="90" y="105" font-size="8">resolution</text></svg><figcaption><b>Figure 1:</b> Relative error against resolution for the Fourier neural operator and a convolutional baseline.</figcaption></figure>
<p class="first">${prose(2, 2)}</p>
<ul><li>an integral operator with a learned kernel,</li><li>a pointwise nonlinearity between layers, and</li><li>a truncation of the Fourier modes.</li></ul>
<p class="first">${prose(5, 3)}</p>
<h2>2 Method</h2>
<p class="first">The layer maps an input function v to</p>
<div class="eq">(K v)(x) = F<sup>−1</sup>(R · F v)(x) + W v(x) <span class="eqno">(1)</span></div>
<p class="first">where R is the learned weight tensor. ${prose(2)}</p>
<h3>2.1 Discretisation</h3>
<p class="first">${prose(4, 1)}</p>
<figure><figcaption><b>Table 1:</b> Relative test error on Darcy flow at three resolutions.</figcaption><table class="ruled"><tr><th>Method</th><th>s = 85</th><th>s = 141</th><th>s = 211</th></tr><tr><td>FNO</td><td>0.0108</td><td>0.0109</td><td>0.0109</td></tr><tr><td>UNet</td><td>0.0212</td><td>0.0338</td><td>0.0398</td></tr><tr><td>TF-Net</td><td>0.0247</td><td>0.0271</td><td>0.0327</td></tr></table></figure>
<p class="first">${prose(4, 2)}</p>
<h2>3 Experiments</h2>
<p class="first">${prose(3, 3)}</p>
<figure><figcaption><b>Table 2:</b> Training cost, in seconds per epoch.</figcaption><table class="plain"><tr><th>Model</th><th>Epoch</th><th>Params</th></tr><tr><td>FNO-2d</td><td>32</td><td>0.4M</td></tr><tr><td>ResNet</td><td>41</td><td>1.1M</td></tr><tr><td>DeepONet</td><td>58</td><td>2.3M</td></tr></table></figure>
<p class="first">${prose(6)}</p>
<h2>4 Conclusion</h2>
<p class="first">${prose(3, 1)}</p>
<p class="fn"><sup>1</sup> The objective is defined over the whole trajectory.</p>
<h2>References</h2>
<p class="ref">[1] Z. Li et al. Neural operator: graph kernel network for partial differential equations. arXiv:2003.03485, 2020.</p>
<p class="ref">[2] L. Lu, P. Jin, and G. E. Karniadakis. DeepONet: learning nonlinear operators. arXiv:1910.03193, 2019.</p>
</body></html>`;

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print the paper ==');
const printer = await browser.newPage();
await printer.setContent(PAPER);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();
check('Chromium printed a PDF', PDF.length > 10000 && PDF.subarray(0, 4).toString() === '%PDF', `${PDF.length} bytes`);

/** The proxy and the indexes, stubbed: the printed paper is the only PDF, and there is no HTML rendering. */
async function stub(target, pdf) {
  await target.route('**/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
  // No HTML rendering: the PDF is the only full text there is.
  await target.route('**/arxiv/html*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
  await target.route('**/arxiv/pdf*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }));
  await target.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }));
  await target.route('**/api.openalex.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
  await target.route('**/api.crossref.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":{"items":[]}}' }));
  await target.route('**/api.semanticscholar.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
  await target.route('**/scholar/*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(context, PDF);

/** Leaves exactly one source chip switched on, whatever the defaults are. */
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
  if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`);
});
process.on('uncaughtException', (error) => {
  console.log(`\ncrashed: ${error.message}\nconsole: ${errors.join('\n  ')}`);
  process.exit(1);
});

console.log('\n== open the paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await selectOnlySource(page, 'arXiv');
await page.getByLabel('Search papers').fill('fourier neural operator');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result', { hasText: 'Fourier Neural Operator' }).locator('h3').click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.waitForSelector('.pdf-pane iframe', { timeout: 15000 });
check('the paper opens on its PDF', await page.locator('.pdf-pane iframe').isVisible());

console.log('\n== reflow ==');
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForFunction(() => Array.from(document.querySelectorAll('.paper-body img')).every((image) => image.complete && image.naturalWidth > 0), null, { timeout: 15000 }).catch(() => {});
check('the line under the title says the text came from the PDF', ((await page.locator('.topbar .sub').textContent()) || '').includes('Reflowed from the PDF'));
check('no notice about falling back', (await page.locator('.reader-column .banner').count()) === 0, (await page.locator('.reader-column .banner').textContent().catch(() => '')) || '');

const headings = await page.locator('.paper-body h2, .paper-body h3').allTextContents();
check(
  'the sections come out in order',
  JSON.stringify(headings) === JSON.stringify(['Abstract', '1 Introduction', '2 Method', '2.1 Discretisation', '3 Experiments', '4 Conclusion', 'References']),
  JSON.stringify(headings),
);
check('the title and authors are not repeated in the body', !(await page.locator('.paper-body').textContent())?.includes('Kamyar'));

const paragraphs = await page.locator('.paper-body > p').allTextContents();
check('the lines of a paragraph are joined back together', paragraphs.some((text) => text.includes('quasi-linear in the resolution. Experiments on Burgers')));
check('the two columns are read in order', paragraphs.some((text) => text.startsWith('where R is the learned weight tensor')));
check('an accent set apart from its letter is put back', paragraphs.some((text) => text.includes('naïve')));
check('a footnote mark becomes a superscript', (await page.locator('.paper-body p sup', { hasText: '1' }).count()) >= 1);

const figure = page.locator('.paper-body figure.pdf-figure');
check('the figure is painted from the page', (await figure.count()) === 1);
check('with its caption under it', ((await figure.locator('figcaption').textContent()) || '').startsWith('Figure 1: Relative error against resolution'));
check(
  'as an image with its pixels',
  await figure
    .locator('img')
    .evaluate((image) => image.complete && image.naturalWidth > 100 && image.naturalHeight > 50 && image.src.startsWith('blob:'))
    .catch(() => false),
);
check('the axis label lives in the picture, not the text', !paragraphs.some((text) => /^resolution$/.test(text.trim())));

const tables = page.locator('.paper-body figure.pdf-table table');
check('both tables are tables', (await tables.count()) === 2);
const ruled = await tables.nth(0).locator('tr').evaluateAll((rows) => rows.map((row) => Array.from(row.cells).map((cell) => cell.textContent)));
check(
  'the ruled table has its rows and cells',
  JSON.stringify(ruled) === JSON.stringify([['Method', 's = 85', 's = 141', 's = 211'], ['FNO', '0.0108', '0.0109', '0.0109'], ['UNet', '0.0212', '0.0338', '0.0398'], ['TF-Net', '0.0247', '0.0271', '0.0327']]),
  JSON.stringify(ruled),
);
const plain = await tables.nth(1).locator('tr').evaluateAll((rows) => rows.map((row) => Array.from(row.cells).map((cell) => cell.textContent)));
check('so does the one set without rules', JSON.stringify(plain) === JSON.stringify([['Model', 'Epoch', 'Params'], ['FNO-2d', '32', '0.4M'], ['ResNet', '41', '1.1M'], ['DeepONet', '58', '2.3M']]), JSON.stringify(plain));

check('the numbered equation is painted, in its place', (await page.locator('.paper-body .pdf-equation img').count()) === 1);
check(
  'between the sentence before it and the one after',
  await page.evaluate(() => {
    const equation = document.querySelector('.paper-body .pdf-equation');
    return Boolean(
      equation?.previousElementSibling?.textContent?.includes('maps an input function') &&
        equation?.nextElementSibling?.textContent?.startsWith('where R is the learned'),
    );
  }),
);
check('the list is a list', (await page.locator('.paper-body ul li').allTextContents()).join('|') === 'an integral operator with a learned kernel,|a pointwise nonlinearity between layers, and|a truncation of the Fourier modes.');
check('the references are one entry each', (await page.locator('.paper-body p', { hasText: /^\[2\] L\. Lu/ }).count()) === 1);

console.log('\n== citations ==');
const cite = page.locator('.paper-body .cite[tabindex]').first();
check('a citation set across two faces is marked whole', (await page.locator('.paper-body .cite[data-cite="0"]').allTextContents()).join('') === 'Li et al [1]');
await cite.scrollIntoViewIfNeeded();
await cite.hover();
await page.waitForSelector('.hover-card .hc-printed', { timeout: 5000 });
check('hovering over it shows the entry', ((await page.locator('.hover-card .hc-printed').textContent()) || '').includes('Neural operator'));
await page.locator('.hover-card .hc-note').waitFor({ timeout: 10000 }).catch(() => {});
await page.locator('.hover-card .hc-printed').click();
await page.waitForFunction(() => (document.querySelector('input[aria-label="Search papers"]')?.value || '').length > 0, null, { timeout: 5000 }).catch(() => {});
check('pressing the card looks the paper up in Discover', (await page.getByLabel('Search papers').inputValue()).startsWith('Neural operator: graph kernel network'), await page.getByLabel('Search papers').inputValue());
await page.screenshot({ path: `${OUT}/reflow-pdf.png`, fullPage: false });
await figure.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/reflow-figure.png` });
await page.locator('.paper-body .pdf-equation').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/reflow-equation.png` });
await tables.nth(0).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/reflow-table.png` });

console.log('\n== highlight ==');
await page.locator('.reader-scroll').evaluate((element) => element.scrollTo(0, 0));
await page.evaluate(() => {
  const paragraph = Array.from(document.querySelectorAll('.paper-body p')).find((element) => element.textContent?.includes('quasi-linear'));
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.data.includes('quasi-linear')) node = walker.nextNode();
  const start = node.data.indexOf('keeps the cost quasi-linear');
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + 'keeps the cost quasi-linear'.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await page.waitForSelector('.selection-toolbar');
// The toolbar sits where the selection was made, which after the
// screenshots' scrolling can be off-screen; the click itself is the test.
await page.locator('.selection-toolbar button').first().evaluate((button) => button.click());
await page.waitForSelector('mark.hl');
check('a highlight paints over the reflowed text', (await page.locator('mark.hl').first().textContent()) === 'keeps the cost quasi-linear');
check('and is filed under its section', ((await page.locator('.notes-rail .eyebrow').first().textContent()) || '').includes('Abstract'));

console.log('\n== reload ==');
await page.reload({ waitUntil: 'networkidle' });
const gate = page.getByRole('button', { name: /Start reading|Not now — keep everything in this browser/i }).first();
if (await gate.isVisible().catch(() => false)) await gate.click();
await page.waitForSelector('.paper-body figure.pdf-figure img', { timeout: 30000 });
check('the paper reopens reflowed from the PDF', (await page.locator('.paper-body figure.pdf-table table').count()) === 2);
check('the highlight re-anchors', (await page.locator('mark.hl').count()) === 1);
await page.locator('.topbar button[aria-label="Switch to the dark theme"]').click();
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/reflow-pdf-dark.png` });

console.log('\n== a PDF with nothing to read ==');
// A scan: pixels and no text. The reader says so and shows what it has.
const blank = await browser.newPage();
await blank.setContent('<body style="margin:0"><div style="width:612pt;height:792pt;background:#eee"></div></body>');
const SCAN = await blank.pdf({ format: 'Letter', printBackground: true });
await blank.close();
await context.route('**/arxiv/pdf*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/pdf', body: route.request().url().includes('1901.00001') ? SCAN : PDF }),
);
await page.getByRole('button', { name: /Back to the collection/i }).click();
if (!(await page.locator('.dock .discover-panel').isVisible().catch(() => false))) {
  await page.getByRole('button', { name: 'Discover papers' }).click();
}
await selectOnlySource(page, 'arXiv');
await page.getByLabel('Search papers').fill('scanned paper');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result', { hasText: 'A Scanned Paper' }).locator('h3').click();
// Read alone adds the paper and opens it.
await page.getByRole('button', { name: /^Read$/ }).click();
// Nothing to reflow, so the reader turns to the PDF itself — the viewer
// shows a scan fine — and says why when the text is asked for anyway.
await page.waitForSelector('.pdf-pane iframe', { timeout: 30000 });
check('a scan opens on the PDF instead', await page.locator('.pdf-pane iframe').isVisible());
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.reader-column .banner', { timeout: 30000 });
check('and Reflow says why there is no text', ((await page.locator('.reader-column .banner').textContent()) || '').includes('no text that can be read'));

console.log('\n== without a worker ==');
// A host that will not serve the worker script — or a browser that will
// not start one — leaves pdf.js to read on the main thread, and the paper
// must come out the same.
const noWorker = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(noWorker, PDF);
await noWorker.route('**/assets/pdf.worker*', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }));
const bare = await noWorker.newPage();
const bareWarnings = [];
bare.on('console', (message) => message.type() === 'warning' && bareWarnings.push(message.text()));
await bare.goto(BASE, { waitUntil: 'networkidle' });
await bare.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await selectOnlySource(bare, 'arXiv');
await bare.getByLabel('Search papers').fill('fourier neural operator');
await bare.getByLabel('Search papers').press('Enter');
await bare.waitForSelector('article.result');
await bare.locator('article.result', { hasText: 'Fourier Neural Operator' }).locator('h3').click();
await bare.getByRole('button', { name: /^Read$/ }).click();
await bare.waitForSelector('.pdf-pane iframe', { timeout: 15000 });
await bare.locator('.segmented button', { hasText: 'Reflow' }).click();
await bare.waitForSelector('.paper-body h2', { timeout: 60000 });
check('the paper is still read, on the main thread', (await bare.locator('.paper-body figure.pdf-table table').count()) === 2 && (await bare.locator('.paper-body figure.pdf-figure img').count()) === 1);
check('and the console says why', bareWarnings.some((text) => text.includes('main thread')), bareWarnings.join(' | '));
await noWorker.close();

const real = errors.filter((error) => !/favicon|net::ERR_|Failed to load resource/.test(error));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
