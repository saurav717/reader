// Reader taking a meeting's notes on this computer (src/lib/recorder.ts says
// how), as the page runs it: which meetings the desktop app has found, which
// project each is for, starting and stopping a recording, the transcript as
// it comes, and — once the meeting ends — writing it up and filing it.
//
// One store for the whole page, read by the floating card that shows a
// recording (src/components/Notetaker.tsx), the Calendar's card and the
// logbook. The page only ever records what the person chose to: a meeting set
// to "Reader takes notes" starts by itself when it opens (Settings can turn
// that off), anything else is offered with a button.

import { useSyncExternalStore } from 'react';
import { apiFetch, proxyHealth } from './api';
import * as google from './google';
import { addDays, fetchAllEvents, fetchCalendars, startOfDay, tagKeys, type CalendarEvent } from './calendar';
import { db } from './db';
import { saveNote } from './logbookStore';
import { meetingProject, type Project } from './projects';
import { eventFor, recordedNote, recorderBridge, summaryPrompt, transcriptText, wordCount, withSpeech, type DetectedMeeting, type RecorderBridge, type RecorderEvent, type Turn } from './recorder';

export type SessionStatus = 'found' | 'starting' | 'recording' | 'writing' | 'filed' | 'failed';

export interface Session {
  /** The SDK's id for the meeting (or the audio source, for one it did not find). */
  windowId: string;
  found: DetectedMeeting;
  /** The calendar event it is, when one fits. */
  event?: CalendarEvent;
  /** The project its notes go to: the event's tag, or what the person picked. */
  projectId: string | null;
  status: SessionStatus;
  /** Started by itself (a meeting set to Reader notes), rather than by a click. */
  auto: boolean;
  started?: number;
  ended?: number;
  turns: Turn[];
  error?: string;
  /** The filed note's id, once it is. */
  noteId?: string;
}

export type Availability = 'checking' | 'browser' | 'unsupported' | 'no-server' | 'ready' | 'failed';

export interface NotetakerState {
  availability: Availability;
  /** Why it is not ready, when it is not. */
  reason?: string;
  sessions: Session[];
  /** macOS permissions as the SDK last said: microphone, screen-capture, accessibility. */
  permissions: Record<string, string>;
}

let state: NotetakerState = { availability: 'checking', sessions: [], permissions: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<NotetakerState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const patchSession = (windowId: string, patch: Partial<Session>) => set({ sessions: state.sessions.map((session) => (session.windowId === windowId ? { ...session, ...patch } : session)) });
const sessionOf = (windowId: string) => state.sessions.find((session) => session.windowId === windowId);

export const notetakerNow = () => state;
export function useNotetaker(): NotetakerState {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
    () => state,
  );
}

/** What the store needs from the page around it: the projects, who is signed in, the choices in Settings, and the model that writes notes up. */
export interface NotetakerContext {
  projects: () => Project[];
  who: () => string | null;
  clientId: () => string;
  /** Start by itself for meetings set to Reader notes. */
  auto: () => boolean;
  /** Offer to take notes of any other meeting found. */
  offer: () => boolean;
  /** Writes the meeting up: the page's model, given the prompt; the Markdown it answered. */
  write: (prompt: { system: string; user: string }) => Promise<string>;
}

let context: NotetakerContext | null = null;
let bridge: RecorderBridge | null = null;
let stopListening: (() => void) | null = null;
let events: CalendarEvent[] = [];
let eventsAt = 0;

// ------------------------------------------------------------- starting --

/** Starts listening to the desktop app, once: told what the page knows, and where to write notes up. */
export async function startNotetaker(given: NotetakerContext): Promise<void> {
  context = given;
  if (stopListening) return;
  bridge = recorderBridge();
  if (!bridge) return set({ availability: typeof window !== 'undefined' && window.readerDesktop?.app ? 'unsupported' : 'browser' });
  stopListening = bridge.onEvent(hear);
  const health = await proxyHealth().catch(() => null);
  if (!health?.notes) return set({ availability: 'no-server', reason: 'This site has no Recall.ai key set up on its server, so meetings cannot be recorded yet.' });
  const enabled = await bridge.enable(health.notes.recall).catch((error: Error) => ({ ok: false, error: error.message }));
  if (!enabled.ok) return set({ availability: 'failed', reason: enabled.error ?? 'The recorder did not start.' });
  set({ availability: 'ready', reason: undefined });
}

/** The meetings on now and in the next hours, from the calendar, read again every ten minutes: to know which meeting the app found. */
async function currentEvents(): Promise<CalendarEvent[]> {
  if (Date.now() - eventsAt < 10 * 60_000) return events;
  const clientId = context?.clientId() ?? '';
  const token = clientId ? await google.calendarToken(clientId).catch(() => null) : null;
  if (!token) return events;
  try {
    const calendars = await fetchCalendars(token);
    const day = startOfDay(new Date());
    events = (await fetchAllEvents(token, calendars, { start: addDays(day, -1), end: addDays(day, 2) })).events;
    eventsAt = Date.now();
  } catch {
    // the calendar is not readable now: the meeting is matched by nothing, and offered
  }
  return events;
}

/** The page's own copy of the calendar, when it has just read one: saves reading it again. */
export function knowEvents(list: CalendarEvent[]): void {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const event of list) byId.set(event.id, event);
  events = [...byId.values()];
  eventsAt = Math.max(eventsAt, Date.now() - 5 * 60_000);
}

// ---------------------------------------------------------- what is heard --

const saveTimers = new Map<string, number>();
/** The transcript kept in this browser as it grows, so a page closed mid-meeting loses nothing. */
function keep(windowId: string): void {
  if (saveTimers.has(windowId)) return;
  saveTimers.set(
    windowId,
    window.setTimeout(() => {
      saveTimers.delete(windowId);
      const session = sessionOf(windowId);
      if (session) void db.setKv(`recording:${windowId}`, { ...session, event: session.event ? { ...session.event } : undefined }).catch(() => undefined);
    }, 2000),
  );
}

async function hear(event: RecorderEvent): Promise<void> {
  if (event.type === 'ready') return;
  if (event.type === 'unavailable') return set({ availability: 'unsupported', reason: event.reason });
  if (event.type === 'permission') return set({ permissions: { ...state.permissions, [event.permission]: event.status } });
  if (event.type === 'error') {
    if (event.window) patchSession(event.window.id, { status: sessionOf(event.window.id)?.status === 'recording' ? 'recording' : 'failed', error: event.message });
    return;
  }
  const found = event.window;
  if (event.type === 'meeting-detected' || event.type === 'meeting-updated') {
    const had = sessionOf(found.id);
    if (had && had.status !== 'found') return patchSession(found.id, { found: { ...had.found, ...found } });
    const match = eventFor(found, await currentEvents());
    const project = match ? meetingProject(context?.projects() ?? [], tagKeys(match)) : undefined;
    const session: Session = { windowId: found.id, found: { ...had?.found, ...found }, ...(match ? { event: match } : {}), projectId: had?.projectId ?? project?.id ?? null, status: 'found', auto: false, turns: [] };
    set({ sessions: [...state.sessions.filter((item) => item.windowId !== found.id), session] });
    // Set to Reader notes on the calendar, for a project: it starts by itself.
    if (!had && match?.notetaker === 'reader' && project && context?.auto()) void startRecording(found.id, project.id, true);
    else if (!had && !context?.offer() && !(match?.notetaker === 'reader')) dismiss(found.id);
    return;
  }
  if (event.type === 'meeting-closed') {
    const session = sessionOf(found.id);
    if (session && (session.status === 'found' || session.status === 'starting')) dismiss(found.id);
    return;
  }
  if (event.type === 'recording-started') {
    if (sessionOf(found.id)) return patchSession(found.id, { status: 'recording', started: sessionOf(found.id)?.started ?? Date.now(), error: undefined });
    // A recording already on as the page opens (it was reloaded mid-meeting): taken up again, with what it had heard, kept in this browser.
    const kept = await db.getKv<Session>(`recording:${found.id}`).catch(() => undefined);
    const keptEvent = kept?.event ? { ...kept.event, start: new Date(kept.event.start), end: new Date(kept.event.end) } : undefined;
    const match = keptEvent ?? eventFor(found, await currentEvents());
    const project = match ? meetingProject(context?.projects() ?? [], tagKeys(match)) : undefined;
    const session: Session = { windowId: found.id, found: { ...kept?.found, ...found }, ...(match ? { event: match } : {}), projectId: kept?.projectId ?? project?.id ?? null, status: 'recording', auto: kept?.auto ?? false, started: kept?.started ?? Date.now(), turns: kept?.turns ?? [] };
    set({ sessions: [...state.sessions.filter((item) => item.windowId !== found.id), session] });
    return;
  }
  if (event.type === 'transcript') {
    const session = sessionOf(found.id);
    if (!session) return;
    patchSession(found.id, { turns: withSpeech(session.turns, event.data) });
    keep(found.id);
    return;
  }
  if (event.type === 'recording-ended') {
    const session = sessionOf(found.id);
    if (session && session.status === 'recording') await writeUp(found.id);
  }
}

// -------------------------------------------------------------- actions --

/** Records a meeting found on the computer, for a project: a token from the Worker, then the app starts. */
export async function startRecording(windowId: string, projectId: string | null, auto = false): Promise<void> {
  const session = sessionOf(windowId);
  if (!bridge || !session || session.status === 'recording' || session.status === 'starting') return;
  patchSession(windowId, { status: 'starting', projectId, auto, error: undefined });
  try {
    const response = await apiFetch('/notes/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = (await response.json().catch(() => ({}))) as { uploadToken?: string; error?: string };
    if (!response.ok || !body.uploadToken) throw new Error(body.error || `Reader’s server answered ${response.status}.`);
    const started = await bridge.start(windowId, body.uploadToken);
    if (!started.ok) throw new Error(started.error || 'The recorder did not start.');
  } catch (error) {
    patchSession(windowId, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

/** A recording with no meeting app found: the computer's sound and its microphone — an in-person meeting, or a call the app missed. */
export async function recordHere(projectId: string | null, title = 'Meeting'): Promise<void> {
  if (!bridge) return;
  const prepared = await bridge.prepareAudio().catch((error: Error) => ({ ok: false, error: error.message }) as { ok: boolean; windowId?: string; error?: string });
  if (!prepared.ok || !prepared.windowId) return set({ reason: prepared.error ?? 'The recorder could not listen to this computer.' });
  set({ sessions: [...state.sessions, { windowId: prepared.windowId, found: { id: prepared.windowId, title }, projectId, status: 'found', auto: false, turns: [] }] });
  await startRecording(prepared.windowId, projectId);
}

export async function stopRecording(windowId: string): Promise<void> {
  if (!bridge) return;
  const stopped = await bridge.stop(windowId).catch((error: Error) => ({ ok: false, error: error.message }));
  // The app says so with recording-ended; when it cannot be reached, the page writes up what it has.
  if (!stopped.ok && sessionOf(windowId)?.status === 'recording') await writeUp(windowId);
}

export const setProject = (windowId: string, projectId: string | null) => {
  patchSession(windowId, { projectId });
  const session = sessionOf(windowId);
  // A meeting written up before it had a project waits for one: picking it files it.
  if (session?.status === 'writing' && session.ended && projectId) void writeUp(windowId);
};

export function dismiss(windowId: string): void {
  set({ sessions: state.sessions.filter((session) => session.windowId !== windowId) });
  void db.deleteKv(`recording:${windowId}`).catch(() => undefined);
}

/**
 * The meeting written up and filed: the transcript to the model, its notes and
 * the transcript into the project's logbook. A meeting with no project waits
 * (the card asks for one); one too short to write up is filed with what there is.
 */
async function writeUp(windowId: string): Promise<void> {
  const session = sessionOf(windowId);
  if (!session || !context) return;
  const ended = session.ended ?? Date.now();
  patchSession(windowId, { status: 'writing', ended });
  const project = context.projects().find((item) => item.id === session.projectId);
  if (!project) return; // waits for setProject
  let markdown = '';
  if (wordCount(session.turns) >= 25) {
    try {
      const event = session.event;
      markdown = await context.write(
        summaryPrompt(
          { title: event?.title || session.found.title || 'Meeting', start: event?.start ?? new Date(session.started ?? ended), project: project.name, question: project.project.question, attendees: (event?.attendees ?? []).map((person) => person.name || person.email) },
          session.turns,
        ),
      );
    } catch (error) {
      markdown = `_The notes could not be written up (${error instanceof Error ? error.message : String(error)}); the transcript is below._`;
    }
  }
  const note = recordedNote({ event: session.event, found: session.found, started: new Date(session.started ?? ended), ended: new Date(ended), turns: session.turns, markdown, by: context.who() ?? 'me' });
  const ok = await saveNote(project, note);
  if (ok) {
    patchSession(windowId, { status: 'filed', noteId: note.id });
    void db.deleteKv(`recording:${windowId}`).catch(() => undefined);
  } else patchSession(windowId, { status: 'failed', error: 'The notes were written but the project would not take them. They are kept in this browser; try again from the card.' });
}

/** Files a failed session again (after the project's room was unreachable, say). */
export const retry = (windowId: string) => void writeUp(windowId);

/** Recordings kept from an earlier visit (the page closed mid-meeting): offered again to be written up. */
export async function recoverRecordings(): Promise<void> {
  const kept = await db.kvWithPrefix<Session>('recording:').catch(() => [] as [string, Session][]);
  for (const [, session] of kept) {
    if (!session?.windowId || state.sessions.some((item) => item.windowId === session.windowId) || !session.turns?.length) continue;
    const event = session.event ? { ...session.event, start: new Date(session.event.start), end: new Date(session.event.end) } : undefined;
    set({ sessions: [...state.sessions, { ...session, ...(event ? { event } : {}), status: 'writing', ended: session.ended ?? Date.now() }] });
    void writeUp(session.windowId);
  }
}

export const transcriptOf = (session: Session) => transcriptText(session.turns);

/** For a test, or a page torn down: forgets everything. */
export function resetNotetaker(): void {
  stopListening?.();
  stopListening = null;
  bridge = null;
  context = null;
  events = [];
  eventsAt = 0;
  state = { availability: 'checking', sessions: [], permissions: {} };
  listeners.forEach((listener) => listener());
}
