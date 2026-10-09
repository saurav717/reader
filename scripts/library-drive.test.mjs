// The library as one file in the account's own Drive: what is written, what
// is read back, how two copies are put together, and how a library is rebuilt
// from the paper folders an account saved before the file existed.
//
//   node --test scripts/library-drive.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadTogether } from './bundle.mjs';

const { parseLibrary, mergeLibraries, serialise, fromSidecar, libraryFromSidecars, sidecar, emptyLibrary } = await loadTogether([
  'src/lib/driveLibrary.ts',
  'src/lib/sidecar.ts',
]);

after(cleanup);

const paper = (id, overrides = {}) => ({
  id,
  source: 'arxiv',
  title: `Paper ${id}`,
  authors: ['A. Author'],
  abstract: '',
  published: '2020-01-01',
  categories: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  collectionIds: [],
  tags: [],
  progress: 0,
  ...overrides,
});

const highlight = (id, paperId, overrides = {}) => ({
  id,
  paperId,
  color: 'green',
  exact: 'the quoted words',
  prefix: 'before ',
  suffix: ' after',
  hint: 42,
  tags: [],
  createdAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

describe('the file in Drive', () => {
  it('reads back what was written', () => {
    const library = {
      papers: [paper('arxiv:1', { collectionIds: ['c1'], progress: 0.4 })],
      collections: [{ id: 'c1', name: 'Operators', color: '#1F5E52', createdAt: '2026-01-01T00:00:00.000Z' }],
      highlights: [highlight('h1', 'arxiv:1')],
      junk: [],
    };
    const text = JSON.stringify({ generator: 'reader', version: 1, updatedAt: 'x', ...library });
    assert.deepEqual(parseLibrary(text), library);
  });

  it('refuses something that is not a library rather than emptying the one open', () => {
    assert.equal(parseLibrary('not json'), null);
    assert.equal(parseLibrary('{"hello": 1}'), null);
  });

  it('drops records it cannot use and fills in missing lists', () => {
    const parsed = parseLibrary(JSON.stringify({ papers: [{ id: 'arxiv:1', title: 'T' }, { title: 'no id' }], highlights: [{}] }));
    assert.equal(parsed.papers.length, 1);
    assert.deepEqual(parsed.papers[0].collectionIds, []);
    assert.deepEqual(parsed.highlights, []);
    assert.deepEqual(parsed.collections, []);
  });

  it('serialises the same library the same way whatever order it is in', () => {
    const a = { ...emptyLibrary(), papers: [paper('arxiv:1'), paper('arxiv:2')] };
    const b = { ...emptyLibrary(), papers: [paper('arxiv:2'), paper('arxiv:1')] };
    assert.equal(serialise(a), serialise(b));
  });
});

describe('putting two copies together', () => {
  it('keeps the first copy where both have the same paper, and adds what only the second has', () => {
    const base = { ...emptyLibrary(), papers: [paper('arxiv:1', { progress: 0.9 })] };
    const extra = { ...emptyLibrary(), papers: [paper('arxiv:1', { progress: 0.1 }), paper('arxiv:2')] };
    const merged = mergeLibraries(base, extra);
    assert.deepEqual(merged.papers.map((item) => [item.id, item.progress]), [['arxiv:1', 0.9], ['arxiv:2', 0]]);
  });

  it('treats a collection of the same name as the same collection', () => {
    const base = { ...emptyLibrary(), collections: [{ id: 'mine', name: 'Reading list', color: '#000', createdAt: '' }] };
    const extra = {
      ...emptyLibrary(),
      collections: [{ id: 'theirs', name: 'reading list', color: '#fff', createdAt: '' }],
      papers: [paper('arxiv:3', { collectionIds: ['theirs'] })],
    };
    const merged = mergeLibraries(base, extra);
    assert.equal(merged.collections.length, 1);
    assert.deepEqual(merged.papers[0].collectionIds, ['mine']);
  });

  it('does not keep a paper in Junk that is in the library', () => {
    const base = { ...emptyLibrary(), papers: [paper('arxiv:1')] };
    const extra = { ...emptyLibrary(), junk: [{ paper: paper('arxiv:1'), highlights: [], removedAt: '', drive: 'kept' }] };
    assert.equal(mergeLibraries(base, extra).junk.length, 0);
  });
});

describe('a library rebuilt from the sidecars in Drive', () => {
  it('gives back the paper, its highlights and the names of its collections', () => {
    const original = paper('arxiv:2010.08895', { arxivId: '2010.08895', tags: ['pde'] });
    const notes = [highlight('h1', original.id, { note: 'why', style: 'underline', section: 'Intro' })];
    const written = sidecar(original, notes, ['Operators', 'To read']);
    const read = fromSidecar(JSON.parse(JSON.stringify(written)), { folderId: 'folder-1', metaFileId: 'meta-1', folderName: 'P' });

    assert.equal(read.paper.id, original.id);
    assert.equal(read.paper.title, original.title);
    assert.deepEqual(read.paper.tags, ['pde']);
    assert.equal(read.paper.drive.folderId, 'folder-1');
    assert.equal(read.paper.drive.metaFileId, 'meta-1');
    assert.deepEqual(read.collectionNames, ['Operators', 'To read']);
    const [mark] = read.highlights;
    assert.equal(mark.id, 'h1');
    assert.equal(mark.paperId, original.id);
    assert.equal(mark.color, 'green');
    assert.equal(mark.style, 'underline');
    assert.equal(mark.exact, 'the quoted words');
    assert.equal(mark.prefix, 'before ');
    assert.equal(mark.hint, 42);
    assert.equal(mark.note, 'why');
  });

  it('skips a sidecar with no paper in it', () => {
    assert.equal(fromSidecar({}, { folderId: 'f', metaFileId: 'm' }), null);
  });

  it('makes one collection per name, shared by the papers that name it', () => {
    let next = 0;
    const read = ['a', 'b'].map((id) => ({ paper: paper(id), highlights: [], collectionNames: ['Operators'] }));
    const library = libraryFromSidecars(read, () => `c${next++}`);
    assert.equal(library.collections.length, 1);
    assert.deepEqual(library.papers.map((item) => item.collectionIds), [['c0'], ['c0']]);
  });
});
