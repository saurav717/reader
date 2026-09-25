// ===========================================================================
//  Notes: what you write about a paper, and what you keep from its Explain
//  page — a passage, a whole section, a diagram, a code cell and its output,
//  a table, an equation, a caveat. One list of pieces per paper, in the order
//  you put them, kept in IndexedDB the way the explanation is.
//
//  A piece taken from Explain is a copy of it as it was drawn: the maths
//  typeset, the code coloured, the diagram still a drawing that follows the
//  theme. It is a copy on purpose. The explanation rewrites itself when asked
//  to, and what you kept should not change under you when it does.
// ===========================================================================

import { useEffect, useSyncExternalStore } from 'react';
import { db } from './db';
import { cleanClip } from './sanitize';

/** Where a kept piece came from, so it can be shown there again. */
export interface NoteSource {
  from: 'explain';
  /** The Explain section it was in. */
  section?: string;
  /** Words from it to find it by. */
  quote?: string;
}

export type NoteBlock =
  | { id: string; kind: 'text'; md: string; at: string }
  | {
      id: string;
      kind: 'clip';
      /** What it is: "Passage", "Diagram", "Code", "Table", "Equation", "Caveat · Superseded", "Section"… */
      label: string;
      /** The piece as it was drawn, cleaned. */
      html: string;
      /** The same as text — Markdown where it has any, TeX for maths — for export and search. */
      text: string;
      /** A line of your own under it. */
      note?: string;
      source: NoteSource;
      at: string;
    };

export type NoteClip = Extract<NoteBlock, { kind: 'clip' }>;

interface Kept {
  blocks: NoteBlock[];
}

const KEY = (paperId: string) => `notes:${paperId}`;
const EMPTY: NoteBlock[] = [];

const cache = new Map<string, NoteBlock[]>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export function subscribeNotes(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function load(paperId: string) {
  if (cache.has(paperId) || loading.has(paperId)) return;
  loading.add(paperId);
  try {
    const kept = await db.getKv<Kept>(KEY(paperId));
    // Something added while this was being read is kept, after what was read.
    const added = cache.get(paperId) ?? [];
    cache.set(paperId, [...(kept?.blocks ?? []), ...added.filter((block) => !kept?.blocks.some((old) => old.id === block.id))]);
  } catch {
    if (!cache.has(paperId)) cache.set(paperId, []);
  } finally {
    loading.delete(paperId);
    changed();
  }
}

function put(paperId: string, blocks: NoteBlock[]) {
  cache.set(paperId, blocks);
  changed();
  void db.setKv(KEY(paperId), { blocks } satisfies Kept).catch(() => undefined);
}

/** A paper's notes, read from IndexedDB the first time they are asked for. */
export function useNotes(paperId: string): NoteBlock[] {
  useEffect(() => {
    if (paperId) void load(paperId);
  }, [paperId]);
  return useSyncExternalStore(subscribeNotes, () => (paperId ? cache.get(paperId) ?? EMPTY : EMPTY));
}

export const notesFor = (paperId: string) => cache.get(paperId) ?? EMPTY;

const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Asks for the notes to be opened, the way H opens them. */
export const OPEN_NOTES = 'reader:open-notes';
/** Asks for the Explain page to be opened, and for a place on it to be shown (a `NoteSource`). */
export const OPEN_EXPLAIN = 'reader:open-explain';
export const SHOW_IN_EXPLAIN = 'reader:explain-show';

/** Sent when something is added, so the notes can show it: `{ paperId, id }`. */
export const NOTE_ADDED = 'reader:note-added';

function add(paperId: string, block: NoteBlock) {
  put(paperId, [...notesFor(paperId), block]);
  void load(paperId);
  window.dispatchEvent(new CustomEvent(NOTE_ADDED, { detail: { paperId, id: block.id } }));
  return block;
}

export function addText(paperId: string, md = ''): NoteBlock {
  return add(paperId, { id: newId(), kind: 'text', md, at: new Date().toISOString() });
}

export function addClip(paperId: string, clip: Omit<NoteClip, 'id' | 'kind' | 'at'>): NoteBlock {
  return add(paperId, { ...clip, id: newId(), kind: 'clip', at: new Date().toISOString() });
}

export function updateNote(paperId: string, id: string, patch: { md?: string; note?: string }) {
  put(
    paperId,
    notesFor(paperId).map((block) => (block.id !== id ? block : block.kind === 'text' ? { ...block, md: patch.md ?? block.md } : { ...block, note: patch.note ?? block.note })),
  );
}

export function removeNote(paperId: string, id: string) {
  put(
    paperId,
    notesFor(paperId).filter((block) => block.id !== id),
  );
}

/** One place up (-1) or down (+1) the list. */
export function moveNote(paperId: string, id: string, by: -1 | 1) {
  const blocks = [...notesFor(paperId)];
  const from = blocks.findIndex((block) => block.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= blocks.length) return;
  [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
  put(paperId, blocks);
}

// ---------------------------------------------------------------------------
// Taking a copy of what is on the page
// ---------------------------------------------------------------------------

/** What is taken out of a copy: the page's own controls, and what only means anything live. */
const CONTROLS = 'button, .caret, .revised-pill, .note-clip-btn, input, select, textarea';

/**
 * A copy of part of the page, safe to keep and draw again: its controls and
 * ids taken out, and cleaned again — a little more strictly than the page
 * was, since a copy is kept for good and drawn without the page around it:
 * nothing that fetches, frames or restyles. The diagram's SVG and KaTeX's
 * maths come through as they are.
 */
export function copyOf(source: Node | DocumentFragment): string {
  const holder = document.createElement('div');
  holder.appendChild(source instanceof DocumentFragment ? source : source.cloneNode(true));
  holder.querySelectorAll(CONTROLS).forEach((element) => element.remove());
  holder.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  // Nothing in a copy may pass for a place on the page it came from.
  holder.querySelectorAll('[data-section], [data-title]').forEach((element) => {
    element.removeAttribute('data-section');
    element.removeAttribute('data-title');
  });
  return cleanClip(holder.innerHTML);
}

// ---------------------------------------------------------------------------
// As Markdown, for the export
// ---------------------------------------------------------------------------

/**
 * Code in a fence that the code cannot close: a run of backticks one longer
 * than the longest run inside it, and never fewer than three.
 */
function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function notesMarkdown(blocks: NoteBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      if (block.md.trim()) lines.push(block.md.trim(), '');
      continue;
    }
    const where = block.source.section ? ` — Explain · ${block.source.section}` : ' — Explain';
    // The label is one line of bold; a newline in it would end the bold
    // early and start something else on the next line.
    lines.push(`**${block.label.replace(/\s*[\r\n]+\s*/g, ' ').trim()}**${where}`, '');
    const code = /^(Code|Output)/.test(block.label);
    lines.push(code ? fenced(block.text.trim()) : block.text.trim().replace(/^/gm, '> '), '');
    if (block.note?.trim()) lines.push(block.note.trim(), '');
  }
  return lines.join('\n');
}
