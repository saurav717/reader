// Renders each landing-page mock-up here to ../landing-N-*.png. <!--RAIL--> puts
// the rail in with Home (the R) showing; <!--RAIL:away--> for a page elsewhere.
//   NODE_PATH=$(npm root -g) node docs/mockups/landing-src/render.mjs
import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(join(here, 'rail.html'), 'utf8');
const homebar = readFileSync(join(here, 'homebar.html'), 'utf8');
const resume = readFileSync(join(here, 'resume.html'), 'utf8');
// <!--HOMEBAR:today--> puts Home's bar in with that view's tab chosen;
// <!--RESUME--> the strip with the paper you left.
const withHomebar = (html) => html.replace('<!--RESUME-->', resume).replace(/<!--HOMEBAR:(\w+)-->/, (_, k) => homebar.replace(`class="tab" data-k="${k}"`, `class="tab on" data-k="${k}"`));
const only = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const name of readdirSync(here).filter((f) => /^\d.*\.html$/.test(f) && (!only || f.startsWith(only)))) {
  const tmp = join(here, `.render-${name}`);
  writeFileSync(tmp, withHomebar(readFileSync(join(here, name), 'utf8')).replace(/<!--RAIL(?::(\w+))?-->/, (_, where) => (where === 'away' ? rail.replace('brand home', 'brand home away') : rail)));
  await page.goto(`file://${tmp}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, '..', `landing-${name.replace('.html', '.png')}`) });
  (await import('node:fs')).unlinkSync(tmp);
  console.log('rendered', name);
}
await browser.close();
