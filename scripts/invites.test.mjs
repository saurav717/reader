// The invitations ledger (worker/invites.js, and its routes in worker/index.js):
// a project invitation waits in the invitee's inbox and is taken up by their
// joining; a mailed one by their signing in; a personal link says its
// inviter's name and note to anyone, counts who signed in from it, and runs
// out; and the owner's report tallies all of it by inviter. Storage and the
// mail provider are stood in for.
//
//   node --test scripts/invites.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { Invites, report, linkToken } = await import('../worker/invites.js');
const { ProjectRoom } = await import('../worker/projectRoom.js');
const { default: worker } = await import('../worker/index.js');
const { issuePass } = await import('../server/passes.js');

function memoryStorage() {
  const map = new Map();
  return {
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([key]) => key.startsWith(prefix)).sort()),
  };
}
const binding = (Class) => {
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get: (name) => {
      if (!objects.has(name)) {
        const sockets = [];
        objects.set(name, new Class({ storage: memoryStorage(), sockets, acceptWebSocket: (s) => sockets.push(s), getWebSockets: () => sockets }, {}));
      }
      const object = objects.get(name);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
};

const SECRET = 'owner-token';
const SITE = 'https://koios.dev/reader/';
const env = (more = {}) => ({ READER_TOKEN: SECRET, READER_OWNERS: 'owner@x.org', ROOMS: binding(ProjectRoom), INVITES: binding(Invites), ...more });
const call = (e, path, { pass, body, method, origin } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { ...(pass ? { Authorization: `Bearer ${pass}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
    { waitUntil(promise) { return promise; } },
  );
const project = { id: 'proj-1', name: 'Sparse-gated MoE', color: '#1f5e52', question: 'Why?', startedAt: '2026-01-01T00:00:00.000Z', papers: [], todos: [] };

describe('a project invitation', () => {
  it('waits in the inbox, is taken up by joining, and counts for the inviter', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('priya@x.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project, name: 'Owner One' } })).json();
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'Priya@x.org', role: 'viewer' } });
    const inbox = (await (await call(e, '/invites/inbox', { pass: priya })).json()).invitations;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].room, room);
    assert.equal(inbox[0].project, 'Sparse-gated MoE');
    assert.equal(inbox[0].byName, 'Owner One');
    assert.equal(inbox[0].role, 'viewer');
    // Invited again: still the one invitation.
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'priya@x.org', role: 'editor' } });
    assert.equal((await (await call(e, '/invites/inbox', { pass: priya })).json()).invitations.length, 1);
    // Joined: gone from the inbox, counted as taken.
    assert.equal((await call(e, `/rooms/${room}/join`, { pass: priya, body: { name: 'Priya N' } })).status, 200);
    assert.equal((await (await call(e, '/invites/inbox', { pass: priya })).json()).invitations.length, 0);
    const tally = await (await call(e, '/usage/invites', { pass: owner })).json();
    assert.equal(tally.totals.sent, 1);
    assert.equal(tally.totals.converted, 1);
    assert.equal(tally.people[0].email, 'owner@x.org');
    assert.deepEqual(tally.people[0].sent, { project: 1, mail: 0, link: 0 });
    assert.deepEqual(tally.people[0].converted, { project: 1, mail: 0, link: 0 });
    assert.equal(tally.people[0].people[0].email, 'priya@x.org');
    assert.equal(tally.people[0].people[0].name, 'Priya N');
    assert.equal(tally.people[0].people[0].how, 'project');
    assert.equal(tally.people[0].people[0].project, 'Sparse-gated MoE');
  });

  it('is taken back by withdrawing it, and the report is the owner’s alone', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('priya@x.org', SECRET);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'priya@x.org' } });
    await call(e, `/rooms/${room}/uninvite`, { pass: owner, body: { email: 'priya@x.org' } });
    assert.equal((await (await call(e, '/invites/inbox', { pass: priya })).json()).invitations.length, 0);
    const tally = await (await call(e, '/usage/invites', { pass: owner })).json();
    assert.equal(tally.totals.sent, 0, 'a withdrawn invitation is not counted');
    assert.equal((await call(e, '/usage/invites', { pass: priya })).status, 401);
  });
});

describe('an invitation by mail', () => {
  it('is taken up by the address signing in', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
      const e = env({ MAIL_API_KEY: 're_test', MAIL_FROM: 'Reader <noreply@reader.example>', GOOGLE_CLIENT_ID: 'cid' });
      const owner = await issuePass('owner@x.org', SECRET);
      assert.equal((await call(e, '/invite', { pass: owner, body: { email: 'dana@uni.edu', name: 'Owner One', link: SITE } })).status, 200);
      let tally = await (await call(e, '/usage/invites', { pass: owner })).json();
      assert.deepEqual(tally.people[0].sent, { project: 0, mail: 1, link: 0 });
      assert.equal(tally.totals.converted, 0);
      // The sign-in: the ledger is told straight, as the Worker's /auth/google does.
      const ledger = e.INVITES.get('invites');
      assert.deepEqual(await (await ledger.fetch('https://invites/converted', { method: 'POST', body: JSON.stringify({ email: 'Dana@uni.edu', name: 'Dana K', how: 'signin' }) })).json(), { converted: 1 });
      tally = await (await call(e, '/usage/invites', { pass: owner })).json();
      assert.deepEqual(tally.people[0].converted, { project: 0, mail: 1, link: 0 });
      assert.equal(tally.people[0].people[0].how, 'mail');
      assert.equal(tally.people[0].people[0].name, 'Dana K');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('the site’s mail log', () => {
  it('keeps each send, taken or refused, for the owner’s Email tab — and a test mail', async () => {
    const real = globalThis.fetch;
    let refuse = false;
    globalThis.fetch = async () => (refuse ? new Response('daily limit reached', { status: 402 }) : new Response('{}', { status: 200 }));
    try {
      const e = env({ MAIL_API_KEY: 're_test', MAIL_FROM: 'Reader <noreply@reader.example>' });
      const owner = await issuePass('owner@x.org', SECRET);
      const priya = await issuePass('priya@x.org', SECRET);
      assert.equal((await call(e, '/invite', { pass: owner, body: { email: 'dana@uni.edu', link: SITE } })).status, 200);
      refuse = true;
      assert.equal((await call(e, '/invite', { pass: owner, body: { email: 'eli@uni.edu', link: SITE } })).status, 502);
      refuse = false;
      assert.equal((await call(e, '/usage/mail/test', { pass: owner, body: {} })).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const overview = await (await call(e, '/usage/mail', { pass: owner })).json();
      assert.equal(overview.provider, 'resend');
      assert.deepEqual(overview.log.today, { sent: 2, failed: 1 });
      assert.equal(overview.used.today, 2);
      assert.deepEqual(overview.log.recent.map((entry) => [entry.kind, entry.to, entry.ok]).sort(), [['test', 'owner@x.org', true], ['try', 'dana@uni.edu', true], ['try', 'eli@uni.edu', false]]);
      assert.match(overview.log.lastFailure.error, /402: daily limit reached/);
      assert.equal((await call(e, '/usage/mail', { pass: priya })).status, 401, 'the owner’s alone');
      assert.equal((await call(e, '/usage/mail/test', { pass: priya, body: {} })).status, 401);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a personal link', () => {
  it('says its inviter’s name and note to anyone, counts who signed in from it, and is only to this site', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const lin = await issuePass('lin@uni.edu', SECRET);
    assert.equal((await call(e, '/invites/link', { pass: owner, body: { link: 'https://evil.example/', name: 'Owner One', note: 'x' } })).status, 400);
    assert.equal((await call(e, '/invites/link', { body: { link: SITE } })).status, 401);
    const made = await (await call(e, '/invites/link', { pass: owner, body: { link: SITE, name: 'Owner One', note: 'Have a look before Thursday?' } })).json();
    assert.match(made.token, /^[a-z0-9]{10}$/);
    assert.equal(made.url, `${SITE}?invite=${made.token}`);
    assert.ok(made.expiresAt > Date.now());
    // What it says, to anyone: a name and a note, nothing else.
    const said = await (await call(e, `/invites/link/${made.token}?open=1`)).json();
    assert.deepEqual(Object.keys(said).sort(), ['byName', 'expired', 'expiresAt', 'note']);
    assert.equal(said.byName, 'Owner One');
    assert.equal(said.note, 'Have a look before Thursday?');
    assert.equal((await call(e, '/invites/link/nosuchlink1')).status, 404);
    // Signed in from it: once per person, and the inviter's own sign-in is not a conversion.
    assert.equal((await call(e, `/invites/link/${made.token}/joined`, { pass: lin, body: { name: 'Lin Z' } })).status, 200);
    assert.equal((await call(e, `/invites/link/${made.token}/joined`, { pass: lin, body: { name: 'Lin Z' } })).status, 200);
    assert.deepEqual(await (await call(e, `/invites/link/${made.token}/joined`, { pass: owner, body: {} })).json(), { ok: true, own: true });
    const tally = await (await call(e, '/usage/invites', { pass: owner })).json();
    assert.deepEqual(tally.people[0].sent, { project: 0, mail: 0, link: 1 });
    assert.deepEqual(tally.people[0].converted, { project: 0, mail: 0, link: 1 });
    assert.deepEqual(tally.people[0].people.map((p) => [p.email, p.how, p.note]), [['lin@uni.edu', 'link', 'Have a look before Thursday?']]);
  });

  it('runs out', async () => {
    const ledger = new Invites({ storage: memoryStorage() });
    const made = await (await ledger.fetch(new Request('https://invites/link', { method: 'POST', body: JSON.stringify({ by: 'o@x', byName: 'O', note: '' }) }))).json();
    const id = await ledger.state.storage.get(`link:${made.token}`);
    const event = await ledger.state.storage.get(`event:${id}`);
    await ledger.state.storage.put(`event:${id}`, { ...event, link: { ...event.link, expiresAt: Date.now() - 1 } });
    assert.equal((await (await ledger.fetch(new Request(`https://invites/link/${made.token}`))).json()).expired, true);
    assert.equal((await ledger.fetch(new Request(`https://invites/link/${made.token}/joined`, { method: 'POST', body: JSON.stringify({ email: 'a@b' }) }))).status, 410);
  });
});

describe('the report', () => {
  it('tallies by inviter, newest first, with the people who took an invitation', () => {
    const made = report(
      [
        { id: '1', kind: 'project', by: 'a@x', byName: 'A', to: 'p@x', room: 'r', project: 'P', at: 10, converted: { email: 'p@x', name: 'P', at: 20, how: 'project' } },
        { id: '2', kind: 'project', by: 'a@x', byName: 'A', to: 'q@x', room: 'r', project: 'P', at: 11 },
        { id: '3', kind: 'mail', by: 'a@x', byName: 'A', to: 'm@x', at: 12, withdrawn: 13 },
        { id: '4', kind: 'link', by: 'b@x', byName: 'B', at: 30, link: { token: 't', note: 'n', opens: 3, expiresAt: 99, joined: [{ email: 'l1@x', name: 'L', at: 31 }, { email: 'l2@x', name: '', at: 32 }] } },
        { id: '5', kind: 'link', by: 'b@x', byName: 'B', at: 33, link: { token: 'u', note: '', opens: 0, expiresAt: 99, joined: [] } },
      ],
      100,
    );
    assert.deepEqual(made.totals, { sent: 4, converted: 2 });
    assert.deepEqual(made.people.map((p) => p.email), ['b@x', 'a@x']);
    assert.deepEqual(made.people[0].sent, { project: 0, mail: 0, link: 2 });
    assert.deepEqual(made.people[0].converted, { project: 0, mail: 0, link: 1 });
    assert.deepEqual(made.people[0].people.map((p) => p.email), ['l2@x', 'l1@x']);
    assert.deepEqual(made.people[1].sent, { project: 2, mail: 0, link: 0 });
    assert.deepEqual(made.people[1].converted, { project: 1, mail: 0, link: 0 });
    assert.equal(linkToken(8).length, 8);
  });
});

describe('which rooms an account is in', () => {
  it('is told by sharing, joining, a role, leaving, removal and closing — for a lost record to be put back from', async () => {
    const e = env();
    const owner = await issuePass('owner@x.org', SECRET);
    const priya = await issuePass('priya@x.org', SECRET);
    const marco = await issuePass('marco@x.org', SECRET);
    const mine = async (pass) => (await (await call(e, '/rooms/mine', { pass })).json()).rooms.map((item) => [item.room, item.role, item.project]);
    const { room } = await (await call(e, '/rooms', { pass: owner, body: { project } })).json();
    assert.deepEqual(await mine(owner), [[room, 'owner', 'Sparse-gated MoE']]);
    assert.deepEqual(await mine(priya), []);
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'priya@x.org', role: 'viewer' } });
    await call(e, `/rooms/${room}/invite`, { pass: owner, body: { email: 'marco@x.org' } });
    await call(e, `/rooms/${room}/join`, { pass: priya, body: {} });
    await call(e, `/rooms/${room}/join`, { pass: marco, body: {} });
    assert.deepEqual(await mine(priya), [[room, 'viewer', 'Sparse-gated MoE']]);
    await call(e, `/rooms/${room}/role`, { pass: owner, body: { email: 'priya@x.org', role: 'editor' } });
    assert.deepEqual(await mine(priya), [[room, 'editor', 'Sparse-gated MoE']]);
    await call(e, `/rooms/${room}/role`, { pass: owner, body: { email: 'priya@x.org', role: 'owner' } });
    assert.deepEqual(await mine(priya), [[room, 'owner', 'Sparse-gated MoE']]);
    assert.deepEqual(await mine(owner), [[room, 'editor', 'Sparse-gated MoE']]);
    await call(e, `/rooms/${room}/leave`, { pass: owner, body: {} });
    assert.deepEqual(await mine(owner), []);
    await call(e, `/rooms/${room}/remove`, { pass: priya, body: { email: 'marco@x.org' } });
    assert.deepEqual(await mine(marco), []);
    await call(e, `/rooms/${room}/close`, { pass: priya, body: {} });
    assert.deepEqual(await mine(priya), []);
  });
});
