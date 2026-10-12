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

const keys = (id) => ({ meta: `latex:meta:${id}`, source: `latex:src:${id}`, pdf: `latex:pdf:${id}`, log: `latex:log:${id}` });
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
  await kv.put(k.log, String(body.log || '').slice(-400_000), { expirationTtl: TTL_S });
  await kv.delete(k.source);
  await jobStates(env).put(id, { ...meta, state: 'done', pdf: Boolean(pdf), exit: Number.isFinite(body.exit) ? body.exit : null, texSeconds: Number.isFinite(body.seconds) ? body.seconds : null, doneAt: Date.now() });
  if (meta.email) await kv.delete(`latex:active:${meta.email}`);
  // On the Usage page: a compile, and the compiler's seconds on it, for its owner.
  const seconds = Math.max(1, Math.round((Date.now() - (meta.compilingAt || meta.createdAt || Date.now())) / 1000));
  tally?.(meta.email === 'owner' ? { owner: true } : { email: meta.email }, { latex: 1, latex_s: seconds });
}

/** The files compiled by the Cloud Run service (cloudrun/latex/server.py): {pdf, log, exit}. */
async function compileOnCloudRun(env, job) {
  const base = String(env.LATEX_CLOUD_RUN_URL).trim().replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${base}/compile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(env.LATEX_CLOUD_RUN_TOKEN).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(CLOUD_RUN_WAIT_MS),
    });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'The compiler took more than 5 minutes.' : `The compiler couldn't be reached (${error?.message || error}).`);
  }
  if (!response.ok) throw new Error(`The compiler answered ${response.status} (${(await response.text()).slice(0, 200)})`);
  return response.json();
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

  if (path === '/latex/jobs') {
    if (request.method !== 'POST') return json({ error: 'POST' }, 405, noStore);
    if (await personOverLimit(env, who)) return json({ error: 'too many requests; wait a minute', limited: true }, 429, { ...noStore, 'Retry-After': '60' });
    // One compile at a time each: the compiler is free here, but not for spending on a loop.
    // The marker in KV can be a minute stale; the job's own state says whether it is still going.
    const active = await kv.get(`latex:active:${owner}`);
    const going = active && isId(active) ? ['queued', 'compiling'].includes((await jobs.get(active))?.state) : false;
    if (going && !who.owner) return json({ error: 'a compile of yours is still going; it ends in a minute or two', active }, 429, noStore);
    const body = await request.json().catch(() => null);
    const files = cleanFiles(body?.files);
    if (!files) return json({ error: 'the files: relative paths inside the folder, as base64, 20 MB in all' }, 400, noStore);
    // Which compiler, when the page names one; the one set up otherwise.
    const on = body?.on === 'github' || body?.on === 'cloudrun' ? body.on : latexCompiler(env);
    if (!latexCompilerReady(env, on)) return json({ error: on === 'cloudrun' ? 'this site has no Cloud Run compiler set up (LATEX_CLOUD_RUN_URL, LATEX_CLOUD_RUN_TOKEN)' : 'this site has no GitHub Actions compiler set up (LATEX_GITHUB_TOKEN, LATEX_RUNNER_TOKEN)' }, 501, noStore);
    const main = typeof body.main === 'string' && /\.tex$/i.test(body.main) && !body.main.split('/').includes('..') ? body.main.replace(/^\/+/, '') : 'main.tex';
    const flag = COMPILERS[body.compiler] ?? '-pdf';
    const id = newId();
    const k = keys(id);
    // Cloud Run: compiled while the page waits for this answer, the files never stored.
    if (on === 'cloudrun') {
      const meta = { email: owner, state: 'compiling', on: 'cloudrun', createdAt: Date.now(), compilingAt: Date.now() };
      await jobs.put(id, meta);
      await kv.put(`latex:active:${owner}`, id, { expirationTtl: ACTIVE_S });
      try {
        await keepResult(env, id, meta, await compileOnCloudRun(env, { main, flag, files }), tally);
      } catch (error) {
        await kv.delete(`latex:active:${owner}`);
        await jobs.put(id, { ...meta, state: 'failed', error: error.message });
        return json({ error: error.message }, 502, noStore);
      }
      return json({ id, on: 'cloudrun', state: 'done' }, 200, noStore);
    }
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

  const asked = /^\/latex\/jobs\/([a-f0-9]{32})(?:\/(pdf|log))?$/.exec(path);
  if (!asked || !isId(asked[1])) return json({ error: 'not found' }, 404, noStore);
  const [, id, what] = asked;
  const k = keys(id);
  const meta = await jobs.get(id);
  // Another person's job answers as if there were none.
  if (!meta || (meta.email !== owner && !who.owner)) return json({ error: 'no such job, or it has expired' }, 404, noStore);
  if (!what) return json({ state: meta.state, on: meta.on ?? 'github', pdf: Boolean(meta.pdf), exit: meta.exit ?? null, texSeconds: meta.texSeconds ?? null, error: meta.error ?? null, createdAt: meta.createdAt, compilingAt: meta.compilingAt ?? null, doneAt: meta.doneAt ?? null }, 200, noStore);
  if (what === 'pdf') {
    const pdf = await kv.get(k.pdf, 'arrayBuffer');
    if (!pdf) return json({ error: 'no PDF' }, 404, noStore);
    return new Response(pdf, { status: 200, headers: { ...noStore, 'Content-Type': 'application/pdf' } });
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
