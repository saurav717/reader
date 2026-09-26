// Gemini, without a network or a key: the request the app sends the proxy,
// how it reads the streamed answer back — thinking apart from the answer, the
// tokens it took — and what its failures say, the proxy's and Google's, plus
// how assistant.ts picks it. The proxy's side is scripts/usage.test.mjs.
//
//   node --test scripts/gemini.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const gemini = await load('src/lib/gemini.ts');
const assistant = await load('src/lib/assistant.ts', { external: ['@anthropic-ai/sdk'] });

after(cleanup);

/** A fetch that answers with these server-sent-event chunks, and remembers what it was asked. */
function fakeFetch(chunks, { status = 200, body } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response(JSON.stringify(body ?? {}), { status, statusText: 'Nope' });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetcher, calls };
}

const event = (parts, finishReason, usageMetadata) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) })}\r\n\r\n`;
const params = { url: 'https://proxy.example/ai/gemini', headers: { Authorization: 'Bearer pass', 'X-Reader-Client': 'c' }, model: 'gemini-3.8-flash', maxTokens: 1000, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], thinking: 'high' };

describe('the request', () => {
  it('puts the system prompt beside the turns, calls the assistant the model, and sends pictures inline', () => {
    const body = gemini.requestBody({
      ...params,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Page 3:' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] },
        { role: 'assistant', content: 'A diagram.' },
        { role: 'user', content: 'Of what?' },
      ],
    });
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] });
    assert.deepEqual(body.contents[0].parts, [{ text: 'Page 3:' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }]);
    assert.deepEqual(body.contents.map((turn) => turn.role), ['user', 'model', 'user']);
    assert.deepEqual(body.generationConfig, { maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } });
  });

  it('goes to the proxy, with its pass, as the model and the request — no Google key anywhere', async () => {
    const { fetcher, calls } = fakeFetch([event([{ text: 'Hello' }], 'STOP')]);
    await new gemini.GeminiStream(params, fetcher).finalMessage();
    assert.equal(calls[0].url, 'https://proxy.example/ai/gemini');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer pass');
    assert.equal(calls[0].body.model, 'gemini-3.8-flash');
    assert.equal(calls[0].body.request.contents[0].parts[0].text, 'Hi');
    assert.ok(!JSON.stringify(calls[0]).includes('AIza'));
  });
});

describe('the answer', () => {
  it('streams thinking apart from the answer, says why it ended, and counts the thinking as output', async () => {
    let usage;
    const { fetcher } = fakeFetch([
      event([{ text: 'Weighing it…', thought: true }]),
      event([{ text: 'Hel' }]),
      event([{ text: 'lo' }], 'STOP', { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 70 }),
    ]);
    const stream = new gemini.GeminiStream({ ...params, onUsage: (u) => (usage = u) }, fetcher);
    let text = '';
    let thinking = '';
    stream.on('text', (d) => (text += d)).on('thinking', (d) => (thinking += d));
    const final = await stream.finalMessage();
    assert.equal(text, 'Hello');
    assert.equal(thinking, 'Weighing it…');
    assert.equal(final.stop_reason, 'end_turn');
    assert.deepEqual(gemini.tokensOf(usage), { input: 200, cacheRead: 1000, output: 100 });
  });

  it('reads a cut-off answer and a declined one in the words the callers check for', () => {
    assert.equal(gemini.stopReason('MAX_TOKENS'), 'max_tokens');
    assert.equal(gemini.stopReason('SAFETY'), 'refusal');
    assert.equal(gemini.stopReason('PROHIBITED_CONTENT'), 'refusal');
    assert.equal(gemini.stopReason(undefined), null);
  });

  it('a question declined before any answer is a refusal', async () => {
    const { fetcher } = fakeFetch([`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`]);
    assert.equal((await new gemini.GeminiStream(params, fetcher).finalMessage()).stop_reason, 'refusal');
  });
});

describe('failures', () => {
  it('a bad key on the proxy: Google’s 400, passed through, said as the proxy’s key', async () => {
    const { fetcher } = fakeFetch([], { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } });
    const error = await new gemini.GeminiStream(params, fetcher).finalMessage().catch((e) => e);
    assert.equal(error.name, 'GeminiError');
    assert.equal(error.fromProxy, false);
    assert.match(assistant.explainError(error, null), /proxy’s Gemini key.*GEMINI_KEY/);
  });

  it('the proxy’s own refusals: no key there, not signed in, the owner’s alone', async () => {
    const said = async (status, body) => {
      const { fetcher } = fakeFetch([], { status, body });
      return assistant.explainError(await new gemini.GeminiStream(params, fetcher).finalMessage().catch((e) => e), null);
    };
    assert.match(await said(501, { error: 'this proxy has no Gemini key', setup: true }), /no Gemini key yet[\s\S]*GEMINI_KEY/);
    assert.match(await said(401, { error: 'this proxy needs its token', token: true }), /Sign in to the paper proxy/);
    assert.match(await said(403, { error: 'for its owner', owners: true }), /for its owner/);
  });

  it('a spent quota, and a model the key cannot use', async () => {
    const quota = new gemini.GeminiError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED');
    assert.match(assistant.explainError(quota, null), /quota/);
    assert.match(assistant.explainError(new gemini.GeminiError(404, 'models/x is not found'), null), /does not serve that model/);
    assert.match(assistant.explainError(new gemini.GeminiError(0, 'fetch failed'), null), /paper proxy/);
  });

  it('stopping is an abort, not a failure', async () => {
    const fetcher = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const stream = new gemini.GeminiStream(params, fetcher);
    stream.abort();
    const error = await stream.finalMessage().catch((e) => e);
    assert.equal(error.name, 'AbortError');
  });
});

describe('in the pickers', () => {
  it('offers Google’s three, each reading pictures, and knows Google runs them', () => {
    const ids = assistant.MODELS.filter((m) => m.provider === 'gemini').map((m) => m.id);
    assert.deepEqual(ids, ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    assert.ok(assistant.MODELS.filter((m) => m.provider === 'gemini').every((m) => m.vision));
    assert.equal(assistant.providerOf('gemini-3.8-flash').company, 'Google');
  });

  it('asks for no key: it runs on the proxy’s, and says why it cannot when it cannot', () => {
    assert.equal(assistant.PROVIDERS.gemini.viaProxy, true);
    assert.equal(assistant.PROVIDERS.anthropic.viaProxy, undefined);
    assert.match(assistant.geminiNote('no-key').long, /GEMINI_KEY/);
    assert.match(assistant.geminiNote('sign-in').short, /sign in/);
    assert.match(assistant.geminiNote('ready').long, /nothing to paste/);
  });
});
