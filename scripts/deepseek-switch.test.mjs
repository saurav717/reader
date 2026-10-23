// The site's DeepSeek switch (worker/deepseekSwitch.js): off unless the owner
// turns it on, and off nothing reaches DeepSeek — /health hides the key, the
// relay and the agent's jobs refuse the provider, the contribution reader says
// it is not configured — while Claude goes on as before. The owner alone sets
// it, and the choice is kept in SESSIONS for everyone.
//
//   node --test scripts/deepseek-switch.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function kv() {
  const map = new Map();
  return { get: async (key) => map.get(key) ?? null, put: async (key, value) => void map.set(key, value) };
}

const SECRET = 'owner-token';
/** An AGENT_JOBS binding that is there, so the start route gets as far as the switch; nothing here needs a job to run. */
const jobs = () => ({ idFromName: (name) => name, get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }) });
const env = () => ({ READER_TOKEN: SECRET, ANTHROPIC_KEY: 'sk-ant-site', DEEPSEEK_KEY: 'sk-ds-site', AI_FOR: 'everyone', SESSIONS: kv(), AGENT_JOBS: jobs() });
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
const chat = { model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'Hello' }] };
const ID = 'a'.repeat(32);

describe('the site’s DeepSeek switch', () => {
  it('is off until the owner turns it on, and /health says so', async () => {
    const e = env();
    assert.deepEqual(await (await call(e, '/site/deepseek')).json(), { enabled: false, stored: true });
    const health = await (await call(e, '/health')).json();
    assert.equal(health.deepseek, false);
    assert.equal(health.ai.deepseek, false);
    assert.equal(health.ai.anthropic, true);
  });

  it('off, lets nothing reach DeepSeek: the relay, the agent’s jobs and the contribution reader all refuse', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    const relay = await call(e, '/ai/deepseek', { pass, body: chat });
    assert.equal(relay.status, 403);
    assert.equal((await relay.json()).off, true);
    const job = await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'deepseek', request: chat } });
    assert.equal(job.status, 403);
    assert.equal((await job.json()).off, true);
    assert.deepEqual(await (await call(e, '/contributions?id=2301.00001')).json(), { configured: false });
    // A key of the person's own is no way round it either.
    assert.equal((await call(e, '/agent-jobs/start', { pass, body: { id: ID, provider: 'deepseek', request: chat }, headers: { 'X-Provider-Key': 'sk-ds-mine' } })).status, 403);
  });

  it('is the owner’s alone to set, with true or false, and the choice holds for everyone', async () => {
    const e = env();
    const pass = await issuePass('a@gmail.com', SECRET);
    assert.equal((await call(e, '/site/deepseek', { pass, body: { enabled: true } })).status, 401);
    assert.equal((await call(e, '/site/deepseek', { body: { enabled: true } })).status, 401);
    assert.equal((await call(e, '/site/deepseek', { pass: SECRET, body: { enabled: 'yes' } })).status, 400);
    const on = await call(e, '/site/deepseek', { pass: SECRET, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { enabled: true, stored: true });
    assert.equal(await e.SESSIONS.get('site:deepseek'), 'on');
    const health = await (await call(e, '/health')).json();
    assert.equal(health.deepseek, true);
    assert.equal(health.ai.deepseek, true);
    // On, the relay gets past the switch (and fails only at DeepSeek itself, which there is none of here).
    const relay = await call(e, '/ai/deepseek', { pass, body: chat });
    assert.notEqual(relay.status, 403);
    assert.equal((await call(e, '/site/deepseek', { pass: SECRET, body: { enabled: false } })).status, 200);
    assert.equal((await (await call(e, '/health')).json()).deepseek, false);
  });

  it('cannot be kept, and so stays off, where no SESSIONS namespace is bound', async () => {
    const e = env();
    delete e.SESSIONS;
    assert.deepEqual(await (await call(e, '/site/deepseek')).json(), { enabled: false, stored: false });
    assert.equal((await call(e, '/site/deepseek', { pass: SECRET, body: { enabled: true } })).status, 501);
  });

  it('leaves Claude alone', async () => {
    const e = env();
    const relay = await call(e, '/ai/anthropic', { pass: await issuePass('a@gmail.com', SECRET), body: { model: 'claude-sonnet-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'Hi' }] } });
    assert.notEqual(relay.status, 403);
  });
});
