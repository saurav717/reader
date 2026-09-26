// Gemini, without a network or a key: the request the client sends, how it
// reads the streamed answer back — thinking apart from the answer, the tokens
// it took — and what its failures say, plus how assistant.ts picks it.
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
const params = { apiKey: 'AIza-test', model: 'gemini-3.8-flash', maxTokens: 1000, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], thinking: 'high' };

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

  it('streams from the model’s own address, with the key in a header and never in the address', async () => {
    const { fetcher, calls } = fakeFetch([event([{ text: 'Hello' }], 'STOP')]);
    await new gemini.GeminiStream(params, fetcher).finalMessage();
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIza-test');
    assert.ok(!calls[0].url.includes('AIza'));
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
  it('a bad key: Google’s 400, said as a bad key', async () => {
    const { fetcher } = fakeFetch([], { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } });
    const error = await new gemini.GeminiStream(params, fetcher).finalMessage().catch((e) => e);
    assert.equal(error.name, 'GeminiError');
    assert.match(assistant.explainError(error, null), /Google rejected that API key/);
  });

  it('a spent quota, and a model the key cannot use', async () => {
    const quota = new gemini.GeminiError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED');
    assert.match(assistant.explainError(quota, null), /quota/);
    assert.match(assistant.explainError(new gemini.GeminiError(404, 'models/x is not found'), null), /does not serve that model/);
    assert.match(assistant.explainError(new gemini.GeminiError(0, 'fetch failed'), null), /generativelanguage\.googleapis\.com/);
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

  it('takes an AI Studio key, and no one else’s', () => {
    assert.equal(assistant.looksLikeKey('AIzaSyExample123', 'gemini'), true);
    assert.equal(assistant.looksLikeKey('sk-ant-api03-x', 'gemini'), false);
    assert.equal(assistant.looksLikeKey('AIzaSyExample123', 'deepseek'), false);
  });
});
