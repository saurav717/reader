// The Write tab's citation helper: the sentence at the caret, which of the
// project's papers fit it (your highlights first), and the claims that cite
// nothing.
//
//   node --test scripts/cite-suggest.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const cs = await load('src/lib/citeSuggest.ts');
after(cleanup);

const P = (id, title, abstract) => ({ id, source: 'arxiv', title, authors: [], abstract, published: '2022', categories: [], addedAt: '', collectionIds: [], tags: [], progress: 0 });
const papers = [
  P('a', 'Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts', 'A bias term added to the routing scores, used only for top-K selection, updated by the load of each expert, so no auxiliary loss is needed.'),
  P('b', 'ST-MoE: Designing Stable and Transferable Sparse Expert Models', 'Router z-loss stabilises training of sparse expert models; we trade balance against quality.'),
  P('c', 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', 'An auxiliary load balancing loss and expert capacity; top-1 routing is enough.'),
  P('d', 'Attention Is All You Need', 'The Transformer, based solely on attention mechanisms.'),
];
const highlights = [{ id: 'h1', paperId: 'a', color: 'yellow', exact: 'a per-expert bias used only for selection, updated from the load each batch', prefix: '', suffix: '', hint: 0, tags: [], createdAt: '' }];

const TEX = `\\section{Related work}
\\paragraph{Load balancing.}
Most MoE models keep experts busy with an auxiliary loss on the router~\\cite{fedus2021switch}.
Expert choice routing side-steps this by letting experts pick tokens.
% a comment that has been shown to be ignored
Closest to us, a per-expert bias used only for selection, updated from the load each batch, balances without a loss.
Top-1 routing was later shown to be enough, and cheaper, at the same quality.
GShard~\\cite{lepikhin2020gshard} trained a 600B-parameter MoE with top-2 gating and achieves 95\\% accuracy.`;

describe('the sentence at the caret', () => {
  it('is the one just ended, comment lines before it left out', () => {
    const caret = TEX.indexOf('without a loss.') + 'without a loss.'.length;
    assert.equal(cs.sentenceAt(TEX, caret).text, 'Closest to us, a per-expert bias used only for selection, updated from the load each batch, balances without a loss.');
    assert.equal(cs.atSentenceEnd(TEX, caret), true);
    assert.equal(cs.atSentenceEnd(TEX, caret - 1), false);
  });

  it('is the one being written, up to its end, when the caret is inside it', () => {
    const caret = TEX.indexOf('later shown');
    assert.equal(cs.sentenceAt(TEX, caret).text, 'Top-1 routing was later shown to be enough, and cheaper, at the same quality.');
  });

  it('knows a \\cite{?} or an empty \\cite{} asked for by hand', () => {
    assert.deepEqual(cs.askedAt('text \\cite{?}', 'text \\cite{?'.length), { from: 11, to: 12 });
    assert.deepEqual(cs.askedAt('text \\citep{}', 'text \\citep{'.length), { from: 12, to: 12 });
    assert.equal(cs.askedAt('text \\cite{key}', 'text \\cite{key'.length), null);
  });
});

describe('which papers fit', () => {
  const index = cs.suggestIndex(papers, highlights);
  it('puts the paper you highlighted the same thing in first, and says which words met', () => {
    const found = index.rank('Closest to us, a per-expert bias used only for selection, updated from the load each batch, balances without a loss.');
    assert.equal(found[0].paper.id, 'a');
    assert.equal(found[0].via, 'highlight');
    assert.equal(found[0].highlight.id, 'h1');
    assert.ok(found[0].matched.includes('bias') && found[0].matched.includes('selection'));
    assert.ok(found[0].score > 5 * (found[1]?.score ?? 0));
  });

  it('finds a paper by its abstract, and leaves out papers that share one word', () => {
    const found = index.rank('Top-1 routing was later shown to be enough, and cheaper.');
    assert.equal(found[0].paper.id, 'c');
    assert.ok(!found.some((candidate) => candidate.paper.id === 'd'));
  });

  it('stems, so experts meets expert and balanced meets balancing', () => {
    assert.deepEqual(cs.terms('Experts balanced the routings'), ['expert', 'balanc', 'rout']);
  });
});

describe('claims with nothing cited', () => {
  it('finds the sentence that says something was shown, and not the cited ones or the comment', () => {
    const claims = cs.uncitedClaims(TEX);
    assert.deepEqual(claims.map((claim) => [claim.line, claim.because]), [[7, 'was later shown']]);
    assert.match(claims[0].text, /^Top-1 routing/);
  });

  it('counts a percentage and "state of the art" as claims, a heading as nothing', () => {
    const claims = cs.uncitedClaims('\\section{Results}\nOur method is state of the art on three benchmarks, by a wide margin.\nIt reaches 95\\% of the baseline at a tenth of the compute, we found.\n');
    assert.deepEqual(claims.map((claim) => claim.because), ['state of the art', 'reaches']);
  });
});
