// A person's GitHub token kept by the Worker (worker/github.js): checked with
// GitHub, sealed, never handed back, used only for the calls Reader makes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedCall, handleGithub } from '../worker/github.js';

function setup(t, { expires = '2027-01-31 00:00:00 UTC', scopes = null } = {}) {
  const kept = new Map();
  const kv = { get: async (key) => kept.get(key) ?? null, put: async (key, value) => void kept.set(key, value), delete: async (key) => void kept.delete(key) };
  const env = { SESSIONS: kv, SECRETS_KEY: 's'.repeat(44) };
  const sent = [];
  let tokenWorks = true;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.Authorization, body: init.body });
    if (!tokenWorks) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    const headers = { 'Content-Type': 'application/json', ...(expires ? { 'github-authentication-token-expiration': expires } : {}), ...(scopes ? { 'x-oauth-scopes': scopes } : {}) };
    if (String(url).endsWith('/user')) return new Response(JSON.stringify({ login: 'saurav' }), { headers });
    return new Response(JSON.stringify({ ok: true }), { headers });
  });
  const tools = { json: (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers }), headers: {}, authorized: async () => ({ email: 'me@uni.edu' }) };
  const ask = (path, init = {}) => handleGithub(new Request(`https://w${path}`, init), env, path, tools);
  return { kept, env, sent, ask, tools, revoke: () => (tokenWorks = false) };
}

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';

describe('GitHub token kept by the Worker', () => {
  it('checks the token with GitHub, keeps it sealed, and never hands it back', async (t) => {
    const { kept, sent, ask } = setup(t);
    assert.equal((await (await ask('/github/token')).json()).connected, false);
    assert.equal((await ask('/github/token', { method: 'PUT', body: JSON.stringify({ token: 'nope' }) })).status, 400);
    const put = await ask('/github/token', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) });
    assert.equal(put.status, 200);
    const said = await put.json();
    assert.deepEqual([said.connected, said.login, said.kind, said.expiresAt], [true, 'saurav', 'fine-grained', '2027-01-31T00:00:00.000Z']);
    assert.equal(sent[0].url, 'https://api.github.com/user');
    const all = JSON.stringify([...kept.entries()]);
    assert.ok(!all.includes(TOKEN), 'the token is not in KV in the clear');
    assert.ok(!all.includes('saurav') && !all.includes('me@uni.edu'), 'neither the login nor the email is');
    const status = await (await ask('/github/token')).json();
    assert.ok(!JSON.stringify(status).includes(TOKEN), 'a page is never told the token');
    assert.equal(status.login, 'saurav');
  });

  it('makes the allowed calls with the kept token, and refuses others', async (t) => {
    const { sent, ask } = setup(t);
    await ask('/github/token', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) });
    const read = await ask('/github/api/repos/me/paper/git/trees/main?recursive=1');
    assert.equal(read.status, 200);
    assert.equal(sent.at(-1).url, 'https://api.github.com/repos/me/paper/git/trees/main?recursive=1');
    assert.equal(sent.at(-1).auth, `Bearer ${TOKEN}`);
    const before = sent.length;
    for (const [path, init] of [
      ['/github/api/repos/me/paper/hooks', {}],
      ['/github/api/user/keys', {}],
      ['/github/api/repos/me/paper', { method: 'DELETE' }],
      ['/github/api/repos/me/paper', { method: 'PATCH', body: JSON.stringify({ private: false }) }],
      ['/github/api/repos/me/paper', { method: 'PATCH', body: JSON.stringify({ private: true, name: 'renamed' }) }],
      ['/github/api/user/repos', { method: 'POST', body: JSON.stringify({ name: 'x', private: false }) }],
      ['/github/api/repos/me/paper/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: 'abc', force: true }) }],
      ['/github/api/repos/me/paper/actions/secrets', {}],
      ['/github/api/repos/me/paper/git/blobs/%2e%2e', {}],
    ]) {
      assert.equal((await ask(path, init)).status, 403, `${init.method ?? 'GET'} ${path}`);
    }
    assert.equal(sent.length, before, 'none of them reached GitHub');
    assert.equal((await ask('/github/api/user/repos', { method: 'POST', body: JSON.stringify({ name: 'x-code', private: true, auto_init: true }) })).status, 200);
  });

  it('forgets a token GitHub no longer takes, and one past its expiry', async (t) => {
    const first = setup(t);
    await first.ask('/github/token', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) });
    first.revoke();
    const refused = await first.ask('/github/api/user');
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).needToken, true);
    assert.equal(first.kept.size, 0);
  });

  it('forgets a token past its expiry date', async (t) => {
    const { kept, ask } = setup(t, { expires: '2020-01-01 00:00:00 UTC' });
    await ask('/github/token', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) });
    const status = await (await ask('/github/token')).json();
    assert.deepEqual([status.connected, status.forgotten], [false, 'expired']);
    assert.equal(kept.size, 0);
  });

  it('keeps nothing without SECRETS_KEY, or for someone not signed in', async (t) => {
    const { env, tools } = setup(t);
    const noKey = await handleGithub(new Request('https://w/github/token', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) }), { ...env, SECRETS_KEY: '' }, '/github/token', tools);
    assert.equal(noKey.status, 501);
    const nobody = await handleGithub(new Request('https://w/github/token'), env, '/github/token', { ...tools, authorized: async () => null });
    assert.equal(nobody.status, 401);
  });

  it('allows exactly the calls Reader makes', () => {
    assert.ok(allowedCall('GET', '/user', null));
    assert.ok(allowedCall('GET', '/repos/me/paper/git/ref/heads/main', null));
    assert.ok(allowedCall('PATCH', '/repos/me/paper/git/refs/heads/main', { sha: 'abc', force: false }));
    assert.ok(allowedCall('POST', '/repos/me/paper/git/blobs', { content: 'x', encoding: 'base64' }));
    assert.equal(allowedCall('GET', '/repos/me/paper/collaborators', null), null);
    assert.equal(allowedCall('PUT', '/repos/me/paper/contents/x', {}), null);
  });
});
