// Finding a passage Claude quoted, and reading the `passages` block that
// carries it — without a browser.
//
//   node --test scripts/locate.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const locate = await load('src/lib/locate.ts');
const assistant = await load('src/lib/assistant.ts', { external: ['@anthropic-ai/sdk'] });

after(cleanup);

describe('comparing the quote with the page', () => {
  it('ignores spacing, case, punctuation, ligatures and hyphenation', () => {
    const page = locate.squash('We call this “oracle se-\nlection”: the ﬁnal model is chosen with the test set.').text;
    assert.ok(locate.findSquashed(page, 'we call this "oracle selection": the final model'));
  });
  it('finds text pdf.js split into spans with no space between them', () => {
    const page = locate.squash('the oracleselectionupper boundis never reached').text;
    const hit = locate.findSquashed(page, 'the oracle selection upper bound is never reached');
    assert.equal(hit.words, hit.of);
  });
  it('falls back to the longest run of words that is there', () => {
    const page = locate.squash('Feature sets were ranked by an oracle that saw the held-out patients before selection.').text;
    const hit = locate.findSquashed(page, 'Feature sets were ranked by an oracle that saw the unseen patients before selection.');
    assert.ok(hit && hit.words >= 4 && hit.words < hit.of);
  });
  it('does not match a handful of common words', () => {
    assert.equal(locate.findSquashed(locate.squash('it is in the of a').text, 'it is in the model of a test'), null);
  });
  it('remembers where each kept character came from', () => {
    const { text, at } = locate.squash('A-b c');
    assert.equal(text, 'abc');
    assert.deepEqual(at, [0, 2, 4]);
  });
  it('picks the page that holds the quote, preferring the one named', () => {
    const pages = ['intro text about aphasia', 'we define oracle selection as choosing on the test set', 'oracle selection again: choosing on the test set'];
    assert.equal(locate.pageOf(pages, 'oracle selection as choosing on the test set'), 2);
    assert.equal(locate.pageOf(pages, 'choosing on the test set', 3), 3);
    assert.equal(locate.pageOf(pages, 'nothing like this is anywhere in these pages'), null);
  });
});

describe('the passages block', () => {
  const answer = [
    'They discuss it in [the model selection section](passage:1).',
    '',
    '```passages',
    '{"quote": "We refer to this as oracle selection [Page 4] because", "label": "Where oracle selection is defined", "section": "3.2", "page": 4, "show": true}',
    '{"quote": "", "label": "empty"}',
    'not json',
    '```',
  ].join('\n');
  it('is taken out of the prose', () => {
    const { text } = assistant.splitPassages(answer);
    assert.equal(text, 'They discuss it in [the model selection section](passage:1).');
  });
  it('lists each passage, without page markers, skipping what does not parse', () => {
    const { passages } = assistant.splitPassages(answer);
    assert.equal(passages.length, 1);
    assert.deepEqual(passages[0], { quote: 'We refer to this as oracle selection because', label: 'Where oracle selection is defined', section: '3.2', page: 4, show: true });
  });
  it('keeps which page a passage is on — the paper, or its explanation', () => {
    const { passages } = assistant.splitPassages(
      'See it.\n\n```passages\n{"quote": "the pressure term keeps the flow divergence free at every instant", "label": "Why pressure appears", "in": "explanation"}\n{"quote": "We prove global regularity", "label": "The claim"}\n```',
    );
    assert.equal(passages[0].source, 'explanation');
    assert.equal(passages[1].source, undefined);
  });
  it('is hidden while it streams in', () => {
    const { text, passages } = assistant.splitPassages('Here it is.\n\n```passages\n{"quote": "half wri');
    assert.equal(text, 'Here it is.');
    assert.equal(passages.length, 0);
  });
  it('knows a question that asks where', () => {
    assert.ok(assistant.asksWhere('Show me where in this paper the authors talk about oracle selection'));
    assert.ok(!assistant.asksWhere('What is oracle selection?'));
  });
});
