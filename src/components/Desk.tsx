import { useEffect, useMemo } from 'react';
import { useStore } from '../lib/store';
import { statusOf } from '../lib/status';
import type { Paper } from '../types';
import { progressLabel } from './LibraryBits';
import { PdfPeek, ReflowPeek, clip, hasPage, sinceLeft, useSpot, whereIn } from './HomeParts';
import { SearchIcon } from './icons';

const SHOWN = 4;

interface Props {
  /** The paper open now, which leads. */
  current: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  onHome: () => void;
  onSearch: () => void;
}

/**
 * Your desk: R, while reading, lays the papers in progress side by side at
 * the page and the line each was left on. 1–4 goes to one there; R or Esc
 * back to the paper; G to Home.
 */
export default function Desk({ current, onOpen, onClose, onHome, onSearch }: Props) {
  const { papers } = useStore();
  const shown = useMemo(() => {
    const open = papers.find((paper) => paper.id === current);
    const others = papers
      .filter((paper) => paper.id !== current && statusOf(paper) === 'reading')
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
    return [...(open ? [open] : []), ...others].slice(0, SHOWN);
  }, [papers, current]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'escape' || key === 'r') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (key === 'g') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onHome();
      } else if (/^[1-9]$/.test(key) && shown[Number(key) - 1]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const paper = shown[Number(key) - 1];
        if (paper.id === current) onClose();
        else onOpen(paper.id);
      }
    };
    // Ahead of the reader's own keys, which would take R, G and the digits otherwise.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown, current, onOpen, onClose, onHome]);

  return (
    <div className="desk-scrim" onClick={onClose} role="dialog" aria-label="Your desk: the papers you are reading">
      <div className="desk" onClick={(event) => event.stopPropagation()}>
        <header className="desk-head">
          <div>
            <span className="home-eyebrow accent">Your desk · R</span>
            <h2>
              {shown.length === 1 ? 'One paper open on it' : `${['', 'One', 'Two', 'Three', 'Four'][shown.length]} papers open on it`}
            </h2>
          </div>
          <button type="button" className="home-search desk-find" onClick={onSearch}>
            <SearchIcon size={16} />
            <span>Find a paper, or one of these…</span>
            <kbd>⌘K</kbd>
          </button>
          <button type="button" className="btn" onClick={onHome}>
            Go to Home
          </button>
        </header>
        <div className="desk-cards" style={{ ['--n' as string]: String(Math.max(shown.length, 2)) }}>
          {shown.map((paper, index) => (
            <DeskCard key={paper.id} paper={paper} index={index} now={paper.id === current} onOpen={() => (paper.id === current ? onClose() : onOpen(paper.id))} />
          ))}
        </div>
        <footer className="desk-foot">
          <span>
            <kbd>1</kbd>–<kbd>{shown.length}</kbd> switch paper, at the line you left
          </span>
          <span>
            <kbd>R</kbd> or <kbd>Esc</kbd> back to this paper
          </span>
          <span>
            <kbd>G</kbd> go Home
          </span>
          <span className="desk-foot-note">The papers in progress, the one you opened last first.</span>
        </footer>
      </div>
    </div>
  );
}

function DeskCard({ paper, index, now, onOpen }: { paper: Paper; index: number; now: boolean; onOpen: () => void }) {
  const spot = useSpot(paper.id);
  return (
    <button type="button" className={`desk-card${now ? ' is-now' : ''}`} onClick={onOpen}>
      <span className="desk-page" aria-hidden="true">
        {hasPage(spot) ? (
          spot.mode === 'pdf' ? <PdfPeek spot={spot} /> : <ReflowPeek spot={spot} />
        ) : (
          <span className="desk-page-bare">{paper.abstract ? clip(paper.abstract, 600) : 'Open it and the page you stop on shows here.'}</span>
        )}
        {now ? <span className="desk-now">Reading now</span> : null}
      </span>
      <span className="desk-info">
        <span className="home-row-title">{paper.title}</span>
        <span className="home-row-sub">
          {[progressLabel(paper.progress), whereIn(spot), paper.lastOpenedAt && !now ? sinceLeft(paper.lastOpenedAt) : ''].filter(Boolean).join(' · ')}
          <kbd>{index + 1}</kbd>
        </span>
      </span>
    </button>
  );
}
