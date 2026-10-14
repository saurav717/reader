// Renders each live-collaboration mock-up here to ../live-N-*.png. <!--RAIL--> puts the labelled rail in,
// <!--TOP--> the panels strip, <!--CODE--> and <!--WRITE--> the Code and Write pages' bodies.
//   NODE_PATH=$(npm root -g) node docs/mockups/live-src/render.mjs [prefix]
import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');
const parts = { RAIL: read('rail.html'), TOP: read('top.html'), CODE: read('code-body.html'), WRITE: read('write-body.html') };
const only = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const name of readdirSync(here).filter((f) => /^\d.*\.html$/.test(f) && (!only || f.startsWith(only)))) {
  const tmp = join(here, `.render-${name}`);
  writeFileSync(tmp, read(name).replace(/<!--(RAIL|TOP|CODE|WRITE)-->/g, (_, key) => parts[key]));
  await page.goto(`file://${tmp}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, '..', `live-${name.replace('.html', '.png')}`) });
  unlinkSync(tmp);
  console.log('rendered', name);
}
await browser.close();
