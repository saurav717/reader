import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ===========================================================================
//  A scene, drawn and played — and the stage that keeps one in view.
//
//  The spec, its layout and its state at a step are src/lib/motion.ts; this
//  file turns them into SVG, tweens between steps, moves the packets along the
//  flows, and wraps the drawing in a card with its caption and controls. The
//  Stage is that card made sticky beside a section's prose, stepping with the
//  paragraph being read until the reader takes the steps in hand.
// ===========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeepButton } from './Keep';
import { anchors, charsAcross, edgeId, labelRoom, layoutMotion, mix, motionText, SCENE_H, SCENE_W, stateAt, stepForParagraph, wrapLabel } from '../lib/motion';
/** How long a step takes to settle after it changes. */
const TWEEN_MS = 800;
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const tone = (t) => `m-${t ?? 'accent'}`;
const numbers = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'number') : typeof v === 'number' ? [v] : []);
const rows = (v) => (Array.isArray(v) && Array.isArray(v[0]) ? v : Array.isArray(v) ? [v] : []);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------
/** The label above a stack, a distribution or a grid. It sits above the drawing, where the column
 *  gap gives it more room than the node's own width; a long one drops a point so it is not cut. */
function Above({ x, y, w, label, muted, mono, size = 10 }) {
    if (!label)
        return null;
    const pt = label.length > 13 ? size - 1 : size;
    const [line] = wrapLabel(label, charsAcross(w + 40, pt), 1);
    return _jsx(Label, { x: x, y: y, text: line, muted: muted, mono: mono, size: pt });
}
function Label({ x, y, text, anchor = 'middle', muted, mono, size = 10 }) {
    if (!text)
        return null;
    return (_jsx("text", { x: x, y: y, textAnchor: anchor, fontSize: size, className: `${muted ? 't-muted' : ''}${mono ? ' mono' : ''}`.trim() || undefined, children: text }));
}
/** One node at one moment: its box, its values after the tween, and the phase of any flow through it. */
function Node({ node, box, values, label, phase }) {
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
            return (_jsxs("g", { className: cls, children: [_jsx("title", { children: label }), _jsx("circle", { cx: x + w / 2, cy: y + 11, r: 11, className: "m-fill" }), inside ? _jsx(Label, { x: x + w / 2, y: y + 14.5, text: label, mono: true }) : _jsx(Label, { x: x + w / 2, y: y + 32, text: wrapLabel(label, 14, 1)[0], muted: true, size: 9 })] }));
        }
        case 'text': {
            const [line] = wrapLabel(label, 28, 1);
            return (_jsxs("g", { className: cls, children: [_jsx("title", { children: label }), _jsx(Label, { x: x + w / 2, y: y + h - 4, text: line, muted: node.tone === 'muted' })] }));
        }
        case 'stack': {
            const n = node.layers ?? 3;
            const lit = phase === null ? -1 : Math.floor(clamp01(phase) * n);
            const gap = n > 6 ? 2 : 4;
            const layer = Math.max(3, Math.min(12, (h - (n - 1) * gap) / n));
            return (_jsxs("g", { className: `${cls}${node.frozen ? ' m-frozen' : ''}`, children: [Array.from({ length: n }, (_, i) => {
                        const ly = y + (n - 1 - i) * (layer + gap);
                        return _jsx("rect", { x: x, y: ly, width: w, height: layer, rx: 3, className: i === lit ? 'm-fill' : 'm-soft' }, i);
                    }), _jsx(Above, { x: x + w / 2, y: top, w: w, label: label, muted: node.frozen })] }));
        }
        case 'dist': {
            const vs = numbers(values);
            const max = Math.max(...vs, 1e-9);
            const n = Math.max(vs.length, 1);
            const bw = w / n;
            const barsH = h - 16;
            return (_jsxs("g", { className: cls, children: [vs.map((v, i) => {
                        const bh = Math.max(0.6, (v / max) * barsH);
                        return _jsx("rect", { x: x + i * bw + 3, y: y + barsH - bh, width: Math.max(2, bw - 6), height: bh, rx: 2, className: "m-fill" }, i);
                    }), node.labels?.slice(0, n).map((name, i) => (_jsx(Label, { x: x + i * bw + bw / 2, y: y + h - 3, text: name, muted: true, size: 8.5 }, i))), _jsx(Above, { x: x + w / 2, y: top, w: w, label: label, muted: true, mono: true, size: 8.5 })] }));
        }
        case 'curve': {
            const series = rows(values);
            const all = series.flat();
            const lo = Math.min(...all, 0), hi = Math.max(...all, 1e-9);
            const plotH = h - 4;
            const point = (v, i, len) => `${(x + (i / Math.max(len - 1, 1)) * w).toFixed(1)} ${(y + plotH - ((v - lo) / (hi - lo || 1)) * plotH).toFixed(1)}`;
            return (_jsxs("g", { className: cls, children: [_jsx("line", { x1: x, y1: y + plotH, x2: x + w, y2: y + plotH, className: "m-axis" }), _jsx("line", { x1: x, y1: y, x2: x, y2: y + plotH, className: "m-axis" }), series.map((s, k) => (_jsx("polyline", { points: s.map((v, i) => point(v, i, s.length)).join(' '), className: k === 0 ? 'm-stroke' : 'm-stroke m-second' }, k))), node.labels?.slice(0, series.length).map((name, k) => (_jsx(Label, { x: x + w, y: y + 9 + k * 11, text: name, anchor: "end", muted: true, size: 8.5 }, k))), _jsx(Label, { x: x + w / 2, y: top, text: wrapLabel(label, 24, 1)[0], muted: true, size: 8.5 })] }));
        }
        case 'grid': {
            const cells = rows(values);
            const r = Math.max(cells.length, 1);
            const c = Math.max(...cells.map((row) => row.length), 1);
            const cw = w / c, ch = h / r;
            return (_jsxs("g", { className: cls, children: [cells.map((row, i) => row.map((v, j) => _jsx("rect", { x: x + j * cw, y: y + i * ch, width: cw - 1, height: ch - 1, className: "m-fill", opacity: 0.12 + 0.88 * clamp01(v) }, `${i}-${j}`))), _jsx(Above, { x: x + w / 2, y: top, w: w, label: label, muted: true, size: 8.5 })] }));
        }
        case 'slider': {
            const lo = node.min ?? 0, hi = node.max ?? 1;
            const v = numbers(values)[0] ?? lo;
            const k = clamp01((v - lo) / (hi - lo || 1));
            const ty = y + 10;
            return (_jsxs("g", { className: cls, children: [_jsx("rect", { x: x, y: ty - 2, width: w, height: 4, rx: 2, className: "m-track" }), _jsx("circle", { cx: x + k * w, cy: ty, r: 6, className: "m-fill" }), _jsx(Label, { x: x, y: ty + 16, text: String(lo), anchor: "start", muted: true, mono: true, size: 8 }), _jsx(Label, { x: x + w, y: ty + 16, text: String(hi), anchor: "end", muted: true, mono: true, size: 8 }), _jsx(Label, { x: x + w / 2, y: ty + 16, text: `${label ?? ''} = ${Number.isInteger(v) ? v : v.toFixed(1)}`, mono: true, size: 9 })] }));
        }
        case 'timeline': {
            const events = node.events ?? [];
            const ats = events.map((e) => (typeof e.at === 'number' ? e.at : Number.parseFloat(String(e.at)) || 0));
            const lo = Math.min(...ats, 0), hi = Math.max(...ats, 1);
            const ly = y + h / 2;
            return (_jsxs("g", { className: cls, children: [_jsx("line", { x1: x, y1: ly, x2: x + w, y2: ly, className: "m-axis" }), events.map((e, i) => {
                        const ex = ats.length > 1 && hi !== lo ? x + ((ats[i] - lo) / (hi - lo)) * w : x + ((i + 0.5) / Math.max(events.length, 1)) * w;
                        return (_jsxs("g", { children: [_jsx("circle", { cx: ex, cy: ly, r: 4.5, className: "m-fill" }), _jsx(Label, { x: ex, y: i % 2 ? ly + 18 : ly - 10, text: e.label, size: 8.5 }), _jsx(Label, { x: ex, y: i % 2 ? ly + 28 : ly - 20, text: String(e.at), muted: true, mono: true, size: 7.5 })] }, i));
                    }), _jsx(Label, { x: x + w / 2, y: top, text: wrapLabel(label, 40, 1)[0], muted: true, size: 8.5 })] }));
        }
        default: {
            // The label at the box's own width: a narrow cell gets smaller type and a tighter wrap.
            const size = w < 70 ? 9 : 10;
            const lines = wrapLabel(label, charsAcross(w, size), h >= 34 ? 2 : 1);
            return (_jsxs("g", { className: cls, children: [_jsx("title", { children: label }), _jsx("rect", { x: x, y: y, width: w, height: h, rx: 5, className: "m-soft" }), lines.map((line, i) => (_jsx(Label, { x: x + w / 2, y: y + h / 2 + 3.5 + (i - (lines.length - 1) / 2) * (size + 2), text: line, size: size }, i)))] }));
        }
    }
}
/**
 * An edge's way from one node to the next: an elbow through the gap between
 * stages (out sideways, down or up the gap, in sideways), or down a column.
 * With the corners rounded, a label spot on its middle run, the point at any
 * fraction of its length for the packets, and where and how it arrives.
 */
function route(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const sideways = Math.abs(dx) >= Math.abs(dy);
    const pts = sideways && Math.abs(dy) >= 4
        ? [{ x: x1, y: y1 }, { x: (x1 + x2) / 2, y: y1 }, { x: (x1 + x2) / 2, y: y2 }, { x: x2, y: y2 }]
        : !sideways && Math.abs(dx) >= 4
            ? [{ x: x1, y: y1 }, { x: x1, y: (y1 + y2) / 2 }, { x: x2, y: (y1 + y2) / 2 }, { x: x2, y: y2 }]
            : [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = lengths.reduce((sum, l) => sum + l, 0) || 1;
    const at = (q) => {
        let left = Math.max(0, Math.min(1, q)) * total;
        for (let i = 0; i < lengths.length; i++) {
            if (left <= lengths[i] || i === lengths.length - 1) {
                const f = lengths[i] ? Math.min(1, left / lengths[i]) : 1;
                return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
            }
            left -= lengths[i];
        }
        return pts[pts.length - 1];
    };
    // Rounded corners: each inner point becomes a short curve.
    const r = 7;
    const toward = (from, to, dist) => {
        const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const k = Math.min(dist, len / 2) / len;
        return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    };
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
        const before = toward(pts[i], pts[i - 1], r), after = toward(pts[i], pts[i + 1], r);
        d += ` L${before.x.toFixed(1)} ${before.y.toFixed(1)} Q${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${after.x.toFixed(1)} ${after.y.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
    const mid = pts.length === 4 ? { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 } : at(0.5);
    const label = pts.length === 4 && !sideways ? { x: mid.x, y: mid.y - 3 } : pts.length === 4 ? { x: mid.x, y: mid.y + 3 } : { x: mid.x, y: mid.y - 4 };
    const prev = pts[pts.length - 2];
    return { d, at, label, end: { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) } };
}
/** A small triangle at the end of an edge, pointing the way it goes. */
function arrowhead(end) {
    const size = 5.5;
    const bx = end.x - Math.cos(end.angle) * size, by = end.y - Math.sin(end.angle) * size;
    const px = -Math.sin(end.angle) * (size * 0.6), py = Math.cos(end.angle) * (size * 0.6);
    return `M${end.x.toFixed(1)} ${end.y.toFixed(1)} L${(bx + px).toFixed(1)} ${(by + py).toFixed(1)} L${(bx - px).toFixed(1)} ${(by - py).toFixed(1)} Z`;
}
/** The scene at a step, tweened from the step before, with the flows moving while `playing`. */
export function MotionScene({ spec, step, playing }) {
    const boxes = useMemo(() => layoutMotion(spec), [spec]);
    const target = useMemo(() => stateAt(spec, step), [spec, step]);
    const previous = useRef(target);
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
    const flowInto = new Map();
    for (const edge of spec.edges)
        if (edge.flow && target.visible.has(edgeId(edge)))
            flowInto.set(edge.flow === 'forward' ? edge.to : edge.to, edge.flow);
    // A step that points at something lets the rest step back, so the caption and the drawing agree on what to look at.
    const focused = target.highlight.size > 0;
    const opacityOf = (id) => (!target.visible.has(id) ? 0 : target.dim.has(id) ? 0.3 : focused && !target.highlight.has(id) ? 0.62 : 1);
    return (_jsxs("svg", { viewBox: `0 0 ${SCENE_W} ${SCENE_H}`, role: "img", "aria-label": spec.steps[step]?.caption || 'Scene', children: [spec.edges.map((edge) => {
                const id = edgeId(edge);
                const a = boxes.get(edge.from), b = boxes.get(edge.to);
                if (!a || !b)
                    return null;
                const { x1, y1, x2, y2 } = anchors(a, b);
                const compare = edge.kind === 'compare';
                const path = route(x1, y1, x2, y2);
                const text = edge.label ? (edge.label.length > 14 ? edge.label.slice(0, 13) + '…' : edge.label) : '';
                const highlighted = target.highlight.has(id);
                const quiet = focused && !highlighted;
                return (_jsxs("g", { className: `m-edge ${tone(edge.tone ?? (compare ? 'pink' : 'muted'))}${highlighted ? ' m-hi' : ''}`, style: { opacity: !target.visible.has(id) ? 0 : target.dim.has(id) ? 0.3 : quiet ? 0.55 : 1 }, children: [_jsx("path", { d: path.d, className: compare ? 'm-stroke m-dashed' : 'm-stroke' }), !compare ? _jsx("path", { d: arrowhead(path.end), className: "m-arrow" }) : null, edge.flow && playing && !reducedMotion()
                            ? [0, 1, 2].map((k) => {
                                const q = (phase + k / 3) % 1;
                                const { x, y } = path.at(edge.flow === 'backward' ? 1 - q : q);
                                return _jsx("circle", { cx: x, cy: y, r: 3, className: "m-packet" }, k);
                            })
                            : null, text ? (_jsxs("text", { x: path.label.x, y: path.label.y, textAnchor: "middle", fontSize: 8.5, className: "m-edge-label mono", children: [_jsx("title", { children: edge.label }), text] })) : null] }, id));
            }), spec.nodes.map((node) => {
                const box = boxes.get(node.id);
                if (!box)
                    return null;
                const flow = flowInto.get(node.id);
                const nodePhase = node.kind === 'stack' && flow && playing && !reducedMotion() ? (flow === 'backward' ? 1 - phase : phase) : null;
                return (_jsx("g", { className: `m-node${target.highlight.has(node.id) ? ' m-hi' : ''}`, style: { opacity: opacityOf(node.id) }, children: _jsx(Node, { node: node, box: box, values: mix(previous.current.values.get(node.id), target.values.get(node.id), eased), label: target.labels.get(node.id), phase: nodePhase }) }, node.id));
            })] }));
}
/** How long a step stays while the scene plays itself. */
export const PLAY_STEP_MS = 3600;
/** Where each scene was left — its mode and its step — so a card drawn again (a section re-keyed, Explain reopened) comes back as it was. */
const remembered = new Map();
const memoryKey = (block) => `${block.title}\n${block.src}`;
export function MotionView({ block, followStep, compact, writer, onMode, }) {
    const spec = block.spec;
    const steps = spec?.steps.length ?? 0;
    const canFollow = followStep !== undefined;
    // Held by default: the scene stays on the step the reader left it on, whatever the page does.
    const was = remembered.get(memoryKey(block));
    const [mode, setMode] = useState(was?.mode === 'follow' && canFollow ? 'follow' : 'hold');
    const [manual, setManual] = useState(was?.manual ?? 0);
    const step = Math.max(0, Math.min(steps - 1, mode === 'follow' && canFollow ? followStep : manual));
    useEffect(() => {
        remembered.set(memoryKey(block), { mode: mode === 'play' ? 'hold' : mode, manual: mode === 'follow' ? step : manual });
    }, [block, mode, manual, step]);
    // Playing: a step every few seconds, to the last, where it holds.
    useEffect(() => {
        if (mode !== 'play' || steps < 2)
            return;
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
    const pick = (next) => {
        setManual(next);
        setMode('hold');
    };
    // Holding keeps the step on screen, whichever way it got there.
    const hold = () => {
        setManual(step);
        setMode('hold');
    };
    useEffect(() => {
        onMode?.(mode);
    }, [mode, onMode]);
    const text = motionText(block.title, spec);
    return (_jsxs("figure", { className: `explain-motion${compact ? ' is-compact' : ''}`, "data-text": text, children: [_jsxs("div", { className: "motion-head", children: [_jsx("span", { className: "motion-kind", children: "\u25B6 Scene" }), _jsx("span", { className: "motion-title", title: block.title || undefined, children: block.title || block.figure || 'The figure, in motion' }), block.open ? (_jsxs("span", { className: "motion-state is-live", children: [_jsx("i", {}), " drawing\u2026"] })) : !spec ? (_jsx("span", { className: "motion-state", children: "not a scene the page can draw" })) : mode === 'play' ? (_jsxs("span", { className: "motion-state is-live", children: [_jsx("i", {}), " playing"] })) : mode === 'follow' && canFollow ? (_jsxs("span", { className: "motion-state is-live", children: [_jsx("i", {}), " follows your reading"] })) : (_jsx("span", { className: "motion-state", children: steps > 1 ? `held on ${step + 1} of ${steps}` : 'held' })), _jsx(KeepButton, { selector: ".explain-motion", what: "scene" })] }), spec ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "motion-art", role: "button", tabIndex: 0, "aria-label": "See the scene close up, on this step", title: "Click for a close-up", children: _jsx(MotionScene, { spec: spec, step: step, playing: true }) }), _jsxs("div", { className: "motion-caption", children: [steps > 1 ? _jsx("b", { children: `${step + 1} of ${steps}. ` }) : null, spec.steps[step]?.caption] }), _jsxs("div", { className: "motion-steps", children: [_jsx("button", { type: "button", className: "play", onClick: play, "aria-pressed": mode === 'play', "aria-label": mode === 'play' ? 'Pause' : 'Play the scene through its steps', title: mode === 'play' ? 'Pause' : steps > 1 ? 'Play: a step every few seconds, to the end' : 'Play', children: mode === 'play' ? (_jsxs("svg", { viewBox: "0 0 10 10", "aria-hidden": "true", children: [_jsx("rect", { x: "1", y: "1", width: "3", height: "8" }), _jsx("rect", { x: "6", y: "1", width: "3", height: "8" })] })) : (_jsx("svg", { viewBox: "0 0 10 10", "aria-hidden": "true", children: _jsx("path", { d: "M2 1 L9 5 L2 9 z" }) })) }), steps > 1 ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "dots", role: "group", "aria-label": "Steps", children: spec.steps.map((s, i) => (_jsx("button", { type: "button", className: i < step ? 'done' : undefined, "aria-current": i === step ? 'step' : undefined, onClick: () => pick(i), title: s.caption || `Step ${i + 1}`, "aria-label": `Step ${i + 1}` }, i))) }), _jsx("input", { type: "range", min: 0, max: steps - 1, step: 1, value: step, onChange: (event) => pick(Number(event.target.value)), "aria-label": "Step" })] })) : null, canFollow && steps > 1 ? (_jsxs("div", { className: "motion-modes", role: "group", "aria-label": "How the scene moves", children: [_jsx("button", { type: "button", className: "motion-mode", "aria-pressed": mode !== 'follow', onClick: hold, title: "Hold: the card stays where it is in the margin, on this step, while you read on", children: "Hold" }), _jsx("button", { type: "button", className: "motion-mode", "aria-pressed": mode === 'follow', onClick: () => setMode('follow'), title: "Follow: the card keeps to the top of the margin as you read, and steps with the paragraph under the reading line", children: "Follow" })] })) : null] })] })) : block.open ? (_jsx("div", { className: "motion-art drawing", children: "Drawing the scene\u2026" })) : (_jsxs("div", { className: "motion-art drawing", children: ["The block ", writer ?? 'the model', " wrote is not a scene the page can draw. Ask for it again, or redraw it."] }))] }));
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
export function Stage({ block, section, writer }) {
    const [followStep, setFollowStep] = useState(0);
    // Pinned to the top of the margin only while following; held, it sits where a figure would.
    const [following, setFollowing] = useState(false);
    const onMode = useCallback((mode) => setFollowing(mode === 'follow'), []);
    const spec = block.spec;
    useEffect(() => {
        const element = section.current;
        const scroller = element?.closest('.explain-scroll');
        if (!element || !scroller || !spec)
            return;
        const onScroll = () => {
            const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
            const paragraphs = element.querySelectorAll('.stage-main .explain-prose > p');
            let index = 0;
            paragraphs.forEach((p, i) => {
                if (p.getBoundingClientRect().top <= line + 10)
                    index = i;
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
    return (_jsx("div", { className: `explain-stage${following ? ' is-following' : ''}`, children: _jsx(MotionView, { block: block, followStep: followStep, writer: writer, onMode: onMode }) }));
}
