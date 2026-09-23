// Asks Browserless for a browser, for real, from this machine — the same
// address the Worker connects at (worker/browserless.js), driven with the
// Playwright this repository already has — and opens one page in it. Says,
// step by step, what happened: whether Browserless answered the token,
// whether the page came as Cloudflare's check for a person, whether that
// check passed on its own, and whether what came is a PDF. It is the check
// to run when the pane says the session is being handed to Browserless and
// nothing follows: it tells the token and the plan apart from the Worker's
// own plumbing, since it takes the Worker out of the picture.
//
//   BROWSERLESS_TOKEN=… node scripts/browserless-live.mjs https://www.academia.edu/download/78156473/10.pdf
//
// BROWSERLESS_URL, BROWSERLESS_PROXY and BROWSERLESS_COUNTRY are read the
// way the Worker reads them. A picture of the page is left in
// browserless-live.png beside the repository, for the eye. Costs a unit or
// two of the plan's month.

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { endpointFor, redacted } from '../worker/browserless.js';

const url = process.argv[2] || 'https://www.academia.edu/download/78156473/10.pdf';
const env = process.env;
if (!String(env.BROWSERLESS_TOKEN || '').trim()) {
  console.error('BROWSERLESS_TOKEN is not set: BROWSERLESS_TOKEN=… node scripts/browserless-live.mjs <url>');
  process.exit(2);
}

const address = endpointFor(env, { timeoutMs: 120_000 });
console.log(`connecting at ${redacted(address)}`);
const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

let browser;
try {
  browser = await chromium.connectOverCDP(address, { timeout: 30_000 });
} catch (error) {
  console.error(`Browserless did not give a browser (${since()}): ${String(error?.message || error).split('\n')[0]}`);
  console.error('A 401 or 403 in there is the token; a 429 is the plan\'s browsers all in use; a 404 is the address.');
  process.exit(1);
}
console.log(`connected (${since()}): ${browser.version()}`);

try {
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 800 });
  let check = null;
  page.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'document' || request.frame() !== page.mainFrame()) return;
    const mitigated = (response.headers()['cf-mitigated'] || '').trim().toLowerCase();
    const type = response.headers()['content-type'] || '';
    console.log(`page came (${since()}): ${response.status()} ${type.split(';')[0]}${mitigated ? ` cf-mitigated: ${mitigated}` : ''} — ${response.url()}`);
    check = mitigated === 'challenge';
  });
  console.log(`opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error) => {
    console.log(`navigation did not settle (${since()}): ${String(error?.message || error).split('\n')[0]}`);
  });
  if (check) {
    console.log("that is Cloudflare's check for a person; waiting up to 20 seconds for it to pass on its own…");
    const until = Date.now() + 20_000;
    while (check && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(check ? `still the check after the wait (${since()}): it wants a box ticked, which the pane can do` : `the check passed on its own (${since()})`);
  }
  let contentType = '';
  try {
    contentType = await page.evaluate(() => document.contentType);
  } catch {
    contentType = '(the viewer would not say)';
  }
  const title = await page.title().catch(() => '');
  console.log(`showing: ${contentType || '?'} "${title}" at ${page.url()}`);
  if (contentType === 'application/pdf') console.log('that is the PDF: the file came to a browser on an address of its own');
  const picture = await page.screenshot({ type: 'png' }).catch(() => null);
  if (picture) {
    await writeFile('browserless-live.png', picture);
    console.log('picture in browserless-live.png');
  }
} finally {
  await browser.close().catch(() => undefined);
  console.log(`closed (${since()})`);
}
