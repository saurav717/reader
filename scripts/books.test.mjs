// Books and PDF links: what Open Library's and the Internet Archive's answers
// become, which of an Archive item's files is the PDF, and what a pasted link
// is taken to be. No network: both services are stubbed.
//
//   node --test scripts/books.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { archiveLocations, fromOpenLibrary, fromArchive, linkFromQuery, paperFromLink, searchBooks, titleFromLink } =
  await load('src/lib/books.ts');
const { findLocations } = await load('src/lib/locations.ts');
const { search, sourceList } = await load('src/lib/sources.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

let handlers = {};
const asked = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  asked.push(url);
  const handler = handlers[url.hostname];
  if (!handler) throw new Error(`no stub for ${url.hostname}`);
  return handler(url);
};
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  handlers = {};
  asked.length = 0;
});

describe('a book from Open Library', () => {
  it('points a free scan at its PDF on the Archive', () => {
    const book = fromOpenLibrary({
      key: '/works/OL1W',
      title: 'Flatland',
      subtitle: 'A Romance of Many Dimensions',
      author_name: ['Edwin A. Abbott'],
      first_publish_year: 1884,
      ia: ['flatlandromanceo00abbouoft', 'other'],
      ebook_access: 'public',
    });
    assert.equal(book.id, 'openlibrary:OL1W:flatlandromanceo00abbouoft');
    assert.equal(book.source, 'books');
    assert.equal(book.title, 'Flatland: A Romance of Many Dimensions');
    assert.equal(book.pdfUrl, 'https://archive.org/download/flatlandromanceo00abbouoft/flatlandromanceo00abbouoft.pdf');
    assert.equal(book.published, '1884-01-01');
  });

  it('gives a book that is only lent out its page and no PDF', () => {
    const book = fromOpenLibrary({ key: '/works/OL2W', title: 'Recent', ia: ['recent00'], ebook_access: 'borrowable' });
    assert.equal(book.pdfUrl, undefined);
    assert.equal(book.landingUrl, 'https://openlibrary.org/works/OL2W');
  });
});

describe('a text from the Internet Archive', () => {
  it('keeps the first of each field the Archive lists as several', () => {
    const text = fromArchive({
      identifier: 'report-1999',
      title: ['A Report'],
      creator: ['Ada', 'Grace'],
      year: '1999',
      description: '<p>What it is about.</p>',
    });
    assert.equal(text.id, 'archive:report-1999');
    assert.deepEqual(text.authors, ['Ada', 'Grace']);
    assert.equal(text.published, '1999-01-01');
    assert.equal(text.abstract, 'What it is about.');
    assert.equal(text.landingUrl, 'https://archive.org/details/report-1999');
  });

  it('finds the PDF among its files, the text one first, and leaves out lent ones', async () => {
    handlers['archive.org'] = () =>
      json({
        result: [
          { name: 'scan_jp2.zip', format: 'Single Page Processed JP2 ZIP' },
          { name: 'scan_bw.pdf', format: 'Image Container PDF' },
          { name: 'scan text.pdf', format: 'Text PDF' },
          { name: 'locked.pdf', format: 'Text PDF', private: 'true' },
        ],
      });
    const found = await archiveLocations('scan');
    assert.deepEqual(
      found.map((location) => location.url),
      ['https://archive.org/download/scan/scan%20text.pdf', 'https://archive.org/download/scan/scan_bw.pdf'],
    );
    assert.ok(found.every((location) => location.isPdf));
  });
});

describe('searching for books', () => {
  it('asks both, folds a book into its own scan, and puts the readable ones first', async () => {
    handlers['openlibrary.org'] = () =>
      json({
        docs: [
          { key: '/works/OL9W', title: 'Lent Only', ebook_access: 'borrowable' },
          { key: '/works/OL1W', title: 'Flatland', ia: ['flat'], ebook_access: 'public' },
        ],
      });
    handlers['archive.org'] = (url) => {
      assert.match(url.searchParams.get('q'), /mediatype:\(texts\) AND format:\(PDF\)/);
      return json({ response: { docs: [{ identifier: 'flat', title: 'Flatland' }, { identifier: 'notes', title: 'Notes' }] } });
    };
    const found = await searchBooks('flatland', 0, 20);
    assert.deepEqual(
      found.map((book) => book.id),
      ['openlibrary:OL1W:flat', 'archive:notes', 'openlibrary:OL9W:'],
    );
  });

  it('still answers when one of the two is down', async () => {
    handlers['openlibrary.org'] = () => new Response('', { status: 503 });
    handlers['archive.org'] = () => json({ response: { docs: [{ identifier: 'notes', title: 'Notes' }] } });
    const found = await searchBooks('notes', 0, 20);
    assert.deepEqual(found.map((book) => book.id), ['archive:notes']);
  });

  it('is a source of its own, without a proxy', async () => {
    assert.ok(sourceList().some((source) => source.id === 'books'));
    handlers['openlibrary.org'] = () => json({ docs: [{ key: '/works/OL1W', title: 'Flatland', ia: ['flat'], ebook_access: 'public' }] });
    handlers['archive.org'] = () => json({ response: { docs: [] } });
    const outcome = await search('flatland', ['books']);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.results[0].title, 'Flatland');
  });

  it('looks for a book’s copies on the Archive only, not in the paper indexes', async () => {
    handlers['archive.org'] = () => json({ result: [{ name: 'notes.pdf', format: 'Text PDF' }] });
    const found = await findLocations(fromArchive({ identifier: 'notes', title: 'Notes' }));
    assert.ok(asked.every((url) => url.hostname === 'archive.org'));
    assert.equal(found[0].url, 'https://archive.org/download/notes/notes.pdf');
  });
});

describe('a pasted link', () => {
  it('is recognised only when the whole query is one', () => {
    assert.ok(linkFromQuery('https://example.org/a.pdf'));
    assert.equal(linkFromQuery('see https://example.org/a.pdf'), null);
    assert.equal(linkFromQuery('deep learning'), null);
  });

  it('reads a title out of the file name', () => {
    assert.equal(titleFromLink(new URL('https://x.org/books/Deep_Learning-Goodfellow.pdf')), 'Deep Learning Goodfellow');
    assert.equal(titleFromLink(new URL('https://x.org/Linear%20Algebra%20Done%20Right/download')), 'Linear Algebra Done Right');
  });

  it('becomes a paper whose PDF is the link, keyed on the link', () => {
    const paper = paperFromLink(new URL('http://www.x.org/notes/lecture3.pdf'));
    assert.equal(paper.id, 'url:https://www.x.org/notes/lecture3.pdf');
    assert.equal(paper.pdfUrl, 'https://www.x.org/notes/lecture3.pdf');
    assert.equal(paper.venue, 'x.org');
  });

  it('keeps a link that is a page as a page', () => {
    const paper = paperFromLink(new URL('https://x.org/book/chapter-1'));
    assert.equal(paper.pdfUrl, undefined);
    assert.equal(paper.landingUrl, 'https://x.org/book/chapter-1');
  });
});
