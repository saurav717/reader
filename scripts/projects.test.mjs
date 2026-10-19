// Projects: which collections are projects, a project record read back from
// Drive however it was written, papers in roles, what to carry on with, and
// what two projects share.
//
//   node --test scripts/projects.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const pj = await load('src/lib/projects.ts');

after(cleanup);

const collection = (id, project) => ({ id, name: `C ${id}`, color: '#000', createdAt: '2026-01-01T00:00:00.000Z', ...(project ? { project } : {}) });
const paper = (id, collectionIds, more = {}) => ({ id, source: 'arxiv', title: id, authors: [], abstract: '', published: '', categories: [], addedAt: '2026-02-01T00:00:00.000Z', collectionIds, tags: [], progress: 0, ...more });

describe('which collections are projects', () => {
  it('is the ones with a project record', () => {
    const list = [collection('a'), collection('b', pj.newProjectInfo('Why?')), collection('c', { question: 'x' })];
    assert.deepEqual(pj.projectsOf(list).map((p) => p.id), ['b', 'c']);
    assert.deepEqual(pj.plainCollections(list).map((c) => c.id), ['a']);
  });

  it('puts right a record that came back from Drive in another shape', () => {
    const info = pj.projectInfo(collection('x', { roles: { p1: 'core', p2: 'nonsense', p3: 7 }, todos: [{ id: 't', text: 'do it' }, { text: 'no id' }, null], playgroundId: '' }));
    assert.deepEqual(info.roles, { p1: 'core' });
    assert.deepEqual(info.todos, [{ id: 't', text: 'do it', done: false }]);
    assert.equal(info.question, '');
    assert.equal(info.startedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(info.playgroundId, undefined);
    assert.equal(pj.projectInfo(collection('y', 'not an object')), null);
  });
});

describe('a project’s papers', () => {
  const project = pj.projectsOf([collection('p', { ...pj.newProjectInfo('', new Date('2026-01-01')), roles: { a: 'core', b: 'baseline' } })])[0];
  const papers = [
    paper('a', ['p'], { lastOpenedAt: '2026-03-02T00:00:00.000Z', progress: 0.3 }),
    paper('b', ['p'], { progress: 1, lastOpenedAt: '2026-03-03T00:00:00.000Z' }),
    paper('c', ['p']),
    paper('d', ['q']),
  ];

  it('groups them by role, in order, the unsorted last', () => {
    assert.deepEqual(pj.byRole(project, papers).map((g) => [g.label, g.papers.map((p) => p.id)]), [['Core', ['a']], ['Baseline', ['b']], ['Unsorted', ['c']]]);
  });

  it('carries on with the one opened last that is not finished', () => {
    assert.equal(pj.continueWith(project, papers).id, 'a');
    assert.equal(pj.continueWith(project, papers.filter((p) => p.id !== 'a')).id, 'c');
  });

  it('says where each stands', () => {
    assert.deepEqual(papers.map(pj.readingState), ['reading', 'done', 'not started', 'not started']);
  });

  it('knows when the project was last worked on', () => {
    assert.equal(pj.lastActive(project, papers), '2026-03-03T00:00:00.000Z');
  });
});

describe('between projects', () => {
  it('counts the papers two projects share', () => {
    const projects = pj.projectsOf([collection('p', pj.newProjectInfo()), collection('q', pj.newProjectInfo()), collection('r', pj.newProjectInfo())]);
    const papers = [paper('a', ['p', 'q']), paper('b', ['p', 'q', 'r']), paper('c', ['r'])];
    assert.deepEqual(pj.sharedWith(projects[0], projects, papers).map((s) => [s.project.id, s.count]), [['q', 2], ['r', 1]]);
  });

  it('adds a paper to a project, or takes it out, once', () => {
    assert.deepEqual(pj.toggledIn(['a', 'p'], 'p', true), ['a', 'p']);
    assert.deepEqual(pj.toggledIn(['a'], 'p', true), ['a', 'p']);
    assert.deepEqual(pj.toggledIn(['a', 'p'], 'p', false), ['a']);
  });

  it('puts a paper in a role and out of it', () => {
    const info = pj.withRole(pj.newProjectInfo(), 'x', 'method');
    assert.equal(info.roles.x, 'method');
    assert.equal('x' in pj.withRole(info, 'x', null).roles, false);
  });
});

describe('a project’s meetings', () => {
  const tag = { title: 'Group meeting', taggedAt: '2026-10-13T10:00:00.000Z' };
  it('a tag goes on the record and comes off it, and the record is bare again without any', () => {
    const tagged = pj.withMeeting(pj.newProjectInfo(), 'cal:e1', tag);
    assert.deepEqual(tagged.meetings, { 'cal:e1': tag });
    assert.equal('meetings' in pj.withMeeting(tagged, 'cal:e1', null), false);
    assert.deepEqual(pj.withMeeting(tagged, 'cal:e2', tag).meetings, { 'cal:e1': tag, 'cal:e2': tag });
  });
  it('a meeting’s project is whichever holds its key, the meeting’s own over its series’', () => {
    const a = collection('a', { ...pj.newProjectInfo(), meetings: { 'cal:series': tag } });
    const b = collection('b', { ...pj.newProjectInfo(), meetings: { 'cal:series_20261013': tag } });
    const projects = pj.projectsOf([a, b]);
    assert.equal(pj.meetingProject(projects, ['cal:series_20261013', 'cal:series']).id, 'b');
    assert.equal(pj.meetingProject(projects, ['cal:series_20261020', 'cal:series']).id, 'a');
    assert.equal(pj.meetingProject(projects, ['cal:other']), undefined);
  });
  it('the tags survive a record read back from Drive, and a broken one is dropped', () => {
    const info = pj.projectInfo(collection('x', { meetings: { 'cal:e1': tag, 'cal:e2': { title: 'No date' }, 'cal:e3': { taggedAt: 'no title' }, 'cal:e4': 'nonsense' } }));
    assert.deepEqual(Object.keys(info.meetings), ['cal:e1', 'cal:e2']);
    assert.equal(info.meetings['cal:e2'].taggedAt, '2026-01-01T00:00:00.000Z');
    assert.equal('meetings' in pj.projectInfo(collection('y', { question: 'q' })), false);
  });
});

describe('a project’s mark', () => {
  it('is two letters', () => {
    assert.equal(pj.initialsOf('Sparse-gated MoE'), 'SG');
    assert.equal(pj.initialsOf('diffusion'), 'DI');
    assert.equal(pj.initialsOf('  '), '?');
  });
});

describe('a copy of a project', () => {
  it('takes the question, the roles and the to-dos with ids of their own, starts now, and leaves the rest behind', () => {
    const source = { ...collection('p', { ...pj.newProjectInfo('Why?', new Date('2026-01-01')), roles: { a: 'core' }, todos: [{ id: 't1', text: 'Read a', done: true }], playgroundId: 'pg', overleaf: { id: 'ov' }, codeRepo: { full: 'x/y' }, meetings: { m: { title: 'Sync', taggedAt: '2026-01-02' } }, shared: { room: 'r', owner: 'o@x', role: 'editor' } }), name: 'MoE', color: '#123' };
    const copy = pj.copyOf(source, ['MoE'], new Date('2026-10-14T12:00:00Z'), () => 'fresh');
    assert.deepEqual(copy, { name: 'MoE (copy)', color: '#123', project: { question: 'Why?', startedAt: '2026-10-14T12:00:00.000Z', roles: { a: 'core' }, todos: [{ id: 'fresh', text: 'Read a', done: true }] } });
    assert.notEqual(copy.project.roles, source.project.roles, 'its own record');
  });
  it('is named beside the copies there already are', () => {
    assert.equal(pj.copyName('MoE', ['MoE']), 'MoE (copy)');
    assert.equal(pj.copyName('MoE', ['MoE', 'moe (copy)']), 'MoE (copy 2)');
    assert.equal(pj.copyName('MoE', ['MoE', 'MoE (copy)', 'MoE (copy 2)']), 'MoE (copy 3)');
  });
});

describe('the room’s list, followed', () => {
  it('reads a paper from the list as a reference, with the source told by the entry or the id', () => {
    assert.deepEqual(pj.paperRefOf({ id: 'arxiv:2101.03961', title: 'Switch', role: 'core', source: 'arxiv', authors: ['A'], published: '2021-01-11', pdfUrl: 'https://arxiv.org/pdf/2101.03961' }), { id: 'arxiv:2101.03961', source: 'arxiv', title: 'Switch', authors: ['A'], abstract: '', published: '2021-01-11', categories: [], arxivId: '2101.03961', pdfUrl: 'https://arxiv.org/pdf/2101.03961' });
    assert.equal(pj.paperRefOf({ id: 'doi:10.1/x', title: '', role: null }).source, 'crossref');
    assert.equal(pj.paperRefOf({ id: 'doi:10.1/x', title: '', role: null }).title, 'doi:10.1/x');
    assert.equal(pj.paperRefOf({ id: 'arxiv:1', title: 'x', role: null, source: 'nope' }).source, 'arxiv');
  });
  it('says what to add, what to put in the project, and what to take out of it', () => {
    const list = [{ id: 'a', title: 'A', role: 'core' }, { id: 'b', title: 'B', role: null }, { id: 'c', title: 'C', role: null }];
    const library = [paper('a', ['p']), paper('b', ['other']), paper('d', ['p', 'other'])];
    const { add, include, drop } = pj.followPapers(list, library, 'p');
    assert.deepEqual(add.map((ref) => ref.id), ['c']);
    assert.deepEqual(include, ['b']);
    assert.deepEqual(drop, ['d']);
  });
  it('knows the same list however its papers are ordered, and a different one', () => {
    const list = { id: 'p', name: 'N', color: '#000', question: 'Q', startedAt: '2026', papers: [{ id: 'a', title: 'A', role: 'core' }, { id: 'b', title: 'B', role: null }], todos: [{ id: 't', text: 'x', done: false }] };
    assert.equal(pj.sameList(list, { ...list, papers: [{ id: 'b', title: 'B elsewhere', role: null, source: 'arxiv' }, { id: 'a', title: 'A', role: 'core' }] }), true, 'titles and order are not the list');
    assert.equal(pj.sameList(list, { ...list, papers: [{ id: 'a', title: 'A', role: 'baseline' }, { id: 'b', title: 'B', role: null }] }), false, 'a role is');
    assert.equal(pj.sameList(list, { ...list, todos: [{ id: 't', text: 'x', done: true }] }), false);
    assert.equal(pj.sameList(list, { ...list, overleaf: { id: 'o' } }), false);
  });
});

describe('a project for a paper’s implementation', () => {
  it('is named after the paper’s head, cut at a word, numbered beside one already so named, and opens on a question', () => {
    assert.equal(pj.projectNameFor('Dreamer: Learning Behaviors by Latent Imagination', []), 'Dreamer — implementation');
    assert.equal(pj.projectNameFor('Dreamer: Learning', ['dreamer — implementation']), 'Dreamer — implementation (2)');
    assert.equal(pj.projectNameFor('Dreamer: Learning', ['Dreamer — implementation', 'Dreamer — implementation (2)']), 'Dreamer — implementation (3)');
    const long = pj.projectNameFor('A very long title that goes on and on about world models and their uses in control', []);
    assert.equal(long, 'A very long title that goes on and on about world models… — implementation');
    assert.match(pj.projectQuestionFor('Dreamer'), /^Reimplement “Dreamer”: /);
  });
});
