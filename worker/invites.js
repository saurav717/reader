/**
 * Invitations, kept in one place (docs/live-collaboration.md, "Invitations
 * that need no link in hand"): one Durable Object for the whole site, the
 * ledger of who invited whom, how, and whether it took.
 *
 * Three kinds of invitation:
 * - `project`: an address invited to a shared project (worker/projectRoom.js
 *   keeps the room's own copy; this one is for the invitee's inbox on Home,
 *   and for the tally). Converted when that address joins the room.
 * - `mail`: "Invite someone" by email (server/mail.js). Converted when that
 *   address first signs in after it.
 * - `link`: a personal link, `?invite=<token>`, with the inviter's name and a
 *   note, good for thirty days. Opened by anyone; converted by each person
 *   who signs in from it.
 *
 * It also keeps, by account, which shared projects that account is in
 * (`rooms:<email>`): told by the Worker as people share, join, leave, are
 * removed, or a room closes. A page asks for it to put back a project record
 * its library lost — the room is the record, the library a mirror.
 *
 * And it keeps the site's mail log: each mail the Worker tried to send — the
 * invitation to a project, "Invite someone", the owner's test — to whom, by
 * whom, and the provider's refusal when it refused (`/mail`, read as
 * `/mail-log` by the Email tab of the Usage page).
 *
 * The owner's dashboard (/usage/invites) reads the whole ledger by inviter:
 * how many each person sent or made, how many took, and who. Nothing here
 * reads a pass: the Worker checks it and hands the email in.
 */

export const LINK_DAYS = 30;
const KEEP_EVENTS = 5000;
/** The site's mail log (`mail:`): every send tried, for the Email tab of the Usage page (worker/mailUsage.js). */
const KEEP_MAIL = 2000;
const MAIL_KINDS = ['project', 'try', 'test'];

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const email = (value) => text(value, 200).trim().toLowerCase();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** A short token for a link: ten letters and digits with no look-alikes, from the platform's random. */
export function linkToken(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

const eventId = (at) => `${String(at).padStart(14, '0')}-${linkToken(6)}`;

/** The tally by inviter, from the events: what each sent or made, what took, and who. */
export function report(events, now = Date.now()) {
  const byInviter = new Map();
  const row = (by, byName) => {
    if (!byInviter.has(by)) byInviter.set(by, { email: by, name: byName || by, sent: { project: 0, mail: 0, link: 0 }, converted: { project: 0, mail: 0, link: 0 }, people: [], last: 0 });
    const item = byInviter.get(by);
    if (byName && item.name === by) item.name = byName;
    return item;
  };
  for (const event of events) {
    const item = row(event.by, event.byName);
    item.last = Math.max(item.last, event.at);
    if (event.kind === 'link') {
      item.sent.link += 1;
      const joined = event.link?.joined ?? [];
      if (joined.length) item.converted.link += 1;
      for (const person of joined) item.people.push({ email: person.email, name: person.name || '', how: 'link', at: person.at, note: event.link?.note || '' });
      continue;
    }
    if (event.withdrawn) continue;
    item.sent[event.kind] += 1;
    if (event.converted) {
      item.converted[event.kind] += 1;
      item.people.push({ email: event.converted.email, name: event.converted.name || '', how: event.kind, project: event.project || '', at: event.converted.at });
    }
  }
  const people = [...byInviter.values()].map((item) => ({ ...item, people: item.people.sort((a, b) => b.at - a.at) })).sort((a, b) => b.last - a.last);
  const totals = people.reduce(
    (sum, item) => ({ sent: sum.sent + item.sent.project + item.sent.mail + item.sent.link, converted: sum.converted + item.converted.project + item.converted.mail + item.converted.link }),
    { sent: 0, converted: 0 },
  );
  return { at: now, people, totals };
}

export class Invites {
  constructor(state) {
    this.state = state;
  }

  async events() {
    const rows = await this.state.storage.list({ prefix: 'event:' });
    return [...rows.values()];
  }
  async event(id) {
    return (await this.state.storage.get(`event:${id}`)) || null;
  }
  async put(event) {
    await this.state.storage.put(`event:${event.id}`, event);
  }
  async toList(who) {
    return (await this.state.storage.get(`to:${who}`)) || [];
  }
  async addTo(who, id) {
    const list = await this.toList(who);
    if (!list.includes(id)) await this.state.storage.put(`to:${who}`, [...list, id].slice(-200));
  }

  async roomsOf(who) {
    return (await this.state.storage.get(`rooms:${who}`)) || [];
  }
  /** Someone in a room, with their role — or out of it (`gone`). */
  async setRoom(who, room, patch, gone) {
    const list = (await this.roomsOf(who)).filter((item) => item.room !== room);
    if (!gone) list.push({ room, role: text(patch.role, 10) || 'editor', project: text(patch.project, 200), at: Date.now() });
    if (list.length) await this.state.storage.put(`rooms:${who}`, list.slice(-200));
    else await this.state.storage.delete(`rooms:${who}`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const now = Date.now();

    // Someone's part in a room: in it with a role, or out of it.
    if (path === '/member' && request.method === 'POST') {
      const who = email(body.email);
      const room = text(body.room, 64);
      if (!who || !room) return json({ error: 'email and room' }, 400);
      await this.setRoom(who, room, body, Boolean(body.gone));
      return json({ ok: true });
    }
    // A room closed: out of it, everyone who was in.
    if (path === '/room-closed' && request.method === 'POST') {
      const room = text(body.room, 64);
      for (const who of Array.isArray(body.emails) ? body.emails.map(email).filter(Boolean) : []) await this.setRoom(who, room, {}, true);
      return json({ ok: true });
    }
    // The rooms an account is in.
    if (path === '/rooms') return json({ rooms: await this.roomsOf(email(url.searchParams.get('email'))) });

    // An invitation sent: to a project, or by mail.
    if (path === '/event' && request.method === 'POST') {
      const kind = body.kind === 'project' ? 'project' : body.kind === 'mail' ? 'mail' : null;
      const by = email(body.by);
      const to = email(body.to);
      if (!kind || !by || !to) return json({ error: 'kind, by and to' }, 400);
      // The same address invited to the same project again: the one invitation, its time moved.
      if (kind === 'project' && body.room) {
        for (const id of await this.toList(to)) {
          const was = await this.event(id);
          if (was && was.kind === 'project' && was.room === body.room && !was.converted && !was.withdrawn) {
            await this.put({ ...was, at: now, role: text(body.role, 10) || was.role, byName: text(body.byName, 200) || was.byName });
            return json({ id: was.id });
          }
        }
      }
      const event = { id: eventId(now), kind, by, byName: text(body.byName, 200), to, at: now, ...(kind === 'project' ? { room: text(body.room, 64), project: text(body.project, 200), role: text(body.role, 10) || 'editor' } : {}) };
      await this.put(event);
      await this.addTo(to, event.id);
      await this.prune();
      return json({ id: event.id });
    }

    // An invitation to a project taken back.
    if (path === '/withdraw' && request.method === 'POST') {
      const to = email(body.to);
      let count = 0;
      for (const id of await this.toList(to)) {
        const was = await this.event(id);
        if (was && was.kind === 'project' && was.room === body.room && !was.converted && !was.withdrawn) {
          await this.put({ ...was, withdrawn: now });
          count += 1;
        }
      }
      return json({ withdrawn: count });
    }

    // Someone took an invitation up: joined the project it was to, or (by mail) signed in.
    if (path === '/converted' && request.method === 'POST') {
      const who = email(body.email);
      if (!who) return json({ error: 'whose?' }, 400);
      const how = body.how === 'project' ? 'project' : 'signin';
      let count = 0;
      for (const id of await this.toList(who)) {
        const was = await this.event(id);
        if (!was || was.converted || was.withdrawn) continue;
        if (how === 'project' ? was.kind === 'project' && was.room === body.room : was.kind === 'mail') {
          await this.put({ ...was, converted: { email: who, name: text(body.name, 200), at: now, how } });
          count += 1;
        }
      }
      return json({ converted: count });
    }

    // A personal link, with the inviter's name and a note.
    if (path === '/link' && request.method === 'POST') {
      const by = email(body.by);
      if (!by) return json({ error: 'whose link?' }, 400);
      const token = linkToken();
      const event = { id: eventId(now), kind: 'link', by, byName: text(body.byName, 200), at: now, link: { token, note: text(body.note, 1000).trim(), opens: 0, expiresAt: now + LINK_DAYS * 86_400_000, joined: [] } };
      await this.put(event);
      await this.state.storage.put(`link:${token}`, event.id);
      await this.prune();
      return json({ token, expiresAt: event.link.expiresAt });
    }

    const link = /^\/link\/([a-z0-9]{6,20})(\/joined)?$/.exec(path);
    if (link) {
      const id = await this.state.storage.get(`link:${link[1]}`);
      const event = id ? await this.event(id) : null;
      if (!event) return json({ error: 'no such link' }, 404);
      const expired = now > event.link.expiresAt;
      if (!link[2]) {
        if (url.searchParams.get('open') === '1' && !expired) await this.put({ ...event, link: { ...event.link, opens: event.link.opens + 1 } });
        return json({ byName: event.byName || 'Someone', note: event.link.note, expired, expiresAt: event.link.expiresAt });
      }
      if (request.method !== 'POST') return json({ error: 'POST' }, 405);
      const who = email(body.email);
      if (!who) return json({ error: 'whose?' }, 400);
      if (expired) return json({ error: 'this link has run out' }, 410);
      if (who === event.by) return json({ ok: true, own: true });
      if (!event.link.joined.some((person) => person.email === who)) await this.put({ ...event, link: { ...event.link, joined: [...event.link.joined, { email: who, name: text(body.name, 200), at: now }] } });
      return json({ ok: true, byName: event.byName || 'Someone' });
    }

    // What waits for someone: the projects they were invited to and have not joined.
    if (path === '/inbox') {
      const who = email(url.searchParams.get('email'));
      const waiting = [];
      for (const id of await this.toList(who)) {
        const was = await this.event(id);
        if (was && was.kind === 'project' && !was.converted && !was.withdrawn) waiting.push({ id: was.id, room: was.room, project: was.project, role: was.role, by: was.by, byName: was.byName, at: was.at });
      }
      return json({ invitations: waiting.sort((a, b) => b.at - a.at) });
    }

    // One person's own tally, and the whole site's for the owner.
    if (path === '/mine') {
      const who = email(url.searchParams.get('email'));
      const mine = (await this.events()).filter((event) => event.by === who);
      return json(report(mine, now).people[0] ?? { email: who, name: who, sent: { project: 0, mail: 0, link: 0 }, converted: { project: 0, mail: 0, link: 0 }, people: [], last: 0 });
    }
    if (path === '/report') return json(report(await this.events(), now));

    // A mail the Worker tried to send, and whether the provider took it.
    if (path === '/mail' && request.method === 'POST') {
      const to = email(body.to);
      if (!to) return json({ error: 'to whom?' }, 400);
      const entry = { id: eventId(now), at: now, kind: MAIL_KINDS.includes(body.kind) ? body.kind : 'try', to, by: email(body.by), ok: Boolean(body.ok), ...(body.ok ? {} : { error: text(body.error, 300) }), ...(body.project ? { project: text(body.project, 200) } : {}) };
      await this.state.storage.put(`mail:${entry.id}`, entry);
      const rows = await this.state.storage.list({ prefix: 'mail:' });
      if (rows.size > KEEP_MAIL) for (const key of [...rows.keys()].sort().slice(0, rows.size - KEEP_MAIL)) await this.state.storage.delete(key);
      return json({ id: entry.id });
    }
    // An account deleted (worker/account.js): every invitation it sent or was sent, its links, its rooms and
    // the mail to or from it, gone; where it only joined someone else's link, it comes off that link's list.
    if (path === '/forget' && request.method === 'POST') {
      const who = email(body.email);
      if (!who) return json({ error: 'whose?' }, 400);
      let events = 0;
      for (const [key, event] of await this.state.storage.list({ prefix: 'event:' })) {
        if (event.by === who || event.to === who) {
          if (event.link?.token) await this.state.storage.delete(`link:${event.link.token}`);
          await this.state.storage.delete(key);
          events += 1;
        } else if (event.link?.joined?.some((person) => person.email === who)) {
          await this.put({ ...event, link: { ...event.link, joined: event.link.joined.filter((person) => person.email !== who) } });
        }
      }
      let mail = 0;
      for (const [key, entry] of await this.state.storage.list({ prefix: 'mail:' })) {
        if (entry.to === who || entry.by === who) {
          await this.state.storage.delete(key);
          mail += 1;
        }
      }
      await this.state.storage.delete([`to:${who}`, `rooms:${who}`]);
      return json({ ok: true, events, mail });
    }

    if (path === '/mail-log') return json({ entries: [...(await this.state.storage.list({ prefix: 'mail:' })).values()] });

    return json({ error: 'not found' }, 404);
  }

  /** The oldest events dropped past a few thousand: a tally, not an archive. */
  async prune() {
    const rows = await this.state.storage.list({ prefix: 'event:' });
    if (rows.size <= KEEP_EVENTS) return;
    const keys = [...rows.keys()].sort();
    for (const key of keys.slice(0, rows.size - KEEP_EVENTS)) await this.state.storage.delete(key);
  }
}
