// Running playgrounds, around the app. src/lib/playgroundRuns.ts says what
// each playground is doing; this draws it, in the ways the person has chosen
// (Settings → Running playgrounds, settings.runningShows):
//
// - shelf    the Playground home's "Running now" shelf, and a state on each row of its list;
// - dock     a count on the rail's Playground button, a dock in the corner of every page, a toast as a run ends;
// - switcher P opens a switcher — running first, then what needs a look, then the rest;
// - tabs     the playgrounds opened in this tab, as tabs across the top of every page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { loadPlaygrounds, usePlaygrounds } from '../lib/playground';
import type { PlaygroundRun, RunEnded } from '../lib/playgroundRuns';
import { ago, clock, closeTab, isLive, phaseLabel, phaseNote, shutDownPlayground, stopPlayground, useRunBoard, useRunEnded, useTabs } from '../lib/playgroundRuns';
import { useStore } from '../lib/store';
import type { RunningShows } from '../types';
import { ColabMark } from './Colab';
import { ChevronDownIcon, CloseIcon } from './icons';

/** Every playground's standing, the live ones first. */
export function useRuns(): PlaygroundRun[] {
  return useRunBoard(usePlaygrounds());
}

const tone = (run: PlaygroundRun) =>
  run.phase === 'running' || run.phase === 'connecting' ? 'run' : run.phase === 'paused' || run.phase === 'idle' ? 'warm' : run.phase === 'failed' ? 'bad' : run.phase === 'ran' ? 'done' : 'cold';

/** The machine's mark: co for Colab, else a computer's. */
function Where({ run }: { run: PlaygroundRun }) {
  return (
    <span className="pr-where">
      {run.where.startsWith('Colab') ? <ColabMark /> : <span className="pg-mark is-pc">PC</span>}
      <span>{run.where}</span>
    </span>
  );
}

export function RunPill({ run }: { run: PlaygroundRun }) {
  return (
    <span className={`pr-pill is-${tone(run)}`}>
      <i aria-hidden="true" />
      {phaseLabel(run)}
    </span>
  );
}

function Progress({ run }: { run: PlaygroundRun }) {
  const value = run.progress;
  return (
    <span className={`pr-bar${value === null || value === undefined ? ' is-unknown' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null || value === undefined ? undefined : Math.round(value * 100)}>
      <i style={value === null || value === undefined ? undefined : { width: `${Math.max(2, Math.round(value * 100))}%` }} />
    </span>
  );
}

// ------------------------------------------------------------ shelf ----

/** The Playground home's top shelf: each playground running now, what it is on, its last line, Stop and Open. */
export function RunningShelf({ runs, onOpen }: { runs: PlaygroundRun[]; onOpen: (id: string) => void }) {
  const live = runs.filter(isLive);
  if (!live.length) return null;
  return (
    <section className="pr-shelf" aria-label="Running now">
      <div className="pg-section-head">
        <span className="eyebrow pr-live-head">
          <i className="pr-dot is-run" aria-hidden="true" />
          Running now · {live.length}
        </span>
        <span className="pg-aside">it keeps going when you leave this page — it runs on the machine, not in the page</span>
      </div>
      <div className="pr-cards">
        {live.map((run) => (
          <article key={run.id} className="pr-card">
            <div className="pr-card-head">
              <i className="pr-dot is-run" aria-hidden="true" />
              <b title={run.title}>{run.title}</b>
              <Where run={run} />
            </div>
            <div className="pr-card-now">
              <span>
                {run.phase === 'paused' ? 'Paused' : run.phase === 'connecting' ? 'Connecting…' : run.label}
                {run.code ? <code> · {run.code}</code> : null}
              </span>
              <span className="pr-mono">{run.startedAt ? clock(Date.now() - run.startedAt) : ''}</span>
            </div>
            <Progress run={run} />
            <div className="pr-tail">{run.tail ?? 'no output yet'}</div>
            <div className="pr-card-foot">
              <span>{run.queued ? `${run.queued} more ${run.queued === 1 ? 'cell' : 'cells'} queued` : run.also?.length ? `also: ${run.also.join(', ')}` : run.kind === 'project' ? 'Project' : 'Notebook'}</span>
              <span className="spacer" />
              <button type="button" className="btn sm pr-stop" onClick={() => void stopPlayground(run.id)}>
                Stop
              </button>
              <button type="button" className="btn sm primary" onClick={() => onOpen(run.id)}>
                Open
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/** A row's state in the home's list: the pill, and what coming back to it will be like. */
export function RunRowState({ run }: { run: PlaygroundRun }) {
  return (
    <span className="pr-row-state">
      <RunPill run={run} />
      <small>{phaseNote(run)}</small>
    </span>
  );
}

/** What can be done from a row besides Open: stop a run, or shut down a kernel left idle. */
export function RunRowAction({ run }: { run: PlaygroundRun }) {
  if (isLive(run))
    return (
      <button type="button" className="btn sm pr-stop" onClick={() => void stopPlayground(run.id)}>
        Stop
      </button>
    );
  if (run.phase === 'idle')
    return (
      <button type="button" className="btn sm" onClick={() => void shutDownPlayground(run.id)} title={run.where.startsWith('Colab') ? 'Stops the Colab runtime: its variables go, and it uses no more units' : 'Shuts the kernel down: its variables go'}>
        Shut down
      </button>
    );
  return null;
}

// -------------------------------------------------------- the rail ----

/** On the rail's Playground button: how many run, and on hover, what each is doing. */
export function RailRunBadge({ onOpen }: { onOpen: (id: string) => void }) {
  const runs = useRuns();
  const live = runs.filter(isLive);
  const idle = runs.filter((run) => run.phase === 'idle');
  if (!live.length && !idle.length) return null;
  return (
    <>
      <span className={`pr-badge${live.length ? '' : ' is-idle'}`} aria-label={live.length ? `${live.length} running` : 'a kernel is idle'}>
        {live.length || ''}
      </span>
      <div className="pr-rail-pop" role="tooltip">
        <b>Playground</b>
        {[...live, ...idle].map((run) => (
          <button key={run.id} type="button" onClick={() => onOpen(run.id)}>
            <i className={`pr-dot is-${tone(run)}`} aria-hidden="true" />
            <span>{run.title}</span>
            <small>{isLive(run) ? run.label ?? phaseLabel(run) : 'idle'}</small>
          </button>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------- the dock ----

const FOLD_KEY = 'reader.playground.dock-folded';
const readFold = () => {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * In the corner of every page but the running playground's own, while
 * something runs: each run, how far it has got, Stop and Open. It folds to a
 * pill, and goes when nothing runs. Toasts stack over it as runs end.
 */
export function RunDock({ current, onOpen }: { current?: string; onOpen: (id: string) => void }) {
  const runs = useRuns();
  const live = runs.filter((run) => isLive(run) && run.id !== current);
  const [folded, setFolded] = useState(readFold);
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? '1' : '0');
    } catch {
      // Only a convenience.
    }
  };
  return (
    <div className="pr-corner">
      <RunToasts current={current} onOpen={onOpen} />
      {live.length ? (
        folded ? (
          <button type="button" className="pr-dock-pill" onClick={() => fold(false)} aria-label={`${live.length} running — show them`}>
            <i className="pr-dot is-run" aria-hidden="true" />
            Running · {live.length}
            {live.length === 1 && live[0].progress !== null && live[0].progress !== undefined ? <span className="pr-mono"> {Math.round(live[0].progress * 100)}%</span> : null}
          </button>
        ) : (
          <section className="pr-dock" aria-label="Running playgrounds">
            <header>
              <i className="pr-dot is-run" aria-hidden="true" />
              <b>Running · {live.length}</b>
              <span className="spacer" />
              <button type="button" className="icon-btn sm" aria-label="Fold the dock" title="Fold" onClick={() => fold(true)}>
                <ChevronDownIcon size={14} />
              </button>
            </header>
            {live.map((run) => (
              <div key={run.id} className="pr-job">
                <div className="pr-job-top">
                  <Where run={run} />
                  <b title={run.title}>{run.title}</b>
                  <span className="pr-mono">{run.phase === 'paused' ? 'paused' : run.label}</span>
                </div>
                <Progress run={run} />
                {run.also?.length ? <div className="pr-job-also">also {run.also.join(' · ')}</div> : null}
                <div className="pr-job-foot">
                  <span className="pr-mono">{run.tail ?? (run.startedAt ? clock(Date.now() - run.startedAt) : '')}</span>
                  <button type="button" className="link pr-stop" onClick={() => void stopPlayground(run.id)}>
                    Stop
                  </button>
                  <button type="button" className="link" onClick={() => onOpen(run.id)}>
                    Open →
                  </button>
                </div>
              </div>
            ))}
          </section>
        )
      ) : null}
    </div>
  );
}

/** A toast as each run ends — off its own page — saying how it ended; it goes after a few seconds. */
function RunToasts({ current, onOpen }: { current?: string; onOpen: (id: string) => void }) {
  const [toasts, setToasts] = useState<RunEnded[]>([]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const add = useCallback((event: RunEnded) => {
    if (event.id === currentRef.current) return;
    setToasts((list) => [...list.filter((t) => t.id !== event.id), event].slice(-3));
    window.setTimeout(() => setToasts((list) => list.filter((t) => t !== event)), 9000);
  }, []);
  useRunEnded(add);
  if (!toasts.length) return null;
  return (
    <div className="pr-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={`${toast.id}:${toast.at}`} className={`pr-toast is-${toast.phase}`}>
          <span className="pr-toast-mark" aria-hidden="true">
            {toast.phase === 'ran' ? '✓' : toast.phase === 'failed' ? '!' : '■'}
          </span>
          <div>
            <b>
              {toast.title} {toast.phase === 'ran' ? 'finished' : toast.phase === 'failed' ? 'failed' : 'stopped'}
            </b>
            <span>{toast.detail}</span>
            <div className="pr-toast-acts">
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  setToasts((list) => list.filter((t) => t !== toast));
                  onOpen(toast.id);
                }}
              >
                {toast.phase === 'failed' ? 'See the error' : 'See results'}
              </button>
              <button type="button" className="btn sm" onClick={() => setToasts((list) => list.filter((t) => t !== toast))}>
                Later
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------ the switcher ----

/** P's switcher: running first, then what needs a look (failed, idle), then the rest; typed letters narrow it. */
export function RunSwitcher({ onOpen, onHome, onClose }: { onOpen: (id: string) => void; onHome: () => void; onClose: () => void }) {
  useEffect(() => {
    void loadPlaygrounds();
  }, []);
  const runs = useRuns();
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((run) => !q || run.title.toLowerCase().includes(q) || run.where.toLowerCase().includes(q)).slice(0, 12);
  }, [runs, query]);
  const groups: { title: string; tone?: string; items: PlaygroundRun[] }[] = [
    { title: 'Running', tone: 'run', items: shown.filter(isLive) },
    { title: 'Needs a look', items: shown.filter((run) => run.phase === 'failed' || run.phase === 'idle') },
    { title: 'Pick up where you left off', items: shown.filter((run) => !isLive(run) && run.phase !== 'failed' && run.phase !== 'idle') },
  ].filter((group) => group.items.length);
  const flat = groups.flatMap((group) => group.items);
  const pick = Math.min(at, Math.max(0, flat.length));
  const go = (index: number) => {
    onClose();
    if (index >= flat.length) onHome();
    else onOpen(flat[index].id);
  };
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setAt((n) => Math.min(flat.length, n + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setAt((n) => Math.max(0, n - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(pick);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  let index = -1;
  return (
    <>
      <div className="scrim pr-scrim" onClick={onClose} />
      <div className="pr-switch" role="dialog" aria-label="Go to a playground" onKeyDown={keys}>
        <div className="pr-switch-q">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setAt(0);
            }}
            placeholder="Go to a playground…"
            aria-label="Find a playground"
          />
          <kbd>esc</kbd>
        </div>
        <div className="pr-switch-list" role="listbox">
          {groups.map((group) => (
            <div key={group.title} className="pr-switch-group">
              <span className={`eyebrow${group.tone ? ' pr-live-head' : ''}`}>{group.title}</span>
              {group.items.map((run) => {
                index += 1;
                const mine = index;
                return (
                  <button key={run.id} type="button" role="option" aria-selected={pick === mine} className={`pr-switch-item${pick === mine ? ' is-on' : ''}`} onMouseEnter={() => setAt(mine)} onClick={() => go(mine)}>
                    <i className={`pr-dot is-${tone(run)}`} aria-hidden="true" />
                    <span className="pr-switch-main">
                      <b>{run.title}</b>
                      <small>
                        {run.where}
                        {isLive(run) ? ` · ${run.label ?? phaseLabel(run)}` : run.at ? ` · ${ago(run.at)}` : ''}
                      </small>
                    </span>
                    {isLive(run) ? <Progress run={run} /> : <RunPill run={run} />}
                  </button>
                );
              })}
            </div>
          ))}
          <button type="button" role="option" aria-selected={pick === flat.length} className={`pr-switch-item is-home${pick === flat.length ? ' is-on' : ''}`} onMouseEnter={() => setAt(flat.length)} onClick={() => go(flat.length)}>
            <span className="pr-switch-main">
              <b>The Playground’s home</b>
              <small>start something new, or see every playground</small>
            </span>
          </button>
        </div>
        <div className="pr-switch-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>P</kbd> again from anywhere
          </span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------- the tabs ----

/** Across the top of every page: the playgrounds opened in this tab, and any running; each with its state. Closing one stops nothing. */
export function RunTabs({ current, onOpen }: { current?: string; onOpen: (id: string) => void }) {
  useEffect(() => {
    void loadPlaygrounds();
  }, []);
  const runs = useRuns();
  const tabs = useTabs();
  const shown = runs.filter((run) => tabs.includes(run.id) || isLive(run) || run.id === current).sort((a, b) => tabs.indexOf(a.id) - tabs.indexOf(b.id));
  if (!shown.length) return null;
  return (
    <nav className="pr-tabs" aria-label="Open playgrounds">
      {shown.map((run) => (
        <div key={run.id} className={`pr-tab${run.id === current ? ' is-on' : ''}`}>
          <button type="button" className="pr-tab-main" onClick={() => onOpen(run.id)} title={`${run.title} — ${phaseLabel(run)} · ${run.where}`} aria-current={run.id === current ? 'page' : undefined}>
            <i className={`pr-dot is-${tone(run)}`} aria-hidden="true" />
            <span>{run.title}</span>
            {isLive(run) && run.progress !== null && run.progress !== undefined ? <small className="pr-mono">{Math.round(run.progress * 100)}%</small> : null}
          </button>
          <button type="button" className="pr-tab-x" aria-label={`Close the tab for ${run.title} (it goes on running)`} title={isLive(run) ? 'Close the tab — the run goes on' : 'Close the tab'} onClick={() => closeTab(run.id)}>
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------- choosing ----

export const RUNNING_SHOWS: { id: keyof RunningShows; label: string; note: string }[] = [
  { id: 'shelf', label: 'A · Running now, on the Playground’s home', note: 'A shelf of what runs at the top of the Playground, and on each playground in its list whether it is idle, finished, failed or stopped.' },
  { id: 'dock', label: 'B · A dock and a count, on every page', note: 'A count on the rail’s Playground button, a dock in the corner while anything runs, and a toast when a run ends.' },
  { id: 'switcher', label: 'C · P opens a switcher', note: 'P from anywhere lists the playgrounds — running first — instead of going to the Playground’s home.' },
  { id: 'tabs', label: 'D · Tabs across the top', note: 'The playgrounds you opened in this tab stay as tabs above every page, with a live dot on each.' },
];

/** The four ways, each a switch; A and B are what the app starts with. */
export function RunningChooser({ compact = false }: { compact?: boolean }) {
  const { settings, updateSettings } = useStore();
  const shows = settings.runningShows;
  const recommended = shows.shelf && shows.dock && !shows.switcher && !shows.tabs;
  return (
    <div className={`pr-choose${compact ? ' is-compact' : ''}`}>
      {RUNNING_SHOWS.map((option) => (
        <label key={option.id} className="pr-choose-row">
          <input type="checkbox" checked={shows[option.id]} onChange={(event) => updateSettings({ runningShows: { ...shows, [option.id]: event.target.checked } })} />
          <span>
            <strong>{option.label}</strong>
            {option.id === 'shelf' || option.id === 'dock' ? <em className="pr-rec">default</em> : null}
            <br />
            <small>{option.note}</small>
          </span>
        </label>
      ))}
      <div className="pr-choose-foot">
        <button type="button" className="btn sm" disabled={recommended} onClick={() => updateSettings({ runningShows: { shelf: true, dock: true, switcher: false, tabs: false } })}>
          Back to the default (A and B)
        </button>
        <button type="button" className="btn sm ghost" onClick={() => updateSettings({ runningShows: { shelf: true, dock: true, switcher: true, tabs: true } })}>
          All four
        </button>
      </div>
    </div>
  );
}
