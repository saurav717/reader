// Renders the stage mock-up (index.html beside this file) into the pictures
// docs/explain-stage.md shows: one frame per state, in reading order, then
// the dark theme and a phone. Run from the repository root, after npm install:
//
//   node docs/mockups/stage-src/render.mjs
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
const wrapped = join(mkdtempSync(join(tmpdir(), 'stage-')), 'index.html');
writeFileSync(wrapped, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${page}</body></html>`);
const url = 'file://' + wrapped;

const browser = await chromium.launch();

/** Scrolls so the given paragraph of a section sits just under the reading line, plus `extra` pixels. */
async function toStep(p, sec, step, extra = 0) {
  await p.evaluate(([sec, step, extra]) => {
    const para = document.querySelectorAll('#s-' + sec + ' p[data-step]')[step];
    window.scrollTo(0, para.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.36 + 40 + extra);
  }, [sec, step, extra]);
  await p.waitForTimeout(1200);
}
/** The mock window only, not the note above it or the brainstorm below. */
async function shot(p, name) {
  const box = await p.evaluate(() => { const r = document.querySelector('.mock').getBoundingClientRect(); return { x: r.x, w: r.width }; });
  await p.screenshot({ path: join(out, `stage-${name}.png`), clip: { x: box.x, y: 0, width: box.w, height: 900 } });
}

let p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(url); await p.waitForTimeout(1000);
await p.evaluate(() => document.querySelector('.mock').scrollIntoView()); await p.waitForTimeout(500);
await p.evaluate(() => window.scrollBy(0, 120)); await p.waitForTimeout(600);
await shot(p, '1-figure-only');
await toStep(p, 'problem', 0); await shot(p, '2-suggested');
await p.click('.explain-figure .suggest'); await p.waitForTimeout(1400); await shot(p, '3-drawing');
await p.waitForTimeout(2800); await shot(p, '4-drawn');
await toStep(p, 'soft', 1); await shot(p, '5-stage-gone');
await toStep(p, 'temp', 2, 300); await shot(p, '6-stage-with-still-under');
await toStep(p, 'loss', 1); await shot(p, '7-loss-tabs');
await toStep(p, 'layers', 1); await p.click('#tabs [data-tab="figure"]'); await p.waitForTimeout(300); await shot(p, '8-still-tab');
await p.click('#tabs [data-tab="anim"]'); await p.waitForTimeout(200);
await toStep(p, 'train', 1); await shot(p, '9-static-with-cell-chip');
await toStep(p, 'loss', 3); await p.click('#menu-btn'); await p.waitForTimeout(300); await shot(p, '10-menu');
await p.close();

p = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await p.goto(url); await p.waitForTimeout(1000);
await toStep(p, 'loss', 3); await shot(p, '11-dark');
await p.close();

p = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
await p.goto(url); await p.waitForTimeout(1000);
await toStep(p, 'temp', 1); await p.screenshot({ path: join(out, 'stage-12-phone.png') });
await p.close();

await browser.close();
console.log('rendered into', out);
