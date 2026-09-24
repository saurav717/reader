// How the library lists papers: the tile that stands in for a cover, the
// line of authors, and the headings the list is grouped under by the day a
// paper was added.
//
//   node --test scripts/library.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { authorLine, coverFor, dayGroup, relativeDay } = await load('src/lib/libraryLook.ts');

after(cleanup);

describe('the tile in place of a cover', () => {
  it('gives every paper in a journal the same colour, whatever the case', () => {
    const a = coverFor({ source: 'scholar', venue: 'Brain imaging and behavior', published: '2019-01-01' });
    const b = coverFor({ source: 'openalex', venue: 'Brain Imaging and Behavior', published: '2021-05-01' });
    assert.equal(a.hue, b.hue);
    assert.equal(a.kind, 'Journal');
    assert.equal(a.year, '2019');
  });

  it('says what kind of thing it is', () => {
    assert.equal(coverFor({ source: 'arxiv', arxivId: '2503.07137', published: '2025-03-10' }).kind, 'arXiv');
    assert.equal(coverFor({ source: 'books', published: '2016', landingUrl: 'https://openlibrary.org/x' }).kind, 'Book');
    assert.equal(coverFor({ source: 'scholar', venue: 'Proceedings of the IEEE/CVF International Conference on Computer Vision' }).kind, 'Proc.');
    assert.equal(coverFor({ source: 'scholar' }).year, undefined);
  });
});

describe('the line of authors', () => {
  it('names three and counts the rest', () => {
    assert.equal(authorLine(['SC Huang', 'A Pareek', 'S Seyyedi', 'I Banerjee', 'MP Lungren']), 'SC Huang, A Pareek, S Seyyedi +2');
    assert.equal(authorLine(['S Mu', 'S Lin']), 'S Mu, S Lin');
    assert.equal(authorLine([]), 'Unknown author');
  });
});

describe('the day a paper was added', () => {
  const now = new Date(2026, 8, 24, 15, 0);
  const at = (y, m, d, h = 9) => new Date(y, m, d, h).toISOString();

  it('groups by today, yesterday, this week and this month', () => {
    assert.equal(dayGroup(at(2026, 8, 24, 1), now), 'Today');
    assert.equal(dayGroup(at(2026, 8, 23, 23), now), 'Yesterday');
    assert.equal(dayGroup(at(2026, 8, 20), now), 'This week');
    assert.equal(dayGroup(at(2026, 8, 3), now), 'Earlier this month');
  });

  it('names the month after that, and the year for another year', () => {
    assert.equal(dayGroup(at(2026, 7, 10), now), 'August');
    assert.equal(dayGroup(at(2025, 11, 1), now), 'December 2025');
  });

  it('says how long ago in words', () => {
    assert.equal(relativeDay(at(2026, 8, 24), now), 'today');
    assert.equal(relativeDay(at(2026, 8, 21), now), '3 days ago');
    assert.equal(relativeDay(at(2026, 2, 12), now), '12 Mar');
  });
});

const { DEFAULT_PREFS, groupPapers, readPrefs, sortPapers } = await load('src/lib/libraryView.ts');

describe('the View menu’s grouping and order', () => {
  const now = new Date(2026, 8, 24, 15, 0);
  const paper = (id, extra) => ({ id, source: 'scholar', title: id, authors: [], abstract: '', published: '', categories: [], addedAt: now.toISOString(), collectionIds: [], tags: [], progress: 0, ...extra });
  const papers = [
    paper('a', { title: 'Zeta', authors: ['EL Meier'], venue: 'Brain imaging and behavior', published: '2019-01-01', progress: 0.3, collectionIds: ['c1', 'c2'], addedAt: new Date(2026, 8, 24).toISOString() }),
    paper('b', { title: 'Alpha', authors: ['S Mu'], arxivId: '2503.07137', published: '2025-03-10', progress: 1, addedAt: new Date(2026, 8, 20).toISOString() }),
    paper('c', { title: 'Mid', authors: ['CM Bishop'], venue: 'Brain Imaging and Behavior', progress: 0, collectionIds: ['c2'], addedAt: new Date(2026, 7, 2).toISOString() }),
  ];
  const collections = [
    { id: 'c1', name: 'Reading list', color: '#000', createdAt: '' },
    { id: 'c2', name: 'Aphasia', color: '#111', createdAt: '' },
  ];
  const names = (groups) => groups.map((group) => `${group.name}:${group.items.map((item) => item.id).join('')}`);

  it('groups by reading status in the side pane’s order', () => {
    assert.deepEqual(names(groupPapers(papers, 'status', collections, now)), ['Reading now:a', 'Not started:c', 'Finished:b']);
  });

  it('puts a paper under each of its collections, and the rest last', () => {
    assert.deepEqual(names(groupPapers(papers, 'collection', collections, now)), ['Reading list:a', 'Aphasia:ac', 'In no collection:b']);
  });

  it('groups a journal however its name is cased, and papers with none last', () => {
    assert.deepEqual(names(groupPapers(papers, 'venue', collections, now)), ['Brain imaging and behavior:ac', 'No journal or conference:b']);
  });

  it('groups by year newest first, and by day added newest first', () => {
    assert.deepEqual(names(groupPapers(papers, 'year', collections, now)), ['2025:b', '2019:a', 'No year:c']);
    assert.deepEqual(names(groupPapers(papers, 'added', collections, now)), ['Today:a', 'This week:b', 'August:c']);
  });

  it('sorts by title, first author’s surname or progress', () => {
    assert.deepEqual(sortPapers(papers, 'title').map((item) => item.id), ['b', 'c', 'a']);
    assert.deepEqual(sortPapers(papers, 'author').map((item) => item.id), ['c', 'a', 'b']);
    assert.deepEqual(sortPapers(papers, 'progress').map((item) => item.id), ['b', 'a', 'c']);
  });

  it('remembers the choice, and falls back on anything it does not know', () => {
    const saved = (value, old) => ({ getItem: (key) => (key === 'reader.libraryView' ? value : key === 'reader.libraryLayout' ? old ?? null : null) });
    assert.deepEqual(readPrefs(saved(null)), DEFAULT_PREFS);
    assert.equal(readPrefs(saved(null, 'grid')).layout, 'grid');
    const read = readPrefs(saved(JSON.stringify({ layout: 'compact', group: 'nonsense', sort: 'year', show: ['authors', 'bogus'] })));
    assert.deepEqual(read, { layout: 'compact', group: 'added', sort: 'year', show: ['authors'] });
  });
});
