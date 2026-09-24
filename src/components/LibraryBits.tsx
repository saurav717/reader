import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PaperRef } from '../types';
import { coverFor } from '../lib/libraryLook';
import { FINISHED_AT } from '../lib/status';
import { CheckIcon } from './icons';

/** What a dragged set of papers carries: their ids, as JSON. */
export const PAPERS_MIME = 'application/x-reader-papers';

export function draggedPapers(event: React.DragEvent): string[] | null {
  if (!event.dataTransfer.types.includes(PAPERS_MIME)) return null;
  try {
    const ids = JSON.parse(event.dataTransfer.getData(PAPERS_MIME) || '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether a drag over something is a drag of papers — the ids themselves are only readable on drop. */
export const carriesPapers = (event: React.DragEvent) => event.dataTransfer.types.includes(PAPERS_MIME);

/**
 * The tile a paper is shown with in place of a cover: a colour of its
 * journal's own — every paper in the same journal gets the same one — with
 * what kind of thing it is and its year. With `selectable`, it turns into
 * the tick box that selects the paper.
 */
export function CoverTile({
  paper,
  size = 'row',
  selected,
  selecting,
  onToggle,
  label,
}: {
  paper: Pick<PaperRef, 'source' | 'venue' | 'arxivId' | 'published' | 'pdfUrl' | 'landingUrl'>;
  size?: 'row' | 'card' | 'mini';
  selected?: boolean;
  /** Something is selected already, so every tile shows its box. */
  selecting?: boolean;
  onToggle?: (event: React.MouseEvent | React.KeyboardEvent) => void;
  label?: string;
}) {
  const cover = coverFor(paper);
  const style = { ['--h' as string]: String(cover.hue) } as React.CSSProperties;
  const face = (
    <>
      <span className="cover-kind">{cover.kind}</span>
      {cover.year ? <span className="cover-year">{cover.year}</span> : null}
    </>
  );
  if (!onToggle) {
    return (
      <span className={`cover cover-${size}`} style={style} aria-hidden="true">
        {face}
      </span>
    );
  }
  return (
    <span
      className={`cover cover-${size} is-selectable${selected ? ' is-selected' : ''}${selecting ? ' is-selecting' : ''}`}
      style={style}
      role="checkbox"
      aria-checked={Boolean(selected)}
      aria-label={label}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onToggle(event);
      }}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          onToggle(event);
        }
      }}
    >
      {face}
      <span className="cover-check" aria-hidden="true">
        <CheckIcon size={14} strokeWidth={2.6} />
      </span>
    </span>
  );
}

/** How far through a paper is, as a ring: hollow when not started, a tick when finished. */
export function ProgressRing({ progress, size = 30 }: { progress: number; size?: number }) {
  const finished = progress >= FINISHED_AT;
  const radius = size / 2 - 2.5;
  const around = 2 * Math.PI * radius;
  const shown = finished ? 1 : Math.max(0, Math.min(1, progress));
  return (
    <span className={`ring${finished ? ' is-finished' : progress > 0 ? ' is-reading' : ' is-new'}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} />
        {shown > 0 ? (
          <circle
            className="ring-fill"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeDasharray={`${around * shown} ${around}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      {finished ? <CheckIcon size={size * 0.46} strokeWidth={2.6} className="ring-mark" /> : null}
    </span>
  );
}

export const progressLabel = (progress: number) =>
  progress >= FINISHED_AT ? 'Finished' : progress > 0 ? `${Math.max(1, Math.round(progress * 100))}% read` : 'Not started';

/**
 * A button that opens a short list of choices under it. It closes on a
 * choice, a click elsewhere or Escape.
 */
export function Menu({
  label,
  icon,
  children,
  up,
  className = 'btn sm',
  title,
  align,
}: {
  label: ReactNode;
  icon?: ReactNode;
  children: (close: () => void) => ReactNode;
  up?: boolean;
  className?: string;
  title?: string;
  /** Opens leftwards from the button's right edge, for a button at the right of the page. */
  align?: 'right';
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((now) => !now)} title={title}>
        {icon}
        {label}
      </button>
      {open ? (
        <div className={`menu${up ? ' up' : ''}${align === 'right' ? ' right' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
