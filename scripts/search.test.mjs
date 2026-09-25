// What the search layer does with a query before it goes out, and with the
// answers when they come back. No network: every source is stubbed, because
// these assertions are about our query shapes, our de-duplication and our
// ranking, not about any index being up.
//
//   node --test scripts/search.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { arxivQuery, arxivIdFromQuery, nameInQuery, nameMatches, papersByAuthor, search, searchAuthors, sortPapers, webUrl } =
  await load('src/lib/sources.ts');

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

describe('the links an index hands back', () => {
  it('keeps https, upgrades http, and drops everything else', () => {
    assert.equal(webUrl('https://example.org/a'), 'https://example.org/a');
    assert.equal(webUrl('http://example.org/a'), 'https://example.org/a');
    assert.equal(webUrl(' https://example.org/a '), 'https://example.org/a');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.org/a', '/relative', 'example.org', '', null, undefined]) {
      assert.equal(webUrl(bad), undefined, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it('does not let a record choose the landing page or the PDF outside https', () => {
    handlers['api.openalex.org'] = () =>
      json({
        results: [
          openAlexWork({
            display_name: 'Odd Links',
            primary_location: { landing_page_url: 'javascript:alert(1)', pdf_url: 'data:application/pdf;base64,AAAA' },
            best_oa_location: { landing_page_url: 'http://example.org/paper', pdf_url: null },
          }),
        ],
      });
    handlers['api.crossref.org'] = () =>
      json({ message: { items: [crossrefItem({ DOI: '10.1/odd', title: ['Odder Links'], URL: 'javascript:alert(2)' })] } });

    return search('odd', ['openalex', 'crossref']).then((outcome) => {
      const [odd, odder] = ['Odd Links', 'Odder Links'].map((title) => outcome.results.find((paper) => paper.title === title));
      assert.equal(odd.landingUrl, 'https://example.org/paper');
      assert.equal(odd.pdfUrl, undefined);
      assert.equal(odder.landingUrl, 'https://doi.org/10.1/odd');
    });
  });
});

describe('telling a person from a topic', () => {
  it('takes a short run of words for a name', () => {
    assert.equal(nameInQuery('Stefan Banach'), 'Stefan Banach');
    assert.equal(nameInQuery('banach'), 'banach');
    assert.equal(nameInQuery('Y. LeCun'), 'Y. LeCun');
    assert.equal(nameInQuery("Gabriel García Márquez"), 'Gabriel García Márquez');
    assert.equal(nameInQuery('Jan van der Berg'), 'Jan van der Berg');
  });

  it('does not take a phrase, a number, an arXiv id or a sentence for one', () => {
    assert.equal(nameInQuery('"attention is all you need"'), null);
    assert.equal(nameInQuery('2010.08895'), null);
    assert.equal(nameInQuery('resnet 2015'), null);
    assert.equal(nameInQuery('a survey of neural operators for pde'), null);
    // The words a topic is made of, which no name has in it.
    assert.equal(nameInQuery('learning with noise'), null);
    assert.equal(nameInQuery('theory of everything'), null);
  });

  it('is settled by author: in front, the way it is on Scholar', () => {
    assert.equal(nameInQuery('author:"Ilya Sutskever"'), 'Ilya Sutskever');
    assert.equal(nameInQuery('author: theory of everything'), 'theory of everything');
  });
});

describe('whether a record could be the person asked for', () => {
  it('fits an initial to the name it stands for, either way round', () => {
    assert.equal(nameMatches('John Smith', 'J Smith'), true);
    assert.equal(nameMatches('S. Banach', 'Stefan Banach'), true);
    assert.equal(nameMatches('Yann LeCun', 'Y. LeCun'), true);
  });

  it('reads initials run together as one each, and lets a middle initial go missing', () => {
    assert.equal(nameMatches('Erin Braun', 'EJ Braun'), true);
    assert.equal(nameMatches('Erin J. Braun', 'EJ Braun'), true);
    assert.equal(nameMatches('Saurav Chennuri', 'SVP Chennuri'), true);
    assert.equal(nameMatches('EJ Braun', 'Erin Braun'), true);
    // The first given name and the surname still have to fit.
    assert.equal(nameMatches('Jane Braun', 'EJ Braun'), false);
    assert.equal(nameMatches('Erin Brown', 'EJ Braun'), false);
  });

  it('fits the words in any order, with or without accents', () => {
    assert.equal(nameMatches('Zongyi Li', 'Li Zongyi'), true);
    assert.equal(nameMatches('Gabriel García Márquez', 'garcia marquez'), true);
  });

  it('fits a name run together, but not a single word buried in another', () => {
    assert.equal(nameMatches('Yann LeCun', 'Le Cun'), true);
    // Every Smith would fit "MIT" otherwise.
    assert.equal(nameMatches('John Smith', 'mit'), false);
  });

  it('does not fit a stranger the index matched on a label', () => {
    assert.equal(nameMatches('Alice Example', 'graph neural networks'), false);
    assert.equal(nameMatches('Alice Example', 'transformers'), false);
  });
});

const openAlexAuthor = (overrides = {}) => ({
  id: 'https://openalex.org/A1',
  display_name: 'Stefan Banach',
  orcid: null,
  works_count: 58,
  cited_by_count: 41000,
  ...overrides,
});

describe('finding a person', () => {
  it('leaves out the people an index matched on something other than the name', () => {
    handlers['api.openalex.org'] = () =>
      json({
        results: [
          openAlexAuthor(),
          openAlexAuthor({ id: 'https://openalex.org/A2', display_name: 'Alice Example', cited_by_count: 90000 }),
        ],
      });

    return searchAuthors('Banach', ['openalex']).then((outcome) => {
      assert.deepEqual(
        outcome.authors.map((author) => author.name),
        ['Stefan Banach'],
      );
    });
  });
});

const paper = (overrides = {}) => ({
  id: overrides.id || overrides.title,
  source: 'openalex',
  title: 'A Title',
  authors: [],
  abstract: '',
  published: '',
  categories: [],
  ...overrides,
});

describe('the order a person’s papers are in', () => {
  const papers = [
    paper({ title: 'old and cited', published: '1932-01-01', citedBy: 900 }),
    paper({ title: 'new', published: '2024-06-01', citedBy: 3 }),
    paper({ title: 'undated', citedBy: 40 }),
    paper({ title: 'newest', published: '2025-02-01' }),
  ];

  it('puts the newest first, and what has no date last', () => {
    assert.deepEqual(
      sortPapers(papers, 'newest').map((entry) => entry.title),
      ['newest', 'new', 'old and cited', 'undated'],
    );
  });

  it('puts the most cited first, newest among equals', () => {
    assert.deepEqual(
      sortPapers(papers, 'cited').map((entry) => entry.title),
      ['old and cited', 'undated', 'new', 'newest'],
    );
  });

  it('asks OpenAlex for that order, so the pages follow on', async () => {
    const asked = [];
    handlers['api.openalex.org'] = (url) => {
      asked.push(url.searchParams.get('sort'));
      return json({ results: [openAlexWork()] });
    };
    const author = { id: 'openalex:A1', source: 'openalex', name: 'Stefan Banach' };
    await papersByAuthor(author, { order: 'newest' });
    await papersByAuthor(author, { order: 'cited' });
    await papersByAuthor(author);
    assert.deepEqual(asked, ['publication_date:desc', 'cited_by_count:desc', 'publication_date:desc']);
  });

  it('puts a page from Semantic Scholar, which takes no order, in order itself', () => {
    handlers['api.semanticscholar.org'] = () =>
      json({
        data: [
          { paperId: 'p1', title: 'older', year: 2001, citationCount: 5, authors: [] },
          { paperId: 'p2', title: 'newer', year: 2019, citationCount: 1, authors: [] },
        ],
      });
    const author = { id: 's2:1', source: 'semanticscholar', name: 'Anyone' };
    return papersByAuthor(author, { order: 'newest' }).then((found) => {
      assert.deepEqual(found.map((entry) => entry.title), ['newer', 'older']);
    });
  });
});
