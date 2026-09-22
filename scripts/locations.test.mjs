// Where a paper can be read from, and what happens when the first copy will
// not hand it over. No network: every index is stubbed, because these
// assertions are about which copies we collect, how we fold duplicates, the
// order we try them in, and the fall-through when one fails — not about any
// index being up.
//
//   node --test scripts/locations.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadTogether } from './bundle.mjs';

// One bundle for both, so that the address set here is the one Unpaywall's
// lookup reads: module state does not cross two separately bundled copies.
const {
  findLocations,
  forgetLocations,
  mergeLocations,
  rankLocations,
  scholarAuthorUrl,
  scholarPaperUrl,
  setContactEmail,
  setProxyBase: setLocationsProxy,
} = await loadTogether(['src/lib/locations.ts', 'src/lib/contact.ts', 'src/lib/api.ts']);

// The download itself: pdf.ts and api.ts together, so that the proxy address
// set here is the one the download reads. Every module this file needs is
// loaded here, before the first `describe`: node's runner starts draining the
// tests it has at the first top-level await, so a bundle loaded further down
// the file would have its tests registered after the teardown hook had already
// put the real `fetch` back.
const { fetchPdfFromLocations, pdfFromFile, setProxyBase } = await loadTogether(['src/lib/pdf.ts', 'src/lib/api.ts']);
setProxyBase('https://proxy.example.workers.dev');

const at = (url, overrides = {}) => ({
  url,
  host: new URL(url).hostname,
  label: new URL(url).hostname,
  kind: 'repository',
  isPdf: true,
  via: 'openalex',
  ...overrides,
});

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

/** Answers by host, so one stub can serve the four lookups at once. */
let handlers = {};
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const handler = handlers[url.hostname];
  if (!handler) return new Response('{}', { status: 404 });
  return handler(url);
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const paper = (overrides = {}) => ({
  id: 'doi:10.1/x',
  source: 'crossref',
  title: 'Attention Is All You Need',
  authors: ['A Vaswani'],
  abstract: '',
  published: '2017-06-12',
  categories: [],
  doi: '10.1/x',
  ...overrides,
});

beforeEach(() => {
  handlers = {};
  forgetLocations();
  setContactEmail('');
  setLocationsProxy(null);
});

describe('a paper from a Google Scholar profile', () => {
  // What a profile's list gives: a title, a byline, and a link to Scholar's
  // own page about the entry. No file, no cluster, no DOI.
  const fromProfile = () =>
    paper({
      id: 'scholar:Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data',
      source: 'scholar',
      title: 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data',
      doi: undefined,
      landingUrl:
        'https://scholar.google.com/citations?view_op=view_citation&hl=en&user=abcdefgh&citation_for_view=abcdefgh:u5HHmVD_uO8C',
      scholarCitation: 'abcdefgh:u5HHmVD_uO8C',
    });

  it('asks the proxy for the entry’s own page, where the file on the person’s own site is', async () => {
    setLocationsProxy('https://proxy.example.workers.dev');
    const asked = [];
    handlers['proxy.example.workers.dev'] = (url) => {
      asked.push(`${url.pathname}?${url.searchParams}`);
      if (url.pathname === '/scholar/work') {
        return json({
          results: [
            {
              title: 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data',
              url: 'https://openaccess.thecvf.com/content/ICCV2023W/paper.html',
              pdfUrl: 'https://www.bu.edu/example/papers/Chennuri_Fusion_ICCVW_2023.pdf',
              pdfKind: 'PDF',
              pdfHost: 'bu.edu',
              authors: ['Saurav Chennuri'],
              snippet: '',
              clusterId: '6188253286931533296',
              versionCount: 5,
            },
          ],
        });
      }
      if (url.pathname === '/scholar/versions') {
        return json({
          results: [
            { title: 'Fusion approaches…', url: 'https://ieeexplore.ieee.org/document/1', authors: [], snippet: '' },
            { title: 'Fusion approaches…', url: 'https://doi.org/10.1109/ICCVW60793.2023.00281', authors: [], snippet: '' },
          ],
        });
      }
      return json({ error: 'not found' }, 404);
    };

    const found = await findLocations(fromProfile());
    assert.equal(asked[0], '/scholar/work?user=abcdefgh&citation=abcdefgh%3Au5HHmVD_uO8C');
    assert.equal(asked[1], '/scholar/versions?cluster=6188253286931533296');

    const bu = found.find((location) => location.host === 'bu.edu');
    assert.ok(bu, 'the copy on the university site is listed');
    assert.equal(bu.isPdf, true);
    assert.equal(bu.label, 'bu.edu');
    assert.equal(bu.via, 'scholar');
    assert.equal(found[0], bu, 'and it is the copy tried first, being the only file');
    assert.ok(found.some((location) => location.host === 'openaccess.thecvf.com'), 'the page the title points at');
    assert.ok(found.some((location) => location.host === 'ieeexplore.ieee.org'), 'and the other versions, from the cluster it named');
  });

  it('does not count Scholar’s own page about the paper as a place to read it', async () => {
    setLocationsProxy('https://proxy.example.workers.dev');
    handlers['proxy.example.workers.dev'] = () => json({ results: [] });
    const found = await findLocations(fromProfile());
    assert.ok(!found.some((location) => location.host === 'scholar.google.com'));
  });

  it('keeps the file the entry’s page gave when the versions ask is refused', async () => {
    setLocationsProxy('https://proxy.example.workers.dev');
    handlers['proxy.example.workers.dev'] = (url) =>
      url.pathname === '/scholar/work'
        ? json({
            results: [
              {
                title: 'Fusion approaches…',
                pdfUrl: 'https://www.bu.edu/example/papers/paper.pdf',
                pdfHost: 'bu.edu',
                authors: [],
                snippet: '',
                clusterId: '6188253286931533296',
              },
            ],
          })
        : json({ error: 'captcha', blocked: true, reason: 'captcha' }, 503);
    const found = await findLocations(fromProfile());
    assert.equal(found.length, 1);
    assert.equal(found[0].host, 'bu.edu');
  });

  it('asks nothing of Scholar without a proxy to ask through', async () => {
    let asked = false;
    handlers['proxy.example.workers.dev'] = () => {
      asked = true;
      return json({ results: [] });
    };
    const found = await findLocations(fromProfile());
    assert.equal(asked, false);
    assert.deepEqual(found, []);
  });
});

describe('collecting every copy of a paper', () => {
  it('asks Unpaywall for all of them, not only the one it calls best', async () => {
    setContactEmail('reader@example.org');
    handlers['api.unpaywall.org'] = () =>
      json({
        best_oa_location: {
          url_for_pdf: 'https://repo.example.edu/one.pdf',
          host_type: 'repository',
          repository_institution: 'Example University',
          version: 'acceptedVersion',
        },
        oa_locations: [
          { url_for_pdf: 'https://publisher.example.com/two.pdf', host_type: 'publisher' },
          { url: 'https://third.example.org/record/9', host_type: 'repository' },
        ],
      });

    const found = await findLocations(paper());
    const urls = found.map((location) => location.url);
    assert.ok(urls.includes('https://repo.example.edu/one.pdf'), 'the best copy');
    assert.ok(urls.includes('https://publisher.example.com/two.pdf'), 'the publisher copy');
    assert.ok(urls.includes('https://third.example.org/record/9'), 'a landing page is still a place to look');
  });

  it('reads the whole of OpenAlex’s location list, where the repository deposits are', async () => {
    handlers['api.openalex.org'] = () =>
      json({
        id: 'https://openalex.org/W1',
        display_name: 'Attention Is All You Need',
        locations: [
          {
            pdf_url: null,
            landing_page_url: 'https://publisher.example.com/paywalled',
            source: { display_name: 'Journal of Examples', type: 'journal' },
          },
          {
            pdf_url: 'https://dspace.example.edu/bitstream/1/paper.pdf',
            landing_page_url: null,
            source: { display_name: 'Example DSpace', type: 'repository' },
            version: 'submittedVersion',
          },
        ],
        ids: { pmcid: 'PMC12345' },
      });

    const found = await findLocations(paper());
    const dspace = found.find((location) => location.host === 'dspace.example.edu');
    assert.equal(dspace.label, 'Example DSpace');
    assert.equal(dspace.kind, 'repository');
    assert.equal(dspace.isPdf, true);
    assert.equal(dspace.version, 'submittedVersion');
    assert.ok(
      found.some((location) => location.via === 'pmc'),
      'a PubMed Central id is a copy in its own right',
    );
  });

  it('keeps going when one index is down', async () => {
    handlers['api.openalex.org'] = () => {
      throw new Error('OpenAlex is having a day');
    };
    handlers['api.semanticscholar.org'] = () => json({ openAccessPdf: { url: 'https://s2.example.org/p.pdf' } });

    const found = await findLocations(paper({ id: 's2:abc' }));
    assert.ok(found.some((location) => location.host === 's2.example.org'));
  });

  it('starts from what the search result already knew', async () => {
    const found = await findLocations(
      paper({ arxivId: '1706.03762', landingUrl: 'https://arxiv.org/abs/1706.03762' }),
    );
    assert.equal(found[0].url, 'https://arxiv.org/pdf/1706.03762');
    assert.equal(found[0].label, 'arXiv');
  });

  it('refuses a location that is not https, because the proxy would too', async () => {
    const found = await findLocations(paper({ pdfUrl: 'ftp://example.org/paper.pdf' }));
    assert.equal(
      found.some((location) => location.url.startsWith('ftp:')),
      false,
    );
  });
});

describe('folding the same copy reported twice', () => {
  it('merges on the URL, ignoring a www. and a trailing slash', () => {
    const merged = mergeLocations([
      [{ url: 'https://www.repo.org/a.pdf/', host: 'repo.org', label: 'repo.org', kind: 'repository', isPdf: false, via: 'openalex' }],
      [{ url: 'https://repo.org/a.pdf', host: 'repo.org', label: 'Example Repository', kind: 'repository', isPdf: true, via: 'unpaywall', version: 'acceptedVersion' }],
    ]);
    assert.equal(merged.length, 1);
    // Whichever record knows more wins, field by field.
    assert.equal(merged[0].label, 'Example Repository');
    assert.equal(merged[0].isPdf, true);
    assert.equal(merged[0].version, 'acceptedVersion');
  });
});

describe('the order the copies are tried in', () => {
  it('puts a file before a landing page, and a preprint before a publisher', () => {
    const ordered = rankLocations([
      { url: 'https://p.example.com/page', host: 'p.example.com', label: 'Publisher', kind: 'publisher', isPdf: false, via: 'crossref' },
      { url: 'https://p.example.com/x.pdf', host: 'p.example.com', label: 'Publisher', kind: 'publisher', isPdf: true, via: 'crossref' },
      { url: 'https://arxiv.org/pdf/1', host: 'arxiv.org', label: 'arXiv', kind: 'preprint', isPdf: true, via: 'arxiv' },
    ]);
    assert.deepEqual(
      ordered.map((location) => location.label),
      ['arXiv', 'Publisher', 'Publisher'],
    );
    assert.equal(ordered[1].isPdf, true, 'the publisher’s file beats its landing page');
  });
});

describe('downloading from whichever copy will answer', () => {
  it('falls through to the next copy when one refuses', async () => {
    const asked = [];
    handlers['proxy.example.workers.dev'] = (url) => {
      const target = url.searchParams.get('url');
      asked.push(target);
      // The first is a landing page behind a login, as so many are.
      if (target.includes('locked.example.com')) {
        return json({ error: 'that link gave a web page rather than a PDF' }, 415);
      }
      return new Response('%PDF-1.4 ...', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    };

    const fetched = await fetchPdfFromLocations(paper(), [
      at('https://locked.example.com/paper.pdf'),
      at('https://open.example.edu/paper.pdf'),
    ]);
    assert.equal(fetched.location.host, 'open.example.edu');
    assert.equal(fetched.tried.length, 1, 'it says what it tried first');
    assert.equal(asked.length, 2);
  });

  it('names the copies it tried when none of them answers', async () => {
    handlers['proxy.example.workers.dev'] = () => json({ error: 'the publisher answered 403' }, 502);
    await assert.rejects(
      fetchPdfFromLocations(paper(), [
        at('https://one.example.com/a.pdf', { label: 'Publisher One' }),
        at('https://two.example.com/b.pdf', { label: 'Publisher Two' }),
      ]),
      (error) => {
        assert.match(error.message, /None of the 2 known copies/);
        assert.match(error.message, /Publisher One, Publisher Two/);
        return true;
      },
    );
  });

  it('asks arXiv by id rather than by URL, which is the route the proxy has', async () => {
    const asked = [];
    handlers['proxy.example.workers.dev'] = (url) => {
      asked.push(url.pathname + '?' + url.searchParams.toString());
      return new Response('%PDF-1.4 ...', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    };
    await fetchPdfFromLocations(paper(), [at('https://arxiv.org/pdf/1706.03762', { kind: 'preprint' })]);
    assert.match(asked[0], /\/arxiv\/pdf\?id=1706\.03762/);
  });
});

describe('a file handed over by the person', () => {
  it('takes a PDF, whatever the browser called it', async () => {
    const blob = await pdfFromFile(new Blob(['%PDF-1.7 hello'], { type: 'application/octet-stream' }));
    assert.equal(blob.type, 'application/pdf');
    assert.equal(blob.size, '%PDF-1.7 hello'.length);
  });

  it('refuses a web page saved as a .pdf, and an empty file', async () => {
    await assert.rejects(pdfFromFile(new Blob(['<html>sign in</html>'], { type: 'application/pdf' })), /not a PDF/);
    await assert.rejects(pdfFromFile(new Blob([], { type: 'application/pdf' })), /empty/);
  });
});

describe('the links out to Google Scholar', () => {
  it('searches for the title as a phrase', () => {
    const url = new URL(scholarPaperUrl(paper()));
    assert.equal(url.hostname, 'scholar.google.com');
    assert.equal(url.searchParams.get('q'), '"Attention Is All You Need"');
  });

  it('sends a person to the profile search rather than to papers', () => {
    const url = new URL(scholarAuthorUrl('Saurav Chennuri'));
    assert.equal(url.pathname, '/citations');
    assert.equal(url.searchParams.get('view_op'), 'search_authors');
    assert.equal(url.searchParams.get('mauthors'), 'Saurav Chennuri');
  });
});
