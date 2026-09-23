// Finding a paper's citations in its text and tying them to its bibliography,
// which is what the hover card over "[12]" or "(Vaswani et al., 2017)" reads
// from; and what can be read off an entry before anyone is asked about it.
//
//   node --test scripts/citations.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { citationNumbers, findCitations, parseReference, referenceIndex, titleFits } = await load('src/lib/citations.ts');

after(cleanup);

const numbered = referenceIndex(
  Array.from({ length: 20 }, (_, i) => ({ id: `ref-${i + 1}`, text: `[${i + 1}] A. Author${i + 1}. A paper. 2020.` })),
);

const authorYear = referenceIndex([
  { id: 'ref-1', text: 'Brown, T., Mann, B., et al. (2020). Language models are few-shot learners. NeurIPS.' },
  { id: 'ref-2', text: 'Devlin, J., Chang, M.-W., Lee, K., and Toutanova, K. (2019a). BERT: Pre-training of deep bidirectional transformers.' },
  { id: 'ref-3', text: 'Ashish Vaswani, Noam Shazeer, and Illia Polosukhin. 2017. Attention is all you need. In NeurIPS.' },
  { id: 'ref-4', text: 'van der Maaten, L. and Hinton, G. (2008). Visualizing data using t-SNE. JMLR.' },
]);

const cited = (text, index) => findCitations(text, index).map((match) => [text.slice(match.start, match.end), match.refs]);

describe('numbers in brackets', () => {
  it('reads lists and ranges', () => {
    assert.deepEqual(citationNumbers('3, 5–7'), [3, 5, 6, 7]);
    assert.deepEqual(citationNumbers('12'), [12]);
    assert.equal(citationNumbers('3, a'), null);
    assert.equal(citationNumbers('9-2'), null);
  });

  it('finds each citation and the entries it names', () => {
    assert.deepEqual(cited('as shown in [12] and [3, 5-6].', numbered), [
      ['[12]', ['ref-12']],
      ['[3, 5-6]', ['ref-3', 'ref-5', 'ref-6']],
    ]);
  });

  it('leaves a bracket alone when the bibliography has no such entry', () => {
    assert.deepEqual(cited('the interval [0, 1] and [99]', numbered), []);
  });

  it('numbers an unlabelled list in order', () => {
    const index = referenceIndex([
      { id: 'a', text: 'Smith. One paper. 2001.' },
      { id: 'b', text: 'Jones. Another paper. 2002.' },
    ]);
    assert.equal(index.byNumber(2), 'b');
  });
});

describe('author and year', () => {
  it('finds a parenthetical citation, each part on its own', () => {
    assert.deepEqual(cited('models (Brown et al., 2020; Devlin et al., 2019a) do', authorYear), [
      ['Brown et al., 2020', ['ref-1']],
      ['Devlin et al., 2019a', ['ref-2']],
    ]);
  });

  it('finds a narrative citation', () => {
    assert.deepEqual(cited('as Vaswani et al. (2017) showed', authorYear), [['Vaswani et al. (2017)', ['ref-3']]]);
  });

  it('matches a year printed without its letter', () => {
    assert.deepEqual(cited('(Devlin et al., 2019)', authorYear), [['Devlin et al., 2019', ['ref-2']]]);
  });

  it('ignores a name and year that are not in the bibliography', () => {
    assert.deepEqual(cited('(Nobody et al., 2011)', authorYear), []);
  });
});

describe('reading an entry', () => {
  it('finds the title in each common style', () => {
    const styles = [
      '[3] A. Vaswani, N. Shazeer, and I. Polosukhin. Attention is all you need. In NeurIPS, 2017.',
      'Vaswani, A., Shazeer, N., and Polosukhin, I. (2017). Attention is all you need. In NeurIPS.',
      'Vaswani A, Shazeer N (2017) Attention is all you need. NeurIPS 30:5998–6008',
      'A. Vaswani et al., “Attention is all you need,” in NeurIPS, 2017.',
    ];
    for (const style of styles) assert.equal(parseReference(style).title, 'Attention is all you need', style);
  });

  it('ends a title at a full stop after capitals and small letters', () => {
    const entry = '[3] K. Bhattacharya and A. Stuart. Model reduction and neural networks for parametric PDEs. SMAI Journal, 2021.';
    assert.equal(parseReference(entry).title, 'Model reduction and neural networks for parametric PDEs');
  });

  it('reads the number, year, DOI and arXiv id', () => {
    const parsed = parseReference('[7] J. Doe. A thing. arXiv preprint arXiv:2106.09685, 2021. doi:10.1000/xyz.123.');
    assert.equal(parsed.number, 7);
    assert.equal(parsed.year, '2021');
    assert.equal(parsed.arxivId, '2106.09685');
    assert.equal(parsed.doi, '10.1000/xyz.123');
  });

  it('takes a search result only when its title is in the entry', () => {
    const entry = 'A. Vaswani et al. Attention is all you need. In NeurIPS, 2017.';
    assert.ok(titleFits('Attention Is All You Need', entry));
    assert.ok(!titleFits('Attention Is Not All You Need: Pure Attention Loses Rank', entry));
    assert.ok(!titleFits('Need', entry));
  });
});
