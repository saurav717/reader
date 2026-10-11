// Compiling on GitHub: the files the Worker takes for a job (worker/latex.js),
// and the errors read out of the log that comes back (src/lib/latexGithub.ts).
//
//   node --test scripts/latex-github.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';
import { FREE_MINUTES, cleanFiles, isLatexPath, latexMonth, summarize } from '../worker/latex.js';

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
