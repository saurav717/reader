import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// The Runtime pane, beside the notebook: what the runtime's machine is and
// how busy it is, in real time — read every two seconds whether a cell runs
// or not — in one of three looks the reader picks and the pane remembers:
//
//   Meters   five bars for GPU, VRAM, CPU, RAM and disk, and the last ten
//            minutes as two line charts with a ruler of which cell ran when;
//   Tiles    the value large with its last minute under it, and the ten
//            minutes as heat strips, one a resource, in step with the ruler;
//   Rings    dials for the rates, memory as a budget against the plan's
//            need, and the hungriest cells of the window.
//
// Under all three: what is left of the session and of the compute units,
// the watch and the pulse, and the runtime's actions. Everything shown comes
// from the Colab store (src/lib/colab.ts) — the probe's samples, kept as a
// history — and the sums are src/lib/runtime.ts.
import { useEffect, useMemo, useState } from 'react';
import { connect, HISTORY_MS, machineLabel, pauseRuns, probeMachine, PULSE_MS, restartKernel, resumeRuns, setGpuWatch, setMachine, setPulse, stopRuns, stopRuntime } from '../lib/colab';
import { bins, nearFull, needMarkers, peakOf, peaksByCell, recent, rulerSegments, sessionLeft, spanText, timeline, unitsLeft } from '../lib/runtime';
import { gigabytes } from '../lib/telemetry';
import { LineChart } from './Charts';
import { attachUrl, MachinePicker, useColab } from './Colab';
const STYLE_KEY = 'reader.colab.pane-style';
export const STYLES = [
    { id: 'meters', label: 'Meters', note: 'Bars for each resource, and the last ten minutes as line charts' },
    { id: 'tiles', label: 'Tiles', note: 'The value large with its last minute, and the ten minutes as heat strips in step with the runs' },
    { id: 'rings', label: 'Rings', note: 'Dials for the rates, memory as a budget against the plan, and the hungriest cells' },
];
const readStyle = () => {
    try {
        const kept = localStorage.getItem(STYLE_KEY);
        return kept === 'meters' || kept === 'rings' ? kept : 'tiles';
    }
    catch {
        return 'tiles';
    }
};
const BIN_MS = 10_000;
const MINUTE = 60_000;
const clock = (since, now) => {
    if (!since)
        return '—';
    const s = Math.max(0, Math.round((now - since) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
/** The fill's colour by how full: the accent, then warning past three quarters, then danger past nine tenths. */
const severity = (share) => (share >= 0.9 ? 'is-bad' : share >= 0.75 ? 'is-warn' : '');
// The quantities, each with a fixed colour wherever it is drawn: the GPU and its memory in the first series colour, the CPU and the system's in the second.
const GPU_HUE = 'var(--viz-1)';
const CPU_HUE = 'var(--viz-2)';
const gpuUtil = (s) => s.gpu?.util;
const vramGb = (s) => (s.gpu ? s.gpu.memUsedMb / 1024 : undefined);
const cpuUtil = (s) => s.cpu;
const ramGb = (s) => (s.ramUsedMb === undefined ? undefined : s.ramUsedMb / 1024);
// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function Meter({ label, value, used, total, unit, need, note, hue }) {
    const share = used !== undefined && total ? Math.min(1, used / total) : 0;
    const tick = need !== undefined && total ? Math.min(1, need / total) : undefined;
    return (_jsxs("div", { className: `rt-meter ${severity(share)}${used === undefined ? ' is-empty' : ''}`, children: [_jsx("span", { className: "rt-meter-label", children: label }), _jsxs("span", { className: "rt-meter-bar", "aria-hidden": "true", children: [_jsx("span", { className: "rt-meter-fill", style: { width: `${Math.round(share * 100)}%`, ...(hue && !severity(share) ? { background: hue } : {}) } }), tick !== undefined ? _jsx("span", { className: "rt-meter-tick", style: { left: `${Math.round(tick * 100)}%` }, title: `The plan needs ${need} ${unit ?? ''}` }) : null] }), _jsx("span", { className: "rt-meter-value", children: value }), note ? _jsx("span", { className: "rt-meter-note", children: note }) : null] }));
}
/** The last minute of one value, as a small line; the y range is fixed so the tiles read against each other. */
function Sparkline({ points, max, hue }) {
    if (points.length < 2)
        return _jsx("svg", { className: "rt-spark", viewBox: "0 0 120 22", "aria-hidden": "true" });
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${(120 + (p.x / 60) * 120).toFixed(1)} ${(20 - (Math.min(max, p.y) / max) * 18).toFixed(1)}`).join(' ');
    return (_jsx("svg", { className: "rt-spark", viewBox: "0 0 120 22", "aria-hidden": "true", children: _jsx("path", { d: path, style: { stroke: hue } }) }));
}
function Tile({ label, value, unit, note, points, max, hue }) {
    return (_jsxs("div", { className: "rt-tile", children: [_jsx("span", { className: "rt-tile-k", children: label }), _jsxs("span", { className: "rt-tile-n", children: [value, unit ? _jsx("small", { children: unit }) : null] }), note ? _jsx("span", { className: "rt-tile-note", children: note }) : null, _jsx(Sparkline, { points: points, max: max, hue: hue })] }));
}
/** One resource over the window as a strip of bins, one hue light to dark by value, with its peak at the end. */
function Strip({ label, values, max, hue, unit, format }) {
    const peak = peakOf(values);
    return (_jsxs(_Fragment, { children: [_jsx("b", { children: label }), _jsx("span", { className: "rt-strip", role: "img", "aria-label": `${label} over the last ten minutes${peak !== undefined ? `, peak ${format ? format(peak) : peak}${unit}` : ''}`, children: values.map((value, index) => (_jsx("i", { style: value === undefined ? undefined : { background: `color-mix(in srgb, ${hue} ${Math.round(12 + 88 * Math.min(1, value / max))}%, var(--surface))` } }, index))) }), _jsx("span", { className: "rt-strip-peak", children: peak !== undefined ? `peak ${format ? format(peak) : peak}${unit}` : '—' })] }));
}
/** Which cell ran when, along the window — the same width as the strips and the charts above it. */
function Ruler({ segments, labelOf, idOf, onGoTo, wide }) {
    const left = wide ? 0 : 40;
    const width = wide ? 420 : 326;
    return (_jsxs("svg", { className: "rt-ruler", viewBox: "0 0 420 14", preserveAspectRatio: "none", role: "img", "aria-label": segments.length ? `Cells that ran: ${segments.map((s) => labelOf(s.key)).join(', ')}` : 'No cell has run in the last ten minutes', children: [_jsx("rect", { className: "rt-ruler-track", x: left, y: 4, width: width, height: 6, rx: 3 }), segments.map((segment) => {
                const x = left + ((segment.start + 10) / 10) * width;
                const w = Math.max(2, ((segment.end - segment.start) / 10) * width);
                const id = idOf(segment.key);
                return (_jsx("rect", { className: `rt-ruler-run is-${segment.state}${id ? ' is-link' : ''}`, x: x, y: 2, width: w, height: 10, rx: 2, onClick: () => id && onGoTo?.(id), children: _jsxs("title", { children: [labelOf(segment.key), " \u00B7 ", segment.live ? 'running' : segment.state] }) }, segment.key));
            })] }));
}
function Ring({ label, value, share, hue }) {
    const r = 30;
    const c = 2 * Math.PI * r;
    const cls = share === undefined ? '' : severity(share);
    return (_jsxs("div", { className: `rt-ring ${cls}`, children: [_jsxs("svg", { viewBox: "0 0 76 76", role: "img", "aria-label": `${label} ${value}`, children: [_jsx("circle", { className: "rt-ring-track", cx: 38, cy: 38, r: r }), share !== undefined ? _jsx("circle", { className: "rt-ring-fill", cx: 38, cy: 38, r: r, style: cls ? undefined : { stroke: hue }, strokeDasharray: `${c * Math.min(1, share)} ${c}`, transform: "rotate(-90 38 38)" }) : null, _jsx("text", { x: 38, y: 43, textAnchor: "middle", children: value })] }), _jsx("span", { className: "rt-ring-k", children: label })] }));
}
/** Memory as a budget: used and free of the total, with the plan's need marked, and said when it is over. */
function Budget({ label, used, total, need, hue }) {
    const share = used !== undefined && total ? Math.min(1, used / total) : 0;
    const over = need !== undefined && total !== undefined && need > total;
    const tick = need !== undefined && total ? Math.min(1, need / total) : undefined;
    return (_jsxs("div", { className: `rt-budget ${severity(share)}`, children: [_jsxs("span", { className: "rt-budget-row", children: [_jsx("b", { children: label }), _jsx("span", { children: used !== undefined && total !== undefined ? `${used.toFixed(1)} used · ${(total - used).toFixed(1)} free of ${total.toFixed(0)} GB` : '—' })] }), _jsxs("span", { className: "rt-budget-bar", "aria-hidden": "true", children: [_jsx("span", { className: "rt-budget-used", style: { width: `${Math.round(share * 100)}%`, ...(severity(share) ? {} : { background: hue }) } }), tick !== undefined ? _jsx("span", { className: `rt-budget-need${over ? ' is-over' : ''}`, style: { left: `${Math.round(tick * 100)}%` } }) : null] }), need !== undefined ? _jsx("span", { className: `rt-budget-note${over ? ' is-over' : ''}`, children: over ? `The plan needs ${need} GB — more than this machine has` : `The plan needs ${need} GB${total ? ` · headroom ${Math.max(0, total - (used ?? 0)).toFixed(1)} GB` : ''}` }) : null] }));
}
// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------
export default function RuntimePane({ cells, compute, onGoTo, onRunAll, picked }) {
    const colab = useColab();
    const [now, setNow] = useState(Date.now());
    const [style, setStyleState] = useState(readStyle);
    const [changing, setChanging] = useState(false);
    const [confirmStop, setConfirmStop] = useState(false);
    useEffect(() => {
        const tick = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(tick);
    }, []);
    const setStyle = (next) => {
        setStyleState(next);
        try {
            localStorage.setItem(STYLE_KEY, next);
        }
        catch {
            // private mode
        }
    };
    const connected = colab.status === 'idle' || colab.status === 'busy';
    const runtime = colab.runtime;
    const sample = colab.sample;
    const specs = colab.specs;
    /** A Jupyter server of the person's own: no Colab session, units or machine to change. */
    const ownServer = colab.backend.kind === 'jupyter';
    const gpuMachine = Boolean(runtime?.accelerator) || (ownServer && Boolean(colab.specs?.gpuName));
    const needs = useMemo(() => needMarkers(compute), [compute]);
    const history = colab.history;
    const { use, memory } = useMemo(() => timeline(history, now, HISTORY_MS), [history, now]);
    const segments = useMemo(() => rulerSegments(colab.runs, now, HISTORY_MS), [colab.runs, now]);
    const peaks = useMemo(() => peaksByCell(colab.runs, now, HISTORY_MS), [colab.runs, now]);
    const strips = useMemo(() => ({
        gpu: bins(history, now, HISTORY_MS, BIN_MS, gpuUtil),
        cpu: bins(history, now, HISTORY_MS, BIN_MS, cpuUtil),
        vram: bins(history, now, HISTORY_MS, BIN_MS, vramGb),
        ram: bins(history, now, HISTORY_MS, BIN_MS, ramGb),
    }), [history, now]);
    const sparks = useMemo(() => ({ gpu: recent(history, now, MINUTE, gpuUtil), cpu: recent(history, now, MINUTE, cpuUtil), vram: recent(history, now, MINUTE, vramGb), ram: recent(history, now, MINUTE, ramGb) }), [history, now]);
    const session = sessionLeft(runtime?.accelerator, colab.startedAt, now);
    const unitHours = unitsLeft(colab.units);
    const lastRun = Math.max(0, ...Object.values(colab.runs).map((run) => run.startedAt + (run.ms ?? 0)));
    const idleFor = connected && !colab.running && lastRun ? now - lastRun : 0;
    const labelOf = (key) => cells.find((cell) => cell.key === key)?.label ?? (key.startsWith('nb:') ? 'a cell' : 'a page cell');
    const idOf = (key) => cells.find((cell) => cell.key === key)?.id;
    const vramNow = sample?.gpu ? sample.gpu.memUsedMb / 1024 : undefined;
    const vramTotal = specs?.vramMb ? specs.vramMb / 1024 : sample?.gpu ? sample.gpu.memTotalMb / 1024 : undefined;
    const ramNow = sample?.ramUsedMb !== undefined ? sample.ramUsedMb / 1024 : undefined;
    const ramTotal = specs?.ramTotalMb ? specs.ramTotalMb / 1024 : undefined;
    const diskUsed = sample?.diskFreeGb !== undefined && sample.diskTotalGb !== undefined ? sample.diskTotalGb - sample.diskFreeGb : undefined;
    const readAgo = history.length ? now - history[history.length - 1].at : undefined;
    const live = colab.gpuWatch && (colab.running ? true : colab.pulse === 'live');
    const headroom = (need, used, total) => total === undefined ? undefined : need !== undefined && need > total ? `the plan needs ${need} GB — over` : `headroom ${Math.max(0, total - (used ?? 0)).toFixed(1)} GB${need !== undefined ? ` · the plan needs ${need}` : ''}`;
    if (!connected || !runtime) {
        return (_jsx("div", { className: "rt-pane", children: _jsx("p", { className: "rt-empty", children: colab.status === 'connecting' ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "spinner" }), " Connecting\u2026"] })) : colab.status === 'lost' ? ('The runtime has ended. Start another from the chip in the bar, or run a cell.') : ('No runtime yet. Run a cell, or start one from the chip in the bar, and the machine shows here: what it is, how busy it is, and how much of the session is left.') }) }));
    }
    const nowLabel = (_jsxs("div", { className: "rt-part-label", children: ["Now", _jsxs("small", { children: [' · ', live ? (_jsxs("span", { className: "rt-live", children: [_jsx("span", { className: "rt-live-dot", "aria-hidden": "true" }), " live, every ", PULSE_MS.live / 1000, " s"] })) : readAgo !== undefined ? (`read ${spanText(readAgo)} ago`) : ('not read yet')] })] }));
    const tenLabel = (_jsxs("div", { className: "rt-part-label", children: ["The last ten minutes", segments.length ? _jsxs("small", { children: [" \u00B7 ", segments.length, " ", segments.length === 1 ? 'run' : 'runs'] }) : null] }));
    const ruler = _jsx(Ruler, { segments: segments, labelOf: labelOf, idOf: idOf, onGoTo: onGoTo, wide: style === 'tiles' });
    return (_jsxs("div", { className: `rt-pane is-${style}`, children: [_jsxs("div", { className: "rt-head", children: [_jsx("b", { children: specs?.gpuName ?? (ownServer ? (colab.backend.kind === 'jupyter' ? colab.backend.server.name : '') : gpuMachine ? `${machineLabel(runtime)} — reading the machine…` : 'CPU runtime') }), _jsx("span", { children: [specs?.vramMb ? gigabytes(specs.vramMb) : '', specs?.cpus ? `${specs.cpus} CPUs` : '', specs?.ramTotalMb ? `${gigabytes(specs.ramTotalMb)} RAM` : '', specs?.diskTotalGb !== undefined ? `${specs.diskTotalGb} GB disk` : ''].filter(Boolean).join(' · ') || machineLabel(runtime) }), _jsxs("span", { className: "rt-state", children: [_jsx("span", { className: `colab-dot is-${colab.status === 'busy' ? 'busy' : 'on'}`, "aria-hidden": "true" }), colab.status === 'busy' ? `running ${labelOf(colab.running ?? '')}` : 'idle', " \u00B7 up ", clock(colab.startedAt, now)] })] }), _jsx("div", { className: "rt-run", role: "group", "aria-label": "Runs", children: colab.status === 'busy' || colab.queue.length ? (_jsxs(_Fragment, { children: [_jsxs("span", { className: "rt-run-state", children: [_jsx("span", { className: `colab-dot is-${colab.running ? 'busy' : 'on'}`, "aria-hidden": "true" }), colab.running ? `running ${labelOf(colab.running)}` : colab.paused ? 'paused' : 'starting', colab.queue.length ? ` · ${colab.queue.length} queued` : '', colab.paused ? (colab.running ? ' · pauses after this cell' : '') : ''] }), colab.paused ? (_jsx("button", { type: "button", className: "btn sm primary", onClick: resumeRuns, title: "Goes on with the cells that wait", children: "\u25B6 Resume" })) : (_jsx("button", { type: "button", className: "btn sm", disabled: !colab.queue.length, onClick: pauseRuns, title: colab.queue.length ? 'The cell running finishes; the rest wait for Resume' : 'One cell runs on its own: a running cell cannot be paused, only stopped', children: "\u23F8 Pause" })), _jsx("button", { type: "button", className: "btn sm colab-stop", onClick: () => void stopRuns(), title: "Interrupts the cell running and drops the rest", children: "\u25A0 Stop" })] })) : (_jsxs(_Fragment, { children: [picked ? (_jsxs("button", { type: "button", className: "btn sm colab", onClick: picked.run, title: "Runs the cell picked in the notebook", children: ["\u25B6 Run ", picked.label] })) : null, _jsx("button", { type: "button", className: "btn sm colab", disabled: !onRunAll || !cells.length, onClick: () => onRunAll?.(), title: "Every code cell in order, at once; stops at the first error", children: "\u25B6 Run all" }), _jsx("button", { type: "button", className: "btn sm", disabled: true, title: "Nothing is running", children: "\u23F8 Pause" }), _jsx("button", { type: "button", className: "btn sm", disabled: true, title: "Nothing is running", children: "\u25A0 Stop" })] })) }), _jsx("div", { className: "segmented rt-styles", role: "radiogroup", "aria-label": "How the machine is shown", children: STYLES.map((option) => (_jsx("button", { type: "button", role: "radio", "aria-checked": style === option.id, "aria-pressed": style === option.id, title: option.note, onClick: () => setStyle(option.id), children: option.label }, option.id))) }), style === 'meters' ? (_jsxs(_Fragment, { children: [nowLabel, _jsxs("div", { className: "rt-meters", children: [gpuMachine ? _jsx(Meter, { label: "GPU", value: sample?.gpu ? `${sample.gpu.util}%` : '—', used: sample?.gpu?.util, total: 100, hue: GPU_HUE }) : null, gpuMachine ? (_jsx(Meter, { label: "VRAM", value: vramNow !== undefined ? `${vramNow.toFixed(1)} / ${vramTotal?.toFixed(0) ?? '?'} GB` : '—', used: vramNow, total: vramTotal, unit: "GB", need: needs.vramGb, hue: GPU_HUE, note: nearFull(vramNow, vramTotal) ? `Near the top${compute?.shrink ? ` — ${compute.shrink}` : ': a smaller micro-batch, gradient checkpointing, an 8-bit optimiser'}` : headroom(needs.vramGb, vramNow, vramTotal) })) : null, _jsx(Meter, { label: "CPU", value: sample?.cpu !== undefined ? `${sample.cpu}%` : '—', used: sample?.cpu, total: 100, hue: CPU_HUE }), _jsx(Meter, { label: "RAM", value: ramNow !== undefined ? `${ramNow.toFixed(1)} / ${ramTotal?.toFixed(0) ?? '?'} GB` : '—', used: ramNow, total: ramTotal, unit: "GB", need: needs.ramGb, hue: CPU_HUE, note: headroom(needs.ramGb, ramNow, ramTotal) }), _jsx(Meter, { label: "Disk", value: sample?.diskFreeGb !== undefined ? `${diskUsed} used · ${sample.diskFreeGb} GB free` : '—', used: diskUsed, total: sample?.diskTotalGb, unit: "GB", hue: "var(--muted)" })] }), tenLabel, use.some((s) => s.points.length >= 2) ? (_jsxs("div", { className: "rt-timeline", children: [_jsx(LineChart, { series: use, title: "Use", xLabel: "min", unit: "%", tableLabel: use.length === 1 ? `${use[0].name} %` : undefined, xRange: [-HISTORY_MS / MINUTE, 0] }), ruler, memory.length ? _jsx(LineChart, { series: memory, title: "Memory", xLabel: "min", unit: " GB", xRange: [-HISTORY_MS / MINUTE, 0] }) : null] })) : (_jsx("p", { className: "rt-note", children: colab.gpuWatch ? 'A timeline draws here as the machine is read.' : 'The watch is off, so nothing is read; switch it on below.' }))] })) : style === 'tiles' ? (_jsxs(_Fragment, { children: [nowLabel, _jsxs("div", { className: "rt-tiles", children: [gpuMachine ? _jsx(Tile, { label: "GPU", value: sample?.gpu ? `${sample.gpu.util}` : '—', unit: "%", points: sparks.gpu, max: 100, hue: GPU_HUE }) : null, gpuMachine ? _jsx(Tile, { label: "VRAM", value: vramNow !== undefined ? vramNow.toFixed(1) : '—', unit: vramTotal ? `of ${vramTotal.toFixed(0)} GB` : 'GB', note: headroom(needs.vramGb, vramNow, vramTotal), points: sparks.vram, max: vramTotal ?? 16, hue: GPU_HUE }) : null, _jsx(Tile, { label: "CPU", value: sample?.cpu !== undefined ? `${sample.cpu}` : '—', unit: "%", points: sparks.cpu, max: 100, hue: CPU_HUE }), _jsx(Tile, { label: "RAM", value: ramNow !== undefined ? ramNow.toFixed(1) : '—', unit: ramTotal ? `of ${ramTotal.toFixed(0)} GB` : 'GB', note: headroom(needs.ramGb, ramNow, ramTotal), points: sparks.ram, max: ramTotal ?? 16, hue: CPU_HUE })] }), tenLabel, _jsxs("div", { className: "rt-strips", children: [gpuMachine ? _jsx(Strip, { label: "GPU", values: strips.gpu, max: 100, hue: GPU_HUE, unit: "%" }) : null, _jsx(Strip, { label: "CPU", values: strips.cpu, max: 100, hue: CPU_HUE, unit: "%" }), gpuMachine ? _jsx(Strip, { label: "VRAM", values: strips.vram, max: vramTotal ?? 16, hue: GPU_HUE, unit: " GB", format: (v) => v.toFixed(1) }) : null, _jsx(Strip, { label: "RAM", values: strips.ram, max: ramTotal ?? 16, hue: CPU_HUE, unit: " GB", format: (v) => v.toFixed(1) }), _jsx("span", {}), ruler, _jsx("span", {}), _jsx("span", {}), _jsxs("span", { className: "rt-strip-axis", children: [_jsx("span", { children: "10 min ago" }), _jsx("span", { children: segments.length ? `${labelOf(segments[segments.length - 1].key)} ${segments[segments.length - 1].live ? 'running' : 'ran'}` : '' }), _jsx("span", { children: "now" })] }), _jsx("span", {})] }), _jsx("div", { className: "rt-part-label", children: "Disk" }), _jsx("div", { className: "rt-meters", children: _jsx(Meter, { label: sample?.diskFreeGb !== undefined ? `${sample.diskFreeGb} GB` : 'Disk', value: sample?.diskTotalGb !== undefined ? `free of ${sample.diskTotalGb}` : '—', used: diskUsed, total: sample?.diskTotalGb, unit: "GB", hue: "var(--muted)" }) })] })) : (_jsxs(_Fragment, { children: [nowLabel, _jsxs("div", { className: "rt-rings", children: [gpuMachine ? _jsx(Ring, { label: "GPU", value: sample?.gpu ? `${sample.gpu.util}%` : '—', share: sample?.gpu ? sample.gpu.util / 100 : undefined, hue: GPU_HUE }) : null, _jsx(Ring, { label: "CPU", value: sample?.cpu !== undefined ? `${sample.cpu}%` : '—', share: sample?.cpu !== undefined ? sample.cpu / 100 : undefined, hue: CPU_HUE }), gpuMachine ? (_jsx(Ring, { label: "VRAM", value: vramNow !== undefined && vramTotal ? `${Math.round((vramNow / vramTotal) * 100)}%` : '—', share: vramNow !== undefined && vramTotal ? vramNow / vramTotal : undefined, hue: GPU_HUE })) : (_jsx(Ring, { label: "RAM", value: ramNow !== undefined && ramTotal ? `${Math.round((ramNow / ramTotal) * 100)}%` : '—', share: ramNow !== undefined && ramTotal ? ramNow / ramTotal : undefined, hue: CPU_HUE }))] }), _jsxs("div", { className: "rt-part-label", children: ["Memory", compute ? ', against the plan' : ''] }), _jsxs("div", { className: "rt-budgets", children: [gpuMachine ? _jsx(Budget, { label: "VRAM", used: vramNow, total: vramTotal, need: needs.vramGb, hue: GPU_HUE }) : null, _jsx(Budget, { label: "RAM", used: ramNow, total: ramTotal, need: needs.ramGb, hue: CPU_HUE }), _jsxs("div", { className: "rt-legend", children: [_jsxs("span", { children: [_jsx("i", { style: { background: GPU_HUE } }), " used"] }), _jsxs("span", { children: [_jsx("i", { className: "is-free" }), " free"] }), compute ? (_jsxs("span", { children: [_jsx("i", { className: "is-need" }), " the plan's need"] })) : null] })] }), _jsxs("div", { className: "rt-part-label", children: ["Peaks, by cell", _jsx("small", { children: " \u00B7 last ten minutes" })] }), peaks.length ? (_jsx("div", { className: "rt-peaks", children: peaks.map((peak) => {
                            const id = idOf(peak.key);
                            const top = peak.gpu !== undefined ? peak.gpu : (peak.cpu ?? 0);
                            const memText = peak.vramMb !== undefined ? `${(peak.vramMb / 1024).toFixed(1)} GB VRAM` : peak.ramMb !== undefined ? `${(peak.ramMb / 1024).toFixed(1)} GB RAM` : '';
                            return (_jsxs("button", { type: "button", className: "rt-peak", disabled: !id, onClick: () => id && onGoTo?.(id), title: id ? 'Go to the cell' : undefined, children: [_jsx("b", { children: labelOf(peak.key) }), _jsx("span", { className: "rt-meter-bar", "aria-hidden": "true", children: _jsx("span", { className: "rt-meter-fill", style: { width: `${Math.round(top)}%`, background: peak.gpu !== undefined ? GPU_HUE : CPU_HUE } }) }), _jsxs("span", { className: "rt-peak-v", children: [top, "% ", peak.gpu !== undefined ? 'GPU' : 'CPU', memText ? _jsx("small", { children: memText }) : null] })] }, peak.key));
                        }) })) : (_jsx("p", { className: "rt-note", children: "A cell that runs while the machine is watched is listed here with its peaks." }))] })), _jsx("div", { className: "rt-part-label", children: "Limits" }), ownServer ? (_jsx("div", { className: "rt-limits", children: _jsxs("p", { className: "rt-note", children: ["A Jupyter server of your own", colab.backend.kind === 'jupyter' ? ` at ${new URL(colab.backend.server.url).host}` : '', ": no Colab session limit and no compute units. If it is a rented machine, it is billed while it is up \u2014 stop it with its provider when you are done."] }) })) : (_jsxs("div", { className: "rt-limits", children: [_jsxs("div", { className: "rt-limit", children: [_jsxs("span", { className: "rt-limit-row", children: [_jsx("b", { children: "Session" }), _jsxs("span", { children: [spanText(session.leftMs), " left of ", session.capHours, " h"] })] }), _jsx("span", { className: "rt-meter-bar", "aria-hidden": "true", children: _jsx("span", { className: `rt-meter-fill${session.share > 0.9 ? ' is-warn' : ''}`, style: { width: `${Math.round(session.share * 100)}%` } }) })] }), _jsx("div", { className: "rt-limit", children: _jsxs("span", { className: "rt-limit-row", children: [_jsx("b", { children: "Compute units" }), _jsx("span", { children: !gpuMachine || runtime.accelerator === 'T4' ? 'free tier' : colab.units?.balance !== undefined ? `${colab.units.balance.toFixed(1)}${unitHours !== null ? ` · about ${spanText(unitHours * 3_600_000)} at ${colab.units.ratePerHour?.toFixed(2)}/h` : ''}` : 'your tier’s' })] }) }), idleFor > 15 * MINUTE ? _jsxs("p", { className: "rt-note is-warn", children: ["Nothing has run for ", spanText(idleFor), ". Colab ends a runtime left idle for long; the pulse keeps this one read, which the free tier counts as activity."] }) : null] })), _jsx("div", { className: "rt-part-label", children: "Reading the machine" }), _jsxs("label", { className: "colab-switch rt-switch", children: [_jsx("input", { type: "checkbox", checked: colab.gpuWatch, onChange: (event) => setGpuWatch(event.target.checked) }), _jsxs("span", { children: [_jsx("b", { children: "Watch while cells run" }), _jsx("small", { children: "A few lines of the reader's own, in a second kernel, every two seconds \u2014 the probe in the chip's menu." })] })] }), _jsxs("div", { className: "rt-pulse", children: [_jsxs("span", { className: "rt-pulse-label", children: [_jsx("b", { children: "Between cells" }), _jsx("small", { children: "The same reading while nothing runs, so the numbers are the machine now, not the last run. Colab may count it as activity: on the free tier that keeps the runtime up; on a machine billed in units the runtime is paid for while it is up either way, and the reading is a negligible share." })] }), _jsx("div", { className: "segmented rt-pulse-pick", role: "radiogroup", "aria-label": "How often the machine is read between cells", children: [
                            ['live', 'Live · 2 s'],
                            ['slow', 'Every 30 s'],
                            ['off', 'Off'],
                        ].map(([id, label]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": colab.pulse === id, "aria-pressed": colab.pulse === id, disabled: !colab.gpuWatch, onClick: () => setPulse(id), children: label }, id))) })] }), _jsx("button", { type: "button", className: "btn sm ghost rt-read", disabled: colab.status === 'busy' || !colab.gpuWatch, onClick: () => void probeMachine(), children: "Read now" }), _jsx("div", { className: "rt-part-label", children: "The runtime" }), _jsxs("div", { className: "rt-actions", children: [_jsx("button", { type: "button", className: "btn sm", disabled: colab.status === 'busy', onClick: () => void restartKernel(), title: "Forgets every variable; keeps the machine and the files on it", children: "Restart the kernel" }), ownServer ? null : (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "btn sm", disabled: colab.status === 'busy', "aria-expanded": changing, onClick: () => setChanging(!changing), children: "Change machine\u2026" }), _jsx("a", { className: "btn sm", href: attachUrl(runtime.endpoint), target: "_blank", rel: "noreferrer noopener", title: "Colab's own notebook page on the same machine \u2014 for Drive, on purpose", children: "Open in Colab \u2197" })] })), confirmStop ? (_jsxs("span", { className: "rt-confirm", children: ["Release the machine now?", _jsx("button", { type: "button", className: "btn sm primary", onClick: () => {
                                    setConfirmStop(false);
                                    void stopRuntime();
                                }, children: "Stop" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setConfirmStop(false), children: "Keep it" })] })) : (_jsx("button", { type: "button", className: "btn sm colab-stop", onClick: () => setConfirmStop(true), children: ownServer ? 'Shut down the kernel' : 'Stop the runtime' }))] }), changing ? (_jsxs("div", { className: "rt-change", children: ["A new runtime on another machine; this one is stopped, and its variables and files go with it.", _jsx(MachinePicker, { machine: colab.machine, onPick: (machine) => {
                            setMachine(machine);
                            setChanging(false);
                            void stopRuntime().then(() => connect(machine));
                        } })] })) : null] }));
}
