import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { OPEN_NOTES } from '../lib/notes';
import { NoteIcon } from './icons';

// ===========================================================================
//  Keeping a piece of a page in your notes: the "Add to notes" button that
//  comes up on the corner of whatever keepable thing the pointer is over,
//  and the line that says it was kept. The Explain page, the reflowed paper
//  and the PDF set as a book all use them, each with what it counts as
//  keepable and how it copies it.
// ===========================================================================

/**
 * The corner button. `selector` says what can be kept whole under `root`;
 * the page's scrolling, anywhere, puts the button away, since it no longer
 * sits on what it would keep.
 */
export function useKeeper({ root, selector, onKeep, off = false }: { root: RefObject<HTMLElement>; selector: string; onKeep: (element: HTMLElement) => void; off?: boolean }) {
  const [at, setAt] = useState<{ element: HTMLElement; top: number; right: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const away = () => setAt(null);
    document.addEventListener('scroll', away, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', away, { capture: true });
  }, [at]);
  useEffect(() => {
    if (off) setAt(null);
  }, [off]);

  const onMouseOver = (event: ReactMouseEvent) => {
    if (off) return;
    const found = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    if (!found || !root.current?.contains(found)) return;
    // Something keepable inside something keepable — an equation in a caveat — is kept with what holds it.
    let element = found;
    for (let outer = element.parentElement?.closest<HTMLElement>(selector); outer && root.current.contains(outer); outer = outer.parentElement?.closest<HTMLElement>(selector)) element = outer;
    if (at?.element === element) return;
    const rect = element.getBoundingClientRect();
    setAt({ element, top: Math.max(rect.top + 6, 56), right: window.innerWidth - rect.right + 6 });
  };
  const onMouseLeave = (event: ReactMouseEvent) => {
    if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.note-clip-btn'))) setAt(null);
  };

  const button =
    at && at.element.isConnected ? (
      <button
        type="button"
        className="note-clip-btn"
        style={{ top: at.top, right: at.right }}
        onClick={() => {
          onKeep(at.element);
          setAt(null);
        }}
        onMouseLeave={(event) => {
          if (!(event.relatedTarget instanceof Node && at.element.contains(event.relatedTarget))) setAt(null);
        }}
        title="Keep this in your notes"
      >
        <NoteIcon size={14} /> Add to notes
      </button>
    ) : null;

  return { onMouseOver, onMouseLeave, button };
}

/** The line at the bottom that says what was kept, with a way to the notes. */
export function useKept() {
  const [kept, setKept] = useState<{ label: string; at: number } | null>(null);
  useEffect(() => {
    if (!kept) return;
    const timer = window.setTimeout(() => setKept(null), 3200);
    return () => window.clearTimeout(timer);
  }, [kept]);
  const toast = kept ? (
    <div className="note-kept" role="status" key={kept.at}>
      <span>
        <b>{kept.label}</b> added to your notes
      </span>
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_NOTES))}>
        Open notes
      </button>
    </div>
  ) : null;
  return { announce: (label: string) => setKept({ label, at: Date.now() }), toast };
}

/** A table as Markdown, a row a line. */
export function tableText(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'), (row) => Array.from(row.children, (cell) => (cell.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|')));
  return rows.map((cells, index) => `| ${cells.join(' | ')} |${index === 0 ? `\n|${cells.map(() => ' --- |').join('')}` : ''}`).join('\n');
}
