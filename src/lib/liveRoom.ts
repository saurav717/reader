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
    papers: papersIn(project.id, papers).map((paper) => ({ id: paper.id, title: paper.title, role: info.roles[paper.id] ?? null })),
    todos: info.todos,
    ...(info.overleaf ? { overleaf: info.overleaf } : {}),
    ...(info.codeRepo ? { codeRepo: info.codeRepo } : {}),
  };
}

/** A member's project record, from the room's summary: the owner's question, roles and to-do list, on top of what this copy already keeps (its playground, say). */
export function fromSummary(summary: SharedProject, shared: SharedWith, had?: ProjectInfo): ProjectInfo {
  const roles: ProjectInfo['roles'] = {};
  for (const paper of summary.papers) if (paper.role && ROLES.some((role) => role.id === paper.role)) roles[paper.id] = paper.role as ProjectInfo['roles'][string];
  return {
    ...(had ?? { question: '', startedAt: summary.startedAt || new Date().toISOString(), roles: {}, todos: [] }),
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

export const roomAction = (room: string, action: 'project' | 'invite' | 'uninvite' | 'role' | 'link' | 'remove', body: Record<string, unknown>) =>
  apiFetch(`/rooms/${room}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => answer<RoomState>(response));

export const joinRoom = (room: string, token: string | null, me: GoogleUser | null) => apiFetch(`/rooms/${room}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...whoAmI(me) }) }).then((response) => answer<RoomState>(response));

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
    let message: { type: string; state?: RoomState; who?: string; place?: Place; member?: Member; project?: SharedProject; gone?: boolean };
    try {
      message = JSON.parse(String(event.data));
    } catch {
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
      if (message.gone && message.who === state.me) return closeRoom(), set({ status: 'error', error: 'You were removed from this project.' });
      return set({ state: { ...state, members }, following: live.following === message.who ? null : live.following });
    }
    if (message.type === 'joined' && message.member) {
      const members = state.members.some((member) => member.email === message.member!.email) ? state.members : [...state.members, { ...message.member, place: null, lastSeen: null, lastPlace: null }];
      return set({ state: { ...state, members }, events: [...live.events, { id: ++eventId, who: message.member.email, kind: 'joined' as const, place: null, at: Date.now() }].slice(-5) });
    }
    if (message.type === 'project' && message.project) return set({ state: { ...state, project: message.project } });
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
