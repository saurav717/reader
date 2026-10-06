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
const params = { apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1000, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], thinking: 'high' };

describe('the request', () => {
  it('sends the system prompt first, streams, and pictures as image_url data URLs', () => {
    const body = deepseek.requestBody({
      ...params,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Page 3:' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'What is this?' }] },
      ],
    });
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 1000);
    assert.deepEqual(body.messages[0], { role: 'system', content: 'Be brief.' });
    assert.deepEqual(body.messages[1].content, [
      { type: 'text', text: 'Page 3:' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      { type: 'text', text: 'What is this?' },
    ]);
  });

  it('switches thinking on with an effort, or off', () => {
    const on = deepseek.requestBody(params);
    assert.deepEqual(on.thinking, { type: 'enabled' });
    assert.equal(on.reasoning_effort, 'high');
    const off = deepseek.requestBody({ ...params, thinking: 'off' });
    assert.deepEqual(off.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in off, false);
    assert.equal(deepseek.requestBody({ ...params, messages: [{ role: 'user', content: 'Hi' }] }).messages[1].content, 'Hi');
  });

  it('asks for the tokens the answer took, and hands them on', async () => {
    assert.deepEqual(deepseek.requestBody(params).stream_options, { include_usage: true });
    const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 };
    const { fetcher } = fakeFetch([event({ content: 'ok' }, 'stop'), `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n']);
    const seen = [];
    await new deepseek.DeepSeekStream({ ...params, onUsage: (u) => seen.push(u) }, fetcher).finalMessage();
    assert.deepEqual(seen, [usage]);
  });

  it('goes to api.deepseek.com with the key as a bearer token', async () => {
    const { fetcher, calls } = fakeFetch([event({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    await new deepseek.DeepSeekStream(params, fetcher).finalMessage();
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
    assert.equal(calls[0].body.model, 'deepseek-flash');
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

describe('tools — the web, with the button on', () => {
  const tools = [{ name: 'web_search', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
  /** One streamed round: reasoning, then a tool call in two deltas, then the finish. */
  const callRound = (id, query) => [
    event({ reasoning_content: 'I should look. ' }),
    event({ tool_calls: [{ index: 0, id, function: { name: 'web_search', arguments: '{"query":' } }] }),
    event({ tool_calls: [{ index: 0, function: { arguments: `"${query}"}` } }] }, 'tool_calls'),
    'data: [DONE]\n\n',
  ];
  const answerRound = (text) => [event({ content: text }, 'stop'), 'data: [DONE]\n\n'];

  /** A fetch that answers each request with the next set of chunks. */
  function fakeRounds(rounds) {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push(JSON.parse(init.body));
      const chunks = rounds[calls.length - 1] ?? answerRound('(no more)');
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    return { fetcher, calls };
  }

  it('declares the tools as functions, and none without them', () => {
    const body = deepseek.requestBody({ ...params, tools });
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'web_search', description: 'Search.', parameters: tools[0].parameters } }]);
    assert.equal('tools' in deepseek.requestBody(params), false);
    assert.equal(deepseek.requestBody({ ...params, tools, toolChoice: 'none' }).tool_choice, 'none');
  });

  it('runs a call, sends its result back with the reasoning, and streams the answer of the next round', async () => {
    const { fetcher, calls } = fakeRounds([callRound('call_1', 'oracle selection'), answerRound('Found it.')]);
    const ran = [];
    const steps = [];
    let text = '';
    const stream = new deepseek.DeepSeekStream(
      {
        ...params,
        tools,
        runTool: async (name, args) => {
          ran.push({ name, args });
          return { text: 'Results: one', step: { tool: 'web_search', what: args.query, outcome: '1 result' } };
        },
      },
      fetcher,
    );
    stream.on('text', (delta) => (text += delta));
    stream.on('step', (step) => steps.push(step));
    const final = await stream.finalMessage();
    assert.equal(final.stop_reason, 'end_turn');
    assert.equal(text, 'Found it.');
    assert.deepEqual(ran, [{ name: 'web_search', args: { query: 'oracle selection' } }]);
    assert.deepEqual(steps, [{ tool: 'web_search', what: 'oracle selection', outcome: '1 result' }]);
    assert.equal(calls.length, 2);
    // The second request carries the first round: the call, its reasoning, and the tool's answer, after the conversation.
    const sent = calls[1].messages;
    assert.deepEqual(sent.slice(0, 2), calls[0].messages);
    assert.deepEqual(sent[2], {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should look. ',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"oracle selection"}' } }],
    });
    assert.deepEqual(sent[3], { role: 'tool', tool_call_id: 'call_1', content: 'Results: one' });
    assert.ok(calls[1].tools, 'the tools stay declared');
  });

  it('stops calling at the cap, and asks for the answer with calling off', async () => {
    const rounds = [callRound('c1', 'a'), callRound('c2', 'b'), callRound('c3', 'c'), answerRound('Enough.')];
    const { fetcher, calls } = fakeRounds(rounds);
    let made = 0;
    const stream = new deepseek.DeepSeekStream({ ...params, tools, maxToolCalls: 2, runTool: async () => ({ text: `r${(made += 1)}`, step: null }) }, fetcher);
    const final = await stream.finalMessage();
    assert.equal(final.stop_reason, 'end_turn');
    assert.equal(made, 2);
    assert.equal(calls.length, 3, 'two rounds of calls, then the answer');
    assert.equal(calls[2].tool_choice, 'none');
    assert.equal('tool_choice' in calls[1], false);
  });

  it('answers in one request when the model does not call, tools or no tools', async () => {
    const { fetcher, calls } = fakeRounds([answerRound('Plain.')]);
    let text = '';
    const stream = new deepseek.DeepSeekStream({ ...params, tools, runTool: async () => ({ text: '', step: null }) }, fetcher);
    stream.on('text', (delta) => (text += delta));
    assert.equal((await stream.finalMessage()).stop_reason, 'end_turn');
    assert.equal(text, 'Plain.');
    assert.equal(calls.length, 1);
  });

  it('reads arguments that did not parse as what they were', () => {
    assert.deepEqual(deepseek.parseArguments('{"query":"x"}'), { query: 'x' });
    assert.deepEqual(deepseek.parseArguments(''), {});
    assert.deepEqual(deepseek.parseArguments('{"query":'), { raw: '{"query":' });
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
  it('offers Claude, DeepSeek and Gemini, and knows who runs each model', () => {
    const providers = new Set(assistant.MODELS.map((m) => m.provider));
    assert.deepEqual([...providers], ['anthropic', 'deepseek', 'gemini']);
    assert.equal(assistant.providerOf('deepseek-flash').company, 'DeepSeek');
    assert.equal(assistant.providerOf('claude-opus-5').name, 'Claude');
    assert.equal(assistant.modelSpec('no-such-model').id, assistant.MODELS[0].id);
    assert.ok(assistant.MODELS.filter((m) => m.provider === 'deepseek').every((m) => m.vision));
  });

  it('sends both DeepSeek entries to deepseek-flash, and reads the retired ids as them', () => {
    assert.equal(assistant.modelSpec('deepseek-flash-fast').apiModel, 'deepseek-flash');
    assert.equal(assistant.modelSpec('deepseek-reasoner').id, 'deepseek-flash');
    assert.equal(assistant.modelSpec('deepseek-chat').id, 'deepseek-flash-fast');
    assert.equal(assistant.providerOf('deepseek-chat').id, 'deepseek');
  });

  it('tells a Claude key from a DeepSeek one', () => {
    assert.ok(assistant.looksLikeKey('sk-ant-api03-abc', 'anthropic'));
    assert.ok(assistant.looksLikeKey('sk-0123456789abcdef', 'deepseek'));
    assert.ok(!assistant.looksLikeKey('sk-ant-api03-abc', 'deepseek'));
    assert.ok(!assistant.looksLikeKey('sk-0123456789abcdef', 'anthropic'));
  });

  it('keeps which model wrote an answer in the history, and nothing for older chats', () => {
    const [chat] = assistant.normaliseHistory([
      { id: 'c1', title: 'x', turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', model: 'deepseek-flash' }] },
    ]);
    assert.equal(chat.turns[1].model, 'deepseek-flash');
    assert.equal(chat.turns[0].model, undefined);
  });
});
