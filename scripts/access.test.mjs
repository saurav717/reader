// Signing in with an institution: which URL a signed-in browser is asked for,
// how a landing page's PDF is found, and what the proxy says about whether it
// can open a window at all. No browser is launched here — these are the
// decisions around it, which are what can be wrong quietly.
//
//   node --test scripts/access.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
const { availability, everSignedIn, pdfCandidates, pdfLinksIn, status } = await import('../server/access.js');
const { googleBooksId, googleBooksPdf, grabTargets } = await import('../server/pdfLinks.js');

describe('which URL a signed-in browser asks for', () => {
  it('turns an IEEE document page into its stamp endpoints, file first', () => {
    const candidates = pdfCandidates('https://ieeexplore.ieee.org/document/9000000/');
    assert.equal(candidates[0], 'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9000000');
    assert.equal(candidates[1], 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9000000');
    assert.equal(candidates[2], 'https://ieeexplore.ieee.org/document/9000000/');
  });

  it('reads the article number from an abstract page and from a stamp URL', () => {
    assert.equal(
      pdfCandidates('https://ieeexplore.ieee.org/abstract/document/1234567')[0],
      'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=1234567',
    );
    assert.equal(
      pdfCandidates('https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=1234567')[0],
      'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=1234567',
    );
  });

  it('leaves every other publisher alone', () => {
    assert.deepEqual(pdfCandidates('https://link.springer.com/article/10.1007/x'), [
      'https://link.springer.com/article/10.1007/x',
    ]);
    assert.deepEqual(pdfCandidates('not a url'), ['not a url']);
  });
});

describe('where a landing page says its PDF is', () => {
  it('reads the citation_pdf_url meta tag most publishers put on the page', () => {
    const html = `<html><head>
      <meta name="citation_title" content="A paper">
      <meta name="citation_pdf_url" content="https://link.springer.com/content/pdf/10.1007/x.pdf">
    </head></html>`;
    assert.deepEqual(pdfLinksIn(html, 'https://link.springer.com/article/10.1007/x'), [
      'https://link.springer.com/content/pdf/10.1007/x.pdf',
    ]);
  });

  it('reads the path IEEE keeps in its metadata blob, and the frame on its stamp page', () => {
    const document = `<script>xplGlobal.document.metadata={"articleNumber":"9000000","pdfPath":"/iel7/1/2/09000000.pdf","pdfUrl":"/stamp/stamp.jsp?tp=&arnumber=9000000"};</script>`;
    assert.deepEqual(pdfLinksIn(document, 'https://ieeexplore.ieee.org/document/9000000'), [
      'https://ieeexplore.ieee.org/iel7/1/2/09000000.pdf',
      'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9000000',
    ]);
    const stamp = `<html><body><iframe src="https://ieeexplore.ieee.org/ielx7/1/2/09000000.pdf?tp=&amp;arnumber=9000000&amp;ref="></iframe></body></html>`;
    assert.deepEqual(pdfLinksIn(stamp, 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9000000'), [
      'https://ieeexplore.ieee.org/ielx7/1/2/09000000.pdf?tp=&arnumber=9000000&ref=',
    ]);
  });

  it('resolves relative links, skips duplicates, and never returns http', () => {
    const html = `<a href="/content/pdf/x.pdf">PDF</a><a href="/content/pdf/x.pdf">again</a><a href="http://mirror.example/x.pdf">mirror</a><a href="/about">about</a>`;
    assert.deepEqual(pdfLinksIn(html, 'https://publisher.example/article/x'), [
      'https://publisher.example/content/pdf/x.pdf',
    ]);
  });
});

describe('a book on Google Books', () => {
  const volume = (accessInfo, title = 'Flatland') => async (url) => {
    assert.equal(String(url), 'https://www.googleapis.com/books/v1/volumes/2fsVAAAAYAAJ');
    return new Response(JSON.stringify({ volumeInfo: { title }, accessInfo }), { status: 200 });
  };

  it('knows the volume from every shape of link, and nothing else', () => {
    assert.equal(googleBooksId('https://books.google.com/books?id=2fsVAAAAYAAJ&printsec=frontcover'), '2fsVAAAAYAAJ');
    assert.equal(googleBooksId('https://www.google.co.uk/books/edition/Flatland/2fsVAAAAYAAJ?hl=en&gbpv=1'), '2fsVAAAAYAAJ');
    assert.equal(googleBooksId('https://play.google.com/store/books/details?id=2fsVAAAAYAAJ'), '2fsVAAAAYAAJ');
    assert.equal(googleBooksId('https://www.google.com/search?q=flatland'), null);
    assert.equal(googleBooksId('https://link.springer.com/book/10.1007/x'), null);
  });

  it('asks the Books API for a free book’s download link and tries it first', async () => {
    const found = await googleBooksPdf(
      'https://www.google.com/books/edition/Flatland/2fsVAAAAYAAJ?gbpv=1',
      volume({ viewability: 'ALL_PAGES', pdf: { isAvailable: true, downloadLink: 'http://books.google.com/books/download/Flatland.pdf?id=2fsVAAAAYAAJ&output=pdf&sig=S' } }),
    );
    assert.equal(found.urls[0], 'https://books.google.com/books/download/Flatland.pdf?id=2fsVAAAAYAAJ&output=pdf&sig=S');
    assert.ok(found.urls.includes('https://books.google.com/books?id=2fsVAAAAYAAJ&hl=en'));
    assert.equal(found.why, null);
  });

  it('says a preview is only a preview, and a bought ebook is DRM', async () => {
    const preview = await googleBooksPdf('https://books.google.com/books?id=2fsVAAAAYAAJ', volume({ viewability: 'PARTIAL', pdf: { isAvailable: false } }));
    assert.match(preview.why, /only shows a preview of “Flatland”/);
    const bought = await googleBooksPdf(
      'https://books.google.com/books?id=2fsVAAAAYAAJ',
      volume({ viewability: 'PARTIAL', pdf: { isAvailable: true, downloadLink: 'http://books.google.com/books/download/F-sample-pdf.acsm?id=2fsVAAAAYAAJ' } }),
    );
    assert.ok(!bought.urls.some((url) => /acsm/.test(url)));
    assert.ok(bought.why);
  });

  it('still walks the book page when the API cannot be reached', async () => {
    const found = await googleBooksPdf('https://books.google.com/books?id=2fsVAAAAYAAJ', async () => {
      throw new Error('offline');
    });
    assert.ok(found.urls.includes('https://books.google.com/books?id=2fsVAAAAYAAJ&hl=en'));
    assert.equal(found.why, null);
  });

  it('finds the download link Google writes http:// on its own page', () => {
    const html = '<a href="http://books.google.com/books/download/Flatland.pdf?id=2fsVAAAAYAAJ&amp;output=pdf&amp;sig=S">Download PDF</a>';
    assert.deepEqual(pdfLinksIn(html, 'https://books.google.com/books?id=2fsVAAAAYAAJ'), [
      'https://books.google.com/books/download/Flatland.pdf?id=2fsVAAAAYAAJ&output=pdf&sig=S',
    ]);
  });

  it('puts the Google Books candidates ahead of the page’s own, for the grab', async () => {
    const { urls, why } = await grabTargets('https://books.google.com/books?id=2fsVAAAAYAAJ', '', volume({ pdf: { isAvailable: true, downloadLink: 'https://books.google.com/books/download/F.pdf?id=2fsVAAAAYAAJ&sig=S' } }));
    assert.equal(urls[0], 'https://books.google.com/books/download/F.pdf?id=2fsVAAAAYAAJ&sig=S');
    assert.equal(urls.at(-1), 'https://books.google.com/books?id=2fsVAAAAYAAJ');
    assert.equal(why, null);
    const elsewhere = await grabTargets('https://link.springer.com/article/10.1007/x', '', async () => {
      throw new Error('should not be asked');
    });
    assert.deepEqual(elsewhere, { urls: ['https://link.springer.com/article/10.1007/x'], why: null });
  });
});

describe('whether this proxy can open a window', () => {
  it('has never signed in when the profile directory does not exist', () => {
    assert.equal(everSignedIn(), false);
  });

  it('answers with a boolean, and a reason when it cannot', async () => {
    const ready = await availability();
    assert.equal(typeof ready.available, 'boolean');
    if (!ready.available) assert.match(ready.reason, /Playwright|Chromium|screen/);
  });

  it('reports the window closed and that there is no profile yet — and never where one would be', async () => {
    const answer = await status();
    assert.equal(answer.window, 'closed');
    assert.equal(answer.everSignedIn, false);
    assert.equal(answer.profileExists, false);
    assert.equal(answer.profile, undefined);
  });
});
