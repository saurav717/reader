// A person's GitHub token, kept by this Worker rather than in their browser:
// sealed for them alone (worker/secrets.js), never handed back to any page,
// and used only through a narrow door — the few GitHub API calls Reader
// makes (commits of files, a private repository made, a repository read or
// turned private), each checked here before the token is put on it.
//
//   GET    /github/token        whose it is, what it may do, when it expires — never the token —
//                               and which ways of connecting this server offers (`methods`)
//   PUT    /github/token        { token }: a pasted token, checked with GitHub, then kept
//   DELETE /github/token        forgotten, and the sign-in revoked with GitHub
//   POST   /github/oauth/start  { via: 'oauth' | 'app' }: where to send the person to sign in
//   GET    /github/callback     where GitHub sends them back: the code exchanged, the token kept
//   *      /github/api/…        one of the allowed calls, made with the kept token
//
// Three ways in, the person's choice (Projects → Connections):
//   - Sign in with GitHub (an OAuth App: GITHUB_OAUTH_CLIENT_ID / _SECRET): one click, as VS Code
//     does; the token reaches every repository of theirs (the `repo` scope) until they disconnect.
//   - Reader's GitHub App (GITHUB_APP_CLIENT_ID / _SECRET, GITHUB_APP_SLUG): they pick which
//     repositories it may use, it may only do what the app is allowed (Contents, Administration),
//     and its token lasts eight hours, renewed here with a refresh token that lasts six months.
//   - A token pasted (fine-grained or classic).
// Both sign-ins use PKCE and a one-time `state` bound to the person, kept sealed for ten minutes.
//
// For anyone signed in (a pass from the Worker), as the LaTeX routes are. A
// token GitHub no longer takes (expired, revoked) is forgotten when it says
// so; one unused for UNUSED_DAYS, too.

import { SECRETS_MISSING, openSecret, sealSecret, secretsKey, secretsReady, staleUse, unusedTooLong } from './secrets.js';

const GITHUB = 'https://api.github.com';
const NAME = '[A-Za-z0-9_.-]{1,100}';
const REPO = `/repos/${NAME}/${NAME}`;
const SHA = '[A-Za-z0-9]{1,64}';
const MAX_BODY = 60 * 1024 * 1024;

/**
 * The calls a page may make with the kept token: what src/lib/github.ts does,
 * and nothing else — no settings, keys, hooks, collaborators, secrets or
 * deletions. `body` checks a write's body when it matters.
 */
const ALLOWED = [
  { method: 'GET', path: new RegExp('^/user$') },
  { method: 'GET', path: new RegExp('^/user/repos$') },
  // A repository made: always private, only these fields.
  { method: 'POST', path: new RegExp('^/user/repos$'), body: (b) => onlyKeys(b, ['name', 'description', 'private', 'auto_init']) && typeof b.name === 'string' && b.private === true },
  { method: 'GET', path: new RegExp(`^${REPO}$`) },
  // A repository changed: only ever made private.
  { method: 'PATCH', path: new RegExp(`^${REPO}$`), body: (b) => onlyKeys(b, ['private']) && b.private === true },
  { method: 'GET', path: new RegExp(`^${REPO}/git/ref/heads/.{1,250}$`) },
  // A branch moved: never forced.
  { method: 'PATCH', path: new RegExp(`^${REPO}/git/refs/heads/.{1,250}$`), body: (b) => onlyKeys(b, ['sha', 'force']) && typeof b.sha === 'string' && b.force !== true },
  { method: 'GET', path: new RegExp(`^${REPO}/git/commits/${SHA}$`) },
  { method: 'POST', path: new RegExp(`^${REPO}/git/commits$`) },
  { method: 'GET', path: new RegExp(`^${REPO}/git/trees/.{1,250}$`) },
  { method: 'POST', path: new RegExp(`^${REPO}/git/trees$`) },
  { method: 'GET', path: new RegExp(`^${REPO}/git/blobs/${SHA}$`) },
  { method: 'POST', path: new RegExp(`^${REPO}/git/blobs$`) },
];

const onlyKeys = (body, keys) => Boolean(body) && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));

/** The allowed call a request is, or null. Paths are compared decoded, so no `..` or encoded slash slips past. */
export function allowedCall(method, path, body) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.split('/').some((part) => part === '..' || part === '.')) return null;
  const rule = ALLOWED.find((item) => item.method === method && item.path.test(path));
  if (!rule) return null;
  if (rule.body && !rule.body(body)) return null;
  return rule;
}

export const isGithubPath = (path) => path === '/github/token' || path === '/github/oauth/start' || path === '/github/callback' || path.startsWith('/github/api/');

/** The sign-ins this server offers: an OAuth App, a GitHub App, both or neither (a token is always). */
export function githubMethods(env) {
  return {
    oauth: Boolean(String(env.GITHUB_OAUTH_CLIENT_ID || '').trim() && String(env.GITHUB_OAUTH_CLIENT_SECRET || '').trim()),
    app: Boolean(String(env.GITHUB_APP_CLIENT_ID || '').trim() && String(env.GITHUB_APP_CLIENT_SECRET || '').trim()),
    appSlug: String(env.GITHUB_APP_SLUG || '').trim() || null,
  };
}

const clientOf = (env, via) => (via === 'app' ? { id: String(env.GITHUB_APP_CLIENT_ID || '').trim(), secret: String(env.GITHUB_APP_CLIENT_SECRET || '').trim() } : { id: String(env.GITHUB_OAUTH_CLIENT_ID || '').trim(), secret: String(env.GITHUB_OAUTH_CLIENT_SECRET || '').trim() });
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const STATE_TTL_S = 600;
const stateKey = (state) => `github-state:${state}`;

/** GitHub's token endpoint: a code (with its PKCE verifier) or a refresh token, for a token. */
async function tokenFromGithub(env, via, params) {
  const client = clientOf(env, via);
  const answer = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'reader-worker' },
    body: JSON.stringify({ client_id: client.id, client_secret: client.secret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const said = await answer.json().catch(() => ({}));
  if (!answer.ok || !said.access_token) throw new Error(said.error_description || said.error || `GitHub answered ${answer.status}`);
  const now = Date.now();
  return {
    token: said.access_token,
    scopes: typeof said.scope === 'string' ? said.scope : null,
    expiresAt: said.expires_in ? new Date(now + Number(said.expires_in) * 1000).toISOString() : null,
    refresh: said.refresh_token || null,
    refreshExpiresAt: said.refresh_token_expires_in ? new Date(now + Number(said.refresh_token_expires_in) * 1000).toISOString() : null,
  };
}

/** The sign-in given back to GitHub: the person's grant to the app revoked, so the token opens nothing. */
async function revokeWithGithub(env, record) {
  if (record.via !== 'oauth' && record.via !== 'app') return;
  const client = clientOf(env, record.via);
  if (!client.id || !client.secret) return;
  await fetch(`${GITHUB}/applications/${client.id}/grant`, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${btoa(`${client.id}:${client.secret}`)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'reader-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: record.token }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

const looksLikeToken = (token) => typeof token === 'string' && token.length >= 20 && token.length <= 255 && /^(github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_]+$/.test(token);
const kindOf = (token) => (token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') ? 'classic' : token.startsWith('gho_') ? 'oauth' : 'app');

/** GitHub's own expiry for a token, from the header it answers with (none: never expires). */
function expiryOf(response) {
  const said = response.headers.get('github-authentication-token-expiration');
  if (!said) return null;
  const at = Date.parse(said.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

const githubHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'reader-worker',
});

/**
 * The kept record, opened: `{ token, login, via, kind, scopes, expiresAt, refresh, refreshExpiresAt,
 * addedAt, lastUsedAt }`, or `{ gone }` when it was just forgotten, or null. A GitHub App's
 * token, near its eight hours, is renewed here with its refresh token first.
 */
async function readRecord(env, kv, owner) {
  const key = await secretsKey(env, 'github', owner);
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw);
    const token = await openSecret(env, owner, 'github-token', kept.token);
    const refresh = kept.refresh ? await openSecret(env, owner, 'github-refresh', kept.refresh) : null;
    const now = Date.now();
    const past = (at) => Boolean(at) && Date.parse(at) <= now;
    // Over for good: past what can renew it (or, with nothing to renew it, its own expiry), unused half a year, or no longer opening.
    const over = refresh ? past(kept.refreshExpiresAt) : past(kept.expiresAt);
    if (!token || over || unusedTooLong(kept.lastUsedAt || kept.addedAt)) {
      await kv.delete(key);
      return { gone: over ? 'expired' : 'unused' };
    }
    const record = { ...kept, token, refresh, login: (await openSecret(env, owner, 'github-login', kept.login)) ?? '' };
    // Renewed when it has under five minutes left.
    if (refresh && kept.expiresAt && Date.parse(kept.expiresAt) - now < 5 * 60_000) {
      try {
        const renewed = await tokenFromGithub(env, kept.via, { grant_type: 'refresh_token', refresh_token: refresh });
        Object.assign(record, { token: renewed.token, expiresAt: renewed.expiresAt, refresh: renewed.refresh ?? refresh, refreshExpiresAt: renewed.refreshExpiresAt ?? kept.refreshExpiresAt });
        await writeRecord(env, kv, owner, record);
      } catch {
        // GitHub won't renew it (the app was uninstalled, or the grant revoked): forgotten.
        await kv.delete(key);
        return { gone: 'expired' };
      }
    }
    return record;
  } catch {
    return null;
  }
}

async function writeRecord(env, kv, owner, record) {
  const { token, login, refresh, gone: _gone, ...rest } = record;
  await kv.put(
    await secretsKey(env, 'github', owner),
    JSON.stringify({
      ...rest,
      token: await sealSecret(env, owner, 'github-token', token),
      login: await sealSecret(env, owner, 'github-login', login),
      ...(refresh ? { refresh: await sealSecret(env, owner, 'github-refresh', refresh) } : {}),
    }),
  );
}

/** Who a token is, from GitHub: the login, and the expiry and scopes it answers with. */
async function whoseToken(token) {
  const answer = await fetch(`${GITHUB}/user`, { headers: githubHeaders(token), signal: AbortSignal.timeout(15_000) });
  if (answer.status === 401) throw Object.assign(new Error('GitHub rejected the token: it may have expired or been revoked.'), { refused: true });
  if (!answer.ok) throw new Error(`GitHub answered ${answer.status}.`);
  const user = await answer.json().catch(() => ({}));
  return { login: String(user.login || ''), scopes: answer.headers.get('x-oauth-scopes'), expiresAt: expiryOf(answer) };
}

/**
 * The page GitHub sends the person back to, in the window that opened for
 * the sign-in: it tells the page that opened it (only that origin) how it
 * went, and closes; with no opener, it says so and links back.
 */
function callbackPage(origin, outcome) {
  const message = JSON.stringify({ type: 'reader-github', ...outcome }).replace(/</g, '\\u003c');
  const target = JSON.stringify(origin || '').replace(/</g, '\\u003c');
  const text = outcome.ok ? `Connected to GitHub as ${outcome.login}. You can close this window.` : `GitHub sign-in didn’t finish: ${outcome.error}`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Koios · GitHub</title>
<body style="font:15px system-ui,sans-serif;margin:48px auto;max-width:420px;padding:0 16px;color:#1a1a17;background:#fbfaf6">
<p>${escape(text)}</p>${origin ? `<p><a href="${escape(origin)}">Back to Koios</a></p>` : ''}
<script>try{if(window.opener&&${target}){window.opener.postMessage(${message},${target});window.close()}}catch(e){}</script></body>`;
  return new Response(html, { status: outcome.ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } });
}

/** What a page is told of the token: never the token. */
const shown = (record) => ({ connected: true, login: record.login, via: record.via ?? 'token', kind: record.kind, scopes: record.scopes ?? null, expiresAt: record.refresh ? record.refreshExpiresAt ?? null : record.expiresAt ?? null, renews: Boolean(record.refresh), addedAt: record.addedAt, lastUsedAt: record.lastUsedAt ?? null });

export async function handleGithub(request, env, path, { json, headers, authorized, personOverLimit = async () => false, origins = [] }) {
  const noStore = { ...headers, 'Cache-Control': 'no-store' };

  // GitHub sending the person back: no pass here (a navigation), so who it is comes from the one-time state.
  if (path === '/github/callback') {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || '';
    if (!/^[0-9a-f]{64}$/.test(state) || !env.SESSIONS || !secretsReady(env)) return callbackPage('', { ok: false, error: 'this sign-in isn’t one Koios started' });
    const kept = await env.SESSIONS.get(stateKey(state));
    await env.SESSIONS.delete(stateKey(state));
    const started = kept ? JSON.parse((await openSecret(env, 'state', 'github-state', kept)) || 'null') : null;
    if (!started) return callbackPage('', { ok: false, error: 'this sign-in has expired or was already used: start it again from Koios' });
    if (url.searchParams.get('error')) return callbackPage(started.origin, { ok: false, error: url.searchParams.get('error_description') || url.searchParams.get('error') });
    try {
      const got = await tokenFromGithub(env, started.via, { code: url.searchParams.get('code') || '', redirect_uri: `${url.origin}/github/callback`, code_verifier: started.verifier });
      const user = await whoseToken(got.token);
      const now = new Date().toISOString();
      const previous = await readRecord(env, env.SESSIONS, started.owner);
      if (previous && !previous.gone && previous.via !== started.via) await revokeWithGithub(env, previous);
      await writeRecord(env, env.SESSIONS, started.owner, { token: got.token, login: user.login, via: started.via, kind: started.via, scopes: got.scopes ?? user.scopes, expiresAt: got.expiresAt ?? user.expiresAt, refresh: got.refresh, refreshExpiresAt: got.refreshExpiresAt, addedAt: now, lastUsedAt: now });
      return callbackPage(started.origin, { ok: true, login: user.login, via: started.via });
    } catch (error) {
      return callbackPage(started.origin, { ok: false, error: error?.message || String(error) });
    }
  }

  const who = await authorized(request, env);
  if (!who) return json({ error: 'sign in with Google first' }, 401, noStore);
  if (!env.SESSIONS) return json({ error: 'this Worker has no KV (SESSIONS) to keep a token in' }, 501, noStore);
  if (!secretsReady(env)) return json({ error: SECRETS_MISSING }, 501, noStore);
  const kv = env.SESSIONS;
  const owner = who.email ?? 'owner';

  // A sign-in started: where to send the person, with a one-time state (bound to them, sealed, ten minutes) and PKCE.
  if (path === '/github/oauth/start') {
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    const body = await request.json().catch(() => null);
    const via = body?.via === 'app' ? 'app' : body?.via === 'oauth' ? 'oauth' : null;
    if (!via) return json({ error: 'which sign-in: oauth or app' }, 400, noStore);
    if (!githubMethods(env)[via]) return json({ error: via === 'app' ? 'this server has no GitHub App set up (docs/deploy.md)' : 'this server has no GitHub OAuth App set up (docs/deploy.md)' }, 501, noStore);
    const origin = request.headers.get('Origin') || '';
    if (!origins.includes(origin)) return json({ error: 'not from this app' }, 403, noStore);
    if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
    const state = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    await kv.put(stateKey(state), await sealSecret(env, 'state', 'github-state', JSON.stringify({ owner, via, origin, verifier })), { expirationTtl: STATE_TTL_S });
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', clientOf(env, via).id);
    authorize.searchParams.set('redirect_uri', `${new URL(request.url).origin}/github/callback`);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    // OAuth Apps grant scopes: `repo` is what private repositories need. A GitHub App has its own permissions instead.
    if (via === 'oauth') authorize.searchParams.set('scope', 'repo');
    return json({ url: authorize.toString() }, 200, noStore);
  }

  if (path === '/github/token') {
    if (request.method === 'DELETE') {
      const record = await readRecord(env, kv, owner);
      if (record && !record.gone) await revokeWithGithub(env, record);
      await kv.delete(await secretsKey(env, 'github', owner));
      return json({ connected: false, methods: githubMethods(env) }, 200, noStore);
    }
    if (request.method === 'PUT') {
      // Asked of GitHub on the person's behalf: no faster than a person connects an account.
      if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
      const body = await request.json().catch(() => null);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!looksLikeToken(token)) return json({ error: 'a GitHub token (github_pat_… or ghp_…)' }, 400, noStore);
      let user;
      try {
        user = await whoseToken(token);
      } catch (error) {
        return json({ error: error?.refused ? error.message : `Koios’s server couldn’t check the token with GitHub (${error?.message || error}).` }, error?.refused ? 400 : 502, noStore);
      }
      const now = new Date().toISOString();
      const previous = await readRecord(env, kv, owner);
      if (previous && !previous.gone) await revokeWithGithub(env, previous);
      const record = { token, login: user.login, via: 'token', kind: kindOf(token), scopes: user.scopes, expiresAt: user.expiresAt, addedAt: now, lastUsedAt: now };
      await writeRecord(env, kv, owner, record);
      return json({ ...shown(record), methods: githubMethods(env) }, 200, noStore);
    }
    const record = await readRecord(env, kv, owner);
    if (!record || record.gone) return json({ connected: false, methods: githubMethods(env), ...(record?.gone ? { forgotten: record.gone } : {}) }, 200, noStore);
    return json({ ...shown(record), methods: githubMethods(env) }, 200, noStore);
  }

  // A call to GitHub with the kept token: one of the allowed ones only.
  const url = new URL(request.url);
  const call = path.split('?')[0].slice('/github/api'.length);
  const method = request.method.toUpperCase();
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return json({ error: 'too large' }, 413, noStore);
  const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413, noStore);
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'a JSON body' }, 400, noStore);
    }
  }
  if (!allowedCall(method, call, body)) return json({ error: 'Koios’s server doesn’t make that GitHub call with your token.' }, 403, noStore);
  const record = await readRecord(env, kv, owner);
  if (!record || record.gone) return json({ error: record?.gone === 'expired' ? 'Your GitHub token expired: connect GitHub again with a new one.' : 'Connect GitHub first (Projects → Connections).', needToken: true }, 401, noStore);
  let answer;
  try {
    answer = await fetch(`${GITHUB}${call}${url.search}`, {
      method,
      headers: { ...githubHeaders(record.token), ...(text ? { 'Content-Type': 'application/json' } : {}) },
      ...(text ? { body: text } : {}),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    return json({ error: `Koios’s server couldn’t reach GitHub (${error?.message || error}).` }, 502, noStore);
  }
  // GitHub no longer takes it (revoked, expired early): forgotten, and said.
  if (answer.status === 401) {
    await kv.delete(await secretsKey(env, 'github', owner));
    return json({ error: 'GitHub rejected your token (revoked or expired): connect GitHub again.', needToken: true }, 401, noStore);
  }
  if (answer.ok && staleUse(record.lastUsedAt)) await writeRecord(env, kv, owner, { ...record, lastUsedAt: new Date().toISOString() });
  return new Response(await answer.arrayBuffer(), { status: answer.status, headers: { ...noStore, 'Content-Type': answer.headers.get('Content-Type') || 'application/json' } });
}
