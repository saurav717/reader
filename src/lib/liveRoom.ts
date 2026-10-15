// The room a shared project is in, from the page's side: its state over
// HTTP, where everyone is over one WebSocket, your own place sent as you
// move, a jump asked for one tab and taken by it once it shows, and
// following someone (docs/live-collaboration.md). The record itself, and
// the words for it, are src/lib/presence.ts; the room is worker/projectRoom.js.
//
// One room is open at a time — the project whose page is showing — and the
// bar, the editors and the trees all read the same snapshot, so they never
// disagree about who is where.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, apiFetch, currentPass } from './api';
import { AWAY_MS, bigMove, jumpFor, type Jump, type Member, type Place, type RoomState, type SharedProject, type Tab } from './presence';
import type { GoogleUser, Paper, ProjectInfo, SharedWith } from '../types';
import type { Project } from './projects';
import { papersIn, ROLES } from './projects';

export type Status = 'off' | 'connecting' | 'live' | 'error';

/** Something that happened in the room, for a toast: someone arrived, or opened a file or a paper. */
export interface RoomEvent {
  id: number;
  who: string;
  kind: 'joined' | 'moved';
  place: Place | null;
  at: number;
}

export interface Live {
  room: string | null;
  status: Status;
  error: string | null;
  state: RoomState | null;
  /** Where you are, as the others see it. */
  mine: Place | null;
  /** Whether your place is sent at all: "Show where I am". */
  visible: boolean;
  /** Who you are following, by email. */
  following: string | null;
  events: RoomEvent[];
}

const OFF: Live = { room: null, status: 'off', error: null, state: null, mine: null, visible: true, following: null, events: [] };
let live: Live = OFF;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const set = (patch: Partial<Live>) => {
  live = { ...live, ...patch };
  emit();
};

/** The snapshot, outside React: for an effect that asks what was last sent. */
export const liveNow = () => live;

export function useLive(): Live {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => live,
    () => OFF,
  );
}

// ------------------------------------------------------------- HTTP -------

/** A project as the room keeps it: enough for every member's copy, nothing of the owner's library besides. */
export function summarize(project: Project, papers: Paper[]): SharedProject {
  const info = project.project;
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    question: info.question,
    startedAt: info.startedAt,
    papers: papersIn(project.id, papers).map((paper) => ({
      id: paper.id,
      title: paper.title,
      role: info.roles[paper.id] ?? null,
      source: paper.source,
      authors: paper.authors.slice(0, 12),
      ...(paper.published ? { published: paper.published } : {}),
      ...(paper.doi ? { doi: paper.doi } : {}),
      ...(paper.arxivId ? { arxivId: paper.arxivId } : {}),
      ...(paper.pdfUrl ? { pdfUrl: paper.pdfUrl } : {}),
    })),
    todos: info.todos,
    ...(info.overleaf ? { overleaf: info.overleaf } : {}),
    ...(info.codeRepo ? { codeRepo: info.codeRepo } : {}),
  };
}

/** A copy's project record, from the room's list: its question, roles, to-do list and links, on top of what this copy alone keeps (its playground, its meetings). */
export function fromSummary(summary: SharedProject, shared: SharedWith, had?: ProjectInfo): ProjectInfo {
  const roles: ProjectInfo['roles'] = {};
  for (const paper of summary.papers) if (paper.role && ROLES.some((role) => role.id === paper.role)) roles[paper.id] = paper.role as ProjectInfo['roles'][string];
  // A link the list no longer has is gone here too: the list is the record of it.
  const { overleaf: _overleaf, codeRepo: _codeRepo, ...kept } = had ?? { question: '', startedAt: summary.startedAt || new Date().toISOString(), roles: {}, todos: [] };
  return {
    ...kept,
    question: summary.question,
    startedAt: summary.startedAt || had?.startedAt || new Date().toISOString(),
    roles,
    todos: summary.todos,
    ...(summary.overleaf ? { overleaf: summary.overleaf as ProjectInfo['overleaf'] } : {}),
    ...(summary.codeRepo ? { codeRepo: summary.codeRepo as ProjectInfo['codeRepo'] } : {}),
    shared,
  };
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Reader’s server answered ${response.status}.`);
  return body;
}

const whoAmI = (me: GoogleUser | null) => (me ? { name: me.name, picture: me.picture } : {});

/** A room for a project (or the one it has, kept current): the owner's. */
export const createRoom = (project: SharedProject, me: GoogleUser | null, room?: string) => apiFetch('/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, room, ...whoAmI(me) }) }).then((response) => answer<RoomState>(response));

export const roomState = (room: string) => apiFetch(`/rooms/${room}`).then((response) => answer<RoomState>(response));

/**
 * Why a project is no longer this account's to be in, from the room's answer (or the live socket's) — or null when the
 * error is something else, such as the network. The words name the project, for the board.
 */
export function accessLost(error: string, project: string): string | null {
  if (/removed|not a member/i.test(error)) return `You were taken out of “${project}” by its owner.`;
  if (/no longer shared|no such room/i.test(error)) return `Its owner stopped sharing “${project}”.`;
  return null;
}

/**
 * The list sent to the room, naming the version it was built on. The room's answer, with the new version, is
 * taken as this page's state. Built on an older list than the room's, the room refuses and answers its own,
 * which is taken instead — the change this page made is let go, and the page follows the newer list. Answers
 * the state either way, or null when the room could not be reached.
 */
export async function pushProject(room: string, project: SharedProject, version: number): Promise<RoomState | null> {
  const response = await apiFetch(`/rooms/${room}/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, version }) }).catch(() => null);
  if (!response) return null;
  const body = (await response.json().catch(() => ({}))) as RoomState & { error?: string };
  if (!response.ok && !(response.status === 409 && body.room)) return null;
  if (live.room === room) set({ state: body });
  return body;
}

/** The rooms this account is in, as the server has them: to put back a project record the library lost. */
export const roomsOfMine = () => apiFetch('/rooms/mine').then((response) => answer<{ rooms: { room: string; role: string; project: string; at: number }[] }>(response)).then((body) => body.rooms);

/** An action on the room; an invitation also says whether its mail went (server/mail.js), and why not when it did not. */
export const roomAction = (room: string, action: 'project' | 'invite' | 'uninvite' | 'role' | 'link' | 'remove' | 'close', body: Record<string, unknown>) => {
  const projectId = live.room === room ? live.state?.project.id : undefined;
  return apiFetch(`/rooms/${room}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((response) => answer<RoomState & { mailed?: boolean; mailError?: string; log?: unknown }>(response))
    .then((state) => {
      // Sharing stopped: the room hands back the project's logbook, for the owner's copy to keep (src/lib/logbookStore.ts).
      if (action === 'close' && state.log && projectId) window.dispatchEvent(new CustomEvent(ROOM_CLOSED_LOG, { detail: { projectId, log: state.log } }));
      return state;
    });
};

/** Told, with the logbook, when the owner stops sharing a project. */
export const ROOM_CLOSED_LOG = 'reader:room-closed-log';

export const joinRoom = (room: string, token: string | null, me: GoogleUser | null) => apiFetch(`/rooms/${room}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...whoAmI(me) }) }).then((response) => answer<RoomState>(response));

/**
 * A project joined, taken into this library under its owner's id — so links to it work for everyone — with
 * whatever this copy already had kept. Answers the project's id.
 */
export async function adoptJoined(state: RoomState, projects: Project[], adoptCollection: (collection: { id: string; name: string; color: string; createdAt: string; project: ProjectInfo }) => Promise<void>): Promise<string> {
  const was = projects.find((item) => item.id === state.project.id);
  await adoptCollection({ id: state.project.id, name: state.project.name, color: state.project.color, createdAt: was?.createdAt ?? state.project.startedAt ?? new Date().toISOString(), project: fromSummary(state.project, { room: state.room, owner: state.owner, role: state.role }, was?.project) });
  return state.project.id;
}

export const leaveRoom = (room: string) => apiFetch(`/rooms/${room}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((response) => answer<{ ok: true }>(response));

// ----------------------------------------------------------- socket -------

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: number | undefined;
let heartbeat: number | undefined;
let lastInput = Date.now();
let me: GoogleUser | null = null;
let eventId = 0;

function liveUrl(room: string): string | null {
  let url: URL;
  try {
    url = new URL(api(`/rooms/${room}/live`), typeof location === 'undefined' ? 'http://localhost/' : location.href);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else return null;
  return url.toString();
}

const onInput = () => {
  const was = Date.now() - lastInput > AWAY_MS;
  lastInput = Date.now();
  if (was && live.mine && !live.mine.active) send({ ...live.mine, active: true }, true);
};
const onVisibility = () => {
  if (!live.mine) return;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  send({ ...live.mine, active: !hidden && Date.now() - lastInput < AWAY_MS }, true);
};

function listen(on: boolean) {
  if (typeof window === 'undefined') return;
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('keydown', onInput, true);
  window[method]('pointerdown', onInput, true);
  document[method]('visibilitychange', onVisibility);
}

function connect(room: string) {
  const url = liveUrl(room);
  const pass = currentPass();
  if (!url || !pass || typeof WebSocket === 'undefined') return set({ status: 'error', error: 'Sign in with Google to see who is here.' });
  set({ status: 'connecting' });
  let ws: WebSocket;
  try {
    // A WebSocket carries no headers of its own: the pass rides as a subprotocol, which the Worker reads as it would the Authorization header.
    ws = new WebSocket(url, ['reader-pass', pass]);
  } catch {
    return set({ status: 'error', error: 'The room could not be reached.' });
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    retry = 0;
    set({ status: 'live', error: null });
    try {
      ws.send(JSON.stringify({ type: 'hello', ...whoAmI(me) }));
    } catch {
      // closed under us
    }
    if (live.mine && live.visible) send(live.mine, true);
  };
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    let message: { type: string; state?: RoomState; who?: string; place?: Place; member?: Member; project?: SharedProject; version?: number; gone?: boolean };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // The logbook's changes, and strokes being drawn: for whoever shows the logbook (src/lib/logbookStore.ts).
    if (message.type === 'log' || message.type === 'ink') {
      roomListeners.forEach((listener) => listener(room, message as unknown as RoomMessage));
      return;
    }
    const state = live.state;
    if (message.type === 'here' && message.state) return set({ state: message.state });
    if (!state) return;
    if (message.type === 'place' && message.who && message.place) {
      const before = state.members.find((member) => member.email === message.who);
      const moved = before && bigMove(before.place, message.place) && (message.place.path || message.place.paperId) && message.place.active;
      const members = state.members.map((member) => (member.email === message.who ? { ...member, place: message.place! } : member));
      set({ state: { ...state, members }, events: moved ? [...live.events, { id: ++eventId, who: message.who, kind: 'moved' as const, place: message.place, at: Date.now() }].slice(-5) : live.events });
      if (live.following === message.who) followers.forEach((listener) => listener(jumpFor(state.project.id, message.place!), message.place!));
      return;
    }
    if (message.type === 'left' && message.who) {
      const members = message.gone ? state.members.filter((member) => member.email !== message.who) : state.members.map((member) => (member.email === message.who ? { ...member, place: null, lastSeen: Date.now(), lastPlace: member.place } : member));
      if (message.gone && message.who === state.me) return shutOut(state.room, 'You were removed from this project.');
      return set({ state: { ...state, members }, following: live.following === message.who ? null : live.following });
    }
    if (message.type === 'joined' && message.member) {
      const members = state.members.some((member) => member.email === message.member!.email) ? state.members : [...state.members, { ...message.member, place: null, lastSeen: null, lastPlace: null }];
      return set({ state: { ...state, members }, events: [...live.events, { id: ++eventId, who: message.member.email, kind: 'joined' as const, place: null, at: Date.now() }].slice(-5) });
    }
    if (message.type === 'project' && message.project) return set({ state: { ...state, project: message.project, version: message.version ?? state.version } });
    if (message.type === 'closed') return shutOut(state.room, 'This project is no longer shared.');
    if (message.type === 'members') void roomState(state.room).then((fresh) => live.room === fresh.room && set({ state: fresh })).catch(() => undefined);
  };
  const dropped = () => {
    if (socket !== ws) return;
    socket = null;
    if (live.room !== room) return;
    set({ status: 'connecting' });
    retry = Math.min(retry + 1, 6);
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => live.room === room && connect(room), 1000 * 2 ** retry);
  };
  ws.onclose = dropped;
  ws.onerror = dropped;
}

/** A message the room sent that is not about who is where: a change to the logbook, or a stroke being drawn. */
export type RoomMessage = { type: 'log' | 'ink'; [key: string]: unknown };
type RoomListener = (room: string, message: RoomMessage) => void;
const roomListeners = new Set<RoomListener>();

/** Hears the room's logbook messages; answers the way to stop. */
export function onRoomMessage(listener: RoomListener): () => void {
  roomListeners.add(listener);
  return () => roomListeners.delete(listener);
}

/** A message to the room over the open socket, when there is one: false when there is not. */
export function sendToRoom(room: string, message: Record<string, unknown>): boolean {
  if (live.room !== room || !socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** Put out of a room by its owner: the socket is closed for good, and the page is told why, still under the room's name so it knows whose project this was. */
function shutOut(room: string, error: string): void {
  closeRoom();
  set({ ...OFF, room, visible: readVisible(), status: 'error', error });
}

/** The room of the project whose page is showing. Opened once; a second call for the same room is nothing. */
export function openRoom(room: string, user: GoogleUser | null): void {
  me = user;
  if (live.room === room) return;
  closeRoom();
  set({ ...OFF, room, visible: readVisible() });
  listen(true);
  void roomState(room)
    .then((state) => live.room === room && set({ state }))
    .catch((error: Error) => live.room === room && set({ status: 'error', error: error.message }));
  connect(room);
  heartbeat = window.setInterval(() => {
    if (!live.mine) return;
    const active = Date.now() - lastInput < AWAY_MS && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    if (active !== live.mine.active || Date.now() - live.mine.at > 25_000) send({ ...live.mine, active }, true);
  }, 10_000);
}

export function closeRoom(): void {
  if (live.room === null) return;
  listen(false);
  window.clearTimeout(retryTimer);
  window.clearTimeout(sendTimer);
  window.clearInterval(heartbeat);
  const ws = socket;
  socket = null;
  try {
    ws?.close(1000, 'left the page');
  } catch {
    // closed already
  }
  live = { ...OFF, visible: live.visible };
  emit();
}

/** The room's state read again — after the share dialog changes something. */
export function refreshRoom(): void {
  const room = live.room;
  if (!room) return;
  void roomState(room)
    .then((state) => live.room === room && set({ state, status: live.status === 'error' ? 'connecting' : live.status, error: null }))
    .catch(() => undefined);
}

// ------------------------------------------------------- a room, read ----

const snapshots = new Map<string, { state: RoomState | null; at: number; listeners: Set<() => void> }>();
const SNAPSHOT_MS = 30_000;

/**
 * A room's state for the eye alone — the collaborators on a project's card or overview — read once and every
 * thirty seconds while something shows it; the room open on this page, with its live places, is answered as it is.
 */
export function useRoomSnapshot(room: string | undefined): RoomState | null {
  const open = useLive();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!room || open.room === room) return () => undefined;
      let entry = snapshots.get(room);
      if (!entry) {
        entry = { state: null, at: 0, listeners: new Set() };
        snapshots.set(room, entry);
      }
      entry.listeners.add(listener);
      const ask = () => {
        const here = snapshots.get(room);
        if (!here || Date.now() - here.at < SNAPSHOT_MS) return;
        here.at = Date.now();
        void roomState(room)
          .then((state) => {
            here.state = state;
            here.listeners.forEach((fn) => fn());
          })
          .catch(() => undefined);
      };
      ask();
      const timer = window.setInterval(ask, SNAPSHOT_MS);
      return () => {
        window.clearInterval(timer);
        entry!.listeners.delete(listener);
      };
    },
    [room, open.room],
  );
  const snapshot = useSyncExternalStore(subscribe, () => (room ? snapshots.get(room)?.state ?? null : null), () => null);
  if (room && open.room === room) return open.state;
  return snapshot;
}

// ------------------------------------------------------------ my place ----

let sendTimer: number | undefined;
function send(place: Place, now: boolean) {
  const stamped = { ...place, at: Date.now() };
  set({ mine: stamped });
  if (!live.visible) return;
  const go = () => {
    window.clearTimeout(sendTimer);
    sendTimer = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'place', place: live.mine }));
      } catch {
        // closed under us
      }
    }
  };
  if (now) go();
  else if (!sendTimer) sendTimer = window.setTimeout(go, 150);
}

/**
 * Where you are, from the page showing it: the tab, the file and line, or
 * the paper. A new tab, file or paper is sent at once; the caret moving is
 * coalesced to one message every 150 ms.
 */
export function reportPlace(place: Omit<Place, 'active' | 'at'>): void {
  if (!live.room) return;
  const next: Place = { ...place, active: Date.now() - lastInput < AWAY_MS && !(typeof document !== 'undefined' && document.visibilityState === 'hidden'), at: Date.now() };
  send(next, bigMove(live.mine, next));
}

const VISIBLE_KEY = 'reader.live.visible';
function readVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== 'off';
  } catch {
    return true;
  }
}
/** "Show where I am": off, the others see you in the room with no place. */
export function setVisible(visible: boolean): void {
  try {
    localStorage.setItem(VISIBLE_KEY, visible ? 'on' : 'off');
  } catch {
    // only a preference
  }
  set({ visible });
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'place', place: visible && live.mine ? live.mine : { tab: live.mine?.tab ?? 'overview', active: true } }));
    } catch {
      // closed
    }
  }
}

// -------------------------------------------------------------- jumps -----

type JumpListener = (jump: Jump) => void;
const jumpListeners = new Set<JumpListener>();
let pending: Jump | null = null;

/** A jump asked for: the tab that shows next takes it (`takeJump`), or one already showing hears it (`onJump`). */
export function requestJump(jump: Jump): void {
  pending = jump;
  jumpListeners.forEach((listener) => listener(jump));
}

/** The jump waiting for this tab, if any, taken. */
export function takeJump(tab: Tab, projectId?: string): Jump | null {
  if (!pending || pending.tab !== tab || (projectId && pending.projectId !== projectId)) return null;
  const jump = pending;
  pending = null;
  return jump;
}

/** A listener for jumps to a tab already showing; it takes the jump itself. */
export function onJump(listener: JumpListener): () => void {
  jumpListeners.add(listener);
  return () => jumpListeners.delete(listener);
}

// ------------------------------------------------------------- follow -----

type FollowListener = (jump: Jump, place: Place) => void;
const followers = new Set<FollowListener>();

export function follow(email: string | null): void {
  set({ following: email });
  if (!email || !live.state) return;
  const member = live.state.members.find((item) => item.email === email);
  if (member?.place) followers.forEach((listener) => listener(jumpFor(live.state!.project.id, member.place!), member.place!));
}

/** Hears every move of the person followed, as a jump to make. */
export function onFollow(listener: FollowListener): () => void {
  followers.add(listener);
  return () => followers.delete(listener);
}

/** Typing, or any edit of your own, ends following: the editor is yours again. */
export function noteEdit(): void {
  if (live.following) set({ following: null });
}

export function dismissEvent(id: number): void {
  set({ events: live.events.filter((event) => event.id !== id) });
}

// -------------------------------------------------------------- hooks -----

/** The other members in a file on a tab: for the editor's carets and the tree's chips. */
export interface Peer {
  id: string;
  name: string;
  color: string;
  place: Place;
}
const NO_PEERS: Peer[] = [];
export function usePeers(tab: Tab, path?: string | null): Peer[] {
  const { state } = useLive();
  if (!state) return NO_PEERS;
  const peers = state.members.filter((member) => member.email !== state.me && member.place && member.place.tab === tab && (!path || member.place.path === path)).map((member) => ({ id: member.email, name: member.name, color: member.color, place: member.place! }));
  return peers.length ? peers : NO_PEERS;
}

/** Jumps for a tab while it is showing: the listener opens the file or paper and goes to the line. */
export function useJumps(tab: Tab, projectId: string | undefined, take: (jump: Jump) => void): void {
  const handle = useCallback(
    (jump: Jump) => {
      if (jump.tab !== tab || (projectId && jump.projectId !== projectId)) return;
      pending = null;
      take(jump);
    },
    [tab, projectId, take],
  );
  useEffect(() => {
    const waiting = takeJump(tab, projectId);
    if (waiting) take(waiting);
    return onJump(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);
}
