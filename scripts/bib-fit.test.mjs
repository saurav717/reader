// The draft's .bib fitted to its venue: the style read off the template,
// each entry checked, and the fixes applied one by one or all at once.
//
//   node --test scripts/bib-fit.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const bf = await load('src/lib/bibFit.ts');
after(cleanup);

const files = [
  { path: 'main.tex', text: '\\documentclass{article}\n\\usepackage{iclr2027_conference}\n\\usepackage{natbib}\n\\begin{document}\n\\input{sections/related}\n\\bibliographystyle{iclr2027_conference}\n\\bibliography{refs}\n\\end{document}' },
  { path: 'iclr2027_conference.bst', text: '' },
  { path: 'sections/related.tex', text: 'A~\\cite{zhou2022expert}. B~\\citep{shazeer17moe, fedus2021switch}.' },
  {
    path: 'refs.bib',
    text: `@article{zhou2022expert,
  title = {Mixture-of-Experts with Expert Choice Routing},
  author = {Zhou, Yanqi},
  journal = {Advances in Neural Information Processing Systems},
  year = {2022},
  eprint = {2202.09368},
  archivePrefix = {arXiv}
}

@misc{zoph2022stmoe,
  title = {ST-MoE: Designing Stable and Transferable Sparse Expert Models},
  eprint = {2202.08906}
}

@inproceedings{shazeer2017outrageously,
  title = {Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer},
  author = {Shazeer, Noam},
  booktitle = {ICLR},
  year = {2017}
}

@misc{shazeer17moe,
  title = {Outrageously large neural networks: the sparsely-gated mixture-of-experts layer},
  author = {Noam Shazeer}
}
`,
  },
];
const papers = [
  { id: 'arxiv:2202.08906', source: 'arxiv', title: 'ST-MoE: Designing Stable and Transferable Sparse Expert Models', authors: ['Barret Zoph'], abstract: '', published: '2022-02-17', categories: [], arxivId: '2202.08906', addedAt: '', collectionIds: [], tags: [], progress: 0, citation: { variants: [], publishedDoi: '10.5555/x', publishedIn: 'JMLR 23 (2022)' } },
];
const published = (paper, key) => `@article{${key},\n  title = {ST-MoE},\n  journal = {JMLR},\n  year = {2022}\n}`;

describe('the style', () => {
  it('is ICLR, author–year, from the .bst and the package', () => {
    const style = bf.styleOf(files);
    assert.equal(style.name, 'ICLR');
    assert.equal(style.bst, 'iclr2027_conference');
    assert.equal(style.authorYear, true);
  });

  it('is numeric for IEEEtran and plain, biblatex when that is loaded', () => {
    assert.equal(bf.styleOf([{ path: 'main.tex', text: '\\documentclass{IEEEtran}\n\\bibliographystyle{IEEEtran}' }]).authorYear, false);
    assert.equal(bf.styleOf([{ path: 'main.tex', text: '\\bibliographystyle{plain}' }]).name, 'plain');
    // The style named in the .tex runs; a .bst left over from another template does not.
    assert.equal(bf.styleOf([{ path: 'main.tex', text: '\\documentclass[conference]{IEEEtran}\n\\bibliographystyle{IEEEtran}' }, { path: 'iclr2027_conference.bst', text: '' }]).name, 'IEEE');
    assert.equal(bf.styleOf([{ path: 'main.tex', text: '\\usepackage[style=authoryear]{biblatex}' }]).biblatex, true);
    assert.equal(bf.styleOf([{ path: 'main.tex', text: '\\usepackage[style=authoryear]{biblatex}' }]).authorYear, true);
  });
});

describe('the issues', () => {
  const report = bf.bibFit(files, papers, published);
  it('are found, worst first: the conference @article, the entries with no author or year, the preprint, the eprint, the twin', () => {
    assert.deepEqual(
      report.issues.map((issue) => issue.id),
      ['conf:zhou2022expert', 'authoryear:zoph2022stmoe', 'authoryear:shazeer17moe', 'published:zoph2022stmoe', 'eprint:zhou2022expert', 'dup:shazeer17moe'],
    );
    assert.equal(report.entries, 4);
  });

  it('fills the author and year in from the paper where the project has it, and says when it cannot', () => {
    const zoph = report.issues.find((issue) => issue.id === 'authoryear:zoph2022stmoe');
    assert.match(zoph.fix.bib[0].text, /@misc\{zoph2022stmoe,\n  title\s+= \{ST-MoE[^}]*\},\n  author\s+= \{Barret Zoph\},\n  year\s+= \{2022\}/);
    assert.equal(report.issues.find((issue) => issue.id === 'authoryear:shazeer17moe').fix, undefined);
  });

  it('merges a twin: the entry taken out and the \\cite rewritten', () => {
    const dup = report.issues.find((issue) => issue.id === 'dup:shazeer17moe');
    assert.doesNotMatch(dup.fix.bib[0].text, /shazeer17moe/);
    assert.equal(dup.fix.tex[0].text, 'A~\\cite{zhou2022expert}. B~\\citep{shazeer2017outrageously, fedus2021switch}.');
  });

  it('applied all at once, each fix lands on the one before', () => {
    const changed = bf.applyAll(files, report.issues, papers, published);
    const bib = changed.find((file) => file.path === 'refs.bib').text;
    assert.match(bib, /^@inproceedings\{zhou2022expert,/);
    assert.match(bib, /booktitle = \{Advances in Neural Information Processing Systems\}/);
    assert.doesNotMatch(bib, /eprint\s*= \{2202\.09368\}/);
    assert.match(bib, /@article\{zoph2022stmoe,\n  title = \{ST-MoE\}/);
    assert.doesNotMatch(bib, /shazeer17moe/);
    assert.equal(bf.bibFit([...files.filter((file) => !changed.some((item) => item.path === file.path)), ...changed], papers, published).issues.filter((issue) => issue.fix).length, 0);
  });
});
