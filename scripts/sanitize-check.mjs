// What the two sanitisers in src/lib/sanitize.ts let through and what they
// take out, checked in a real browser: DOMPurify needs a DOM, and the point
// of the check is what the page would actually render. The module itself is
// bundled and loaded into a blank page, so it is the shipped configuration
// that is exercised, not a copy of it.
//
//   node scripts/sanitize-check.mjs        # CHROMIUM_PATH=/path/to/chrome

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '/home/user/reader/node_modules/playwright/index.mjs';

const bundle = await build({
  entryPoints: ['src/lib/sanitize.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'sanitize',
  platform: 'browser',
  logLevel: 'silent',
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: bundle.outputFiles[0].text });

const figure = (svg) => page.evaluate((input) => window.sanitize.cleanFigure(input), svg);
const clip = (html) => page.evaluate((input) => window.sanitize.cleanClip(input), html);

let checks = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks += 1;
  console.log(`ok - ${name}`);
};

// --- a figure ---------------------------------------------------------------

const hostile = await figure(
  '<svg xmlns="http://www.w3.org/2000/svg"><style>body{display:none}</style><image href="https://x/a.png"/><a href="https://x">z</a>' +
    '<foreignObject><div>html</div></foreignObject><script>alert(1)</script><rect style="fill:red" onclick="alert(1)" x="1"/></svg>',
);
check('a figure keeps no <style>', !/<style/i.test(hostile));
check('a figure keeps no <image>', !/<image/i.test(hostile));
check('a figure keeps no <a>', !/<a[\s>]/i.test(hostile));
check('a figure keeps no <foreignObject>', !/foreignobject/i.test(hostile));
check('a figure keeps no <script>', !/<script/i.test(hostile));
check('a figure keeps no href', !/href=/i.test(hostile));
check('a figure keeps no inline style', !/style=/i.test(hostile));
check('a figure keeps no event handler', !/onclick/i.test(hostile));
check('a figure still has its shapes', /<rect x="1">/.test(hostile));

const plain = '<svg viewBox="0 0 10 10"><rect class="f-accent" x="1" y="1" width="2" height="2"></rect><text class="t-muted" x="1" y="8">hi</text></svg>';
check('a well-behaved figure is unchanged', (await figure(plain)) === plain);
const withUse = await figure('<svg><defs><marker id="m"><path d="M0 0"/></marker></defs><path marker-end="url(#m)" d="M1 1"/><use xlink:href="#m"/></svg>');
check('a marker reference in an attribute survives, since it is not a URL fetch', /marker-end="url\(#m\)"/.test(withUse));

// --- a clip -----------------------------------------------------------------

const katex = '<span class="katex"><span class="mord" style="margin-right:0.2em">x</span><span class="strut" style="height:1em;vertical-align:-0.25em"></span></span>';
check('KaTeX spacing survives a clip', (await clip(katex)) === katex);

const clipped = await clip(
  '<p>see <a href="https://example.org">this</a></p><style>p{color:red}</style><svg><image href="https://x/a.png"/><foreignObject>x</foreignObject></svg>' +
    '<iframe src="https://x"></iframe><object data="https://x"></object><embed src="https://x"><script>alert(1)</script><img src="https://x/y.png">',
);
check('a clip keeps its links', /<a href="https:\/\/example.org">this<\/a>/.test(clipped));
check('a clip keeps no <style>', !/<style/i.test(clipped));
check('a clip keeps no <image>', !/<image/i.test(clipped));
check('a clip keeps no <foreignObject>', !/foreignobject/i.test(clipped));
check('a clip keeps no <iframe>', !/<iframe/i.test(clipped));
check('a clip keeps no <object>', !/<object/i.test(clipped));
check('a clip keeps no <embed>', !/<embed/i.test(clipped));
check('a clip keeps no <script>', !/<script/i.test(clipped));

await browser.close();
console.log(`\n${checks} checks passed`);
