// What the reader says about a paper's venue: a Scholar byline saved before
// the proxy knew Scholar's newer layout is read again, and the hover card
// over a journal or conference finds its record, and a conference's place
// and dates, from OpenAlex, dblp and Wikidata.
//
//   node --test scripts/venues.test.mjs

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { tidyByline } = await load('src/lib/byline.ts');
const { readProceedingsTitle, venueDetails, venueFits } = await load('src/lib/venueInfo.ts');

after(cleanup);

describe('a Scholar record saved with the byline misread', () => {
  const saved = {
    id: 'scholar:7339561324566250059',
    source: 'scholar',
    title: 'The utility of lesion classification in predicting language and treatment outcomes in chronic stroke-induced aphasia',
    authors: ['EL Meier', 'JP Johnson', 'Y Pan', 'S KiranBrain imaging and behavior', '2019•Springer'],
    abstract: '',
    published: '',
    categories: [],
  };

  it('gets its authors, venue and year back', () => {
    const tidied = tidyByline(saved);
    assert.deepEqual(tidied.authors, ['EL Meier', 'JP Johnson', 'Y Pan', 'S Kiran']);
    assert.equal(tidied.venue, 'Brain imaging and behavior');
    assert.equal(tidied.published, '2019-01-01');
  });

  it('leaves a record that was read right alone', () => {
    const fine = { ...saved, authors: ['EL Meier', 'S Kiran', 'J van der Merwe'], venue: 'Brain imaging and behavior' };
    assert.equal(tidyByline(fine), fine);
  });

  it('leaves records from other indexes alone', () => {
    const other = { ...saved, source: 'openalex' };
    assert.equal(tidyByline(other), other);
  });
});

describe('a proceedings volume’s title at dblp', () => {
  it('reads the place after the dates', () => {
    assert.deepEqual(
      readProceedingsTitle('Advances in Neural Information Processing Systems 32: Annual Conference on Neural Information Processing Systems 2019, NeurIPS 2019, December 8-14, 2019, Vancouver, BC, Canada.'),
      { dates: 'December 8–14, 2019', location: 'Vancouver, BC, Canada', name: 'NeurIPS 2019' },
    );
  });

  it('reads the place before the dates', () => {
    assert.deepEqual(readProceedingsTitle('IEEE Conference on Computer Vision and Pattern Recognition, CVPR 2019, Long Beach, CA, USA, June 16-20, 2019.'), {
      dates: 'June 16–20, 2019',
      location: 'Long Beach, CA, USA',
      name: 'CVPR 2019',
    });
  });

  it('does not take a volume for a place', () => {
    const read = readProceedingsTitle('Proceedings of the 57th Conference of the Association for Computational Linguistics, ACL 2019, Florence, Italy, July 28- August 2, 2019, Volume 1: Long Papers');
    assert.equal(read.location, 'Florence, Italy');
    assert.equal(read.dates, 'July 28–August 2, 2019');
  });
});

describe('whether an index’s venue is the one printed', () => {
  it('matches past Scholar’s lower case and cut-short names', () => {
    assert.ok(venueFits('Brain Imaging and Behavior', 'Brain imaging and behavior'));
    assert.ok(venueFits('Advances in Neural Information Processing Systems', 'Advances in neural information'));
  });

  it('does not take one short name for a longer one', () => {
    assert.ok(!venueFits('Nature Neuroscience', 'Nature'));
  });
});

// ------------------------------------------------------ the whole lookup ---

const routes = [];
const route = (pattern, body) => routes.push([pattern, body]);

globalThis.fetch = async (input) => {
  const url = decodeURIComponent(String(input));
  const hit = routes.find(([pattern]) => pattern.test(url));
  if (!hit) return new Response('{}', { status: 404 });
  const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

beforeEach(() => {
  routes.length = 0;
});

describe('the card over a venue', () => {
  it('describes a journal and where in it the paper is', async () => {
    route(/api\.openalex\.org\/works\?.*title\.search/, {
      results: [
        {
          id: 'https://openalex.org/W1',
          title: 'The utility of lesion classification in predicting language and treatment outcomes in chronic stroke-induced aphasia',
          publication_date: '2019-12-01',
          primary_location: { source: { id: 'https://openalex.org/S1', display_name: 'Brain Imaging and Behavior', type: 'journal', issn_l: '1931-7557' } },
          biblio: { volume: '13', issue: '6', first_page: '1510', last_page: '1525' },
        },
      ],
    });
    route(/api\.openalex\.org\/sources\/S1/, {
      id: 'https://openalex.org/S1',
      display_name: 'Brain Imaging and Behavior',
      type: 'journal',
      issn_l: '1931-7557',
      host_organization_name: 'Springer Science+Business Media',
      country_code: 'US',
      homepage_url: 'https://www.springer.com/journal/11682',
      works_count: 2400,
      cited_by_count: 70000,
      summary_stats: { h_index: 90, '2yr_mean_citedness': 3.1 },
    });
    const details = await venueDetails({ id: 'scholar:1', title: 'The utility of lesion classification in predicting language and treatment outcomes in chronic stroke-induced aphasia', venue: 'Brain imaging and behavior', year: 2019 });
    assert.equal(details.kind, 'journal');
    assert.equal(details.name, 'Brain Imaging and Behavior');
    assert.equal(details.publisher, 'Springer Science+Business Media');
    assert.equal(details.country, 'United States');
    assert.equal(details.issn, '1931-7557');
    assert.equal(details.placement, 'Vol. 13, issue 6, pp. 1510–1525');
    assert.equal(details.hIndex, 90);
    assert.equal(details.event, undefined);
  });

  it('finds where and when a conference met', async () => {
    route(/api\.openalex\.org\/sources\?/, { results: [] });
    route(/dblp\.org\/search\/venue/, { result: { hits: { hit: [{ info: { venue: 'Neural Information Processing Systems (NeurIPS)', acronym: 'NeurIPS', url: 'https://dblp.org/db/conf/nips/' } }] } } });
    route(/dblp\.org\/search\/publ/, {
      result: {
        hits: {
          hit: [
            {
              info: {
                title: 'Advances in Neural Information Processing Systems 32: Annual Conference on Neural Information Processing Systems 2019, NeurIPS 2019, December 8-14, 2019, Vancouver, BC, Canada.',
                type: 'Editorship',
                year: '2019',
                url: 'https://dblp.org/rec/conf/nips/2019',
                ee: 'https://proceedings.neurips.cc/paper/2019',
              },
            },
          ],
        },
      },
    });
    const details = await venueDetails({ id: 'scholar:2', title: 'Some paper', venue: 'Advances in Neural Information Processing Systems (NeurIPS)', year: 2019 });
    assert.equal(details.kind, 'conference');
    assert.equal(details.event.location, 'Vancouver, BC, Canada');
    assert.equal(details.event.dates, 'December 8–14, 2019');
    assert.equal(details.event.proceedingsUrl, 'https://proceedings.neurips.cc/paper/2019');
    assert.equal(details.dblpUrl, 'https://dblp.org/db/conf/nips/');
  });

  it('falls back on Wikidata for a meeting dblp has no volume of', async () => {
    route(/dblp\.org\/search\/venue/, { result: { hits: { hit: [{ info: { venue: 'International Conference on Learning Representations (ICLR)', acronym: 'ICLR' } }] } } });
    route(/dblp\.org\/search\/publ/, { result: { hits: { hit: [] } } });
    route(/wikidata\.org.*wbsearchentities/, { search: [{ id: 'Q100', label: 'ICLR 2024' }] });
    route(/wikidata\.org.*ids=Q100&/, {
      entities: {
        Q100: {
          labels: { en: { value: 'ICLR 2024' } },
          claims: {
            P276: [{ mainsnak: { datavalue: { value: { id: 'Q1741' } } } }],
            P580: [{ mainsnak: { datavalue: { value: { time: '+2024-05-07T00:00:00Z' } } } }],
            P582: [{ mainsnak: { datavalue: { value: { time: '+2024-05-11T00:00:00Z' } } } }],
            P856: [{ mainsnak: { datavalue: { value: 'https://iclr.cc/Conferences/2024' } } }],
          },
        },
      },
    });
    route(/wikidata\.org.*ids=Q1741/, { entities: { Q1741: { labels: { en: { value: 'Vienna' } } } } });
    const details = await venueDetails({ id: 'scholar:3', title: 'Another paper', venue: 'The Twelfth International Conference on Learning Representations', year: 2024 });
    assert.equal(details.kind, 'conference');
    assert.equal(details.event.location, 'Vienna');
    assert.equal(details.event.dates, 'May 7 – May 11, 2024');
    assert.equal(details.event.website, 'https://iclr.cc/Conferences/2024');
  });
});
