// Renders the close-up mock-up (index.html beside this file) into the pictures
// docs/explain-closeup.md shows of the designs considered and not built: one
// frame a state. Run from the repository root, after npm install:
//
//   node docs/mockups/closeup-src/render.mjs
//
// index.html is the page as it is published (no <html> skeleton, so the
// artifact wrapper can add its own); this script wraps it before loading it.
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..');
const page = readFileSync(join(here, 'index.html'), 'utf8');
const wrapped = join(mkdtempSync(join(tmpdir(), 'closeup-')), 'index.html');
writeFileSync(
  wrapped,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap"></head><body>${page}</body></html>`,
);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await p.goto('file://' + wrapped);
await p.waitForTimeout(800);
for (const state of ['expand', 'peek', 'pane', 'zoom']) {
  await p.evaluate((state) => window.setState(state), state);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, `closeup-alt-${state}.png`), clip: { x: 0, y: 0, width: 1440, height: 900 } });
  console.log(`closeup-alt-${state}.png`);
}
await browser.close();
