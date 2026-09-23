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
const { fetchPdfFromLocations, pdfAvailability, pdfFromFile, setProxyBase, COPIES_AT_ONCE } = await loadTogether([
  'src/lib/pdf.ts',
  'src/lib/api.ts',
]);
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
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const handler = handlers[url.hostname];
  if (!handler) return new Response('{}', { status: 404 });
  return handler(url, init);
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

  it('falls back to the search by title when the entry’s own page is refused, or the proxy has no route for it', async () => {
    // What the site sees from a Worker older than the route (404) and what a
    // plain request gets from Scholar's profile pages (a 401 refusal): either
    // way the search answers, with the same record the Papers tab shows.
    for (const refusal of [json({ error: 'not found' }, 404), json({ error: 'refused', blocked: true, reason: 'refused' }, 503)]) {
      forgetLocations();
      setLocationsProxy('https://proxy.example.workers.dev');
      const asked = [];
      handlers['proxy.example.workers.dev'] = (url) => {
        asked.push(url.pathname);
        if (url.pathname === '/scholar/work') return refusal.clone();
        if (url.pathname === '/scholar/search') {
          assert.equal(url.searchParams.get('q'), '"Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data"');
          return json({
            results: [
              // A neighbour Scholar finds for the same words: not this paper.
              { title: 'Fusion approaches to aphasia severity: a replication', url: 'https://other.example.org/1', pdfUrl: 'https://other.example.org/1.pdf', authors: [], snippet: '', clusterId: '1' },
              {
                title: 'Fusion Approaches to Predict Post-Stroke Aphasia Severity from Multimodal Neuroimaging Data',
                url: 'https://ieeexplore.ieee.org/document/10350951',
                pdfUrl: 'https://www.bu.edu/example/papers/Chennuri_Fusion_ICCVW_2023.pdf',
                pdfHost: 'bu.edu',
                authors: [],
                snippet: '',
                clusterId: '6188253286931533296',
                versionCount: 5,
              },
            ],
          });
        }
        if (url.pathname === '/scholar/versions') {
          return json({ results: [{ title: 'Fusion approaches…', url: 'https://openaccess.thecvf.com/x.html', pdfUrl: 'https://openaccess.thecvf.com/x.pdf', pdfHost: 'thecvf.com', authors: [], snippet: '' }] });
        }
        return json({ error: 'not found' }, 404);
      };
      const found = await findLocations(fromProfile());
      assert.deepEqual(asked, ['/scholar/work', '/scholar/search', '/scholar/versions']);
      assert.equal(found[0].host, 'bu.edu');
      assert.ok(found.some((location) => location.host === 'openaccess.thecvf.com' && location.isPdf), 'and the versions from the cluster the search named');
      assert.ok(!found.some((location) => location.host === 'other.example.org'), 'the neighbour is not this paper');
    }
  });

  it('asks the search by title for any Scholar paper without a cluster, not only a profile’s', async () => {
    setLocationsProxy('https://proxy.example.workers.dev');
    const asked = [];
    handlers['proxy.example.workers.dev'] = (url) => {
      asked.push(url.pathname);
      return json({ results: [{ title: 'Attention Is All You Need', pdfUrl: 'https://arxiv.example.org/1706.03762.pdf', pdfHost: 'arxiv.org', authors: [], snippet: '' }] });
    };
    const found = await findLocations(paper({ id: 'scholar:Attention Is All You Need', source: 'scholar', doi: undefined, landingUrl: undefined }));
    assert.deepEqual(asked, ['/scholar/search']);
    assert.equal(found[0].host, 'arxiv.example.org');
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
    handlers['proxy.example.workers.dev'] = async (url) => {
      const target = url.searchParams.get('url');
      asked.push(target);
      // The first is a landing page behind a login, as so many are.
      if (target.includes('locked.example.com')) {
        return json({ error: 'that link gave a web page rather than a PDF' }, 415);
      }
      // A beat behind the refusal, so the refusal is on record when the answer comes.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response('%PDF-1.4 ...', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    };

    const fetched = await fetchPdfFromLocations(paper(), [
      at('https://locked.example.com/paper.pdf'),
      at('https://open.example.edu/paper.pdf'),
    ]);
    assert.equal(fetched.location.host, 'open.example.edu');
    assert.equal(fetched.tried.length, 1, 'it says what refused before the answer came');
    assert.equal(asked.length, 2);
  });

  it('asks a few copies at once, best first, and the first to answer wins', async () => {
    const asked = [];
    let inFlight = 0;
    let most = 0;
    handlers['proxy.example.workers.dev'] = async (url) => {
      const target = url.searchParams.get('url');
      asked.push(new URL(target).hostname);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, target.includes('slow') ? 60 : 5));
      inFlight -= 1;
      if (target.includes('refuses')) return json({ error: 'that link gave a web page rather than a PDF' }, 415);
      return new Response('%PDF-1.4 ...', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    };

    const fetched = await fetchPdfFromLocations(paper(), [
      at('https://slow.example.com/a.pdf'),
      at('https://refuses.example.com/b.pdf'),
      at('https://quick.example.edu/c.pdf'),
      at('https://later.example.org/d.pdf'),
      at('https://last.example.org/e.pdf'),
    ]);
    // The quick copy answered while the best-ranked one was still on its
    // way: it is the file, and nobody waited for the slow one to say so.
    assert.equal(fetched.location.host, 'quick.example.edu');
    assert.deepEqual(fetched.tried.map((entry) => entry.location.host), ['refuses.example.com']);
    assert.deepEqual(asked.slice(0, COPIES_AT_ONCE), ['slow.example.com', 'refuses.example.com', 'quick.example.edu'], 'started in rank order');
    assert.equal(most, COPIES_AT_ONCE, 'a window of copies in flight, not one and not all');
    assert.ok(!asked.includes('last.example.org'), 'a win stops the queue');
  });

  it('asks one copy per site at a time, whatever the window allows', async () => {
    const asked = [];
    const perHost = new Map();
    let mostAtOnePlace = 0;
    handlers['proxy.example.workers.dev'] = async (url) => {
      const host = new URL(url.searchParams.get('url')).hostname;
      asked.push(host);
      perHost.set(host, (perHost.get(host) || 0) + 1);
      mostAtOnePlace = Math.max(mostAtOnePlace, perHost.get(host));
      await new Promise((resolve) => setTimeout(resolve, 10));
      perHost.set(host, perHost.get(host) - 1);
      return json({ error: 'that link gave a web page rather than a PDF' }, 415);
    };

    await assert.rejects(
      fetchPdfFromLocations(paper(), [
        at('https://www.academia.edu/download/1/a.pdf'),
        at('https://www.academia.edu/download/2/b.pdf'),
        at('https://academia.edu/download/3/c.pdf'),
        at('https://ieeexplore.ieee.org/stamp/d.pdf'),
        at('https://link.springer.com/content/pdf/e.pdf'),
      ]),
      /None of the 5 known copies/,
    );
    assert.equal(asked.length, 5, 'every copy was still asked');
    assert.equal(mostAtOnePlace, 1, 'never two at one site at once');
    // The window is filled from other sites while a site is busy, so the head start is not lost.
    assert.deepEqual(asked.slice(0, 3), ['www.academia.edu', 'ieeexplore.ieee.org', 'link.springer.com']);
  });

  it('stops a download nobody is waiting for any more, and leaves one somebody is', async () => {
    const signals = [];
    handlers['proxy.example.workers.dev'] = (url, init) =>
      new Promise((resolve, reject) => {
        signals.push(init.signal);
        const timer = setTimeout(() => resolve(new Response('%PDF-1.4 ...', { status: 200, headers: { 'Content-Type': 'application/pdf' } })), 200);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const copies = [at('https://one.example.org/a.pdf'), at('https://two.example.org/b.pdf')];
    const leaving = new AbortController();
    const staying = new AbortController();
    const left = fetchPdfFromLocations(paper(), copies, leaving.signal);
    const stayed = fetchPdfFromLocations(paper(), copies, staying.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(signals.length, 2, 'one download per copy, shared by both callers');

    leaving.abort();
    await assert.rejects(left, (error) => error.name === 'AbortError');
    assert.ok(signals.every((signal) => !signal.aborted), 'somebody is still waiting on them');

    staying.abort();
    await assert.rejects(stayed, (error) => error.name === 'AbortError');
    assert.ok(signals.every((signal) => signal.aborted), 'nobody is: the downloads themselves are stopped');
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

describe('whether there is a PDF to open at all', () => {
  const nothing = { pdfUrl: null, resolved: false, driveCopy: false, locations: null };

  it('is still looking while both the link and the copies are out', () => {
    assert.equal(pdfAvailability(nothing), 'checking');
    assert.equal(pdfAvailability({ ...nothing, resolved: true }), 'checking');
    assert.equal(pdfAvailability({ ...nothing, locations: [] }), 'checking');
  });

  it('opens on the copy in Drive without waiting for any index', () => {
    assert.equal(pdfAvailability({ ...nothing, driveCopy: true }), 'ready');
  });

  it('opens on a link the paper came with, or one resolved by DOI', () => {
    assert.equal(pdfAvailability({ ...nothing, pdfUrl: 'https://arxiv.org/pdf/2010.08895' }), 'ready');
    assert.equal(pdfAvailability({ ...nothing, resolved: true, pdfUrl: 'https://repo.example/paper.pdf' }), 'ready');
  });

  it('opens on the copies the indexes list, with no link of its own — a Scholar profile’s paper', () => {
    const copies = [at('https://www.bu.edu/lab/files/paper.pdf', { via: 'scholar' })];
    assert.equal(pdfAvailability({ ...nothing, locations: copies }), 'ready');
  });

  it('does not count a landing page: a paper behind a login opens on its abstract, not on the wall', () => {
    const page = [at('https://ieeexplore.ieee.org/document/1', { isPdf: false, kind: 'publisher' })];
    assert.equal(pdfAvailability({ ...nothing, resolved: true, locations: page }), 'none');
    assert.equal(pdfAvailability({ ...nothing, locations: page }), 'checking');
  });

  it('gives up only once the link and the copies have both come back empty', () => {
    assert.equal(pdfAvailability({ ...nothing, resolved: true, locations: [] }), 'none');
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
