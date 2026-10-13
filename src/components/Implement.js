import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ===========================================================================
//  The Implementation page's own pieces. The page itself is Explain.tsx —
//  the same bar, outline, sections and ask bar, switched to the plan by the
//  tab in the bar — and these are what the plan has that the explanation
//  does not: a directory tree, starter files, a compute budget worked out
//  for the reader's machine, the picker for that machine, the empty state,
//  and the Local menu that writes the scaffold onto the reader's machine.
// ===========================================================================
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cellKey, colabAvailable, colabGranted, connect as connectColab, probeMachine, runAll, runCell, setMachine } from '../lib/colab';
import { colabChoices, colabMachine, colabMachineOf, colabSteps, needsOn } from '../lib/colabRun';
import { DEFAULT_HARDWARE, estimate, FIT_TEXT, flopsText, GPUS, gpuById, hoursText, matchGpu, normaliseHardware, parseCompute, usdText } from '../lib/hardware';
import { computeOf, hardwareNow, parseTree, setHardware, slugOf, subscribeHardware } from '../lib/implement';
import { useStore } from '../lib/store';
import { runInWorkspace, workspaceStatus, writeScaffold } from '../lib/workspace';
import { gigabytes } from '../lib/telemetry';
import { MachineChart } from './Charts';
import { CellRunOutput, ColabMark, ConnectCard, RunState, useColab } from './Colab';
import { CloseIcon, ExplainIcon, LocalIcon } from './icons';
import { highlightPython } from './Explain';
import { KeepButton } from './Keep';
import CopyBlock from './CopyBlock';
import { WhereDialog } from './Playground';
import { createPlayground, OPEN_PLAYGROUND, paperCells, paperFiles } from '../lib/playground';
/** The plan the page is showing — its title and sections — for the pieces that need more than their own block, such as the Colab panel under the budget. */
export const PlanContext = createContext(null);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const useHardware = () => useSyncExternalStore(subscribeHardware, hardwareNow);
let local = { checking: false, console: { open: false, command: '', output: '', running: false } };
const localListeners = new Set();
const setLocal = (patch) => {
    local = { ...local, ...patch };
    localListeners.forEach((listener) => listener());
};
const setConsole = (patch) => setLocal({ console: { ...local.console, ...patch } });
const subscribeLocal = (listener) => {
    localListeners.add(listener);
    return () => {
        localListeners.delete(listener);
    };
};
export const useLocal = () => useSyncExternalStore(subscribeLocal, () => local);
/** Asks the proxy about the machine, once, or again on `refresh`. */
export async function checkWorkspace(refresh = false) {
    if (local.checking || (local.status && !refresh))
        return;
    setLocal({ checking: true });
    const status = await workspaceStatus();
    setLocal({ status, checking: false });
}
let controller = null;
/** Runs a command in the project's directory, its output into the console. */
export async function runLocally(command) {
    const project = local.project;
    if (!project || local.console.running || !command.trim())
        return;
    controller = new AbortController();
    setConsole({ open: true, command, output: '', running: true, error: undefined });
    try {
        await runInWorkspace(project.slug, command, (text) => setConsole({ output: text }), controller.signal);
    }
    catch (error) {
        if (!controller.signal.aborted)
            setConsole({ error: error instanceof Error ? error.message : String(error) });
    }
    finally {
        controller = null;
        setConsole({ running: false });
    }
}
export function stopLocally() {
    controller?.abort();
}
/** The commands the page suggests running: its shell cells, and the Makefile's targets. */
export function suggestedCommands(sections) {
    const out = [];
    for (const section of sections)
        for (const block of section.blocks) {
            if (block.kind === 'file' && /(^|\/)Makefile$/.test(block.path)) {
                for (const match of block.code.matchAll(/^([a-z][\w-]*):(?!=)/gm))
                    if (!out.some((c) => c.command === `make ${match[1]}`))
                        out.push({ label: `make ${match[1]}`, command: `make ${match[1]}` });
            }
            if (block.kind === 'code' && block.lang === 'bash' && !block.open)
                out.push({ label: block.title, command: block.code.trim() });
        }
    return out.slice(0, 12);
}
// ---------------------------------------------------------------------------
// A directory tree
// ---------------------------------------------------------------------------
export function TreeBlock({ block }) {
    const rows = useMemo(() => parseTree(block.text), [block.text]);
    return (_jsxs("figure", { className: "impl-tree", children: [_jsxs("header", { children: [_jsx("span", { className: "cell-index", children: "tree" }), _jsx("span", { className: "cell-title", children: "Repository layout" })] }), _jsxs("ol", { children: [rows.map((row, index) => (_jsxs("li", { className: row.dir ? 'is-dir' : 'is-file', style: { paddingLeft: 14 + row.depth * 18 }, children: [_jsx("span", { className: "tree-icon", "aria-hidden": "true", children: row.dir ? (_jsx("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.3", strokeLinejoin: "round", children: _jsx("path", { d: "M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z" }) })) : (_jsxs("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.3", strokeLinejoin: "round", children: [_jsx("path", { d: "M4 1.5h5l3 3v10H4v-13Z" }), _jsx("path", { d: "M9 1.5v3h3" })] })) }), _jsx("span", { className: "tree-name", children: row.name }), row.note ? _jsx("span", { className: "tree-note", children: row.note }) : null] }, index))), block.open ? _jsx("li", { className: "tree-writing", children: "\u2026" }) : null] })] }));
}
// ---------------------------------------------------------------------------
// A starter file
// ---------------------------------------------------------------------------
export function FileBlock({ block }) {
    const [copied, setCopied] = useState(false);
    const lines = block.code.replace(/\s+$/, '').split('\n').length;
    return (_jsxs("figure", { className: "impl-file", "data-path": block.path, children: [_jsxs("header", { children: [_jsxs("span", { className: "file-path", title: block.path, children: [_jsx("span", { className: "file-dir", children: block.path.includes('/') ? `${block.path.slice(0, block.path.lastIndexOf('/') + 1)}` : '' }), _jsx("b", { children: block.path.slice(block.path.lastIndexOf('/') + 1) })] }), _jsxs("span", { className: "file-meta", children: [block.lang, " \u00B7 ", lines, " ", lines === 1 ? 'line' : 'lines'] }), _jsx(KeepButton, { selector: ".impl-file", what: "file" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => {
                            void navigator.clipboard?.writeText(block.code).then(() => {
                                setCopied(true);
                                window.setTimeout(() => setCopied(false), 1400);
                            });
                        }, children: copied ? 'Copied' : 'Copy' })] }), _jsxs("pre", { className: "cell-code", children: [_jsx("code", { dangerouslySetInnerHTML: { __html: block.lang === 'python' ? highlightPython(block.code) : esc(block.code) } }), block.open ? _jsx("span", { className: "caret", "aria-hidden": "true" }) : null] })] }));
}
// ---------------------------------------------------------------------------
// The reader's machine
// ---------------------------------------------------------------------------
const RAM_CHOICES = [8, 16, 32, 64, 128, 256, 512, 1024];
const DISK_CHOICES = [50, 100, 200, 500, 1000, 2000, 4000];
/**
 * The picker. What it sets is kept in this browser and sent to Claude with
 * every request, and the compute budget on the page recomputes from it as it
 * changes. `compact` is the version in the outline.
 */
export function HardwarePanel({ compact }) {
    const hardware = useHardware();
    const gpu = gpuById(hardware.gpu);
    const set = (patch) => setHardware(normaliseHardware({ ...hardware, ...patch }));
    const counts = Array.from({ length: gpu.maxCount }, (_, i) => i + 1);
    return (_jsxs("div", { className: `hardware-panel${compact ? ' is-compact' : ''}`, role: "group", "aria-label": "Your machine", children: [_jsxs("label", { className: "hw-field hw-gpu", children: [_jsx("span", { children: "Accelerator" }), _jsx("select", { value: hardware.gpu, onChange: (event) => set({ gpu: event.target.value, count: 1 }), "aria-label": "Accelerator", children: ['Colab', 'a desktop', 'rented', 'other'].map((group) => (_jsx("optgroup", { label: group === 'other' ? 'Elsewhere' : group === 'rented' ? 'Rented by the hour' : group === 'a desktop' ? 'Your own' : 'Google Colab', children: GPUS.filter((g) => (group === 'Colab' ? g.colab : group === 'a desktop' ? g.where === 'a desktop' : group === 'rented' ? g.where.startsWith('rented') : !g.colab && g.where !== 'a desktop' && !g.where.startsWith('rented'))).map((g) => (_jsxs("option", { value: g.id, children: [g.label, " \u2014 ", g.where] }, g.id))) }, group))) })] }), _jsxs("label", { className: "hw-field", children: [_jsx("span", { children: "Cards" }), _jsx("select", { value: hardware.count, disabled: gpu.maxCount === 1, onChange: (event) => set({ count: Number(event.target.value) }), "aria-label": "How many cards", children: counts.map((n) => (_jsxs("option", { value: n, children: [n, "\u00D7"] }, n))) })] }), _jsxs("label", { className: "hw-field", children: [_jsx("span", { children: "RAM" }), _jsxs("select", { value: RAM_CHOICES.includes(hardware.ramGb) ? hardware.ramGb : 'custom', onChange: (event) => set({ ramGb: Number(event.target.value) }), "aria-label": "System memory", children: [RAM_CHOICES.map((n) => (_jsxs("option", { value: n, children: [n, " GB"] }, n))), !RAM_CHOICES.includes(hardware.ramGb) ? _jsxs("option", { value: "custom", children: [hardware.ramGb, " GB"] }) : null] })] }), _jsxs("label", { className: "hw-field", children: [_jsx("span", { children: "Free disk" }), _jsxs("select", { value: DISK_CHOICES.includes(hardware.diskGb) ? hardware.diskGb : 'custom', onChange: (event) => set({ diskGb: Number(event.target.value) }), "aria-label": "Free disk", children: [DISK_CHOICES.map((n) => (_jsx("option", { value: n, children: n >= 1000 ? `${n / 1000} TB` : `${n} GB` }, n))), !DISK_CHOICES.includes(hardware.diskGb) ? _jsxs("option", { value: "custom", children: [hardware.diskGb, " GB"] }) : null] })] }), !compact ? (_jsxs(_Fragment, { children: [_jsxs("label", { className: "hw-field hw-range", children: [_jsxs("span", { children: ["Hours a day ", _jsx("b", { children: hardware.hoursPerDay })] }), _jsx("input", { type: "range", min: 1, max: 24, step: 1, value: hardware.hoursPerDay, onChange: (event) => set({ hoursPerDay: Number(event.target.value) }), "aria-label": "Hours a day the machine is yours" })] }), _jsxs("label", { className: "hw-field hw-range", title: "Model FLOPs utilisation: the share of the card's peak that training really reaches. 30\u201350% is a well-tuned transformer; small batches and small models sit lower.", children: [_jsxs("span", { children: ["Utilisation ", _jsxs("b", { children: [Math.round(hardware.mfu * 100), "%"] })] }), _jsx("input", { type: "range", min: 0.1, max: 0.6, step: 0.05, value: hardware.mfu, onChange: (event) => set({ mfu: Number(event.target.value) }), "aria-label": "Utilisation of the card's peak" })] })] })) : null, _jsx(UseThisMachine, {}), _jsxs("div", { className: "hw-note", children: [gpu.id === 'cpu'
                        ? 'No accelerator: only the smallest experiments are practical.'
                        : `${hardware.count > 1 ? `${hardware.count}× ` : ''}${gpu.tflops} TFLOPS bf16 · ${gpu.vramGb} GB${hardware.count > 1 ? ` a card` : ''}${gpu.usdPerHour ? ` · about $${gpu.usdPerHour}/h${hardware.count > 1 ? ' a card' : ''}` : ' · no hourly cost'}${gpu.sessionHours ? ` · sessions of up to ${gpu.sessionHours} h` : ''}`, hardware !== DEFAULT_HARDWARE ? null : ''] })] }));
}
/** "Use this machine": what the proxy found under the desk, into the picker. */
function UseThisMachine() {
    const { status, checking } = useLocal();
    useEffect(() => {
        void checkWorkspace();
    }, []);
    if (!status?.available)
        return null;
    const { machine } = status;
    const card = machine.gpus[0];
    const matched = card ? matchGpu(card.name, card.vramGb) : null;
    const apply = () => {
        const hardware = hardwareNow();
        setHardware(normaliseHardware({
            ...hardware,
            gpu: matched?.id ?? 'cpu',
            count: matched ? Math.max(1, machine.gpus.length) : 1,
            ramGb: machine.ramGb || hardware.ramGb,
            diskGb: machine.diskFreeGb ?? hardware.diskGb,
            hoursPerDay: 24,
        }));
    };
    return (_jsxs("div", { className: "hw-detect", children: [_jsxs("button", { type: "button", className: "btn sm", onClick: apply, disabled: checking, title: card ? `${machine.gpus.length}× ${card.name}${card.vramGb ? ` (${card.vramGb} GB)` : ''}, ${machine.ramGb} GB RAM` : 'No NVIDIA card was found; the CPU only', children: [_jsx(LocalIcon, { size: 14 }), " Use this machine"] }), _jsxs("span", { children: [machine.host, ": ", card ? `${machine.gpus.length > 1 ? `${machine.gpus.length}× ` : ''}${card.name}${card.vramGb ? ` · ${card.vramGb} GB` : ''}` : 'no NVIDIA GPU found', " \u00B7 ", machine.ramGb, " GB RAM", matched && card && !new RegExp(matched.label.split(' ')[0], 'i').test(card.name) ? ` · nearest in the list: ${matched.label}` : ''] })] }));
}
// ---------------------------------------------------------------------------
// The compute budget, for that machine
// ---------------------------------------------------------------------------
const fitClass = (fit) => `fit-${fit}`;
function FitChip({ fit }) {
    return _jsx("span", { className: `fit-chip ${fitClass(fit)}`, children: FIT_TEXT[fit] });
}
export function ComputeBlock({ block }) {
    const hardware = useHardware();
    const compute = useMemo(() => (block.open ? null : parseCompute(block.text)), [block.text, block.open]);
    if (!compute) {
        return (_jsxs("figure", { className: "impl-budget", children: [_jsxs("header", { children: [_jsx("span", { className: "cell-index", children: "budget" }), _jsx("span", { className: "cell-title", children: "Compute budget" })] }), _jsx("div", { className: "budget-empty", children: block.open ? 'Working out the budget…' : 'The budget could not be read. Ask for it again from the bar: “Rewrite the compute block as valid JSON”.' })] }));
    }
    return (_jsxs(_Fragment, { children: [_jsx(Budget, { compute: compute, hardware: hardware }), _jsx(ColabRunPanel, { compute: compute, hardware: hardware })] }));
}
function Budget({ compute, hardware }) {
    const est = estimate(compute, hardware);
    const [editing, setEditing] = useState(false);
    const longest = Math.max(1e-9, ...est.phases.map((phase) => phase.hours));
    const gpu = est.gpu;
    const machine = gpu.id === 'cpu' ? 'CPU only' : `${hardware.count}× ${gpu.label}`;
    return (_jsxs("figure", { className: "impl-budget", id: "compute-budget", children: [_jsxs("header", { children: [_jsx("span", { className: "cell-index", children: "budget" }), _jsxs("span", { className: "cell-title", children: ["Compute budget on ", _jsx("b", { children: machine })] }), _jsx(KeepButton, { selector: ".impl-budget", what: "budget" }), _jsx("button", { type: "button", className: "btn sm ghost", "aria-expanded": editing, onClick: () => setEditing(!editing), children: editing ? 'Done' : 'Change machine' })] }), editing ? _jsx(HardwarePanel, {}) : null, _jsxs("div", { className: "budget-summary", children: [_jsxs("div", { className: "budget-stat", children: [_jsx("span", { className: "stat-label", children: "Wall clock" }), _jsx("b", { children: hoursText(est.hours) }), _jsx("span", { className: "stat-note", children: est.days >= 1 ? `${est.days.toFixed(1).replace(/\.0$/, '')} days at ${hardware.hoursPerDay} h a day` : 'in one sitting' })] }), _jsxs("div", { className: "budget-stat", children: [_jsx("span", { className: "stat-label", children: "Cost" }), _jsx("b", { children: usdText(est.usd) }), _jsx("span", { className: "stat-note", children: gpu.usdPerHour ? `at about $${gpu.usdPerHour}/h a card` : gpu.colab ? 'on the free tier' : 'your own hardware' })] }), _jsxs("div", { className: "budget-stat", children: [_jsx("span", { className: "stat-label", children: "Memory" }), _jsx(FitChip, { fit: est.fit }), _jsx("span", { className: "stat-note", children: compute.minVramGb !== undefined ? `needs ${compute.minVramGb} GB · ${gpu.vramGb ? `${gpu.vramGb * hardware.count} GB here` : 'no card'}` : '' })] }), est.sessions !== undefined ? (_jsxs("div", { className: "budget-stat", children: [_jsx("span", { className: "stat-label", children: "Colab sessions" }), _jsx("b", { children: est.sessions }), _jsx("span", { className: "stat-note", children: est.sessions > 1 ? 'checkpoint to Drive between them' : `up to ${gpu.sessionHours} h each` })] })) : null] }), _jsx("div", { className: "budget-scroll", children: _jsxs("table", { className: "budget-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Phase" }), _jsx("th", { children: "Work" }), _jsx("th", { children: "On your machine" }), _jsx("th", { children: "Memory" })] }) }), _jsx("tbody", { children: est.phases.map((row, index) => (_jsxs("tr", { children: [_jsxs("td", { children: [_jsx("b", { children: row.phase.name }), row.phase.note ? _jsx("span", { className: "phase-note", children: row.phase.note }) : null] }), _jsxs("td", { className: "mono", children: [row.phase.flops !== undefined ? flopsText(row.phase.flops) : row.phase.h100Hours !== undefined ? `${row.phase.h100Hours} H100 h` : '—', row.phase.parallel === false ? _jsx("span", { className: "phase-note", children: "one card" }) : null] }), _jsxs("td", { children: [_jsx("div", { className: "phase-bar", style: { width: `${Math.max(2, (row.hours / longest) * 100)}%` } }), _jsx("span", { className: "phase-hours", children: hoursText(row.hours) }), row.usd > 0 ? _jsx("span", { className: "phase-usd", children: usdText(row.usd) }) : null] }), _jsxs("td", { children: [row.phase.memoryGb !== undefined ? _jsxs("span", { className: "mono", children: [row.phase.memoryGb, " GB"] }) : null, " ", _jsx(FitChip, { fit: row.fit })] })] }, index))) })] }) }), _jsxs("div", { className: "budget-foot", children: [compute.diskGb !== undefined ? (_jsxs("span", { className: est.disk === 'no' ? 'is-bad' : '', children: ["Disk: ", compute.diskGb, " GB needed, ", hardware.diskGb, " GB free", est.disk === 'no' ? ' — not enough' : ''] })) : null, compute.ramGb !== undefined ? (_jsxs("span", { className: est.ram === 'no' ? 'is-bad' : '', children: ["RAM: ", compute.ramGb, " GB needed, ", hardware.ramGb, " GB here", est.ram === 'no' ? ' — not enough' : ''] })) : null, est.fit !== 'fits' && compute.shrink ? _jsxs("span", { className: "shrink", children: ["To get it to fit: ", compute.shrink] }) : null, _jsxs("span", { className: "assumption", children: ["Hours are FLOPs \u00F7 (", hardware.count > 1 ? `${hardware.count} × ` : '', gpu.tflops, " TFLOPS \u00D7 ", Math.round(hardware.mfu * 100), "% utilisation); an estimate, not a promise."] })] })] }));
}
/** The budget in three lines, for the outline: the machine, the time, the fit. */
export function HardwareSummary({ sections }) {
    const hardware = useHardware();
    const compute = useMemo(() => computeOf(sections), [sections]);
    const gpu = gpuById(hardware.gpu);
    const est = compute ? estimate(compute, hardware) : null;
    return (_jsxs("div", { className: "outline-hardware", children: [_jsx("div", { className: "aged-label", children: "Your machine" }), _jsxs("div", { className: "hw-summary-line", children: [_jsx("b", { children: gpu.id === 'cpu' ? 'CPU only' : `${hardware.count}× ${gpu.label}` }), _jsx("span", { children: gpu.where })] }), est ? (_jsxs("div", { className: "hw-summary-est", children: [_jsx("span", { className: "est-time", children: hoursText(est.hours) }), _jsx("span", { className: "est-cost", children: usdText(est.usd) }), _jsx(FitChip, { fit: est.fit })] })) : null, _jsx("a", { href: "#compute-budget", className: "hw-change", onClick: (event) => {
                    event.preventDefault();
                    const target = document.getElementById('compute-budget') ?? document.querySelector('.impl-budget');
                    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    target?.querySelector('button[aria-expanded="false"]')?.click();
                }, children: "Change machine" }), est ? (_jsx("a", { href: "#run-on-colab", className: "hw-change", onClick: (event) => {
                    event.preventDefault();
                    openColabPanel();
                }, children: "Run it on Colab" })) : null] }));
}
/** Brings the Colab panel under the budget into view, opened. */
export function openColabPanel() {
    const target = document.getElementById('run-on-colab');
    if (!target)
        return;
    target.querySelector('button[aria-expanded="false"].colab-panel-toggle')?.click();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// ---------------------------------------------------------------------------
// Before there is a plan
// ---------------------------------------------------------------------------
export function ImplementEmpty({ title, byline, children }) {
    return (_jsxs("div", { className: "explain-empty impl-empty", children: [_jsxs("div", { className: "explain-kicker pill", children: [_jsx(ExplainIcon, { size: 15 }), " The paper, as a project"] }), _jsx("h1", { children: title }), byline ? _jsx("div", { className: "byline", children: byline }) : null, _jsxs("p", { className: "explain-lede", children: ["The model reads the paper and plans how to ", _jsx("b", { children: "build it" }), ": ", _jsx("mark", { children: "what to reproduce" }), " and what to leave out, ", _jsx("mark", { children: "which datasets" }), " and where to get them, how to ", _jsx("mark", { children: "lay the code out" }), ", the starter files, and ", _jsx("b", { children: "what it costs" }), " \u2014 in hours and dollars on the machine you pick below."] }), _jsxs("ul", { className: "explain-promises impl-promises", children: [_jsxs("li", { className: "p-data", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsxs("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", children: [_jsx("ellipse", { cx: "12", cy: "6", rx: "7.5", ry: "3" }), _jsx("path", { d: "M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" }), _jsx("path", { d: "M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" })] }) }), _jsx("b", { children: "Datasets" }), _jsx("span", { children: "what the paper used, what is public, how to get it" })] }), _jsxs("li", { className: "p-tree", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsxs("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("path", { d: "M4 5h5l2 2h9v11H4V5Z" }), _jsx("path", { d: "M4 10h16" })] }) }), _jsx("b", { children: "Repository & starter files" }), _jsx("span", { children: "the layout, the skeletons, a zip or a commit" })] }), _jsxs("li", { className: "p-budget", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsxs("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", children: [_jsx("circle", { cx: "12", cy: "12", r: "8.5" }), _jsx("path", { d: "M12 7.5V12l3 2" })] }) }), _jsx("b", { children: "Compute budget" }), _jsx("span", { children: "hours, dollars and memory for your hardware" })] }), _jsxs("li", { className: "p-colab", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsx("span", { className: "colab-mark", children: "co" }) }), _jsx("b", { children: "Colab" }), _jsx("span", { children: "a notebook that lays the repository out and runs" })] })] }), _jsxs("div", { className: "impl-machine", children: [_jsxs("div", { className: "impl-machine-head", children: [_jsx("b", { children: "Your machine" }), _jsx("span", { children: "The model plans for it: the scale, the batch sizes, the substitutions." })] }), _jsx(HardwarePanel, {})] }), children] }));
}
/**
 * The plan's scaffold as a Playground project: its starter files, PLAN.md and notebook at the top of the folder,
 * the briefing the terminal agents read (AGENTS.md, CLAUDE.md) and a README unless the plan wrote its own, citing the paper.
 */
export function planProjectFiles(plan, paper) {
    const files = {};
    for (const [path, text] of Object.entries(plan.files))
        files[plan.folder && path.startsWith(`${plan.folder}/`) ? path.slice(plan.folder.length + 1) : path] = text;
    const brief = paperFiles(paper.title, paper);
    for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md'])
        if (!(name in files))
            files[name] = brief[name];
    return files;
}
export function LocalMenu({ title, bundle, sections, plan = null, paper, onPlan, existing, projectOpen = false, onProject, }) {
    const { status, checking, project } = useLocal();
    const { papers } = useStore();
    const [open, setOpen] = useState(false);
    /** The Playground's own "Where should it run?", for the plan as a project. */
    const [projecting, setProjecting] = useState(false);
    const [writing, setWriting] = useState('idle');
    const [error, setError] = useState('');
    const box = useRef(null);
    useEffect(() => {
        void checkWorkspace();
    }, []);
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!box.current?.contains(event.target))
                setOpen(false);
        };
        const key = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener('mousedown', away);
        window.addEventListener('keydown', key, true);
        return () => {
            window.removeEventListener('mousedown', away);
            window.removeEventListener('keydown', key, true);
        };
    }, [open]);
    const slug = slugOf(title);
    const mine = project?.slug === slug ? project : undefined;
    const commands = useMemo(() => suggestedCommands(sections), [sections]);
    const what = bundle?.kind === 'plan' ? 'the scaffold' : bundle?.kind === 'page' ? 'the page' : 'the notebook';
    const write = async (overwrite = false) => {
        if (!bundle)
            return;
        setWriting('writing');
        setError('');
        try {
            // The files without their folder (implementations/<paper>/, notebooks/): the workspace has one folder a paper already.
            const flat = {};
            for (const [path, text] of Object.entries(bundle.files))
                flat[bundle.folder && path.startsWith(`${bundle.folder}/`) ? path.slice(bundle.folder.length + 1) : path] = text;
            const written = await writeScaffold(slug, flat, overwrite);
            setLocal({ project: { slug, dir: written.dir, written } });
            setWriting('idle');
            void checkWorkspace(true);
        }
        catch (failure) {
            setWriting('error');
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    };
    const draft = useMemo(() => {
        if (!plan || !paper)
            return null;
        const known = papers.find((p) => p.id === paper.paperId);
        const about = { ...paper, abstract: known?.abstract, arxivId: known?.arxivId, doi: known?.doi, authors: paper.authors ?? known?.authors };
        const head = paper.title.split(/[:—–]/)[0].trim();
        // Cut at a word, not inside one, when the title is long.
        const name = `${head.length > 70 ? `${head.slice(0, 70).replace(/\s+\S*$/, '')}…` : head} — implementation`;
        return { title: name, kind: 'project', start: 'paper', cites: [{ paperId: paper.paperId, title: paper.title }], files: planProjectFiles(plan, about), cells: paperCells(paper.title, about), note: `The plan's ${plan.what} go into the project's folder, with an AGENTS.md that tells a coding agent about the paper. It opens in the editor: files, a console, and the agent.` };
    }, [plan, paper, papers]);
    return (_jsxs("div", { className: "menu-wrap", ref: box, children: [_jsxs("button", { type: "button", className: `btn sm local-open${mine || projectOpen ? ' is-on' : ''}`, "aria-haspopup": "menu", "aria-expanded": open, disabled: !bundle && !draft, onClick: () => setOpen(!open), title: bundle ? `Write ${what} onto this machine, through the reader's proxy, and run it there` : 'Ready once the page is written', children: [_jsx(LocalIcon, { size: 15 }), " Local"] }), open && (bundle || draft) ? (_jsxs("div", { className: "menu right local-menu", role: "menu", "aria-label": "Local workspace", children: [paper ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: "Set up the implementation" }), existing && onProject ? (_jsxs("button", { type: "button", role: "menuitem", className: "colab-action local-project", disabled: projectOpen, onClick: () => {
                                    setOpen(false);
                                    onProject(existing.id);
                                }, children: [_jsx("b", { children: projectOpen ? 'Open below' : `Open ${existing.title}` }), _jsx("span", { children: "the project set up from this plan \u2014 its files, a terminal and the agent, here on this page" })] })) : null, draft ? (_jsxs("button", { type: "button", role: "menuitem", className: "colab-action local-project", onClick: () => {
                                    setOpen(false);
                                    setProjecting(true);
                                }, children: [_jsx("b", { children: existing ? 'Set up another project…' : 'Open as a project…' }), _jsxs("span", { children: ["the plan's ", Object.keys(draft.files).length, " files in an editor on this page \u2014 on this computer, Colab, or a GPU machine of yours"] })] })) : (_jsxs("button", { type: "button", role: "menuitem", className: "colab-action local-project", onClick: () => {
                                    setOpen(false);
                                    onPlan?.();
                                }, children: [_jsx("b", { children: "Plan it first" }), _jsx("span", { children: "the Implementation page writes the plan its project is set up from" })] })), bundle ? _jsxs("div", { className: "menu-label", children: ["Or write ", what, " through the proxy"] }) : null] })) : null, !bundle ? null : checking && !status ? (_jsx("div", { className: "colab-status", children: "Asking the proxy about this machine\u2026" })) : !status?.available ? (_jsxs("div", { className: "colab-status", children: [_jsx("b", { children: "No local workspace." }), " ", status?.reason ?? '', _jsx(CopyBlock, { className: "local-setup", code: "READER_WORKSPACE=~/reader-workspace npm start" }), "then point Settings \u2192 Paper proxy at it, and the scaffold can be written and run here."] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "local-machine", children: [_jsx("b", { children: status.machine.host }), _jsxs("span", { children: [status.machine.gpus.length ? status.machine.gpus.map((gpu) => `${gpu.name}${gpu.vramGb ? ` ${gpu.vramGb} GB` : ''}`).join(', ') : 'no NVIDIA GPU', " \u00B7 ", status.machine.ramGb, " GB RAM", status.machine.diskFreeGb !== undefined ? ` · ${status.machine.diskFreeGb} GB free` : ''] }), _jsxs("span", { children: [status.machine.python ?? 'no python on the path', status.machine.torch ? ` · torch ${status.machine.torch.version}${status.machine.torch.cuda ? ' with CUDA' : ', no CUDA'}` : ''] })] }), _jsxs("button", { type: "button", role: "menuitem", className: "colab-action", disabled: writing === 'writing', onClick: () => void write(false), children: [_jsx("b", { children: writing === 'writing' ? 'Writing…' : mine ? `Write ${what} again` : `Write ${what} here` }), _jsxs("span", { children: [status.root, "/", slug, "/ \u2014 ", Object.keys(bundle.files).length, " ", Object.keys(bundle.files).length === 1 ? 'file' : 'files', "; one you have changed is left alone"] })] }), mine ? (_jsxs("div", { className: "colab-status is-ok", children: [mine.written.written.length, " written", mine.written.skipped.length ? `, ${mine.written.skipped.length} left as you had ${mine.written.skipped.length === 1 ? 'it' : 'them'}` : '', mine.written.skipped.length ? (_jsxs(_Fragment, { children: [' · ', _jsxs("button", { type: "button", className: "link", onClick: () => void write(true), children: ["replace ", mine.written.skipped.length === 1 ? 'it' : 'them'] })] })) : null, _jsx("div", { className: "local-dir", children: mine.dir })] })) : null, writing === 'error' ? _jsx("div", { className: "colab-status is-error", children: error }) : null, mine ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: "Run there" }), commands.slice(0, 6).map((command) => (_jsxs("button", { type: "button", role: "menuitem", className: "colab-action local-command", onClick: () => {
                                            setOpen(false);
                                            void runLocally(command.command);
                                        }, children: [_jsx("b", { children: command.label }), _jsx("span", { children: command.command.split('\n')[0] })] }, command.command))), _jsxs("button", { type: "button", role: "menuitem", className: "colab-action", onClick: () => {
                                            setOpen(false);
                                            setConsole({ open: true });
                                        }, children: [_jsx("b", { children: "Open the console" }), _jsx("span", { children: "any command, in the project's directory" })] })] })) : null, _jsxs("div", { className: "colab-hint", children: [_jsx(LocalIcon, { size: 14 }), " Commands run as the user who started the proxy, in ", status.root, "."] })] }))] })) : null, projecting && draft ? (_jsx(WhereDialog, { draft: draft, onClose: () => setProjecting(false), onCreate: async (spec) => {
                    const made = await createPlayground(spec);
                    setProjecting(false);
                    if (onProject)
                        onProject(made.id);
                    else
                        window.dispatchEvent(new CustomEvent(OPEN_PLAYGROUND, { detail: { id: made.id } }));
                } })) : null] }));
}
/** The console at the bottom of the page: a command, its output as it comes, Stop. */
export function RunConsole({ sections }) {
    const { project, console: state } = useLocal();
    const [draft, setDraft] = useState('');
    const out = useRef(null);
    const commands = useMemo(() => suggestedCommands(sections), [sections]);
    useEffect(() => {
        const element = out.current;
        if (element)
            element.scrollTop = element.scrollHeight;
    }, [state.output]);
    if (!state.open || !project)
        return null;
    return (_jsxs("section", { className: "run-console", role: "region", "aria-label": "Local console", children: [_jsxs("header", { children: [_jsx(LocalIcon, { size: 15 }), _jsx("span", { className: "console-dir", title: project.dir, children: project.dir }), state.running ? (_jsxs("span", { className: "console-live", children: [_jsx("span", { className: "spinner" }), " running"] })) : null, _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close the console", onClick: () => setConsole({ open: false }), children: _jsx(CloseIcon, { size: 15 }) })] }), _jsxs("form", { className: "console-form", onSubmit: (event) => {
                    event.preventDefault();
                    void runLocally(draft);
                }, children: [_jsx("span", { className: "console-prompt", children: "$" }), _jsx("input", { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: "a command, in the project's directory \u2014 make test, python -m minitron.importance, nvidia-smi\u2026", "aria-label": "Command to run", disabled: state.running }), state.running ? (_jsx("button", { type: "button", className: "btn sm", onClick: stopLocally, children: "Stop" })) : (_jsx("button", { type: "submit", className: "btn sm primary", disabled: !draft.trim(), children: "Run" }))] }), commands.length ? (_jsx("div", { className: "console-suggestions", children: commands.slice(0, 6).map((command) => (_jsx("button", { type: "button", className: "ask-suggestion", disabled: state.running, onClick: () => void runLocally(command.command), title: command.command, children: command.label }, command.command))) })) : null, state.error ? _jsx("div", { className: "console-error", children: state.error }) : null, _jsx("pre", { className: "console-out", ref: out, children: state.output || (state.running ? '' : 'Nothing has run yet.') })] }));
}
// ---------------------------------------------------------------------------
// Run it on Colab: the plan, run in the reader's own runtime from the page,
// with the machine watched while it does
// ---------------------------------------------------------------------------
const PANEL_KEY = 'reader.implement.colab-panel';
const bar = (needed, have) => {
    if (needed === undefined || !have)
        return 0;
    return Math.min(100, Math.round((needed / have) * 100));
};
/**
 * Under the compute budget: which of Colab's machines the plan fits on, what
 * it needs against what the machine has (measured, once a runtime is
 * connected), the steps to run in order — each a cell the kernel takes
 * exactly as shown — and the GPU, CPU, memory and disk as they run.
 */
export function ColabRunPanel({ compute, hardware }) {
    const plan = useContext(PlanContext);
    const colab = useColab();
    const { settings } = useStore();
    const [open, setOpen] = useState(() => {
        try {
            return localStorage.getItem(PANEL_KEY) !== 'closed';
        }
        catch {
            return true;
        }
    });
    const [confirmAll, setConfirmAll] = useState(false);
    const [card, setCard] = useState(false);
    const [showing, setShowing] = useState(null);
    const toggle = () => {
        setOpen(!open);
        try {
            localStorage.setItem(PANEL_KEY, open ? 'closed' : 'open');
        }
        catch {
            // private mode
        }
    };
    const choices = useMemo(() => colabChoices(compute, hardware), [compute, hardware]);
    const steps = useMemo(() => (plan ? colabSteps(plan.sections) : []), [plan]);
    // The machine: the runtime's while there is one, else the picker's when it is Colab's, else what the first-run card would start.
    const connected = colab.status === 'idle' || colab.status === 'busy';
    const accelerator = connected && colab.runtime ? (colab.runtime.accelerator ?? 'NONE') : (colabMachineOf(hardware)?.accelerator ?? colab.machine.accelerator);
    const choice = choices.find((c) => c.machine.accelerator === accelerator) ?? choices[0];
    const measured = connected && colab.specs && colab.runtime?.accelerator === (accelerator === 'NONE' ? null : accelerator) ? colab.specs : undefined;
    const needs = useMemo(() => needsOn(compute, choice, measured), [compute, choice, measured]);
    const available = colabAvailable(settings.googleClientId);
    const pick = (next) => {
        setMachine({ ...colab.machine, accelerator: next });
        setHardware(normaliseHardware({ ...hardware, gpu: colabMachine(next).gpu, count: 1 }));
    };
    const connectIt = () => {
        if (colab.status === 'off' && !colabGranted()) {
            setCard(true);
            return;
        }
        void connectColab({ ...colab.machine, accelerator }).catch(() => undefined);
    };
    const runStep = (step) => {
        if (colab.status === 'off' && !colabGranted()) {
            setCard(true);
            return;
        }
        void runCell(cellKey(step.code), step.code).catch(() => undefined);
    };
    const runs = steps.map((step) => colab.runs[cellKey(step.code)]);
    const done = runs.filter((run) => run?.state === 'ran').length;
    // The chart: the step running now, else the last one that ran with the machine watched.
    const charted = runs.filter((run) => run && run.samples && run.samples.length >= 2).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    const sample = colab.sample;
    const specs = colab.specs;
    return (_jsxs("figure", { className: `impl-colab${open ? ' is-open' : ''}`, id: "run-on-colab", children: [_jsxs("header", { children: [_jsx("span", { className: "cell-index", children: _jsx(ColabMark, {}) }), _jsxs("span", { className: "cell-title", children: ["Run it on Colab", connected && colab.runtime ? _jsxs("span", { className: "colab-title-note", children: [" \u00B7 connected to ", choice.machine.label.split(' · ')[0]] }) : null] }), _jsx(KeepButton, { selector: ".impl-colab", what: "panel" }), _jsx("button", { type: "button", className: "btn sm ghost colab-panel-toggle", "aria-expanded": open, onClick: toggle, children: open ? 'Hide' : 'Show' })] }), open ? (_jsxs(_Fragment, { children: [_jsxs("p", { className: "colab-lede", children: ["The plan, run in a Colab runtime of your own, from here: pick the machine, and the steps below run in order \u2014 each on its click, exactly as shown \u2014 with the GPU and the CPU watched while they do.", !available ? _jsx("b", { children: " Running cells needs a Google client ID and the reader's proxy (Settings \u2192 Google, Settings \u2192 Paper proxy)." }) : null] }), _jsx("div", { className: "colab-part-label", children: "The machine" }), _jsx("div", { className: "colab-machines", role: "radiogroup", "aria-label": "Colab machine", children: choices.map((c) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": c.machine.accelerator === accelerator, className: `colab-machine${c.machine.accelerator === accelerator ? ' is-on' : ''}${c.recommended ? ' is-best' : ''}`, disabled: connected, title: connected ? 'Change machine from the runtime menu in the bar: a new runtime is started' : `Plan and run on a ${c.machine.label}`, onClick: () => pick(c.machine.accelerator), children: [_jsxs("span", { className: "machine-head", children: [_jsx("b", { children: c.machine.label }), c.recommended ? _jsx("span", { className: "machine-best", children: "Smallest that fits" }) : null] }), _jsx("small", { children: c.machine.tier }), _jsxs("span", { className: "machine-est", children: [_jsx("span", { children: hoursText(c.est.hours) }), _jsx("span", { children: usdText(c.est.usd) }), c.est.sessions !== undefined && c.est.sessions > 1 ? _jsxs("span", { children: [c.est.sessions, " sessions"] }) : null] }), _jsx(FitChip, { fit: c.est.fit })] }, c.machine.accelerator))) }), _jsxs("div", { className: "colab-part-label", children: ["What it needs, and what the ", choice.machine.label.split(' · ')[0], " has", measured ? ' — measured' : ''] }), _jsx("div", { className: "colab-needs", children: needs.map((need) => (_jsxs("div", { className: `need-row fit-${need.fit}`, children: [_jsx("span", { className: "need-label", children: need.label }), _jsx("span", { className: "need-bar", "aria-hidden": "true", children: _jsx("span", { className: `need-fill${need.fit === 'no' ? ' is-over' : need.fit === 'tight' ? ' is-tight' : ''}`, style: { width: `${need.id === 'time' ? Math.min(100, (need.needed ?? 1) * 25) : bar(need.needed, need.have)}%` } }) }), _jsx("span", { className: "need-numbers", children: need.id === 'time' ? (_jsx("b", { children: need.needed })) : need.needed !== undefined ? (_jsxs(_Fragment, { children: [_jsxs("b", { children: [need.needed, " ", need.unit] }), " needed \u00B7 ", need.have ? `${need.have} ${need.unit}` : 'none', need.measured ? _jsx("span", { className: "need-measured", children: "measured" }) : null] })) : (_jsxs(_Fragment, { children: ["not said \u00B7 ", need.have ? `${need.have} ${need.unit}` : 'none'] })) }), need.id === 'time' ? _jsx("span", { className: `fit-chip fit-${need.fit}`, children: (need.needed ?? 1) > 1 ? 'Checkpoint between them' : 'One session' }) : _jsx(FitChip, { fit: need.fit }), _jsx("span", { className: "need-note", children: need.note })] }, need.id))) }), _jsxs("div", { className: "colab-part-label", children: [_jsxs("span", { children: ["How to run it, in order", steps.length ? ` · ${done} of ${steps.length} ${done === 1 ? 'has' : 'have'} run` : ''] }), steps.length > 1 && connected ? (confirmAll ? (_jsxs("span", { className: "colab-run-all", children: ["Run all ", steps.length, " steps, top to bottom? It stops at the first that fails.", _jsx("button", { type: "button", className: "btn sm primary", onClick: () => {
                                            setConfirmAll(false);
                                            void runAll(steps.map((step) => ({ key: cellKey(step.code), code: step.code })));
                                        }, children: "Run all" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setConfirmAll(false), children: "Not now" })] })) : (_jsx("button", { type: "button", className: "btn sm ghost", disabled: colab.status === 'busy', onClick: () => setConfirmAll(true), children: "Run all steps" }))) : null] }), _jsxs("ol", { className: "colab-steps", children: [_jsxs("li", { className: `colab-step is-connect${connected ? ' is-done' : ''}`, children: [_jsx("span", { className: "step-number", children: connected ? '✓' : '1' }), _jsxs("div", { className: "step-body", children: [_jsx("b", { children: connected ? `Connected to your ${choice.machine.label.split(' · ')[0]} runtime` : `Connect a ${choice.machine.label.split(' · ')[0]} runtime` }), _jsx("span", { className: "step-note", children: connected
                                                    ? specs
                                                        ? [specs.gpuName ? `${specs.gpuName} · ${specs.vramMb ? gigabytes(specs.vramMb) : ''}` : 'no GPU', specs.cpus ? `${specs.cpus} CPUs` : '', specs.ramTotalMb ? `${gigabytes(specs.ramTotalMb)} RAM` : '', specs.diskFreeGb !== undefined ? `${specs.diskFreeGb} GB disk free` : ''].filter(Boolean).join(' · ')
                                                        : colab.gpuWatch
                                                            ? 'Reading what the machine is…'
                                                            : 'The machine watch is off (runtime menu), so nothing is measured'
                                                    : colab.status === 'connecting'
                                                        ? 'Google’s window, then the runtime, then the kernel — about fifteen seconds the first time'
                                                        : 'Starts a runtime in your own Colab account, on your tier; the first time, a card says what will happen before anything does' })] }), _jsxs("div", { className: "step-actions", children: [connected ? (_jsx("button", { type: "button", className: "btn sm ghost", disabled: colab.status === 'busy' || !colab.gpuWatch, onClick: () => void probeMachine(), title: "Read the machine again: its use now, and the disk free", children: "Measure again" })) : (_jsxs("button", { type: "button", className: `btn sm colab${available ? ' is-go' : ''}`, disabled: !available || colab.status === 'connecting', onClick: connectIt, children: [_jsx(ColabMark, {}), colab.status === 'connecting' ? 'Connecting…' : colab.status === 'lost' ? '▶ Start a new runtime' : '▶ Connect'] })), card ? (_jsx(ConnectCard, { busy: colab.status === 'connecting', onClose: () => setCard(false), onConnect: (machine) => {
                                                    void connectColab(machine)
                                                        .then(() => setCard(false))
                                                        .catch(() => undefined);
                                                } })) : null] })] }), steps.map((step, index) => {
                                const key = cellKey(step.code);
                                const run = colab.runs[key];
                                const live = run?.state === 'running' || run?.state === 'queued';
                                return (_jsxs("li", { className: `colab-step is-${step.kind}${run ? ` has-run is-${run.state}` : ''}`, children: [_jsx("span", { className: "step-number", children: run?.state === 'ran' ? '✓' : live ? _jsx("span", { className: "spinner" }) : index + 2 }), _jsxs("div", { className: "step-body", children: [_jsx("b", { children: step.title }), _jsxs("span", { className: "step-note", children: [step.note, ' · ', _jsx("button", { type: "button", className: "link", onClick: () => setShowing(showing === key ? null : key), children: showing === key ? 'Hide the cell' : 'Show the cell' })] }), run ? _jsx(RunState, { run: run }) : null] }), _jsx("div", { className: "step-actions", children: _jsxs("button", { type: "button", className: `btn sm colab${connected && !run ? ' is-go' : ''}`, disabled: !available || colab.status === 'connecting' || Boolean(colab.running), onClick: () => runStep(step), title: connected ? 'Run exactly this cell in your runtime' : 'Connects first, then runs this cell', children: [_jsx(ColabMark, {}), run ? '▶ Run again' : '▶ Run'] }) }), showing === key ? (_jsx("pre", { className: "cell-code step-code", children: _jsx("code", { dangerouslySetInnerHTML: { __html: step.kind === 'python' || step.kind === 'scaffold' ? highlightPython(step.code) : esc(step.code) } }) })) : null, run ? (_jsx("div", { className: "step-output", children: _jsx(CellRunOutput, { run: run, onForget: () => undefined }) })) : null] }, key));
                            }), !steps.length ? _jsx("li", { className: "colab-step is-empty", children: "No cells on the plan yet \u2014 the steps come from its shell cells, its Makefile and its Python cells." }) : null] }), _jsx("div", { className: "colab-part-label", children: "The machine, as it runs" }), _jsxs("div", { className: `colab-live${connected ? ' is-on' : ''}`, children: [_jsxs("div", { className: "live-tiles", children: [_jsxs("div", { className: "live-tile", children: [_jsx("span", { className: "k", children: "GPU" }), _jsx("b", { children: sample?.gpu ? `${sample.gpu.util}%` : specs?.gpuName ? '—' : accelerator === 'NONE' ? 'none' : '—' }), _jsx("small", { children: specs?.gpuName ?? (accelerator === 'NONE' ? 'CPU runtime' : choice.machine.label.split(' · ')[0]) })] }), _jsxs("div", { className: "live-tile", children: [_jsx("span", { className: "k", children: "VRAM" }), _jsx("b", { children: sample?.gpu ? gigabytes(sample.gpu.memUsedMb) : '—' }), _jsxs("small", { children: ["of ", specs?.vramMb ? gigabytes(specs.vramMb) : accelerator === 'NONE' ? 'none' : `${gpuById(choice.machine.gpu).vramGb} GB`] })] }), _jsxs("div", { className: "live-tile", children: [_jsx("span", { className: "k", children: "CPU" }), _jsx("b", { children: sample?.cpu !== undefined ? `${sample.cpu}%` : '—' }), _jsx("small", { children: specs?.cpus ? `${specs.cpus} cores` : 'not measured yet' })] }), _jsxs("div", { className: "live-tile", children: [_jsx("span", { className: "k", children: "RAM" }), _jsx("b", { children: sample?.ramUsedMb !== undefined ? gigabytes(sample.ramUsedMb) : '—' }), _jsxs("small", { children: ["of ", specs?.ramTotalMb ? gigabytes(specs.ramTotalMb) : `about ${choice.machine.ramGb} GB`] })] }), _jsxs("div", { className: "live-tile", children: [_jsx("span", { className: "k", children: "Disk free" }), _jsx("b", { children: sample?.diskFreeGb !== undefined ? `${sample.diskFreeGb} GB` : specs?.diskFreeGb !== undefined ? `${specs.diskFreeGb} GB` : '—' }), _jsxs("small", { children: ["of ", specs?.diskTotalGb !== undefined ? `${specs.diskTotalGb} GB` : `about ${choice.machine.diskGb} GB`] })] })] }), charted?.samples ? (_jsx(MachineChart, { samples: charted.samples, live: charted.state === 'running' })) : (_jsx("div", { className: "live-empty", children: connected
                                    ? colab.gpuWatch
                                        ? 'Run a step and its use is drawn here, every two seconds, as the loss curve is under a training cell.'
                                        : 'Turn on “Watch the machine while cells run” in the runtime menu and its use is drawn here as steps run.'
                                    : 'Connect a runtime and the tiles fill with what it is; run a step and its use is drawn here as it runs.' })), _jsxs("div", { className: "live-note", children: ["Read by a few lines of the reader's own \u2014 ", _jsx("code", { children: "nvidia-smi" }), ", the CPU and memory counters (", _jsx("code", { children: "/proc" }), " on Linux, the system's own on a Mac or Windows PC), the disk \u2014 in a second kernel, every two seconds while a step runs and once as the runtime connects. Shown in the runtime menu; nothing runs unseen."] })] })] })) : null] }));
}
