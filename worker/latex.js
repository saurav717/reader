// Compiling LaTeX for anyone signed in to the reader: all of TeX Live,
// nothing for the person to install or set up. Two compilers; the page names
// the one it wants (the Write tab's Compile on), else the first set up is used:
//
// - Google Cloud Run (cloudrun/latex): the Worker hands it the files and
//   waits — a PDF in seconds, no queue. LATEX_CLOUD_RUN_URL and
//   LATEX_CLOUD_RUN_TOKEN.
// - GitHub Actions in the reader's own repository
//   (.github/workflows/latex-compile.yml): a minute or two, as below.
//   LATEX_GITHUB_TOKEN and LATEX_RUNNER_TOKEN.
//
// Either way the page sees the same thing: a job it asks after, whose PDF and
// log it reads.
//
// The repository is public, so a paper never goes into it. The page hands
// the paper's files to this Worker, which keeps them in KV for an hour and
// asks GitHub to run the workflow with only a random job id. The runner
// fetches the files from here with a secret only it holds
// (LATEX_RUNNER_TOKEN, a secret of both this Worker and the repository),
// compiles them, prints nothing of them, and posts the PDF and the log back
// here; the page reads them. Nothing of the paper is kept: the files are
// dropped once compiled, and the PDF and log an hour after.
//
// A job's state (queued, compiling, done) is kept in a Durable Object of its
// own (LatexJob below, the LATEX_JOBS binding), not in KV: KV hands a page a
// reading up to a minute old, so the page went on saying "waiting for GitHub"
// while it compiled, and saw the PDF up to a minute after it came back. The
// files, the PDF and the log are each written once and read once, which KV
// does well.
//
// Needs, besides the SESSIONS KV namespace (wrangler.toml), for Cloud Run:
//   LATEX_CLOUD_RUN_URL    a var, the service's https:// address
//   LATEX_CLOUD_RUN_TOKEN  any long random string, the same as the service's LATEX_TOKEN
//   LATEX_CLOUD_RUN_CPU, LATEX_CLOUD_RUN_MEMORY_GIB  vars, what the service was given (2 and 4 when unset), for the Usage page
// or, for GitHub Actions:
//   LATEX_GITHUB_TOKEN  a fine-grained token on the repository, Actions: read and write (to start the workflow)
//   LATEX_RUNNER_TOKEN  any long random string, the same as the repository's secret of that name
//   LATEX_REPO          a var, owner/repo; saurav717/reader when unset

import { SECRETS_MISSING, openSecret, sealSecret, secretsKey, secretsReady, staleUse, unusedTooLong } from './secrets.js';

const TTL_S = 60 * 60;
const MAX_BYTES = 20 * 1024 * 1024;
const ACTIVE_S = 10 * 60;
const WORKFLOW = 'latex-compile.yml';
const COMPILERS = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex', latex: '-pdfdvi' };

const CLOUD_RUN_WAIT_MS = 5 * 60_000;

/** Which compiler this Worker has: 'cloudrun', 'github', or null. */
export function latexCompiler(env) {
  if (!env.SESSIONS) return null;
  if (/^https:\/\//.test(String(env.LATEX_CLOUD_RUN_URL || '').trim()) && String(env.LATEX_CLOUD_RUN_TOKEN || '').trim()) return 'cloudrun';
  if (String(env.LATEX_GITHUB_TOKEN || '').trim() && String(env.LATEX_RUNNER_TOKEN || '').trim()) return 'github';
  return null;
}

export const latexAvailable = (env) => Boolean(latexCompiler(env));

/** Whether this Worker can compile on that one. */
export function latexCompilerReady(env, on) {
  if (!env.SESSIONS) return false;
  if (on === 'cloudrun') return /^https:\/\//.test(String(env.LATEX_CLOUD_RUN_URL || '').trim()) && Boolean(String(env.LATEX_CLOUD_RUN_TOKEN || '').trim());
  if (on === 'github') return Boolean(String(env.LATEX_GITHUB_TOKEN || '').trim() && String(env.LATEX_RUNNER_TOKEN || '').trim());
  return false;
}

const keys = (id) => ({ meta: `latex:meta:${id}`, source: `latex:src:${id}`, pdf: `latex:pdf:${id}`, log: `latex:log:${id}`, synctex: `latex:synctex:${id}` });
/**
 * One compile's state, read and written in one place, so what the runner says
 * the page sees at once. It forgets the job an hour on.
 */
export class LatexJob {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'PUT') {
      await this.state.storage.put('meta', await request.json());
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + TTL_S * 1000);
      return new Response('ok');
    }
    const meta = await this.state.storage.get('meta');
    return meta ? Response.json(meta) : new Response('none', { status: 404 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

/** Where a job's state is: its Durable Object, or KV where there is none bound (a local test). */
function jobStates(env) {
  if (env.LATEX_JOBS) {
    const of = (id) => env.LATEX_JOBS.get(env.LATEX_JOBS.idFromName(id));
    return {
      get: async (id) => {
        const answer = await of(id).fetch('https://latex-job/');
        return answer.ok ? answer.json() : null;
      },
      put: (id, meta) => of(id).fetch('https://latex-job/', { method: 'PUT', body: JSON.stringify(meta) }),
    };
  }
  return {
    get: (id) => env.SESSIONS.get(keys(id).meta, 'json'),
    put: (id, meta) => env.SESSIONS.put(keys(id).meta, JSON.stringify(meta), { expirationTtl: TTL_S }),
  };
}

const isId = (id) => /^[a-f0-9]{32}$/.test(id || '');
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function sameSecret(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) differ |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return differ === 0;
}

/** Whether a path is one of these. */
export const isLatexPath = (path) => path === '/latex/jobs' || path.startsWith('/latex/');

/** The files a job may hold: relative paths that stay inside the paper's folder, as base64. */
export function cleanFiles(raw) {
  if (!Array.isArray(raw)) return null;
  const files = [];
  let bytes = 0;
  for (const file of raw) {
    const path = typeof file?.path === 'string' ? file.path.replace(/^\/+/, '') : '';
    if (!path || path.split('/').some((part) => part === '..' || part === '') || path.length > 300) return null;
    if (typeof file.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) return null;
    bytes += Math.floor((file.base64.length * 3) / 4);
    files.push({ path, base64: file.base64 });
  }
  return bytes <= MAX_BYTES && files.length <= 500 ? files : null;
}

async function startRun(env, id) {
  const repo = String(env.LATEX_REPO || 'saurav717/reader').trim();
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(env.LATEX_GITHUB_TOKEN).trim()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'reader-worker',
    },
    body: JSON.stringify({ ref: 'main', inputs: { job: id } }),
  });
  if (!response.ok) throw new Error(`GitHub didn't start the compile (${response.status} ${(await response.text()).slice(0, 200)})`);
}

/** A compile's PDF and log, kept for its owner's page; its files dropped, and it counted on the Usage page. */
async function keepResult(env, id, meta, body, tally) {
  const kv = env.SESSIONS;
  const k = keys(id);
  const pdf = typeof body.pdf === 'string' && body.pdf ? Uint8Array.from(atob(body.pdf), (char) => char.charCodeAt(0)) : null;
  if (pdf) await kv.put(k.pdf, pdf, { expirationTtl: TTL_S });
  // SyncTeX, gzipped: a double-click on the PDF opens its source line.
  const synctex = pdf && typeof body.synctex === 'string' && body.synctex ? Uint8Array.from(atob(body.synctex), (char) => char.charCodeAt(0)) : null;
  if (synctex) await kv.put(k.synctex, synctex, { expirationTtl: TTL_S });
  await kv.put(k.log, String(body.log || '').slice(-400_000), { expirationTtl: TTL_S });
  await kv.delete(k.source);
  await jobStates(env).put(id, { ...meta, state: 'done', pdf: Boolean(pdf), synctex: Boolean(synctex), exit: Number.isFinite(body.exit) ? body.exit : null, texSeconds: Number.isFinite(body.seconds) ? body.seconds : null, doneAt: Date.now() });
  if (meta.email) await kv.delete(`latex:active:${meta.email}`);
  // On the Usage page: a compile, and the compiler's seconds on it, for its owner.
  const seconds = Math.max(1, Math.round((Date.now() - (meta.compilingAt || meta.createdAt || Date.now())) / 1000));
  tally?.(meta.email === 'owner' ? { owner: true } : { email: meta.email }, { latex: 1, latex_s: seconds });
}

/** The files compiled by the Cloud Run service (cloudrun/latex/server.py): its answer, as it gave it. */
async function sendToCloudRun(env, job) {
  const base = String(env.LATEX_CLOUD_RUN_URL).trim().replace(/\/+$/, '');
  try {
    return await fetch(`${base}/compile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(env.LATEX_CLOUD_RUN_TOKEN).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(CLOUD_RUN_WAIT_MS),
    });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'The compiler took more than 5 minutes.' : `The compiler couldn't be reached (${error?.message || error}).`);
  }
}

/** Every file of the paper and the SHA-256 of its base64: what the kept folder should hold. */
export function cleanManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > 500) return null;
  const manifest = {};
  for (const [given, sha] of entries) {
    const path = given.replace(/^\/+/, '');
    if (!path || path.length > 300 || path.split('/').some((part) => part === '..' || part === '.' || part === '')) return null;
    if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)) return null;
    manifest[path] = sha;
  }
  return manifest;
}

const OVERLEAF_REMOTE = /^https:\/\/git\.overleaf\.com\/[A-Za-z0-9]+\/?$/;
const overleafKey = (owner) => `overleaf-token:${owner}`;

/** The key Overleaf tokens were sealed with before worker/secrets.js (derived from the Cloud Run token): kept only to open those, which are then sealed again the new way. */
async function tokenKey(env) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.LATEX_CLOUD_RUN_TOKEN || '').trim()), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('reader-overleaf-token'), info: new Uint8Array() }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** An Overleaf token sealed the old way: what records from before look like (and the tests make). */
export async function sealToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), new TextEncoder().encode(token)));
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  return JSON.stringify({ iv: b64(iv), data: b64(sealed) });
}

/** The token back, or null when there is none or it can't be opened (the secret changed). */
export async function openToken(env, kept) {
  if (!kept) return null;
  try {
    const { iv, data } = JSON.parse(kept);
    const bytes = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, await tokenKey(env), bytes(data)));
  } catch {
    return null;
  }
}

/**
 * The person's Overleaf accounts, each with its Git token and its email
 * sealed for them alone (worker/secrets.js), filed under a keyed hash of
 * their email: `{ accounts: [{ id, label, token, addedAt, lastUsedAt }] }`,
 * `label` and `token` sealed. Read here opened — `{ id, label, token,
 * addedAt, lastUsedAt }` in the clear, for this request only. An account
 * unused for UNUSED_DAYS is forgotten. Accounts kept the old way (sealed
 * with a key from LATEX_CLOUD_RUN_TOKEN, the email in the clear, under the
 * plain email) are opened, then sealed again and moved, as they are read.
 */
async function readAccounts(env, kv, owner) {
  const ready = secretsReady(env);
  const raw = ready ? await kv.get(await secretsKey(env, 'overleaf', owner)) : null;
  let accounts = [];
  if (raw) {
    try {
      const kept = JSON.parse(raw);
      for (const item of Array.isArray(kept?.accounts) ? kept.accounts : []) {
        if (!item || typeof item.id !== 'string') continue;
        const token = await openSecret(env, owner, 'overleaf-token', item.token);
        // One that no longer opens (SECRETS_KEY changed) is of no use to anyone: left out, and dropped at the next write.
        if (!token) continue;
        accounts.push({ id: item.id, label: (await openSecret(env, owner, 'overleaf-label', item.label)) ?? 'Overleaf account', token, addedAt: item.addedAt || '', lastUsedAt: item.lastUsedAt || item.addedAt || '' });
      }
    } catch {
      // unreadable: as if none
    }
  } else {
    // Kept the old way: opened with the old key, then sealed again and moved (with SECRETS_KEY), the old record deleted.
    const legacy = await kv.get(overleafKey(owner));
    if (legacy) {
      try {
        const kept = JSON.parse(legacy);
        const items = Array.isArray(kept?.accounts) ? kept.accounts : typeof kept?.iv === 'string' ? [{ id: 'a1', label: 'Overleaf account', sealed: legacy, addedAt: '' }] : [];
        for (const item of items) {
          const token = item && typeof item.sealed === 'string' ? await openToken(env, item.sealed) : null;
          if (token) accounts.push({ id: item.id, label: typeof item.label === 'string' ? item.label : 'Overleaf account', token, addedAt: item.addedAt || '', lastUsedAt: new Date().toISOString() });
        }
      } catch {
        // unreadable: as if none
      }
      if (ready) {
        await writeAccounts(env, kv, owner, accounts);
        await kv.delete(overleafKey(owner));
      }
    }
  }
  const kept = accounts.filter((account) => !unusedTooLong(account.lastUsedAt));
  if (kept.length !== accounts.length && ready) await writeAccounts(env, kv, owner, kept);
  return kept;
}

/** The accounts, sealed and kept (none: the record deleted). Needs SECRETS_KEY. */
async function writeAccounts(env, kv, owner, accounts) {
  const key = await secretsKey(env, 'overleaf', owner);
  if (!accounts.length) return kv.delete(key);
  const sealed = [];
  for (const account of accounts) {
    sealed.push({ id: account.id, label: await sealSecret(env, owner, 'overleaf-label', account.label), token: await sealSecret(env, owner, 'overleaf-token', account.token), addedAt: account.addedAt, lastUsedAt: account.lastUsedAt || account.addedAt });
  }
  return kv.put(key, JSON.stringify({ accounts: sealed }));
}

/** Everything kept here for one person: their Overleaf accounts (the old way too) and the marker of a compile going (worker/account.js). */
export async function forgetOverleaf(env, owner) {
  const kv = env.SESSIONS;
  if (!kv) return false;
  if (secretsReady(env)) await kv.delete(await secretsKey(env, 'overleaf', owner));
  await kv.delete(overleafKey(owner));
  await kv.delete(`latex:active:${owner}`);
  return true;
}

/** The accounts as the page sees them: never a token. */
const shownAccounts = (accounts) => accounts.map(({ id, label, addedAt, lastUsedAt }) => ({ id, label, addedAt, lastUsedAt }));

/** A token added as an account (or the account that has it already, its label changed when one is given); its id back. */
async function addAccount(env, kv, owner, token, label) {
  const accounts = await readAccounts(env, kv, owner);
  const now = new Date().toISOString();
  const known = accounts.find((account) => account.token === token);
  if (known) {
    if (label) known.label = label;
    known.lastUsedAt = now;
    await writeAccounts(env, kv, owner, accounts);
    return { id: known.id, accounts };
  }
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  accounts.push({ id, label: label || `Overleaf account ${accounts.length + 1}`, token, addedAt: now, lastUsedAt: now });
  const left = accounts.slice(-8);
  await writeAccounts(env, kv, owner, left);
  return { id, accounts: left };
}

/** The kept folder's name: whose and which paper, hashed, so one person's folder is never another's. */
export async function projectKey(owner, project) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${owner}\n${project}`));
  return [...new Uint8Array(digest)].slice(0, 20).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The routes. `who` is the signed-in person (or the owner) from the
 * Worker's own check; the runner's routes take LATEX_RUNNER_TOKEN instead.
 */
export async function handleLatex(request, env, path, { json, headers, authorized, personOverLimit, tally }) {
  const noStore = { ...headers, 'Cache-Control': 'no-store' };
  // HTTPS only: a paper, a pass or the runner's secret never over plain HTTP (LATEX_ALLOW_HTTP is for a local test).
  if (new URL(request.url).protocol !== 'https:' && !env.LATEX_ALLOW_HTTP) return json({ error: 'HTTPS only' }, 403, noStore);
  if (!latexAvailable(env)) return json({ error: 'this site has no LaTeX compiler set up yet (LATEX_CLOUD_RUN_URL and LATEX_CLOUD_RUN_TOKEN, or LATEX_GITHUB_TOKEN and LATEX_RUNNER_TOKEN — see worker/latex.js)' }, 501, noStore);
  const kv = env.SESSIONS;
  const jobs = jobStates(env);

  // ---- the runner's
  const runner = /^\/latex\/runner\/([a-f0-9]{32})\/(source|result)$/.exec(path);
  if (runner) {
    const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!given || !sameSecret(given, String(env.LATEX_RUNNER_TOKEN).trim())) return json({ error: 'not the runner' }, 401, noStore);
    const [, id, what] = runner;
    const k = keys(id);
    const meta = await jobs.get(id);
    if (!meta) return json({ error: 'no such job, or it has expired' }, 404, noStore);
    if (what === 'source') {
      const source = await kv.get(k.source);
      if (!source) return json({ error: 'its files are gone' }, 410, noStore);
      await jobs.put(id, { ...meta, state: 'compiling', compilingAt: Date.now() });
      return new Response(source, { status: 200, headers: { ...noStore, 'Content-Type': 'application/json' } });
    }
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'a JSON body' }, 400, noStore);
    await keepResult(env, id, meta, body, tally);
    return json({ ok: true }, 200, noStore);
  }

  // ---- the page's: signed in
  const who = await authorized(request, env);
  if (!who) return json({ error: 'sign in with Google to compile in the cloud' }, 401, noStore);
  const owner = who.email ?? 'owner';

  // Cloud Run starts an instance on the first request after a quiet spell, which
  // takes some seconds with all of TeX Live: the page asks for one while the
  // paper is being written, so the compile doesn't wait for it.
  if (path === '/latex/warm') {
    if (!latexCompilerReady(env, 'cloudrun')) return json({ warm: false }, 200, noStore);
    const started = Date.now();
    const answer = await fetch(`${String(env.LATEX_CLOUD_RUN_URL).trim().replace(/\/+$/, '')}/`, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    return json({ warm: Boolean(answer?.ok), ms: Date.now() - started }, 200, noStore);
  }

  // A paper kept in Drive, in step with Overleaf by the compiler on Cloud Run: the person's Overleaf Git
  // token kept here, encrypted, and handed to each sync (src/lib/overleafCloud.ts, cloudrun/latex/server.py).
  if (path === '/latex/overleaf/token') {
    // One account forgotten (?account=), or all of them.
    if (request.method === 'DELETE') {
      const which = new URL(request.url).searchParams.get('account');
      const left = which ? (await readAccounts(env, kv, owner)).filter((account) => account.id !== which) : [];
      if (secretsReady(env)) await writeAccounts(env, kv, owner, left);
      // Every account forgotten: whatever was kept the old way goes too.
      if (!left.length) await kv.delete(overleafKey(owner));
      return json({ known: left.length > 0, accounts: shownAccounts(left) }, 200, noStore);
    }
    // An account connected: with one of its projects (`url`), the token is tried on it first — a token
    // from another Overleaf account can't open it, and isn't kept. Without one, checked at its first sync.
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 80) : '';
      if (!token || token.length > 200 || /\s/.test(token)) return json({ error: 'an Overleaf Git token (Overleaf: Account Settings → Git integration → Generate token)' }, 400, noStore);
      if (!secretsReady(env)) return json({ error: SECRETS_MISSING }, 501, noStore);
      if (body?.url != null) {
        if (typeof body.url !== 'string' || !OVERLEAF_REMOTE.test(body.url)) return json({ error: 'one of the account’s Overleaf projects, by its link (https://www.overleaf.com/project/…)' }, 400, noStore);
        if (!latexCompilerReady(env, 'cloudrun')) return json({ error: 'checking a token needs the compiler on Cloud Run (LATEX_CLOUD_RUN_URL)' }, 501, noStore);
        if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
        let checked;
        try {
          checked = await fetch(`${String(env.LATEX_CLOUD_RUN_URL).trim().replace(/\/+$/, '')}/git/check`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${String(env.LATEX_CLOUD_RUN_TOKEN).trim()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: body.url, token }),
            signal: AbortSignal.timeout(60_000),
          });
        } catch (error) {
          return json({ error: `Koios’s server couldn’t reach its compiler to check the token (${error?.message || error}).` }, 502, noStore);
        }
        // The compiler not updated yet (it deploys after the Worker): said, not taken for a wrong token.
        if (checked.status === 404) return json({ error: 'Koios’s server is being updated and can’t check tokens for a few minutes yet: try again shortly.' }, 503, noStore);
        if (!checked.ok) {
          const said = await checked.json().catch(() => ({}));
          return json({ error: said.error || `the compiler answered ${checked.status}`, mismatch: checked.status === 401 }, checked.status === 401 ? 403 : 502, noStore);
        }
      }
      const added = await addAccount(env, kv, owner, token, label);
      return json({ known: true, account: added.id, accounts: shownAccounts(added.accounts) }, 200, noStore);
    }
    const accounts = await readAccounts(env, kv, owner);
    return json({ known: accounts.length > 0, accounts: shownAccounts(accounts) }, 200, noStore);
  }
  // /files: the Overleaf project's files as they are, nothing merged or pushed — for comparing a paper with it.
  if (path === '/latex/overleaf/sync' || path === '/latex/overleaf/files') {
    const peek = path === '/latex/overleaf/files';
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    if (!latexCompilerReady(env, 'cloudrun')) return json({ error: 'syncing a paper in Drive with Overleaf needs the compiler on Cloud Run (LATEX_CLOUD_RUN_URL)' }, 501, noStore);
    if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
    const body = await request.json().catch(() => null);
    if (!body || typeof body.url !== 'string' || !OVERLEAF_REMOTE.test(body.url)) return json({ error: 'an Overleaf Git address (https://git.overleaf.com/…)' }, 400, noStore);
    const changed = peek ? [] : cleanFiles(body.changed ?? []);
    if (!changed) return json({ error: 'the changed files: relative paths inside the folder, as base64, 20 MB in all' }, 400, noStore);
    const manifest = peek ? {} : cleanManifest(body.manifest ?? {});
    if (!manifest) return json({ error: 'the manifest: relative paths inside the folder, each with a SHA-256' }, 400, noStore);
    const deleted = Array.isArray(body.deleted) ? body.deleted.filter((item) => typeof item === 'string' && item.length <= 300 && !item.split('/').includes('..')).slice(0, 500) : [];
    // A paper moved in from a computer: its files' Git ids then, for the compiler to find their commit by.
    const baseTree = body.baseTree && typeof body.baseTree === 'object' && !Array.isArray(body.baseTree) && Object.keys(body.baseTree).length <= 2000 && Object.entries(body.baseTree).every(([path, blob]) => typeof path === 'string' && !path.split('/').includes('..') && /^[0-9a-f]{40}$/.test(String(blob))) ? body.baseTree : null;
    // Which account's token: one given now (added as an account), else the project's own (`account`), then the others —
    // a token opens only the projects of its own Overleaf account and those shared with it.
    const given = typeof body.token === 'string' ? body.token.trim() : '';
    if (given && !secretsReady(env)) return json({ error: SECRETS_MISSING }, 501, noStore);
    if (given) await addAccount(env, kv, owner, given, typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '');
    const accounts = await readAccounts(env, kv, owner);
    const order = [...accounts].sort((a, b) => (b.id === body.account ? 1 : 0) - (a.id === body.account ? 1 : 0));
    if (given) {
      const at = order.findIndex((account) => account.token === given);
      if (at > 0) order.unshift(...order.splice(at, 1));
    }
    if (!order.length) return json({ error: 'Connect your Overleaf account: its Git token (Overleaf: Account Settings → Git integration).', needToken: true }, 400, noStore);
    const base = String(env.LATEX_CLOUD_RUN_URL).trim().replace(/\/+$/, '');
    // A project can be open to several of the person's accounts (shared between them): the one asked for goes first,
    // and when it can't open it any more (unshared, or its token revoked), another that can is used — and said.
    const refused = [];
    for (const account of order) {
      const token = account.token;
      if (!token) continue;
      let answer;
      try {
        answer = await fetch(`${base}/git/${peek ? 'files' : 'sync'}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${String(env.LATEX_CLOUD_RUN_TOKEN).trim()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(peek ? { url: body.url, token } : { url: body.url, token, base: typeof body.base === 'string' ? body.base : '', ...(baseTree ? { baseTree } : {}), changed, deleted, manifest, message: String(body.message || 'Edits from Koios').slice(0, 200) }),
          signal: AbortSignal.timeout(CLOUD_RUN_WAIT_MS),
        });
      } catch (error) {
        return json({ error: `Koios’s server couldn’t reach its compiler (${error?.message || error}).` }, 502, noStore);
      }
      // The compiler not updated yet: said, not taken for every account being refused.
      if (peek && answer.status === 404) return json({ error: 'Koios’s server is being updated and can’t compare with Overleaf for a few minutes yet: try again shortly.' }, 503, noStore);
      // This account can't open the project (another account's, or its token revoked): the next one is tried.
      if (answer.status === 401) {
        refused.push(account);
        continue;
      }
      const said = await answer.json().catch(() => ({ error: `the compiler answered ${answer.status}` }));
      // Used: so it isn't forgotten as unused (written at most once a day).
      if (answer.ok && secretsReady(env) && staleUse(account.lastUsedAt)) {
        account.lastUsedAt = new Date().toISOString();
        await writeAccounts(env, kv, owner, accounts);
      }
      const asked = refused.find((item) => item.id === body.account);
      return json({ ...said, account: account.id, accountLabel: account.label, ...(asked ? { fellBackFrom: asked.label } : {}) }, answer.status, noStore);
    }
    return json({
      error: order.length > 1 ? `None of your ${order.length} connected Overleaf accounts can open this project. Connect the Overleaf account it is in (or one it is shared with) — or, if a token was revoked in Overleaf, connect that account again with a new one.` : 'Your connected Overleaf account can’t open this project: it may be in another Overleaf account (connect that one too), or the token was revoked in Overleaf (connect it again with a new one).',
      needToken: true,
      tried: order.length,
    }, 401, noStore);
  }

  if (path === '/latex/jobs') {
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
    const body = await request.json().catch(() => null);
    const files = cleanFiles(body?.files);
    if (!files) return json({ error: 'the files: relative paths inside the folder, as base64, 20 MB in all' }, 400, noStore);
    // Which compiler, when the page names one; the one set up otherwise.
    const on = body?.on === 'github' || body?.on === 'cloudrun' ? body.on : latexCompiler(env);
    if (!latexCompilerReady(env, on)) return json({ error: on === 'cloudrun' ? 'this site has no Cloud Run compiler set up (LATEX_CLOUD_RUN_URL, LATEX_CLOUD_RUN_TOKEN)' : 'this site has no GitHub Actions compiler set up (LATEX_GITHUB_TOKEN, LATEX_RUNNER_TOKEN)' }, 501, noStore);
    const main = typeof body.main === 'string' && /\.tex$/i.test(body.main) && !body.main.split('/').includes('..') ? body.main.replace(/^\/+/, '') : 'main.tex';
    const flag = COMPILERS[body.compiler] ?? '-pdf';
    // Cloud Run: compiled while the page waits, and its answer ({pdf, log, exit,
    // seconds}) handed straight back — nothing stored, nothing to ask after. With
    // a project, the service keeps the paper's folder between compiles, as
    // Overleaf does: the page sends every file's fingerprint (manifest) and only
    // the files that changed, and a 409 {need} asks it for any the service lacks.
    if (on === 'cloudrun') {
      const manifest = body.manifest == null ? null : cleanManifest(body.manifest);
      if (body.manifest != null && !manifest) return json({ error: 'the manifest: relative paths inside the folder, each with a SHA-256' }, 400, noStore);
      const project = typeof body.project === 'string' && body.project && body.project.length <= 300 ? await projectKey(owner, body.project) : null;
      const started = Date.now();
      let answer;
      try {
        answer = await sendToCloudRun(env, { main, flag, files, ...(project ? { project, manifest: manifest ?? undefined, fresh: body.fresh === true } : {}) });
      } catch (error) {
        return json({ error: error.message }, 502, noStore);
      }
      if (answer.status === 409) return new Response(answer.body, { status: 409, headers: { ...noStore, 'Content-Type': 'application/json' } });
      if (!answer.ok) return json({ error: `The compiler answered ${answer.status} (${(await answer.text()).slice(0, 200)})` }, 502, noStore);
      tally?.(owner === 'owner' ? { owner: true } : { email: owner }, { latex: 1, latex_s: Math.max(1, Math.round((Date.now() - started) / 1000)) });
      return new Response(answer.body, { status: 200, headers: { ...noStore, 'Content-Type': 'application/json' } });
    }
    // GitHub Actions: one compile at a time each — its minutes are free here, but not for spending on a loop.
    // The marker in KV can be a minute stale; the job's own state says whether it is still going.
    const active = await kv.get(`latex:active:${owner}`);
    const going = active && isId(active) ? ['queued', 'compiling'].includes((await jobs.get(active))?.state) : false;
    if (going && !who.owner) return json({ error: 'a compile of yours is still going; it ends in a minute or two', active }, 429, noStore);
    const id = newId();
    const k = keys(id);
    await kv.put(k.source, JSON.stringify({ main, flag, files }), { expirationTtl: TTL_S });
    await jobs.put(id, { email: owner, state: 'queued', on: 'github', createdAt: Date.now() });
    await kv.put(`latex:active:${owner}`, id, { expirationTtl: ACTIVE_S });
    try {
      await startRun(env, id);
    } catch (error) {
      await kv.delete(`latex:active:${owner}`);
      await jobs.put(id, { email: owner, state: 'failed', on: 'github', error: error.message, createdAt: Date.now() });
      return json({ error: error.message }, 502, noStore);
    }
    return json({ id, on: 'github', state: 'queued' }, 202, noStore);
  }

  const asked = /^\/latex\/jobs\/([a-f0-9]{32})(?:\/(pdf|log|synctex))?$/.exec(path);
  if (!asked || !isId(asked[1])) return json({ error: 'not found' }, 404, noStore);
  const [, id, what] = asked;
  const k = keys(id);
  const meta = await jobs.get(id);
  // Another person's job answers as if there were none.
  if (!meta || (meta.email !== owner && !who.owner)) return json({ error: 'no such job, or it has expired' }, 404, noStore);
  if (!what) return json({ state: meta.state, on: meta.on ?? 'github', pdf: Boolean(meta.pdf), synctex: Boolean(meta.synctex), exit: meta.exit ?? null, texSeconds: meta.texSeconds ?? null, error: meta.error ?? null, createdAt: meta.createdAt, compilingAt: meta.compilingAt ?? null, doneAt: meta.doneAt ?? null }, 200, noStore);
  if (what === 'pdf') {
    const pdf = await kv.get(k.pdf, 'arrayBuffer');
    if (!pdf) return json({ error: 'no PDF' }, 404, noStore);
    return new Response(pdf, { status: 200, headers: { ...noStore, 'Content-Type': 'application/pdf' } });
  }
  if (what === 'synctex') {
    const synctex = await kv.get(k.synctex, 'arrayBuffer');
    if (!synctex) return json({ error: 'no SyncTeX' }, 404, noStore);
    return new Response(synctex, { status: 200, headers: { ...noStore, 'Content-Type': 'application/gzip' } });
  }
  const log = (await kv.get(k.log)) ?? '';
  return new Response(log, { status: 200, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ------------------------------------------------------------ the month --

/** Cloud Run's free tier a month (request-based billing), and what the service is given, for the Usage page. */
export function cloudRunPlan(env) {
  const cpu = Number(env.LATEX_CLOUD_RUN_CPU) || 2;
  const memoryGib = Number(env.LATEX_CLOUD_RUN_MEMORY_GIB) || 4;
  return { on: 'cloudrun', service: String(env.LATEX_CLOUD_RUN_URL || '').trim(), cpu, memoryGib, free: { vcpuSeconds: 180_000, gibSeconds: 360_000, requests: 2_000_000 } };
}

/** GitHub's Free plan: minutes a month for private repositories, and jobs at once. Public ones aren't metered. */
export const FREE_MINUTES = 2000;
export const FREE_CONCURRENT = 20;

/**
 * The compiler's month as GitHub has it, for the Usage page: the runs of the
 * workflow since the 1st (UTC), what they took — each run's minutes rounded
 * up, as GitHub bills a job — those running now, and whether the repository
 * is private, which is when the month's minutes are limited.
 */
export async function latexMonth(env, now = Date.now(), fetcher = fetch) {
  const repo = String(env.LATEX_REPO || 'saurav717/reader').trim();
  const ask = async (path) => {
    const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      headers: { Authorization: `Bearer ${String(env.LATEX_GITHUB_TOKEN).trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'reader-worker' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.split('?')[0] || 'the repository'}`);
    return response.json();
  };
  const month = new Date(now).toISOString().slice(0, 7);
  const info = await ask('');
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const answer = await ask(`/actions/workflows/${WORKFLOW}/runs?created=%3E%3D${month}-01&per_page=100&page=${page}`);
    runs.push(...(answer.workflow_runs || []));
    if ((answer.workflow_runs || []).length < 100) break;
  }
  return { on: 'github', repo, ...summarize(runs, { private: Boolean(info.private), month, now }) };
}

/** The numbers out of the runs: pure, so it can be tested without GitHub. */
export function summarize(runs, { private: isPrivate, month, now = Date.now() }) {
  let seconds = 0;
  let minutes = 0;
  let longest = 0;
  let done = 0;
  let failed = 0;
  let running = 0;
  let queued = 0;
  const byDay = {};
  for (const run of runs) {
    const day = String(run.created_at || '').slice(0, 10);
    const row = byDay[day] || (byDay[day] = { day, runs: 0, minutes: 0 });
    row.runs += 1;
    if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' || run.status === 'requested') {
      queued += 1;
      continue;
    }
    const started = Date.parse(run.run_started_at || run.created_at);
    const ended = run.status === 'completed' ? Date.parse(run.updated_at) : now;
    const took = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, (ended - started) / 1000) : 0;
    seconds += took;
    longest = Math.max(longest, took);
    const billed = Math.max(1, Math.ceil(took / 60));
    minutes += billed;
    row.minutes += billed;
    if (run.status !== 'completed') running += 1;
    else if (run.conclusion === 'success') done += 1;
    else failed += 1;
  }
  const finished = done + failed;
  return {
    month,
    private: isPrivate,
    limit: isPrivate ? FREE_MINUTES : null,
    concurrent: FREE_CONCURRENT,
    runs: runs.length,
    done,
    failed,
    running,
    queued,
    minutes,
    seconds: Math.round(seconds),
    average: finished ? Math.round(seconds / Math.max(1, runs.length - queued)) : 0,
    longest: Math.round(longest),
    days: Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
