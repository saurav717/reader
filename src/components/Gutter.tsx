// A handle between two panes, dragged to share the room between them: the
// file tree and the editor, the editor and the side pane, the editor and the
// terminal below. A double click puts it back where it started.

import { useRef } from 'react';

export default function Gutter({ axis, label, className, onStart, onMove, onEnd, onReset }: { axis: 'x' | 'y'; label: string; className?: string; onStart: () => void; onMove: (delta: number) => void; onEnd?: () => void; onReset: () => void }) {
  const from = useRef<number | null>(null);
  return (
    <div
      className={`pg-gutter is-${axis}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label} — drag; double-click to reset`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        from.current = axis === 'x' ? event.clientX : event.clientY;
        document.body.classList.add(axis === 'x' ? 'is-dragging-x' : 'is-dragging-y');
        onStart();
      }}
      onPointerMove={(event) => {
        if (from.current === null) return;
        onMove((axis === 'x' ? event.clientX : event.clientY) - from.current);
      }}
      onPointerUp={(event) => {
        if (from.current === null) return;
        from.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove('is-dragging-x', 'is-dragging-y');
        onEnd?.();
      }}
      onDoubleClick={onReset}
    />
  );
}

/** How a project's panes are laid out: kept in this browser, the same for every project. */
export interface PaneLayout {
  /** The file tree's width; 0 when folded away. */
  tree: number;
  /** The side pane's width: Sync, Runtime, Metrics. */
  side: number;
  /** The side pane's width while it shows the agent, which wants more room. */
  agent: number;
  /** The console's share of the editor's column, in percent. */
  console: number;
  /** The side pane on the left of the editor rather than the right. */
  sideLeft: boolean;
  /** A pane given the room: the console over the editor, or the side pane over most of the width. */
  big: 'console' | 'side' | null;
}

export const DEFAULT_LAYOUT: PaneLayout = { tree: 252, side: 380, agent: 560, console: 32, sideLeft: false, big: null };
const LAYOUT_KEY = 'reader.pgLayout';
const clamp = (value: unknown, low: number, high: number, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback);

/** A layout read back: anything odd or out of range made sensible. */
export function readLayout(raw: unknown): PaneLayout {
  const value = raw && typeof raw === 'object' ? (raw as Partial<PaneLayout>) : {};
  return {
    tree: clamp(value.tree, 0, 600, DEFAULT_LAYOUT.tree),
    side: clamp(value.side, 260, 1400, DEFAULT_LAYOUT.side),
    agent: clamp(value.agent, 300, 1400, DEFAULT_LAYOUT.agent),
    console: clamp(value.console, 12, 88, DEFAULT_LAYOUT.console),
    sideLeft: value.sideLeft === true,
    big: value.big === 'console' || value.big === 'side' ? value.big : null,
  };
}

export function loadLayout(): PaneLayout {
  try {
    return readLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: PaneLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // private mode: the default next time
  }
}

/** The tree dragged narrower than this folds away. */
export const TREE_FOLD = 96;
