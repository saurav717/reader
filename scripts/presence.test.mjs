// Where someone is in a shared project (src/lib/presence.ts): the words for a
// place, which moves are told at once, who counts as here or away, the order
// the bar shows people in, a jump from a place and the view it opens, and a
// place carried in a link — read back from a project's address (src/lib/route.ts).
//
//   node --test scripts/presence.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const pr = await load('src/lib/presence.ts');
const route = await load('src/lib/route.ts');

after(cleanup);

const place = (more = {}) => ({ tab: 'code', active: true, at: 1000, ...more });

describe('a place in words', () => {
  it('names the tab, the file and the line on Code and Write', () => {
    assert.equal(pr.describePlace(place({ path: 'src/train.py', line: 42 })), 'Code · train.py · line 42');
    assert.equal(pr.describePlace(place({ tab: 'write', path: 'sections/related.tex' })), 'Write · related.tex');
    assert.equal(pr.shortPlace(place({ path: 'src/train.py', line: 42 })), 'train.py:42');
  });
  it('names the paper and page on Read, and the tab alone otherwise', () => {
    assert.equal(pr.describePlace(place({ tab: 'read', paperId: 'x', title: 'Switch Transformers', page: 6 })), 'Read · Switch Transformers · p. 6');
    assert.equal(pr.describePlace(place({ tab: 'overview' })), 'Overview');
    assert.equal(pr.describePlace(null), 'not here');
  });
});

describe('moves', () => {
  it('tells a new tab, file or paper at once, and coalesces the caret', () => {
    const here = place({ path: 'a.py', line: 1 });
    assert.equal(pr.bigMove(null, here), true);
    assert.equal(pr.bigMove(here, place({ path: 'a.py', line: 2 })), false);
    assert.equal(pr.bigMove(here, place({ path: 'b.py', line: 1 })), true);
    assert.equal(pr.bigMove(here, place({ tab: 'write', path: 'a.py', line: 1 })), true);
    assert.equal(pr.bigMove(here, place({ path: 'a.py', line: 1, active: false })), true);
  });
  it('knows the same place from a changed one', () => {
    assert.equal(pr.samePlace(place({ path: 'a', line: 1, sel: [1, 2] }), place({ path: 'a', line: 1, sel: [1, 2] })), true);
    assert.equal(pr.samePlace(place({ path: 'a', line: 1, sel: [1, 2] }), place({ path: 'a', line: 1, sel: [1, 3] })), false);
    assert.equal(pr.samePlace(null, place()), false);
  });
});

describe('here, away, gone', () => {
  const member = (more) => ({ email: 'p@x', role: 'editor', joinedAt: '2026-01-01', lastSeen: null, place: null, ...more });
  it('is by the place and its active flag', () => {
    assert.equal(pr.presenceOf(member({ place: place({ at: 1000 }) }), 2000), 'here');
    assert.equal(pr.presenceOf(member({ place: place({ at: 1000, active: false }) }), 2000), 'away');
    assert.equal(pr.presenceOf(member({ place: null })), 'gone');
  });
  it('orders here first, then away, then gone by when they were last here', () => {
    const list = [member({ email: 'gone-old', lastSeen: 10 }), member({ email: 'away', place: place({ active: false }) }), member({ email: 'gone-new', lastSeen: 20 }), member({ email: 'here', place: place() })];
    assert.deepEqual(pr.orderMembers(list, 5000).map((m) => m.email), ['here', 'away', 'gone-new', 'gone-old']);
  });
  it('makes initials for an avatar with no picture', () => {
    assert.equal(pr.initials('Priya Natarajan'), 'PN');
    assert.equal(pr.initials('marco'), 'MA');
    assert.equal(pr.initials('dana.k@ethz.ch'), 'DK');
    assert.equal(pr.initials(''), '?');
  });
});

describe('a jump', () => {
  it('carries what a place has, and opens the project on that tab', () => {
    const jump = pr.jumpFor('p1', place({ path: 'train.py', line: 42, col: 3, offset: 900, sel: [890, 900] }));
    assert.deepEqual(jump, { projectId: 'p1', tab: 'code', path: 'train.py', line: 42, col: 3, offset: 900, sel: [890, 900] });
    assert.deepEqual(pr.viewFor(jump), { kind: 'project', id: 'p1', mode: 'workspace' });
    assert.deepEqual(pr.viewFor({ projectId: 'p1', tab: 'write' }), { kind: 'project', id: 'p1', mode: 'write' });
    assert.deepEqual(pr.viewFor({ projectId: 'p1', tab: 'read' }), { kind: 'project', id: 'p1', mode: 'read' });
    assert.deepEqual(pr.viewFor({ projectId: 'p1', tab: 'overview' }), { kind: 'project', id: 'p1' });
  });
  it('is a link: `at` on the project address, read back on that tab', () => {
    assert.equal(pr.atParam(place({ path: 'src/train.py', line: 42 })), 'src/train.py:42');
    assert.equal(pr.atParam(place({ tab: 'read', paperId: 'arxiv:1' })), 'paper:arxiv:1');
    assert.equal(pr.atParam(place({ tab: 'overview' })), null);
    assert.deepEqual(pr.atFrom('p1', 'code', 'src/train.py:42'), { projectId: 'p1', tab: 'code', path: 'src/train.py', line: 42 });
    assert.deepEqual(pr.atFrom('p1', 'write', 'main.tex'), { projectId: 'p1', tab: 'write', path: 'main.tex' });
    assert.deepEqual(pr.atFrom('p1', 'read', 'paper:arxiv:1'), { projectId: 'p1', tab: 'read', paperId: 'arxiv:1' });
    assert.equal(pr.atFrom('p1', 'code', ''), null);
  });
});

describe('the project address', () => {
  const ROOM = 'a'.repeat(32);
  it('reads a place and an invitation, and never writes them back', () => {
    const got = route.placeFor(`/project/?id=p1&view=workspace&at=${encodeURIComponent('src/train.py:42')}&room=${ROOM}&join=tok`, '/');
    assert.deepEqual(got, { view: { kind: 'project', id: 'p1', mode: 'workspace' }, at: 'src/train.py:42', join: { room: ROOM, token: 'tok' } });
    assert.deepEqual(route.placeFor(`/project/?id=p1&room=${ROOM}&as=Dana%40ethz.ch`, '/').join, { room: ROOM, token: null, as: 'dana@ethz.ch' });
    assert.equal(route.addressWith('/project/?id=p2', `?id=p1&room=${ROOM}&as=x%40y`), '/project/?id=p2');
    assert.deepEqual(route.placeFor('/project/?id=p1&room=nope', '/'), { view: { kind: 'project', id: 'p1' } });
    assert.equal(route.pathFor(got, '/'), '/project/?id=p1&view=workspace');
    assert.equal(route.addressWith('/project/?id=p2', `?id=p1&at=x&room=${ROOM}&join=t&code=keep`), '/project/?code=keep&id=p2');
  });
});

describe('when someone was last here', () => {
  it('says so in words', () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 0);
    assert.equal(pr.whenSeen(now - 20_000, now), 'just now');
    assert.equal(pr.whenSeen(now - 4 * 60_000, now), '4 min ago');
    assert.equal(pr.whenSeen(now - 3 * 3_600_000, now), '3 h ago');
    assert.match(pr.whenSeen(now - 30 * 3_600_000, now), /^yesterday \d\d:\d\d$/);
    assert.equal(pr.whenSeen(null), 'never');
  });
});
