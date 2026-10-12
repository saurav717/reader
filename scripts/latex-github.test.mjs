// Compiling on GitHub: the files the Worker takes for a job (worker/latex.js),
// and the errors read out of the log that comes back (src/lib/latexGithub.ts).
//
//   node --test scripts/latex-github.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';
import { FREE_MINUTES, LatexJob, cleanFiles, handleLatex, isLatexPath, latexCompiler, latexMonth, openToken, sealToken, summarize } from '../worker/latex.js';

const gh = await load('src/lib/latexGithub.ts');
after(cleanup);

describe('a job’s files', () => {
  it('takes relative paths as base64, and nothing that climbs out', () => {
    assert.deepEqual(cleanFiles([{ path: '/paper/main.tex', base64: 'XGRvYw==' }]), [{ path: 'paper/main.tex', base64: 'XGRvYw==' }]);
    assert.equal(cleanFiles([{ path: '../etc/passwd', base64: '' }]), null);
    assert.equal(cleanFiles([{ path: 'a//b.tex', base64: '' }]), null);
    assert.equal(cleanFiles([{ path: 'main.tex', base64: 'not base64!' }]), null);
    assert.equal(cleanFiles('nope'), null);
    assert.equal(cleanFiles([{ path: 'big.pdf', base64: 'A'.repeat(28 * 1024 * 1024) }]), null);
  });

  it('knows its routes', () => {
    assert.ok(isLatexPath('/latex/jobs'));
    assert.ok(isLatexPath('/latex/runner/abc/source'));
    assert.ok(!isLatexPath('/latexy'));
  });
});

describe('the log', () => {
  it('reads located errors, bare ! errors with their line, and warnings', () => {
    const log = [
      './main.tex:16: LaTeX Error: File `physics.sty\' not found.',
      '! Undefined control sequence.',
      'l.42 \\secondinstitute',
      'LaTeX Warning: Citation `oda\' on page 3 undefined on input line 120.',
      'Package hyperref Warning: Token not allowed in a PDF string.',
    ].join('\n');
    const read = gh.readTexLog(log);
    assert.deepEqual(read.errors, [
      { file: 'main.tex', line: 16, message: "LaTeX Error: File `physics.sty' not found." },
      { file: '', line: 42, message: 'Undefined control sequence.' },
    ]);
    assert.deepEqual(read.warnings.map((item) => item.line), [120, null]);
  });
});

describe('the month, for the Usage page', () => {
  const runs = [
    { status: 'completed', conclusion: 'success', created_at: '2026-10-02T10:00:00Z', run_started_at: '2026-10-02T10:00:05Z', updated_at: '2026-10-02T10:01:35Z' },
    { status: 'completed', conclusion: 'failure', created_at: '2026-10-02T11:00:00Z', run_started_at: '2026-10-02T11:00:05Z', updated_at: '2026-10-02T11:00:35Z' },
    { status: 'in_progress', created_at: '2026-10-03T09:00:00Z', run_started_at: '2026-10-03T09:00:00Z' },
    { status: 'queued', created_at: '2026-10-03T09:01:00Z' },
  ];

  it('rounds each run up to the minute, as GitHub bills a job, and counts what is running', () => {
    const month = summarize(runs, { private: false, month: '2026-10', now: Date.parse('2026-10-03T09:00:50Z') });
    assert.equal(month.minutes, 4);
    assert.equal(month.limit, null);
    assert.deepEqual([month.runs, month.done, month.failed, month.running, month.queued], [4, 1, 1, 1, 1]);
    assert.equal(month.longest, 90);
    assert.deepEqual(month.days, [{ day: '2026-10-02', runs: 2, minutes: 3 }, { day: '2026-10-03', runs: 2, minutes: 1 }]);
  });

  it('has a limit only when the repository is private', () => {
    assert.equal(summarize([], { private: true, month: '2026-10' }).limit, FREE_MINUTES);
  });

  it('asks GitHub for the repository and this month’s runs, page by page', async () => {
    const asked = [];
    const fetcher = async (url) => {
      asked.push(url.replace('https://api.github.com/repos/me/paper', ''));
      if (url.endsWith('/me/paper')) return new Response(JSON.stringify({ private: true }));
      return new Response(JSON.stringify({ workflow_runs: runs.slice(0, 2) }));
    };
    const month = await latexMonth({ LATEX_REPO: 'me/paper', LATEX_GITHUB_TOKEN: 't' }, Date.parse('2026-10-20T00:00:00Z'), fetcher);
    assert.deepEqual(asked, ['', '/actions/workflows/latex-compile.yml/runs?created=%3E%3D2026-10-01&per_page=100&page=1']);
    assert.equal(month.repo, 'me/paper');
    assert.equal(month.limit, FREE_MINUTES);
    assert.equal(month.minutes, 3);
  });
});

describe('a job’s state', () => {
  // KV as a page far from the runner sees it: a key once read keeps its first reading.
  function staleKv() {
    const data = new Map();
    const seen = new Map();
    return {
      get: async (key, type) => {
        if (!seen.has(key)) seen.set(key, data.get(key));
        const value = seen.get(key);
        if (value == null) return null;
        return type === 'json' ? JSON.parse(value) : type === 'arrayBuffer' ? new TextEncoder().encode(value).buffer : value;
      },
      put: async (key, value) => void data.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value)),
      delete: async (key) => void data.delete(key),
    };
  }
  // The Durable Objects, one per job, with storage in memory.
  function jobObjects() {
    const objects = new Map();
    return {
      idFromName: (name) => name,
      get: (name) => {
        if (!objects.has(name)) {
          const stored = new Map();
          let alarm = null;
          const storage = {
            get: async (key) => stored.get(key),
            put: async (key, value) => void stored.set(key, structuredClone(value)),
            deleteAll: async () => stored.clear(),
            getAlarm: async () => alarm,
            setAlarm: async (at) => void (alarm = at),
          };
          objects.set(name, new LatexJob({ storage }));
        }
        const object = objects.get(name);
        return { fetch: (url, init) => object.fetch(new Request(url, init)) };
      },
    };
  }

  it('reaches the page at once, whatever KV has cached', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const env = { SESSIONS: staleKv(), LATEX_JOBS: jobObjects(), LATEX_GITHUB_TOKEN: 'g', LATEX_RUNNER_TOKEN: 'r' };
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    const tools = { json, headers: {}, authorized: async () => ({ email: 'a@b.c' }), personOverLimit: async () => false, tally: () => {} };
    const ask = (path, init = {}) => handleLatex(new Request(`https://w${path}`, init), env, path, tools).then((r) => r.json());
    const runner = { headers: { Authorization: 'Bearer r' } };

    const files = [{ path: 'main.tex', base64: btoa('\\documentclass{article}') }];
    const { id } = await ask('/latex/jobs', { method: 'POST', body: JSON.stringify({ files, main: 'main.tex' }) });
    assert.equal((await ask(`/latex/jobs/${id}`)).state, 'queued');
    assert.equal((await ask(`/latex/runner/${id}/source`, runner)).main, 'main.tex');
    assert.equal((await ask(`/latex/jobs/${id}`)).state, 'compiling');
    await ask(`/latex/runner/${id}/result`, { ...runner, method: 'POST', body: JSON.stringify({ pdf: btoa('%PDF'), log: 'ok', exit: 0 }) });
    const done = await ask(`/latex/jobs/${id}`);
    assert.equal(done.state, 'done');
    assert.equal(done.pdf, true);
    // The next compile isn't refused by KV's stale "still going".
    assert.ok((await ask('/latex/jobs', { method: 'POST', body: JSON.stringify({ files }) })).id);
  });

  it('on Cloud Run: compiled while the page waits, the answer handed straight back, nothing stored', async (t) => {
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization, job: JSON.parse(init.body) });
      return Response.json({ pdf: btoa('%PDF'), log: 'Output written on output.pdf', exit: 0, seconds: 1.5, cached: false });
    });
    const kv = staleKv();
    const stored = [];
    const put = kv.put;
    kv.put = (key, value, options) => (stored.push(key), put(key, value, options));
    const env = { SESSIONS: kv, LATEX_JOBS: jobObjects(), LATEX_CLOUD_RUN_URL: 'https://latex-abc.a.run.app/', LATEX_CLOUD_RUN_TOKEN: 'c', LATEX_GITHUB_TOKEN: 'g', LATEX_RUNNER_TOKEN: 'r' };
    assert.equal(latexCompiler(env), 'cloudrun');
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    const tallied = [];
    const tools = { json, headers: {}, authorized: async () => ({ email: 'a@b.c' }), personOverLimit: async () => false, tally: (who, counts) => tallied.push(counts) };
    const ask = (path, init = {}) => handleLatex(new Request(`https://w${path}`, init), env, path, tools);

    const files = [{ path: 'main.tex', base64: btoa('\\documentclass{article}') }];
    const answer = await ask('/latex/jobs', { method: 'POST', body: JSON.stringify({ files, main: 'main.tex', compiler: 'xelatex' }) });
    assert.equal(answer.status, 200);
    const done = await answer.json();
    assert.deepEqual([done.pdf, done.exit, done.seconds], [btoa('%PDF'), 0, 1.5]);
    assert.deepEqual(sent, [{ url: 'https://latex-abc.a.run.app/compile', auth: 'Bearer c', job: { main: 'main.tex', flag: '-xelatex', files } }]);
    assert.deepEqual(stored, []);
    assert.equal(tallied[0].latex, 1);

    // A compiler that doesn't answer well: the page is told.
    t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 503 }));
    const failed = await ask('/latex/jobs', { method: 'POST', body: JSON.stringify({ files }) });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /503/);
  });

  it('on Cloud Run with a project: the folder is named for whose and which paper, the manifest passed on, a 409 handed back', async (t) => {
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const job = JSON.parse(init.body);
      sent.push(job);
      return job.files.length ? Response.json({ pdf: '', log: '', exit: 0, seconds: 0.4, cached: true }) : Response.json({ need: ['main.tex'] }, { status: 409 });
    });
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    const as = (email) => ({ json, headers: {}, authorized: async () => ({ email }), personOverLimit: async () => false, tally: () => {} });
    const env = { SESSIONS: staleKv(), LATEX_CLOUD_RUN_URL: 'https://latex.run.app', LATEX_CLOUD_RUN_TOKEN: 'c' };
    const sha = 'a'.repeat(64);
    const ask = (email, body) => handleLatex(new Request('https://w/latex/jobs', { method: 'POST', body: JSON.stringify(body) }), env, '/latex/jobs', as(email));

    const need = await ask('a@b.c', { project: 'p1', manifest: { 'main.tex': sha }, files: [] });
    assert.equal(need.status, 409);
    assert.deepEqual(await need.json(), { need: ['main.tex'] });
    const again = await ask('a@b.c', { project: 'p1', manifest: { 'main.tex': sha }, files: [{ path: 'main.tex', base64: 'eA==' }], fresh: true });
    assert.equal((await again.json()).cached, true);
    await ask('x@y.z', { project: 'p1', manifest: { 'main.tex': sha }, files: [] });
    assert.equal(sent[0].project, sent[1].project);
    assert.notEqual(sent[0].project, sent[2].project);
    assert.match(sent[0].project, /^[a-f0-9]{40}$/);
    assert.deepEqual([sent[0].manifest, sent[1].fresh], [{ 'main.tex': sha }, true]);
    assert.equal((await ask('a@b.c', { project: 'p1', manifest: { '../x': sha }, files: [] })).status, 400);
  });

  it('compiles where the page asks, warms Cloud Run, and says when the asked-for one isn’t set up', async (t) => {
    const asked = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      asked.push(String(url));
      return String(url).endsWith('/compile') ? Response.json({ pdf: btoa('%PDF'), log: '', exit: 0, seconds: 3.2 }) : String(url).endsWith('/') ? Response.json({ ok: true }) : new Response(null, { status: 204 });
    });
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    const tools = { json, headers: {}, authorized: async () => ({ email: 'a@b.c' }), personOverLimit: async () => false, tally: () => {} };
    const files = [{ path: 'main.tex', base64: btoa('x') }];
    const both = { SESSIONS: staleKv(), LATEX_JOBS: jobObjects(), LATEX_CLOUD_RUN_URL: 'https://latex.run.app', LATEX_CLOUD_RUN_TOKEN: 'c', LATEX_GITHUB_TOKEN: 'g', LATEX_RUNNER_TOKEN: 'r' };
    const ask = (env, path, init = {}) => handleLatex(new Request(`https://w${path}`, init), env, path, tools);

    const github = await (await ask(both, '/latex/jobs', { method: 'POST', body: JSON.stringify({ files, on: 'github' }) })).json();
    assert.deepEqual([github.on, github.state], ['github', 'queued']);
    assert.match(asked.pop(), /api\.github\.com/);

    const cloud = await (await ask(both, '/latex/jobs', { method: 'POST', body: JSON.stringify({ files, on: 'cloudrun' }) })).json();
    assert.equal(cloud.seconds, 3.2);

    const warm = await (await ask(both, '/latex/warm', { method: 'POST' })).json();
    assert.equal(warm.warm, true);
    assert.equal(asked.pop(), 'https://latex.run.app/');

    const onlyGithub = { SESSIONS: staleKv(), LATEX_JOBS: jobObjects(), LATEX_GITHUB_TOKEN: 'g', LATEX_RUNNER_TOKEN: 'r' };
    const refused = await ask(onlyGithub, '/latex/jobs', { method: 'POST', body: JSON.stringify({ files, on: 'cloudrun' }) });
    assert.equal(refused.status, 501);
    assert.match((await refused.json()).error, /Cloud Run/);
  });

  it('uses GitHub Actions only when Cloud Run isn’t set up, and an https:// service only', () => {
    assert.equal(latexCompiler({ SESSIONS: {}, LATEX_GITHUB_TOKEN: 'g', LATEX_RUNNER_TOKEN: 'r' }), 'github');
    assert.equal(latexCompiler({ SESSIONS: {}, LATEX_CLOUD_RUN_URL: 'http://latex.run.app', LATEX_CLOUD_RUN_TOKEN: 'c' }), null);
    assert.equal(latexCompiler({ LATEX_CLOUD_RUN_URL: 'https://latex.run.app', LATEX_CLOUD_RUN_TOKEN: 'c' }), null);
  });

  it('a paper in Drive: the Overleaf token kept sealed, handed to Cloud Run for each sync, dropped when Overleaf refuses it', async (t) => {
    const sent = [];
    let refuse = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      sent.push({ url: String(url), job: JSON.parse(init.body) });
      return refuse ? Response.json({ error: 'Overleaf refused the Git token', needToken: true }, { status: 401 }) : Response.json({ ok: true, commit: 'abc1234', files: [], deleted: [], conflicts: [], tree: {} });
    });
    const kv = staleKv();
    const kept = new Map();
    kv.get = async (key) => kept.get(key) ?? null;
    kv.put = async (key, value) => void kept.set(key, value);
    kv.delete = async (key) => void kept.delete(key);
    const env = { SESSIONS: kv, LATEX_CLOUD_RUN_URL: 'https://latex.run.app', LATEX_CLOUD_RUN_TOKEN: 'c' };
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    const tools = { json, headers: {}, authorized: async () => ({ email: 'a@b.c' }), personOverLimit: async () => false, tally: () => {} };
    const ask = (path, init = {}) => handleLatex(new Request(`https://w${path}`, init), env, path, tools);
    const url = 'https://git.overleaf.com/621baf31fcfddbde3bf5fdf8';
    const sync = (extra = {}) => ask('/latex/overleaf/sync', { method: 'POST', body: JSON.stringify({ url, base: '', changed: [], deleted: [], manifest: {}, ...extra }) });

    assert.equal((await (await ask('/latex/overleaf/token')).json()).known, false);
    const first = await sync();
    assert.equal(first.status, 400);
    assert.equal((await first.json()).needToken, true);
    assert.equal((await sync({ token: 'olp_secret' })).status, 200);
    assert.equal(sent.at(-1).url, 'https://latex.run.app/git/sync');
    assert.equal(sent.at(-1).job.token, 'olp_secret');
    assert.ok(![...kept.values()].some((value) => value.includes('olp_secret')), 'not kept in the clear');
    assert.equal((await (await ask('/latex/overleaf/token')).json()).known, true);
    await sync();
    assert.equal(sent.at(-1).job.token, 'olp_secret', 'the kept token is used');
    refuse = true;
    assert.equal((await sync()).status, 401);
    assert.equal((await (await ask('/latex/overleaf/token')).json()).known, false, 'a refused token is dropped');
    assert.equal((await sync({ url: 'https://evil.example/repo' })).status, 400);
  });

  it('seals and opens a token, and opens nothing sealed under another secret', async () => {
    const sealed = await sealToken({ LATEX_CLOUD_RUN_TOKEN: 'one' }, 'olp_x');
    assert.equal(await openToken({ LATEX_CLOUD_RUN_TOKEN: 'one' }, sealed), 'olp_x');
    assert.equal(await openToken({ LATEX_CLOUD_RUN_TOKEN: 'two' }, sealed), null);
  });
});
