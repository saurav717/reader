/**
 * A project shared with the people you work with: one Durable Object per
 * shared project (docs/live-collaboration.md), holding
 *
 * - the members — email, role, name, picture, the colour given to them, when
 *   they joined — and the invitations waiting, by email;
 * - the project's list (its name, colour, question, its papers with their
 *   roles, its to-do list), which is the record of a shared project: every
 *   member's copy, the owner's too, takes it from here, and the owner or an
 *   editor sends a change back naming the version it was built on — a
 *   stale one is refused, so nobody's page overwrites a newer list;
 * - where each member is right now (in memory, re-sent by their page when
 *   this object wakes), and when each was last here (in storage).
 *
 * The page keeps one WebSocket per open shared project, accepted with
 * Cloudflare's hibernation API so a room with nobody typing costs nothing.
 * Each socket's attachment names the member; a `place` message from one is
 * fanned out to the others, and a socket closing takes that member's place
 * with it. The Worker (worker/index.js) checks the pass and hands the email
 * in on the internal address: nothing here reads a token.
 */

/** Members' colours, by join order, so a person is the same colour on everyone's screen. */
export const PALETTE = ['#8a3a6e', '#b27414', '#2d64a0', '#1f8a70', '#a0462d', '#5a3ea8'];

/** How long without a word before a member's place is dropped by a page that reads it. */
export const AWAY_MS = 60_000;

const ROLES = new Set(['owner', 'editor', 'viewer']);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const email = (value) => text(value, 200).trim().toLowerCase();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

/** A project's summary as a member's copy needs it, with nothing else from the owner's record carried along. */
export function projectSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const papers = Array.isArray(raw.papers)
    ? raw.papers
        .filter((paper) => paper && typeof paper.id === 'string')
        .slice(0, 500)
        .map((paper) => ({
          id: text(paper.id, 200),
          title: text(paper.title, 400),
          role: ROLE_IDS.has(paper.role) ? paper.role : null,
          // Enough of the paper for a member's library to take it in without a lookup (src/lib/projects.ts, `paperRefOf`).
          ...(SOURCES.has(paper.source) ? { source: paper.source } : {}),
          ...(Array.isArray(paper.authors) ? { authors: paper.authors.filter((a) => typeof a === 'string').slice(0, 12).map((a) => a.slice(0, 120)) } : {}),
          ...(typeof paper.published === 'string' && paper.published ? { published: text(paper.published, 40) } : {}),
          ...(typeof paper.doi === 'string' && paper.doi ? { doi: text(paper.doi, 200) } : {}),
          ...(typeof paper.arxivId === 'string' && paper.arxivId ? { arxivId: text(paper.arxivId, 40) } : {}),
          ...(typeof paper.pdfUrl === 'string' && /^https?:\/\//.test(paper.pdfUrl) ? { pdfUrl: text(paper.pdfUrl, 1000) } : {}),
        }))
    : [];
  const todos = Array.isArray(raw.todos) ? raw.todos.filter((todo) => todo && typeof todo.id === 'string' && typeof todo.text === 'string').slice(0, 200).map((todo) => ({ id: text(todo.id, 100), text: text(todo.text, 1000), done: Boolean(todo.done) })) : [];
  return { id: text(raw.id, 200), name: text(raw.name, 200) || 'Untitled project', color: /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : '#1f5e52', question: text(raw.question, 2000), startedAt: text(raw.startedAt, 40), papers, todos, ...(raw.overleaf && typeof raw.overleaf === 'object' ? { overleaf: raw.overleaf } : {}), ...(raw.codeRepo && typeof raw.codeRepo === 'object' ? { codeRepo: raw.codeRepo } : {}) };
}
const ROLE_IDS = new Set(['core', 'baseline', 'method', 'related']);
const SOURCES = new Set(['arxiv', 'openalex', 'semanticscholar', 'crossref', 'scholar', 'books']);

/** A place as a page sends it, with anything else left out: what every other member's page is handed. */
export function cleanPlace(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const tab = ['overview', 'read', 'code', 'write'].includes(raw.tab) ? raw.tab : 'overview';
  const place = { tab, active: raw.active !== false, at: now };
  if (typeof raw.path === 'string' && raw.path) place.path = raw.path.slice(0, 500);
  if (Number.isFinite(raw.line) && raw.line > 0) place.line = Math.floor(raw.line);
  if (Number.isFinite(raw.col) && raw.col > 0) place.col = Math.floor(raw.col);
  if (Number.isFinite(raw.offset) && raw.offset >= 0) place.offset = Math.floor(raw.offset);
  if (Array.isArray(raw.sel) && raw.sel.length === 2 && raw.sel.every((n) => Number.isFinite(n) && n >= 0)) place.sel = [Math.floor(raw.sel[0]), Math.floor(raw.sel[1])];
  if (typeof raw.paperId === 'string' && raw.paperId) place.paperId = raw.paperId.slice(0, 200);
  if (typeof raw.title === 'string' && raw.title) place.title = raw.title.slice(0, 300);
  if (Number.isFinite(raw.page) && raw.page > 0) place.page = Math.floor(raw.page);
  return place;
}

/** The tag a link carries for an address (server/mail.js): kept on the invitation, so links need no hashing on the page. */
async function tagOf(email) {
  const bytes = new TextEncoder().encode(`reader-invite:${email}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomToken = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export class ProjectRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** Where each member is, by email: in memory only; a page sends its place again as its socket opens. */
    this.places = new Map();
  }

  // ------------------------------------------------------------ storage --

  async room() {
    return (await this.state.storage.get('room')) || null;
  }
  async members() {
    const rows = await this.state.storage.list({ prefix: 'member:' });
    return [...rows.values()].sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1));
  }
  async member(who) {
    return (await this.state.storage.get(`member:${who}`)) || null;
  }
  async invitations() {
    const rows = await this.state.storage.list({ prefix: 'invite:' });
    return [...rows.values()];
  }
  async seen() {
    const rows = await this.state.storage.list({ prefix: 'seen:' });
    return Object.fromEntries([...rows.entries()].map(([key, value]) => [key.slice('seen:'.length), value]));
  }

  /** What a member's page is handed: the room, its members with where each is, and — for the owner — the invitations and the link. */
  async stateFor(who) {
    const room = await this.room();
    const me = await this.member(who);
    if (!room || !me) return null;
    const seen = await this.seen();
    const members = (await this.members()).map((member) => ({ ...member, place: this.places.get(member.email) ?? null, lastSeen: seen[member.email]?.at ?? null, lastPlace: seen[member.email]?.place ?? null }));
    const manages = me.role === 'owner' || me.role === 'editor';
    return { room: room.id, owner: room.owner, version: room.version ?? 1, project: room.project, me: who, role: me.role, members, ...(manages ? { invitations: await this.invitations() } : {}), ...(me.role === 'owner' ? { link: (await this.state.storage.get('link')) || null } : {}) };
  }

  // ------------------------------------------------------------- fetch ----

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const who = email(url.searchParams.get('email'));
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (!who) return json({ error: 'whose request?' }, 400);

    if (path === '/create') {
      const was = await this.room();
      if (was && was.owner !== who) return json({ error: 'this room is someone else’s' }, 403);
      const project = projectSummary(body.project);
      if (!project || !project.id) return json({ error: 'which project?' }, 400);
      // A room there already keeps its list — the record — and its version; only a new one takes the project as sent.
      const room = was ? { ...was, version: was.version ?? 1 } : { id: text(body.room, 64), owner: who, project, version: 1, createdAt: new Date().toISOString() };
      await this.state.storage.put('room', room);
      if (!(await this.member(who))) await this.state.storage.put(`member:${who}`, { email: who, role: 'owner', name: text(body.name, 200) || who, picture: text(body.picture, 1000) || undefined, color: PALETTE[0], joinedAt: room.createdAt });
      if (!(await this.state.storage.get('link'))) await this.state.storage.put('link', { token: randomToken(), on: false, domain: '' });
      return json(await this.stateFor(who));
    }

    const room = await this.room();
    if (!room) return json({ error: 'no such room' }, 404);

    if (path === '/join') {
      const already = await this.member(who);
      if (already) return json(await this.stateFor(who));
      const invitation = await this.state.storage.get(`invite:${who}`);
      const link = (await this.state.storage.get('link')) || null;
      const byLink = link && link.on && text(body.token, 64) === link.token && (!link.domain || who.endsWith(`@${link.domain}`));
      if (!invitation && !byLink) return json({ error: 'not invited to this project' }, 403);
      const count = (await this.members()).length;
      const member = { email: who, role: invitation?.role ?? 'editor', name: text(body.name, 200) || who, picture: text(body.picture, 1000) || undefined, color: PALETTE[count % PALETTE.length], joinedAt: new Date().toISOString() };
      await this.state.storage.put(`member:${who}`, member);
      if (invitation) await this.state.storage.delete(`invite:${who}`);
      this.broadcast({ type: 'joined', member }, who);
      return json(await this.stateFor(who));
    }

    const me = await this.member(who);
    if (!me) return json({ error: 'not a member of this project' }, 403);
    const manages = me.role === 'owner' || me.role === 'editor';

    if (path === '/state') return json(await this.stateFor(who));

    if (path === '/live') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket' || typeof WebSocketPair === 'undefined') return json({ error: 'a WebSocket upgrade' }, 426);
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.serializeAttachment({ email: who });
      this.state.acceptWebSocket(server);
      const headers = {};
      const protocol = request.headers.get('Sec-WebSocket-Protocol');
      if (protocol) headers['Sec-WebSocket-Protocol'] = protocol.split(',')[0].trim();
      // What the page sees as it opens: everyone here, and where.
      try {
        server.send(JSON.stringify({ type: 'here', state: await this.stateFor(who) }));
      } catch {
        // closed under us
      }
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    if (path === '/project') {
      if (!manages) return json({ error: 'only the owner or an editor changes the project' }, 403);
      const project = projectSummary(body.project);
      if (!project) return json({ error: 'which project?' }, 400);
      // Built on an older list than the room's: refused, with the room's own, for the page to take instead.
      const version = room.version ?? 1;
      if (Number.isFinite(body.version) && body.version !== version) return json({ error: 'the project changed since this page read it', ...(await this.stateFor(who)) }, 409);
      const next = { ...project, id: room.project.id };
      await this.state.storage.put('room', { ...room, project: next, version: version + 1, updatedAt: new Date().toISOString(), updatedBy: who });
      this.broadcast({ type: 'project', project: next, version: version + 1 }, who);
      return json(await this.stateFor(who));
    }

    if (path === '/invite') {
      if (!manages) return json({ error: 'only the owner or an editor invites' }, 403);
      const target = email(body.email);
      if (!target || !target.includes('@')) return json({ error: 'an email address' }, 400);
      if (await this.member(target)) return json({ error: `${target} is already a member` }, 409);
      const role = ROLES.has(body.role) && body.role !== 'owner' ? body.role : 'editor';
      await this.state.storage.put(`invite:${target}`, { email: target, role, by: who, at: new Date().toISOString(), tag: await tagOf(target) });
      return json(await this.stateFor(who));
    }

    if (path === '/uninvite') {
      if (!manages) return json({ error: 'only the owner or an editor invites' }, 403);
      await this.state.storage.delete(`invite:${email(body.email)}`);
      return json(await this.stateFor(who));
    }

    if (path === '/role') {
      if (me.role !== 'owner') return json({ error: 'only the owner changes roles' }, 403);
      const target = email(body.email);
      const member = await this.member(target);
      if (!member || member.role === 'owner') return json({ error: 'no such member' }, 404);
      if (body.role === 'owner') {
        // The project handed over: they own it, and the owner who handed it over stays as an editor.
        await this.state.storage.put(`member:${target}`, { ...member, role: 'owner' });
        await this.state.storage.put(`member:${who}`, { ...me, role: 'editor' });
        await this.state.storage.put('room', { ...room, owner: target });
        this.broadcast({ type: 'members' }, null);
        return json(await this.stateFor(who));
      }
      const role = ROLES.has(body.role) ? body.role : 'editor';
      await this.state.storage.put(`member:${target}`, { ...member, role });
      this.broadcast({ type: 'members' }, null);
      return json(await this.stateFor(who));
    }

    if (path === '/link') {
      if (me.role !== 'owner') return json({ error: 'only the owner sets the link' }, 403);
      const link = (await this.state.storage.get('link')) || { token: randomToken(), on: false, domain: '' };
      const next = { token: body.renew ? randomToken() : link.token, on: Boolean(body.on), domain: text(body.domain, 200).replace(/^@/, '').toLowerCase() };
      await this.state.storage.put('link', next);
      return json(await this.stateFor(who));
    }

    // The owner stops sharing: everyone is let go, told so, and the room forgotten; the owner's copy is theirs alone again.
    if (path === '/close') {
      if (me.role !== 'owner') return json({ error: 'only the owner stops sharing' }, 403);
      this.broadcast({ type: 'closed' }, who);
      for (const socket of this.sockets()) {
        try {
          socket.close(1000, 'the project is no longer shared');
        } catch {
          // closed already
        }
      }
      this.places.clear();
      const members = (await this.members()).map((member) => member.email);
      for (const prefix of ['member:', 'invite:', 'seen:']) for (const key of (await this.state.storage.list({ prefix })).keys()) await this.state.storage.delete(key);
      await this.state.storage.delete('link');
      await this.state.storage.delete('room');
      return json({ ok: true, members });
    }

    if (path === '/remove' || path === '/leave') {
      const target = path === '/leave' ? who : email(body.email);
      const member = await this.member(target);
      if (!member) return json({ error: 'no such member' }, 404);
      if (member.role === 'owner') return json({ error: 'the owner stays; delete the project to close the room' }, 400);
      if (target !== who && me.role !== 'owner') return json({ error: 'only the owner removes a member' }, 403);
      await this.state.storage.delete(`member:${target}`);
      await this.state.storage.delete(`seen:${target}`);
      this.places.delete(target);
      for (const socket of this.sockets()) {
        if (attachmentOf(socket).email !== target) continue;
        try {
          socket.close(1000, 'removed from the project');
        } catch {
          // closed already
        }
      }
      this.broadcast({ type: 'left', who: target, gone: true }, target);
      return path === '/leave' ? json({ ok: true }) : json(await this.stateFor(who));
    }

    return json({ error: 'not found' }, 404);
  }

  // ----------------------------------------------------------- sockets ----

  sockets() {
    try {
      return this.state.getWebSockets();
    } catch {
      return [];
    }
  }

  /** A message to every member's socket but `except`'s (null: everyone's). */
  broadcast(message, except) {
    const data = JSON.stringify(message);
    for (const socket of this.sockets()) {
      if (except && attachmentOf(socket).email === except) continue;
      try {
        socket.send(data);
      } catch {
        // closed under us; the close event takes it off
      }
    }
  }

  async webSocketMessage(socket, raw) {
    const { email: who } = attachmentOf(socket);
    if (!who) return;
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : '');
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'place') {
      const place = cleanPlace(message.place);
      if (!place) return;
      this.places.set(who, place);
      this.broadcast({ type: 'place', who, place }, who);
    } else if (message.type === 'hello') {
      // The page knows its person's name and picture; the pass only the email.
      const member = await this.member(who);
      if (!member) return;
      const name = text(message.name, 200);
      const picture = text(message.picture, 1000);
      if ((name && name !== member.name) || (picture && picture !== member.picture)) {
        await this.state.storage.put(`member:${who}`, { ...member, name: name || member.name, picture: picture || member.picture });
        this.broadcast({ type: 'members' }, null);
      }
    } else if (message.type === 'ping') {
      try {
        socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        // closed
      }
    }
  }

  async webSocketClose(socket) {
    await this.gone(socket);
  }
  async webSocketError(socket) {
    await this.gone(socket);
  }

  /** A member's last socket closing: their place goes, with when and where they were kept for "earlier". */
  async gone(socket) {
    const { email: who } = attachmentOf(socket);
    if (!who) return;
    const others = this.sockets().filter((other) => other !== socket && attachmentOf(other).email === who);
    if (others.length) return;
    const place = this.places.get(who) ?? null;
    this.places.delete(who);
    if (await this.member(who)) await this.state.storage.put(`seen:${who}`, { at: Date.now(), place });
    this.broadcast({ type: 'left', who }, who);
  }
}

function attachmentOf(socket) {
  try {
    return socket.deserializeAttachment() || {};
  } catch {
    return {};
  }
}
