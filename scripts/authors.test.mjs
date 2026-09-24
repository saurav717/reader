// Who the hover card over an author's name says they are: an OpenAlex
// record is taken only when it looks like the person who wrote the paper,
// and someone with no record of their own is found through the paper at
// Open Library and Wikipedia instead.
//
//   node --test scripts/authors.test.mjs

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { authorDetails, profilesElsewhere, recordDoubt, scholarProfile, worksUnderName } = await load('src/lib/hoverInfo.ts');

after(cleanup);

const topic = (field, count) => ({ display_name: `${field} topic`, count, field: { display_name: field } });
const years = (...spans) =>
  Object.fromEntries(spans.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => [String(from + i), 2])));

describe('whether a record is the paper’s author', () => {
  it('takes a record whose work is in the paper’s field', () => {
    assert.equal(recordDoubt([topic('Computer Science')], [topic('Computer Science', 40), topic('Mathematics', 5)], years([2010, 2024])), undefined);
  });

  it('takes a record with some work in the paper’s field, and a field of its own besides', () => {
    assert.equal(recordDoubt([topic('Medicine')], [topic('Computer Science', 40), topic('Medicine', 6)], years([2010, 2024])), undefined);
  });

  it('sets aside a record with next to nothing in the paper’s field', () => {
    const doubt = recordDoubt([topic('Psychology')], [topic('Engineering', 120), topic('Physics and Astronomy', 60), topic('Psychology', 1)], years([1999, 2024]));
    assert.match(doubt, /Engineering/);
    assert.match(doubt, /Psychology/);
  });

  it('sets aside a record whose papers come in runs decades apart', () => {
    const doubt = recordDoubt([], [], { ...years([1936, 1937]), ...years([1999, 2024]) });
    assert.match(doubt, /1936–1937/);
    assert.match(doubt, /1999–2024/);
  });

  it('knows nothing either way without topics or years', () => {
    assert.equal(recordDoubt([], [], {}), undefined);
  });
});

// ------------------------------------------------------ the whole lookup ---

const routes = [];
const route = (pattern, body) => routes.push([pattern, body]);
const asked = [];

globalThis.fetch = async (input) => {
  const url = String(input);
  asked.push(url);
  const hit = routes.find(([pattern]) => pattern.test(decodeURIComponent(url)));
  if (!hit) return new Response('{}', { status: 404 });
  const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
  return new Response(JSON.stringify(body), { status: body?.status ?? 200, headers: { 'content-type': 'application/json' } });
};

beforeEach(() => {
  routes.length = 0;
  asked.length = 0;
});

const carnegie = { id: 'scholar:1373097389684180493', title: 'How to win friends and influence people' };

function carnegieWorld() {
  // OpenAlex has the book, filed under an engineer in Wellington with the initial and surname.
  route(/api\.openalex\.org\/works\?.*title\.search/, {
    results: [
      {
        id: 'https://openalex.org/W1',
        title: 'How to win friends and influence people',
        authorships: [{ author: { id: 'https://openalex.org/A9', display_name: 'D. Carnegie' } }],
        topics: [{ display_name: 'Social influence', field: { display_name: 'Psychology' } }],
      },
    ],
  });
  route(/api\.openalex\.org\/authors\/A9/, {
    id: 'https://openalex.org/A9',
    display_name: 'Dale A. Carnegie',
    orcid: null,
    works_count: 193,
    cited_by_count: 2000,
    summary_stats: { h_index: 19, i10_index: 44 },
    last_known_institutions: [{ display_name: 'Victoria University of Wellington' }],
    topics: [
      { display_name: 'Music Technology and Sound Studies', count: 30, field: { display_name: 'Engineering' } },
      { display_name: 'Advanced Optical Sensing Technologies', count: 25, field: { display_name: 'Physics and Astronomy' } },
      { display_name: 'Social influence', count: 1, field: { display_name: 'Psychology' } },
    ],
  });
  route(/api\.openalex\.org\/works\?.*group_by=publication_year/, {
    group_by: [{ key: '1937', count: 1 }, ...Object.entries(years([1999, 2024])).map(([key, count]) => ({ key, count }))],
  });
  route(/api\.openalex\.org\/works\?.*author\.id:A9/, { results: [{ id: 'W2', display_name: 'Augmentation of wound healing', authorships: [] }] });

  route(/openlibrary\.org\/search\.json\?.*title=/, {
    docs: [
      { key: '/works/OL2W', title: 'How to Win Friends and Influence People in the Digital Age', author_name: ['Dale Carnegie & Associates'], author_key: ['OL3A'] },
      { key: '/works/OL1W', title: 'How to Win Friends and Influence People', author_name: ['Dale Carnegie'], author_key: ['OL1A'] },
    ],
  });
  route(/openlibrary\.org\/authors\/OL1A\.json/, {
    name: 'Dale Carnegie',
    birth_date: 'November 24, 1888',
    death_date: 'November 1, 1955',
    remote_ids: { wikidata: 'Q334365', viaf: '12345' },
  });
  route(/openlibrary\.org\/search\.json\?.*author_key:OL1A/, {
    docs: [
      { key: '/works/OL1W', title: 'How to Win Friends and Influence People', first_publish_year: 1936, edition_count: 300 },
      { key: '/works/OL4W', title: 'How to Stop Worrying and Start Living', first_publish_year: 1948, edition_count: 120 },
      { key: '/works/OL5W', title: 'How to stop worrying and start living', first_publish_year: 1950, edition_count: 10 },
      { key: '/works/OL6W', title: 'Public Speaking and Influencing Men in Business', first_publish_year: 1926, edition_count: 40 },
    ],
  });
  route(/wikidata\.org\/w\/api\.php/, { entities: { Q334365: { sitelinks: { enwiki: { title: 'Dale Carnegie' } } } } });
  route(/wikipedia\.org\/api\/rest_v1\/page\/summary\/Dale_Carnegie/, {
    description: 'American writer and lecturer (1888–1955)',
    extract: 'Dale Carnegie was an American writer and lecturer.',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Dale_Carnegie' } },
  });
}

describe('D Carnegie, author of a book from 1936', () => {
  it('does not show the Wellington engineer OpenAlex files the book under', async () => {
    carnegieWorld();
    const details = await authorDetails('D Carnegie', 0, carnegie);
    assert.equal(details.via, 'paper');
    assert.equal(details.openAlexId, undefined);
    assert.equal(details.citedBy, undefined);
    assert.equal(details.hIndex, undefined);
    assert.equal(details.affiliation, undefined);
    assert.deepEqual(details.topWorks, []);
    assert.equal(details.mistaken.openAlexId, 'A9');
    assert.equal(details.mistaken.affiliation, 'Victoria University of Wellington');
    assert.match(details.mistaken.reason, /1937.*1999–2024/);
  });

  it('finds the writer himself through the book, at Open Library and Wikipedia', async () => {
    carnegieWorld();
    const found = await profilesElsewhere('D Carnegie', carnegie);
    assert.equal(found.fullName, 'Dale Carnegie');
    assert.equal(found.lived, '1888–1955');
    assert.equal(found.description, 'American writer and lecturer (1888–1955)');
    assert.deepEqual(
      found.profiles.map((page) => page.site),
      ['Wikipedia', 'Open Library', 'Wikidata', 'VIAF'],
    );
    assert.equal(found.profiles[1].url, 'https://openlibrary.org/authors/OL1A');
    // The book being read is left out, and a retitled edition counts once.
    assert.deepEqual(
      found.works.map((work) => [work.title, work.year, work.editions]),
      [
        ['How to Stop Worrying and Start Living', 1948, 120],
        ['Public Speaking and Influencing Men in Business', 1926, 40],
      ],
    );
  });
});

describe('someone with a page nowhere', () => {
  const paper = { id: 'scholar:1', title: 'Notes on the rearing of silkworms in Bengal' };

  it('finds nothing elsewhere for a paper Open Library does not know', async () => {
    route(/openlibrary\.org\/search\.json/, { docs: [] });
    const found = await profilesElsewhere('R Mukherjee', paper);
    assert.deepEqual(found, { profiles: [], works: [] });
  });

  it('lists what else was published under the name, the open paper left out', async () => {
    route(/api\.openalex\.org\/works\?.*raw_author_name\.search/, {
      results: [
        { id: 'W1', display_name: 'Notes on the rearing of silkworms in Bengal', authorships: [{ author: { display_name: 'R. Mukherjee' } }] },
        { id: 'W2', display_name: 'Mulberry cultivation in the Gangetic plain', publication_date: '1921-01-01', cited_by_count: 4, authorships: [{ author: { display_name: 'R. Mukherjee' } }] },
        { id: 'W3', display_name: 'An unrelated paper by someone else', authorships: [{ author: { display_name: 'S. Banerjee' } }] },
      ],
    });
    route(/openlibrary\.org\/search\.json\?.*author=/, {
      docs: [{ key: '/works/OL9W', title: 'Silk of Bengal', author_name: ['Radhakamal Mukherjee'], first_publish_year: 1919, edition_count: 2 }],
    });
    const works = await worksUnderName('R Mukherjee', paper);
    assert.deepEqual(
      works.map((work) => [work.title, work.year]),
      [
        ['Silk of Bengal', 1919],
        ['Mulberry cultivation in the Gangetic plain', 1921],
      ],
    );
  });
});

describe('their Google Scholar profile', () => {
  const paper = { id: 'scholar:fusion', title: 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data' };
  const person = {
    userId: 'CHENNURIxx1',
    name: 'Saurav Chennuri',
    profileUrl: 'https://scholar.google.com/citations?hl=en&user=CHENNURIxx1',
    affiliation: 'Somewhere Else Now',
    interests: ['Machine Learning'],
    citedBy: 57,
    citedBySince: 50,
    hIndex: 4,
    i10Index: 2,
    works: [{ title: 'A much cited paper', authors: ['S Chennuri'], year: 2021, citedBy: 30, snippet: '' }],
  };

  it('is the one the paper’s own Scholar record links the byline’s name to, with the counts from the profile', async () => {
    route(/\/scholar\/search\?q=/, {
      results: [
        {
          title: 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data',
          authors: ['S Chennuri', 'S Lai', 'A Billot', 'M Varkanitsa', 'EJ Braun', 'S Kiran'],
          authorIds: [
            { name: 'S Chennuri', userId: 'CHENNURIxx1' },
            { name: 'S Kiran', userId: 'KIRANxxxxxx' },
          ],
          snippet: '',
        },
      ],
    });
    route(/\/scholar\/person\?user=CHENNURIxx1/, { results: [person] });
    // Others of the name, none at the paper's institution: the name alone would have found nobody.
    route(/\/scholar\/authors/, {
      results: [
        { userId: 'OTHER1xxxxx', name: 'S Chennuri', profileUrl: 'https://scholar.google.com/citations?user=OTHER1xxxxx', interests: [] },
        { userId: 'OTHER2xxxxx', name: 'Sai Chennuri', profileUrl: 'https://scholar.google.com/citations?user=OTHER2xxxxx', interests: [] },
      ],
    });
    const found = await scholarProfile('S Chennuri', ['Boston University'], true, paper, 0);
    assert.equal(found.how, 'paper');
    assert.equal(found.profile.scholarUserId, 'CHENNURIxx1');
    assert.equal(found.profile.citedBy, 57);
    assert.equal(found.profile.hIndex, 4);
    assert.equal(found.profile.i10Index, 2);
    assert.equal(found.profile.works[0].title, 'A much cited paper');
    assert.ok(!asked.some((url) => url.includes('/scholar/authors')), 'the name is not searched for once the paper says who it is');
  });

  it('is the one of the name whose profile lists the paper, when the paper’s record links nobody', async () => {
    route(/\/scholar\/search\?q=/, { results: [] });
    route(/\/scholar\/authors/, {
      results: [
        { userId: 'OTHER1xxxxx', name: 'S Chennuri', profileUrl: 'https://scholar.google.com/citations?user=OTHER1xxxxx', interests: [] },
        { userId: 'CHENNURIxx1', name: 'Saurav Chennuri', profileUrl: 'https://scholar.google.com/citations?user=CHENNURIxx1', interests: [] },
      ],
    });
    route(/\/scholar\/person\?user=OTHER1xxxxx/, { results: [{ ...person, userId: 'OTHER1xxxxx', name: 'S Chennuri', works: [] }] });
    route(/\/scholar\/person\?user=CHENNURIxx1/, {
      results: [{ ...person, works: [{ title: 'Fusion approaches to predict post-stroke aphasia severity from multimodal…', authors: [], snippet: '' }] }],
    });
    const found = await scholarProfile('S Chennuri', ['Boston University'], true, { ...paper, id: 'scholar:fusion-2' }, 0);
    assert.equal(found.profile?.scholarUserId, 'CHENNURIxx1');
  });

  it('says Scholar could not be asked, rather than that there is no profile', async () => {
    route(/\/scholar\//, { status: 503, error: 'Google Scholar asked for a captcha', blocked: true, reason: 'captcha' });
    const found = await scholarProfile('S Chennuri', [], true, { ...paper, id: 'scholar:fusion-3' }, 0);
    assert.equal(found.profile, null);
    assert.match(found.error, /captcha/);
  });
});
