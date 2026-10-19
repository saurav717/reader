// The agent's answers written on the Worker (worker/agentJobs.js): that a job
// started with the request the page would have sent the provider keeps what
// the provider streams, and hands it back from any offset to whoever started
// it and nobody else; that a person's own key is gone once the provider has
// answered; that a refusal comes back with the provider's status; that Stop
// ends it; and that the owner's switch on /site/agent-jobs turns starting
// one off for everyone. Cloudflare's storage is a Map; the provider is a
// stand-in that streams a few events.
//
//   node --test scripts/agent-jobs.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { AgentJob } = await import('../worker/agentJobs.js');
const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    deleteAll: async () => void map.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async (at) => void (alarm = at),
    getAlarm: async () => alarm,
  };
}

const SSE = ['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n'];

/** A provider that streams SSE, one event at a time, and remembers the key it was asked with. */
function provider({ status = 200, events = SSE } = {}) {
  const seen = { keys: [] };
  const fetchImpl = async (_url, init) => {
    seen.keys.push(init.headers['x-api-key'] || init.headers.Authorization);
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) { events.forEach((e) => controller.enqueue(encoder.encode(e))); controller.close(); } }), { status: 200 });
  };
  return { seen, fetchImpl };
}

/** An AGENT_JOBS binding: one real AgentJob per name, over memory storage. */
function jobsBinding(fetchImpl, envRef) {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) objects.set(name, new AgentJob({ storage: memoryStorage() }, envRef(), { fetchImpl }));
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
}

function kv() {
  const map = new Map();
  return { get: async (key) => map.get(key) ?? null, put: async (key, value) => void map.set(key, value) };
}

const SECRET = 'owner-token';
function env(options) {
  const p = provider(options);
  const e = { READER_TOKEN: SECRET, ANTHROPIC_KEY: 'sk-ant-site', AI_FOR: 'everyone', SESSIONS: kv() };
  e.AGENT_JOBS = jobsBinding(p.fetchImpl, () => e);
  return { e, seen: p.seen };
}
const call = (e, path, { pass, body, headers = {} } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: 'https://koios.dev', ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil() {} },
  );

const ID = 'a'.repeat(32);
const request = { model: 'claude-sonnet-5', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'Write the project' }] };
const object = (e, id = ID) => e.AGENT_JOBS.objects.get(`agent-job:${id}`);

describe('the agent’s jobs on the Worker', () => {
  it('keeps what the provider streamed and hands it back from any offset, after the page was gone', async () => {
    const { e, seen } = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const started = await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } });
    assert.equal(started.status, 200);
    // The page is gone; the alarm runs the job anyway.
    await object(e).alarm();
    assert.deepEqual(seen.keys, ['sk-ant-site']);
    const whole = await (await call(e, `/agent-jobs/read?id=${ID}&from=0&wait=0`, { pass })).json();
    assert.equal(whole.data, SSE.join(''));
    assert.equal(whole.done, true);
    assert.equal(whole.status, 200);
    const rest = await (await call(e, `/agent-jobs/read?id=${ID}&from=${SSE[0].length}&wait=0`, { pass: await issuePass('a@gmail.com', SECRET) })).json();
    assert.equal(rest.data, SSE.slice(1).join(''));
  });

  it('shows the job to nobody else, and starts nothing without a pass', async () => {
    const { e } = env();
    await call(e, '/agent-jobs/start', { pass: await issuePass('a@gmail.com', SECRET), body: { id: ID, provider: 'anthropic', request } });
    const theirs = await call(e, `/agent-jobs/read?id=${ID}&wait=0`, { pass: await issuePass('b@gmail.com', SECRET) });
    assert.equal(theirs.status, 403);
    assert.equal((await call(e, '/agent-jobs/start', { body: { id: 'b'.repeat(32), provider: 'anthropic', request } })).status, 401);
  });

  it('holds a person’s own key only until the provider has answered', async () => {
    const { e, seen } = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request }, headers: { 'X-Provider-Key': 'sk-ant-mine' } });
    const storage = object(e).state.storage;
    assert.equal(storage.map.get('key'), 'sk-ant-mine');
    await object(e).alarm();
    assert.deepEqual(seen.keys, ['sk-ant-mine']);
    assert.equal(storage.map.has('key'), false);
  });

  it('hands back a refusal with the provider’s status', async () => {
    const { e } = env({ status: 401 });
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } });
    await object(e).alarm();
    const read = await (await call(e, `/agent-jobs/read?id=${ID}&wait=0`, { pass })).json();
    assert.equal(read.status, 401);
    assert.equal(read.done, true);
    assert.match(read.data, /invalid x-api-key/);
  });

  it('is joined, not started again, when the page sends the same start twice', async () => {
    const { e } = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } });
    const again = await (await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } })).json();
    assert.equal(again.existing, true);
  });

  it('stops on Stop, before or while it runs', async () => {
    const { e } = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } });
    const stopped = await (await call(e, '/agent-jobs/stop', { pass, body: { id: ID } })).json();
    assert.equal(stopped.done, true);
    assert.equal(stopped.stopped, true);
    await object(e).alarm();
    const read = await (await call(e, `/agent-jobs/read?id=${ID}&wait=0`, { pass })).json();
    assert.equal(read.data, '');
    assert.equal(read.stopped, true);
  });

  it('marks a job cut off when its alarm ran before and never finished', async () => {
    const { e } = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } });
    const storage = object(e).state.storage;
    storage.map.set('meta', { ...storage.map.get('meta'), status: 'running' });
    await object(e).alarm();
    const read = await (await call(e, `/agent-jobs/read?id=${ID}&wait=0`, { pass })).json();
    assert.equal(read.done, true);
    assert.equal(read.interrupted, true);
  });

  it('is the owner’s to turn off for everyone, and then starts nothing', async () => {
    const { e } = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    assert.equal((await (await call(e, '/site/agent-jobs')).json()).enabled, true);
    assert.equal((await call(e, '/site/agent-jobs', { pass, body: { enabled: false } })).status, 401);
    const off = await call(e, '/site/agent-jobs', { pass: SECRET, body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal((await (await call(e, '/site/agent-jobs')).json()).enabled, false);
    const refused = await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).off, true);
    await call(e, '/site/agent-jobs', { pass: SECRET, body: { enabled: true } });
    assert.equal((await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'anthropic', request } })).status, 200);
  });

  it('says it is unavailable where no AGENT_JOBS object is bound', async () => {
    const { e } = env();
    delete e.AGENT_JOBS;
    assert.deepEqual(await (await call(e, '/site/agent-jobs')).json(), { enabled: false, available: false, stored: true });
    assert.equal((await call(e, '/agent-jobs/start', { pass: await issuePass('a@gmail.com', SECRET), body: { id: ID, provider: 'anthropic', request } })).status, 501);
  });
});

// The page's side (src/lib/agentJobs.ts), against the Worker above: the fetch
// the provider's client is given starts the job, and its answer is the
// provider's stream as it came — read on through a lost connection.
describe('the page’s fetch for a job', async () => {
  const pass = await issuePass('a@gmail.com', SECRET);
  globalThis.localStorage = {
    store: new Map([['reader.settings', JSON.stringify({ proxyBase: 'https://proxy.example', proxyToken: pass })]]),
    getItem(key) {
      return this.store.get(key) ?? null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
    removeItem(key) {
      this.store.delete(key);
    },
  };
  const { cleanup, load } = await import('./bundle.mjs');
  const jobs = await load('src/lib/agentJobs.ts');
  const realFetch = globalThis.fetch;
  /** The browser's fetch, to the Worker under test: `drop` calls to /read fail as a lost connection would. */
  const route = (e, { drop = 0 } = {}) => {
    const links = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/agent-jobs/read' && drop-- > 0) throw new TypeError('Failed to fetch');
      const answer = await worker.fetch(new Request(url, { ...init, headers: { ...init.headers, Origin: 'https://koios.dev' } }), e, { waitUntil() {} });
      // The alarm, as Cloudflare would run it, once the job is in.
      if (url.pathname === '/agent-jobs/start') {
        const id = JSON.parse(init.body).id;
        setTimeout(() => void object(e, id).alarm(), 5);
      }
      return answer;
    };
    return links;
  };

  it('hands the provider’s client the stream the job kept', async () => {
    const { e } = env();
    route(e);
    const id = jobs.newJobId();
    const response = await jobs.jobFetch({ id, provider: 'anthropic' })('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), SSE.join(''));
  });

  it('waits out a lost connection and reads on from where it was', async () => {
    const { e } = env();
    route(e, { drop: 1 });
    const links = [];
    const response = await jobs.jobFetch({ id: jobs.newJobId(), provider: 'anthropic', onLink: (online) => links.push(online) })('x', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(await response.text(), SSE.join(''));
    assert.ok(links.includes(false), 'it said the connection was lost');
    assert.equal(links[links.length - 1], true);
  });

  it('passes on the provider’s refusal as one not to retry', async () => {
    const { e } = env({ status: 401 });
    route(e);
    const response = await jobs.jobFetch({ id: jobs.newJobId(), provider: 'anthropic' })('x', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-should-retry'), 'false');
  });

  it('is off when the owner says so', async () => {
    const { e } = env();
    route(e);
    assert.equal((await jobs.serverJobs(true)).enabled, true);
    await call(e, '/site/agent-jobs', { pass: SECRET, body: { enabled: false } });
    assert.equal((await jobs.serverJobs(true)).enabled, false);
  });

  it('is parsed by the Anthropic SDK as the provider’s own stream', async () => {
    const real = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"```python file=main.py\\nprint(1)\\n```"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { e } = env({ events: real });
    route(e, { drop: 1 });
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: 'site-key', maxRetries: 0, fetch: jobs.jobFetch({ id: jobs.newJobId(), provider: 'anthropic' }) });
    let text = '';
    const stream = client.messages.stream(request).on('text', (delta) => (text += delta));
    const final = await stream.finalMessage();
    assert.equal(text, '```python file=main.py\nprint(1)\n```');
    assert.equal(final.stop_reason, 'end_turn');
  });

  it('cleans up', async () => {
    globalThis.fetch = realFetch;
    await cleanup();
  });
});
