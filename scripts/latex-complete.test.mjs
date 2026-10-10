// LaTeX autocomplete: what is being typed at the caret, and what fits it —
// commands, environments with their \end, cite keys, labels, files.
//
//   node --test scripts/latex-complete.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const lc = await load('src/lib/latexComplete.ts');

after(cleanup);

const at = (text) => {
  const caret = text.indexOf('|');
  return { text: text.replace('|', ''), caret };
};
const ctx = (text) => {
  const { text: t, caret } = at(text);
  return lc.contextAt(t, caret);
};
const sources = {
  files: [
    { path: 'main.tex', text: '\\newcommand{\\method}{LossFree}\n\\DeclareMathOperator{\\topk}{TopK}\n\\section{Intro}\\label{sec:intro}\n\\begin{figure}\\label{fig:load}\\end{figure}\n\\newenvironment{claim}{}{}' },
    { path: 'sections/method.tex', text: '\\begin{equation}\\label{eq:bias}x\\end{equation}' },
  ],
  paths: ['main.tex', 'sections/method.tex', 'figures/load.png', 'figures/arch.pdf', 'refs.bib', 'notes.txt'],
  keys: [
    { key: 'wang2024auxiliary', detail: 'Auxiliary-Loss-Free Load Balancing' },
    { key: 'fedus2021switch', detail: 'Switch Transformers' },
    { key: 'zoph2022stmoe', detail: 'ST-MoE' },
  ],
};
const run = (text) => {
  const { text: t, caret } = at(text);
  return lc.complete(t, caret, sources);
};
/** The text with the first suggestion taken, and the caret where it would be. */
const take = (text, index = 0) => {
  const { text: t, caret } = at(text);
  const done = lc.complete(t, caret, sources);
  const item = done.items[index];
  const out = t.slice(0, done.from) + item.insert + t.slice(done.to);
  const where = done.from + (item.caret ?? item.insert.length);
  return out.slice(0, where) + '|' + out.slice(where);
};

describe('what is being typed', () => {
  it('knows a command, a \\begin, a \\cite, a \\ref and a file', () => {
    assert.deepEqual(ctx('see \\sec|'), { kind: 'command', prefix: 'sec', from: 5, to: 8 });
    assert.equal(ctx('\\begin{fig|').kind, 'begin');
    assert.equal(ctx('\\end{|').kind, 'end');
    assert.deepEqual(ctx('as in~\\citep[p.~3]{fedus2021switch, wa|}'), { kind: 'cite', prefix: 'wa', from: 36, to: 38 });
    assert.equal(ctx('Fig.~\\ref{fig:|}').kind, 'ref');
    assert.equal(ctx('\\cref{|').kind, 'ref');
    assert.equal(ctx('\\input{sec|}').kind, 'input');
    assert.equal(ctx('\\includegraphics[width=\\linewidth]{fig|}').kind, 'graphics');
    assert.equal(ctx('\\bibliography{|}').kind, 'bib');
    assert.equal(ctx('\\addbibresource{|}').kind, 'bibresource');
  });

  it('stays quiet in plain text, in a comment, and on a bare backslash', () => {
    assert.equal(ctx('plain words|'), null);
    assert.equal(ctx('% \\sec|'), null);
    assert.equal(ctx('50\\% \\sec|').kind, 'command');
    assert.equal(ctx('line \\\\|'), null);
    assert.equal(ctx('\\|'), null);
  });

  it('replaces the whole word, also the part after the caret', () => {
    assert.deepEqual(ctx('\\cite{wa|ng}'), { kind: 'cite', prefix: 'wa', from: 6, to: 10 });
    assert.deepEqual(ctx('\\textb|f{x}'), { kind: 'command', prefix: 'textb', from: 1, to: 7 });
  });
});

describe('what fits', () => {
  it('offers commands, the caret in their first argument', () => {
    assert.equal(run('\\sec|').items[0].label, '\\section{}');
    assert.equal(take('\\sec|'), '\\section{|}');
    assert.equal(take('\\textb|'), '\\textbf{|}');
    assert.equal(take('\\maket|'), '\\maketitle|');
    assert.equal(take('\\includeg|'), '\\includegraphics[width=\\linewidth]{|}');
  });

  it('offers the paper’s own commands', () => {
    const items = run('\\met|').items.map((item) => item.label);
    assert.ok(items.includes('\\method'), items.join(' '));
    assert.ok(run('\\top|').items.some((item) => item.label === '\\topk'));
  });

  it('fills in \\end for an environment, the caret inside', () => {
    assert.equal(take('\\begin{enu|'), '\\begin{enumerate}\n    \\item |\n\\end{enumerate}');
    assert.equal(take('  \\begin{equation|}'), '  \\begin{equation}\n      |\n  \\end{equation}');
    assert.equal(take('\\begin{item|}'), '\\begin{itemize}\n    \\item |\n\\end{itemize}');
    assert.equal(take('\\begin{figure|'), '\\begin{figure}\n    \\centering\n    \\includegraphics[width=\\linewidth]{|}\n    \\caption{}\n    \\label{fig:}\n\\end{figure}');
    assert.ok(run('\\begin{cl|').items.some((item) => item.label === 'claim'));
  });

  it('closes the environment that is open', () => {
    assert.equal(run('\\begin{itemize}\\begin{table}\\end{table}\\item x \\end{|').items[0].label, 'itemize');
  });

  it('offers cite keys by key, labels by name, files by path', () => {
    assert.deepEqual(run('\\cite{|').items.map((item) => item.label), ['wang2024auxiliary', 'fedus2021switch', 'zoph2022stmoe']);
    assert.deepEqual(run('\\cite{fedus2021switch,z|}').items.map((item) => item.label), ['zoph2022stmoe']);
    assert.deepEqual(run('\\ref{fig|').items.map((item) => item.label), ['fig:load']);
    assert.deepEqual(run('\\eqref{|').items.map((item) => [item.label, item.detail]).find(([label]) => label === 'eq:bias'), ['eq:bias', 'sections/method.tex']);
    assert.deepEqual(run('\\input{sec|').items.map((item) => item.insert), ['sections/method']);
    assert.deepEqual(run('\\includegraphics{|').items.map((item) => item.insert), ['figures/load.png', 'figures/arch.pdf']);
    assert.deepEqual(run('\\bibliography{|').items.map((item) => item.insert), ['refs']);
    assert.deepEqual(run('\\addbibresource{|').items.map((item) => item.insert), ['refs.bib']);
  });

  it('finds by any part of the name, the start first', () => {
    assert.deepEqual(run('\\cite{switch|').items.map((item) => item.label), ['fedus2021switch']);
    assert.equal(run('\\cite{nothing|'), null);
  });
});
