// The Git mirror: what it writes, and that a flush is one commit rather than
// one commit per file. GitHub is stubbed — these assertions are about the
// shape of what we send, not about the API being reachable.
//
//   node --test scripts/github.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { parseRepo, citeKey, toBibtex, pathFor, filesFor, commitFiles, toMarkdown } =
  await load('src/lib/github.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

const paper = (overrides = {}) => ({
  id: 'arxiv:2010.08895',
  source: 'arxiv',
  title: 'Fourier Neural Operator for Parametric PDEs',
  authors: ['Zongyi Li', 'Anima Anandkumar'],
  abstract: 'An operator learning method.',
  published: '2020-10-18',
  categories: ['cs.LG'],
  arxivId: '2010.08895',
  landingUrl: 'https://arxiv.org/abs/2010.08895',
  addedAt: '2024-01-01T00:00:00.000Z',
  collectionIds: ['c1'],
  tags: [],
  progress: 0,
  ...overrides,
});

const collections = [{ id: 'c1', name: 'Operator learning', color: '#000', createdAt: '' }];

const highlight = (overrides = {}) => ({
  id: 'h1',
  paperId: 'arxiv:2010.08895',
  color: 'yellow',
  exact: 'the operator is learned in Fourier space',
  prefix: '',
  suffix: '',
  hint: 0,
  tags: [],
  createdAt: '2024-01-02T00:00:00.000Z',
  ...overrides,
});

describe('reading the repository setting', () => {
  it('accepts owner/repo and a full URL alike', () => {
    assert.deepEqual(parseRepo('you/papers'), { owner: 'you', repo: 'papers' });
    assert.deepEqual(parseRepo('https://github.com/you/papers'), { owner: 'you', repo: 'papers' });
    assert.deepEqual(parseRepo('https://github.com/you/papers.git'), { owner: 'you', repo: 'papers' });
  });

  it('rejects what is not a repository', () => {
    assert.equal(parseRepo('papers'), null);
    assert.equal(parseRepo('you/papers/tree/main'), null);
    assert.equal(parseRepo(''), null);
  });
});

describe('the bibliography it generates', () => {
  it('builds a cite key a person would recognise', () => {
    assert.equal(citeKey(paper()), 'li2020fourier');
  });

  it('writes a preprint as @misc and a published paper as @article', () => {
    assert.match(toBibtex(paper()), /^@misc\{li2020fourier,/);
    assert.match(toBibtex(paper({ venue: 'ICLR' })), /^@article\{li2020fourier,/);
  });

  it('carries the identifiers a bibliography style needs', () => {
    const entry = toBibtex(paper({ doi: '10.1/x', venue: 'ICLR' }));
    assert.match(entry, /doi = \{10\.1\/x\}/);
    assert.match(entry, /journal = \{ICLR\}/);
    assert.match(entry, /archivePrefix = \{arXiv\}/);
    assert.match(entry, /author = \{Zongyi Li and Anima Anandkumar\}/);
  });

  it('strips the braces that would otherwise break the entry', () => {
    assert.doesNotMatch(toBibtex(paper({ title: 'A {braced} title' })), /\{braced\}/);
  });
});

describe('where a paper lands in the repository', () => {
  it('files it under its collection, as a path-safe name', () => {
    assert.equal(
      pathFor(paper(), collections),
      'collections/operator-learning/fourier-neural-operator-for-parametric-pdes-arxiv-2010.08895',
    );
  });

  it('files a paper in no collection under unsorted', () => {
    assert.match(pathFor(paper({ collectionIds: [] }), collections), /^collections\/unsorted\//);
  });
});

describe('what a flush writes', () => {
  const context = { collections, highlights: [highlight()], library: [paper()] };

  it('writes a sidecar, a note, an index and a bibliography', () => {
    const files = filesFor([paper()], context);
    const paths = Object.keys(files).sort();
    assert.equal(paths.filter((path) => path.endsWith('.json') && path !== 'library.json').length, 1);
    assert.equal(paths.filter((path) => path.endsWith('.md')).length, 1);
    assert.ok(paths.includes('library.json'));
    assert.ok(paths.includes('references.bib'));
  });

  it('puts the highlights in the note under the colour they were made with', () => {
    const markdown = toMarkdown(paper(), [highlight({ note: 'this is the core idea' })], ['Operator learning']);
    assert.match(markdown, /^---\n/);
    assert.match(markdown, /cite: li2020fourier/);
    assert.match(markdown, /### Key claim/);
    assert.match(markdown, /> the operator is learned in Fourier space/);
    assert.match(markdown, /this is the core idea/);
  });

  it('rebuilds the index from the whole library, so a removed paper leaves it', () => {
    const files = filesFor([paper()], { ...context, library: [] });
    assert.deepEqual(JSON.parse(files['library.json']).papers, []);
  });
});

describe('committing', () => {
  let calls = [];
  const target = { owner: 'you', repo: 'papers', branch: 'main', token: 't' };

  const json = (body) => new Response(JSON.stringify(body), { status: 200 });

  beforeEach(() => {
    calls = [];
    const tree = 'NEW_TREE';
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init.method || 'GET'} ${path}`);
      if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'HEAD_SHA' } });
      if (path.includes('/git/commits/HEAD_SHA')) return json({ sha: 'HEAD_SHA', tree: { sha: 'OLD_TREE' } });
      if (path.endsWith('/git/blobs')) return json({ sha: `blob${calls.length}` });
      if (path.endsWith('/git/trees')) return json({ sha: tree });
      if (path.endsWith('/git/commits')) return json({ sha: 'NEW_COMMIT' });
      if (path.endsWith('/git/refs/heads/main')) return json({});
      throw new Error(`unexpected ${path}`);
    };
  });

  it('lands many files in a single commit', async () => {
    const files = { 'a.md': 'a', 'b.md': 'b', 'c.json': '{}', 'references.bib': '' };
    const result = await commitFiles(target, files, 'reader: sync');
    assert.equal(result.commit, 'NEW_COMMIT');
    // Four blobs, but one tree, one commit and one ref update.
    assert.equal(calls.filter((call) => call.endsWith('/git/blobs')).length, 4);
    assert.equal(calls.filter((call) => call.endsWith('/git/trees')).length, 1);
    assert.equal(calls.filter((call) => call === 'POST /repos/you/papers/git/commits').length, 1);
    assert.equal(calls.filter((call) => call.startsWith('PATCH')).length, 1);
  });

  it('makes no commit at all when nothing actually changed', async () => {
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init.method || 'GET'} ${path}`);
      if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'HEAD_SHA' } });
      if (path.includes('/git/commits/HEAD_SHA')) return json({ sha: 'HEAD_SHA', tree: { sha: 'SAME_TREE' } });
      if (path.endsWith('/git/blobs')) return json({ sha: 'blob' });
      // The tree the write produces is identical to the one already there.
      if (path.endsWith('/git/trees')) return json({ sha: 'SAME_TREE' });
      throw new Error(`should not have reached ${path}`);
    };
    const result = await commitFiles(target, { 'a.md': 'a' }, 'reader: sync');
    assert.equal(result.commit, null);
    assert.equal(calls.filter((call) => call === 'POST /repos/you/papers/git/commits').length, 0);
  });

  it('does nothing when there is nothing to write', async () => {
    const result = await commitFiles(target, {}, 'reader: sync');
    assert.equal(result.commit, null);
    assert.equal(calls.length, 0);
  });

  it('explains a missing branch rather than passing on a bare 404', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    await assert.rejects(() => commitFiles(target, { 'a.md': 'a' }, 'm'), /could not be found|does not exist/);
  });

  it('explains a token that is not allowed to write', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'Resource not accessible' }), { status: 403 });
    await assert.rejects(() => commitFiles(target, { 'a.md': 'a' }, 'm'), /Contents: read and write/);
  });
});
