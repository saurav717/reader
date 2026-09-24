// The dictionary behind the Meaning tab of the lookup card, with both
// dictionaries it asks stubbed: which one wins, how a word's other forms are
// found, and how "no entry" is told apart from "no network". And where the
// card is placed: beside the line, below it or above it, never over it.
//
//   node --test scripts/lookup.test.mjs

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const lookup = await load('src/lib/lookup.ts');
const { placeLookup } = await load('src/lib/lookupPlace.ts');

after(cleanup);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const missing = () => new Response('{}', { status: 404 });

const WIKTIONARY = {
  attention: {
    en: [
      {
        partOfSpeech: 'Noun',
        language: 'English',
        definitions: [
          { definition: 'Mental focus.', parsedExamples: [{ example: 'Pay <b>attention</b>.' }] },
          { definition: '' },
          { definition: '(<i>machine learning</i>) A mechanism that weighs parts of the input&#160;by relevance.' },
        ],
      },
    ],
    fr: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'care' }] }],
  },
  models: {
    en: [
      { partOfSpeech: 'Noun', definitions: [{ definition: 'plural of <a href="/wiki/model">model</a>' }] },
      { partOfSpeech: 'Verb', definitions: [{ definition: 'third-person singular simple present indicative of <a>model</a>' }] },
    ],
  },
  model: {
    en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'A simplified representation of a system.' }] }],
  },
};

const FREE = {
  attention: [{ word: 'attention', phonetic: '/əˈtɛnʃən/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Free attention.' }] }] }],
  encode: [{ word: 'encode', meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To convert into a code.' }] }] }],
  transformer: [{ word: 'transformer', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A device.' }] }] }],
};

let asked;
function stub({ wiktionary = 'up', free = 'up' } = {}) {
  asked = [];
  globalThis.fetch = async (url) => {
    const address = String(url);
    asked.push(address);
    const term = decodeURIComponent(address.split('/').pop());
    if (address.includes('wiktionary.org')) {
      if (wiktionary === 'down') throw new TypeError('Failed to fetch');
      return WIKTIONARY[term] ? json(WIKTIONARY[term]) : missing();
    }
    if (address.includes('dictionaryapi.dev')) {
      if (free === 'down') throw new TypeError('Failed to fetch');
      if (free === '500') return new Response('', { status: 500 });
      return FREE[term] ? json(FREE[term]) : missing();
    }
    throw new Error(`unexpected fetch ${address}`);
  };
}

// Each test asks about words no other test has, since answers are kept.
describe('the dictionary', () => {
  beforeEach(() => stub());

  it('takes Wiktionary’s English senses, as text, with the Free Dictionary’s pronunciation', async () => {
    const entry = await lookup.lookupWord('Attention,');
    assert.equal(entry.source, 'Wiktionary');
    assert.equal(entry.phonetic, '/əˈtɛnʃən/');
    assert.equal(entry.senses.length, 1);
    assert.equal(entry.senses[0].partOfSpeech, 'noun');
    assert.deepEqual(entry.senses[0].definitions, [
      { definition: 'Mental focus.', example: 'Pay attention.' },
      { definition: '(machine learning) A mechanism that weighs parts of the input by relevance.', example: undefined },
    ]);
  });

  it('follows a plural to the word it is a form of, and says so', async () => {
    const entry = await lookup.lookupWord('models');
    assert.equal(entry.word, 'model');
    assert.equal(entry.formOf, 'models: plural of model');
    assert.equal(entry.senses[0].definitions[0].definition, 'A simplified representation of a system.');
  });

  it('falls back to the Free Dictionary, trying the word’s dictionary forms', async () => {
    const entry = await lookup.lookupWord('encoding');
    assert.equal(entry.source, 'Free Dictionary');
    assert.equal(entry.word, 'encode');
    assert.equal(entry.formOf, 'encoding: a form of encode');
  });

  it('still answers when Wiktionary cannot be reached', async () => {
    stub({ wiktionary: 'down' });
    const entry = await lookup.lookupWord('transformer');
    assert.equal(entry.source, 'Free Dictionary');
  });

  it('says there is no entry when both answered and neither has one', async () => {
    assert.equal(await lookup.lookupWord('qwertyuiop'), null);
  });

  it('says neither could be reached when neither could', async () => {
    stub({ wiktionary: 'down', free: '500' });
    await assert.rejects(lookup.lookupWord('unreachable'), /No dictionary could be reached/);
  });

  it('asks once per word in a session', async () => {
    await lookup.lookupWord('attention');
    assert.deepEqual(asked, []);
  });
});

describe('dictionary forms', () => {
  it('guesses the forms a dictionary files a word under', () => {
    assert.deepEqual(lookup.dictionaryForms('studies'), ['study', 'studie', 'studies'.slice(0, -1)].filter((v, i, a) => a.indexOf(v) === i));
    assert.ok(lookup.dictionaryForms('trained').includes('train'));
    assert.ok(lookup.dictionaryForms('encoding').includes('encode'));
    assert.ok(lookup.dictionaryForms('stopped').includes('stop'));
    assert.ok(lookup.dictionaryForms('boxes').includes('box'));
    assert.deepEqual(lookup.dictionaryForms('class'), []);
  });
});

describe('where the card goes', () => {
  const viewport = { width: 1440, height: 900 };
  const anchor = { top: 400, bottom: 420, left: 500, right: 700 };

  it('sits in the margin beside the line when the margin is wide enough', () => {
    const place = placeLookup({ top: 0, left: 0, anchor, column: { left: 370, right: 1070 }, selector: {} }, 300, viewport);
    assert.equal(place.side, 'margin');
    assert.ok(place.left >= 1070);
    assert.ok(place.left + place.width <= viewport.width);
  });

  it('does not count the rail or a side panel as margin', () => {
    const place = placeLookup(
      { top: 0, left: 0, anchor, column: { left: 546, right: 1246 }, pane: { left: 352, right: 1440 }, selector: {} },
      300,
      viewport,
    );
    assert.equal(place.side, 'below');
    assert.ok(place.left >= 352);
  });

  it('goes below the line, clear of it, when there is no margin', () => {
    const place = placeLookup({ top: 0, left: 0, anchor, column: { left: 100, right: 1340 }, selector: {} }, 300, viewport);
    assert.equal(place.side, 'below');
    assert.ok(place.top >= anchor.bottom);
  });

  it('goes above the line when the line is near the bottom', () => {
    const low = { top: 800, bottom: 820, left: 500, right: 700 };
    const place = placeLookup({ top: 0, left: 0, anchor: low, selector: {} }, 300, viewport);
    assert.equal(place.side, 'above');
    assert.ok(place.top + Math.min(300, place.maxHeight) <= low.top);
    assert.ok(place.top >= 12);
  });

  it('fits a phone', () => {
    const place = placeLookup({ top: 0, left: 0, anchor, selector: {} }, 300, { width: 390, height: 844 });
    assert.equal(place.width, 366);
    assert.equal(place.left, 12);
  });
});
