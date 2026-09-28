import { useEffect, useState } from 'react';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { SPOT_EVENT, spotFor, type Spot } from '../lib/spot';
import type { Paper } from '../types';
import { progressLabel } from './LibraryBits';

// The pieces of Home that more than one of its views shows: the paper to
// carry on with, and the page you left it at.

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** "2 hours ago", "yesterday", "3 Sep": how long since you were reading it. */
export function sinceLeft(iso: string, now = new Date()): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 60 * 12) return `${Math.round(minutes / 60)} hour${minutes < 90 ? '' : 's'} ago`;
  return relativeDay(iso, now);
}

/** Where you stopped in a paper, kept up to date as the reader keeps it. */
export function useSpot(paperId: string | undefined): Spot | null {
  const [spot, setSpot] = useState<Spot | null>(() => (paperId ? spotFor(paperId) : null));
  useEffect(() => {
    if (!paperId) {
      setSpot(null);
      return;
    }
    setSpot(spotFor(paperId));
    const onSpot = () => setSpot(spotFor(paperId));
    window.addEventListener(SPOT_EVENT, onSpot);
    return () => window.removeEventListener(SPOT_EVENT, onSpot);
  }, [paperId]);
  return spot;
}

/** Whether there is a page to show: a picture of it, or its paragraphs. */
export const hasPage = (spot: Spot | null): spot is Spot =>
  (spot?.mode === 'pdf' && Boolean(spot.image)) || (spot?.mode === 'reflow' && Boolean(spot.blocks?.length));

/** "page 3 of 6", or the section, or the mode. */
export function whereIn(spot: Spot | null): string {
  if (!spot) return '';
  if (spot.mode === 'pdf') return spot.page ? `page ${spot.page}${spot.pages ? ` of ${spot.pages}` : ''}` : 'PDF';
  return spot.section ?? 'Reflow';
}

/** The paper to carry on with, and the page you left it at. */
export function Continue({ paper, now, onOpen }: { paper: Paper; now: Date; onOpen: () => void }) {
  const spot = useSpot(paper.id);

  const year = /^\d{4}/.exec(paper.published || '')?.[0];
  const started = paper.progress > 0;
  // Whether there is a page to show, or only the abstract and a word about it.
  const shown = hasPage(spot);
  const where = whereIn(spot);

  return (
    <section className={`home-card home-continue${shown ? '' : ' is-bare'}`}>
      <div className="home-continue-head">
        <div className="home-continue-text">
          <span className="home-eyebrow accent">
            {started ? 'Continue reading' : 'Start reading'}
            {paper.lastOpenedAt ? ` · left ${sinceLeft(paper.lastOpenedAt, now)}` : ''}
          </span>
          <h2 className="home-continue-title" title={paper.title}>
            {paper.title}
          </h2>
          <div className="home-facts">
            <span>
              {authorLine(paper.authors, 2)}
              {paper.venue ? ` · ${paper.venue}` : ''}
              {year && !paper.venue?.includes(year) ? ` · ${year}` : ''}
            </span>
            {started ? (
              <span className="home-progress">
                <span className="home-bar-track">
                  <span style={{ width: `${Math.round(Math.min(1, paper.progress) * 100)}%` }} />
                </span>
                {progressLabel(paper.progress)}
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className="btn primary home-resume" onClick={onOpen}>
          {started ? 'Resume here' : 'Open'} <kbd>↵</kbd>
        </button>
      </div>

      <div className="home-peek">
        <div className="home-peek-bar">
          <span className="home-eyebrow">{shown ? 'Where you stopped' : paper.abstract ? 'Abstract' : started ? 'Where you are' : 'Not started'}</span>
          {shown && where ? <span className="home-peek-where">{where}</span> : null}
          <span style={{ flex: 1 }} />
          {shown && spot ? <span className="home-chip">{spot.mode === 'pdf' ? 'PDF' : 'Reflow'}</span> : null}
        </div>
        <button type="button" className="home-peek-page" onClick={onOpen} aria-label={`Open ${paper.title} where you stopped`}>
          {shown && spot?.mode === 'pdf' ? (
            <PdfPeek spot={spot} />
          ) : shown && spot ? (
            <ReflowPeek spot={spot} />
          ) : (
            <div className="home-peek-sheet home-peek-abstract">
              {paper.abstract ? <p>{paper.abstract}</p> : null}
              <p className="home-peek-hint">
                {started
                  ? 'Home will show the page you were on from the next time you read this paper.'
                  : 'Home will show the page you stop on, once you have started it.'}
              </p>
            </div>
          )}
        </button>
        <div className="home-peek-fade" aria-hidden="true" />
      </div>
    </section>
  );
}

/** The PDF page you left, moved so that where you were sits a little below the top. */
export function PdfPeek({ spot }: { spot: Spot }) {
  const top = spot.top ?? 0;
  return (
    <div className="home-peek-pdf" style={{ ['--at' as string]: String(top) }}>
      <img src={spot.image} alt={`Page ${spot.page ?? ''} of the paper, as you left it`} />
      {top > 0.02 ? <span className="home-peek-read" aria-hidden="true" /> : null}
      <span className="home-stop" aria-hidden="true">
        <span>You were here</span>
      </span>
    </div>
  );
}

/** The paragraphs you left, the ones scrolled past dimmed, and a line where the screen began. */
export function ReflowPeek({ spot }: { spot: Spot }) {
  const blocks = spot.blocks ?? [];
  const stopAt = blocks.findIndex((block) => !block.read);
  return (
    <div className="home-peek-sheet home-peek-reflow">
      {blocks.map((block, index) => {
        const body = block.runs.map((run, at) =>
          run.color ? (
            <mark key={at} className={`hl-bg-${run.color}`}>
              {run.text}
            </mark>
          ) : (
            <span key={at}>{run.text}</span>
          ),
        );
        return (
          <div key={index} className={block.read ? 'is-read' : undefined}>
            {index === stopAt && stopAt > 0 ? (
              <span className="home-stop in-flow" aria-hidden="true">
                <span>You were here</span>
              </span>
            ) : null}
            {block.heading ? <h3>{body}</h3> : <p>{body}</p>}
          </div>
        );
      })}
    </div>
  );
}
