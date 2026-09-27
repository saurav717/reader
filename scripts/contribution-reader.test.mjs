// Each author's part in a paper, as DeepSeek reads the paper's statement of
// who did what (server/contributionReader.js): what it answers is kept only
// where the statement bears it out, word for word — a model that says
// someone did what the paper does not say is worse than saying nothing.
//
// DeepSeek is not asked: it is stubbed.
//
//   node --test scripts/contribution-reader.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { checkReading, contributionsAsked, readContributions, readingRequest, DEEPSEEK_CHAT } = await import('../server/contributionReader.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const AUTHORS = ['Ada Lindqvist', 'Tomas Okafor', 'Mira Castell'];
const STATEMENT =
  '∗Equal contribution. Listing order is random.\n\nA.L. and M.C. wrote the first implementation. T.O. ran the translation experiments and is the project lead. M.C. wrote the paper with help from all authors.';

/** DeepSeek, answering `authors` and remembering what it was sent. */
const deepseek = (authors, { status = 200, content } = {}) => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (status !== 200) return json({ error: 'no' }, status);
    return json({
      choices: [{ message: { content: content ?? JSON.stringify({ authors }) } }],
      usage: { prompt_tokens: 812, prompt_cache_hit_tokens: 0, completion_tokens: 140 },
    });
  };
  return { sent, fetchImpl };
};

describe('reading a contributions statement with DeepSeek', () => {
  it('asks once, with the authors numbered in the byline\'s order and the statement as printed', async () => {
    const { sent, fetchImpl } = deepseek([]);
    await readContributions({ authors: AUTHORS, statement: STATEMENT }, 'sk-test', { fetchImpl });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, DEEPSEEK_CHAT);
    assert.equal(sent[0].auth, 'Bearer sk-test');
    assert.deepEqual(sent[0].body.thinking, { type: 'disabled' });
    assert.deepEqual(JSON.parse(sent[0].body.messages[1].content), {
      authors: [
        { index: 0, name: 'Ada Lindqvist' },
        { index: 1, name: 'Tomas Okafor' },
        { index: 2, name: 'Mira Castell' },
      ],
      statement: STATEMENT,
    });
    assert.equal(readingRequest(AUTHORS, STATEMENT).response_format.type, 'json_object');
  });

  it('gives each author the words about them, initials read', async () => {
    const { fetchImpl } = deepseek([
      { index: 0, did: ['A.L. and M.C. wrote the first implementation.'], roles: [] },
      { index: 1, did: ['T.O. ran the translation experiments'], roles: ['project lead'] },
      { index: 2, did: ['A.L. and M.C. wrote the first implementation.', 'M.C. wrote the paper with help from all authors.'], roles: [] },
    ]);
    const { people, usage } = await readContributions({ authors: AUTHORS, statement: STATEMENT }, 'sk-test', { fetchImpl });
    assert.deepEqual(people, [
      { did: ['A.L. and M.C. wrote the first implementation.'], roles: [] },
      { did: ['T.O. ran the translation experiments'], roles: ['project lead'] },
      { did: ['A.L. and M.C. wrote the first implementation.', 'M.C. wrote the paper with help from all authors.'], roles: [] },
    ]);
    assert.deepEqual(usage, { input: 812, cacheRead: 0, output: 140 });
  });

  it('drops what the statement does not say, and indexes off the byline', async () => {
    const { fetchImpl } = deepseek([
      { index: 0, did: ['Ada designed the attention mechanism.', 'A.L. and M.C. wrote the first implementation'], roles: ['Corresponding author'] },
      { index: 7, did: ['M.C. wrote the paper with help from all authors.'] },
      { index: 'one', did: ['T.O. ran the translation experiments'] },
    ]);
    const { people } = await readContributions({ authors: AUTHORS, statement: STATEMENT }, 'sk-test', { fetchImpl });
    assert.deepEqual(people, [
      { did: ['A.L. and M.C. wrote the first implementation'], roles: [] },
      { did: [], roles: [] },
      { did: [], roles: [] },
    ]);
  });

  it('compares as text: quotes, dashes and spacing aside', () => {
    const statement = 'We thank “the reviewers”. A.L. wrote the  data–loading code.';
    assert.deepEqual(checkReading({ did: ['A.L. wrote the data-loading code.'] }, statement).did, ['A.L. wrote the data-loading code.']);
  });

  it('answers nothing, and never throws, without a key, on a refusal, or on an answer that is not JSON', async () => {
    assert.deepEqual(await readContributions({ authors: AUTHORS, statement: STATEMENT }, ''), { people: null, usage: null });
    assert.equal((await readContributions({ authors: AUTHORS, statement: STATEMENT }, 'sk', deepseek([], { status: 402 }))).people, null);
    assert.equal((await readContributions({ authors: AUTHORS, statement: STATEMENT }, 'sk', deepseek([], { content: 'Sure! Here…' }))).people, null);
    const failing = { fetchImpl: async () => { throw new Error('offline'); } };
    assert.deepEqual(await readContributions({ authors: AUTHORS, statement: STATEMENT }, 'sk', failing), { people: null, usage: null });
  });

  it('reads the question from the address, tidied, and refuses one with nothing to read', () => {
    const params = new URLSearchParams({ authors: JSON.stringify([' Ada Lindqvist ', '', 'Tomas Okafor']), statement: `  ${STATEMENT}  ` });
    assert.deepEqual(contributionsAsked(params), { authors: ['Ada Lindqvist', 'Tomas Okafor'], statement: STATEMENT });
    assert.equal(contributionsAsked(new URLSearchParams({ authors: 'not json', statement: STATEMENT })), null);
    assert.equal(contributionsAsked(new URLSearchParams({ authors: JSON.stringify(AUTHORS), statement: 'short' })), null);
  });
});
