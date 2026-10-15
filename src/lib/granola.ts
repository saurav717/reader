// Granola, the AI notepad, taking the notes of a meeting on the Calendar page
// and handing them to the project the meeting is tagged with.
//
// Granola itself does the listening: it reads the same Google Calendar, sees
// the meeting begin and writes its notes on the person's own computer. What
// Reader adds is the other end — once a meeting it was asked to take notes of
// has ended, the notes are read from Granola's API with the person's own key
// (Settings → Meetings), matched to the meeting, and filed in the project's
// logbook (src/lib/logbook.ts), where everyone in the project reads them.
//
// Granola's API does not answer a browser on another site, so the calls go
// through the Worker (`/granola/…`, worker/meetings.js), which passes the key
// on and keeps nothing. The parsing and the matching are here, apart from the
// network, for scripts/granola.test.mjs.

import { apiFetch } from './api';
import type { CalendarEvent } from './calendar';
import type { MeetingNote } from './logbook';

/** A note as Granola's API lists or gives it, as much as is read. Field names vary between its versions; every one is optional. */
export interface GranolaRaw {
  id?: string;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
  web_url?: string;
  summary_markdown?: string | null;
  summary_text?: string | null;
  summary?: string | null;
  attendees?: { email?: string; name?: string }[];
  calendar_event?: {
    id?: string;
    event_id?: string;
    calendar_event_id?: string;
    ical_uid?: string;
    event_title?: string;
    title?: string;
    scheduled_start_time?: string;
    start_time?: string;
    scheduled_end_time?: string;
    end_time?: string;
    invitees?: { email?: string }[];
  } | null;
}

export interface GranolaNote {
  id: string;
  title: string;
  createdAt: string;
  url?: string;
  markdown: string;
  /** The calendar event Granola tied it to: Google's id for it, and when it was. */
  eventId?: string;
  start?: string;
  end?: string;
  attendees: string[];
}

const iso = (value: unknown): string | undefined => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined);

/** One of Granola's notes as the page uses it; null for one with no id. */
export function parseGranolaNote(raw: GranolaRaw): GranolaNote | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  const event = raw.calendar_event ?? undefined;
  const people = new Set<string>();
  for (const person of [...(raw.attendees ?? []), ...(event?.invitees ?? [])]) if (person?.email) people.add(person.email.trim().toLowerCase());
  const title = (raw.title || event?.event_title || event?.title || '').trim();
  const url = typeof raw.web_url === 'string' && /^https:\/\//.test(raw.web_url) ? raw.web_url : undefined;
  return {
    id: raw.id,
    title: title || 'Untitled meeting',
    createdAt: iso(raw.created_at) ?? new Date(0).toISOString(),
    ...(url ? { url } : {}),
    markdown: (raw.summary_markdown || raw.summary_text || raw.summary || '').trim(),
    ...(event?.event_id || event?.calendar_event_id || event?.id ? { eventId: String(event.event_id || event.calendar_event_id || event.id) } : {}),
    ...(iso(event?.scheduled_start_time ?? event?.start_time) ? { start: iso(event?.scheduled_start_time ?? event?.start_time) } : {}),
    ...(iso(event?.scheduled_end_time ?? event?.end_time) ? { end: iso(event?.scheduled_end_time ?? event?.end_time) } : {}),
    attendees: [...people],
  };
}

/** A meeting's title as it is compared: lower case, no punctuation, no "Re:" or "(copy)". */
const gist = (title: string) =>
  title
    .toLowerCase()
    .replace(/\b(re|fwd?|updated invitation|invitation)\s*:\s*/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Whether two titles are of the same meeting: the same words, or one inside the other. */
export function sameTitle(a: string, b: string): boolean {
  const [x, y] = [gist(a), gist(b)];
  if (!x || !y) return false;
  return x === y || (x.length >= 6 && y.includes(x)) || (y.length >= 6 && x.includes(y));
}

/**
 * The Granola note of a meeting, out of a list: one tied to the same calendar
 * event (by Google's id — a meeting of a series by its own instance id or the
 * series'), else one at the same time with the same title, else one written
 * during or just after the meeting with the same title. None for a meeting
 * that has none.
 */
export function noteFor(event: Pick<CalendarEvent, 'eventId' | 'seriesId' | 'title' | 'start' | 'end'>, notes: GranolaNote[]): GranolaNote | undefined {
  const start = event.start.getTime();
  const end = event.end.getTime();
  const byId = notes.find((note) => note.eventId && (note.eventId === event.eventId || note.eventId.split('@')[0] === event.eventId));
  if (byId) return byId;
  const near = (iso: string | undefined, before: number, after: number) => {
    if (!iso) return false;
    const at = Date.parse(iso);
    return at >= before && at <= after;
  };
  const sameSlot = notes.find((note) => sameTitle(note.title, event.title) && near(note.start, start - 20 * 60_000, start + 20 * 60_000));
  if (sameSlot) return sameSlot;
  return notes.find((note) => !note.start && sameTitle(note.title, event.title) && near(note.createdAt, start - 15 * 60_000, end + 3 * 3600_000));
}

/** The meetings whose notes are due: Granola was asked, the meeting is over (by ten minutes, for Granola to finish), and not more than `days` ago. */
export function meetingsDue(events: CalendarEvent[], now: Date, days = 14): CalendarEvent[] {
  const since = now.getTime() - days * 86_400_000;
  return events.filter((event) => event.notetaker === 'granola' && !event.allDay && event.end.getTime() + 10 * 60_000 <= now.getTime() && event.end.getTime() >= since);
}

/** The meeting's notes, as the logbook files them. */
export function noteOf(note: GranolaNote, event: Pick<CalendarEvent, 'id' | 'title' | 'start' | 'end' | 'meet' | 'attendees'>, by: string, now = new Date()): MeetingNote {
  // Each person once: by name when the calendar has one, and Granola's addresses only for those it does not.
  const known = new Set(event.attendees.map((person) => person.email.toLowerCase()));
  const attendees = new Set([...event.attendees.map((person) => person.name || person.email), ...note.attendees.filter((email) => !known.has(email.toLowerCase()))]);
  return {
    id: `granola:${note.id}`,
    meeting: event.id,
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    source: 'granola',
    ...(note.url ? { url: note.url } : {}),
    ...(event.meet ? { call: event.meet } : {}),
    attendees: [...attendees].filter(Boolean).slice(0, 40),
    markdown: note.markdown || '_Granola has no summary for this meeting yet._',
    by,
    at: now.toISOString(),
  };
}

// ------------------------------------------------------------------- API ---

export class GranolaError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GranolaError';
  }
}

async function ask<T>(key: string, path: string): Promise<T> {
  const response = await apiFetch(`/granola${path}`, { headers: { 'X-Granola-Key': key } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) {
    const said = body.error || body.message || `Granola answered ${response.status}`;
    throw new GranolaError(response.status, response.status === 401 || response.status === 403 ? `Granola did not take the key: ${said}. Keys are made in Granola under Settings → API (a Business or Enterprise plan).` : said);
  }
  return body;
}

/** The notes created after a moment, every page of them (up to a few hundred). */
export async function listNotes(key: string, after: Date): Promise<GranolaNote[]> {
  const notes: GranolaNote[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ created_after: after.toISOString(), page_size: '30' });
    if (cursor) params.set('cursor', cursor);
    const body = await ask<{ notes?: GranolaRaw[]; data?: GranolaRaw[]; cursor?: string; next_cursor?: string; hasMore?: boolean; has_more?: boolean }>(key, `/notes?${params}`);
    for (const raw of body.notes ?? body.data ?? []) {
      const note = parseGranolaNote(raw);
      if (note) notes.push(note);
    }
    cursor = body.next_cursor ?? body.cursor;
    if (!cursor || body.hasMore === false || body.has_more === false) break;
  }
  return notes;
}

/** One note with all of it: its summary, its calendar event, who was there. */
export const getNote = async (key: string, id: string): Promise<GranolaNote | null> => parseGranolaNote(await ask<GranolaRaw>(key, `/notes/${encodeURIComponent(id)}`));

/**
 * The notes of each meeting that is due and not yet filed, read from Granola:
 * the list once, for the span the meetings cover, then each match in full.
 * Answers the notes to file, by the meeting's id; a meeting Granola has no
 * note for yet is left for the next time.
 */
export async function collectNotes(key: string, due: CalendarEvent[], by: string, now = new Date()): Promise<Map<string, MeetingNote>> {
  const found = new Map<string, MeetingNote>();
  if (!due.length) return found;
  const earliest = new Date(Math.min(...due.map((event) => event.start.getTime())) - 3600_000);
  const listed = await listNotes(key, earliest);
  for (const event of due) {
    const match = noteFor(event, listed);
    if (!match) continue;
    const full = (await getNote(key, match.id).catch(() => null)) ?? match;
    found.set(event.id, noteOf(full, event, by, now));
  }
  return found;
}
