// A project's logbook: what a project keeps besides its papers and code — the
// notes of its meetings, the links that come up and would otherwise be lost
// in a chat, a notepad, and a whiteboard to draw on with a pen or a stylus.
// The page is src/components/Logbook.tsx; where it is kept is
// src/lib/logbookStore.ts — the project's room on the Worker when it is shared
// (worker/logbook.js), so every member reads and writes the same one, and this
// browser alone when it is not.
//
// What is here is the record and the arithmetic on it, with no network and no
// DOM, so scripts/logbook.test.mjs can pin it.

/** The notes of one meeting: filed by Granola once the meeting ended, or written in by hand. */
export interface MeetingNote {
  id: string;
  /** The calendar event it is of (lib/calendar.ts, `CalendarEvent.id`), when it came from one. */
  meeting?: string;
  title: string;
  /** When the meeting was, ISO. */
  start: string;
  end?: string;
  source: 'granola' | 'manual';
  /** The notes in Granola's web app. */
  url?: string;
  /** The meeting's call, for "Join" on the next one of a series. */
  call?: string;
  attendees: string[];
  /** The notes, as Markdown. */
  markdown: string;
  /** Who filed them, and when. */
  by: string;
  at: string;
}

/** A link kept for the project: a doc, a dataset, a recording — what was shared in a meeting and is needed again a week later. */
export interface ProjectLink {
  id: string;
  url: string;
  title: string;
  note: string;
  pinned: boolean;
  by: string;
  at: string;
  /** The meeting note it was found in, when it came from one. */
  from?: string;
}

/** The project's notepad: one text, with the version a change is made on (as the room's list is). */
export interface Notepad {
  text: string;
  version: number;
  by?: string;
  at?: string;
}

export type InkTool = 'pen' | 'marker';

/**
 * One stroke on the whiteboard. Strokes are only ever added or taken away
 * whole, never changed, so two people drawing at once never collide: each
 * stroke has its own id, and the board is the set of them.
 */
export interface Stroke {
  id: string;
  by: string;
  color: string;
  /** The width at full pressure, in board units. */
  width: number;
  tool: InkTool;
  /** x, y, pressure (0–1) for each point, flat, in board units. */
  points: number[];
  at: string;
}

export interface Logbook {
  notes: MeetingNote[];
  links: ProjectLink[];
  pad: Notepad;
  strokes: Stroke[];
}

export const EMPTY_LOGBOOK: Logbook = { notes: [], links: [], pad: { text: '', version: 0 }, strokes: [] };

/** The board's own size: strokes are kept in these units, and drawn scaled to the screen. */
export const BOARD = { width: 1600, height: 1000 };

export const LOGBOOK_TABS = [
  { id: 'meetings', label: 'Meetings', note: 'The notes of every meeting for this project' },
  { id: 'links', label: 'Links', note: 'Docs, datasets and recordings — and the links that came up in meetings' },
  { id: 'notepad', label: 'Notepad', note: 'One page of notes the whole project writes in' },
  { id: 'board', label: 'Whiteboard', note: 'Draw with a pen, a stylus or a mouse' },
] as const;

export type LogbookTab = (typeof LOGBOOK_TABS)[number]['id'];

export const isLogbookTab = (value: unknown): value is LogbookTab => LOGBOOK_TABS.some((tab) => tab.id === value);

export const newId = (prefix = ''): string => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ----------------------------------------------------------------- notes ---

/** The notes newest meeting first. */
export const notesInOrder = (notes: MeetingNote[]): MeetingNote[] => [...notes].sort((a, b) => b.start.localeCompare(a.start) || b.at.localeCompare(a.at));

/** `notes` with `note` in place of the one with its id — or of the one of the same meeting from the same source — or added. */
export function withNote(notes: MeetingNote[], note: MeetingNote): MeetingNote[] {
  return notesInOrder([...notes.filter((item) => item.id !== note.id && !(note.meeting && item.meeting === note.meeting && item.source === note.source)), note]);
}

/** Whether a meeting already has its notes filed: by the event, or by Granola's note. */
export const hasNotesFor = (notes: MeetingNote[], meeting: string, noteId?: string): boolean => notes.some((note) => note.meeting === meeting || (noteId !== undefined && note.id === noteId));

/**
 * The action items in a meeting's notes: unchecked boxes (`- [ ] …`), and the
 * items of a list under a heading that says so ("Action items", "Next steps",
 * "To do", "Follow-ups"), the way Granola writes its summaries.
 */
export function actionItems(markdown: string): string[] {
  const items: string[] = [];
  let under = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,6}\s+|\*\*)(.+?)(\*\*)?:?$/.exec(line);
    if (heading && !/^[-*+]\s/.test(line)) {
      under = /\b(action items?|next steps?|to-?dos?|follow[- ]?ups?|tasks)\b/i.test(heading[2]);
      continue;
    }
    const box = /^[-*+]\s+\[ \]\s+(.+)$/.exec(line);
    if (box) {
      items.push(clean(box[1]));
      continue;
    }
    if (/^[-*+]\s+\[x\]/i.test(line)) continue;
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (under && bullet) items.push(clean(bullet[1]));
    else if (under && line && !bullet) under = false;
  }
  return [...new Set(items.filter(Boolean))];
}

const clean = (text: string) =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();

// ----------------------------------------------------------------- links ---

export type LinkKind = 'doc' | 'sheet' | 'slides' | 'drive' | 'code' | 'paper' | 'data' | 'video' | 'design' | 'notes' | 'write' | 'call' | 'web';

const KINDS: [RegExp, LinkKind, string][] = [
  [/docs\.google\.com\/document/, 'doc', 'Google Doc'],
  [/docs\.google\.com\/spreadsheets/, 'sheet', 'Google Sheet'],
  [/docs\.google\.com\/presentation/, 'slides', 'Google Slides'],
  [/drive\.google\.com/, 'drive', 'Google Drive'],
  [/colab\.research\.google\.com/, 'code', 'Colab'],
  [/(^|\.)github\.com|gitlab\.com|bitbucket\.org/, 'code', 'Code'],
  [/(^|\.)arxiv\.org|openreview\.net|doi\.org|semanticscholar\.org|aclanthology\.org|proceedings\./, 'paper', 'Paper'],
  [/huggingface\.co\/datasets|kaggle\.com|zenodo\.org|figshare\.com/, 'data', 'Dataset'],
  [/huggingface\.co/, 'code', 'Hugging Face'],
  [/(^|\.)zoom\.us\/rec|youtube\.com|youtu\.be|vimeo\.com|loom\.com/, 'video', 'Recording'],
  [/figma\.com|miro\.com|excalidraw\.com|canva\.com/, 'design', 'Design'],
  [/notion\.so|notes\.granola\.ai|hackmd\.io|dropbox\.com\/paper/, 'notes', 'Notes'],
  [/overleaf\.com/, 'write', 'Overleaf'],
  [/meet\.google\.com|(^|\.)zoom\.us\/(j|my|w)\/|teams\.microsoft\.com|\.webex\.com/, 'call', 'Call'],
];

/** What kind of thing a link is, and its name for a person, from where it points. */
export function linkKind(url: string): { kind: LinkKind; label: string } {
  let at: string;
  try {
    const parsed = new URL(url);
    at = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`.toLowerCase();
  } catch {
    return { kind: 'web', label: 'Link' };
  }
  for (const [pattern, kind, label] of KINDS) if (pattern.test(at)) return { kind, label };
  return { kind: 'web', label: 'Website' };
}

/** A link as a person would want it named: the host and the end of the path, when nothing better is known. */
export function linkTitle(url: string): string {
  try {
    const parsed = new URL(url);
    // GitHub: the repository, and the pull request or issue when it is one.
    const github = /^\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues)\/(\d+))?/.exec(parsed.pathname);
    if (parsed.hostname.replace(/^www\./, '') === 'github.com' && github) return `${github[1]}/${github[2]}${github[4] ? ` #${github[4]}` : ''}`;
    const tail = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const words = decodeURIComponent(tail).replace(/[-_+]+/g, ' ').replace(/\.(pdf|html?)$/i, '').trim();
    const host = parsed.hostname.replace(/^www\./, '');
    return words && words.length >= 2 && !/^[\w-]{20,}$/.test(tail) ? `${words} · ${host}` : host;
  } catch {
    return url;
  }
}

/** A link put in a canonical form, so the same thing pasted twice is kept once: https, no tracking, no trailing slash or fragment. */
export function sameUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid|gclid|usp$|ouid$)/.test(key)) parsed.searchParams.delete(key);
    return `${parsed.protocol === 'http:' ? 'https:' : parsed.protocol}//${parsed.host.replace(/^www\./, '').toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

/** A link as typed: with a scheme put on when it has none, or null when it is not one. */
export function linkFrom(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Every link in a meeting's notes — bare, or in Markdown's `[name](url)` — with
 * the name it was given there, or the line it was on: the links that came up
 * in the meeting, which the Links tab offers to keep. The meeting's own call is
 * not one of them.
 */
export function linksIn(markdown: string, skip: string[] = []): { url: string; title: string }[] {
  const seen = new Set(skip.map(sameUrl));
  const found: { url: string; title: string }[] = [];
  for (const line of markdown.split('\n')) {
    const named = new Map<string, string>();
    for (const match of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) named.set(match[2], match[1]);
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) {
      const url = match[0].replace(/[.,;:!?]+$/, '');
      const key = sameUrl(url);
      if (seen.has(key) || linkKind(url).kind === 'call') continue;
      seen.add(key);
      // A line that is a label and then the link ("Dataset: https://…") names it; a link in the middle of a sentence does not.
      const after = line.slice((match.index ?? 0) + match[0].length).replace(/^[\s.,;:!?)]+/, '');
      const context = after ? '' : clean(line.slice(0, match.index).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[-*+#>\s\d.)]+/, '')).replace(/[:\-–—\s(]+$/, '');
      found.push({ url, title: named.get(url) ?? (context.length >= 3 && context.length <= 60 ? context : linkTitle(url)) });
    }
  }
  return found;
}

/** The links the meetings brought up that are not kept yet, newest meeting first, each with the note it came from. */
export function suggestedLinks(notes: MeetingNote[], links: ProjectLink[], dismissed: string[] = []): { url: string; title: string; from: MeetingNote }[] {
  const kept = new Set([...links.map((link) => sameUrl(link.url)), ...dismissed.map(sameUrl)]);
  const out: { url: string; title: string; from: MeetingNote }[] = [];
  for (const note of notesInOrder(notes)) {
    for (const link of linksIn(note.markdown, note.call ? [note.call] : [])) {
      const key = sameUrl(link.url);
      if (kept.has(key)) continue;
      kept.add(key);
      out.push({ ...link, from: note });
    }
  }
  return out;
}

/** `links` with one in place of the one with its id, or added; pinned first, then newest. */
export function withLink(links: ProjectLink[], link: ProjectLink): ProjectLink[] {
  return linksInOrder([...links.filter((item) => item.id !== link.id), link]);
}

export const linksInOrder = (links: ProjectLink[]): ProjectLink[] => [...links].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at.localeCompare(a.at));

// --------------------------------------------------------------- notepad ---

/**
 * A notepad change made on an older version than the room's, put on top of
 * the newer one: the one stretch the person changed (between what is the same
 * at the start and at the end) is put where the same surroundings are in the
 * newer text. Two people typing in different places both keep what they
 * typed; only where both changed the very same stretch does the later one's
 * text go in beside the other's, rather than over it.
 */
export function mergePad(base: string, mine: string, theirs: string): string {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  let start = 0;
  while (start < base.length && start < mine.length && base[start] === mine[start]) start++;
  let end = 0;
  while (end < base.length - start && end < mine.length - start && base[base.length - 1 - end] === mine[mine.length - 1 - end]) end++;
  const before = base.slice(0, start);
  const removed = base.slice(start, base.length - end);
  const after = base.slice(base.length - end);
  const inserted = mine.slice(start, mine.length - end);
  // Where the stretch is in theirs: the same text before it, nearest the place it was.
  const at = locate(theirs, before, removed, after, start);
  if (at) return theirs.slice(0, at.from) + inserted + theirs.slice(at.to);
  // Both changed it: keep theirs, and put mine in after it on a line of its own.
  const anchor = Math.min(theirs.length, start);
  const lineEnd = theirs.indexOf('\n', anchor);
  const cut = lineEnd === -1 ? theirs.length : lineEnd;
  return `${theirs.slice(0, cut)}\n${inserted}${theirs.slice(cut)}`;
}

function locate(text: string, before: string, removed: string, after: string, near: number): { from: number; to: number } | null {
  const tail = before.slice(-40);
  const head = after.slice(0, 40);
  const candidates: number[] = [];
  for (let i = text.indexOf(tail + removed + head); i !== -1; i = text.indexOf(tail + removed + head, i + 1)) candidates.push(i + tail.length);
  if (!candidates.length) return null;
  const from = candidates.reduce((best, i) => (Math.abs(i - near) < Math.abs(best - near) ? i : best));
  return { from, to: from + removed.length };
}

// ------------------------------------------------------------------- ink ---

export const INK_COLORS = ['#1a1a17', '#2d64a0', '#c0392b', '#1f8a70', '#b27414', '#8a3a6e'];
export const INK_WIDTHS = [2, 4, 8];

/**
 * A stroke's points thinned before it is kept: a point closer than `minGap`
 * to the last one kept is dropped (the pen sends hundreds a second), and the
 * numbers are rounded, so a page of handwriting stays small enough to send.
 */
export function thinPoints(points: number[], minGap = 1.5): number[] {
  if (points.length <= 6) return points.map(round);
  const out = [points[0], points[1], points[2]];
  for (let i = 3; i < points.length; i += 3) {
    const [x, y] = [points[i], points[i + 1]];
    const last = out.length - 3;
    const isEnd = i + 3 >= points.length;
    if (!isEnd && Math.hypot(x - out[last], y - out[last + 1]) < minGap) continue;
    out.push(x, y, points[i + 2]);
  }
  return out.map(round);
}

const round = (value: number, index?: number) => (index !== undefined && index % 3 === 2 ? Math.round(value * 100) / 100 : Math.round(value * 10) / 10);

/** The width of a stroke at a point, from the pen's pressure: a mouse (always 0.5) draws the middle width. */
export const pressureWidth = (width: number, pressure: number, tool: InkTool): number => (tool === 'marker' ? width * 3 : width * (0.35 + 1.3 * Math.max(0, Math.min(1, pressure || 0.5))));

/** Whether a stroke passes within `radius` of a point: what the eraser takes away. */
export function strokeNear(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const reach = radius + stroke.width / 2;
  const p = stroke.points;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= reach;
  for (let i = 0; i + 3 < p.length; i += 3) if (segmentDistance(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach) return true;
  return false;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The board as an SVG, for Download: every stroke as a path, the marker's translucent. */
export function boardSvg(strokes: Stroke[], background = '#ffffff'): string {
  const paths = strokes
    .map((stroke) => {
      const p = stroke.points;
      if (!p.length) return '';
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 3; i < p.length; i += 3) d += ` L${p[i]} ${p[i + 1]}`;
      if (p.length === 3) d += ` L${p[0] + 0.1} ${p[1]}`;
      const width = pressureWidth(stroke.width, averagePressure(p), stroke.tool);
      return `<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${width.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"${stroke.tool === 'marker' ? ' stroke-opacity="0.35"' : ''}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD.width} ${BOARD.height}" width="${BOARD.width}" height="${BOARD.height}"><rect width="100%" height="100%" fill="${background}"/>${paths}</svg>`;
}

function averagePressure(points: number[]): number {
  let sum = 0;
  let count = 0;
  for (let i = 2; i < points.length; i += 3) (sum += points[i]), count++;
  return count ? sum / count : 0.5;
}
