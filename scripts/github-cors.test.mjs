// The page's GitHub calls through Reader's server cross origins (the site on
// github.io, the Worker on workers.dev): every header the page puts on them
// must be one the Worker allows, or the browser blocks the call before it is
// sent — and the page sees only "failed to fetch".
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const { githubFetch, ON_SERVER } = await load('src/lib/githubToken.ts');
const { default: worker } = await import('../worker/index.js');
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

// Headers a browser sends cross-origin without asking (CORS-safelisted), as the page uses them.
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language']);

describe('GitHub calls through Reader’s server', () => {
  it('carry only headers the Worker allows', async () => {
    const preflight = await worker.fetch(new Request('https://w.dev/github/api/user/repos', { method: 'OPTIONS', headers: { Origin: 'https://koios.dev' } }), {});
    const allowed = new Set(preflight.headers.get('Access-Control-Allow-Headers').toLowerCase().split(/\s*,\s*/));
    const sent = [];
    globalThis.fetch = async (url, init = {}) => {
      sent.push({ url: String(url), headers: new Headers(init.headers) });
      return Response.json([]);
    };
    await githubFetch(ON_SERVER, '/user/repos?sort=pushed');
    await githubFetch(ON_SERVER, '/repos/me/paper/git/blobs', { method: 'POST', body: JSON.stringify({ content: 'x' }) });
    await githubFetch(ON_SERVER, '/repos/me/paper/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: 'a', force: false }) });
    assert.equal(sent.length, 3);
    for (const call of sent) {
      assert.match(call.url, /\/github\/api\//);
      for (const [name] of call.headers) assert.ok(SAFELISTED.has(name) || allowed.has(name), `${name} isn’t allowed by the Worker (${call.url})`);
    }
  });
});
