// Where the app thinks its proxy is. The address can come from the build
// (`VITE_API_BASE`) or, on a static host that was built without one, from
// Settings at runtime — which is the difference between rebuilding a site and
// pasting a URL into a box. These assertions are about which one wins, and
// about refusing an address that could only ever fail.
//
//   node --test scripts/proxy-setting.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { api, apiBase, checkProxy, hasProxy, normaliseProxyBase, setProxyBase } = await load('src/lib/api.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

describe('what counts as a proxy address', () => {
  it('keeps an https URL, without its trailing slash', () => {
    assert.equal(normaliseProxyBase('https://proxy.example.workers.dev/'), 'https://proxy.example.workers.dev');
  });

  it('keeps a same-origin path', () => {
    assert.equal(normaliseProxyBase('/api'), '/api');
  });

  it('allows http only on this machine', () => {
    assert.equal(normaliseProxyBase('http://localhost:8080/api'), 'http://localhost:8080/api');
    // An https page cannot call an http one, so this could only ever fail.
    assert.equal(normaliseProxyBase('http://proxy.example.com'), null);
  });

  it('treats empty, "none" and nonsense as no proxy', () => {
    for (const value of ['', '   ', 'none', 'workers.dev', undefined, null]) {
      assert.equal(normaliseProxyBase(value), null, `${value}`);
    }
  });
});

describe('the setting and the build', () => {
  it('falls back to the build, which under the test runner is same-origin', () => {
    setProxyBase('');
    assert.equal(apiBase(), '/api');
    assert.equal(hasProxy(), true);
    assert.equal(api('/health'), '/api/health');
  });

  it('is overridden by the setting, and building a URL follows it', () => {
    setProxyBase('https://proxy.example.workers.dev');
    assert.equal(apiBase(), 'https://proxy.example.workers.dev');
    assert.equal(api('/arxiv/pdf?id=2010.08895'), 'https://proxy.example.workers.dev/arxiv/pdf?id=2010.08895');
    setProxyBase('');
  });
});

describe('testing an address before anything depends on it', () => {
  it('accepts a proxy that answers the health route', async () => {
    globalThis.fetch = async (input) => {
      assert.equal(String(input), 'https://proxy.example.workers.dev/health');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await checkProxy('https://proxy.example.workers.dev/');
    assert.equal(result.ok, true);
  });

  it('rejects something that answers but is not ours', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ hello: true }), { status: 200 });
    assert.equal((await checkProxy('https://example.com')).ok, false);
  });

  it('explains a CORS failure rather than only reporting it', async () => {
    // A Worker that does not list this site in ALLOWED_ORIGINS fails here, and
    // from the page that is indistinguishable from the host being down.
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await checkProxy('https://proxy.example.workers.dev');
    assert.equal(result.ok, false);
    assert.match(result.message, /ALLOWED_ORIGINS/);
  });

  it('does not go out at all for an address that cannot work', async () => {
    globalThis.fetch = async () => assert.fail('should not have been called');
    assert.equal((await checkProxy('http://proxy.example.com')).ok, false);
  });
});
