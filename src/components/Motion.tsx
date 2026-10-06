// ===========================================================================
//  A scene, drawn and played — and the stage that keeps one in view.
//
//  The spec, its layout and its state at a step are src/lib/motion.ts; this
//  file turns them into SVG, tweens between steps, moves the packets along the
//  flows, and wraps the drawing in a card with its caption and controls. The
//  Stage is that card made sticky beside a section's prose, stepping with the
//  paragraph being read until the reader takes the steps in hand.
// ===========================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Block } from '../lib/explain';
import { KeepButton } from './Keep';
import { anchors, charsAcross, clearOf, edgeId, labelRoom, layoutMotion, mix, motionText, overlaps, SCENE_H, SCENE_W, stateAt, stepForParagraph, wrapLabel } from '../lib/motion';
import type { Box, MotionNode, MotionSpec, SceneState, Tone, Values } from '../lib/motion';

export type MotionBlock = Extract<Block, { kind: 'motion' }>;

/** How long a step takes to settle after it changes. */
const TWEEN_MS = 800;
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const tone = (t?: Tone) => `m-${t ?? 'accent'}`;
const numbers = (v: Values | undefined): number[] => (Array.isArray(v) ? (v as unknown[]).filter((n): n is number => typeof n === 'number') : typeof v === 'number' ? [v] : []);
const rows = (v: Values | undefined): number[][] => (Array.isArray(v) && Array.isArray(v[0]) ? (v as number[][]) : Array.isArray(v) ? [v as number[]] : []);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------

function Label({ x, y, text, anchor = 'middle', muted, mono, size = 10 }: { x: number; y: number; text?: string; anchor?: 'start' | 'middle' | 'end'; muted?: boolean; mono?: boolean; size?: number }) {
  if (!text) return null;
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={size} className={`${muted ? 't-muted' : ''}${mono ? ' mono' : ''}`.trim() || undefined}>
      {text}
    </text>
  );
}

/** One node at one moment: its box, its values after the tween, and the phase of any flow through it. */
function Node({ node, box, values, label, phase }: { node: MotionNode; box: Box; values: Values | undefined; label?: string; phase: number | null }) {
  const cls = tone(node.tone);
  const room = labelRoom(node);
  // The body sits under the room kept for the label.
  const { x, w } = box;
  const y = box.y + room;
  const h = box.h - room;
  const top = box.y + 9;
  switch (node.kind) {
    case 'input': {
      // A letter or two sits in the circle; a word goes under it.
      const inside = (label?.length ?? 0) <= 2;
      return (
        <g className={cls}>
          <title>{label}</title>
          <circle cx={x + w / 2} cy={y + 11} r={11} className="m-fill" />
          {inside ? <Label x={x + w / 2} y={y + 14.5} text={label} mono /> : <Label x={x + w / 2} y={y + 32} text={wrapLabel(label, 14, 1)[0]} muted size={9} />}
        </g>
      );
    }
    case 'text': {
      const [line] = wrapLabel(label, 28, 1);
      return (
        <g className={cls}>
          <title>{label}</title>
          <Label x={x + w / 2} y={y + h - 4} text={line} muted={node.tone === 'muted'} />
        </g>
      );
    }
    case 'stack': {
      const n = node.layers ?? 3;
      const lit = phase === null ? -1 : Math.floor(clamp01(phase) * n);
      const gap = n > 6 ? 2 : 4;
      const layer = Math.max(3, Math.min(12, (h - (n - 1) * gap) / n));
      return (
        <g className={`${cls}${node.frozen ? ' m-frozen' : ''}`}>
          {Array.from({ length: n }, (_, i) => {
            const ly = y + (n - 1 - i) * (layer + gap);
            return <rect key={i} x={x} y={ly} width={w} height={layer} rx={3} className={i === lit ? 'm-fill' : 'm-soft'} />;
          })}
          <Label x={x + w / 2} y={top} text={wrapLabel(label, charsAcross(w + 16), 1)[0]} muted={node.frozen} />
        </g>
      );
    }
    case 'dist': {
      const vs = numbers(values);
      const max = Math.max(...vs, 1e-9);
      const n = Math.max(vs.length, 1);
      const bw = w / n;
      const barsH = h - 16;
      return (
        <g className={cls}>
          {vs.map((v, i) => {
            const bh = Math.max(0.6, (v / max) * barsH);
            return <rect key={i} x={x + i * bw + 3} y={y + barsH - bh} width={Math.max(2, bw - 6)} height={bh} rx={2} className="m-fill" />;
          })}
          {node.labels?.slice(0, n).map((name, i) => (
            <Label key={i} x={x + i * bw + bw / 2} y={y + h - 3} text={name} muted size={8.5} />
          ))}
          <Label x={x + w / 2} y={top} text={wrapLabel(label, charsAcross(w + 16, 8.5), 1)[0]} muted mono size={8.5} />
        </g>
      );
    }
    case 'curve': {
      const series = rows(values);
      const all = series.flat();
      const lo = Math.min(...all, 0), hi = Math.max(...all, 1e-9);
      const plotH = h - 4;
      const point = (v: number, i: number, len: number) => `${(x + (i / Math.max(len - 1, 1)) * w).toFixed(1)} ${(y + plotH - ((v - lo) / (hi - lo || 1)) * plotH).toFixed(1)}`;
      return (
        <g className={cls}>
          <line x1={x} y1={y + plotH} x2={x + w} y2={y + plotH} className="m-axis" />
          <line x1={x} y1={y} x2={x} y2={y + plotH} className="m-axis" />
          {series.map((s, k) => (
            <polyline key={k} points={s.map((v, i) => point(v, i, s.length)).join(' ')} className={k === 0 ? 'm-stroke' : 'm-stroke m-second'} />
          ))}
          {node.labels?.slice(0, series.length).map((name, k) => (
            <Label key={k} x={x + w} y={y + 9 + k * 11} text={name} anchor="end" muted size={8.5} />
          ))}
          <Label x={x + w / 2} y={top} text={wrapLabel(label, 24, 1)[0]} muted size={8.5} />
        </g>
      );
    }
    case 'grid': {
      const cells = rows(values);
      const r = Math.max(cells.length, 1);
      const c = Math.max(...cells.map((row) => row.length), 1);
      const cw = w / c, ch = h / r;
      return (
        <g className={cls}>
          {cells.map((row, i) => row.map((v, j) => <rect key={`${i}-${j}`} x={x + j * cw} y={y + i * ch} width={cw - 1} height={ch - 1} className="m-fill" opacity={0.12 + 0.88 * clamp01(v)} />))}
          <Label x={x + w / 2} y={top} text={wrapLabel(label, charsAcross(w + 16, 8.5), 1)[0]} muted size={8.5} />
        </g>
      );
    }
    case 'slider': {
      const lo = node.min ?? 0, hi = node.max ?? 1;
      const v = numbers(values)[0] ?? lo;
      const k = clamp01((v - lo) / (hi - lo || 1));
      const ty = y + 10;
      return (
        <g className={cls}>
          <rect x={x} y={ty - 2} width={w} height={4} rx={2} className="m-track" />
          <circle cx={x + k * w} cy={ty} r={6} className="m-fill" />
          <Label x={x} y={ty + 16} text={String(lo)} anchor="start" muted mono size={8} />
          <Label x={x + w} y={ty + 16} text={String(hi)} anchor="end" muted mono size={8} />
          <Label x={x + w / 2} y={ty + 16} text={`${label ?? ''} = ${Number.isInteger(v) ? v : v.toFixed(1)}`} mono size={9} />
        </g>
      );
    }
    case 'timeline': {
      const events = node.events ?? [];
      const ats = events.map((e) => (typeof e.at === 'number' ? e.at : Number.parseFloat(String(e.at)) || 0));
      const lo = Math.min(...ats, 0), hi = Math.max(...ats, 1);
      const ly = y + h / 2;
      return (
        <g className={cls}>
          <line x1={x} y1={ly} x2={x + w} y2={ly} className="m-axis" />
          {events.map((e, i) => {
            const ex = ats.length > 1 && hi !== lo ? x + ((ats[i] - lo) / (hi - lo)) * w : x + ((i + 0.5) / Math.max(events.length, 1)) * w;
            return (
              <g key={i}>
                <circle cx={ex} cy={ly} r={4.5} className="m-fill" />
                <Label x={ex} y={i % 2 ? ly + 18 : ly - 10} text={e.label} size={8.5} />
                <Label x={ex} y={i % 2 ? ly + 28 : ly - 20} text={String(e.at)} muted mono size={7.5} />
              </g>
            );
          })}
          <Label x={x + w / 2} y={top} text={wrapLabel(label, 40, 1)[0]} muted size={8.5} />
        </g>
      );
    }
    default: {
      // The label at the box's own width: a narrow cell gets smaller type and a tighter wrap.
      const size = w < 70 ? 9 : 10;
      const lines = wrapLabel(label, charsAcross(w, size), h >= 34 ? 2 : 1);
      return (
        <g className={cls}>
          <title>{label}</title>
          <rect x={x} y={y} width={w} height={h} rx={5} className="m-soft" />
          {lines.map((line, i) => (
            <Label key={i} x={x + w / 2} y={y + h / 2 + 3.5 + (i - (lines.length - 1) / 2) * (size + 2)} text={line} size={size} />
          ))}
        </g>
      );
    }
  }
}

/** The scene at a step, tweened from the step before, with the flows moving while `playing`. */
export function MotionScene({ spec, step, playing }: { spec: MotionSpec; step: number; playing: boolean }) {
  const boxes = useMemo(() => layoutMotion(spec), [spec]);
  const target = useMemo(() => stateAt(spec, step), [spec, step]);
  const previous = useRef<SceneState>(target);
  const since = useRef(performance.now());
  const lastStep = useRef(step);
  if (lastStep.current !== step) {
    previous.current = stateAt(spec, lastStep.current);
    lastStep.current = step;
    since.current = performance.now();
  }
  const hasFlow = spec.edges.some((e) => e.flow);
  const [, setTick] = useState(0);
  const t0 = useRef(performance.now());
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const settling = performance.now() - since.current < TWEEN_MS;
      const moving = playing && hasFlow && !reducedMotion();
      if (settling || moving) {
        setTick((n) => n + 1);
        frame = requestAnimationFrame(loop);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, hasFlow, step]);
  const u = clamp01((performance.now() - since.current) / TWEEN_MS);
  const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  const t = playing && !reducedMotion() ? (performance.now() - t0.current) / 1000 : 0;
  const phase = (t * 0.45) % 1;
  // A stack lit layer by layer while packets flow into it: forward from below, backward from above.
  const flowInto = new Map<string, 'forward' | 'backward'>();
  for (const edge of spec.edges) if (edge.flow && target.visible.has(edgeId(edge))) flowInto.set(edge.flow === 'forward' ? edge.to : edge.to, edge.flow);
  const opacityOf = (id: string) => (target.visible.has(id) ? (target.dim.has(id) ? 0.3 : 1) : 0);

  return (
    <svg viewBox={`0 0 ${SCENE_W} ${SCENE_H}`} role="img" aria-label={spec.steps[step]?.caption || 'Scene'}>
      {spec.edges.map((edge) => {
        const id = edgeId(edge);
        const a = boxes.get(edge.from), b = boxes.get(edge.to);
        if (!a || !b) return null;
        const { x1, y1, x2, y2 } = anchors(a, b);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const compare = edge.kind === 'compare';
        const dx = x2 - x1, dy = y2 - y1;
        const sideways = Math.abs(dx) >= Math.abs(dy);
        const d = sideways && Math.abs(dy) > 4 ? `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` : !sideways && Math.abs(dx) > 4 ? `M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
        const text = edge.label ? (edge.label.length > 12 ? edge.label.slice(0, 11) + '…' : edge.label) : '';
        const pillW = text ? 12 + 5.6 * text.length : 0;
        const c1 = sideways && Math.abs(dy) > 4 ? { x: mx, y: y1 } : !sideways && Math.abs(dx) > 4 ? { x: x1, y: my } : { x: x1 + dx / 3, y: y1 + dy / 3 };
        const c2 = sideways && Math.abs(dy) > 4 ? { x: mx, y: y2 } : !sideways && Math.abs(dx) > 4 ? { x: x2, y: my } : { x: x1 + (2 * dx) / 3, y: y1 + (2 * dy) / 3 };
        const at = (q: number) => {
          const u = 1 - q;
          return { x: u * u * u * x1 + 3 * u * u * q * c1.x + 3 * u * q * q * c2.x + q * q * q * x2, y: u * u * u * y1 + 3 * u * u * q * c1.y + 3 * u * q * q * c2.y + q * q * q * y2 };
        };
        const all = Array.from(boxes.values());
        const pill = text
          ? [0.5, 0.3, 0.7].map((q) => { const p = at(q); return { x: p.x - pillW / 2, y: p.y - 9, w: pillW, h: 18 }; }).find((r) => !all.some((box) => overlaps(r, box, 2))) ?? clearOf({ x: mx - pillW / 2, y: my - 9, w: pillW, h: 18 }, all, { dx, dy })
          : null;
        return (
          <g key={id} className={`m-edge ${tone(edge.tone ?? (compare ? 'pink' : 'muted'))}${target.highlight.has(id) ? ' m-hi' : ''}`} style={{ opacity: opacityOf(id) }}>
            <path d={d} className={compare ? 'm-stroke m-dashed' : 'm-stroke'} />
            {edge.flow && playing && !reducedMotion()
              ? [0, 1, 2].map((k) => {
                  const p = (phase + k / 3) % 1;
                  const q = edge.flow === 'backward' ? 1 - p : p;
                  // The point at q along the same cubic the line is drawn with.
                  const { x: px, y: py } = at(q);
                  return <circle key={k} cx={px} cy={py} r={3} className="m-packet" />;
                })
              : null}
            {pill ? (
              <g className="m-pill">
                <title>{edge.label}</title>
                <rect x={pill.x} y={pill.y} width={pill.w} height={pill.h} rx={4} />
                <text x={pill.x + pill.w / 2} y={pill.y + 12.5} textAnchor="middle" fontSize={9} className="mono">
                  {text}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
      {spec.nodes.map((node) => {
        const box = boxes.get(node.id);
        if (!box) return null;
        const flow = flowInto.get(node.id);
        const nodePhase = node.kind === 'stack' && flow && playing && !reducedMotion() ? (flow === 'backward' ? 1 - phase : phase) : null;
        return (
          <g key={node.id} className={`m-node${target.highlight.has(node.id) ? ' m-hi' : ''}`} style={{ opacity: opacityOf(node.id) }}>
            <Node node={node} box={box} values={mix(previous.current.values.get(node.id), target.values.get(node.id), eased)} label={target.labels.get(node.id)} phase={nodePhase} />
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The card: the scene with its caption and controls
// ---------------------------------------------------------------------------

/** How a scene moves through its steps: by hand, by itself, or with the paragraph being read. */
export type SceneMode = 'hold' | 'play' | 'follow';
/** How long a step stays while the scene plays itself. */
export const PLAY_STEP_MS = 3600;
/** Where each scene was left — its mode and its step — so a card drawn again (a section re-keyed, Explain reopened) comes back as it was. */
const remembered = new Map<string, { mode: SceneMode; manual: number }>();
const memoryKey = (block: MotionBlock) => `${block.title}\n${block.src}`;

export function MotionView({
  block,
  followStep,
  compact,
  writer,
}: {
  block: MotionBlock;
  /** The step the reading has reached, when the card can follow it (the stage). */
  followStep?: number;
  compact?: boolean;
  /** Who wrote the scene — the model asked for it — for what the card says when it cannot be drawn. */
  writer?: string;
}) {
  const spec = block.spec;
  const steps = spec?.steps.length ?? 0;
  const canFollow = followStep !== undefined;
  // Held by default: the scene stays on the step the reader left it on, whatever the page does.
  const was = remembered.get(memoryKey(block));
  const [mode, setMode] = useState<SceneMode>(was?.mode === 'follow' && canFollow ? 'follow' : 'hold');
  const [manual, setManual] = useState(was?.manual ?? 0);
  const step = Math.max(0, Math.min(steps - 1, mode === 'follow' && canFollow ? followStep : manual));
  useEffect(() => {
    remembered.set(memoryKey(block), { mode: mode === 'play' ? 'hold' : mode, manual: mode === 'follow' ? step : manual });
  }, [block, mode, manual, step]);
  // Playing: a step every few seconds, to the last, where it holds.
  useEffect(() => {
    if (mode !== 'play' || steps < 2) return;
    const timer = window.setInterval(() => {
      setManual((current) => {
        if (current >= steps - 1) {
          setMode('hold');
          return current;
        }
        return current + 1;
      });
    }, PLAY_STEP_MS);
    return () => window.clearInterval(timer);
  }, [mode, steps]);
  const play = () => {
    if (mode === 'play') {
      setMode('hold');
      return;
    }
    // From the end, play again from the start; from a step the reading picked, from there.
    setManual(mode === 'follow' ? step : step >= steps - 1 ? 0 : step);
    setMode('play');
  };
  const pick = (next: number) => {
    setManual(next);
    setMode('hold');
  };
  // Holding keeps the step on screen, whichever way it got there.
  const hold = () => {
    setManual(step);
    setMode('hold');
  };
  const text = motionText(block.title, spec);
  return (
    <figure className={`explain-motion${compact ? ' is-compact' : ''}`} data-text={text}>
      <div className="motion-head">
        <span className="motion-kind">▶ Scene</span>
        <span className="motion-title" title={block.title || undefined}>
          {block.title || block.figure || 'The figure, in motion'}
        </span>
        {block.open ? (
          <span className="motion-state is-live">
            <i /> drawing…
          </span>
        ) : !spec ? (
          <span className="motion-state">not a scene the page can draw</span>
        ) : mode === 'play' ? (
          <span className="motion-state is-live">
            <i /> playing
          </span>
        ) : mode === 'follow' && canFollow ? (
          <span className="motion-state is-live">
            <i /> follows your reading
          </span>
        ) : (
          <span className="motion-state">{steps > 1 ? `held on ${step + 1} of ${steps}` : 'held'}</span>
        )}
        <KeepButton selector=".explain-motion" what="scene" />
      </div>
      {spec ? (
        <>
          <div className="motion-art">
            <MotionScene spec={spec} step={step} playing />
          </div>
          <div className="motion-caption">
            {steps > 1 ? <b>{`${step + 1} of ${steps}. `}</b> : null}
            {spec.steps[step]?.caption}
          </div>
          <div className="motion-steps">
            <button type="button" className="play" onClick={play} aria-pressed={mode === 'play'} aria-label={mode === 'play' ? 'Pause' : 'Play the scene through its steps'} title={mode === 'play' ? 'Pause' : steps > 1 ? 'Play: a step every few seconds, to the end' : 'Play'}>
              {mode === 'play' ? (
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1" y="1" width="3" height="8" />
                  <rect x="6" y="1" width="3" height="8" />
                </svg>
              ) : (
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 1 L9 5 L2 9 z" />
                </svg>
              )}
            </button>
            {steps > 1 ? (
              <>
                <div className="dots" role="group" aria-label="Steps">
                  {spec.steps.map((s, i) => (
                    <button key={i} type="button" className={i < step ? 'done' : undefined} aria-current={i === step ? 'step' : undefined} onClick={() => pick(i)} title={s.caption || `Step ${i + 1}`} aria-label={`Step ${i + 1}`} />
                  ))}
                </div>
                <input type="range" min={0} max={steps - 1} step={1} value={step} onChange={(event) => pick(Number(event.target.value))} aria-label="Step" />
              </>
            ) : null}
            {canFollow && steps > 1 ? (
              <div className="motion-modes" role="group" aria-label="How the scene moves">
                <button type="button" className="motion-mode" aria-pressed={mode !== 'follow'} onClick={hold} title="Hold: the scene stays on this step while you read">
                  Hold
                </button>
                <button type="button" className="motion-mode" aria-pressed={mode === 'follow'} onClick={() => setMode('follow')} title="Follow: the scene steps with the paragraph under the reading line">
                  Follow
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : block.open ? (
        <div className="motion-art drawing">Drawing the scene…</div>
      ) : (
        <div className="motion-art drawing">The block {writer ?? 'the model'} wrote is not a scene the page can draw. Ask for it again, or redraw it.</div>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// The stage: the section's scene, in view while the section is read
// ---------------------------------------------------------------------------

/**
 * Sticky beside the section's prose. It knows which step the paragraph
 * crossing a line a third of the way down the scroller — the one the
 * outline follows — belongs to, and the card steps with it when the reader
 * asks it to follow.
 */
export function Stage({ block, section, writer }: { block: MotionBlock; section: RefObject<HTMLElement>; writer?: string }) {
  const [followStep, setFollowStep] = useState(0);
  const spec = block.spec;
  useEffect(() => {
    const element = section.current;
    const scroller = element?.closest<HTMLElement>('.explain-scroll');
    if (!element || !scroller || !spec) return;
    const onScroll = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const paragraphs = element.querySelectorAll<HTMLElement>('.stage-main .explain-prose > p');
      let index = 0;
      paragraphs.forEach((p, i) => {
        if (p.getBoundingClientRect().top <= line + 10) index = i;
      });
      setFollowStep(stepForParagraph(spec, index, paragraphs.length));
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [section, spec]);
  return (
    <div className="explain-stage">
      <MotionView block={block} followStep={followStep} writer={writer} />
    </div>
  );
}
