// The Learn page, on the rail: everything you have set out to learn. A box
// to search it — topics, pages, the terms they taught, their text — the
// tracks down the left, the chosen track's map beside them, and a form for
// a new topic. The map is drawn here (src/lib/learn.ts lays it out).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getState, modelSpec, PROVIDERS, subscribe } from '../lib/assistant';
import { useStore } from '../lib/store';
import {
  BOX_H,
  countRead,
  DEFAULT_PREFS,
  deleteTrack,
  driveStateOf,
  FROM_HINT,
  layoutMap,
  loadTracks,
  nextNode,
  nodeStates,
  openLearnPage,
  sceneNodes,
  searchTracks,
  startTrack,
  subscribeLearn,
  syncFromDrive,
  TO_HINT,
  touchTrack,
  tracks,
  trackStatus,
  writeMap,
} from '../lib/learn';
import type { LearnNode, LearnPrefs, LearnTrack, NodeState, SearchHit } from '../lib/learn';
import ModelChip from './ModelChip';
import { SearchIcon, SparkleIcon } from './icons';
import { relativeDay } from '../lib/libraryLook';

const PREF_CHIPS: { key: keyof LearnPrefs; label: string; note: string }[] = [
  { key: 'pictures', label: 'Pictures first', note: 'Every idea led by a drawing, an analogy or an example' },
  { key: 'plainFirst', label: 'Plain, then formal', note: 'Plain prose on the page; the exact statement folded under it' },
  { key: 'code', label: 'Code cells', note: 'Short runnable cells where running something teaches it' },
  { key: 'checks', label: 'Checks at the end of a page', note: 'Three quick questions that decide how the next page is written' },
  { key: 'generate', label: 'Generate a picture if none is found', note: 'When no paper, Commons or web picture shows what a page asks for, one is made by FLUX through Pollinations.ai — free, no key — and captioned as generated' },
];

const STATE_LABEL: Record<NodeState, string> = { confident: 'confident', read: 'read', next: 'up next', ready: 'ready', locked: 'needs a page before it' };

const STATUS_LABEL = { new: 'not started', reading: 'in progress', stalled: 'stalled', finished: 'finished' } as const;
type Filter = 'all' | 'reading' | 'stalled' | 'finished';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'reading', label: 'In progress' },
  { id: 'stalled', label: 'Stalled' },
  { id: 'finished', label: 'Finished' },
];

interface Props {
  /** The track the address names, when it names one. */
  id?: string;
  /** A topic asked for from elsewhere: "Teach me this" on a selection. */
  ask?: { topic: string; context?: string; at: number };
  /** The page's address follows the track shown. */
  onOpen: (id?: string) => void;
  onOpenPaper: (id: string) => void;
}

export default function LearnPage({ id, ask, onOpen, onOpenPaper }: Props) {
  const assistant = useSyncExternalStore(subscribe, getState);
  const all = useSyncExternalStore(subscribeLearn, tracks);
  const { papers, driveConnected } = useStore();
  const model = assistant.prefs.explainModel ?? assistant.prefs.model;
  const hasKey = Boolean(assistant.keys[modelSpec(model).provider]);
  const [topic, setTopic] = useState(ask?.topic ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [prefs, setPrefs] = useState<LearnPrefs>(DEFAULT_PREFS);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  /** The form open: always when there is nothing yet, else on request or on a topic handed in. */
  const [composing, setComposing] = useState(Boolean(ask?.topic));
  const input = useRef<HTMLInputElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => void loadTracks(), []);
  // Drive connected after the page opened is read too.
  useEffect(() => {
    if (driveConnected) void syncFromDrive();
  }, [driveConnected]);
  useEffect(() => {
    if (ask?.topic) {
      setTopic(ask.topic);
      setComposing(true);
      setQuery('');
      window.setTimeout(() => input.current?.focus(), 50);
    }
  }, [ask?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  // "/" goes to the search box, as it does on Home.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = event.target as HTMLElement | null;
      if (typing && (typing.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName))) return;
      if (document.querySelector('.scrim, .sheet, .palette, .explain')) return;
      event.preventDefault();
      searchBox.current?.focus();
      searchBox.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const track = (id ? all.find((t) => t.id === id) : undefined) ?? (id ? undefined : all[0]);
  const now = Date.now();
  const listed = useMemo(() => (filter === 'all' ? all : all.filter((t) => trackStatus(t, now) === filter)), [all, filter, now]);
  const found = useMemo(() => (query.trim() ? searchTracks(all, query.trim()) : null), [all, query]);
  const showForm = composing || !all.length;

  const start = async () => {
    if (!topic.trim() || starting || !hasKey) return;
    setStarting(true);
    setError('');
    try {
      const made = await startTrack({ topic: topic.trim(), from: from.trim(), to: to.trim(), prefs, model });
      onOpen(made);
      setTopic('');
      setComposing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const openNode = (t: LearnTrack, node: LearnNode) => {
    touchTrack(t.id);
    if (node.kind === 'paper') {
      const have = papers.find((paper) => (node.paper?.arxivId && paper.arxivId === node.paper.arxivId) || paper.title.toLowerCase() === (node.paper?.title ?? node.title).toLowerCase());
      if (have) onOpenPaper(have.id);
      else window.dispatchEvent(new CustomEvent('reader:discover', { detail: { query: node.paper?.arxivId ?? node.paper?.title ?? node.title } }));
      return;
    }
    openLearnPage(t.id, node.id);
  };
  /** The map's Studio badge: the page opens with its Studio, or is written first and then opens it. */
  const openStudio = (t: LearnTrack, node: LearnNode) => {
    touchTrack(t.id);
    openLearnPage(t.id, node.id, true);
  };
  const openHit = (t: LearnTrack, hit: SearchHit) => {
    const node = hit.nodeId ? t.nodes.find((n) => n.id === hit.nodeId) : undefined;
    if (node) openNode(t, node);
    else {
      setQuery('');
      onOpen(t.id);
    }
  };

  return (
    <main className="main learn-page" aria-label="Learn">
      <div className="learn-scroll">
        <header className="learn-head">
          <div className="learn-head-text">
            <h1>
              <SparkleIcon size={20} /> Learn
            </h1>
            <p>
              {all.length ? `${all.length} topic${all.length === 1 ? '' : 's'} mapped` : 'A topic of your own, mapped as pages written one at a time'} · {modelSpec(model).label} writes the pages
            </p>
          </div>
          <form
            className={`learn-search${query ? ' is-on' : ''}`}
            role="search"
            onSubmit={(event) => event.preventDefault()}
          >
            <SearchIcon size={16} />
            <input ref={searchBox} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search what you have learned — a topic, a page, a term, a sentence…" aria-label="Search what you have learned" />
            {query ? (
              <button type="button" className="btn sm ghost" onClick={() => setQuery('')} aria-label="Clear the search">
                ×
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </form>
          <button type="button" className={`btn${showForm ? '' : ' primary'}`} onClick={() => (setComposing(!showForm), window.setTimeout(() => input.current?.focus(), 50))}>
            {showForm && all.length ? 'Close' : '+ New topic'}
          </button>
        </header>

        {showForm ? (
          <section className="learn-hero home-card">
            <h2>What do you want to understand?</h2>
            <p>Name a topic and how far you want to go. {modelSpec(model).label} maps it first, then writes each page as you reach it.</p>
            <form
              className="find-box learn-box"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <SparkleIcon size={17} />
              <input ref={input} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="a topic — diffusion models, the immune system, spectral graph theory…" aria-label="The topic to learn" />
              <button type="submit" className="btn primary" disabled={!topic.trim() || starting || !hasKey} title={hasKey ? 'Write the map (Enter)' : `${modelSpec(model).label} needs its key in Settings`}>
                {starting ? <span className="spinner" /> : null} Map it <kbd>↵</kbd>
              </button>
            </form>
            <div className="learn-range">
              <label>
                <span>from</span>
                <input value={from} onChange={(event) => setFrom(event.target.value)} placeholder={FROM_HINT} aria-label="What you already know" />
              </label>
              <label>
                <span>to</span>
                <input value={to} onChange={(event) => setTo(event.target.value)} placeholder={TO_HINT} aria-label="Where you want to get" />
              </label>
            </div>
            <div className="find-options learn-prefs">
              <span className="find-label">Prefers</span>
              {PREF_CHIPS.map((chip) => (
                <button key={chip.key} type="button" className={`chip${prefs[chip.key] ? ' is-on' : ''}`} aria-pressed={Boolean(prefs[chip.key])} title={chip.note} onClick={() => setPrefs({ ...prefs, [chip.key]: !prefs[chip.key] })}>
                  {chip.label}
                </button>
              ))}
              <span className="find-gap" />
              <ModelChip value={model} keys={assistant.keys} what="Maps and writes with" onChange={() => undefined} />
            </div>
            {!hasKey ? (
              <p className="learn-note">
                {modelSpec(model).label} needs its key in Settings ({PROVIDERS[modelSpec(model).provider].name}) before it can map a topic.
              </p>
            ) : null}
            {ask?.context && ask.topic === topic ? <p className="learn-note">{ask.context}</p> : null}
            {error ? <p className="learn-note is-error">{error}</p> : null}
          </section>
        ) : null}

        {found ? (
          <section className="learn-results">
            <h2 className="home-eyebrow">
              {found.length ? `${found.length} topic${found.length === 1 ? '' : 's'} match “${query.trim()}”` : `Nothing you have learned mentions “${query.trim()}”`}
            </h2>
            {found.map(({ track: t, hits }) => (
              <article key={t.id} className="home-card learn-result">
                <button type="button" className="learn-result-head" onClick={() => openHit(t, { kind: 'topic', label: t.topic })}>
                  <span className="t">{t.topic}</span>
                  <span className="m">
                    {STATUS_LABEL[trackStatus(t, now)]} · {countRead(t).read} of {countRead(t).total} read · {relativeDay(new Date(t.opened ?? t.updated).toISOString(), new Date())}
                  </span>
                </button>
                <ul className="learn-hits">
                  {hits
                    .filter((hit) => hit.kind !== 'topic')
                    .map((hit, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => openHit(t, hit)} title={hit.nodeId ? 'Open this page' : 'Open this track'}>
                          <span className={`learn-hit-kind is-${hit.kind}`}>{hit.kind === 'page' ? 'page' : hit.kind === 'term' ? 'term' : 'in the text'}</span>
                          <b>{hit.label}</b>
                          {hit.snippet ? <span className="learn-hit-snippet">{hit.snippet}</span> : null}
                        </button>
                      </li>
                    ))}
                </ul>
              </article>
            ))}
          </section>
        ) : all.length ? (
          <div className="learn-page-cols">
            <aside className="learn-list">
              <div className="learn-filters" role="group" aria-label="Which tracks">
                {FILTERS.map((item) => (
                  <button key={item.id} type="button" className={`chip${filter === item.id ? ' is-on' : ''}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              {listed.map((t) => (
                <TrackCard key={t.id} track={t} current={t.id === track?.id} onPick={() => onOpen(t.id)} onOpen={(node) => openNode(t, node)} />
              ))}
              {!listed.length ? <p className="learn-note">No track is {STATUS_LABEL[filter as keyof typeof STATUS_LABEL] ?? filter}.</p> : null}
            </aside>
            <div className="learn-main">
              {track ? (
                <TrackMap track={track} onOpen={(node) => openNode(track, node)} onOpenStudio={(node) => openStudio(track, node)} />
              ) : (
                <section className="home-card home-view-empty-card">
                  <h2>No such track</h2>
                  <p>The address names a track that is not here. Pick one on the left, or map a new topic.</p>
                </section>
              )}
            </div>
          </div>
        ) : (
          <section className="home-card home-view-empty-card">
            <h2>Nothing mapped yet</h2>
            <p>
              Type a topic above. The map comes first, in a few seconds: a handful of boxes from the ground up, each a ten-minute page, each saying which pages it assumes you have read. Open a box and its page is written then, with
              pictures first, the formal account folded under them, and three quick questions at the end that decide how the next page is written.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

/** The map: stages as columns, each page a box coloured by where you are, the needs as curves between them. */
function TrackMap({ track, onOpen, onOpenStudio }: { track: LearnTrack; onOpen: (node: LearnNode) => void; /** The Studio badge on a page: open the page with its Studio. */ onOpenStudio: (node: LearnNode) => void }) {
  const layout = useMemo(() => layoutMap(track), [track.stages, track.nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const scenes = useMemo(() => sceneNodes(track), [track.nodes, track.pages]); // eslint-disable-line react-hooks/exhaustive-deps
  const sceneCount = { written: 0, planned: 0 };
  for (const state of scenes.values()) sceneCount[state]++;
  const driveState = useSyncExternalStore(subscribeLearn, () => driveStateOf(track.id));
  const states = nodeStates(track);
  const counts = countRead(track);
  const byId = new Map(track.nodes.map((node) => [node.id, node]));
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <section className="home-card learn-map">
      <header className="learn-map-head">
        <h2>{track.topic}</h2>
        {track.nodes.length ? (
          <>
            <span className="pill learn-pill">
              {counts.read} of {counts.total} read
            </span>
            {counts.confident ? <span className="pill learn-pill is-gold">{counts.confident} confident</span> : null}
            {sceneCount.written + sceneCount.planned ? (
              <span className="pill learn-pill is-studio" title={sceneCount.planned ? `${sceneCount.written} written, ${sceneCount.planned} to come when their pages are written` : 'Pages with a Studio scene: a 3-D view of the idea, opened from the ⤢ on the box'}>
                ⤢ {sceneCount.written + sceneCount.planned} Studio{sceneCount.written + sceneCount.planned === 1 ? '' : 's'}
              </span>
            ) : null}
          </>
        ) : null}
        <span className="learn-map-meta">
          {track.mapping ? (
            <>
              <span className="spinner" /> Mapping with {modelSpec(track.model).label}…
            </>
          ) : (
            <>
              Mapped by {modelSpec(track.model).label} · {new Date(track.created).toLocaleDateString()}
              {' · '}
              <button type="button" className="link-btn" onClick={() => void writeMap(track.id)} title="Ask for the map again; pages already written keep their place where their box survives">
                Remap
              </button>
              {' · '}
              {confirmDelete ? (
                <>
                  <button type="button" className="link-btn danger" onClick={() => deleteTrack(track.id)}>
                    Delete the track and its pages
                  </button>{' '}
                  <button type="button" className="link-btn" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" className="link-btn" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              )}
            </>
          )}
        </span>
      </header>
      {(track.from || track.to) && !track.mapping ? (
        <p className="learn-map-range">
          {track.from ? (
            <>
              from <b>{track.from}</b>
            </>
          ) : null}
          {track.from && track.to ? ' · ' : ''}
          {track.to ? (
            <>
              to <b>{track.to}</b>
            </>
          ) : null}
        </p>
      ) : null}
      {driveState ? (
        <p className={`learn-map-drive is-${driveState.state}`}>
          <span className="drive-dot" aria-hidden="true" />
          {driveState.state === 'saving' ? (
            'Saving to your Drive…'
          ) : driveState.state === 'error' ? (
            <span title={driveState.message}>Not saved to Drive — {driveState.message}</span>
          ) : (
            <>
              Kept in your Drive, under Learn
              {driveState.link ?? track.drive?.link ? (
                <>
                  {' · '}
                  <a href={driveState.link ?? track.drive?.link} target="_blank" rel="noreferrer noopener">
                    Open the folder ↗
                  </a>
                </>
              ) : null}
            </>
          )}
        </p>
      ) : null}
      {track.error ? (
        <p className="learn-note is-error">
          {track.error}{' '}
          <button type="button" className="link-btn" onClick={() => void writeMap(track.id)}>
            Try again
          </button>
        </p>
      ) : null}
      {track.nodes.length ? (
        <>
          <svg className="learn-map-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="list" aria-label={`The map of ${track.topic}`}>
            {layout.columns.map((column) => (
              <text key={column.stage} className="map-stage" x={column.x} y={22}>
                {column.stage.toUpperCase()}
              </text>
            ))}
            {layout.edges.map((edge) => (
              <path key={`${edge.from}-${edge.to}`} className={`map-edge${track.progress[edge.from] ? ' is-on' : ''}`} d={edge.d} />
            ))}
            {layout.boxes.map((box) => {
              const node = byId.get(box.id)!;
              const state = states[box.id];
              const scene = scenes.get(box.id);
              return (
                <g key={box.id} className={`map-node is-${state}${node.kind === 'paper' ? ' is-paper' : ''}`} role="listitem" tabIndex={0} onClick={() => onOpen(node)} onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), onOpen(node))}>
                  <title>
                    {node.title} — {STATE_LABEL[state]}. {node.blurb}
                    {scene ? ` Studio${scene === 'planned' ? ' (when the page is written)' : ''}: ${node.studio ?? 'a 3-D view of the idea'}.` : ''}
                  </title>
                  <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={9} />
                  <text x={box.x + box.w / 2} y={box.y + BOX_H / 2 + 4.5} textAnchor="middle">
                    {node.kind === 'paper' ? '📄 ' : ''}
                    {node.title.length > 20 ? `${node.title.slice(0, 19)}…` : node.title}
                    {state === 'next' ? ' ▸' : ''}
                  </text>
                  {scene ? (
                    // The Studio badge, on the box's corner: a written scene opens straight into it; a planned one writes the page first.
                    <g
                      className={`map-studio is-${scene}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${scene === 'written' ? 'Open the Studio' : 'Write the page and open its Studio'}: ${node.studio ?? node.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenStudio(node);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenStudio(node);
                      }}
                    >
                      <title>{`${scene === 'written' ? 'Studio' : 'Studio, when the page is written'}: ${node.studio ?? 'a 3-D view of the idea'}`}</title>
                      <circle cx={box.x + box.w - 2} cy={box.y + 2} r={9} />
                      <text x={box.x + box.w - 2} y={box.y + 5.5} textAnchor="middle">
                        ⤢
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <div className="learn-legend">
            <span>
              <i className="is-read" /> read
            </span>
            <span>
              <i className="is-confident" /> confident
            </span>
            <span>
              <i className="is-next" /> up next
            </span>
            <span>
              <i className="is-ready" /> ready
            </span>
            <span>
              <i className="is-locked" /> needs a page before it
            </span>
            {sceneCount.written + sceneCount.planned ? (
              <span title="A page whose idea is a process or a scene gets a Studio: a 3-D view of it, walked step by step. The ⤢ on a box opens it; a hollow ⤢ is one to come when the page is written.">
                <i className="is-studio" /> has a Studio
              </span>
            ) : null}
            <span className="learn-legend-note">Click a box to open its page — it is written then. A dashed box is a paper, opened in the reader.{sceneCount.written + sceneCount.planned ? ' The ⤢ on a box opens its Studio.' : ''}</span>
          </div>
        </>
      ) : track.mapping ? (
        <div className="learn-map-empty">
          <span className="spinner" /> Working out the stages and the pages…
        </div>
      ) : null}
    </section>
  );
}

function TrackCard({ track, current, onPick, onOpen }: { track: LearnTrack; current: boolean; onPick: () => void; onOpen: (node: LearnNode) => void }) {
  const counts = countRead(track);
  const scenes = sceneNodes(track).size;
  const next = nextNode(track);
  const pct = counts.total ? Math.round((counts.read / counts.total) * 100) : 0;
  const when = track.opened ?? track.updated;
  return (
    <section className={`home-card learn-track${current ? ' is-current' : ''}`}>
      <button type="button" className="learn-track-pick" onClick={onPick}>
        <span className="t">{track.topic}</span>
        <span className="m">
          {track.mapping ? 'mapping…' : `${counts.total} pages · ${counts.read} read${scenes ? ` · ${scenes} Studio${scenes === 1 ? '' : 's'}` : ''}`}
          {when ? ` · ${relativeDay(new Date(when).toISOString(), new Date())}` : ''}
          {!track.mapping ? <em className={`learn-status is-${trackStatus(track)}`}>{STATUS_LABEL[trackStatus(track)]}</em> : null}
        </span>
        <span className="bar">
          <i style={{ width: `${pct}%` }} />
        </span>
      </button>
      {next ? (
        <button type="button" className="learn-track-next" onClick={() => onOpen(next)}>
          Next: <b>{next.title}</b>
          {track.pages[next.id]?.content ? '' : ' — not written yet'}
        </button>
      ) : counts.total && counts.read === counts.total ? (
        <div className="learn-track-next is-done">Every page read.</div>
      ) : null}
    </section>
  );
}
