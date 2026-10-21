// Notes taken by Reader itself, on this computer, with no bot in the call:
// the Reader desktop app runs Recall.ai's Desktop Recording SDK, which sees a
// Zoom, Meet or Teams meeting open on the computer and records its audio, and
// hands back what is said, speaker by speaker, as it is said. When the meeting
// ends the transcript is written up by the model the person uses for Ask AI,
// and filed — notes and transcript — in the logbook of the project the
// meeting is tagged with (src/lib/logbook.ts).
//
// The desktop app's side is desktop/app/main.js; the Worker gives it the
// upload token each recording needs (worker/meetings.js, /notes/upload); the
// session — which meeting is being recorded, for which project — is
// src/lib/notetaker.ts. What is here has no network and no DOM, so
// scripts/logbook.test.mjs can pin it.

import { sameTitle } from './granola';
import type { CalendarEvent } from './calendar';
import { newId, type MeetingNote } from './logbook';

// ------------------------------------------------------------- the bridge --

/** A meeting the SDK has found open on the computer (its `RecallAiSdkWindow`). */
export interface DetectedMeeting {
  id: string;
  title?: string;
  url?: string;
  /** Recall's name for the platform: zoom, google-meet, microsoft-teams, slack… */
  platform?: string;
}

/** What the desktop app sends the page: the SDK's events, as they come. */
export type RecorderEvent =
  | { type: 'ready'; platform: string }
  | { type: 'unavailable'; reason: string }
  | { type: 'meeting-detected' | 'meeting-updated' | 'meeting-closed'; window: DetectedMeeting }
  | { type: 'recording-started' | 'recording-ended'; window: DetectedMeeting }
  | { type: 'transcript'; window: DetectedMeeting; data: TranscriptData }
  | { type: 'permission'; permission: string; granted: boolean; status: string }
  | { type: 'error'; window?: DetectedMeeting; message: string };

/** What Recall sends for each stretch of speech (`transcript.data`). */
export interface TranscriptData {
  words?: { text?: string; start_timestamp?: { relative?: number; absolute?: string } }[];
  participant?: { id?: number; name?: string | null; is_host?: boolean };
}

/** The desktop app's side of note-taking, as preload-site.js puts it on the page. */
export interface RecorderBridge {
  /** Starts the SDK with the Recall region the Worker names; resolves once it is listening. */
  enable(apiUrl: string): Promise<{ ok: boolean; error?: string }>;
  start(windowId: string, uploadToken: string): Promise<{ ok: boolean; error?: string }>;
  stop(windowId: string): Promise<{ ok: boolean; error?: string }>;
  /** A recording of the computer's sound and microphone with no meeting app: an in-person meeting, or a call the SDK did not find. */
  prepareAudio(): Promise<{ ok: boolean; windowId?: string; error?: string }>;
  requestPermission(permission: string): Promise<{ ok: boolean; error?: string }>;
  /** macOS made to forget its decisions about Reader, and Reader started again, so each permission is asked afresh (desktop/app/notes.js). */
  resetPermissions?(): Promise<{ ok: boolean; said?: string[]; error?: string }>;
  /** Every event from now on; answers the way to stop listening. */
  onEvent(listener: (event: RecorderEvent) => void): () => void;
}

declare global {
  interface Window {
    readerDesktop?: {
      app: true;
      platform: string;
      notes?: RecorderBridge;
      /** The app's own version, and its updates (desktop/app/updates.js). */
      updates?: AppUpdates;
      /** This computer's own Companion handed from the account it is connected to, to whoever pairs next, and started again after a shutdown (desktop/app/main.js). */
      companion?: { release(id: string): Promise<{ ok: boolean; error?: string }>; start?(): Promise<{ ok: boolean; error?: string }> };
      /** Google sign-in in the browser, for an app Google won't sign in inside (src/lib/google.ts). */
      google?: {
        token(request: { clientId: string; scope: string; prompt: string; hint: string; proxy: string }): Promise<{
          access_token?: string;
          expires_in?: number;
          scope?: string;
          error?: string;
          error_description?: string;
        }>;
        /** Whether the app keeps a sign-in for this client, so the page signs in with no click (desktop/app/google.js). */
        kept?(request: { clientId: string; hint: string }): Promise<{ email: string } | null>;
        signOut?(request: { clientId: string; email: string; proxy: string }): Promise<{ ok: boolean }>;
      };
    };
  }
}

/** Where the Reader app is with updating itself (desktop/app/updates.js sends it as it changes). */
export interface AppUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'manual' | 'failed' | 'unsupported';
  /** This app's version. */
  version: string;
  /** The newer version, once there is one. */
  available?: string;
  percent?: number;
  error?: string;
}

export interface AppUpdates {
  state(): Promise<AppUpdateState | null>;
  /** Checks now (and says what it found in a dialog). */
  check(): Promise<AppUpdateState | null>;
  /** Restarts into the version downloaded. */
  install(): Promise<null>;
  onEvent(listener: (state: AppUpdateState) => void): () => void;
}

/** The desktop app's recorder, when the page is in the app on a computer that can record (macOS or Windows). */
export const recorderBridge = (): RecorderBridge | null => (typeof window !== 'undefined' && window.readerDesktop?.notes) || null;

/** Whether the page is in the Reader app at all, recorder or not (Linux has the app, not the recorder). */
export const inDesktopApp = (): boolean => typeof window !== 'undefined' && Boolean(window.readerDesktop?.app);

// ------------------------------------------------------- which meeting --

/**
 * A call's link as it is compared: the Zoom meeting's number (or personal
 * room), the Meet code, the Teams meeting's thread — whatever else is in the
 * link (a passcode, a tracking parameter, the host's subdomain) left out.
 */
export function callKey(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = decodeURIComponent(parsed.pathname);
  if (host === 'zoom.us' || host.endsWith('.zoom.us') || host.endsWith('zoomgov.com')) {
    const meeting = /\/(?:j|w|s|wc(?:\/join)?)\/(\d{9,12})/.exec(path) ?? /\/wc\/(\d{9,12})\/join/.exec(path);
    if (meeting) return `zoom:${meeting[1]}`;
    const room = /\/my\/([\w.-]+)/i.exec(path);
    if (room) return `zoom:my:${room[1].toLowerCase()}`;
    const confno = parsed.searchParams.get('confno');
    return confno ? `zoom:${confno}` : null;
  }
  if (host === 'meet.google.com') {
    const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(path);
    return code ? `meet:${code[1].toLowerCase()}` : null;
  }
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') {
    const thread = /(19:meeting_[^@/]+@thread\.v2)/i.exec(path) ?? /\/meet\/(\d+)/.exec(path);
    return thread ? `teams:${thread[1].toLowerCase()}` : null;
  }
  return null;
}

/**
 * The calendar event a meeting found on the computer is: one whose call is
 * the same call, else one with the same title on now; else, when only one
 * meeting with a call is on now, that one. None when nothing fits.
 */
export function eventFor(found: DetectedMeeting, events: CalendarEvent[], now = new Date()): CalendarEvent | undefined {
  const at = now.getTime();
  const current = events.filter((event) => !event.allDay && event.start.getTime() - 15 * 60_000 <= at && event.end.getTime() + 10 * 60_000 >= at);
  const key = callKey(found.url);
  if (key) {
    const byCall = events.filter((event) => callKey(event.meet) === key || callKey(event.location) === key);
    // A standing room or a weekly meeting has one link for many events: the one on now, else the next.
    const byCallNow = byCall.find((event) => current.includes(event));
    if (byCallNow) return byCallNow;
  }
  if (found.title) {
    const byTitle = current.find((event) => sameTitle(event.title, found.title!));
    if (byTitle) return byTitle;
  }
  const withCall = current.filter((event) => event.meet);
  return withCall.length === 1 && (!key || !callKey(withCall[0].meet)) ? withCall[0] : undefined;
}

// ------------------------------------------------------------ transcript --

/** One turn of the conversation: who, and what they said. */
export interface Turn {
  speaker: string;
  text: string;
  /** Seconds from the start of the recording. */
  at: number;
}

/**
 * The transcript with one stretch of speech more: put on the same speaker's
 * last turn when they are still talking, a new turn when someone else is.
 */
export function withSpeech(turns: Turn[], data: TranscriptData): Turn[] {
  const words = (data.words ?? []).map((word) => (word.text ?? '').trim()).filter(Boolean);
  if (!words.length) return turns;
  const speaker = data.participant?.name?.trim() || (data.participant?.id !== undefined ? `Speaker ${data.participant.id}` : 'Someone');
  const at = data.words?.[0]?.start_timestamp?.relative ?? (turns.length ? turns[turns.length - 1].at : 0);
  const text = words.join(' ').replace(/\s+([,.;:!?])/g, '$1');
  const last = turns[turns.length - 1];
  if (last && last.speaker === speaker) return [...turns.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
  return [...turns, { speaker, text, at }];
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

/** The transcript as it is kept: "[12:04] Priya: …" a line. */
export const transcriptText = (turns: Turn[]): string => turns.map((turn) => `[${clock(turn.at)}] ${turn.speaker}: ${turn.text}`).join('\n');

/** Who spoke, in the order they first did. */
export const speakers = (turns: Turn[]): string[] => [...new Set(turns.map((turn) => turn.speaker))];

/** How long the conversation ran, in words: a rough guide to whether it is worth writing up. */
export const wordCount = (turns: Turn[]): number => turns.reduce((count, turn) => count + turn.text.split(/\s+/).filter(Boolean).length, 0);

// --------------------------------------------------------------- writing --

/** The most of a transcript sent to the model: about two hours of talk, the end kept when it is longer. */
export const TRANSCRIPT_LIMIT = 120_000;

/** What the model is told: write the meeting up for the project's logbook, in the shape the Meetings tab reads. */
export function summaryPrompt(meeting: { title: string; start: Date; project?: string; question?: string; attendees: string[] }, turns: Turn[]): { system: string; user: string } {
  const system = [
    'You write up research meetings for a project’s logbook, from the transcript of the meeting.',
    'Write Markdown with these sections, in this order, leaving out any that would be empty:',
    '### Summary — three to six bullets: what was discussed and found, with the numbers and names that were said.',
    '### Decisions — one bullet per thing decided.',
    '### Action items — one bullet per task, as "- **Name**: the task (by when, if said)". Only tasks someone took on or was given.',
    '### Open questions — what was left unresolved.',
    'Be specific and brief. Do not invent anything that was not said; if the transcript is unclear, say less. No preamble, no closing line.',
  ].join('\n');
  let transcript = transcriptText(turns);
  if (transcript.length > TRANSCRIPT_LIMIT) transcript = `[…the start of the meeting is left out…]\n${transcript.slice(-TRANSCRIPT_LIMIT)}`;
  const context = [
    `Meeting: ${meeting.title}`,
    `When: ${meeting.start.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}`,
    meeting.project ? `Project: ${meeting.project}${meeting.question ? ` — ${meeting.question}` : ''}` : '',
    meeting.attendees.length ? `Invited: ${meeting.attendees.join(', ')}` : '',
  ].filter(Boolean);
  return { system, user: `${context.join('\n')}\n\n<transcript>\n${transcript}\n</transcript>` };
}

/** The notes of a meeting Reader recorded, as the logbook files them. */
export function recordedNote(params: { event?: Pick<CalendarEvent, 'id' | 'title' | 'start' | 'end' | 'meet' | 'attendees'>; found: DetectedMeeting; started: Date; ended: Date; turns: Turn[]; markdown: string; by: string; now?: Date }): MeetingNote {
  const { event, found, turns } = params;
  const attendees = new Set([...(event?.attendees ?? []).map((person) => person.name || person.email), ...speakers(turns).filter((name) => !/^(Speaker \d+|Someone)$/.test(name))]);
  return {
    id: newId('rec-'),
    ...(event ? { meeting: event.id } : {}),
    title: event?.title || found.title || 'Meeting',
    start: (event?.start ?? params.started).toISOString(),
    end: (event?.end ?? params.ended).toISOString(),
    source: 'reader',
    ...(event?.meet || found.url ? { call: event?.meet || found.url } : {}),
    attendees: [...attendees].filter(Boolean).slice(0, 40),
    markdown: params.markdown.trim() || '_The meeting was recorded, but there was too little said to write up._',
    transcript: transcriptText(turns),
    by: params.by,
    at: (params.now ?? new Date()).toISOString(),
  };
}
