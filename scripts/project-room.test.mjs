// A project shared with the people you work with (worker/projectRoom.js, and
// the /rooms routes in worker/index.js): that sharing makes a room with the
// owner in it; that only an invited address, or anyone with the link when it
// is on, joins; that each member's place is fanned out to the others and
// kept as "last seen" when their socket closes; that the owner alone sets
// roles and the link, and a member may leave; and that a pass is needed
// for all of it. Cloudflare's storage and sockets are stand-ins here.
//
//   node --test scripts/project-room.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ProjectRoom, cleanPlace, projectSummary, PALETTE } = await import('../worker/projectRoom.js');
const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function memoryStorage() {
  const map = new Map();
  return {
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix))),
  };
}

/** A socket as the hibernation API hands it back: its attachment, what it was sent, whether it was closed. */
function fakeSocket(email) {
  const socket = { sent: [], closed: null, attachment: { email } };
  socket.serializeAttachment = (value) => (socket.attachment = value);
  socket.deserializeAttachment = () => socket.attachment;
  socket.send = (data) => socket.sent.push(JSON.parse(data));
  socket.close = (code, reason) => (socket.closed = { code, reason });
  return socket;
}

function roomsBinding() {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) {
        const sockets = [];
        const state = { storage: memoryStorage(), sockets, acceptWebSocket: (socket) => sockets.push(socket), getWebSockets: () => sockets };
        objects.set(name, new ProjectRoom(state, {}));
      }
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)), object };
    },
  };
}

const SECRET = 'owner-token';
const env = () => ({ READER_TOKEN: SECRET, ROOMS: roomsBinding() });
const call = (e, path, { pass, body, method, origin } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil() {} },
  );

const project = { id: 'proj-1', name: 'Sparse-gated MoE', color: '#1f5e52', question: 'Why?', startedAt: '2026-01-01T00:00:00.000Z', papers: [{ id: 'arxiv:1', title: 'Switch', role: 'core' }], todos: [{ id: 't1', text: 'write', done: false }] };

describe('sharing a project', () => {
  it('makes a room with the owner in it, named by an id the owner keeps', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const made = await (await call(e, '/rooms', { pass: owner, body: { project, name: 'Owner One' } })).json();
    assert.match(made.room, /^[0-9a-f]{32}$/);
    assert.equal(made.owner, 'owner@x.org');
    assert.equal(made.role, 'owner');
    assert.deepEqual(made.members.map((m) => [m.email, m.role, m.color, m.name]), [['owner@x.org', 'owner', PALETTE[0], 'Owner One']]);
    assert.equal(made.project.name, 'Sparse-gated MoE');
    assert.deepEqual(made.invitations, []);
    assert.equal(made.link.on, false);
    // Shared again (the owner's page keeps the room's copy current): the same room, the project as sent.
    const again = await (await call(e, '/rooms', { pass: owner, body: { project: { ...project, question: 'How?' }, room: made.room } })).json();
    assert.equal(again.room, made.room);
    assert.equal(again.project.question, 'How?');
    assert.equal((await call(e, '/rooms', { body: { project } })).status, 401);
    assert.equal((await call(e, '/rooms', { pass: owner, method: 'GET' })).status, 405);
  });

  it('lets an invited address join, with the next colour, and nobody else', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('Priya@IITH.ac.in', SECRET);
    const marco = await issuePass('marco@y.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: priya, body: {} })).status, 403);
    const invited = await (await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'priya@iith.ac.in', role: 'viewer' } })).json();
    assert.deepEqual(invited.invitations.map((i) => [i.email, i.role]), [['priya@iith.ac.in', 'viewer']]);
    const joined = await (await call(e, `/rooms/${room}/join`, { pass: priya, body: { name: 'Priya N' } })).json();
    assert.equal(joined.me, 'priya@iith.ac.in');
    assert.equal(joined.role, 'viewer');
    assert.deepEqual(joined.members.map((m) => [m.email, m.color]), [['owner@x.org', PALETTE[0]], ['priya@iith.ac.in', PALETTE[1]]]);
    // A viewer sees the members, not the invitations or the link.
    assert.equal(joined.invitations, undefined);
    assert.equal(joined.link, undefined);
    // The invitation is spent; a stranger is still refused; a member is told the state.
    assert.deepEqual((await (await call(e, `/rooms/${room}`, { pass: owner })).json()).invitations, []);
    assert.equal((await call(e, `/rooms/${room}`, { pass: marco })).status, 403);
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: marco, body: { token: 'nope' } })).status, 403);
  });

  it('mails an invitation when the site can, to the address, with the page’s own link', async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    };
    try {
      const e = { ...env(), MAIL_API_KEY: 're_test', MAIL_FROM: 'Reader <noreply@reader.example>' };
      const owner = await issuePass('owner@x.org', SECRET);
      const { room } = await (await call(e, '/rooms', { pass: owner, body: { project, name: 'Owner One' } })).json();
      const link = `https://saurav717.github.io/reader/project/?id=proj-1&room=${room}`;
      const invited = await (await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'Dana@ethz.ch', role: 'viewer', link } })).json();
      assert.equal(invited.mailed, true);
      assert.deepEqual(invited.invitations.map((i) => i.email), ['dana@ethz.ch']);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, 'https://api.resend.com/emails');
      assert.deepEqual(sent[0].body.to, ['dana@ethz.ch']);
      assert.equal(sent[0].body.reply_to, 'owner@x.org');
      assert.equal(sent[0].body.subject, 'Owner One invited you to “Sparse-gated MoE” on Reader');
      const tag = await (await import('../server/mail.js')).addressTag('dana@ethz.ch');
      assert.match(tag, /^[0-9a-f]{12}$/);
      assert.match(sent[0].body.text, new RegExp(`${link.replace(/[.?+]/g, '\\$&')}&for=${tag}`), 'the link carries a tag of the address, not the address');
      assert.doesNotMatch(sent[0].body.text, /as=dana/);
      assert.equal(invited.invitations[0].tag, tag, 'the invitation keeps the tag, for the share dialog’s copied link');
      assert.match(sent[0].body.text, /As a viewer you can see the project, and where everyone/);
      // A link that is not this app's is never mailed: the invitation stands, the mail does not go.
      const elsewhere = await (await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'lin@x.org', role: 'editor', link: 'https://evil.example/x' } })).json();
      assert.equal(elsewhere.mailed, false);
      assert.equal(sent.length, 1);
      // Without mail set up, the same answer says so and sends nothing.
      const unsent = await (await call({ ...env(), ROOMS: e.ROOMS }, `/rooms/${room}/invite`, { pass: owner, body: { email: 'marco@x.org', role: 'editor', link } })).json();
      assert.equal(unsent.mailed, false);
      assert.equal(sent.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('lets anyone with the link join while it is on, within its domain', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const { room, link } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    const marco = await issuePass('marco@y.org', SECRET);
    const lin = await issuePass('lin@iith.ac.in', SECRET);
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: marco, body: { token: link.token } })).status, 403);
    const on = await (await call(e, `/rooms/${room}/link`, { pass: owner, body: { on: true, domain: '@iith.ac.in' } })).json();
    assert.equal(on.link.domain, 'iith.ac.in');
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: marco, body: { token: link.token } })).status, 403);
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: lin, body: { token: link.token } })).status, 200);
    // A new link: the old one stops working.
    const renewed = await (await call(e, `/rooms/${room}/link`, { pass: owner, body: { on: true, renew: true } })).json();
    assert.notEqual(renewed.link.token, link.token);
    const dana = await issuePass('dana@iith.ac.in', SECRET);
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: dana, body: { token: link.token } })).status, 403);
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: dana, body: { token: renewed.link.token } })).status, 200);
    // Only the owner sets the link or a role.
    assert.equal((await call(e, `/rooms/${room}/link`, { pass: lin, body: { on: false } })).status, 403);
    assert.equal((await call(e, `/rooms/${room}/role`, { pass: lin, body: { email: 'dana@iith.ac.in', role: 'viewer' } })).status, 403);
    const roled = await (await call(e, `/rooms/${room}/role`, { pass: owner, body: { email: 'dana@iith.ac.in', role: 'viewer' } })).json();
    assert.equal(roled.members.find((m) => m.email === 'dana@iith.ac.in').role, 'viewer');
  });

  it('keeps the project as the owner or an editor sends it, for every member', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('priya@x.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'priya@x.org' } });
    await call(e, `/rooms/${room}/join`, { pass: priya, body: {} });
    const changed = await (await call(e, `/rooms/${room}/project`, { pass: priya, body: { project: { ...project, id: 'other', todos: [] } } })).json();
    assert.equal(changed.project.id, 'proj-1', 'the id is the room’s to keep');
    assert.deepEqual(changed.project.todos, []);
    assert.deepEqual((await (await call(e, `/rooms/${room}`, { pass: owner })).json()).project.todos, []);
  });

  it('lets a member leave and the owner remove one, never the owner', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('priya@x.org', SECRET);
    const marco = await issuePass('marco@x.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    for (const who of ['priya@x.org', 'marco@x.org']) await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: who } });
    await call(e, `/rooms/${room}/join`, { pass: priya, body: {} });
    await call(e, `/rooms/${room}/join`, { pass: marco, body: {} });
    assert.equal((await call(e, `/rooms/${room}/remove`, { pass: priya, body: { email: 'marco@x.org' } })).status, 403);
    assert.equal((await call(e, `/rooms/${room}/remove`, { pass: owner, body: { email: 'owner@x.org' } })).status, 400);
    assert.equal((await call(e, `/rooms/${room}/leave`, { pass: priya, body: {} })).status, 200);
    const after = await (await call(e, `/rooms/${room}/remove`, { pass: owner, body: { email: 'marco@x.org' } })).json();
    assert.deepEqual(after.members.map((m) => m.email), ['owner@x.org']);
    assert.equal((await call(e, `/rooms/${room}`, { pass: priya })).status, 403);
  });

  it('wants a WebSocket upgrade from this app for the live socket', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    assert.equal((await call(e, `/rooms/${room}/live`, { pass: owner })).status, 403);
    assert.equal((await call(e, `/rooms/${room}/live`, { pass: owner, origin: 'http://localhost:5173' })).status, 426);
    // The pass may ride as a subprotocol, since a browser's WebSocket sends no headers of its own.
    const asSub = await worker.fetch(new Request(`https://proxy.example/rooms/${room}/live`, { headers: { Origin: 'http://localhost:5173', 'Sec-WebSocket-Protocol': `reader-pass, ${owner}` } }), e, { waitUntil() {} });
    assert.equal(asSub.status, 426);
    const noPass = await worker.fetch(new Request(`https://proxy.example/rooms/${room}/live`, { headers: { Origin: 'http://localhost:5173' } }), e, { waitUntil() {} });
    assert.equal(noPass.status, 401);
  });
});

describe('inviting someone to try Reader', () => {
  const withMail = () => ({ ...env(), MAIL_API_KEY: 're_test', MAIL_FROM: 'Reader <noreply@reader.example>' });
  const stub = () => {
    const sent = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => (sent.push({ url: String(url), body: JSON.parse(init.body) }), new Response('{}', { status: 200 }));
    return { sent, restore: () => (globalThis.fetch = real) };
  };

  it('mails the site, with the note and the sender as reply-to, only to a link of this app', async () => {
    const { sent, restore } = stub();
    try {
      const e = withMail();
      const pass = await issuePass('owner@x.org', SECRET);
      const ok = await (await call(e, '/invite', { pass, body: { email: 'Colleague@Uni.edu', name: 'Owner One', note: 'Have a look?', link: 'https://saurav717.github.io/reader/' } })).json();
      assert.deepEqual(ok, { ok: true, to: 'colleague@uni.edu' });
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].body.to, ['colleague@uni.edu']);
      assert.equal(sent[0].body.reply_to, 'owner@x.org');
      assert.equal(sent[0].body.subject, "Owner One thinks you'd like Reader");
      assert.match(sent[0].body.text, /Have a look\?/);
      assert.equal((await call(e, '/invite', { pass, body: { email: 'c@uni.edu', link: 'https://evil.example/' } })).status, 400);
      assert.equal((await call(e, '/invite', { pass, body: { email: 'not-an-address', link: 'https://saurav717.github.io/reader/' } })).status, 400);
      assert.equal((await call(e, '/invite', { body: { email: 'c@uni.edu', link: 'https://saurav717.github.io/reader/' } })).status, 401);
      assert.equal(sent.length, 1);
    } finally {
      restore();
    }
  });

  it('says so when the site cannot send mail, or when the address could not sign in here', async () => {
    const { sent, restore } = stub();
    try {
      const pass = await issuePass('owner@x.org', SECRET);
      const none = await call(env(), '/invite', { pass, body: { email: 'c@uni.edu', link: 'https://saurav717.github.io/reader/' } });
      assert.equal(none.status, 501);
      const limited = await call({ ...withMail(), READER_EMAILS: '@x.org' }, '/invite', { pass, body: { email: 'c@uni.edu', link: 'https://saurav717.github.io/reader/' } });
      assert.equal(limited.status, 403);
      assert.match((await limited.json()).error, /READER_EMAILS/);
      assert.equal(sent.length, 0);
    } finally {
      restore();
    }
  });
});

describe('where everyone is', () => {
  const setUp = async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('priya@x.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'priya@x.org' } });
    await call(e, `/rooms/${room}/join`, { pass: priya, body: {} });
    const { object } = e.ROOMS.get(`room:${room}`);
    const sockets = { owner: fakeSocket('owner@x.org'), priya: fakeSocket('priya@x.org') };
    object.state.acceptWebSocket(sockets.owner);
    object.state.acceptWebSocket(sockets.priya);
    /** A socket closing, as the platform has it: off the list by the time the object hears of it. */
    const close = (socket) => (object.state.sockets.splice(object.state.sockets.indexOf(socket), 1), object.webSocketClose(socket));
    return { e, room, owner, priya, object, sockets, close };
  };

  it('fans a place out to the others, cleaned, and lists it in the state', async () => {
    const { e, room, owner, object, sockets } = await setUp();
    await object.webSocketMessage(sockets.priya, JSON.stringify({ type: 'place', place: { tab: 'code', path: 'train.py', line: 42.9, col: 3, offset: 900, sel: [890, 900], junk: 'x', active: true } }));
    assert.equal(sockets.priya.sent.length, 0, 'not back to the sender');
    assert.equal(sockets.owner.sent.length, 1);
    const { type, who, place } = sockets.owner.sent[0];
    assert.equal(type, 'place');
    assert.equal(who, 'priya@x.org');
    assert.deepEqual({ ...place, at: 0 }, { tab: 'code', path: 'train.py', line: 42, col: 3, offset: 900, sel: [890, 900], active: true, at: 0 });
    const state = await (await call(e, `/rooms/${room}`, { pass: owner })).json();
    assert.equal(state.members.find((m) => m.email === 'priya@x.org').place.path, 'train.py');
    assert.equal(state.members.find((m) => m.email === 'owner@x.org').place, null);
  });

  it('takes a member’s name and picture from their hello', async () => {
    const { e, room, owner, object, sockets } = await setUp();
    await object.webSocketMessage(sockets.priya, JSON.stringify({ type: 'hello', name: 'Priya Natarajan', picture: 'https://p/x.png' }));
    assert.deepEqual(sockets.owner.sent, [{ type: 'members' }]);
    const state = await (await call(e, `/rooms/${room}`, { pass: owner })).json();
    assert.deepEqual(state.members.find((m) => m.email === 'priya@x.org').name, 'Priya Natarajan');
  });

  it('drops a place when the last socket closes, keeping when and where for "earlier"', async () => {
    const { e, room, owner, object, sockets, close } = await setUp();
    await object.webSocketMessage(sockets.priya, JSON.stringify({ type: 'place', place: { tab: 'write', path: 'main.tex', line: 3 } }));
    const second = fakeSocket('priya@x.org');
    object.state.acceptWebSocket(second);
    await close(second);
    assert.equal(sockets.owner.sent.filter((m) => m.type === 'left').length, 0, 'another tab of theirs is still open');
    await close(sockets.priya);
    assert.deepEqual(sockets.owner.sent.at(-1), { type: 'left', who: 'priya@x.org' });
    const state = await (await call(e, `/rooms/${room}`, { pass: owner })).json();
    const priya = state.members.find((m) => m.email === 'priya@x.org');
    assert.equal(priya.place, null);
    assert.ok(priya.lastSeen > 0);
    assert.equal(priya.lastPlace.path, 'main.tex');
  });

  it('closes a removed member’s sockets and tells the rest', async () => {
    const { e, room, owner, object, sockets } = await setUp();
    await call(e, `/rooms/${room}/remove`, { pass: owner, body: { email: 'priya@x.org' } });
    assert.deepEqual(sockets.priya.closed, { code: 1000, reason: 'removed from the project' });
    assert.deepEqual(sockets.owner.sent.at(-1), { type: 'left', who: 'priya@x.org', gone: true });
    assert.equal(object.places.has('priya@x.org'), false);
  });
});

describe('what the room keeps of a project and a place', () => {
  it('is a summary with a shape of its own', () => {
    const summary = projectSummary({ id: 'p', name: 'N', color: 'red', papers: [{ id: 'a', title: 'T', role: 'core' }, { id: 'b', role: 'nope' }, { nope: 1 }], todos: [{ id: 't', text: 'x', done: 1 }], extra: true });
    assert.deepEqual(summary, { id: 'p', name: 'N', color: '#1f5e52', question: '', startedAt: '', papers: [{ id: 'a', title: 'T', role: 'core' }, { id: 'b', title: '', role: null }], todos: [{ id: 't', text: 'x', done: true }] });
    assert.equal(projectSummary(null), null);
  });
  it('takes only what a place is', () => {
    assert.deepEqual(cleanPlace({ tab: 'nope', line: -1, sel: [1], page: 2, title: 'T', paperId: 'x' }, 5), { tab: 'overview', active: true, at: 5, paperId: 'x', title: 'T', page: 2 });
    assert.equal(cleanPlace('x'), null);
  });
});
