// Reflow mode on a long paper: the column scrolls, and the book view pages it.
// Needs a server on BASE (`npm run build && npm start`). Writes screenshots to .smoke/.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2503.07137v1</id>
    <published>2025-03-10T00:00:00Z</published>
    <title>A Comprehensive Survey of Mixture-of-Experts: Algorithms, Theory, and Applications</title>
    <summary>Mixture of Experts models dynamically select the most relevant sub-models to process input data.</summary>
    <author><name>Siyuan Mu</name></author>
    <author><name>Sen Lin</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2503.07137v1"/>
    <category term="cs.LG"/>
  </entry>
</feed>`;

// The shape arXiv's LaTeXML rendering has: a title block with a "thanks"
// note, an abstract, numbered sections, an equation table, a figure, a
// tabular with rules, footnotes and a bibliography.
const paragraph = (n) =>
  `<div class="ltx_para"><p class="ltx_p">Paragraph ${n}. Mixture of Experts models route each token to a small number of experts, so that the capacity of the network grows without the cost of every forward pass growing with it. The gate is trained jointly with the experts, and a load-balancing loss keeps any single expert from taking every token.<span class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">${n}</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">${n}</sup><span class="ltx_note_type">footnote: </span>A footnote to paragraph ${n}.</span></span></span></p></div>`;
const section = (n) =>
  `<section class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">${n} </span>Section ${n}</h2>${[1, 2, 3, 4, 5].map((k) => paragraph(`${n}.${k}`)).join('')}
  <table class="ltx_equation ltx_eqn_table"><tbody><tr class="ltx_equation ltx_eqn_row">
    <td class="ltx_eqn_cell ltx_eqn_center_padleft"></td>
    <td class="ltx_eqn_cell ltx_align_center"><math display="block"><mi>y</mi><mo>=</mo><munder><mo>∑</mo><mi>i</mi></munder><msub><mi>g</mi><mi>i</mi></msub><mo>(</mo><mi>x</mi><mo>)</mo><msub><mi>E</mi><mi>i</mi></msub><mo>(</mo><mi>x</mi><mo>)</mo></math></td>
    <td class="ltx_eqn_cell ltx_eqn_center_padright"></td>
    <td class="ltx_eqn_cell ltx_eqn_eqno ltx_align_right" rowspan="1"><span class="ltx_tag ltx_tag_equation">(${n})</span></td>
  </tr></tbody></table>
  <figure class="ltx_table"><figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table ${n}: </span>Experts and their cost.</figcaption>
    <table class="ltx_tabular ltx_align_middle"><tbody>
      <tr><th class="ltx_td ltx_border_tt">Model</th><th class="ltx_td ltx_border_tt">Experts</th></tr>
      <tr><td class="ltx_td ltx_border_t">Switch</td><td class="ltx_td ltx_border_t">128</td></tr>
      <tr><td class="ltx_td ltx_border_bb">GShard</td><td class="ltx_td ltx_border_bb">2048</td></tr>
    </tbody></table></figure></section>`;

const ARTICLE = {
  source: 'arxiv',
  base: 'https://arxiv.org/html/2503.07137',
  html: `<html><body><div class="ltx_page_content"><article class="ltx_document">
    <h1 class="ltx_title ltx_title_document">A Comprehensive Survey of Mixture-of-Experts</h1>
    <div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Siyuan Mu</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Sen Lin <span class="ltx_note ltx_role_thanks"><sup class="ltx_note_mark">†</sup><span class="ltx_note_outer"><span class="ltx_note_content"><span class="ltx_note_type">thanks: </span>The work was done at the University of Houston.</span></span></span></span></span></div>
    <div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6><p class="ltx_p">Artificial intelligence has achieved astonishing successes in many domains, especially with the recent breakthroughs in the development of foundational large models.</p></div>
    ${[1, 2, 3, 4, 5, 6, 7, 8].map(section).join('')}
    <section class="ltx_bibliography"><h2 class="ltx_title ltx_title_bibliography">References</h2><ul class="ltx_biblist">
      ${[1, 2, 3, 4, 5, 6].map((n) => `<li class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">[${n}]</span><span class="ltx_bibblock">N. Author. A paper about experts, number ${n}.</span><span class="ltx_bibblock">Journal of Things, 2024.</span></li>`).join('')}
    </ul></section>
  </article></div></body></html>`,
};

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function run(viewport, name) {
  console.log(`\n== ${name} (${viewport.width}×${viewport.height}) ==`);
  const context = await browser.newContext({ viewport });
  await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
  await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ARTICLE) }));
  // No PDF anywhere, so Reflow is arXiv's HTML — the case in the bug report.
  for (const pattern of ['**/api/arxiv/pdf*', '**/api/pdf*', '**/api/locate*', '**/api.openalex.org/**', '**/api.crossref.org/**', '**/api.semanticscholar.org/**', '**/api.unpaywall.org/**']) {
    await context.route(pattern, (route) => route.fulfill({ status: 404, body: '' }));
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
  if (!(await page.getByLabel('Search papers').isVisible())) await page.getByRole('button', { name: 'Discover papers' }).click();
  const chips = page.locator('.discover-panel .chip');
  for (let index = 0; index < (await chips.count()); index += 1) {
    const chip = chips.nth(index);
    const wanted = ((await chip.textContent()) || '').trim() === 'arXiv';
    if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
  }
  await page.getByLabel('Search papers').fill('mixture of experts survey');
  await page.getByLabel('Search papers').press('Enter');
  await page.waitForSelector('article.result');
  await page.locator('article.result').first().locator('h3').click();
  await page.getByRole('button', { name: /^Read$/ }).click();
  // On a narrow screen the side panels sit over the reader; shut them to read.
  if (await page.locator('.library-panel').isVisible()) await page.getByRole('button', { name: 'Library', exact: true }).click();
  if (await page.locator('.dock').isVisible()) await page.getByRole('button', { name: 'Discover papers' }).click();
  // The PDF is tried first and fails; then Reflow is arXiv's HTML.
  await page.getByRole('button', { name: 'Read the text instead' }).click({ timeout: 30000 });
  await page.waitForSelector('.paper-body .ltx_section', { timeout: 20000 });

  const scroll = await page.evaluate(() => {
    const element = document.querySelector('.reader-scroll');
    const before = element.scrollTop;
    element.scrollBy(0, 1500);
    return { client: element.clientHeight, scrollHeight: element.scrollHeight, before, after: element.scrollTop };
  });
  check('the reflowed paper is shorter on screen than it is long', scroll.client < scroll.scrollHeight, JSON.stringify(scroll));
  check('and it scrolls', scroll.after > scroll.before);
  check('the reading column fits in the window', scroll.client <= viewport.height);
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(200);
  check('the mouse wheel scrolls it too', (await page.evaluate(() => document.querySelector('.reader-scroll').scrollTop)) > scroll.after);
  check('the duplicate title from arXiv is hidden', !(await page.locator('.paper-body .ltx_title_document').isVisible()));
  check('equations have no table grid', (await page.evaluate(() => getComputedStyle(document.querySelector('.ltx_eqn_cell')).borderTopStyle)) === 'none');
  await page.evaluate(() => document.querySelector('.reader-scroll').scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/${name}-scroll.png` });

  await page.getByRole('button', { name: /Read as a book/ }).click();
  await page.waitForSelector('.book-pages');
  await page.waitForTimeout(300);
  const folio = () => page.locator('.book-folio').textContent();
  const first = await folio();
  const two = await page.locator('.book-spread.two').count();
  const landscape = viewport.width > viewport.height;
  check(landscape ? 'two pages side by side' : 'one tall page on an upright screen', landscape ? two === 1 : two === 0, first);
  check('the book has more than one spread', /of (\d+)/.test(first) && Number(first.match(/of (\d+)/)[1]) > 2, first);
  const fits = await page.evaluate(() => {
    const pages = document.querySelector('.book-pages');
    return pages.getBoundingClientRect().bottom <= window.innerHeight && pages.scrollHeight <= pages.clientHeight + 1;
  });
  check('the pages fit the window, no vertical overflow', fits);
  await page.screenshot({ path: `${OUT}/${name}-book-1.png` });

  await page.keyboard.press('ArrowRight');
  const second = await folio();
  check('the right arrow turns the page', second !== first, `${first} → ${second}`);
  const offset = await page.evaluate(() => document.querySelector('.book-pages').scrollLeft);
  check('and the columns move along by a spread', offset > 0, String(offset));
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.screenshot({ path: `${OUT}/${name}-book-3.png` });
  await page.getByRole('button', { name: 'Previous page' }).click();
  check('the buttons turn it back and forth', (await folio()) !== second);
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  const beforeWheel = await folio();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(100);
  check('the wheel turns a page', (await folio()) !== beforeWheel);
  await page.keyboard.press('End');
  const lastFolio = await folio();
  check('End goes to the last page', /–?(\d+) of \1$/.test(lastFolio) || lastFolio.endsWith(`of ${lastFolio.match(/of (\d+)/)[1]}`), lastFolio);
  await page.screenshot({ path: `${OUT}/${name}-book-last.png` });
  check('the bibliography is on the last pages', await page.evaluate(() => {
    const pages = document.querySelector('.book-pages');
    const item = [...document.querySelectorAll('.ltx_bibitem')].pop();
    const a = pages.getBoundingClientRect();
    const b = item.getBoundingClientRect();
    return b.left >= a.left - 1 && b.right <= a.right + 1;
  }));

  // Highlighting works the same in the book.
  await page.keyboard.press('Home');
  await page.evaluate(() => {
    const p = document.querySelector('.ltx_abstract .ltx_p');
    const node = p.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 'Artificial intelligence'.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForSelector('.selection-toolbar');
  await page.locator('.selection-toolbar button').first().click();
  await page.waitForSelector('mark.hl');
  check('a highlight can be made in the book', (await page.locator('mark.hl').first().textContent()) === 'Artificial intelligence');

  await page.setViewportSize({ width: 700, height: viewport.height });
  await page.waitForTimeout(300);
  check('narrowing the window drops to one page', (await page.locator('.book-spread.two').count()) === 0);
  await page.setViewportSize(viewport);

  await page.getByRole('button', { name: /Read as one scrolling page/ }).click();
  check('the toggle goes back to scrolling', await page.locator('.reader-scroll').isVisible());
  check('the highlight is still painted after the switch', (await page.locator('.reader-scroll mark.hl').count()) === 1);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

await run({ width: 1440, height: 900 }, 'desktop');
await run({ width: 1024, height: 1366 }, 'ipad-portrait');
await run({ width: 1366, height: 1024 }, 'ipad-landscape');
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall passed');
