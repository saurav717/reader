import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { STATUS_LABEL, statusOf, type ReadingStatus } from '../lib/status';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { lastVisit } from '../lib/homeViews';
import type { Paper } from '../types';
import { CoverTile, ProgressRing, progressLabel } from './LibraryBits';
import { PdfPeek, ReflowPeek, clip, hasPage, sinceLeft, useSpot, whereIn } from './HomeParts';
import { ClockIcon, HighlighterIcon, InboxIcon, StackIcon } from './icons';

const DAY = 24 * 3600 * 1000;
/** A paper in progress not opened for this long is said to have stalled. */
export const STALLED_DAYS = 5;

const idleDays = (paper: Paper, now: Date) => (paper.lastOpenedAt ? Math.floor((now.getTime() - new Date(paper.lastOpenedAt).getTime()) / DAY) : 0);
const byOpened = (a: Paper, b: Paper) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '');
const byAdded = (a: Paper, b: Paper) => b.addedAt.localeCompare(a.addedAt);

/** Papers added since the visit before this one — or in the last week, on a first. */
export function inboxOf(papers: Paper[], now = new Date()): { since: string; fresh: Paper[] } {
  const since = lastVisit() ?? new Date(now.getTime() - 7 * DAY).toISOString();
  return { since, fresh: papers.filter((paper) => statusOf(paper) === 'unread' && paper.addedAt > since).sort(byAdded) };
}

interface PlanItem {
  key: string;
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  action: string;
  run: () => void;
}

/**
 * Today: a short plan for this sitting, made from the library — carry on with
 * the paper you were reading, pick up the ones that stalled, start the next
 * one, and look over this week's highlights.
 */
export function TodayView({ hero, onOpenPaper, onShowNotes }: { hero: Paper | null; onOpenPaper: (id: string) => void; onShowNotes: () => void }) {
  const { papers, highlights } = useStore();
  const now = new Date();
  const spot = useSpot(hero?.id);

  const plan = useMemo(() => {
    const items: PlanItem[] = [];
    if (hero && statusOf(hero) === 'reading') {
      items.push({
        key: `carry-${hero.id}`,
        icon: <ProgressRing progress={hero.progress} size={30} />,
        title: `Carry on with ${hero.title}`,
        detail: `${progressLabel(hero.progress)}${spot ? ` · ${whereIn(spot)}` : ''}${hero.lastOpenedAt ? ` · left ${sinceLeft(hero.lastOpenedAt, now)}` : ''}`,
        action: 'Resume',
        run: () => onOpenPaper(hero.id),
      });
    }
    for (const paper of papers
      .filter((item) => statusOf(item) === 'reading' && item.id !== hero?.id && idleDays(item, now) >= STALLED_DAYS)
      .sort(byOpened)
      .slice(0, 2)) {
      items.push({
        key: `stalled-${paper.id}`,
        icon: <ProgressRing progress={paper.progress} size={30} />,
        title: `Pick back up: ${paper.title}`,
        detail: (
          <>
            {progressLabel(paper.progress)} · <span className="home-stalled">not opened for {idleDays(paper, now)} days</span>
          </>
        ),
        action: 'Open',
        run: () => onOpenPaper(paper.id),
      });
    }
    for (const paper of papers.filter((item) => statusOf(item) === 'unread' && item.id !== hero?.id).sort(byAdded).slice(0, 2)) {
      items.push({
        key: `start-${paper.id}`,
        icon: <CoverTile paper={paper} size="mini" />,
        title: `Start ${paper.title}`,
        detail: `${authorLine(paper.authors, 2)} · added ${relativeDay(paper.addedAt, now)}`,
        action: 'Start',
        run: () => onOpenPaper(paper.id),
      });
    }
    const week = highlights.filter((highlight) => !highlight.orphaned && now.getTime() - new Date(highlight.createdAt).getTime() < 7 * DAY);
    if (week.length) {
      const notes = week.filter((highlight) => highlight.note).length;
      items.push({
        key: 'review',
        icon: (
          <span className="home-plan-icon">
            <HighlighterIcon size={16} />
          </span>
        ),
        title: `Look over ${week.length} highlight${week.length === 1 ? '' : 's'} from this week`,
        detail: `${new Set(week.map((highlight) => highlight.paperId)).size} paper${new Set(week.map((highlight) => highlight.paperId)).size === 1 ? '' : 's'}${notes ? ` · ${notes} with a note` : ''}`,
        action: 'Show',
        run: onShowNotes,
      });
    }
    return items;
    // `now` is this render's; the plan follows the library, not the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [papers, highlights, hero, spot, onOpenPaper, onShowNotes]);

  const openedThisWeek = papers.filter((paper) => paper.lastOpenedAt && now.getTime() - new Date(paper.lastOpenedAt).getTime() < 7 * DAY).length;
  const highlightsThisWeek = highlights.filter((highlight) => now.getTime() - new Date(highlight.createdAt).getTime() < 7 * DAY).length;
  const inProgress = papers.filter((paper) => statusOf(paper) === 'reading').length;

  return (
    <div className="home-view home-today">
      <section className="home-card">
        <div className="home-view-head">
          <h2>Your plan for today</h2>
          <p>Made from your library: what you were reading, what stalled, what is next, and what you marked this week.</p>
        </div>
        {plan.length ? (
          plan.map((item, index) => (
            <div key={item.key} className={`home-plan${index === 0 ? ' is-first' : ''}`}>
              <span className="home-plan-step">{index + 1}</span>
              {item.icon}
              <span className="home-row-text">
                <span className="home-row-title">{clip(item.title, 140)}</span>
                <span className="home-row-sub">{item.detail}</span>
              </span>
              <button type="button" className={`btn${index === 0 ? ' primary' : ''}`} onClick={item.run}>
                {item.action}
              </button>
            </div>
          ))
        ) : (
          <p className="home-view-empty">Nothing is waiting. Add a paper from Discover and it will be here.</p>
        )}
      </section>
      <aside className="home-card home-week">
        <h2 className="home-eyebrow">This week</h2>
        <div className="home-stats">
          <span>
            <b>{openedThisWeek}</b> papers opened
          </span>
          <span>
            <b>{highlightsThisWeek}</b> highlights
          </span>
          <span>
            <b>{inProgress}</b> in progress
          </span>
        </div>
      </aside>
    </div>
  );
}

const LANES: ReadingStatus[] = ['unread', 'reading', 'finished'];

/** Projects: each collection, its papers set out by how far you are with them. */
export function ProjectsView({ hero, onOpenPaper }: { hero: Paper | null; onOpenPaper: (id: string) => void }) {
  const { papers, collections } = useStore();
  const now = new Date();
  const [chosen, setChosen] = useState<string | null>(() => hero?.collectionIds.find((id) => collections.some((c) => c.id === id)) ?? collections[0]?.id ?? null);
  const collection = collections.find((item) => item.id === chosen) ?? collections[0];

  if (!collection) {
    return (
      <div className="home-view">
        <section className="home-card home-view-empty-card">
          <h2>No collections yet</h2>
          <p>A collection is a project: the papers for one question, set out here by how far you are with each. Make one with the + beside Collections in the library.</p>
        </section>
      </div>
    );
  }
  const inIt = papers.filter((paper) => paper.collectionIds.includes(collection.id));
  const lastOpened = inIt.filter((paper) => paper.lastOpenedAt && statusOf(paper) !== 'finished').sort(byOpened)[0];

  return (
    <div className="home-view home-projects">
      <nav className="home-card home-project-list" aria-label="Collections">
        <h2 className="home-eyebrow">Collections</h2>
        {collections.map((item) => {
          const members = papers.filter((paper) => paper.collectionIds.includes(item.id));
          const reading = members.filter((paper) => statusOf(paper) === 'reading').length;
          return (
            <button key={item.id} type="button" className={`home-project${item.id === collection.id ? ' is-on' : ''}`} aria-pressed={item.id === collection.id} onClick={() => setChosen(item.id)}>
              <span className="home-project-dot" style={{ background: item.color }} />
              <span className="home-row-text">
                <span className="home-project-name">{item.name}</span>
                <span className="home-row-sub">
                  {members.length} paper{members.length === 1 ? '' : 's'}
                  {reading ? ` · ${reading} reading` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
      <section className="home-project-main">
        <div className="home-project-head">
          <div>
            <span className="home-eyebrow">Collection</span>
            <h2>{collection.name}</h2>
          </div>
          {lastOpened ? (
            <button type="button" className="btn primary" onClick={() => onOpenPaper(lastOpened.id)} title={lastOpened.title}>
              Resume {clip(lastOpened.title, 34)}
            </button>
          ) : null}
        </div>
        <div className="home-lanes">
          {LANES.map((lane) => {
            const members = inIt.filter((paper) => statusOf(paper) === lane).sort(lane === 'unread' ? byAdded : byOpened);
            return (
              <div key={lane} className="home-lane">
                <div className="home-lane-head">
                  <span className="home-eyebrow">{STATUS_LABEL[lane]}</span>
                  <span className="home-lane-count">{members.length}</span>
                </div>
                {members.map((paper) => (
                  <button key={paper.id} type="button" className="home-lane-card" onClick={() => onOpenPaper(paper.id)}>
                    <span className="home-row-title">{paper.title}</span>
                    <span className="home-row-sub">{authorLine(paper.authors, 2)}</span>
                    {lane === 'reading' ? (
                      <span className="home-lane-progress">
                        <span className="home-bar-track">
                          <span style={{ width: `${Math.round(paper.progress * 100)}%` }} />
                        </span>
                        {idleDays(paper, now) >= STALLED_DAYS ? <span className="home-stalled">stalled</span> : null}
                      </span>
                    ) : null}
                  </button>
                ))}
                {!members.length ? <p className="home-lane-empty">None</p> : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** Inbox: papers added since your last visit, not started yet, to open or set aside. */
export function InboxView({ onOpenPaper }: { onOpenPaper: (id: string) => void }) {
  const { papers, setReadingStatus, removePaper } = useStore();
  const now = new Date();
  const { since, fresh } = useMemo(() => inboxOf(papers, now), [papers]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = papers.filter((paper) => statusOf(paper) === 'unread' && !fresh.includes(paper)).sort(byAdded).slice(0, 8);

  const row = (paper: Paper) => (
    <div key={paper.id} className="home-inbox-row">
      <CoverTile paper={paper} size="mini" />
      <span className="home-row-text">
        <span className="home-row-title">{paper.title}</span>
        <span className="home-row-sub">
          {authorLine(paper.authors, 3)}
          {paper.venue ? ` · ${paper.venue}` : ''} · added {relativeDay(paper.addedAt, now)}
        </span>
      </span>
      <span className="home-inbox-actions">
        <button type="button" className="btn primary sm" onClick={() => onOpenPaper(paper.id)}>
          Open
        </button>
        <button type="button" className="btn sm" onClick={() => void setReadingStatus([paper.id], 'finished')} title="Mark it as read without opening it">
          Mark read
        </button>
        <button type="button" className="btn ghost sm" onClick={() => void removePaper(paper.id)} title="Move it to Junk, where it can be put back">
          Not for me
        </button>
      </span>
    </div>
  );

  return (
    <div className="home-view home-inbox">
      <section className="home-card">
        <div className="home-view-head">
          <h2>
            <InboxIcon size={18} /> New since your last visit
          </h2>
          <p>Papers added to your library since {relativeDay(since, now) === 'today' ? 'earlier today' : relativeDay(since, now)} — from Discover here, or synced from Drive — that you have not started.</p>
        </div>
        {fresh.length ? fresh.map(row) : <p className="home-view-empty">Nothing new since then.</p>}
      </section>
      {waiting.length ? (
        <section className="home-card">
          <div className="home-view-head">
            <h2>
              <StackIcon size={18} /> Still waiting
            </h2>
            <p>Added before that, and not started yet.</p>
          </div>
          {waiting.map(row)}
        </section>
      ) : null}
    </div>
  );
}

/** On the views other than Continue reading: the paper you left, a few lines of it, one key away. */
export function ResumeStrip({ paper, onOpen }: { paper: Paper; onOpen: () => void }) {
  const spot = useSpot(paper.id);
  const now = new Date();
  return (
    <div className="home-strip">
      <div className="home-strip-meta">
        <span className="home-eyebrow accent">
          <ClockIcon size={12} /> Pick up where you left off
        </span>
        <span className="home-row-title">{paper.title}</span>
        <span className="home-row-sub">
          {[progressLabel(paper.progress), whereIn(spot), paper.lastOpenedAt ? sinceLeft(paper.lastOpenedAt, now) : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
      {hasPage(spot) ? (
        <button type="button" className="home-strip-page" onClick={onOpen} aria-label={`Open ${paper.title} where you stopped`}>
          {spot.mode === 'pdf' ? <PdfPeek spot={spot} /> : <ReflowPeek spot={spot} />}
        </button>
      ) : null}
      <button type="button" className="btn primary home-resume" onClick={onOpen}>
        Resume <kbd>↵</kbd>
      </button>
    </div>
  );
}
