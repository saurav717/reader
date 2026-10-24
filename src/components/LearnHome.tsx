// Home's Learn tab: name a topic and how far to go, and the model maps it as
// boxes you open one at a time. The map is drawn here (src/lib/learn.ts lays
// it out), with the tracks in progress beside it.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getState, modelSpec, PROVIDERS, subscribe } from '../lib/assistant';
import { useStore } from '../lib/store';
import {
  BOX_H,
  countRead,
  DEFAULT_PREFS,
  deleteTrack,
  FROM_HINT,
  layoutMap,
  loadTracks,
  nextNode,
  nodeStates,
  openLearnPage,
  startTrack,
  subscribeLearn,
  TO_HINT,
  touchTrack,
  tracks,
  writeMap,
} from '../lib/learn';
import type { LearnNode, LearnPrefs, LearnTrack, NodeState } from '../lib/learn';
import ModelChip from './ModelChip';
import { SparkleIcon } from './icons';
import { relativeDay } from '../lib/libraryLook';

const PREF_CHIPS: { key: keyof LearnPrefs; label: string; note: string }[] = [
  { key: 'pictures', label: 'Pictures first', note: 'Every idea led by a drawing, an analogy or an example' },
  { key: 'plainFirst', label: 'Plain, then formal', note: 'Plain prose on the page; the exact statement folded under it' },
  { key: 'code', label: 'Code cells', note: 'Short runnable cells where running something teaches it' },
  { key: 'checks', label: 'Checks at the end of a page', note: 'Three quick questions that decide how the next page is written' },
];

const STATE_LABEL: Record<NodeState, string> = { confident: 'confident', read: 'read', next: 'up next', ready: 'ready', locked: 'needs a page before it' };

interface Props {
  /** A topic asked for from elsewhere: "Teach me this" on a selection. */
  ask?: { topic: string; context?: string; at: number };
  onOpenPaper: (id: string) => void;
}

export function LearnHome({ ask, onOpenPaper }: Props) {
  const assistant = useSyncExternalStore(subscribe, getState);
  const all = useSyncExternalStore(subscribeLearn, tracks);
  const { papers } = useStore();
  const model = assistant.prefs.explainModel ?? assistant.prefs.model;
  const hasKey = Boolean(assistant.keys[modelSpec(model).provider]);
  const [topic, setTopic] = useState(ask?.topic ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [prefs, setPrefs] = useState<LearnPrefs>(DEFAULT_PREFS);
  const [chosen, setChosen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => void loadTracks(), []);
  useEffect(() => {
    if (ask?.topic) {
      setTopic(ask.topic);
      setChosen(null);
      input.current?.focus();
    }
  }, [ask?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const track = (chosen ? all.find((t) => t.id === chosen) : undefined) ?? all[0];

  const start = async () => {
    if (!topic.trim() || starting || !hasKey) return;
    setStarting(true);
    setError('');
    try {
      const id = await startTrack({ topic: topic.trim(), from: from.trim(), to: to.trim(), prefs, model });
      setChosen(id);
      setTopic('');
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

  return (
    <div className="home-view learn-home">
      <section className="learn-hero">
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
            <button key={chip.key} type="button" className={`chip${prefs[chip.key] ? ' is-on' : ''}`} aria-pressed={prefs[chip.key]} title={chip.note} onClick={() => setPrefs({ ...prefs, [chip.key]: !prefs[chip.key] })}>
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
        {error ? <p className="learn-note is-error">{error}</p> : null}
      </section>

      {track ? (
        <div className="learn-cols">
          <TrackMap track={track} onOpen={(node) => openNode(track, node)} />
          <aside className="learn-side">
            <h3 className="home-eyebrow">In progress</h3>
            {all.map((t) => (
              <TrackCard key={t.id} track={t} current={t.id === track.id} onPick={() => setChosen(t.id)} onOpen={(node) => openNode(t, node)} />
            ))}
            {ask?.context ? (
              <section className="home-card learn-from">
                <div className="t">“{ask.topic}”</div>
                <div>{ask.context}</div>
              </section>
            ) : null}
          </aside>
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
  );
}

/** The map: stages as columns, each page a box coloured by where you are, the needs as curves between them. */
function TrackMap({ track, onOpen }: { track: LearnTrack; onOpen: (node: LearnNode) => void }) {
  const layout = useMemo(() => layoutMap(track), [track.stages, track.nodes]); // eslint-disable-line react-hooks/exhaustive-deps
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
              return (
                <g key={box.id} className={`map-node is-${state}${node.kind === 'paper' ? ' is-paper' : ''}`} role="listitem" tabIndex={0} onClick={() => onOpen(node)} onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), onOpen(node))}>
                  <title>
                    {node.title} — {STATE_LABEL[state]}. {node.blurb}
                  </title>
                  <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={9} />
                  <text x={box.x + box.w / 2} y={box.y + BOX_H / 2 + 4.5} textAnchor="middle">
                    {node.kind === 'paper' ? '📄 ' : ''}
                    {node.title.length > 20 ? `${node.title.slice(0, 19)}…` : node.title}
                    {state === 'next' ? ' ▸' : ''}
                  </text>
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
            <span className="learn-legend-note">Click a box to open its page — it is written then. A dashed box is a paper, opened in the reader.</span>
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
  const next = nextNode(track);
  const pct = counts.total ? Math.round((counts.read / counts.total) * 100) : 0;
  const when = track.opened ?? track.updated;
  return (
    <section className={`home-card learn-track${current ? ' is-current' : ''}`}>
      <button type="button" className="learn-track-pick" onClick={onPick}>
        <span className="t">{track.topic}</span>
        <span className="m">
          {track.mapping ? 'mapping…' : `${counts.total} pages · ${counts.read} read`}
          {when ? ` · ${relativeDay(new Date(when).toISOString(), new Date())}` : ''}
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
