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

describe('a project’s mark', () => {
  it('is two letters', () => {
    assert.equal(pj.initialsOf('Sparse-gated MoE'), 'SG');
    assert.equal(pj.initialsOf('diffusion'), 'DI');
    assert.equal(pj.initialsOf('  '), '?');
  });
});
