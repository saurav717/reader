// Gemini through the Node proxy (`npm start`), on its own key: the route
// relays a question from this app to Google with GEMINI_KEY in a header,
// streams the answer back, keeps the key out of everything the page sees,
// and says what is missing when it cannot. The Worker's side is in
// scripts/usage.test.mjs.
//
//   node --test scripts/gemini-relay.test.mjs

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.READER_SCHOLAR_PROFILE_DIR = join(tmpdir(), `reader-no-scholar-profile-${process.pid}`);
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
delete process.env.READER_TOKEN;
delete process.env.GEMINI_KEY;

const { default: apiRouter } = await import('../server/api.js');
const { checkRequest, tokensOf } = await import('../server/geminiRelay.js');

const SSE = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })}\r\n\r\n`;
const QUESTION = { model: 'gemini-3.5-flash-lite', request: { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] } };

describe('the Node proxy’s /ai/gemini', () => {
  const server = createServer((req, res) => apiRouter(req, res));
  const realFetch = globalThis.fetch;
  const sent = [];
  let base;
  const ready = new Promise((resolve) => server.listen(0, resolve)).then(() => {
    base = `http://localhost:${server.address().port}`;
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      sent.push({ url, key: init.headers['x-goog-api-key'] });
      return new Response(SSE, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  const ask = async (body = QUESTION) => {
    await ready;
    return realFetch(`${base}/api/ai/gemini`.replace('/api', ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify(body),
    });
  };

  afterEach(() => {
    delete process.env.GEMINI_KEY;
    delete process.env.READER_TOKEN;
    sent.length = 0;
  });
  after(() => {
    globalThis.fetch = realFetch;
    server.close();
  });

  it('says it has no key, in /health and when asked', async () => {
    await ready;
    assert.equal((await (await realFetch(`${base}/health`)).json()).gemini, false);
    const answer = await ask();
    assert.equal(answer.status, 501);
    assert.equal((await answer.json()).setup, true);
    assert.equal(sent.length, 0);
  });

  it('with GEMINI_KEY, streams Google’s answer back — the key in the header to Google, nowhere else', async () => {
    process.env.GEMINI_KEY = 'AIza-local-key';
    assert.equal((await (await realFetch(`${base}/health`)).json()).gemini, true);
    const answer = await ask();
    assert.equal(answer.status, 200);
    const text = await answer.text();
    assert.match(text, /Hello/);
    assert.ok(!text.includes('AIza-local-key'));
    assert.equal(sent[0].key, 'AIza-local-key');
    assert.match(sent[0].url, /gemini-3\.5-flash-lite:streamGenerateContent\?alt=sse$/);
  });

  it('wants the token when the proxy has one', async () => {
    process.env.GEMINI_KEY = 'AIza-local-key';
    process.env.READER_TOKEN = 'local-token';
    assert.equal((await ask()).status, 401);
    assert.equal(sent.length, 0);
  });
});

describe('what is relayed', () => {
  it('keeps to the turns, the system instruction and the generation settings', () => {
    const { request } = checkRequest({
      model: 'gemini-3.8-flash',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { fileData: { fileUri: 'gs://x' } }] }],
        tools: [{ googleSearch: {} }],
        safetySettings: [{}],
        generationConfig: { thinkingConfig: { thinkingLevel: 'extreme' } },
      },
    });
    assert.deepEqual(Object.keys(request).sort(), ['contents', 'generationConfig']);
    assert.equal(request.contents[0].parts.length, 2, 'a file by address is not a picture');
    assert.deepEqual(request.generationConfig.thinkingConfig, { includeThoughts: true });
  });

  it('counts the thinking as output, and a cached read apart', () => {
    assert.deepEqual(tokensOf({ promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 5, thoughtsTokenCount: 7 }), { input: 40, cacheRead: 60, output: 12 });
  });
});
