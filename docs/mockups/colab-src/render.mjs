// Renders each Colab mock-up here to ../colab-N-*.png.
//   NODE_PATH=$(npm root -g) node docs/mockups/colab-src/render.mjs
import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');
const bar = read('bar.html');
const outline = read('outline.html');
const prose = read('prose.html');
const code = read('code.html');
// <!--BAR:chip--> puts the Explain bar in with that chip where Colab sits;
// <!--OUTLINE--> the outline; <!--PROSE[[cell]]--> section 03 with that cell in
// its margin; %%CODE%% the cell's code.
const assemble = (html) =>
  html
    .replace(/<!--BAR:([\s\S]*?)-->\n/, (_, chip) => bar.replace('<!--CHIP-->', chip))
    .replace('<!--OUTLINE-->', outline)
    .replace(/<!--PROSE\[\[([\s\S]*?)\]\]-->\n/, (_, cell) => prose.replace('<!--CELL-->', cell))
    .replace('%%CODE%%', code);
const only = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const name of readdirSync(here).filter((f) => /^\d.*\.html$/.test(f) && (!only || f.startsWith(only)))) {
  const tmp = join(here, `.render-${name}`);
  writeFileSync(tmp, assemble(read(name)));
  await page.goto(`file://${tmp}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, '..', `colab-${name.replace('.html', '.png')}`) });
  unlinkSync(tmp);
  console.log('rendered', name);
}
await browser.close();
