import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { FINISHED_AT, statusOf } from '../lib/status';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { SPOT_EVENT, spotFor, type Spot } from '../lib/spot';
import type { Highlight, Paper } from '../types';
import { CoverTile, ProgressRing, progressLabel } from './LibraryBits';
import { SearchIcon } from './icons';

interface Props {
  onOpenPaper: (id: string) => void;
  onOpenHighlight: (paperId: string, highlightId: string) => void;
  onSearch: () => void;
  onDiscover: () => void;
}

/** A paper in progress not opened for this long is said to have stalled. */
const STALLED_DAYS = 5;
const DAY = 24 * 3600 * 1000;

const opened = (paper: Paper) => paper.lastOpenedAt ?? '';
const byOpened = (a: Paper, b: Paper) => opened(b).localeCompare(opened(a));

/** A key pressed while typing is text, not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)));
}

function greeting(now: Date, name?: string): string {
  const hour = now.getHours();
  const part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

/** "2 hours ago", "yesterday", "3 Sep": how long since you were reading it. */
function sinceLeft(iso: string, now = new Date()): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 60 * 12) return `${Math.round(minutes / 60)} hour${minutes < 90 ? '' : 's'} ago`;
  return relativeDay(iso, now);
}

/**
 * Home: where the app opens, and what R on the rail comes back to. The paper
 * you were last reading fills it, shown at the page you left it on, with what
 * else is in progress, your latest highlights and what is next beside it.
 */
export default function Home({ onOpenPaper, onOpenHighlight, onSearch, onDiscover }: Props) {
  const { papers, highlights, user } = useStore();
  const now = new Date();

  // The paper to carry on with: the last one opened that isn't finished; failing
  // that, the last one opened; failing that, the newest one not started.
  const hero = useMemo(() => {
    const openedOnes = papers.filter((paper) => paper.lastOpenedAt).sort(byOpened);
    return (
      openedOnes.find((paper) => paper.progress < FINISHED_AT) ??
      openedOnes[0] ??
      papers.filter((paper) => statusOf(paper) === 'unread').sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0] ??
      null
    );
  }, [papers]);

  const inProgress = useMemo(
    () => papers.filter((paper) => statusOf(paper) === 'reading' && paper.id !== hero?.id).sort(byOpened).slice(0, 4),
    [papers, hero],
  );
  const upNext = useMemo(
    () =>
      papers
        .filter((paper) => statusOf(paper) === 'unread' && paper.id !== hero?.id)
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
        .slice(0, 3),
    [papers, hero],
  );
  const recent = useMemo(() => {
    const known = new Set(papers.map((paper) => paper.id));
    return highlights
      .filter((highlight) => !highlight.orphaned && known.has(highlight.paperId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
  }, [highlights, papers]);

  // Enter carries on reading, as the button says.
  useEffect(() => {
    if (!hero) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isTyping(event.target)) return;
      if (document.querySelector('.scrim, .sheet, .palette')) return;
      // A focused button or link on Home answers Enter itself; R, just
      // clicked to come here, is not asked again.
      if ((event.target as HTMLElement | null)?.closest?.('.home :is(button, a)')) return;
      event.preventDefault();
      onOpenPaper(hero.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hero, onOpenPaper]);

  const titleOf = (id: string) => papers.find((paper) => paper.id === id)?.title ?? '';

  return (
    <div className="main home">
      <div className="home-scroll">
        <header className="home-bar">
          <div className="home-hello">
            <span className="home-eyebrow">{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
            <h1>{greeting(now, user?.name)}</h1>
          </div>
          <button type="button" className="home-search" onClick={onSearch}>
            <SearchIcon size={16} />
            <span>Search your library, or find a paper…</span>
            <kbd>⌘K</kbd>
          </button>
        </header>

        {!hero ? (
          <div className="home-empty">
            <h2>Your library is empty</h2>
            <p>Find a paper to read — search by title, author or topic, or paste an arXiv id or DOI. Home will pick up where you leave off.</p>
            <button type="button" className="btn primary" onClick={onDiscover}>
              <SearchIcon size={15} /> Find papers
            </button>
          </div>
        ) : (
          <div className="home-grid">
            <Continue paper={hero} now={now} onOpen={() => onOpenPaper(hero.id)} />
            <aside className="home-side">
              {inProgress.length ? (
                <section className="home-card">
                  <h2 className="home-eyebrow">Also in progress</h2>
                  {inProgress.map((paper) => {
                    const idle = paper.lastOpenedAt ? Math.floor((now.getTime() - new Date(paper.lastOpenedAt).getTime()) / DAY) : 0;
                    return (
                      <button key={paper.id} type="button" className="home-row" onClick={() => onOpenPaper(paper.id)}>
                        <ProgressRing progress={paper.progress} size={28} />
                        <span className="home-row-text">
                          <span className="home-row-title">{paper.title}</span>
                          <span className="home-row-sub">
                            {progressLabel(paper.progress)}
                            {paper.lastOpenedAt ? ' · ' : ''}
                            {idle >= STALLED_DAYS ? <span className="home-stalled">not opened for {idle} days</span> : paper.lastOpenedAt ? relativeDay(paper.lastOpenedAt, now) : ''}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </section>
              ) : null}

              {recent.length ? (
                <section className="home-card">
                  <h2 className="home-eyebrow">Recent highlights</h2>
                  {recent.map((highlight: Highlight) => (
                    <button key={highlight.id} type="button" className="home-hl" onClick={() => onOpenHighlight(highlight.paperId, highlight.id)}>
                      <span className={`home-hl-quote hl-bg-${highlight.color}`}>{clip(highlight.exact, 150)}</span>
                      <span className="home-row-sub">
                        <span className={`home-dot dot-${highlight.color}`} /> {clip(titleOf(highlight.paperId), 60)}
                        {highlight.note ? ' · with a note' : ''}
                      </span>
                    </button>
                  ))}
                </section>
              ) : null}

              {upNext.length ? (
                <section className="home-card">
                  <h2 className="home-eyebrow">Up next</h2>
                  {upNext.map((paper) => (
                    <button key={paper.id} type="button" className="home-row" onClick={() => onOpenPaper(paper.id)}>
                      <CoverTile paper={paper} size="mini" />
                      <span className="home-row-text">
                        <span className="home-row-title">{paper.title}</span>
                        <span className="home-row-sub">added {relativeDay(paper.addedAt, now)}</span>
                      </span>
                    </button>
                  ))}
                </section>
              ) : null}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The paper to carry on with, and the page you left it at. */
function Continue({ paper, now, onOpen }: { paper: Paper; now: Date; onOpen: () => void }) {
  const [spot, setSpot] = useState<Spot | null>(() => spotFor(paper.id));
  useEffect(() => {
    setSpot(spotFor(paper.id));
    const onSpot = () => setSpot(spotFor(paper.id));
    window.addEventListener(SPOT_EVENT, onSpot);
    return () => window.removeEventListener(SPOT_EVENT, onSpot);
  }, [paper.id]);

  const year = /^\d{4}/.exec(paper.published || '')?.[0];
  const started = paper.progress > 0;
  // Whether there is a page to show, or only the abstract and a word about it.
  const shown = (spot?.mode === 'pdf' && Boolean(spot.image)) || (spot?.mode === 'reflow' && Boolean(spot.blocks?.length));
  const where =
    spot?.mode === 'pdf'
      ? spot.page
        ? `page ${spot.page}${spot.pages ? ` of ${spot.pages}` : ''}`
        : 'PDF'
      : spot?.section ?? (spot ? 'Reflow' : '');

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
function PdfPeek({ spot }: { spot: Spot }) {
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
function ReflowPeek({ spot }: { spot: Spot }) {
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
