import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { STICKY_COLORS, markText, removeNote, updateNote } from '../lib/notes';
import type { NoteBlock, NotePin, StickyColor } from '../lib/notes';

type Sticky = Extract<NoteBlock, { kind: 'text' }> & { pin: NotePin };

/** The stickies of a paper, numbered in reading order: by page, then down it. */
export function stickiesOf(blocks: NoteBlock[]): { sticky: Sticky; number: number }[] {
  return blocks
    .filter((block): block is Sticky => block.kind === 'text' && Boolean(block.pin))
    .sort((a, b) => a.pin.page - b.pin.page || a.pin.y - b.pin.y || a.pin.x - b.pin.x)
    .map((sticky, index) => ({ sticky, number: index + 1 }));
}

const CARD_W = 196;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Pin({
  paperId,
  sticky,
  number,
  width,
  height,
  open,
  fresh,
  onToggle,
}: {
  paperId: string;
  sticky: Sticky;
  number: number;
  width: number;
  height: number;
  open: boolean;
  fresh: boolean;
  onToggle: () => void;
}) {
  // Where the marker is while it is dragged; written to the note when it is let go.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (fresh) text.current?.focus();
  }, [fresh]);

  const at = drag ?? { x: sticky.pin.x, y: sticky.pin.y };
  const left = at.x * width;
  const top = at.y * height;
  // The card beside the marker, on whichever side has room, and kept on the page.
  const onRight = left + 18 + CARD_W < width || left < width / 2;
  const cardLeft = Math.max(4, Math.min(width - CARD_W - 4, onRight ? left + 18 : left - 18 - CARD_W));
  const cardTop = Math.max(4, Math.min(height - 120, top - 14));
  const color: StickyColor = sticky.color ?? 'yellow';

  const onDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { px: event.clientX, py: event.clientY, x: sticky.pin.x, y: sticky.pin.y, moved: false };
  };
  const onMove = (event: ReactPointerEvent) => {
    const from = start.current;
    if (!from) return;
    const dx = event.clientX - from.px;
    const dy = event.clientY - from.py;
    if (!from.moved && Math.hypot(dx, dy) < 4) return;
    from.moved = true;
    setDrag({ x: Math.min(0.98, Math.max(0.02, from.x + dx / width)), y: Math.min(0.98, Math.max(0.02, from.y + dy / height)) });
  };
  const onUp = () => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    if (!from.moved) onToggle();
    else if (drag) markText(paperId, sticky.id, { pin: { page: sticky.pin.page, x: drag.x, y: drag.y } });
    setDrag(null);
  };

  return (
    <>
      <button
        type="button"
        className={`pdf-pin is-${color}${open ? ' is-open' : ''}`}
        style={{ left, top }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label={`Sticky ${number}${open ? ', open' : ''}`}
        title={open ? 'Click to fold it away · drag to move it' : 'Click to open it · drag to move it'}
      >
        {number}
      </button>
      {open ? (
        <div
          className={`pdf-sticky is-${color}`}
          style={{ left: cardLeft, top: cardTop, width: CARD_W }}
          onDoubleClick={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          data-sticky={sticky.id}
        >
          <div className="pdf-sticky-head">
            <b>{number}</b>
            <span className="pdf-sticky-colors">
              {STICKY_COLORS.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`is-${choice}`}
                  aria-pressed={choice === color}
                  aria-label={`${choice[0].toUpperCase()}${choice.slice(1)}`}
                  onClick={() => markText(paperId, sticky.id, { color: choice })}
                />
              ))}
            </span>
            <button type="button" className="pdf-sticky-x" onClick={() => removeNote(paperId, sticky.id)} aria-label="Delete this sticky" title="Delete">
              ×
            </button>
          </div>
          <textarea
            ref={text}
            value={sticky.md}
            placeholder="Write on the page…"
            aria-label={`Sticky ${number}`}
            onChange={(event) => updateNote(paperId, sticky.id, { md: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                event.currentTarget.blur();
              }
            }}
          />
          <div className="pdf-sticky-foot">
            <span>
              p. {sticky.pin.page}
              {sticky.source?.section ? ` · ${sticky.source.section}` : ''}
            </span>
            <span>{time(sticky.at)}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The stickies on one page of the PDF: a numbered marker where each was put, and its card beside it. */
export default function PagePins({
  paperId,
  page,
  stickies,
  width,
  height,
  folded,
  fresh,
  onToggle,
}: {
  paperId: string;
  page: number;
  stickies: { sticky: Sticky; number: number }[];
  width: number;
  height: number;
  folded: Set<string>;
  fresh: string | null;
  onToggle: (id: string) => void;
}) {
  const here = stickies.filter(({ sticky }) => sticky.pin.page === page);
  if (!here.length) return null;
  return (
    <div className="pdf-pins">
      {here.map(({ sticky, number }) => (
        <Pin
          key={sticky.id}
          paperId={paperId}
          sticky={sticky}
          number={number}
          width={width}
          height={height}
          open={!folded.has(sticky.id)}
          fresh={fresh === sticky.id}
          onToggle={() => onToggle(sticky.id)}
        />
      ))}
    </div>
  );
}
