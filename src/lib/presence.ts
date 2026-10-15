// Working on a project together: where each person in it is, as a record
// the pages send and the bar reads (docs/live-collaboration.md). What is
// here needs no network and no DOM — the socket, the stores and the hooks
// are src/lib/liveRoom.ts — so it can be tested on its own.

import type { View } from '../types.view';

export type Tab = 'overview' | 'read' | 'code' | 'write' | 'logbook';
export type Role = 'owner' | 'editor' | 'viewer';

/** Where someone is in a project: which tab, and what in it. */
export interface Place {
  tab: Tab;
  /** The file open, on the Code or Write tab; on the Logbook, which of its tabs (meetings, links, notepad, board). */
  path?: string;
  line?: number;
  col?: number;
  /** The caret's offset in the file, for drawing it in someone else's editor. */
  offset?: number;
  /** Offsets selected, when something is. */
  sel?: [number, number];
  /** The paper open, on the Read tab (or beside the code). */
  paperId?: string;
  title?: string;
  page?: number;
  /** False after a minute without a key or a click, or with the tab hidden. */
  active: boolean;
  /** When this was true (the room's clock). */
  at: number;
}

export interface Member {
  email: string;
  role: Role;
  name: string;
  picture?: string;
  color: string;
  joinedAt: string;
  /** Where they are now, or null when their page is closed. */
  place: Place | null;
  /** When they were last here, and where, once they have left. */
  lastSeen: number | null;
  lastPlace: Place | null;
}

export interface Invitation {
  email: string;
  role: Role;
  by: string;
  at: string;
  /** The tag a link carries for this address (never the address): `&for=`. */
  tag?: string;
}

export interface JoinLink {
  token: string;
  on: boolean;
  domain: string;
}

/** A project as its room keeps it, for every member's copy. */
export interface SharedProject {
  id: string;
  name: string;
  color: string;
  question: string;
  startedAt: string;
  /** Each paper by id, with its role — and enough of it for a member's library to take it in without a lookup. */
  papers: { id: string; title: string; role: string | null; source?: string; authors?: string[]; published?: string; doi?: string; arxivId?: string; pdfUrl?: string }[];
  todos: { id: string; text: string; done: boolean }[];
  overleaf?: unknown;
  codeRepo?: unknown;
}

/** What the room answers a member: who is in it, and where. */
export interface RoomState {
  room: string;
  owner: string;
  /** The list's version: up by one with each change; a change sent names the one it was built on. */
  version?: number;
  project: SharedProject;
  me: string;
  role: Role;
  members: Member[];
  invitations?: Invitation[];
  link?: JoinLink | null;
}

/** Members' colours, by join order: the room's own list (worker/projectRoom.js), repeated here for a member the room has no colour for. */
export const PALETTE = ['#8a3a6e', '#b27414', '#2d64a0', '#1f8a70', '#a0462d', '#5a3ea8'];

/** How long after the last key or click someone is still "here now" rather than away. */
export const AWAY_MS = 60_000;

export const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', read: 'Read', code: 'Code', write: 'Write', logbook: 'Logbook' };

const SECTION_LABEL: Record<string, string> = { meetings: 'Meetings', links: 'Links', notepad: 'Notepad', board: 'Whiteboard' };

const fileName = (path: string) => path.split('/').pop() || path;

/** Where someone is, in words: "Code · train.py · line 42". */
export function describePlace(place: Place | null | undefined): string {
  if (!place) return 'not here';
  const parts = [TAB_LABEL[place.tab]];
  if (place.tab === 'logbook' && place.path && SECTION_LABEL[place.path]) parts.push(SECTION_LABEL[place.path]);
  else if ((place.tab === 'code' || place.tab === 'write') && place.path) {
    parts.push(fileName(place.path));
    if (place.line) parts.push(`line ${place.line}`);
  } else if (place.paperId) {
    parts.push(place.title || 'a paper');
    if (place.page) parts.push(`p. ${place.page}`);
  }
  return parts.join(' · ');
}

/** The same, shorter, for a chip: the file, or the paper's title. */
export function shortPlace(place: Place | null | undefined): string {
  if (!place) return '';
  if (place.tab === 'logbook') return place.path && SECTION_LABEL[place.path] ? SECTION_LABEL[place.path] : TAB_LABEL.logbook;
  if ((place.tab === 'code' || place.tab === 'write') && place.path) return `${fileName(place.path)}${place.line ? `:${place.line}` : ''}`;
  if (place.paperId) return `${place.title || 'a paper'}${place.page ? `, p. ${place.page}` : ''}`;
  return TAB_LABEL[place.tab];
}

/** Whether two places are the same destination: a move between them is worth telling the room, or following. */
export function samePlace(a: Place | null | undefined, b: Place | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.tab === b.tab && a.path === b.path && a.line === b.line && a.col === b.col && a.offset === b.offset && a.paperId === b.paperId && a.page === b.page && a.active === b.active && (a.sel?.[0] ?? -1) === (b.sel?.[0] ?? -1) && (a.sel?.[1] ?? -1) === (b.sel?.[1] ?? -1);
}

/** Whether a move is one to tell the room at once (a new tab, file or paper) rather than coalesce with the next. */
export function bigMove(from: Place | null | undefined, to: Place): boolean {
  if (!from) return true;
  return from.tab !== to.tab || from.path !== to.path || from.paperId !== to.paperId || from.active !== to.active;
}

/** A member who is here, away, or gone, as the bar colours them. */
export type Presence = 'here' | 'away' | 'gone';
export function presenceOf(member: Pick<Member, 'place'>, now = Date.now()): Presence {
  if (!member.place) return 'gone';
  return member.place.active && now - member.place.at < AWAY_MS * 10 ? 'here' : 'away';
}

/** The members in the order the bar shows them: here first, then away, then gone; the owner first among equals. */
export function orderMembers<T extends Pick<Member, 'place' | 'role' | 'joinedAt' | 'lastSeen'>>(members: T[], now = Date.now()): T[] {
  const rank = { here: 0, away: 1, gone: 2 };
  return [...members].sort((a, b) => rank[presenceOf(a, now)] - rank[presenceOf(b, now)] || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0) || a.joinedAt.localeCompare(b.joinedAt));
}

/** Initials for an avatar with no picture: "Priya Natarajan" → "PN"; an email → its first letter. */
export function initials(name: string): string {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** What a jump to a place does: the view to open, and what to do once it is open. */
export interface Jump {
  projectId: string;
  tab: Tab;
  path?: string;
  line?: number;
  col?: number;
  offset?: number;
  sel?: [number, number];
  paperId?: string;
}

export function jumpFor(projectId: string, place: Place): Jump {
  const jump: Jump = { projectId, tab: place.tab };
  if (place.path) jump.path = place.path;
  if (place.line) jump.line = place.line;
  if (place.col) jump.col = place.col;
  if (place.offset !== undefined) jump.offset = place.offset;
  if (place.sel) jump.sel = place.sel;
  if (place.paperId) jump.paperId = place.paperId;
  return jump;
}

/** The view a jump opens: the project on the tab the place is on. */
export function viewFor(jump: Pick<Jump, 'projectId' | 'tab' | 'path'>): View {
  if (jump.tab === 'overview') return { kind: 'project', id: jump.projectId };
  if (jump.tab === 'logbook') return { kind: 'project', id: jump.projectId, mode: 'logbook', ...(jump.path ? { section: jump.path } : {}) };
  return { kind: 'project', id: jump.projectId, mode: jump.tab === 'code' ? 'workspace' : jump.tab };
}

/**
 * A place as a link carries it, after the project's address: `path:line` on
 * the Code and Write tabs, `paper:<id>` on Read. Read back by `atFrom`.
 */
export function atParam(place: Place): string | null {
  if ((place.tab === 'code' || place.tab === 'write') && place.path) return `${place.path}${place.line ? `:${place.line}` : ''}`;
  if (place.tab === 'read' && place.paperId) return `paper:${place.paperId}`;
  return null;
}

export function atFrom(projectId: string, tab: Tab, at: string | null | undefined): Jump | null {
  if (!at) return null;
  if (at.startsWith('paper:')) return at.length > 6 ? { projectId, tab: 'read', paperId: at.slice(6) } : null;
  const match = /^(.*?)(?::(\d+))?$/.exec(at);
  if (!match || !match[1]) return null;
  const line = match[2] ? Number(match[2]) : undefined;
  return { projectId, tab: tab === 'write' ? 'write' : 'code', path: match[1], ...(line && line > 0 ? { line } : {}) };
}

/** The colour a member has, or the one their place in the list would give them. */
export const colorOf = (member: Pick<Member, 'color'> | undefined, index = 0) => member?.color || PALETTE[index % PALETTE.length];

/** "4 min ago", "yesterday 18:40", for when someone was last here. */
export function whenSeen(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'never';
  const gap = now - at;
  if (gap < 60_000) return 'just now';
  if (gap < 3_600_000) return `${Math.round(gap / 60_000)} min ago`;
  if (gap < 86_400_000) return `${Math.round(gap / 3_600_000)} h ago`;
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (gap < 2 * 86_400_000) return `yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}
