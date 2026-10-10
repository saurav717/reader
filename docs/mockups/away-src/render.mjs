// Renders each mock-up here to ../away-N-*.png, with the Playground's rail.
//   node docs/mockups/away-src/render.mjs [prefix]
import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(join(here, '..', 'playground-src', 'rail.html'), 'utf8');
const only = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const name of readdirSync(here).filter((f) => /^\d.*\.html$/.test(f) && (!only || f.startsWith(only)))) {
  const tmp = join(here, `.render-${name}`);
  writeFileSync(tmp, readFileSync(join(here, name), 'utf8').replace('<!--RAIL-->', rail));
  await page.goto(`file://${tmp}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, '..', `away-${name.replace('.html', '.png')}`) });
  unlinkSync(tmp);
  console.log('rendered', name);
}
await browser.close();
