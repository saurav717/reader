// ===========================================================================
//  A figure, close up. Click a diagram Claude drew on the Explain or the
//  Implementation page — or a scene, on the step it is on — and it lifts off
//  the page and grows from where it sits to the middle of the window, as
//  large as the window allows, with its caption under it and the rest of the
//  page dimmed behind. Tab, or the arrow keys, go on to the next figure on
//  the page; Esc, or a click beside it, puts it back where it came from.
//  Figures are SVG, so the close-up is drawn afresh at the larger size, not
//  scaled up from pixels: the type in it stays sharp.
// ===========================================================================
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, NoteIcon } from './icons';

/** One of the drawings on the page that can be looked at close up. */
export interface CloseUpVisual {
  /** The figure or the scene card on the page, for what is kept in the notes. */
  element: HTMLElement;
  /** The drawing itself, whose place the close-up grows from and returns to. */
  art: HTMLElement;
  kind: 'figure' | 'scene';
  /** The section it is in. */
  section: string;
  caption: string;
  /** The drawing, as SVG — cleaned by DOMPurify before it was put on the page, or drawn by the page itself. */
  svg: string;
  /** Width over height, from the viewBox, so the close-up has the drawing's own proportions. */
  aspect: number;
}

/** What on the page is a drawing: a figure's SVG, or a scene's. The page's own icons — in buttons, in headers — are not. */
export const CLOSEUP_ART = '.explain-figure .figure-art:not(.drawing), .explain-motion .motion-art:not(.drawing)';

function aspectOf(svg: SVGSVGElement, art: HTMLElement): number {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) return viewBox[2] / viewBox[3];
  const rect = svg.getBoundingClientRect().width ? svg.getBoundingClientRect() : art.getBoundingClientRect();
  return rect.height > 0 ? rect.width / rect.height : 16 / 9;
}

/** Every drawing on the page, in reading order. */
export function closeUpVisuals(root: HTMLElement | null): CloseUpVisual[] {
  if (!root) return [];
  const visuals: CloseUpVisual[] = [];
  for (const art of Array.from(root.querySelectorAll<HTMLElement>(CLOSEUP_ART))) {
    const svg = art.querySelector<SVGSVGElement>(':scope > svg');
    if (!svg) continue;
    const scene = art.matches('.motion-art');
    const element = art.closest<HTMLElement>(scene ? '.explain-motion' : '.explain-figure');
    if (!element) continue;
    const caption = scene
      ? [element.querySelector('.motion-title')?.textContent?.trim(), element.querySelector('.motion-caption')?.textContent?.trim()].filter(Boolean).join(' — ')
      : (element.querySelector('figcaption')?.textContent?.trim() ?? '');
    visuals.push({
      element,
      art,
      kind: scene ? 'scene' : 'figure',
      section: art.closest<HTMLElement>('.explain-section')?.dataset.title ?? '',
      caption,
      svg: svg.outerHTML,
      aspect: aspectOf(svg, art),
    });
  }
  return visuals;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** How large the drawing is in the close-up: as large as the window allows, with room for the caption and the keys, and never smaller than it is on the page. */
function sizeFor(visual: CloseUpVisual): { width: number; height: number } {
  const narrow = window.innerWidth < 720;
  const roomWidth = window.innerWidth - (narrow ? 32 : 120);
  const roomHeight = window.innerHeight - (narrow ? 170 : 230);
  let width = Math.max(240, Math.min(roomWidth, roomHeight * visual.aspect));
  // A figure already wider on the page than the window's height allows stays at least that wide.
  const onPage = visual.art.getBoundingClientRect().width;
  if (onPage > width) width = Math.min(roomWidth, onPage);
  return { width: Math.round(width), height: Math.round(width / visual.aspect) };
}

/**
 * The close-up itself, over the whole window: the drawing at `index` among
 * `visuals`, grown from its place on the page. `onKeep` keeps the figure in
 * the notes, as the corner button on the page does.
 */
export default function FigureCloseUp({ visuals, index, onIndex, onClose, onKeep }: { visuals: CloseUpVisual[]; index: number; onIndex: (index: number) => void; onClose: () => void; onKeep?: (element: HTMLElement) => void }) {
  const visual = visuals[index];
  const cardRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => (visual ? sizeFor(visual) : { width: 0, height: 0 }));
  const [leaving, setLeaving] = useState(false);
  const opened = useRef<HTMLElement | null>(null);
  const [stepped, setStepped] = useState(0);

  useEffect(() => {
    if (!visual) return;
    const fit = () => setSize(sizeFor(visual));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [visual]);

  // The drawing lifts off the page: the card starts where the drawing is, at its size, and settles in the middle.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const art = artRef.current;
    if (!card || !art || !visual || opened.current === visual.art) return;
    const first = opened.current === null;
    opened.current = visual.art;
    if (!first) {
      // On to the next: a quick fade, not a flight across the page.
      setStepped((n) => n + 1);
      return;
    }
    if (reducedMotion()) return;
    const from = visual.art.getBoundingClientRect();
    const to = art.getBoundingClientRect();
    if (!to.width || !to.height) return;
    card.style.transition = 'none';
    card.style.transformOrigin = 'top left';
    card.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    card.style.opacity = '0.7';
    requestAnimationFrame(() => {
      card.style.transition = '';
      card.style.transform = '';
      card.style.opacity = '';
    });
  }, [visual, size]);

  // Back where it came from: the card shrinks to the drawing's place, then goes.
  const close = () => {
    if (leaving) return;
    const card = cardRef.current;
    const art = artRef.current;
    if (!card || !art || !visual || reducedMotion()) {
      onClose();
      return;
    }
    const from = visual.art.getBoundingClientRect();
    const to = art.getBoundingClientRect();
    // The drawing it grew from has gone from the page (rewritten since): nowhere to shrink to.
    if (!from.width || !from.height || !to.width || !to.height) {
      onClose();
      return;
    }
    setLeaving(true);
    card.style.transformOrigin = 'top left';
    card.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    card.style.opacity = '0';
    window.setTimeout(onClose, 240);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const step = (by: number) => {
        event.preventDefault();
        if (visuals.length > 1) onIndex((index + by + visuals.length) % visuals.length);
      };
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') step(event.shiftKey ? -1 : 1);
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') step(1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visuals, index, onIndex, leaving]);

  // The close-up takes the focus, and gives it back to the drawing it grew from.
  useEffect(() => {
    const was = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    bodyRef.current?.focus({ preventScroll: true });
    return () => {
      (opened.current ?? was)?.focus?.({ preventScroll: true });
    };
  }, []);

  if (!visual) return null;
  const label = visual.kind === 'scene' ? 'Scene' : 'Figure';
  return createPortal(
    <div className={`figure-closeup${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label={`Close-up of ${visual.kind === 'scene' ? 'the scene' : 'the figure'}${visual.caption ? `: ${visual.caption}` : ''}`}>
      <div className="figure-closeup-back" onClick={close} />
      <div className="figure-closeup-body" ref={bodyRef} tabIndex={-1} style={{ width: size.width }}>
        <div className="figure-closeup-head">
          <span className="figure-closeup-title" title={visual.section || undefined}>
            {label} {index + 1} of {visuals.length}
            {visual.section ? ` · ${visual.section}` : ''}
          </span>
          {visuals.length > 1 ? (
            <span className="figure-closeup-dots" aria-hidden="true">
              {visuals.map((other, at) => (
                <i key={at} className={at === index ? 'on' : undefined} onClick={() => onIndex(at)} title={other.caption || `${other.kind === 'scene' ? 'Scene' : 'Figure'} ${at + 1}`} />
              ))}
            </span>
          ) : null}
          <span className="figure-closeup-tools">
            {onKeep ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  onKeep(visual.element);
                  close();
                }}
                title={`Keep this ${visual.kind} in your notes`}
              >
                <NoteIcon size={13} /> Add to notes
              </button>
            ) : null}
            <button type="button" className="btn sm" onClick={close} aria-label="Back to the page" title="Back to the page (Esc)">
              <CloseIcon size={14} />
            </button>
          </span>
        </div>
        <div key={stepped} className={`figure-closeup-card${stepped ? ' is-stepped' : ''}`} ref={cardRef}>
          <div ref={artRef} className={`closeup-art ${visual.kind === 'scene' ? 'motion-art is-scene' : 'figure-art'}`} style={{ width: size.width, height: size.height }} dangerouslySetInnerHTML={{ __html: visual.svg }} />
          {visual.caption ? <p className="figure-closeup-caption">{visual.caption}</p> : null}
        </div>
        <div className="pdf-zoom-chip figure-closeup-chip">
          <b>Close-up</b> {index + 1} of {visuals.length}
          {visuals.length > 1 ? (
            <>
              {' '}
              <span className="sep" /> <kbd>⇥</kbd> next <kbd>⇧⇥</kbd> back
            </>
          ) : null}{' '}
          <span className="sep" /> <kbd>Esc</kbd> back to the page
        </div>
      </div>
    </div>,
    document.body,
  );
}
