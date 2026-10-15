// Where a project's logbook (src/lib/logbook.ts) is kept, and the one way
// every page reads and changes it.
//
// A shared project's is kept by its room on the Worker (worker/logbook.js):
// read once as the logbook opens, then kept current by the room's messages on
// the live socket the project page already holds (src/lib/liveRoom.ts), and
// changed with a POST each — shown at once, and put back from the room if the
// room refuses. A project of one's own keeps its logbook in this browser
// (IndexedDB, under `logbook:<project id>`); when it is shared, the owner's
// page hands it to the room the first time the logbook opens there, and when
// sharing stops the room hands it back.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from './api';
import { db } from './db';
import { EMPTY_LOGBOOK, linksInOrder, notesInOrder, withLink, withNote, type Logbook, type MeetingNote, type Notepad, type ProjectLink, type Stroke } from './logbook';
import { ROOM_CLOSED_LOG, onRoomMessage, sendToRoom, type RoomMessage } from './liveRoom';
import type { Project } from './projects';

export type LogStatus = 'loading' | 'ready' | 'error';

interface Entry {
  log: Logbook;
  status: LogStatus;
  error: string | null;
  /** Strokes others are drawing right now, by who: shown until the finished stroke arrives. */
  ink: Record<string, Stroke>;
  listeners: Set<() => void>;
  loaded: boolean;
}

const entries = new Map<string, Entry>();

const entryOf = (projectId: string): Entry => {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = { log: EMPTY_LOGBOOK, status: 'loading', error: null, ink: {}, listeners: new Set(), loaded: false };
    entries.set(projectId, entry);
  }
  return entry;
};

function patch(projectId: string, change: Partial<Omit<Entry, 'listeners'>>): void {
  const entry = entryOf(projectId);
  Object.assign(entry, change);
  // A new object each time, so React sees the change.
  entries.set(projectId, { ...entry });
  entry.listeners.forEach((listener) => listener());
}

const localKey = (projectId: string) => `logbook:${projectId}`;

/** A logbook read from anywhere — the room, this browser, an old version — with whatever is missing put in. */
export function logbookOf(raw: unknown): Logbook {
  const value = (raw ?? {}) as Partial<Logbook>;
  return {
    notes: notesInOrder(Array.isArray(value.notes) ? value.notes.filter((note) => note && typeof note.id === 'string') : []),
    links: linksInOrder(Array.isArray(value.links) ? value.links.filter((link) => link && typeof link.id === 'string' && typeof link.url === 'string') : []),
    pad: value.pad && typeof value.pad.text === 'string' ? { text: value.pad.text, version: Number(value.pad.version) || 0, ...(value.pad.by ? { by: value.pad.by } : {}), ...(value.pad.at ? { at: value.pad.at } : {}) } : { text: '', version: 0 },
    strokes: Array.isArray(value.strokes) ? value.strokes.filter((stroke) => stroke && typeof stroke.id === 'string' && Array.isArray(stroke.points)) : [],
  };
}

const isEmpty = (log: Logbook) => !log.notes.length && !log.links.length && !log.strokes.length && !log.pad.text;

// ------------------------------------------------------------- backends ---

const roomOf = (project: Project): string | null => project.project.shared?.room ?? null;

async function readRoom(room: string): Promise<Logbook> {
  const response = await apiFetch(`/rooms/${room}/log`);
  const body = (await response.json().catch(() => ({}))) as Logbook & { error?: string };
  if (!response.ok) throw new Error(body.error || `The project’s room answered ${response.status}.`);
  return logbookOf(body);
}

async function postRoom<T>(room: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const response = await apiFetch(`/rooms/${room}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, body: (await response.json().catch(() => ({}))) as T & { error?: string } };
}

const readLocal = async (projectId: string): Promise<Logbook> => logbookOf(await db.getKv(localKey(projectId)).catch(() => undefined));
const writeLocal = (projectId: string, log: Logbook) => db.setKv(localKey(projectId), log).catch(() => undefined);

/** The logbook read again, from wherever it is kept. */
export async function loadLogbook(project: Project): Promise<Logbook> {
  const room = roomOf(project);
  try {
    let log = room ? await readRoom(room) : await readLocal(project.id);
    // A project just shared: the owner's page hands the room what was kept here before.
    if (room && project.project.shared?.role === 'owner' && isEmpty(log)) {
      const before = await readLocal(project.id);
      if (!isEmpty(before)) log = await seedRoom(room, before);
    }
    patch(project.id, { log, status: 'ready', error: null, loaded: true });
    return log;
  } catch (error) {
    patch(project.id, { status: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function seedRoom(room: string, log: Logbook): Promise<Logbook> {
  for (const note of log.notes) await postRoom(room, { op: 'note', note });
  for (const link of log.links) await postRoom(room, { op: 'link', link });
  for (let i = 0; i < log.strokes.length; i += 200) await postRoom(room, { op: 'stroke', strokes: log.strokes.slice(i, i + 200) });
  if (log.pad.text) await postRoom(room, { op: 'pad', text: log.pad.text, version: 0 });
  return readRoom(room);
}

/**
 * A change to a project's logbook: shown at once, then kept — in the room, or
 * in this browser. Answers false (with the logbook put back as the room has
 * it, and the reason on the entry) when the room refused it.
 */
async function change(project: Project, local: (log: Logbook) => Logbook, remote: Record<string, unknown>): Promise<boolean> {
  const entry = entryOf(project.id);
  const room = roomOf(project);
  if (!entry.loaded) await loadLogbook(project).catch(() => undefined);
  const next = local(entryOf(project.id).log);
  patch(project.id, { log: next, error: null });
  if (!room) {
    await writeLocal(project.id, next);
    return true;
  }
  const answer = await postRoom(room, remote).catch(() => null);
  if (answer?.ok) return true;
  patch(project.id, { error: answer?.body.error ?? 'The project’s room could not be reached; the change was not kept.' });
  void loadLogbook(project).catch(() => undefined);
  return false;
}

// -------------------------------------------------------------- changes ---

export const saveNote = (project: Project, note: MeetingNote) => change(project, (log) => ({ ...log, notes: withNote(log.notes, note) }), { op: 'note', note });
export const removeNote = (project: Project, id: string) => change(project, (log) => ({ ...log, notes: log.notes.filter((note) => note.id !== id) }), { op: 'unnote', ids: [id] });
export const saveLink = (project: Project, link: ProjectLink) => change(project, (log) => ({ ...log, links: withLink(log.links, link) }), { op: 'link', link });
export const removeLink = (project: Project, id: string) => change(project, (log) => ({ ...log, links: log.links.filter((link) => link.id !== id) }), { op: 'unlink', ids: [id] });
export const addStrokes = (project: Project, strokes: Stroke[]) => change(project, (log) => ({ ...log, strokes: [...log.strokes.filter((stroke) => !strokes.some((item) => item.id === stroke.id)), ...strokes] }), { op: 'stroke', strokes });
export const removeStrokes = (project: Project, ids: string[]) => change(project, (log) => ({ ...log, strokes: log.strokes.filter((stroke) => !ids.includes(stroke.id)) }), { op: 'unstroke', ids });
export const clearBoard = (project: Project) => change(project, (log) => ({ ...log, strokes: [] }), { op: 'clear' });

/**
 * The notepad saved, made on `version`. Answers the notepad as kept — or, when
 * someone else's change got there first, `conflict` with theirs, for the page
 * to merge into and save again (lib/logbook.ts, `mergePad`).
 */
export async function savePad(project: Project, text: string, version: number, by: string): Promise<{ pad: Notepad; conflict: boolean } | null> {
  const room = roomOf(project);
  if (!room) {
    const pad = { text, version: version + 1, by, at: new Date().toISOString() };
    const log = { ...entryOf(project.id).log, pad };
    patch(project.id, { log });
    await writeLocal(project.id, log);
    return { pad, conflict: false };
  }
  const answer = await postRoom<{ pad?: Notepad }>(room, { op: 'pad', text, version }).catch(() => null);
  if (!answer) {
    patch(project.id, { error: 'The project’s room could not be reached; the notepad is not saved yet.' });
    return null;
  }
  if (answer.body.pad) {
    patch(project.id, { log: { ...entryOf(project.id).log, pad: answer.body.pad }, error: null });
    return { pad: answer.body.pad, conflict: answer.status === 409 };
  }
  patch(project.id, { error: answer.body.error ?? 'The notepad was not saved.' });
  return null;
}

/** A stroke being drawn, sent to the others as it grows (kept by nobody: the finished one is `addStrokes`). */
export function sendInk(project: Project, stroke: Stroke): void {
  const room = roomOf(project);
  if (room) sendToRoom(room, { type: 'ink', stroke });
}

// --------------------------------------------------------- what is heard ---

/** The room of each project open in a logbook, so a message names its project. */
const projectOfRoom = new Map<string, string>();

function hear(room: string, message: RoomMessage): void {
  const projectId = projectOfRoom.get(room);
  if (!projectId) return;
  const entry = entryOf(projectId);
  const log = entry.log;
  if (message.type === 'ink') {
    const who = String(message.who ?? '');
    const stroke = message.stroke as Stroke | undefined;
    if (who && stroke) patch(projectId, { ink: { ...entry.ink, [who]: stroke } });
    return;
  }
  const op = message.op;
  const ids = (message.ids as string[] | undefined) ?? [];
  if (op === 'note' && message.note) patch(projectId, { log: { ...log, notes: withNote(log.notes, message.note as MeetingNote) } });
  else if (op === 'unnote') patch(projectId, { log: { ...log, notes: log.notes.filter((note) => !ids.includes(note.id)) } });
  else if (op === 'link' && message.link) patch(projectId, { log: { ...log, links: withLink(log.links, message.link as ProjectLink) } });
  else if (op === 'unlink') patch(projectId, { log: { ...log, links: log.links.filter((link) => !ids.includes(link.id)) } });
  else if (op === 'stroke' && Array.isArray(message.strokes)) {
    const strokes = message.strokes as Stroke[];
    // The finished stroke takes the place of the one being drawn.
    const ink = { ...entry.ink };
    for (const stroke of strokes) if (ink[stroke.by]?.id === stroke.id) delete ink[stroke.by];
    patch(projectId, { ink, log: { ...log, strokes: [...log.strokes.filter((stroke) => !strokes.some((item) => item.id === stroke.id)), ...strokes] } });
  } else if (op === 'unstroke') patch(projectId, { log: { ...log, strokes: log.strokes.filter((stroke) => !ids.includes(stroke.id)) } });
  else if (op === 'clear') patch(projectId, { log: { ...log, strokes: [] }, ink: {} });
  else if (op === 'pad' && message.pad) patch(projectId, { log: { ...log, pad: message.pad as Notepad } });
}

let listening = false;
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  onRoomMessage(hear);
  // Sharing stopped: the room's logbook comes back to the owner's copy, kept in this browser from now on.
  window.addEventListener(ROOM_CLOSED_LOG, (event) => {
    const { projectId, log } = (event as CustomEvent<{ projectId: string; log: unknown }>).detail;
    const kept = logbookOf(log);
    void writeLocal(projectId, kept);
    patch(projectId, { log: kept, loaded: true, status: 'ready' });
  });
}
listen();

// ------------------------------------------------------------------ hook ---

export interface LogbookView {
  log: Logbook;
  status: LogStatus;
  error: string | null;
  ink: Record<string, Stroke>;
  /** Whether this account may change it: anyone on a project of their own; the owner and editors of a shared one. */
  writable: boolean;
  shared: boolean;
  reload: () => void;
}

const NONE: Entry = { log: EMPTY_LOGBOOK, status: 'loading', error: null, ink: {}, listeners: new Set(), loaded: false };

/** A project's logbook, kept current: loaded as it shows, and as the room says it changes. */
export function useLogbook(project: Project | undefined): LogbookView {
  const id = project?.id;
  const room = project ? roomOf(project) : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!id) return () => undefined;
      const entry = entryOf(id);
      entry.listeners.add(listener);
      return () => {
        entries.get(id)?.listeners.delete(listener);
        entry.listeners.delete(listener);
      };
    },
    [id],
  );
  const entry = useSyncExternalStore(subscribe, () => (id ? entries.get(id) ?? NONE : NONE), () => NONE);
  useEffect(() => {
    if (!project) return;
    if (room) projectOfRoom.set(room, project.id);
    void loadLogbook(project).catch(() => undefined);
    return () => {
      if (room) projectOfRoom.delete(room);
    };
    // Loaded once per project and room; the room's messages keep it current after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, room]);
  const role = project?.project.shared?.role;
  return {
    log: entry.log,
    status: entry.status,
    error: entry.error,
    ink: entry.ink,
    writable: !role || role !== 'viewer',
    shared: Boolean(room),
    reload: () => project && void loadLogbook(project).catch(() => undefined),
  };
}

/** Notes filed for a project from outside its page — the Calendar's Granola notes — once the logbook has been read, so none is filed twice. */
export async function fileNotes(project: Project, notes: MeetingNote[]): Promise<number> {
  const log = await loadLogbook(project).catch(() => null);
  if (!log) return 0;
  let filed = 0;
  for (const note of notes) {
    if (log.notes.some((item) => item.id === note.id)) continue;
    if (await saveNote(project, note)) filed++;
  }
  return filed;
}
