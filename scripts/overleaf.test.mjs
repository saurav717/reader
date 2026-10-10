// A project's paper in Overleaf: the link however it was pasted, the outline
// and words of the .tex files, the \cite keys and which papers they are, and
// a write that will not go over a change made in Overleaf. GitHub is stubbed.
//
//   node --test scripts/overleaf.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const ol = await load('src/lib/overleaf.ts');
const pj = await load('src/lib/projects.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

const paper = (id, more = {}) => ({ id, source: 'arxiv', title: id, authors: [], abstract: '', published: '', categories: [], addedAt: '2026-02-01T00:00:00.000Z', collectionIds: [], tags: [], progress: 0, ...more });

describe('the link', () => {
  it('takes the editor address, a share link, or no scheme', () => {
    assert.equal(ol.parseOverleafUrl('https://www.overleaf.com/project/66F1C0A9E2B7D4A1B2C3D4E5/detached'), 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5');
    assert.equal(ol.parseOverleafUrl('www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5'), 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5');
    assert.equal(ol.parseOverleafUrl('https://www.overleaf.com/read/abcdefghjkmn'), 'https://www.overleaf.com/read/abcdefghjkmn');
    assert.equal(ol.parseOverleafUrl('https://www.overleaf.com/4815162342abcdefghijkl'), 'https://www.overleaf.com/4815162342abcdefghijkl');
    assert.equal(ol.parseOverleafUrl('https://latex.example.edu/project/66f1c0a9e2b7d4a1b2c3d4e5'), 'https://latex.example.edu/project/66f1c0a9e2b7d4a1b2c3d4e5');
  });

  it('refuses what is not a project', () => {
    for (const bad of ['', 'overleaf', 'https://www.overleaf.com/project', 'https://www.overleaf.com/learn/latex', 'javascript:alert(1)', 'ftp://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5']) {
      assert.equal(ol.parseOverleafUrl(bad), null, bad);
    }
  });

  it('is put right when it comes back from Drive, and kept on the project record', () => {
    assert.equal(ol.overleafLinkOf({ url: 'nope' }), undefined);
    assert.deepEqual(ol.overleafLinkOf({ url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', repo: 'https://github.com/me/paper.git', branch: ' ', folder: '/paper/' }), {
      url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5',
      repo: 'me/paper',
      folder: 'paper',
    });
    assert.deepEqual(ol.overleafLinkOf({ url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', branch: 'x', folder: 'y' }), { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5' });
    const info = pj.projectInfo({ id: 'p', name: 'P', color: '#000', createdAt: '2026-01-01', project: { question: '', roles: {}, todos: [], overleaf: { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5' } } });
    assert.equal(info.overleaf.url, 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5');
    assert.equal(pj.projectInfo({ id: 'p', name: 'P', color: '#000', createdAt: '2026-01-01', project: { overleaf: { url: 'bad' } } }).overleaf, undefined);
  });

  it('keeps the account and each computer’s browser, and drops a browser that is not one', () => {
    const link = ol.overleafLinkOf({
      url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5',
      account: ' me@lab.edu ',
      browsers: { mac: { browser: 'chrome', profile: 'Profile 1', label: 'Google Chrome · Work' }, pc: { browser: '--evil', label: 'x' }, old: { browser: 'firefox' }, gone: null },
    });
    assert.equal(link.account, 'me@lab.edu');
    assert.deepEqual(link.browsers, { mac: { browser: 'chrome', profile: 'Profile 1', label: 'Google Chrome · Work' }, old: { browser: 'firefox', label: 'firefox' } });
    assert.equal(ol.overleafLinkOf({ url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', browsers: { pc: { browser: '' } } }).browsers, undefined);
  });

  it('falls back to the default view for a choice it does not know', () => {
    assert.equal(ol.overleafViewOf({ overleafView: 'dock' }), 'dock');
    assert.equal(ol.overleafViewOf({ overleafView: 'somewhere' }), 'beside');
  });

  it('puts the window on the right half of the screen', () => {
    assert.equal(ol.besideFeatures({ availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875 }), 'popup,left=720,top=25,width=720,height=875');
  });
});

const files = [
  {
    path: 'main.tex',
    text: '\\documentclass{article}\n\\usepackage{natbib}\n\\begin{document}\n\\section{Introduction}\nMixture of experts route tokens.% a comment that is not counted\n\\input{related}\n\\bibliography{refs}\n\\end{document}\n',
  },
  {
    path: 'related.tex',
    text: '\\section{Related work}\n\\paragraph{Load balancing.} Most models use an auxiliary loss~\\cite{fedus2022switch, zoph2022stmoe}.\n% \\cite{commented2020out}\n\\citet[p.~3]{wang2024auxfree} add a bias $b_i$ used only for \\textbf{selection}.\n\\subsection*{Routing at scale}\nGShard~\\citep{nobody2020gone}.\n',
  },
  { path: 'refs.bib', text: '@comment{x}\n@article{fedus2022switch,\n  title = {Switch Transformers: Scaling to Trillion Parameter Models},\n  doi = {10.5555/SWITCH}\n}\n@misc{zoph2022stmoe, title = "ST-MoE", eprint = {2202.08906}}\n@misc{wang2024auxfree,\n title={Auxiliary-Loss-Free Load Balancing},\n}\n' },
];

describe('the files', () => {
  it('counts words without commands, maths or comments', () => {
    assert.equal(ol.wordCount('Hello \\textbf{bold} world~\\cite{a} with $x^2$ maths. % not this'), 5);
  });

  it('makes an outline across files, with words under each heading', () => {
    const headings = ol.outline(files);
    assert.deepEqual(headings.map((h) => [h.level, h.title, h.path, h.line]), [
      [2, 'Introduction', 'main.tex', 4],
      [2, 'Related work', 'related.tex', 1],
      [3, 'Routing at scale', 'related.tex', 5],
    ]);
    assert.equal(headings[2].words, 1);
    assert.ok(headings[1].words > 10);
    assert.equal(headings[1].total, headings[1].words + headings[2].words);
    assert.equal(headings[0].total, headings[0].words);
  });

  it('reads the files in the order the main file pulls them in', () => {
    const order = ol.readingOrder([
      { path: 'paper/a.tex', text: '\\section{A}' },
      { path: 'paper/main.tex', text: '\\documentclass{article}\n\\input{sec/z}\n% \\input{a}\n\\include{./a.tex}' },
      { path: 'paper/sec/z.tex', text: '\\section{Z}' },
      { path: 'paper/notes.tex', text: '' },
    ]).map((file) => file.path);
    assert.deepEqual(order, ['paper/main.tex', 'paper/sec/z.tex', 'paper/a.tex', 'paper/notes.tex']);
  });

  it('finds every cited key, not the commented ones', () => {
    const keys = ol.citationsIn(files).map((c) => `${c.key}@${c.path}:${c.line}`);
    assert.deepEqual(keys, ['fedus2022switch@related.tex:2', 'zoph2022stmoe@related.tex:2', 'wang2024auxfree@related.tex:4', 'nobody2020gone@related.tex:6']);
  });

  it('reads the bib entries, and tells which paper each is', () => {
    const entries = ol.bibEntries(files);
    assert.deepEqual(entries.map((e) => e.key), ['fedus2022switch', 'zoph2022stmoe', 'wang2024auxfree']);
    assert.equal(ol.entryFor(paper('s', { title: 'Something else', doi: '10.5555/switch' }), entries).key, 'fedus2022switch');
    assert.equal(ol.entryFor(paper('z', { arxivId: '2202.08906v2' }), entries).key, 'zoph2022stmoe');
    assert.equal(ol.entryFor(paper('w', { title: 'Auxiliary-loss-free load balancing' }), entries).key, 'wang2024auxfree');
    assert.equal(ol.keyFor(paper('n', { title: 'Novel Things', authors: ['Ada Lovelace'], published: '2025-01-01' }), entries), 'lovelace2025novel');
    assert.match(ol.bibtexFor(paper('z', { arxivId: '2202.08906', title: 'ST-MoE' }), entries), /^@misc\{zoph2022stmoe,/);
  });

  it('says what is cited, what is read and not, and which keys are missing', () => {
    const switchPaper = paper('switch', { doi: '10.5555/switch', progress: 1 });
    const unread = paper('unread', { title: 'An unread paper with a long title' });
    const read = paper('read', { title: 'A read paper with a long title', lastOpenedAt: '2026-03-01' });
    const health = ol.draftHealth(files, [switchPaper, unread, read]);
    assert.deepEqual(health.cited.map((c) => [c.paper.id, c.key, c.at.length]), [['switch', 'fedus2022switch', 1]]);
    assert.deepEqual(health.readNotCited.map((p) => p.id), ['read']);
    assert.deepEqual(health.missing, ['nobody2020gone']);
    assert.ok(health.words > 20);
  });

  it('finds the main file and the bib file the main file names', () => {
    assert.equal(ol.mainFileOf(files), 'main.tex');
    assert.equal(ol.bibFileOf([...files, { path: 'other.bib', text: '' }]), 'refs.bib');
  });

  it('quotes a passage the way LaTeX does', () => {
    assert.equal(ol.quoteOf('  50% of  {tokens}\n go_to', 'k'), "``50\\% of tokens go\\_to''~\\cite{k}");
  });

  it('highlights commands, comments and maths', () => {
    assert.equal(ol.highlightTex('\\cite{a} 50\\% $x$ % c <'), '<span class="tok-k">\\cite</span>{a} 50<span class="tok-k">\\%</span> <span class="tok-n">$x$</span> <span class="tok-c">% c &lt;</span>');
  });
});

describe('GitHub', () => {
  const link = { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', repo: 'me/paper', folder: 'paper' };
  const target = ol.draftTarget(link, { githubToken: ' t ' });
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

  it('needs both a repository and a token', () => {
    assert.equal(ol.draftTarget({ url: link.url }, { githubToken: 't' }), null);
    assert.equal(ol.draftTarget(link, { githubToken: '' }), null);
    assert.deepEqual(target, { owner: 'me', repo: 'paper', branch: 'main', token: 't' });
  });

  it('reads the .tex and .bib files in the folder', async () => {
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).includes('/git/trees/')) {
        return Response.json({ tree: [
          { path: 'paper/main.tex', type: 'blob', sha: 'a', size: 10 },
          { path: 'paper/fig.png', type: 'blob', sha: 'b', size: 10 },
          { path: 'other/x.tex', type: 'blob', sha: 'c', size: 10 },
          { path: 'paper/refs.bib', type: 'blob', sha: 'd', size: 10 },
        ] });
      }
      return Response.json({ content: b64(String(url).endsWith('/a') ? 'Überall \\cite{k}' : '@misc{k,}'), encoding: 'base64' });
    };
    const read = await ol.readDraft(target, link);
    assert.deepEqual(read, [{ path: 'paper/main.tex', text: 'Überall \\cite{k}', sha: 'a' }, { path: 'paper/refs.bib', text: '@misc{k,}', sha: 'd' }]);
    assert.ok(asked[0].endsWith('/repos/me/paper/git/trees/main?recursive=1'));
  });

  it('will not write over a file changed in Overleaf since it was read', async () => {
    const methods = [];
    globalThis.fetch = async (url, init = {}) => {
      methods.push(init.method ?? 'GET');
      return Response.json({ tree: [{ path: 'paper/main.tex', type: 'blob', sha: 'moved' }] });
    };
    await assert.rejects(ol.writeDraft(target, [{ path: 'paper/main.tex', text: 'x', sha: 'a' }], 'm'), (error) => error instanceof ol.DraftConflict && error.paths[0] === 'paper/main.tex');
    assert.deepEqual(methods, ['GET']);
  });
});
