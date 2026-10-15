/**
 * A shared project's logbook, kept by its room (worker/projectRoom.js): the
 * notes of its meetings, the links kept for it, its notepad and the strokes
 * on its whiteboard (src/lib/logbook.ts is the page's side of the record).
 *
 * Each is stored under keys of its own — `note:<id>`, `weblink:<id>`,
 * `stroke:<id>`, and `pad` — so no value comes near a Durable Object's limit
 * and two members' changes never write the same key: a note, a link or a
 * stroke is added or taken away whole. The notepad is one text, and a change
 * to it names the version it was made on, as the room's list does; one made
 * on an older version is refused with the current text, which the page
 * merges its change into and sends again.
 *
 * Everything a page sends is cleaned here before it is kept: lengths cut,
 * links only http(s), colours only #rrggbb. A member reads all of it; the
 * owner and editors change it.
 */

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const iso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString());
const id = (value) => (typeof value === 'string' && /^[\w:.-]{1,120}$/.test(value) ? value : '');
const http = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().slice(0, 2000) : '';
  } catch {
    return '';
  }
};

export const LIMITS = { notes: 500, links: 500, strokes: 5000, markdown: 100_000, pad: 100_000, points: 6000 };

export function cleanNote(raw, who) {
  if (!raw || typeof raw !== 'object' || !id(raw.id)) return null;
  return {
    id: id(raw.id),
    ...(id(raw.meeting) ? { meeting: id(raw.meeting) } : typeof raw.meeting === 'string' && raw.meeting ? { meeting: raw.meeting.slice(0, 300) } : {}),
    title: text(raw.title, 300) || 'Meeting',
    start: iso(raw.start),
    ...(raw.end ? { end: iso(raw.end) } : {}),
    source: raw.source === 'granola' ? 'granola' : 'manual',
    ...(http(raw.url) ? { url: http(raw.url) } : {}),
    ...(http(raw.call) ? { call: http(raw.call) } : {}),
    attendees: Array.isArray(raw.attendees) ? raw.attendees.filter((a) => typeof a === 'string').slice(0, 40).map((a) => a.slice(0, 200)) : [],
    markdown: text(raw.markdown, LIMITS.markdown),
    by: who,
    at: new Date().toISOString(),
  };
}

export function cleanLink(raw, who) {
  if (!raw || typeof raw !== 'object' || !id(raw.id) || !http(raw.url)) return null;
  return {
    id: id(raw.id),
    url: http(raw.url),
    title: text(raw.title, 300) || http(raw.url),
    note: text(raw.note, 2000),
    pinned: Boolean(raw.pinned),
    by: text(raw.by, 200) || who,
    at: raw.at ? iso(raw.at) : new Date().toISOString(),
    ...(id(raw.from) ? { from: id(raw.from) } : {}),
  };
}

export function cleanStroke(raw, who) {
  if (!raw || typeof raw !== 'object' || !id(raw.id) || !Array.isArray(raw.points)) return null;
  const whole = Math.min(raw.points.length, LIMITS.points);
  const points = raw.points.slice(0, whole - (whole % 3)).map((n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0));
  if (points.length < 3) return null;
  return {
    id: id(raw.id),
    by: who,
    color: /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : '#1a1a17',
    width: Number.isFinite(raw.width) ? Math.max(0.5, Math.min(40, raw.width)) : 3,
    tool: raw.tool === 'marker' ? 'marker' : 'pen',
    points,
    at: new Date().toISOString(),
  };
}

const PREFIX = { note: 'note:', link: 'weblink:', stroke: 'stroke:' };

/** The whole logbook, as a member's page reads it. */
export async function readLog(storage) {
  const list = async (prefix) => [...(await storage.list({ prefix })).values()];
  const [notes, links, strokes, pad] = await Promise.all([list(PREFIX.note), list(PREFIX.link), list(PREFIX.stroke), storage.get('pad')]);
  return {
    notes: notes.sort((a, b) => (b.start || '').localeCompare(a.start || '')),
    links: links.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.at || '').localeCompare(a.at || '')),
    strokes: strokes.sort((a, b) => (a.at || '').localeCompare(b.at || '')),
    pad: pad || { text: '', version: 0 },
  };
}

/** Every key the logbook has, for a room that is closed. */
export async function logKeys(storage) {
  const keys = ['pad'];
  for (const prefix of Object.values(PREFIX)) keys.push(...(await storage.list({ prefix })).keys());
  return keys;
}

const count = async (storage, prefix) => (await storage.list({ prefix })).size;

/**
 * One change to the logbook, from a member who may make it. Answers
 * `{ status, body, broadcast }`: what the page is told, and what every other
 * member's page is sent (none for a change that did nothing).
 */
export async function changeLog(storage, who, body) {
  const op = body?.op;
  if (op === 'note') {
    const note = cleanNote(body.note, who);
    if (!note) return { status: 400, body: { error: 'which note?' } };
    const had = await storage.get(PREFIX.note + note.id);
    if (!had && (await count(storage, PREFIX.note)) >= LIMITS.notes) return { status: 413, body: { error: `a logbook keeps ${LIMITS.notes} meetings’ notes` } };
    // A meeting's notes from the same source are kept once: a note filed again for the same meeting takes the old one's place.
    if (note.meeting) {
      for (const [key, value] of await storage.list({ prefix: PREFIX.note })) {
        if (value.meeting === note.meeting && value.source === note.source && value.id !== note.id) {
          await storage.delete(key);
          if (had === undefined) note.at = value.at;
        }
      }
    }
    await storage.put(PREFIX.note + note.id, note);
    return { status: 200, body: { note }, broadcast: { type: 'log', op: 'note', note } };
  }
  if (op === 'link') {
    const link = cleanLink(body.link, who);
    if (!link) return { status: 400, body: { error: 'a link, http or https' } };
    const had = await storage.get(PREFIX.link + link.id);
    if (!had && (await count(storage, PREFIX.link)) >= LIMITS.links) return { status: 413, body: { error: `a logbook keeps ${LIMITS.links} links` } };
    await storage.put(PREFIX.link + link.id, link);
    return { status: 200, body: { link }, broadcast: { type: 'log', op: 'link', link } };
  }
  if (op === 'stroke') {
    const strokes = (Array.isArray(body.strokes) ? body.strokes : [body.stroke]).slice(0, 200).map((raw) => cleanStroke(raw, who)).filter(Boolean);
    if (!strokes.length) return { status: 400, body: { error: 'which stroke?' } };
    if ((await count(storage, PREFIX.stroke)) + strokes.length > LIMITS.strokes) return { status: 413, body: { error: 'the whiteboard is full: clear it, or download it and start again' } };
    for (const stroke of strokes) await storage.put(PREFIX.stroke + stroke.id, stroke);
    return { status: 200, body: { strokes }, broadcast: { type: 'log', op: 'stroke', strokes } };
  }
  if (op === 'unnote' || op === 'unlink' || op === 'unstroke') {
    const prefix = op === 'unnote' ? PREFIX.note : op === 'unlink' ? PREFIX.link : PREFIX.stroke;
    const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(id).filter(Boolean).slice(0, 500);
    if (!ids.length) return { status: 400, body: { error: 'which?' } };
    for (const item of ids) await storage.delete(prefix + item);
    return { status: 200, body: { ok: true, ids }, broadcast: { type: 'log', op, ids } };
  }
  if (op === 'clear') {
    const keys = [...(await storage.list({ prefix: PREFIX.stroke })).keys()];
    for (const key of keys) await storage.delete(key);
    return { status: 200, body: { ok: true }, broadcast: { type: 'log', op: 'clear' } };
  }
  if (op === 'pad') {
    const pad = (await storage.get('pad')) || { text: '', version: 0 };
    if (!Number.isFinite(body.version) || body.version !== pad.version) return { status: 409, body: { error: 'the notepad changed since this page read it', pad } };
    const next = { text: text(body.text, LIMITS.pad), version: pad.version + 1, by: who, at: new Date().toISOString() };
    await storage.put('pad', next);
    return { status: 200, body: { pad: next }, broadcast: { type: 'log', op: 'pad', pad: next } };
  }
  return { status: 400, body: { error: 'what change?' } };
}
