// DeepSeek, without a network or a key: the request the client sends, how it
// reads the streamed answer back, and what its failures say — plus the model
// list and key checks in assistant.ts that decide which provider answers.
//
//   node --test scripts/deepseek.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const deepseek = await load('src/lib/deepseek.ts');
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

const event = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const params = { apiKey: 'sk-test', model: 'deepseek-reasoner', maxTokens: 1000, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] };

describe('the request', () => {
  it('sends the system prompt first, streams, and flattens pictures into a line of text', () => {
    const body = deepseek.requestBody({
      ...params,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Page 3:' }, { type: 'image', source: {} }, { type: 'text', text: 'What is this?' }] },
      ],
    });
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 1000);
    assert.deepEqual(body.messages[0], { role: 'system', content: 'Be brief.' });
    assert.equal(body.messages[1].content, `Page 3:\n\n${deepseek.PICTURE_LEFT_OUT}\n\nWhat is this?`);
  });

  it('goes to api.deepseek.com with the key as a bearer token', async () => {
    const { fetcher, calls } = fakeFetch([event({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    await new deepseek.DeepSeekStream(params, fetcher).finalMessage();
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
    assert.equal(calls[0].body.model, 'deepseek-reasoner');
  });
});

describe('the answer', () => {
  it('reads text and reasoning as they stream, across chunk boundaries and keep-alives', async () => {
    const whole = [event({ reasoning_content: 'Hmm. ' }), ': keep-alive\n\n', event({ content: 'Hello, ' }), event({ content: 'world.' }, 'stop'), 'data: [DONE]\n\n'].join('');
    // Cut it up at awkward places, the way the network does.
    const chunks = [whole.slice(0, 17), whole.slice(17, 60), whole.slice(60, 61), whole.slice(61)];
    const { fetcher } = fakeFetch(chunks);
    let text = '';
    let thinking = '';
    const stream = new deepseek.DeepSeekStream(params, fetcher);
    stream.on('text', (d) => (text += d)).on('thinking', (d) => (thinking += d));
    const final = await stream.finalMessage();
    assert.equal(text, 'Hello, world.');
    assert.equal(thinking, 'Hmm. ');
    assert.equal(final.stop_reason, 'end_turn');
  });

  it('says max_tokens when the answer ran out of room, as Anthropic would', async () => {
    const { fetcher } = fakeFetch([event({ content: 'cut' }, 'length'), 'data: [DONE]\n\n']);
    assert.equal((await new deepseek.DeepSeekStream(params, fetcher).finalMessage()).stop_reason, 'max_tokens');
    assert.equal(deepseek.stopReason('content_filter'), 'refusal');
  });
});

describe('failures', () => {
  it('carries the status and DeepSeek’s own message', async () => {
    const { fetcher } = fakeFetch([], { status: 402, body: { error: { message: 'Insufficient Balance' } } });
    await assert.rejects(new deepseek.DeepSeekStream(params, fetcher).finalMessage(), (error) => {
      assert.equal(error.status, 402);
      assert.equal(error.message, 'Insufficient Balance');
      assert.match(assistant.explainError(error, null), /balance has run out/);
      return true;
    });
  });

  it('turns a request that never got an answer into a plain sentence', async () => {
    const fetcher = async () => {
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(new deepseek.DeepSeekStream(params, fetcher).finalMessage(), (error) => {
      assert.equal(error.status, 0);
      assert.match(assistant.explainError(error, null), /Could not reach api\.deepseek\.com/);
      return true;
    });
  });

  it('reads a stop as Stopped', async () => {
    const fetcher = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const stream = new deepseek.DeepSeekStream(params, fetcher);
    stream.abort();
    await assert.rejects(stream.finalMessage(), (error) => assistant.explainError(error, null) === 'Stopped.');
  });
});

describe('models and keys', () => {
  it('offers Claude and DeepSeek, and knows who runs each model', () => {
    const providers = new Set(assistant.MODELS.map((m) => m.provider));
    assert.deepEqual([...providers], ['anthropic', 'deepseek']);
    assert.equal(assistant.providerOf('deepseek-chat').company, 'DeepSeek');
    assert.equal(assistant.providerOf('claude-opus-5').name, 'Claude');
    assert.equal(assistant.modelSpec('no-such-model').id, assistant.MODELS[0].id);
    assert.ok(assistant.MODELS.filter((m) => m.provider === 'deepseek').every((m) => !m.vision));
  });

  it('tells a Claude key from a DeepSeek one', () => {
    assert.ok(assistant.looksLikeKey('sk-ant-api03-abc', 'anthropic'));
    assert.ok(assistant.looksLikeKey('sk-0123456789abcdef', 'deepseek'));
    assert.ok(!assistant.looksLikeKey('sk-ant-api03-abc', 'deepseek'));
    assert.ok(!assistant.looksLikeKey('sk-0123456789abcdef', 'anthropic'));
  });

  it('keeps which model wrote an answer in the history, and nothing for older chats', () => {
    const [chat] = assistant.normaliseHistory([
      { id: 'c1', title: 'x', turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', model: 'deepseek-chat' }] },
    ]);
    assert.equal(chat.turns[1].model, 'deepseek-chat');
    assert.equal(chat.turns[0].model, undefined);
  });
});
