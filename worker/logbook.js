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

/** A note and its transcript together stay under a Durable Object value's 128 KiB. */
export const LIMITS = { notes: 500, links: 500, strokes: 5000, markdown: 40_000, transcript: 80_000, pad: 100_000, points: 6000, experiments: 500, summary: 40_000 };

export function cleanNote(raw, who) {
  if (!raw || typeof raw !== 'object' || !id(raw.id)) return null;
  return {
    id: id(raw.id),
    ...(id(raw.meeting) ? { meeting: id(raw.meeting) } : typeof raw.meeting === 'string' && raw.meeting ? { meeting: raw.meeting.slice(0, 300) } : {}),
    title: text(raw.title, 300) || 'Meeting',
    start: iso(raw.start),
    ...(raw.end ? { end: iso(raw.end) } : {}),
    source: raw.source === 'granola' || raw.source === 'reader' ? raw.source : 'manual',
    ...(http(raw.url) ? { url: http(raw.url) } : {}),
    ...(http(raw.call) ? { call: http(raw.call) } : {}),
    attendees: Array.isArray(raw.attendees) ? raw.attendees.filter((a) => typeof a === 'string').slice(0, 40).map((a) => a.slice(0, 200)) : [],
    markdown: text(raw.markdown, LIMITS.markdown),
    ...(typeof raw.transcript === 'string' && raw.transcript ? { transcript: text(raw.transcript, LIMITS.transcript) } : {}),
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

const num = (value) => (Number.isFinite(value) ? value : undefined);
/** An experiment's record (src/lib/experiments.ts): the shape is kept, every string cut, every number checked. */
export function cleanExperiment(raw, who) {
  if (!raw || typeof raw !== 'object' || !id(raw.id) || !id(raw.playgroundId)) return null;
  const returns = raw.returns && typeof raw.returns === 'object' && [raw.returns.first, raw.returns.last, raw.returns.best].every(Number.isFinite) ? { first: raw.returns.first, last: raw.returns.last, best: raw.returns.best } : undefined;
  const last = {};
  if (raw.last && typeof raw.last === 'object') for (const [key, value] of Object.entries(raw.last).slice(0, 12)) if (Number.isFinite(value)) last[String(key).slice(0, 80)] = value;
  const where = raw.where && typeof raw.where === 'object' ? { kind: raw.where.kind === 'server' ? 'server' : 'drive', label: text(raw.where.label, 120), path: text(raw.where.path, 600), ...(http(raw.where.link) ? { link: http(raw.where.link) } : {}), ...(id(raw.where.serverId) ? { serverId: id(raw.where.serverId) } : {}) } : { kind: 'drive', label: 'Google Drive', path: '' };
  const config = (() => {
    try {
      const json = JSON.stringify(raw.config && typeof raw.config === 'object' ? raw.config : {});
      return json.length <= 8000 ? JSON.parse(json) : { '…': 'too long to keep' };
    } catch {
      return {};
    }
  })();
  return {
    id: id(raw.id),
    playgroundId: id(raw.playgroundId),
    playground: text(raw.playground, 200),
    title: text(raw.title, 200) || id(raw.id),
    ...(typeof raw.sim === 'string' && raw.sim ? { sim: raw.sim.slice(0, 200) } : {}),
    status: raw.status === 'crashed' || raw.status === 'stopped' ? raw.status : 'finished',
    started: iso(raw.started),
    ended: iso(raw.ended),
    steps: Math.max(0, Math.floor(num(raw.steps) ?? 0)),
    episodes: Math.max(0, Math.floor(num(raw.episodes) ?? 0)),
    ...(returns ? { returns } : {}),
    ...(Number.isFinite(raw.success) ? { success: Math.max(0, Math.min(100, Math.round(raw.success))) } : {}),
    last,
    ...(() => {
      const list = (Array.isArray(raw.evaluations) ? raw.evaluations : []).slice(0, 8).filter((e) => e && typeof e === 'object' && e.metrics && typeof e.metrics === 'object').map((e) => {
        const numbers = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {}).slice(0, 12).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [String(k).slice(0, 80), v]));
        return {
          step: Math.max(0, Math.floor(num(e.step) ?? 0)),
          name: text(e.name, 80) || 'eval',
          metrics: numbers(e.metrics),
          ...(Number.isFinite(e.episodes) ? { episodes: Math.max(0, Math.floor(e.episodes)) } : {}),
          ...(typeof e.protocol === 'string' && e.protocol ? { protocol: text(e.protocol, 400) } : {}),
          ...(e.paper && typeof e.paper === 'object' && Object.keys(numbers(e.paper)).length ? { paper: numbers(e.paper) } : {}),
          ...(typeof e.source === 'string' && e.source ? { source: text(e.source, 120) } : {}),
          ...(typeof e.higherIsBetter === 'boolean' ? { higherIsBetter: e.higherIsBetter } : e.higherIsBetter && typeof e.higherIsBetter === 'object' ? { higherIsBetter: Object.fromEntries(Object.entries(e.higherIsBetter).slice(0, 12).map(([k, v]) => [String(k).slice(0, 80), Boolean(v)])) } : {}),
        };
      }).filter((e) => Object.keys(e.metrics).length);
      return list.length ? { evaluations: list } : {};
    })(),
    findings: (Array.isArray(raw.findings) ? raw.findings : []).slice(0, 20).filter((f) => f && typeof f === 'object').map((f) => ({ id: text(f.id, 40), level: f.level === 'error' || f.level === 'warn' ? f.level : 'info', title: text(f.title, 200), detail: text(f.detail, 600), try: text(f.try, 600) })),
    notes: (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 30).filter((n) => n && typeof n === 'object').map((n) => ({ step: Math.max(0, Math.floor(num(n.step) ?? 0)), by: text(n.by, 40) || 'code', text: text(n.text, 500) })),
    config,
    ...(typeof raw.machine === 'string' && raw.machine ? { machine: raw.machine.slice(0, 120) } : {}),
    where,
    files: (Array.isArray(raw.files) ? raw.files : []).slice(0, 60).filter((f) => f && typeof f === 'object' && typeof f.path === 'string').map((f) => ({ path: f.path.slice(0, 300), ...(Number.isFinite(f.bytes) ? { bytes: f.bytes } : {}), kind: ['video', 'image', 'scene', 'events', 'report'].includes(f.kind) ? f.kind : 'video' })),
    leftOut: (Array.isArray(raw.leftOut) ? raw.leftOut : []).slice(0, 60).filter((p) => typeof p === 'string').map((p) => p.slice(0, 300)),
    ...(raw.summary && typeof raw.summary === 'object' && typeof raw.summary.text === 'string' ? { summary: { text: text(raw.summary.text, LIMITS.summary), by: text(raw.summary.by, 80) || who, at: iso(raw.summary.at) } } : {}),
    by: text(raw.by, 200) || who,
    at: raw.at ? iso(raw.at) : new Date().toISOString(),
  };
}

const PREFIX = { note: 'note:', link: 'weblink:', stroke: 'stroke:', experiment: 'experiment:' };

/** The whole logbook, as a member's page reads it. */
export async function readLog(storage) {
  const list = async (prefix) => [...(await storage.list({ prefix })).values()];
  const [notes, links, strokes, experiments, pad] = await Promise.all([list(PREFIX.note), list(PREFIX.link), list(PREFIX.stroke), list(PREFIX.experiment), storage.get('pad')]);
  return {
    notes: notes.sort((a, b) => (b.start || '').localeCompare(a.start || '')),
    links: links.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.at || '').localeCompare(a.at || '')),
    strokes: strokes.sort((a, b) => (a.at || '').localeCompare(b.at || '')),
    experiments: experiments.sort((a, b) => (b.ended || '').localeCompare(a.ended || '')),
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
  if (op === 'experiment') {
    const experiment = cleanExperiment(body.experiment, who);
    if (!experiment) return { status: 400, body: { error: 'which experiment?' } };
    const key = PREFIX.experiment + experiment.playgroundId + ':' + experiment.id;
    const had = await storage.get(key);
    if (!had && (await count(storage, PREFIX.experiment)) >= LIMITS.experiments) return { status: 413, body: { error: `a logbook keeps ${LIMITS.experiments} experiments` } };
    await storage.put(key, experiment);
    return { status: 200, body: { experiment }, broadcast: { type: 'log', op: 'experiment', experiment } };
  }
  if (op === 'unexperiment') {
    const keys = (Array.isArray(body.keys) ? body.keys : [body.key]).filter((k) => typeof k === 'string' && /^[\w:.-]{3,250}$/.test(k)).slice(0, 100);
    if (!keys.length) return { status: 400, body: { error: 'which?' } };
    for (const key of keys) await storage.delete(PREFIX.experiment + key);
    return { status: 200, body: { ok: true, keys }, broadcast: { type: 'log', op: 'unexperiment', keys } };
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
