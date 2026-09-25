import { useEffect, useRef, useState } from 'react';
import { MIN, PAD, bounds, clamp, fit } from '../lib/floatWindow';
import type { Rect, Viewport } from '../lib/floatWindow';
import { useFloatingWindow } from './FloatingWindow';
import NotesRail from './NotesRail';
import { CloseIcon, HighlighterIcon, PanelRightIcon } from './icons';

interface Props {
  paperId: string;
  selectedId: string | null;
  orphanIds: string[];
  onSelect: (id: string | null) => void;
  onClose: () => void;
  /** Put the notes back in the dock, beside the page. */
  onDock: () => void;
}

/**
 * The first place the notes window takes: a column down the right of the
 * page, narrower and shorter than Ask Claude's, so the two do not open one
 * exactly over the other.
 */
function notesStart(view: Viewport): Rect {
  const b = bounds(view);
  const w = clamp(Math.round(view.width * 0.26), MIN.w, 380);
  const h = Math.max(MIN.h, Math.round(b.h * 0.72));
  return fit({ x: b.x + b.w - w - PAD * 2, y: b.y + Math.round(b.h * 0.14), w, h }, view);
}

/**
 * The highlights and notes, lifted off the dock into a window that floats
 * over the page the way Ask Claude does: nothing under it moves, and it is
 * moved instead — by its bar, or with ⌘ + arrows while it is the window in
 * front, and thrown at an edge with ⌘⇧ + arrows.
 */
export default function NotesWindow({ paperId, selectedId, orphanIds, onSelect, onClose, onDock }: Props) {
  const [said, setSaid] = useState('');
  const { win, rectRef, floating, persist, frame, position, bar, grips } = useFloatingWindow({
    id: 'notes',
    store: 'reader.notes.window',
    name: 'Notes window',
    start: notesStart,
    say: setSaid,
  });
  const element = useRef<HTMLElement>(null);

  // Escape from inside the window closes it, as it does Ask Claude, unless a
  // note is being written, where Escape is the note's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.metaKey || event.ctrlKey) return;
      const active = document.activeElement;
      if (!element.current?.contains(active) || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section
      ref={element}
      className={`assistant-win notes-win${floating ? ' is-floating' : ' is-sheet'}`}
      data-win-style="frosted"
      style={position}
      role="dialog"
      aria-modal="false"
      aria-label="Highlights and notes"
      {...frame}
    >
      <header className="win-bar" {...bar}>
        <HighlighterIcon size={15} className="win-mark" />
        <span className="win-name">Highlights &amp; notes</span>
        <span className="win-ctl">
          {floating ? (
            <label className="win-tint" title="Window transparency">
              <span aria-hidden="true">◐</span>
              <input
                type="range"
                min={25}
                max={100}
                step={5}
                value={Math.round(win.tint * 100)}
                aria-label="Window opacity"
                onChange={(event) => persist(rectRef.current, { tint: clamp(Number(event.target.value) / 100, 0.25, 1) })}
              />
            </label>
          ) : null}
          <button type="button" className="win-btn" onClick={onDock} aria-label="Put the notes back beside the page" title="Dock beside the page">
            <PanelRightIcon size={14} />
          </button>
          <button type="button" className="win-btn" onClick={onClose} aria-label="Close the notes" title="Close (Esc, H or ⌘⇧\)">
            <CloseIcon size={14} />
          </button>
        </span>
      </header>

      <NotesRail paperId={paperId} selectedId={selectedId} orphanIds={orphanIds} onSelect={onSelect} onClose={onClose} inWindow />

      {grips.map(({ key, ...grip }) => (
        <div key={key} {...grip} />
      ))}

      <span className="vh" aria-live="polite">
        {said}
      </span>
    </section>
  );
}
