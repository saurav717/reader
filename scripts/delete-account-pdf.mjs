// Prints docs/delete-account/index.html to docs/delete-account.pdf, with
// Chromium through Playwright: A4, the page's own fonts (loaded from Google
// Fonts, so it needs the network), and "page N of M" in the footer.
//
//   node scripts/delete-account-pdf.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs', 'delete-account', 'index.html');
const out = join(root, 'docs', 'delete-account.pdf');

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const page = await browser.newPage();
await page.goto(pathToFileURL(source).toString(), { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="width:100%;font:8px IBM Plex Sans,Helvetica,Arial,sans-serif;color:#7a776d;padding:0 16mm;display:flex;justify-content:space-between">' +
    '<span>Koios · Delete my account: how it works</span><span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
  margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
});
await browser.close();
console.log(`wrote ${out}`);
