import { useEffect, useRef, useState } from 'react';
import { MIN, PAD, bounds, clamp, fit } from '../lib/floatWindow';
import type { Rect, Viewport } from '../lib/floatWindow';
import type { Paper } from '../types';
import { useFloatingWindow } from './FloatingWindow';
import Reader from './Reader';
import { BookIcon, ChevronDownIcon, CloseIcon, PanelRightIcon } from './icons';

/** The first place the paper takes: the left half of the page, over the code's file tree and the start of its editor. */
function paperStart(view: Viewport): Rect {
  const b = bounds(view);
  const w = clamp(Math.round(b.w * 0.46), MIN.w, 760);
  const h = Math.max(MIN.h, Math.round(b.h * 0.86));
  return fit({ x: b.x + PAD * 2, y: b.y + Math.round(b.h * 0.08), w, h }, view);
}

/**
 * A paper of a project in a window of its own, over the project's code in
 * full-code mode: moved by its bar, resized from any edge, faded with its
 * slider so the code shows through, and switched to another of the project's
 * papers from the bar. Nothing under it moves.
 */
export default function PaperWindow({
  paper,
  papers,
  onPick,
  onDock,
  onOpenFull,
  onClose,
}: {
  paper: Paper;
  /** The project's papers, to switch between from the bar. */
  papers: Paper[];
  onPick: (id: string) => void;
  /** Put the paper beside the code instead. */
  onDock: () => void;
  /** The paper on a page of its own. */
  onOpenFull: () => void;
  onClose: () => void;
}) {
  const [said, setSaid] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { win, rectRef, floating, persist, frame, position, bar, grips } = useFloatingWindow({
    id: 'project-paper',
    store: 'reader.project.paper.window',
    name: 'Paper window',
    start: paperStart,
    say: setSaid,
  });
  const element = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.metaKey || event.ctrlKey) return;
      const active = document.activeElement;
      if (!element.current?.contains(active) || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section
      ref={element}
      className={`assistant-win paper-win${floating ? ' is-floating' : ' is-sheet'}`}
      data-win-style="frosted"
      style={position}
      role="dialog"
      aria-modal="false"
      aria-label={`Paper: ${paper.title}`}
      {...frame}
    >
      <header className="win-bar" {...bar}>
        <BookIcon size={15} className="win-mark" />
        {/* As wide as the title shown, not the longest one in the list (a bare select's width): the rest of the bar is for dragging. */}
        <span className="paper-win-pick" title="Another paper of the project">
          <span className="paper-win-pick-name">{paper.title}</span>
          <ChevronDownIcon size={12} />
          <select value={paper.id} onChange={(event) => onPick(event.target.value)} aria-label="Which paper" onPointerDown={(event) => event.stopPropagation()}>
            {papers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </span>
        <span className="win-ctl">
          {floating ? (
            <label className="win-tint" title="See the code through it">
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
          <button type="button" className="win-btn" onClick={onOpenFull} aria-label="Open the paper on its own page" title="Open on its own page">
            <BookIcon size={14} />
          </button>
          <button type="button" className="win-btn" onClick={onDock} aria-label="Put the paper beside the code" title="Beside the code">
            <PanelRightIcon size={14} />
          </button>
          <button type="button" className="win-btn" onClick={onClose} aria-label="Close the paper" title="Close (Esc)">
            <CloseIcon size={14} />
          </button>
        </span>
      </header>

      <div className="paper-win-body">
        <Reader
          key={paper.id}
          paperId={paper.id}
          notesOpen={false}
          selectedHighlightId={selected}
          onBack={onClose}
          onToggleNotes={onOpenFull}
          onNotes={() => undefined}
          onToggleSidebar={() => undefined}
          zen={false}
          onToggleZen={onOpenFull}
          onSelectHighlight={setSelected}
          onOrphans={() => undefined}
        />
      </div>

      {grips.map(({ key, ...grip }) => (
        <div key={key} {...grip} />
      ))}

      <span className="vh" aria-live="polite">
        {said}
      </span>
    </section>
  );
}
