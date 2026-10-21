/**
 * The showcase (components/Showcase.tsx), recorded whole: its own pointer
 * finds "Attention Is All You Need", reads it, asks about it, has it
 * explained, planned and run on a stand-in Colab — the model and Colab
 * replayed by the page. Its scene cards are hidden; the video says it.
 */
import { attentionPdf, json } from '../lib.mjs';

const TITLE = 'Attention Is All You Need';
export const pointer = false; // the showcase brings its own

export async function setup(context) {
  const PDF = await attentionPdf();
  await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
  for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
    await context.route(`**/${host}/**`, (route) => route.fulfill(json('{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}')));
  }
  const HIT = { id: '1706.03762', clusterId: '1706.03762', title: TITLE, url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://arxiv.org/pdf/1706.03762', authors: ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'], year: 2017, snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.' };
  await context.route('**/scholar/search*', (route) => route.fulfill(json({ results: [HIT] })));
  await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill(json('{"results":[]}')));
  const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><updated>2023-08-02T00:41:18Z</updated><published>2017-06-12T17:57:34Z</published><title>${TITLE}</title><summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/><category term="cs.CL"/></entry></feed>`;
  await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
  await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 404, body: '' }));
  await context.addInitScript(() => {
    let last = '';
    new MutationObserver(() => {
      const scene = document.querySelector('.showcase')?.getAttribute('data-scene');
      if (scene && scene !== last) {
        last = scene;
        window.__mark?.(`scene:${scene}`);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-scene'] });
  });
}

export async function prepare({ page, arrive }) {
  await arrive();
  await page.addStyleTag({ content: '.showcase-card { display: none !important; }' });
}

export default async function ({ page, mark }) {
  await page.exposeFunction('__mark', mark);
  await page.mouse.move(768, 432);
  await page.waitForTimeout(2500);
  mark('palette');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.type('show me', { delay: 60 });
  await page.locator('.palette-row', { hasText: 'Show me, with a paper' }).click();
  await page.waitForSelector('.showcase[data-scene="done"]', { state: 'attached', timeout: 400_000 });
  await page.waitForTimeout(1500);
}
