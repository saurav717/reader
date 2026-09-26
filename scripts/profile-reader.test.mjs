// Where a person is now, when Serply stands in for SerpApi: Google's snippet
// of a Scholar profile is as often its list of works as its top, and a paper's
// title must never be taken for an affiliation — by the rule in
// server/serply.js, or by DeepSeek reading the snippet (server/profileReader.js),
// whose answer is kept only where the snippet bears it out.
//
// Neither Serply nor DeepSeek is asked: both are stubbed.
//
//   node --test scripts/profile-reader.test.mjs

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { askSerplyScholar, forgetSerply, fromSerplyProfiles } = await import('../server/serply.js');
const { checkReading, readingRequest, readProfiles, DEEPSEEK_CHAT } = await import('../server/profileReader.js');
const { askServices, forgetResting } = await import('../server/scholarServices.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const TITLE = 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data';
/** What Google showed of the profile: its list of works, not its top. */
const WORKS_SNIPPET = `${TITLE}. S Chennuri, S Lai, A Billot, M Varkanitsa, EJ Braun… - 2023 IEEE/CVF International Conference on Computer …`;
/** And the other way it shows one: the top of the page, run together. */
const TOP_SNIPPET = 'Saurav Chennuri. Boston University. Verified email at bu.edu. Medical Imaging. Deep Learning';

const profiles = (description) => ({
  results: [
    { title: 'Saurav Chennuri - Google Scholar', link: 'https://scholar.google.com/citations?user=SAURAVxxAAAJ&hl=en', description },
  ],
});
const PAPERS = {
  articles: [
    {
      title: TITLE,
      link: 'https://openaccess.thecvf.com/x.html',
      author: {
        names: 'S Chennuri, S Lai, A Billot - 2023 IEEE/CVF International Conference on Computer Vision Workshops, 2023 - openaccess.thecvf.com',
        authors: [{ name: 'S Chennuri', link: '/citations?user=SAURAVxxAAAJ&hl=en' }],
      },
      extras: { citations: { count: 'Cited by 6' } },
    },
  ],
};

/** Serply, answering with Google's snippet `description` and the papers above. */
const serply = (description) => async (url) =>
  new URL(String(url)).pathname === '/v1/search' ? json(profiles(description)) : json(PAPERS);

/** DeepSeek, answering `profiles` and remembering what it was sent. */
const deepseek = (profilesAnswer) => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
    return json({
      choices: [{ message: { content: JSON.stringify({ profiles: profilesAnswer }) } }],
      usage: { prompt_tokens: 612, prompt_cache_hit_tokens: 384, completion_tokens: 41 },
    });
  };
  return { sent, fetchImpl };
};

beforeEach(() => {
  forgetSerply();
  forgetResting();
});

describe('Serply’s own reading of the snippet', () => {
  it('takes no paper title for an affiliation when Google shows the list of works', () => {
    const [person] = fromSerplyProfiles(profiles(WORKS_SNIPPET));
    assert.equal(person.name, 'Saurav Chennuri');
    assert.equal(person.affiliation, undefined);
    assert.deepEqual(person.interests, []);
  });

  it('still reads the top of the profile when that is what Google shows', () => {
    const [person] = fromSerplyProfiles(profiles(TOP_SNIPPET));
    assert.equal(person.affiliation, 'Boston University');
    assert.equal(person.verifiedEmail, 'bu.edu');
    assert.deepEqual(person.interests, ['Medical Imaging', 'Deep Learning']);
  });

  it('drops an affiliation that is one of their own works, and sends no snippet to the app', async () => {
    const fetchImpl = serply(`${TITLE} - Cited by 6 - Medical Imaging`);
    const [person] = await askSerplyScholar('person', { user: 'SAURAVxxAAAJ', name: 'Saurav Chennuri' }, 'k', { fetchImpl });
    assert.equal(person.affiliation, undefined);
    assert.equal(person.snippet, undefined);
    assert.equal(person.works[0].title, TITLE);
  });
});

describe('DeepSeek reading the snippet', () => {
  it('keeps only what the snippet bears out', () => {
    const person = { name: 'Saurav Chennuri', snippet: TOP_SNIPPET, works: [{ title: TITLE }] };
    assert.deepEqual(checkReading({ affiliation: 'Boston University', verifiedEmail: 'bu.edu', interests: ['Deep Learning'] }, person), {
      affiliation: 'Boston University',
      verifiedEmail: 'bu.edu',
      interests: ['Deep Learning'],
    });
    // Invented, or a paper's title: dropped, not corrected.
    assert.equal(checkReading({ affiliation: 'MIT' }, person).affiliation, undefined);
    assert.equal(checkReading({ affiliation: TITLE }, { ...person, snippet: WORKS_SNIPPET }).affiliation, undefined);
    assert.equal(checkReading({ verifiedEmail: 'mit.edu' }, person).verifiedEmail, undefined);
  });

  it('asks once, thinking off, for JSON, with the snippet and the titles of their works', () => {
    const request = readingRequest([{ userId: 'SAURAVxxAAAJ', name: 'Saurav Chennuri', snippet: WORKS_SNIPPET, works: [{ title: TITLE }] }]);
    assert.equal(request.model, 'deepseek-flash');
    assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.deepEqual(request.response_format, { type: 'json_object' });
    const [asked] = JSON.parse(request.messages[1].content).profiles;
    assert.equal(asked.id, 'SAURAVxxAAAJ');
    assert.deepEqual(asked.papers, [TITLE]);
  });

  it('never throws: a refusal is no reading', async () => {
    const { readings, usage } = await readProfiles([{ userId: 'SAURAVxxAAAJ', name: 'S', snippet: TOP_SNIPPET }], 'key', {
      fetchImpl: async () => json({ error: { message: 'Insufficient Balance' } }, 402),
    });
    assert.equal(readings.size, 0);
    assert.equal(usage, null);
  });

  it('a person through Serply, read by DeepSeek: where they are, and the tokens it took', async () => {
    const reader = deepseek([{ id: 'SAURAVxxAAAJ', affiliation: 'Boston University', verifiedEmail: 'bu.edu', interests: ['Medical Imaging'] }]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url) === DEEPSEEK_CHAT ? reader.fetchImpl(url, init) : serply(TOP_SNIPPET)(url));
    try {
      const { results, via, ai } = await askServices('person', { user: 'SAURAVxxAAAJ', name: 'Saurav Chennuri' }, { serply: 's', deepseek: 'd' });
      assert.equal(via, 'serply');
      assert.equal(results[0].affiliation, 'Boston University');
      assert.equal(reader.sent.length, 1);
      assert.equal(reader.sent[0].auth, 'Bearer d');
      assert.deepEqual(
        { input: ai.input, cacheRead: ai.cacheRead, output: ai.output, provider: ai.provider },
        { input: 228, cacheRead: 384, output: 41, provider: 'deepseek' },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('when DeepSeek says the snippet shows no affiliation, none is shown', async () => {
    const reader = deepseek([{ id: 'SAURAVxxAAAJ', affiliation: null, verifiedEmail: null, interests: [] }]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url) === DEEPSEEK_CHAT ? reader.fetchImpl(url, init) : serply(WORKS_SNIPPET)(url));
    try {
      const { results } = await askServices('person', { user: 'SAURAVxxAAAJ', name: 'Saurav Chennuri' }, { serply: 's', deepseek: 'd' });
      assert.equal(results[0].affiliation, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('is not asked without a key, nor when SerpApi answers', async () => {
    const reader = deepseek([]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url) === DEEPSEEK_CHAT ? reader.fetchImpl(url, init) : serply(TOP_SNIPPET)(url));
    try {
      const { ai } = await askServices('person', { user: 'SAURAVxxAAAJ', name: 'Saurav Chennuri' }, { serply: 's' });
      assert.equal(ai, undefined);
      assert.equal(reader.sent.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
