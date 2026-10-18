// The Cite menu's "Ask AI": the question put to the model, the entry read
// out of its answer and checked against the paper, and DeepSeek's balance.
//
//   node --test scripts/cite-ai.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const ai = await load('src/lib/citeAi.ts', { external: ['@anthropic-ai/sdk'] });
after(cleanup);

const TITLE = 'Mixture-of-Experts with Expert Choice Routing';
const ENTRY = `@inproceedings{zhou2022mixture,
  title = {Mixture-of-Experts with Expert Choice Routing},
  author = {Zhou, Yanqi and Lei, Tao and Liu, Hanxiao},
  booktitle = {Advances in Neural Information Processing Systems},
  volume = {35},
  pages = {7103--7114},
  year = {2022}
}`;

describe('the order', () => {
  it('asks DeepSeek, then Claude, then Gemini', () => {
    assert.deepEqual(ai.CITE_AI_ORDER.map((item) => item.provider), ['deepseek', 'anthropic', 'gemini']);
  });
});

describe('citeAiQuestion', () => {
  it('names the paper and leaves out what it does not know', () => {
    const question = ai.citeAiQuestion({ title: TITLE, authors: ['Yanqi Zhou', 'Tao Lei'], published: '2022-02-18', arxivId: 'arXiv:2202.09368' });
    assert.match(question, /Title: Mixture-of-Experts/);
    assert.match(question, /Authors: Yanqi Zhou, Tao Lei/);
    assert.match(question, /arXiv: 2202\.09368/);
    assert.doesNotMatch(question, /DOI|Venue/);
  });
});

describe('entryFromAnswer', () => {
  it('takes the fenced entry and the source line', () => {
    const got = ai.entryFromAnswer(`Here it is.\n\n\`\`\`bibtex\n${ENTRY}\n\`\`\`\nSource: https://proceedings.neurips.cc/paper/2022/hash/abc.html.`, TITLE);
    assert.equal(got.bibtex, ENTRY);
    assert.equal(got.url, 'https://proceedings.neurips.cc/paper/2022/hash/abc.html');
  });

  it('takes an entry written without a fence, up to its closing brace', () => {
    const got = ai.entryFromAnswer(`${ENTRY}\nHope that helps!`, TITLE);
    assert.equal(got.bibtex, ENTRY);
    assert.equal(got.url, undefined);
  });

  it('refuses an answer with no entry', () => {
    assert.match(ai.entryFromAnswer('I could not find it.', TITLE).error, /no BibTeX/);
  });

  it('refuses an entry for another paper', () => {
    const other = ENTRY.replace('Mixture-of-Experts with Expert Choice Routing', 'Switch Transformers: Scaling to Trillion Parameter Models');
    assert.match(ai.entryFromAnswer(other, TITLE).error, /different paper/);
  });

  it('takes a title with its capitals braced', () => {
    const braced = ENTRY.replace('{Mixture-of-Experts with Expert Choice Routing}', '{{Mixture-of-Experts} with Expert Choice Routing}');
    assert.ok(ai.entryFromAnswer(braced, TITLE).bibtex);
  });
});

describe('deepseekHasCredit', () => {
  const answering = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it('is false only when DeepSeek says there is nothing left', async () => {
    assert.equal(await ai.deepseekHasCredit('sk-x', answering({ is_available: false, balance_infos: [] })), false);
    assert.equal(await ai.deepseekHasCredit('sk-x', answering({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] })), false);
    assert.equal(await ai.deepseekHasCredit('sk-x', answering({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.20' }] })), true);
  });

  it('asks anyway on the site key, or when the balance cannot be read', async () => {
    assert.equal(await ai.deepseekHasCredit('', answering({ is_available: false })), true);
    assert.equal(await ai.deepseekHasCredit('sk-x', answering({}, 401)), true);
    assert.equal(await ai.deepseekHasCredit('sk-x', async () => { throw new TypeError('Failed to fetch'); }), true);
  });
});

describe('shortReason', () => {
  it('says out of credit for the providers’ ways of saying it', () => {
    assert.equal(ai.shortReason(new Error('402 Insufficient Balance')), 'out of credit');
    assert.equal(ai.shortReason(new Error('Your credit balance is too low to access the Anthropic API.')), 'out of credit');
    assert.equal(ai.shortReason(new Error('429 rate_limit_error')), 'busy');
  });
});
