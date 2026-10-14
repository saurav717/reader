// The proxy's /cite route: a paper's BibTeX from the source that publishes
// it, and from nowhere else — the allowlist in server/citeSources.js.
//
//   node --test scripts/cite-proxy.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { default: apiRouter } = await import('../server/api.js');
const { citeSourceUrl } = await import('../server/citeSources.js');

/** Answers the next fetch, whatever URL it is for. */
let upstream = () => new Response('nothing stubbed', { status: 500 });
let asked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push({ url, init });
  return upstream(url, init);
};

const server = createServer((req, res) => apiRouter(req, res));
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

const get = (target) => realFetch(`${base}/cite?url=${encodeURIComponent(target)}`);

describe('which addresses are citation sources', () => {
  it('takes each publisher’s BibTeX path, over HTTPS', () => {
    for (const url of [
      'https://arxiv.org/bibtex/2202.08906',
      'https://arxiv.org/bibtex/2202.08906v2',
      'https://arxiv.org/bibtex/hep-th/9901001',
      'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17.bib?param=1',
      'https://aclanthology.org/2020.acl-main.1.bib',
      'https://api.crossref.org/works/10.5555%2Fx/transform/application/x-bibtex',
      'https://doi.org/10.1145/3448016',
      'https://api.datacite.org/dois/application/x-bibtex/10.48550/arXiv.2202.08906',
      'https://proceedings.mlr.press/v202/zhou23c.bib',
      'https://api.semanticscholar.org/graph/v1/paper/arXiv:2202.08906?fields=citationStyles',
      'https://api2.openreview.net/notes?content.title=GShard',
    ]) assert.equal(citeSourceUrl(url), url, url);
  });

  it('refuses everything else: other hosts, other paths on those hosts, plain HTTP, credentials', () => {
    for (const url of [
      'https://evil.example/paper.bib',
      'https://arxiv.org/abs/2202.08906',
      'https://arxiv.org/pdf/2202.08906',
      'https://dblp.org/search/publ/api?q=x',
      'http://arxiv.org/bibtex/2202.08906',
      'https://user:pass@arxiv.org/bibtex/2202.08906',
      'https://arxiv.org:8443/bibtex/2202.08906',
      'https://api.crossref.org/works?query=attention',
      'ftp://arxiv.org/bibtex/2202.08906',
      '',
      'not a url',
    ]) assert.equal(citeSourceUrl(url), null, url);
  });
});

describe('the route', () => {
  it('fetches the entry and hands it over as text, cached for a day', async () => {
    asked = [];
    upstream = () => new Response('@misc{zoph2022stmoe,\n  title={ST-MoE}\n}', { status: 200, headers: { 'content-type': 'application/x-bibtex; charset=utf-8' } });
    const response = await get('https://arxiv.org/bibtex/2202.08906');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
    assert.match(await response.text(), /^@misc\{zoph2022stmoe,/);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://arxiv.org/bibtex/2202.08906');
    assert.match(asked[0].init.headers.Accept, /^application\/x-bibtex/);
  });

  it('passes a source’s refusal through, uncached', async () => {
    upstream = () => new Response('no such record', { status: 404 });
    const response = await get('https://aclanthology.org/2099.acl-main.1.bib');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('will not fetch an address that is not a source', async () => {
    asked = [];
    const response = await get('https://evil.example/paper.bib');
    assert.equal(response.status, 400);
    assert.equal(asked.length, 0);
  });
});
