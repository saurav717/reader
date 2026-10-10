// Compiling LaTeX for anyone signed in to the reader, on GitHub Actions in
// the reader's own repository (.github/workflows/latex-compile.yml): all of
// TeX Live, nothing for the person to install or set up.
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
// Needs, besides the SESSIONS KV namespace (wrangler.toml):
//   LATEX_GITHUB_TOKEN  a fine-grained token on the repository, Actions: read and write (to start the workflow)
//   LATEX_RUNNER_TOKEN  any long random string, the same as the repository's secret of that name
//   LATEX_REPO          a var, owner/repo; saurav717/reader when unset

const TTL_S = 60 * 60;
const MAX_BYTES = 20 * 1024 * 1024;
const ACTIVE_S = 10 * 60;
const WORKFLOW = 'latex-compile.yml';
const COMPILERS = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex', latex: '-pdfdvi' };

export const latexAvailable = (env) => Boolean(env.SESSIONS && String(env.LATEX_GITHUB_TOKEN || '').trim() && String(env.LATEX_RUNNER_TOKEN || '').trim());

const keys = (id) => ({ meta: `latex:meta:${id}`, source: `latex:src:${id}`, pdf: `latex:pdf:${id}`, log: `latex:log:${id}` });
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

/**
 * The routes. `who` is the signed-in person (or the owner) from the
 * Worker's own check; the runner's routes take LATEX_RUNNER_TOKEN instead.
 */
export async function handleLatex(request, env, path, { json, headers, authorized, personOverLimit }) {
  const noStore = { ...headers, 'Cache-Control': 'no-store' };
  // HTTPS only: a paper, a pass or the runner's secret never over plain HTTP (LATEX_ALLOW_HTTP is for a local test).
  if (new URL(request.url).protocol !== 'https:' && !env.LATEX_ALLOW_HTTP) return json({ error: 'HTTPS only' }, 403, noStore);
  if (!latexAvailable(env)) return json({ error: 'this site has no LaTeX compiler set up yet (LATEX_GITHUB_TOKEN, LATEX_RUNNER_TOKEN — see worker/latex.js)' }, 501, noStore);
  const kv = env.SESSIONS;

  // ---- the runner's
  const runner = /^\/latex\/runner\/([a-f0-9]{32})\/(source|result)$/.exec(path);
  if (runner) {
    const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!given || !sameSecret(given, String(env.LATEX_RUNNER_TOKEN).trim())) return json({ error: 'not the runner' }, 401, noStore);
    const [, id, what] = runner;
    const k = keys(id);
    const meta = await kv.get(k.meta, 'json');
    if (!meta) return json({ error: 'no such job, or it has expired' }, 404, noStore);
    if (what === 'source') {
      const source = await kv.get(k.source);
      if (!source) return json({ error: 'its files are gone' }, 410, noStore);
      await kv.put(k.meta, JSON.stringify({ ...meta, state: 'compiling', compilingAt: Date.now() }), { expirationTtl: TTL_S });
      return new Response(source, { status: 200, headers: { ...noStore, 'Content-Type': 'application/json' } });
    }
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'a JSON body' }, 400, noStore);
    const pdf = typeof body.pdf === 'string' && body.pdf ? Uint8Array.from(atob(body.pdf), (char) => char.charCodeAt(0)) : null;
    if (pdf) await kv.put(k.pdf, pdf, { expirationTtl: TTL_S });
    await kv.put(k.log, String(body.log || '').slice(-400_000), { expirationTtl: TTL_S });
    await kv.delete(k.source);
    await kv.put(k.meta, JSON.stringify({ ...meta, state: 'done', pdf: Boolean(pdf), exit: Number.isFinite(body.exit) ? body.exit : null, doneAt: Date.now() }), { expirationTtl: TTL_S });
    if (meta.email) await kv.delete(`latex:active:${meta.email}`);
    return json({ ok: true }, 200, noStore);
  }

  // ---- the page's: signed in
  const who = await authorized(request, env);
  if (!who) return json({ error: 'sign in with Google to compile on GitHub' }, 401, noStore);
  const owner = who.email ?? 'owner';

  if (path === '/latex/jobs') {
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
    // One compile at a time each: GitHub's minutes are free here, but not for spending on a loop.
    const active = await kv.get(`latex:active:${owner}`);
    if (active && !who.owner) return json({ error: 'a compile of yours is still going; it ends in a minute or two', active }, 429, noStore);
    const body = await request.json().catch(() => null);
    const files = cleanFiles(body?.files);
    if (!files) return json({ error: 'the files: relative paths inside the folder, as base64, 20 MB in all' }, 400, noStore);
    const main = typeof body.main === 'string' && /\.tex$/i.test(body.main) && !body.main.split('/').includes('..') ? body.main.replace(/^\/+/, '') : 'main.tex';
    const flag = COMPILERS[body.compiler] ?? '-pdf';
    const id = newId();
    const k = keys(id);
    await kv.put(k.source, JSON.stringify({ main, flag, files }), { expirationTtl: TTL_S });
    await kv.put(k.meta, JSON.stringify({ email: owner, state: 'queued', createdAt: Date.now() }), { expirationTtl: TTL_S });
    await kv.put(`latex:active:${owner}`, id, { expirationTtl: ACTIVE_S });
    try {
      await startRun(env, id);
    } catch (error) {
      await kv.delete(`latex:active:${owner}`);
      await kv.put(k.meta, JSON.stringify({ email: owner, state: 'failed', error: error.message, createdAt: Date.now() }), { expirationTtl: TTL_S });
      return json({ error: error.message }, 502, noStore);
    }
    return json({ id }, 202, noStore);
  }

  const asked = /^\/latex\/jobs\/([a-f0-9]{32})(?:\/(pdf|log))?$/.exec(path);
  if (!asked || !isId(asked[1])) return json({ error: 'not found' }, 404, noStore);
  const [, id, what] = asked;
  const k = keys(id);
  const meta = await kv.get(k.meta, 'json');
  // Another person's job answers as if there were none.
  if (!meta || (meta.email !== owner && !who.owner)) return json({ error: 'no such job, or it has expired' }, 404, noStore);
  if (!what) return json({ state: meta.state, pdf: Boolean(meta.pdf), exit: meta.exit ?? null, error: meta.error ?? null, createdAt: meta.createdAt, compilingAt: meta.compilingAt ?? null, doneAt: meta.doneAt ?? null }, 200, noStore);
  if (what === 'pdf') {
    const pdf = await kv.get(k.pdf, 'arrayBuffer');
    if (!pdf) return json({ error: 'no PDF' }, 404, noStore);
    return new Response(pdf, { status: 200, headers: { ...noStore, 'Content-Type': 'application/pdf' } });
  }
  const log = (await kv.get(k.log)) ?? '';
  return new Response(log, { status: 200, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } });
}
