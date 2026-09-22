// What the search layer does with a query before it goes out, and with the
// answers when they come back. No network: every source is stubbed, because
// these assertions are about our query shapes, our de-duplication and our
// ranking, not about any index being up.
//
//   node --test scripts/search.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { arxivQuery, arxivIdFromQuery, search } = await load('src/lib/sources.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

/** Answers by host, so one stub can serve a multi-source search. */
let handlers = {};
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const handler = handlers[url.hostname];
  if (!handler) throw new Error(`no stub for ${url.hostname}`);
  return handler(url);
};

const json = (body) => new Response(JSON.stringify(body), { status: 200 });

const openAlexWork = (overrides = {}) => ({
  id: 'https://openalex.org/W1',
  doi: null,
  display_name: 'A Title',
  publication_date: '2020-01-01',
  abstract_inverted_index: null,
  authorships: [],
  primary_location: null,
  concepts: [],
  ...overrides,
});

const crossrefItem = (overrides = {}) => ({
  DOI: '10.1/x',
  title: ['A Title'],
  author: [],
  issued: { 'date-parts': [[2020, 1, 1]] },
  ...overrides,
});

beforeEach(() => {
  handlers = {};
});

describe('the arXiv query it builds', () => {
  it('joins the words of a multi-word query with AND rather than leaving them bare', () => {
    // `all:attention is all you need` parses as one field and four loose
    // words, which is what used to make a multi-word search useless.
    const built = arxivQuery('deep residual learning');
    assert.equal(built, 'all:deep AND all:residual AND all:learning');
  });

  it('keeps a quoted phrase together', () => {
    assert.equal(arxivQuery('"neural operator" convergence'), 'all:"neural operator" AND all:convergence');
  });

  it('drops stopwords, which would otherwise all have to match', () => {
    assert.equal(arxivQuery('the cost of attention'), 'all:cost AND all:attention');
  });

  it('keeps the stopwords when they are the entire query', () => {
    assert.equal(arxivQuery('all you need'), 'all:all AND all:you AND all:need');
  });

  it('can search a named field, which is what author search uses', () => {
    assert.equal(arxivQuery('"Yann LeCun"', 'au'), 'au:"Yann LeCun"');
  });
});

describe('recognising an arXiv id', () => {
  it('accepts a query that is an id', () => {
    assert.equal(arxivIdFromQuery('2010.08895'), '2010.08895');
    assert.equal(arxivIdFromQuery('arXiv:1706.03762v5'), '1706.03762v5');
  });

  it('does not hijack a query that merely contains one', () => {
    // Anchored on purpose: "scaling laws 2020.1234" is a search, not a lookup.
    assert.equal(arxivIdFromQuery('scaling laws 2020.12345'), null);
    assert.equal(arxivIdFromQuery('attention is all you need'), null);
  });
});

describe('merging what the sources return', () => {
  it('folds two records of the same paper into one, by DOI', () => {
    handlers['api.openalex.org'] = () =>
      json({ results: [openAlexWork({ doi: 'https://doi.org/10.1/SAME', display_name: 'Shared Paper' })] });
    handlers['api.crossref.org'] = () =>
      json({ message: { items: [crossrefItem({ DOI: '10.1/same', title: ['Shared Paper'] })] } });

    return search('shared', ['openalex', 'crossref']).then((outcome) => {
      assert.equal(outcome.results.length, 1);
      assert.equal(outcome.results[0].title, 'Shared Paper');
    });
  });

  it('folds them together on the title when neither carries a DOI', () => {
    handlers['api.openalex.org'] = () =>
      json({ results: [openAlexWork({ display_name: 'The Same: Paper, Really' })] });
    handlers['api.crossref.org'] = () =>
      json({ message: { items: [crossrefItem({ DOI: undefined, title: ['the same paper really'] })] } });

    return search('same', ['openalex', 'crossref']).then((outcome) => {
      assert.equal(outcome.results.length, 1);
    });
  });

  it('does not file the same preprint twice over arXiv\'s own DOI', () => {
    // arXiv mints 10.48550/arXiv.NNNN, which OpenAlex reports and arXiv's own
    // API does not — so keying on the DOI would show the paper twice.
    handlers['api.openalex.org'] = () =>
      json({
        results: [
          openAlexWork({
            doi: 'https://doi.org/10.48550/arXiv.2010.08895',
            display_name: 'Fourier Neural Operator',
          }),
        ],
      });
    handlers['api.crossref.org'] = () =>
      json({
        message: {
          items: [crossrefItem({ DOI: '10.48550/arxiv.2010.08895', title: ['Fourier Neural Operator'] })],
        },
      });

    return search('fno', ['openalex', 'crossref']).then((outcome) => {
      assert.equal(outcome.results.length, 1);
      assert.equal(outcome.results[0].arxivId, '2010.08895');
    });
  });

  it('fills the gaps in one record from the other', () => {
    // Crossref has the venue and the citation count; OpenAlex has the PDF.
    handlers['api.openalex.org'] = () =>
      json({
        results: [
          openAlexWork({
            doi: 'https://doi.org/10.1/x',
            best_oa_location: { pdf_url: 'https://repo.example/x.pdf', landing_page_url: null, source: null },
          }),
        ],
      });
    handlers['api.crossref.org'] = () =>
      json({
        message: {
          items: [crossrefItem({ 'container-title': ['Journal of Things'], 'is-referenced-by-count': 42 })],
        },
      });

    return search('x', ['openalex', 'crossref']).then((outcome) => {
      assert.equal(outcome.results.length, 1);
      assert.equal(outcome.results[0].pdfUrl, 'https://repo.example/x.pdf');
      assert.equal(outcome.results[0].venue, 'Journal of Things');
      assert.equal(outcome.results[0].citedBy, 42);
    });
  });

  it('ranks a paper both sources agree on above one only a single source ranked first', () => {
    handlers['api.openalex.org'] = () =>
      json({
        results: [
          openAlexWork({ id: 'https://openalex.org/ONLY', display_name: 'Only OpenAlex Has This' }),
          openAlexWork({ doi: 'https://doi.org/10.1/both', display_name: 'Both Have This' }),
        ],
      });
    handlers['api.crossref.org'] = () =>
      json({ message: { items: [crossrefItem({ DOI: '10.1/both', title: ['Both Have This'] })] } });

    return search('q', ['openalex', 'crossref']).then((outcome) => {
      assert.equal(outcome.results[0].title, 'Both Have This');
    });
  });

  it('reports a source that failed without losing the one that worked', () => {
    handlers['api.openalex.org'] = () => new Response('nope', { status: 500 });
    handlers['api.crossref.org'] = () => json({ message: { items: [crossrefItem()] } });

    return search('q', ['openalex', 'crossref']).then((outcome) => {
      assert.equal(outcome.results.length, 1);
      assert.equal(outcome.errors.length, 1);
      assert.equal(outcome.errors[0].source, 'openalex');
    });
  });

  it('says so rather than silently returning nothing when no source is selected', () => {
    // Deselecting every chip used to look exactly like "no results".
    return search('q', []).then((outcome) => {
      assert.equal(outcome.results.length, 0);
      assert.equal(outcome.errors.length, 1);
      assert.match(outcome.errors[0].message, /No sources are selected/);
    });
  });

  it('knows a short page means there is nothing more to ask for', () => {
    handlers['api.openalex.org'] = () => json({ results: [openAlexWork()] });
    return search('q', ['openalex']).then((outcome) => {
      assert.equal(outcome.exhausted, true);
    });
  });
});
