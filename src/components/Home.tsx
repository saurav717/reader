import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { FINISHED_AT, statusOf } from '../lib/status';
import { relativeDay } from '../lib/libraryLook';
import type { Highlight, Paper } from '../types';
import { CoverTile, ProgressRing, progressLabel } from './LibraryBits';
import { Continue, clip } from './HomeParts';
import { InboxView, ProjectsView, ResumeStrip, STALLED_DAYS, TodayView, inboxOf } from './HomeViews';
import { FindPapers } from './HomeSearch';
import { CollectionsBoard } from './HomeBoard';
import { HOME_TABS, TAB_ABOUT, TAB_LABEL, openingTab, readHomePrefs, writeHomePrefs, type HomePrefs, type HomeTab } from '../lib/homeViews';
import { CheckIcon, ClockIcon, GridIcon, InboxIcon, OpenBookIcon, SearchIcon, StackIcon } from './icons';

interface Props {
  onOpenPaper: (id: string) => void;
  onOpenHighlight: (paperId: string, highlightId: string) => void;
  onSearch: () => void;
  onDiscover: () => void;
  /** The highlights and notes of every paper, in the dock. */
  onShowNotes: () => void;
}

const TAB_ICON: Record<HomeTab, React.ReactNode> = {
  search: <SearchIcon size={15} />,
  board: <GridIcon size={15} />,
  continue: <OpenBookIcon size={15} />,
  today: <ClockIcon size={15} />,
  projects: <StackIcon size={15} />,
  inbox: <InboxIcon size={15} />,
};

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

/**
 * Home: where the app opens, and what R on the rail comes back to. The paper
 * you were last reading fills it, shown at the page you left it on, with what
 * else is in progress, your latest highlights and what is next beside it.
 */
export default function Home({ onOpenPaper, onOpenHighlight, onSearch, onDiscover, onShowNotes }: Props) {
  const { papers, highlights, user } = useStore();
  const now = new Date();
  const [prefs, setPrefs] = useState<HomePrefs>(readHomePrefs);
  const [tab, setTab] = useState<HomeTab>(() => openingTab(prefs));
  const [menuOpen, setMenuOpen] = useState(false);
  /** A question handed to Find papers from elsewhere on Home: a column's “search everywhere”. */
  const [findAsk, setFindAsk] = useState<{ query: string; at: number } | null>(null);
  const changePrefs = (next: HomePrefs) => {
    setPrefs(next);
    writeHomePrefs(next);
  };
  const show = (next: HomeTab) => {
    setTab(next);
    changePrefs({ ...prefs, last: next });
  };
  const tabs = HOME_TABS.filter((item) => prefs.tabs.includes(item));

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

  // 1–4 switch between the views shown as tabs.
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || !/^[1-9]$/.test(event.key)) return;
      if (document.querySelector('.scrim, .sheet, .palette')) return;
      const next = tabs[Number(event.key) - 1];
      if (!next) return;
      event.preventDefault();
      showRef.current(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs]);

  const fresh = useMemo(() => inboxOf(papers).fresh.length, [papers]);

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
          <nav className="home-tabs" aria-label="Home view">
            {tabs.map((item, index) => (
              <button
                key={item}
                type="button"
                className={`home-tab${tab === item ? ' is-on' : ''}`}
                aria-pressed={tab === item}
                title={`${TAB_ABOUT[item]} (${index + 1})`}
                onClick={() => show(item)}
              >
                {TAB_ICON[item]}
                {TAB_LABEL[item]}
                {prefs.opensOn === item ? <em>default</em> : null}
                {item === 'inbox' && fresh ? <b aria-label={`${fresh} new`}>{fresh}</b> : null}
              </button>
            ))}
            <span className="home-tabs-more">
              <button type="button" className={`home-tab${menuOpen ? ' is-on' : ''}`} aria-expanded={menuOpen} aria-label="Choose Home's views" title="Choose Home's views" onClick={() => setMenuOpen(!menuOpen)}>
                ⋯
              </button>
              {menuOpen ? <ViewMenu prefs={prefs} onChange={changePrefs} onClose={() => setMenuOpen(false)} /> : null}
            </span>
          </nav>
          <button type="button" className="home-search" onClick={onSearch}>
            <SearchIcon size={16} />
            <span>Search your library, or find a paper…</span>
            <kbd>⌘K</kbd>
          </button>
        </header>

        {tab === 'search' ? (
          <FindPapers
            key={findAsk?.at ?? 'find'}
            hero={hero}
            ask={findAsk?.query}
            saveTo={prefs.saveTo}
            onSaveTo={(id) => changePrefs({ ...prefs, saveTo: id })}
            onOpenPaper={onOpenPaper}
            onDiscover={(query) => window.dispatchEvent(new CustomEvent('reader:discover', { detail: { query } }))}
          />
        ) : tab === 'board' ? (
          <CollectionsBoard
            onOpenPaper={onOpenPaper}
            onFind={(query) => {
              setFindAsk({ query, at: Date.now() });
              show('search');
            }}
          />
        ) : tab === 'today' ? (
          <TodayView hero={hero} onOpenPaper={onOpenPaper} onShowNotes={onShowNotes} />
        ) : tab === 'projects' ? (
          <ProjectsView hero={hero} onOpenPaper={onOpenPaper} />
        ) : tab === 'inbox' ? (
          <InboxView onOpenPaper={onOpenPaper} />
        ) : !hero ? (
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
        {tab !== 'continue' && tab !== 'search' && hero && statusOf(hero) === 'reading' ? <ResumeStrip paper={hero} onOpen={() => onOpenPaper(hero.id)} /> : null}
      </div>
    </div>
  );
}

/** Which view Home opens on, and which are tabs. */
function ViewMenu({ prefs, onChange, onClose }: { prefs: HomePrefs; onChange: (next: HomePrefs) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const opensOn = (value: HomePrefs['opensOn']) => {
    // A view Home opens on is one of its tabs.
    const tabs = value === 'last' || prefs.tabs.includes(value) ? prefs.tabs : HOME_TABS.filter((item) => item === value || prefs.tabs.includes(item));
    onChange({ ...prefs, opensOn: value, tabs });
  };
  // The view Home opens on stays a tab; any other can be put away.
  const fixed = (item: HomeTab) => item === prefs.opensOn || (prefs.opensOn === 'last' && prefs.tabs.length === 1 && prefs.tabs[0] === item);
  const toggle = (item: HomeTab) => {
    if (fixed(item)) return;
    const tabs = prefs.tabs.includes(item) ? prefs.tabs.filter((other) => other !== item) : HOME_TABS.filter((other) => other === item || prefs.tabs.includes(other));
    onChange({ ...prefs, tabs });
  };
  return (
    <div ref={box} className="home-menu" role="dialog" aria-label="Home's views">
      <p className="home-eyebrow">Home opens on</p>
      {[...HOME_TABS, 'last' as const].map((item) => (
        <label key={item} className={`home-menu-opt${prefs.opensOn === item ? ' is-on' : ''}`}>
          <input type="radio" name="home-opens-on" checked={prefs.opensOn === item} onChange={() => opensOn(item)} />
          <span>
            <b>{item === 'last' ? 'Whichever I used last' : TAB_LABEL[item]}</b>
            {item === 'last' ? null : <small>{TAB_ABOUT[item]}</small>}
          </span>
        </label>
      ))}
      <p className="home-eyebrow home-menu-split">Show as tabs</p>
      <div className="home-menu-tabs">
        {HOME_TABS.map((item) => (
          <label key={item} className={fixed(item) ? 'is-fixed' : undefined} title={fixed(item) ? 'Home opens on it, so it stays' : undefined}>
            <input type="checkbox" checked={prefs.tabs.includes(item)} disabled={fixed(item)} onChange={() => toggle(item)} />
            {prefs.tabs.includes(item) ? <CheckIcon size={11} strokeWidth={3} className="home-menu-tick" /> : null}
            {TAB_LABEL[item]}
          </label>
        ))}
      </div>
      <label className="home-menu-check">
        <input type="checkbox" checked={prefs.clearPanels} onChange={() => onChange({ ...prefs, clearPanels: !prefs.clearPanels })} />
        <span>
          <b>Put the side panels away on Home</b>
          <small>The library and the dock close while you are on Home, and come back as they were when you open a paper.</small>
        </span>
      </label>
      <p className="home-menu-foot">
        <kbd>1</kbd>–<kbd>{Math.min(9, prefs.tabs.length)}</kbd> switch views · <kbd>/</kbd> search · <kbd>R</kbd> in a paper opens your desk
      </p>
    </div>
  );
}

