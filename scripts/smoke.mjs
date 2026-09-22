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

console.log('\n== search and add ==');
await page.getByRole('button', { name: 'Discover papers' }).click();
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
check('notes rail lists the highlight', (await page.locator('.note-card').count()) === 1);
check('notes rail groups by section', (await page.locator('.notes-rail .eyebrow').first().textContent())?.includes('2 Learning operators'));

console.log('\n== note ==');
await page.locator('.note-card .quote').click();
await page.locator('.note-card textarea').fill('Is the win from the FFT or the global receptive field?');
await page.waitForTimeout(300);

console.log('\n== persistence and re-anchoring ==');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.paper-body p', { timeout: 10000 }).catch(() => {});
check('reader reopens on the paper you were reading', (await page.locator('.paper-body p').count()) === 3);
const afterReloadMarks = await page.locator('mark.hl').count();
check('highlight re-anchors after a reload', afterReloadMarks === 1, `marks=${afterReloadMarks}`);
const noteText = await page.locator('.note-card textarea').first().inputValue().catch(() => '');
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
await page.getByRole('button', { name: 'Library' }).click();
await page.locator('.nav-item', { hasText: 'All papers' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/collection.png` });
await page.getByRole('button', { name: 'Discover papers' }).click();
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

console.log('\n== console errors ==');
// Google Fonts and the GIS script are external; a sandbox that intercepts TLS
// fails them without anything being wrong with the app.
const real = errors.filter((message) => !/favicon|ERR_CERT_AUTHORITY_INVALID|ERR_INTERNET_DISCONNECTED|gsi\/client|accounts\.google|fonts\.googleapis/.test(message));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILURES (${problems.length}):\n- ${problems.join('\n- ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
