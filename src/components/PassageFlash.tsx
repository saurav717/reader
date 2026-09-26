import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PassageLook } from '../types';
import { CloseIcon, SparkleIcon } from './icons';

/** How long the mark stays before it fades, unless the pointer is on its caption. */
const LINGER_MS = 9000;
const FADE_MS = 600;

export interface Flash {
  /** The passage on the page; none when only its page could be shown. */
  range?: Range;
  label: string;
  /** "3.2 Model selection · page 4". */
  where?: string;
  /** Rects outside this element are not drawn — the passage has scrolled out of the pane. */
  clip?: HTMLElement | null;
  /** When nothing can be drawn over the text, the caption sits at the top of this element instead. */
  anchor?: HTMLElement | null;
  /** Changes for every new flash, so the same passage shown twice starts again. */
  key: number;
  /** Its number in the answer's list, shown on the caption as it is in the chat. */
  n?: number;
}

const LINGER_S = LINGER_MS / 1000;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A passage Claude pointed at, marked on the page for a few seconds: a band of
 * the accent colour over each line of it, and a caption above the first line
 * saying what it is. Drawn on a layer of its own over the page, never in the
 * text, and re-measured every frame, so it follows the passage as the page
 * scrolls, turns or reflows, and leaves nothing behind.
 */
export default function PassageFlash({ flash, look = 'marker', onDone }: { flash: Flash; look?: PassageLook; onDone: () => void }) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [holding, setHolding] = useState(false);
  const held = useRef(false);

  useEffect(() => {
    setLeaving(false);
    let frame = 0;
    const measure = () => {
      const range = flash.range;
      if (range) {
        const clip = flash.clip?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
        const next: Box[] = [];
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width < 2 || rect.height < 2) continue;
          if (rect.bottom < clip.top || rect.top > clip.bottom || rect.right < clip.left || rect.left > clip.right) continue;
          // One band per line: pdf.js and inline markup give many rects to a line.
          const line = next.find((box) => Math.abs(box.top - rect.top) < rect.height / 2);
          if (line) {
            const right = Math.max(line.left + line.width, rect.right);
            line.left = Math.min(line.left, rect.left);
            line.width = right - line.left;
            line.height = Math.max(line.height, rect.height);
          } else next.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
          if (next.length > 60) break;
        }
        setBoxes((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    let fade = 0;
    let done = 0;
    const leave = () => {
      if (held.current) {
        fade = window.setTimeout(leave, 1500);
        return;
      }
      setLeaving(true);
      done = window.setTimeout(onDone, FADE_MS);
    };
    fade = window.setTimeout(leave, LINGER_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fade);
      window.clearTimeout(done);
      window.removeEventListener('keydown', onKey);
    };
    // A new flash is a new key; the callbacks may change without restarting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash.key]);

  const first = boxes[0];
  const anchor = !flash.range ? flash.anchor?.getBoundingClientRect() : null;
  const last = boxes[boxes.length - 1];
  // The passage as one box: what the spotlight lights and the outline frames.
  const around = boxes.length
    ? boxes.reduce(
        (box, next) => {
          const right = Math.max(box.left + box.width, next.left + next.width);
          const bottom = Math.max(box.top + box.height, next.top + next.height);
          const left = Math.min(box.left, next.left);
          const top = Math.min(box.top, next.top);
          return { left, top, width: right - left, height: bottom - top };
        },
        { ...boxes[0] },
      )
    : null;
  // Lined up with the passage's left edge, not its first word, which can end a line;
  // above it when there is room, else under it, with the pointer towards it.
  const CARD = 360;
  const left = around ? Math.max(8, Math.min(around.left - 6, window.innerWidth - CARD - 8)) : 0;
  const above = first ? first.top > 110 : true;
  const place: React.CSSProperties | null = first
    ? above
      ? { left, top: first.top - 14, transform: 'translateY(-100%)' }
      : { left, top: last.top + last.height + 14 }
    : anchor
      ? { left: anchor.left + anchor.width / 2, top: anchor.top + 14, transform: 'translateX(-50%)' }
      : null;
  const pointer = around ? Math.max(14, Math.min(around.left + 18 - left, CARD - 24)) : null;

  return createPortal(
    <div className={`passage-flash look-${look}${leaving ? ' is-leaving' : ''}`} aria-live="polite">
      {look === 'spotlight' && around ? (
        <div className="passage-spot" style={{ left: around.left - 10, top: around.top - 8, width: around.width + 20, height: around.height + 16 }} />
      ) : null}
      {look === 'outline' && around ? (
        <div className="passage-frame" style={{ left: around.left - 12, top: around.top - 8, width: around.width + 24, height: around.height + 16 }} />
      ) : null}
      {boxes.map((box, index) => (
        <div
          key={index}
          className="passage-band"
          style={{ left: box.left - 3, top: box.top - 1, width: box.width + 6, height: box.height + 2, animationDelay: `${index * 110}ms, ${index * 110 + 500}ms` }}
        />
      ))}
      {place ? (
        <div
          className={`passage-tag${above ? ' is-above' : ' is-below'}${first ? '' : ' is-floating'}${holding ? ' is-held' : ''}`}
          style={{ ...place, ...(pointer !== null && first ? { ['--pointer' as string]: `${pointer}px` } : {}), ['--linger' as string]: `${LINGER_S}s` }}
          role="status"
          onPointerEnter={() => {
            held.current = true;
            setHolding(true);
          }}
          onPointerLeave={() => {
            held.current = false;
            setHolding(false);
          }}
        >
          <span className="passage-badge" aria-hidden="true">
            {flash.n ?? <SparkleIcon size={13} />}
          </span>
          <span className="passage-text">
            <span className="passage-eyebrow">
              <SparkleIcon size={11} /> Ask AI points here
            </span>
            <b>{flash.label}</b>
            {flash.where ? (
              <span className="passage-where">
                {flash.where.split(' · ').map((part) => (
                  <i key={part}>{part}</i>
                ))}
              </span>
            ) : null}
          </span>
          <button type="button" aria-label="Clear the highlight" onClick={onDone}>
            <CloseIcon size={13} />
          </button>
          <span className="passage-time" aria-hidden="true" />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
