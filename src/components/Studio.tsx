// ===========================================================================
//  Studio — a page's process walked step by step, full screen.
//
//  The scene is src/lib/studio.ts: the slots, what the state looks like at
//  each, the lesson steps with their equations, the readouts. This file draws
//  it. The slots stand in a row in 3-D (across the screen, or receding into it
//  along one wall), the state is lifted off the first, carried past the
//  others — its picture tweening from slot to slot — and set down at the
//  last; the equation of the current lesson step stays above, the readouts
//  and the step's note beside, and a scrubber below. The card in the page is
//  the same scene at rest: its slots in a strip, and the button that opens it.
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { frameAt, frameAtSlot, readoutsAt, stepAt, stepStarts, walkAt } from '../lib/studio';
import type { StudioSpec } from '../lib/studio';
import { FrameCanvas, toneOf } from './StudioFrame';
import { typesetMath } from '../lib/typesetMath';
import { CloseIcon, SparkleIcon } from './icons';

export type StudioView = 'row' | 'wall' | 'strip';
const VIEWS: { id: StudioView; label: string; note: string }[] = [
  { id: 'row', label: 'Row', note: 'The slots across the screen, the state carried left to right' },
  { id: 'wall', label: 'Wall', note: 'The slots receding into the screen along one wall, the state carried toward you' },
  { id: 'strip', label: 'Strip', note: 'Every slot side by side, flat' },
];
const VIEW_KEY = 'reader.studio.view';
const readView = (): StudioView => {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === 'row' || stored === 'wall' || stored === 'strip') return stored;
  } catch {
    // private mode
  }
  return 'row';
};

/** How long the walk from one slot to the next takes when playing. */
const SLOT_MS = 2400;
/** How high the state is carried, in pixels of the stage. */
const LIFT_PX = 130;
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

// ---------------------------------------------------------------------------
// The equation of the current step
// ---------------------------------------------------------------------------

function Equation({ tex }: { tex: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void typesetMath(ref.current);
  }, [tex]);
  return (
    <div ref={ref} className="studio-eq-math">
      <div key={tex} className="chat-math-block" data-tex={tex}>
        {tex}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage: the slots, the carried state, the floor
// ---------------------------------------------------------------------------

function Stage({ spec, p, view, seed }: { spec: StudioSpec; p: number; view: StudioView; seed: number }) {
  const n = spec.slots.length;
  const walk = walkAt(p, n);
  const tone = toneOf(spec);
  const carried = useMemo(() => frameAt(spec, p, seed), [spec, p, seed]);
  const slotFrames = useMemo(() => spec.slots.map((_, i) => frameAtSlot(spec, i, seed)), [spec, seed]);
  // Drag to orbit the row or the wall; the strip is flat.
  const [orbit, setOrbit] = useState(0);
  const drag = useRef<{ x: number; orbit: number } | null>(null);
  useEffect(() => setOrbit(0), [view]);
  const onPointerDown = (event: React.PointerEvent) => {
    if (view === 'strip' || event.button !== 0) return;
    drag.current = { x: event.clientX, orbit };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag.current) return;
    setOrbit(Math.max(-40, Math.min(40, drag.current.orbit + (event.clientX - drag.current.x) * 0.15)));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  if (view === 'strip') {
    return (
      <div className="studio-strip" role="list" aria-label={`${spec.state}, one ${spec.unit} at a time`}>
        {spec.slots.map((label, i) => {
          const held = i === walk.slot && walk.phase !== 'setdown';
          return (
            <div key={i} role="listitem" className={`studio-strip-slot${i < walk.position - 0.35 ? ' is-passed' : ''}${held ? ' is-held' : ''}`}>
              <FrameCanvas frame={held ? carried : slotFrames[i]} tone={tone} label={`${spec.state} at ${label}`} />
              <span className="studio-slot-label">{label}</span>
            </div>
          );
        })}
      </div>
    );
  }

  // The row across the screen, or the wall receding into it: the same slots, placed and turned differently.
  const spacing = view === 'wall' ? Math.max(120, Math.min(190, 1700 / n)) : Math.max(88, Math.min(150, 960 / n));
  const place = (i: number): [number, number] => (view === 'wall' ? [0, (n - 1 - i) * -spacing + 150] : [(i - (n - 1) / 2) * spacing, (i - (n - 1) / 2) * -6]);
  const at = place(walk.slot);
  const to = place(walk.next);
  const cx = at[0] + (to[0] - at[0]) * walk.between;
  const cz = at[1] + (to[1] - at[1]) * walk.between;
  const lift = walk.lift * LIFT_PX;
  const turned = walk.phase === 'carry';
  const carry =
    view === 'wall'
      ? `translate3d(${cx + 110}px, ${-lift}px, ${cz}px) rotateY(${90 - (turned ? 40 : 0)}deg) scale(1.1)`
      : `translate3d(${cx}px, ${-lift}px, ${cz + 60}px) rotateY(${turned ? 26 : 0}deg) scale(1.25)`;
  const world = view === 'wall' ? `translate(-50%, 0) translateX(-340px) rotateY(${-46 + orbit}deg) translateZ(-20px)` : `translate(-50%, 0) rotateY(${-20 + orbit}deg) translateX(-40px)`;
  const trail: JSX.Element[] = [];
  const dots = Math.floor(p * 48);
  for (let q = 0; q < dots; q++) {
    const f = q / 48;
    const w = walkAt(f, n);
    const a = place(w.slot);
    const b = place(w.next);
    const x = a[0] + (b[0] - a[0]) * w.between;
    const z = a[1] + (b[1] - a[1]) * w.between;
    const l = w.lift * LIFT_PX;
    trail.push(<i key={q} style={{ transform: view === 'wall' ? `translate3d(${x + 107}px, ${-l - 3}px, ${z - 3}px)` : `translate3d(${x - 3}px, ${-l - 3}px, ${z + 60}px)` }} />);
  }
  return (
    <div className={`studio-scene is-${view}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="studio-world" style={{ transform: world }}>
        <div className="studio-floor" />
        <div className="studio-slots">
          {spec.slots.map((label, i) => {
            const [x, z] = place(i);
            const passed = i < walk.position - 0.35 && i > 0;
            const empty = (i === 0 && p < 1 - LIFT_SPAN_EPS) || (i === n - 1 && p < 1 - LIFT_SPAN_EPS);
            return (
              <div key={i} className={`studio-slot${passed ? ' is-passed' : ''}${empty ? ' is-empty' : ''}`} style={{ transform: `translate3d(${x}px, 0, ${z}px)${view === 'wall' ? ' rotateY(90deg)' : ''}` }}>
                <FrameCanvas frame={slotFrames[i]} tone={tone} label={`${spec.state} at ${label}`} />
                {empty ? <div className="studio-ghost" /> : null}
                <div className="studio-stand" />
                <div className="studio-slot-label">{label}</div>
              </div>
            );
          })}
        </div>
        <div className="studio-trail">{trail}</div>
        <div className="studio-carry" style={{ transform: carry }}>
          <FrameCanvas frame={carried} tone={tone} label={`${spec.state}, in hand`} />
          <div className="studio-shadow" style={{ top: `${120 + lift}px`, opacity: 0.2 + 0.6 * (1 - walk.lift) }} />
          <div className="studio-tag">{walk.phase === 'pickup' ? `picking up · ${spec.slots[0]}` : walk.phase === 'setdown' ? `setting down · ${spec.slots[n - 1]}` : `in hand · ${spec.unit} ${walk.slot + 1} of ${n}`}</div>
        </div>
      </div>
    </div>
  );
}
/** The last slot shows its own frame only once the state is set down on it; the first, only before it is picked up. */
const LIFT_SPAN_EPS = 0.02;

// ---------------------------------------------------------------------------
// The Studio, full screen
// ---------------------------------------------------------------------------

export function Studio({ spec, title, kicker, onClose }: { spec: StudioSpec; title: string; /** The track and the page, for the bar. */ kicker?: string; onClose: () => void }) {
  const n = spec.slots.length;
  const [p, setP] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<StudioView>(() => (reducedMotion() ? 'strip' : readView()));
  const [seed, setSeed] = useState(1);
  const step = stepAt(spec, p);
  const starts = useMemo(() => stepStarts(spec), [spec]);
  const current = spec.steps[step];
  const readouts = readoutsAt(spec, p);
  const walk = walkAt(p, n);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // private mode
    }
  }, [view]);

  // Playing: the walk advances at a slot every few seconds, and holds at the end.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setP((current) => {
        const next = Math.min(1, current + dt / (SLOT_MS * Math.max(1, n - 1)));
        if (next >= 1) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, n]);

  const play = useCallback(() => {
    setP((current) => (current >= 1 ? 0 : current));
    setPlaying((on) => !on);
  }, []);
  const toSlot = useCallback(
    (slot: number) => {
      setPlaying(false);
      setP(n < 2 ? 0 : Math.max(0, Math.min(n - 1, slot)) / (n - 1));
    },
    [n],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === ' ') {
        event.preventDefault();
        play();
      } else if (event.key === ']' || event.key === 'ArrowRight') {
        event.preventDefault();
        toSlot(Math.floor(walk.position + 1e-6) + 1);
      } else if (event.key === '[' || event.key === 'ArrowLeft') {
        event.preventDefault();
        toSlot(Math.ceil(walk.position - 1e-6) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, play, toSlot, walk.position]);

  return (
    <div className="studio" role="dialog" aria-modal="true" aria-label={`Studio: ${title || spec.state}`}>
      <header className="explain-bar studio-bar">
        <span className="explain-brand">
          <SparkleIcon size={15} /> Studio
        </span>
        <span className="explain-bar-title">
          {kicker ? `${kicker} · ` : ''}
          {title || spec.state}
        </span>
        <div className="segmented" role="group" aria-label="How the slots are laid out">
          {VIEWS.map((item) => (
            <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => setView(item.id)} title={item.note}>
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the Studio (Esc)" title="Close (Esc)">
          <CloseIcon size={17} />
        </button>
      </header>
      <div className="studio-body">
        <aside className="studio-rail">
          <h4>Steps</h4>
          <ol className="studio-steps">
            {spec.steps.map((item, i) => (
              <li key={i} className={i === step ? 'is-on' : ''}>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setP(starts[i]);
                  }}
                >
                  <span className="n">{i + 1}</span>
                  {item.title}
                </button>
              </li>
            ))}
          </ol>
          <h4>In hand</h4>
          <p className="studio-state">{spec.state}</p>
          <h4>Slots</h4>
          <p className="studio-state">
            {n} · one {spec.unit} each
          </p>
          {spec.show.kind === 'noise' ? (
            <button type="button" className="btn sm ghost" onClick={() => setSeed((s) => s + 1)} title="Draw the noise again from a different seed">
              Reroll the noise
            </button>
          ) : null}
        </aside>
        <div className="studio-stage">
          <div className="studio-eq">
            <span className="studio-eq-label">
              step {step + 1} of {spec.steps.length} · {current?.title}
            </span>
            {current?.equation ? <Equation tex={current.equation} /> : null}
          </div>
          <Stage spec={spec} p={p} view={view} seed={seed} />
          <div className="studio-story">
            {spec.steps.map((item, i) => (
              <div key={i} className={`studio-story-step${i === step ? ' is-on' : ''}`}>
                <b>
                  {i + 1} · {item.title}
                </b>
                {item.note ? <span>{item.note}</span> : null}
              </div>
            ))}
          </div>
          <div className="studio-hint">
            <kbd>space</kbd> play · <kbd>[</kbd>
            <kbd>]</kbd> a {spec.unit} back or on{view !== 'strip' ? ' · drag to orbit' : ''}
          </div>
        </div>
        <aside className="studio-inspector">
          <h4>At this {spec.unit}</h4>
          <div className="studio-readouts">
            <div className="studio-readout">
              <span>{spec.unit}</span>
              <span>
                {walk.slot + 1} of {n} · {spec.slots[walk.slot]}
              </span>
            </div>
            {readouts.map((item) => (
              <div key={item.label} className="studio-readout">
                <span>{item.label}</span>
                <span>{item.value}</span>
              </div>
            ))}
          </div>
          {current?.note ? <div className="studio-note">{current.note}</div> : null}
          {spec.tries.length ? (
            <>
              <h4>Try</h4>
              {spec.tries.map((item, i) => (
                <p key={i} className="studio-try">
                  {item}
                </p>
              ))}
            </>
          ) : null}
          {spec.ask ? (
            <>
              <h4>Ask</h4>
              <p className="studio-ask">{spec.ask}</p>
            </>
          ) : null}
        </aside>
      </div>
      <footer className="studio-bottom">
        <button type="button" className="studio-play" onClick={play} aria-pressed={playing} aria-label={playing ? 'Pause' : 'Play the walk'} title={playing ? 'Pause (space)' : 'Play (space)'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="studio-scrub">
          <input type="range" min={0} max={1000} value={Math.round(p * 1000)} onChange={(event) => (setPlaying(false), setP(Number(event.target.value) / 1000))} aria-label={`Where in the walk, from ${spec.slots[0]} to ${spec.slots[n - 1]}`} />
          <div className="studio-ticks">
            {spec.slots.map((label, i) => (
              <button key={i} type="button" className={`${i === walk.slot ? 'is-on' : ''}${i === 0 ? ' is-first' : i === n - 1 ? ' is-last' : ''}`} style={{ left: `${n < 2 ? 0 : (i / (n - 1)) * 100}%` }} onClick={() => toSlot(i)} title={`Go to ${label}`}>
                {n <= 12 || i === 0 || i === n - 1 || i % Math.ceil(n / 10) === 0 ? label : ''}
              </button>
            ))}
          </div>
        </div>
        <span className="studio-foot mono">
          {walk.phase === 'carry' ? 'walking' : walk.phase === 'pickup' ? 'picking up' : 'setting down'} · {(SLOT_MS / 1000).toFixed(1)} s per {spec.unit}
        </span>
      </footer>
    </div>
  );
}
