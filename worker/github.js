// A person's GitHub token, kept by this Worker rather than in their browser:
// sealed for them alone (worker/secrets.js), never handed back to any page,
// and used only through a narrow door — the few GitHub API calls Reader
// makes (commits of files, a private repository made, a repository read or
// turned private), each checked here before the token is put on it.
//
//   GET    /github/token     whose it is, what it may do, when it expires — never the token
//   PUT    /github/token     { token }: checked with GitHub, then kept
//   DELETE /github/token     forgotten
//   *      /github/api/…     one of the allowed calls, made with the kept token
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

export const isGithubPath = (path) => path === '/github/token' || path.startsWith('/github/api/');

const looksLikeToken = (token) => typeof token === 'string' && token.length >= 20 && token.length <= 255 && /^(github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_]+$/.test(token);
const kindOf = (token) => (token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') ? 'classic' : 'app');

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

/** The kept record, opened: `{ token, login, kind, scopes, expiresAt, addedAt, lastUsedAt }`, or null. */
async function readRecord(env, kv, owner) {
  const key = await secretsKey(env, 'github', owner);
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw);
    const token = await openSecret(env, owner, 'github-token', kept.token);
    // Expired by GitHub's date, or unused half a year, or no longer opening: forgotten.
    if (!token || (kept.expiresAt && Date.parse(kept.expiresAt) <= Date.now()) || unusedTooLong(kept.lastUsedAt || kept.addedAt)) {
      await kv.delete(key);
      return { gone: kept.expiresAt && Date.parse(kept.expiresAt) <= Date.now() ? 'expired' : 'unused' };
    }
    return { ...kept, token, login: (await openSecret(env, owner, 'github-login', kept.login)) ?? '' };
  } catch {
    return null;
  }
}

async function writeRecord(env, kv, owner, record) {
  const { token, login, ...rest } = record;
  await kv.put(await secretsKey(env, 'github', owner), JSON.stringify({ ...rest, token: await sealSecret(env, owner, 'github-token', token), login: await sealSecret(env, owner, 'github-login', login) }));
}

/** What a page is told of the token: never the token. */
const shown = (record) => ({ connected: true, login: record.login, kind: record.kind, scopes: record.scopes ?? null, expiresAt: record.expiresAt ?? null, addedAt: record.addedAt, lastUsedAt: record.lastUsedAt ?? null });

export async function handleGithub(request, env, path, { json, headers, authorized, personOverLimit = async () => false }) {
  const noStore = { ...headers, 'Cache-Control': 'no-store' };
  const who = await authorized(request, env);
  if (!who) return json({ error: 'sign in with Google first' }, 401, noStore);
  if (!env.SESSIONS) return json({ error: 'this Worker has no KV (SESSIONS) to keep a token in' }, 501, noStore);
  if (!secretsReady(env)) return json({ error: SECRETS_MISSING }, 501, noStore);
  const kv = env.SESSIONS;
  const owner = who.email ?? 'owner';

  if (path === '/github/token') {
    if (request.method === 'DELETE') {
      await kv.delete(await secretsKey(env, 'github', owner));
      return json({ connected: false }, 200, noStore);
    }
    if (request.method === 'PUT') {
      // Asked of GitHub on the person's behalf: no faster than a person connects an account.
      if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
      const body = await request.json().catch(() => null);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!looksLikeToken(token)) return json({ error: 'a GitHub token (github_pat_… or ghp_…)' }, 400, noStore);
      let answer;
      try {
        answer = await fetch(`${GITHUB}/user`, { headers: githubHeaders(token), signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        return json({ error: `Reader’s server couldn’t reach GitHub (${error?.message || error}).` }, 502, noStore);
      }
      if (answer.status === 401) return json({ error: 'GitHub rejected the token: it may have expired or been revoked.' }, 400, noStore);
      if (!answer.ok) return json({ error: `GitHub answered ${answer.status}.` }, 502, noStore);
      const user = await answer.json().catch(() => ({}));
      const now = new Date().toISOString();
      const record = { token, login: String(user.login || ''), kind: kindOf(token), scopes: answer.headers.get('x-oauth-scopes'), expiresAt: expiryOf(answer), addedAt: now, lastUsedAt: now };
      await writeRecord(env, kv, owner, record);
      return json(shown(record), 200, noStore);
    }
    const record = await readRecord(env, kv, owner);
    if (!record || record.gone) return json({ connected: false, ...(record?.gone ? { forgotten: record.gone } : {}) }, 200, noStore);
    return json(shown(record), 200, noStore);
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
  if (!allowedCall(method, call, body)) return json({ error: 'Reader’s server doesn’t make that GitHub call with your token.' }, 403, noStore);
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
    return json({ error: `Reader’s server couldn’t reach GitHub (${error?.message || error}).` }, 502, noStore);
  }
  // GitHub no longer takes it (revoked, expired early): forgotten, and said.
  if (answer.status === 401) {
    await kv.delete(await secretsKey(env, 'github', owner));
    return json({ error: 'GitHub rejected your token (revoked or expired): connect GitHub again.', needToken: true }, 401, noStore);
  }
  if (answer.ok && staleUse(record.lastUsedAt)) await writeRecord(env, kv, owner, { ...record, lastUsedAt: new Date().toISOString() });
  return new Response(await answer.arrayBuffer(), { status: answer.status, headers: { ...noStore, 'Content-Type': answer.headers.get('Content-Type') || 'application/json' } });
}
