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

  it('signs in with GitHub (OAuth App): PKCE, one-time state, the token kept, the grant revoked on disconnect', async (t) => {
    const kept = new Map();
    const kv = { get: async (key) => kept.get(key) ?? null, put: async (key, value) => void kept.set(key, value), delete: async (key) => void kept.delete(key) };
    const env = { SESSIONS: kv, SECRETS_KEY: 's'.repeat(44), GITHUB_OAUTH_CLIENT_ID: 'oauth-id', GITHUB_OAUTH_CLIENT_SECRET: 'oauth-secret' };
    const sent = [];
    let verifier = null;
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      sent.push({ url: String(url), method: init.method ?? 'GET', body: init.body, auth: init.headers?.Authorization });
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        verifier = JSON.parse(init.body).code_verifier;
        return Response.json({ access_token: 'gho_signedin', scope: 'repo', token_type: 'bearer' });
      }
      if (String(url).endsWith('/user')) return Response.json({ login: 'saurav' });
      return new Response(null, { status: 204 });
    });
    const tools = { json: (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers }), headers: {}, authorized: async () => ({ email: 'me@uni.edu' }), origins: ['https://saurav717.github.io'] };
    const ask = (path, init = {}) => handleGithub(new Request(`https://w.dev${path}`, init), env, path.split('?')[0], tools);
    const methods = (await (await ask('/github/token')).json()).methods;
    assert.deepEqual([methods.oauth, methods.app], [true, false]);
    assert.equal((await ask('/github/oauth/start', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ via: 'oauth' }) })).status, 403);
    assert.equal((await ask('/github/oauth/start', { method: 'POST', headers: { Origin: 'https://saurav717.github.io' }, body: JSON.stringify({ via: 'app' }) })).status, 501, 'no GitHub App set up');
    const { url } = await (await ask('/github/oauth/start', { method: 'POST', headers: { Origin: 'https://saurav717.github.io' }, body: JSON.stringify({ via: 'oauth' }) })).json();
    const go = new URL(url);
    assert.equal(go.origin + go.pathname, 'https://github.com/login/oauth/authorize');
    assert.deepEqual([go.searchParams.get('client_id'), go.searchParams.get('scope'), go.searchParams.get('code_challenge_method'), go.searchParams.get('redirect_uri')], ['oauth-id', 'repo', 'S256', 'https://w.dev/github/callback']);
    assert.ok(![...kept.values()].some((value) => value.includes('me@uni.edu')), 'the state names no one in the clear');
    const state = go.searchParams.get('state');
    const back = await ask(`/github/callback?code=abc&state=${state}`);
    assert.equal(back.status, 200);
    const page = await back.text();
    assert.match(page, /postMessage\(\{"type":"reader-github","ok":true,"login":"saurav","via":"oauth"\},"https:\/\/saurav717\.github\.io"\)/);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(challenge, go.searchParams.get('code_challenge'), 'PKCE: the verifier sent matches the challenge');
    assert.equal((await ask(`/github/callback?code=abc&state=${state}`)).status, 400, 'a state is used once');
    const status = await (await ask('/github/token')).json();
    assert.deepEqual([status.connected, status.login, status.via, status.scopes], [true, 'saurav', 'oauth', 'repo']);
    assert.ok(![...kept.values()].some((value) => value.includes('gho_signedin')));
    await ask('/github/token', { method: 'DELETE' });
    const revoke = sent.find((item) => item.url === 'https://api.github.com/applications/oauth-id/grant');
    assert.equal(revoke?.method, 'DELETE');
    assert.equal(revoke.auth, `Basic ${btoa('oauth-id:oauth-secret')}`);
    assert.equal(kept.size, 0);
  });

  it('a GitHub App’s eight-hour token is renewed with its refresh token', async (t) => {
    const kept = new Map();
    const kv = { get: async (key) => kept.get(key) ?? null, put: async (key, value) => void kept.set(key, value), delete: async (key) => void kept.delete(key) };
    const env = { SESSIONS: kv, SECRETS_KEY: 's'.repeat(44), GITHUB_APP_CLIENT_ID: 'app-id', GITHUB_APP_CLIENT_SECRET: 'app-secret', GITHUB_APP_SLUG: 'reader-papers' };
    let issued = 0;
    const used = [];
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        issued += 1;
        const body = JSON.parse(init.body);
        // The first token is already all but spent: the next use renews it.
        return Response.json({ access_token: `ghu_${issued}`, expires_in: issued === 1 ? 60 : 28800, refresh_token: `ghr_${issued}`, refresh_token_expires_in: 15897600, grant: body.grant_type ?? 'code' });
      }
      used.push(init.headers?.Authorization);
      if (String(url).endsWith('/user')) return Response.json({ login: 'saurav' });
      return Response.json({ ok: true });
    });
    const tools = { json: (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers }), headers: {}, authorized: async () => ({ email: 'me@uni.edu' }), origins: ['https://saurav717.github.io'] };
    const ask = (path, init = {}) => handleGithub(new Request(`https://w.dev${path}`, init), env, path.split('?')[0], tools);
    const { url } = await (await ask('/github/oauth/start', { method: 'POST', headers: { Origin: 'https://saurav717.github.io' }, body: JSON.stringify({ via: 'app' }) })).json();
    assert.equal(new URL(url).searchParams.get('scope'), null, 'a GitHub App asks for no scopes: its permissions are its own');
    await ask(`/github/callback?code=abc&state=${new URL(url).searchParams.get('state')}`);
    const status = await (await ask('/github/token')).json();
    assert.deepEqual([status.via, status.renews, status.methods.appSlug], ['app', true, 'reader-papers']);
    assert.equal(issued, 2, 'renewed as it was read');
    await ask('/github/api/user');
    assert.equal(used.at(-1), 'Bearer ghu_2');
    assert.ok(![...kept.values()].some((value) => value.includes('ghr_')), 'the refresh token is sealed too');
  });

  it('reaches the GitHub routes through the Worker itself, whatever the method', async () => {
    // Through the Worker's own front door (worker/index.js), not the handler alone: a route it turns away by method never
    // gets here. Not signed in, each is refused for that (401) — never "method not allowed" (405).
    const { default: worker } = await import('../worker/index.js');
    const env = { READER_TOKEN: 'r'.repeat(32), SECRETS_KEY: 's'.repeat(44), SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} } };
    for (const [method, path] of [['POST', '/github/oauth/start'], ['PUT', '/github/token'], ['DELETE', '/github/token'], ['POST', '/github/api/repos/me/paper/git/blobs'], ['PATCH', '/github/api/repos/me/paper/git/refs/heads/main']]) {
      const answer = await worker.fetch(new Request(`https://w.dev${path}`, { method, headers: { Origin: 'https://saurav717.github.io', 'Content-Type': 'application/json' }, ...(method === 'DELETE' ? {} : { body: '{}' }) }), env);
      assert.equal(answer.status, 401, `${method} ${path}`);
    }
  });
});
