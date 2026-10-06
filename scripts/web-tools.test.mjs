// The web tools behind Ask AI's Web button, without a network: what a tool
// call asks the proxy, what the model reads back — results, a page, a
// failure said as a sentence — and whether the button can be on at all.
//
//   node --test scripts/web-tools.test.mjs

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadTogether } from './bundle.mjs';

const mod = await loadTogether(['src/lib/webTools.ts', 'src/lib/api.ts', 'src/lib/assistant.ts'], { external: ['@anthropic-ai/sdk'] });

after(cleanup);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that answers every request with this JSON (or status), and remembers what it was asked. */
function fakeFetch(body, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

describe('the tools', () => {
  it('are a search and a page read, each with one required argument', () => {
    assert.deepEqual(
      mod.WEB_TOOLS.map((tool) => [tool.name, tool.parameters.required]),
      [
        ['web_search', ['query']],
        ['read_page', ['url']],
      ],
    );
    assert.deepEqual(mod.stepOf('web_search', { query: ' transformers ' }), { tool: 'web_search', what: 'transformers' });
    assert.deepEqual(mod.stepOf('read_page', { url: 'https://a.example/' }), { tool: 'read_page', what: 'https://a.example/' });
    assert.equal(mod.stepOf('delete_everything', {}), null);
  });

  it('a search goes to the proxy with its headers, and comes back as a numbered list', async () => {
    mod.setProxyBase('https://proxy.example');
    const calls = fakeFetch({ via: 'brave', results: [{ title: 'A', url: 'https://a.example/', snippet: 'about a', age: 'May 2026' }, { title: 'B', url: 'https://b.example/', snippet: '' }] });
    const { text, step } = await mod.runWebTool('web_search', { query: 'a & b' });
    assert.equal(calls[0].url, 'https://proxy.example/web/search?q=a%20%26%20b');
    assert.ok(calls[0].init.headers['X-Reader-Client'], 'the client id goes along, so the proxy can tell browsers apart');
    assert.match(text, /^Results for “a & b”:\n\n1\. A\n   https:\/\/a\.example\/\n   \(May 2026\)\n   about a\n\n2\. B\n   https:\/\/b\.example\/$/);
    assert.deepEqual(step, { tool: 'web_search', what: 'a & b', outcome: '2 results' });
  });

  it('a page comes back with its title and address first, and a PDF as a note', async () => {
    mod.setProxyBase('https://proxy.example');
    fakeFetch({ url: 'https://a.example/x', title: 'Page A', text: 'Hello there', truncated: true });
    const page = await mod.runWebTool('read_page', { url: 'https://a.example/x' });
    assert.equal(page.text, 'Title: Page A\nURL: https://a.example/x\n(The page is longer; this is its start.)\n\nHello there');
    assert.deepEqual(page.step, { tool: 'read_page', what: 'https://a.example/x', outcome: 'Page A' });
    fakeFetch({ url: 'https://a.example/p.pdf', title: '', text: '', truncated: false, note: 'That address is a PDF file, not a page.' });
    const pdf = await mod.runWebTool('read_page', { url: 'https://a.example/p.pdf' });
    assert.match(pdf.text, /PDF file/);
    assert.equal(pdf.step.outcome, 'not a page');
  });

  it('says what went wrong in a sentence the model can carry on from, and never throws for it', async () => {
    mod.setProxyBase('https://proxy.example');
    fakeFetch({ error: 'nope', auth: true }, 401);
    const refused = await mod.runWebTool('web_search', { query: 'x' });
    assert.match(refused.text, /wants its token or a sign-in/);
    assert.match(refused.step.outcome, /token/);
    fakeFetch({ error: 'no key', setup: true }, 501);
    assert.match((await mod.runWebTool('web_search', { query: 'x' })).text, /BRAVE_KEY, SERPLY_KEY or SERPAPI_KEY/);
    fakeFetch({ results: [] });
    assert.match((await mod.runWebTool('web_search', { query: 'nothing' })).text, /No results/);
    assert.match((await mod.runWebTool('web_search', {})).text, /needs its query/);
    assert.match((await mod.runWebTool('frobnicate', {})).text, /no tool called frobnicate/);
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const down = await mod.runWebTool('read_page', { url: 'https://a.example/' });
    assert.match(down.text, /could not be reached/);
  });
});

describe('whether the button can be on', () => {
  it('reads the proxy’s /health: a search key, and whether this browser is let in', async () => {
    mod.setProxyBase('https://proxy.example');
    fakeFetch({ ok: true, auth: true, gemini: false, web: true });
    mod.setProxyToken('');
    assert.equal(await mod.checkWeb(), 'sign-in');
    assert.match(mod.webNote('sign-in'), /Sign in/);
    mod.setProxyToken('tok');
    assert.equal(await mod.checkWeb(), 'ready');
    mod.setProxyBase('https://other.example');
    fakeFetch({ ok: true, auth: false, gemini: true, web: false });
    assert.equal(await mod.checkWeb(), 'no-key');
    assert.match(mod.webNote('no-key'), /BRAVE_KEY/);
    mod.setProxyToken('');
  });

  it('is a Claude or DeepSeek matter: Claude always, DeepSeek when the proxy is ready, Gemini never', () => {
    assert.equal(mod.webUsable('claude-opus-5', 'no-proxy'), true);
    assert.equal(mod.webUsable('deepseek-flash', 'ready'), true);
    assert.equal(mod.webUsable('deepseek-flash', 'no-key'), false);
    assert.equal(mod.webUsable('gemini-3.8-flash', 'ready'), false);
  });

  it('is said in the system prompt, by the tools each model has, and off by default', () => {
    assert.match(mod.webInstructions('deepseek'), /web_search.*read_page/);
    assert.doesNotMatch(mod.webInstructions('anthropic'), /read_page/);
    assert.match(mod.webInstructions('anthropic'), /Markdown link/);
    assert.equal(mod.getState().prefs.web, undefined);
  });
});
