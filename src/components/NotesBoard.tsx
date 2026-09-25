import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { addText, notesMarkdown, removeNote, sourceName, textLabel, updateNote, useNotes } from '../lib/notes';
import type { NoteBlock } from '../lib/notes';
import { CARD_W, clampZoom, fitView, placeNew, tidyBySection, topZ, useBoardLayout, zoomAt } from '../lib/board';
import type { BoardView, Place } from '../lib/board';
import { cleanClip } from '../lib/sanitize';
import { showSource } from './NotesList';
import MarkdownNote from './MarkdownNote';
import { saveMarkdown } from './NotesIndex';
import { CloseIcon, DownloadIcon, ExplainIcon, FileIcon, NoteIcon, PlusIcon, TrashIcon } from './icons';

interface Props {
  paperId: string;
  title: string;
  onClose: () => void;
}

const MIN_W = 180;
const MIN_H = 80;
const MINI_W = 180;
const MINI_H = 112;
const START: BoardView = { x: 0, y: 0, zoom: 1 };

/** What a pointer is doing on the board, from the moment it went down. */
type Gesture =
  | { kind: 'pan'; x: number; y: number; from: BoardView }
  | { kind: 'move'; id: string; x: number; y: number; from: Place }
  | { kind: 'size'; id: string; x: number; y: number; from: Place; height: number }
  | { kind: 'label'; id: string; x: number; y: number; from: { x: number; y: number } };

/** Things on the board that are not the board: a pointer on them does not pan it. */
const NOT_BOARD = '.board-card, .board-label, .board-tools, .board-mini, .board-zoom';

function Card({
  block,
  place,
  selected,
  fresh,
  onPointerDown,
  onSize,
  onSelect,
  onShowSource,
  measure,
  paperId,
}: {
  block: NoteBlock;
  place: Place | undefined;
  selected: boolean;
  fresh: boolean;
  onPointerDown: (event: ReactPointerEvent, block: NoteBlock) => void;
  onSize: (event: ReactPointerEvent, block: NoteBlock) => void;
  onSelect: () => void;
  onShowSource: () => void;
  measure: (id: string, element: HTMLElement | null) => void;
  paperId: string;
}) {
  const html = useMemo(() => (block.kind === 'clip' ? cleanClip(block.html) : ''), [block]);
  const sized = place?.h !== undefined;

  return (
    <article
      ref={(element) => measure(block.id, element)}
      className={`board-card is-${block.kind}${block.kind === 'text' && block.pin ? ` is-sticky is-${block.color ?? 'yellow'}` : ''}${selected ? ' is-selected' : ''}${sized ? ' is-sized' : ''}${place ? '' : ' is-unplaced'}`}
      style={place ? { left: place.x, top: place.y, width: place.w, height: place.h, zIndex: place.z } : { width: CARD_W }}
      onPointerDown={onSelect}
      data-id={block.id}
    >
      <header className="board-card-head" onPointerDown={(event) => onPointerDown(event, block)} title="Drag to move it on the board">
        <span className="board-grip" aria-hidden="true">
          ⋮⋮
        </span>
        <span className="board-card-kind">{block.kind === 'text' ? textLabel(block) : block.label}</span>
        <button type="button" className="icon-btn sm" onClick={() => removeNote(paperId, block.id)} aria-label="Delete from your notes" title="Delete from your notes">
          <TrashIcon size={13} />
        </button>
      </header>
      {block.kind === 'text' ? (
        <MarkdownNote md={block.md} focus={fresh} className="board-write" onChange={(md) => updateNote(paperId, block.id, { md })} />
      ) : (
        <>
          <div className="board-card-body note-clip" dangerouslySetInnerHTML={{ __html: html }} />
          {block.note ? <p className="board-card-note">{block.note}</p> : null}
          <footer className="board-card-foot">
            <button type="button" className="note-source" onClick={onShowSource} title={block.source.from === 'explain' ? 'Show it in the explanation' : 'Show it in the paper'}>
              {block.source.from === 'explain' ? <ExplainIcon size={12} /> : <FileIcon size={12} />} {sourceName(block.source)}
            </button>
          </footer>
        </>
      )}
      <span className="board-size" onPointerDown={(event) => onSize(event, block)} aria-hidden="true" title="Drag to resize" />
    </article>
  );
}

/**
 * A paper's notes, full screen: each piece a card, moved by its bar,
 * sized by its corner, the board panned by dragging it (or the wheel) and
 * zoomed with ⌘/Ctrl + the wheel. Double-clicking the board writes a new
 * note there. Where the cards are is the board's alone: the list in the pane
 * keeps its own order.
 */
export default function NotesBoard({ paperId, title, onClose }: Props) {
  const blocks = useNotes(paperId);
  const { layout, ready, update } = useBoardLayout(paperId);
  const view = layout.view ?? START;
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // How big the board is on the screen.
  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // How tall each card is drawn — what a card not yet sized by hand takes up.
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Map<string, HTMLElement>());
  if (!observer.current && typeof ResizeObserver !== 'undefined') {
    observer.current = new ResizeObserver((entries) => {
      setHeights((current) => {
        let next = current;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.id;
          const height = Math.round((entry.target as HTMLElement).offsetHeight);
          if (id && current[id] !== height) next = { ...next, [id]: height };
        }
        return next;
      });
    });
  }
  useEffect(() => () => observer.current?.disconnect(), []);
  const measure = useCallback((id: string, element: HTMLElement | null) => {
    const was = observed.current.get(id);
    if (was === element) return;
    if (was) observer.current?.unobserve(was);
    if (element) {
      observed.current.set(id, element);
      observer.current?.observe(element);
    } else observed.current.delete(id);
  }, []);

  // A piece with no card on the board yet — kept while it was shut, or its
  // first opening — is put below the others once it has been measured; and
  // the board opened for the first time shows all of it.
  useLayoutEffect(() => {
    if (!ready || !size.w) return;
    const missing = blocks.filter((block) => !layout.places[block.id]);
    if (!missing.length) {
      if (!layout.view && blocks.length) update((current) => ({ ...current, view: fitView(current.places, heights, size.w, size.h) }));
      return;
    }
    if (missing.some((block) => heights[block.id] === undefined)) return;
    const columns = Math.max(2, Math.min(5, Math.floor((size.w - 80) / (CARD_W + 24))));
    update((current) => {
      const places = placeNew(current.places, missing.map((block) => block.id), heights, columns);
      return { ...current, places, view: current.view ?? fitView(places, heights, size.w, size.h) };
    });
  }, [ready, blocks, layout.places, layout.view, heights, size.w, size.h, update]);

  const setView = useCallback((next: BoardView) => update((current) => ({ ...current, view: next })), [update]);
  const toBoard = (clientX: number, clientY: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - view.x) / view.zoom, y: (clientY - (rect?.top ?? 0) - view.y) / view.zoom };
  };

  // ⌘/Ctrl + the wheel zooms about the pointer — the page itself is not
  // zoomed — and the wheel alone pans, unless a card sized by hand is
  // scrolling what is in it.
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const current = layoutRef.current.view ?? START;
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        update((layoutNow) => ({ ...layoutNow, view: zoomAt(current, current.zoom * Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top) }));
        return;
      }
      const inside = event.target instanceof Element ? event.target.closest<HTMLElement>('.board-card.is-sized .board-card-body, .board-card.is-sized .board-write') : null;
      if (inside && inside.scrollHeight > inside.clientHeight) return;
      event.preventDefault();
      update((layoutNow) => ({ ...layoutNow, view: { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY } }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [update]);

  const raise = (id: string) =>
    update((current) => {
      const place = current.places[id];
      if (!place) return current;
      const z = topZ(current.places);
      return place.z === z - 1 ? current : { ...current, places: { ...current.places, [id]: { ...place, z } } };
    });

  const onBoardDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest(NOT_BOARD))) return;
    setSelected(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, from: view };
  };
  const onCardDown = (event: ReactPointerEvent, block: NoteBlock) => {
    const place = layout.places[block.id];
    if (event.button !== 0 || !place || (event.target instanceof Element && event.target.closest('button'))) return;
    event.preventDefault();
    wrap.current?.setPointerCapture(event.pointerId);
    raise(block.id);
    gesture.current = { kind: 'move', id: block.id, x: event.clientX, y: event.clientY, from: place };
  };
  const onSizeDown = (event: ReactPointerEvent, block: NoteBlock) => {
    const place = layout.places[block.id];
    if (event.button !== 0 || !place) return;
    event.preventDefault();
    event.stopPropagation();
    wrap.current?.setPointerCapture(event.pointerId);
    raise(block.id);
    gesture.current = { kind: 'size', id: block.id, x: event.clientX, y: event.clientY, from: place, height: place.h ?? heights[block.id] ?? 160 };
  };
  const onLabelDown = (event: ReactPointerEvent, id: string, from: { x: number; y: number }) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
    event.preventDefault();
    wrap.current?.setPointerCapture(event.pointerId);
    gesture.current = { kind: 'label', id, x: event.clientX, y: event.clientY, from };
  };
  const onMove = (event: ReactPointerEvent) => {
    const now = gesture.current;
    if (!now) return;
    const dx = event.clientX - now.x;
    const dy = event.clientY - now.y;
    if (now.kind === 'pan') {
      setView({ ...now.from, x: now.from.x + dx, y: now.from.y + dy });
      return;
    }
    const bx = Math.round(dx / view.zoom);
    const by = Math.round(dy / view.zoom);
    if (now.kind === 'label') {
      update((current) => ({ ...current, labels: current.labels?.map((label) => (label.id === now.id ? { ...label, x: now.from.x + bx, y: now.from.y + by } : label)) }));
      return;
    }
    update((current) => {
      const place = current.places[now.id];
      if (!place) return current;
      const next = now.kind === 'move' ? { ...place, x: now.from.x + bx, y: now.from.y + by } : { ...place, w: Math.max(MIN_W, now.from.w + bx), h: Math.max(MIN_H, now.height + by) };
      return { ...current, places: { ...current.places, [now.id]: next } };
    });
  };
  const onUp = () => {
    gesture.current = null;
  };

  /** A new note, written where it is asked for: where the board was double-clicked, or the middle of the screen. */
  const write = (at?: { x: number; y: number }) => {
    const spot = at ?? toBoard((wrap.current?.getBoundingClientRect().left ?? 0) + size.w / 2 - CARD_W / 2, (wrap.current?.getBoundingClientRect().top ?? 0) + size.h / 2 - 60);
    const block = addText(paperId);
    update((current) => ({ ...current, places: { ...current.places, [block.id]: { x: Math.round(spot.x), y: Math.round(spot.y), w: CARD_W, z: topZ(current.places) } } }));
    setSelected(block.id);
    setFresh(block.id);
  };

  const tidy = () => {
    const { places, labels } = tidyBySection(blocks, heights, layout.places);
    update((current) => ({ ...current, places, labels, view: fitView(places, heights, size.w, size.h) }));
  };
  const fit = () => setView(fitView(layout.places, heights, size.w, size.h));
  const zoomBy = (factor: number) => setView(zoomAt(view, view.zoom * factor, size.w / 2, size.h / 2));

  // Esc: out of a note being written, then off the board. Arrows nudge the card picked.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest('textarea, input, [contenteditable="true"]');
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (typing) (event.target as HTMLElement).blur();
        else onClose();
        return;
      }
      if (typing || !selected || event.metaKey || event.ctrlKey || event.altKey) return;
      const step = event.shiftKey ? 40 : 10;
      const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!by) return;
      event.preventDefault();
      update((current) => {
        const place = current.places[selected];
        return place ? { ...current, places: { ...current.places, [selected]: { ...place, x: place.x + by[0], y: place.y + by[1] } } } : current;
      });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, selected, update]);

  // The whole board in small, and the part of it on the screen.
  const mini = useMemo(() => {
    const rects = blocks.flatMap((block) => {
      const place = layout.places[block.id];
      return place ? [{ id: block.id, x: place.x, y: place.y, w: place.w, h: place.h ?? heights[block.id] ?? 160 }] : [];
    });
    if (!rects.length || !size.w) return null;
    const seen = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: size.w / view.zoom, h: size.h / view.zoom };
    const all = [...rects, seen];
    const left = Math.min(...all.map((rect) => rect.x));
    const top = Math.min(...all.map((rect) => rect.y));
    const right = Math.max(...all.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...all.map((rect) => rect.y + rect.h));
    const scale = Math.min((MINI_W - 12) / (right - left), (MINI_H - 12) / (bottom - top));
    const box = (rect: { x: number; y: number; w: number; h: number }) => ({ left: 6 + (rect.x - left) * scale, top: 6 + (rect.y - top) * scale, width: Math.max(2, rect.w * scale), height: Math.max(2, rect.h * scale) });
    return { rects: rects.map((rect) => ({ id: rect.id, style: box(rect) })), seen: box(seen), left, top, scale };
  }, [blocks, layout.places, heights, view, size]);
  const jump = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!mini) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const bx = mini.left + (event.clientX - rect.left - 6) / mini.scale;
    const by = mini.top + (event.clientY - rect.top - 6) / mini.scale;
    setView({ ...view, x: Math.round(size.w / 2 - bx * view.zoom), y: Math.round(size.h / 2 - by * view.zoom) });
  };

  const exportMarkdown = () => saveMarkdown(title, `# ${title}\n\n${notesMarkdown(blocks)}`);

  return (
    <section className="notes-board" role="dialog" aria-modal="true" aria-label={`Notes board: ${title}`}>
      <header className="explain-bar board-bar">
        <span className="explain-brand">
          <NoteIcon size={15} /> Notes board
        </span>
        <span className="explain-bar-title" title={title}>
          {title} · {blocks.length} piece{blocks.length === 1 ? '' : 's'}
        </span>
        <span className="board-sync" title="Moving a card here never changes the order of the list in the notes pane">
          ⇅ Arranged here only — the list keeps its order
        </span>
        <button type="button" className="btn ghost sm" onClick={exportMarkdown} disabled={!blocks.length}>
          <DownloadIcon size={14} /> Export
        </button>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the board" title="Back to the paper (Esc or B)">
          <CloseIcon size={17} />
        </button>
      </header>

      <div
        ref={wrap}
        className="board-wrap"
        style={{ ['--zoom' as string]: String(view.zoom), backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.zoom}px ${22 * view.zoom}px` }}
        onPointerDown={onBoardDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest(NOT_BOARD)) return;
          write(toBoard(event.clientX - 20, event.clientY - 16));
        }}
      >
        <div className="board-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          {(layout.labels ?? []).map((label) => (
            <div key={label.id} className="board-label" style={{ left: label.x, top: label.y }} onPointerDown={(event) => onLabelDown(event, label.id, label)}>
              {label.text}
              <button type="button" onClick={() => update((current) => ({ ...current, labels: current.labels?.filter((item) => item.id !== label.id) }))} aria-label={`Remove the heading ${label.text}`}>
                ×
              </button>
            </div>
          ))}
          {blocks.map((block) => (
            <Card
              key={block.id}
              block={block}
              paperId={paperId}
              place={layout.places[block.id]}
              selected={selected === block.id}
              fresh={fresh === block.id}
              onPointerDown={onCardDown}
              onSize={onSizeDown}
              onSelect={() => setSelected(block.id)}
              onShowSource={() => {
                if (block.kind !== 'clip') return;
                onClose();
                window.setTimeout(() => void showSource(block.source), 60);
              }}
              measure={measure}
            />
          ))}
        </div>

        {!blocks.length ? (
          <div className="board-empty">
            <p>Nothing on this paper's board yet.</p>
            <p>Double-click anywhere to write, or keep figures, tables and passages from the paper — they land here too.</p>
          </div>
        ) : null}

        <div className="board-tools" role="toolbar" aria-label="Board">
          <button type="button" onClick={() => write()}>
            <PlusIcon size={14} /> Text
          </button>
          <i aria-hidden="true" />
          <button type="button" onClick={tidy} disabled={!blocks.length} title="Put every card back in columns, one to a section">
            ☰ Tidy by section
          </button>
          <button type="button" onClick={fit} disabled={!blocks.length} title="Show every card">
            ⤢ Fit
          </button>
        </div>

        <div className="board-zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" disabled={view.zoom <= clampZoom(0)}>
            −
          </button>
          <button type="button" className="board-zoom-at" onClick={() => setView(zoomAt(view, 1, size.w / 2, size.h / 2))} title="Back to 100%">
            {Math.round(view.zoom * 100)}%
          </button>
          <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" disabled={view.zoom >= clampZoom(99)}>
            +
          </button>
        </div>

        {mini ? (
          <div className="board-mini" onPointerDown={jump} title="The whole board — click to go there" aria-hidden="true">
            {mini.rects.map((rect) => (
              <b key={rect.id} style={rect.style} className={rect.id === selected ? 'is-selected' : undefined} />
            ))}
            <span className="board-mini-seen" style={mini.seen} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
