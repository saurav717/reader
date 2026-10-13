import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Google Colab on the Explain and Implementation pages: the chip in the bar
// that says what is running and opens to the runtime's menu, the card the
// first Run opens to say what will happen before anything does, and what a
// cell that has run shows under its code. The store, the runtime and the
// kernel are src/lib/colab.ts; the rules they keep are in docs/colab-run.md.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { backendLabel, colabAvailable, colabNow, compareOutput, connect, differingLines, disconnect, MACHINES, machineLabel, outputText, restartKernel, runAll, setGpuWatch, setMachine, stopRuntime, subscribeColab } from '../lib/colab';
import { useStore } from '../lib/store';
import { gigabytes, hasCurve, lossSeries, MACHINE_PROBE } from '../lib/telemetry';
import { LossChart } from './Charts';
import CopyBlock from './CopyBlock';
export const useColab = () => useSyncExternalStore(subscribeColab, colabNow);
/** The Colab mark: the two rings, as the page draws them everywhere Colab is named. */
export const ColabMark = () => (_jsx("span", { className: "colab-mark", "aria-hidden": "true", children: "co" }));
const clock = (since, now) => {
    if (!since)
        return '';
    const s = Math.max(0, Math.round((now - since) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
/** The chip while a cell runs: the machine's use from the last sample, or just that it runs. */
const busyText = (sample) => {
    if (!sample)
        return 'running';
    const parts = [sample.gpu ? `GPU ${sample.gpu.util}%` : '', sample.cpu !== undefined ? `CPU ${sample.cpu}%` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'running';
};
/** The runtime's machine in a line: the card, the CPUs, the memory, the disk — what the probe read. */
export function specsText(specs) {
    if (!specs)
        return '';
    return [
        specs.gpuName ? `${specs.gpuName}${specs.vramMb ? ` · ${gigabytes(specs.vramMb)}` : ''}` : '',
        specs.cpus ? `${specs.cpus} CPU${specs.cpus === 1 ? '' : 's'}` : '',
        specs.ramTotalMb ? `${gigabytes(specs.ramTotalMb)} RAM` : '',
        specs.diskFreeGb !== undefined ? `${specs.diskFreeGb} GB disk free` : '',
    ]
        .filter(Boolean)
        .join(' · ');
}
/** Colab's own page attached to this runtime, as the CLI's `colab url` builds it: the backend named twice, the way Colab's frontend looks for it. */
export const attachUrl = (endpoint) => {
    const host = 'https://colab.research.google.com';
    const path = `/tun/m/${endpoint}`;
    return `${host}/notebooks/empty.ipynb?dbu=${encodeURIComponent(path)}#datalabBackendUrl=${host}${path}`;
};
function useAway(open, close, box) {
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!box.current?.contains(event.target))
                close();
        };
        const key = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
            }
        };
        window.addEventListener('mousedown', away);
        window.addEventListener('keydown', key, true);
        return () => {
            window.removeEventListener('mousedown', away);
            window.removeEventListener('keydown', key, true);
        };
    }, [open, close, box]);
}
/** The machines, as buttons; the one chosen is kept for next time. */
export function MachinePicker({ machine, onPick, disabled }) {
    return (_jsx("div", { className: "colab-pick", role: "radiogroup", "aria-label": "Machine", children: MACHINES.map((option) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": machine.accelerator === option.accelerator, className: `colab-opt${machine.accelerator === option.accelerator ? ' is-on' : ''}`, disabled: disabled, onClick: () => onPick({ ...machine, accelerator: option.accelerator }), children: [_jsx("b", { children: option.label }), _jsx("small", { children: option.note })] }, option.accelerator))) }));
}
/**
 * What the first Run says before anything happens: that a runtime starts in
 * the person's own Colab, on which machine, that Google will ask once for
 * Colab, and what the reader can and cannot do with it.
 */
export function ConnectCard({ cellLabel, onConnect, onClose, busy, playground, initial, footer, }) {
    const colab = useColab();
    const { settings } = useStore();
    const [machine, pick] = useState(initial ?? colab.machine);
    const box = useRef(null);
    useAway(true, onClose, box);
    const available = colabAvailable(settings.googleClientId);
    return (_jsxs("div", { className: "menu right colab-menu colab-connect", role: "dialog", "aria-label": "Run in Google Colab", ref: box, children: [_jsx("div", { className: "menu-label", children: playground ? (_jsxs(_Fragment, { children: [_jsx("b", { children: "Run this playground in your Google Colab." }), " Connecting starts a runtime in your own Colab account \u2014 the same one colab.research.google.com uses \u2014 and the notebook\u2019s cells and the console\u2019s commands run in it."] })) : (_jsxs(_Fragment, { children: [_jsxs("b", { children: ["Run ", cellLabel ? `${cellLabel} ` : 'this cell ', "in your Google Colab."] }), " The first run starts a runtime in your own Colab account \u2014 the same one colab.research.google.com uses \u2014 and every cell on this page can then run in it with one click."] })) }), _jsx(MachinePicker, { machine: machine, onPick: pick, disabled: busy }), _jsxs("div", { className: "colab-google", children: [_jsx("span", { className: "colab-g", "aria-hidden": "true" }), _jsxs("div", { children: ["Google will ask once for ", _jsx("b", { children: "Colab" }), " access", settings.googleClientId ? ' on top of the sign-in you have given' : '', " (", _jsx("code", { children: "auth/colaboratory" }), "). It is kept the way the Drive token is: in this tab, for an hour, never on disk."] })] }), _jsxs("div", { className: "colab-can", children: [_jsxs("div", { children: [_jsx("b", { children: "The reader can" }), _jsxs("ul", { children: [_jsx("li", { children: playground ? 'run the cells and commands you run here' : 'run the cells on this page you click' }), _jsx("li", { children: "show what they print here \u2014 and loss curves, when a cell prints losses" }), _jsxs("li", { children: ["read the machine's use while a cell runs \u2014 ", machine.accelerator !== 'NONE' ? 'GPU, ' : '', "CPU, memory, disk \u2014 with a few lines of its own, every two seconds"] })] })] }), _jsxs("div", { children: [_jsx("b", { children: "It cannot" }), _jsxs("ul", { children: [_jsx("li", { children: "run anything without a click" }), _jsx("li", { children: "mount your Drive or read your notebooks" }), _jsx("li", { children: "start more than one runtime" })] })] })] }), _jsx("hr", {}), available ? (_jsxs("button", { type: "button", className: "colab-action is-primary", disabled: busy, onClick: () => onConnect(machine), children: [_jsx("b", { children: busy ? 'Connecting…' : playground ? `Connect · ${machineLabel(machine)}` : `Connect and run${cellLabel ? ` ${cellLabel}` : ''}` }), _jsxs("span", { children: ["Opens Google's window and starts the ", machineLabel(machine), " runtime", playground ? '' : ', runs the cell', ". About fifteen seconds the first time."] })] })) : (_jsxs("div", { className: "colab-status", children: [_jsx("b", { children: "Not available here." }), " ", settings.googleClientId ? 'Running cells needs the reader’s proxy (Settings → Paper proxy), which makes the calls to Colab that a page cannot.' : 'Give Settings → Google a client ID first: the runtime is started as you.'] })), playground ? null : (_jsxs("div", { className: "colab-hint", children: [_jsx(ColabMark, {}), "The code was written by a model, from the paper. Read it before you run it: it runs as you, on your Colab quota. ", _jsx("b", { children: "Colab \u2192 Download the notebook" }), " in the bar is the same cells for Colab's own page instead."] })), footer] }));
}
/**
 * The chip in the bar: the Colab mark, a dot for the state, the machine and
 * how long it has been up. It opens to the runtime's menu — what it is,
 * what it costs, what has run — and to starting one when there is none.
 */
export function ColabChip({ cells }) {
    const colab = useColab();
    const { settings, user } = useStore();
    const [open, setOpen] = useState(false);
    const [changing, setChanging] = useState(false);
    const [probe, setProbe] = useState(false);
    const [now, setNow] = useState(Date.now());
    const box = useRef(null);
    const close = () => {
        setOpen(false);
        setChanging(false);
    };
    useAway(open, close, box);
    useEffect(() => {
        if (!colab.startedAt)
            return;
        const tick = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(tick);
    }, [colab.startedAt]);
    const available = colabAvailable(settings.googleClientId);
    if (!available && colab.status === 'off')
        return null;
    const connected = colab.status === 'idle' || colab.status === 'busy';
    const ran = cells.filter((cell) => colab.runs[cell.key]?.state === 'ran').length;
    const dot = colab.status === 'busy' ? 'busy' : colab.status === 'connecting' ? 'busy' : connected ? 'on' : colab.status === 'lost' || colab.status === 'error' ? 'lost' : 'off';
    const text = colab.status === 'connecting'
        ? 'Colab · connecting…'
        : connected && colab.runtime
            ? `${colab.backend.kind === 'jupyter' ? colab.backend.server.name : machineLabel(colab.runtime)} · ${colab.reconnecting ? 'reconnecting…' : colab.status === 'busy' ? busyText(colab.sample) : 'idle'} · ${clock(colab.startedAt, now)}`
            : colab.status === 'lost'
                ? `${colab.runtime ? backendLabel(colab.backend, colab.runtime) : 'Colab'} · runtime ended`
                : colab.status === 'error'
                    ? 'Colab · not connected'
                    : 'Colab · no runtime';
    return (_jsxs("div", { className: "menu-wrap", ref: box, children: [_jsxs("button", { type: "button", className: `colab-chip is-${dot}`, "aria-haspopup": "menu", "aria-expanded": open, onClick: () => setOpen(!open), title: colab.error || 'Your Colab runtime: the cells on this page run in it', children: [_jsx(ColabMark, {}), _jsx("span", { className: `colab-dot is-${dot}`, "aria-hidden": "true" }), text] }), open ? (connected || colab.status === 'busy' ? (_jsxs("div", { className: "menu right colab-menu colab-runtime", role: "menu", "aria-label": "Your Colab runtime", children: [_jsxs("div", { className: "menu-label", children: [_jsx("b", { children: "Your Colab runtime" }), " \u00B7 started from this page", user?.email ? `, as ${user.email}` : ''] }), _jsxs("div", { className: "colab-stats", children: [_jsxs("div", { children: [_jsx("span", { className: "k", children: "Machine" }), _jsx("span", { className: "v", children: colab.runtime ? backendLabel(colab.backend, colab.runtime) : '—' })] }), _jsxs("div", { children: [_jsx("span", { className: "k", children: "Up for" }), _jsx("span", { className: "v", children: clock(colab.startedAt, now) || '—' })] }), _jsxs("div", { children: [_jsx("span", { className: "k", children: "Compute units" }), _jsxs("span", { className: "v", children: [colab.units?.balance !== undefined ? colab.units.balance.toFixed(1) : colab.runtime?.accelerator ? 'your tier’s' : '0', colab.units?.ratePerHour ? _jsxs("small", { children: [" \u00B7 ", colab.units.ratePerHour.toFixed(2), "/h"] }) : !colab.runtime?.accelerator ? _jsx("small", { children: " \u00B7 free" }) : null] })] })] }), colab.specs ? (_jsxs("div", { className: "colab-specs", title: "Read off the machine by the probe below, as the runtime connected", children: [colab.specs.gpuName ? (_jsxs("span", { children: [_jsx("b", { children: colab.specs.gpuName }), colab.specs.vramMb ? ` · ${gigabytes(colab.specs.vramMb)}` : ''] })) : (_jsx("span", { children: _jsx("b", { children: "No GPU" }) })), colab.specs.cpus ? _jsxs("span", { children: [colab.specs.cpus, " CPUs"] }) : null, colab.specs.ramTotalMb ? _jsxs("span", { children: [gigabytes(colab.specs.ramTotalMb), " RAM"] }) : null, colab.specs.diskFreeGb !== undefined ? _jsxs("span", { children: [colab.specs.diskFreeGb, " GB disk free"] }) : null, colab.sample?.cpu !== undefined && colab.status === 'idle' ? _jsxs("span", { className: "colab-specs-now", children: ["CPU ", colab.sample.cpu, "% now"] }) : null] })) : null, _jsxs("div", { className: "colab-hint", children: [cells.length, " ", cells.length === 1 ? 'cell' : 'cells', " on this page \u00B7 ", ran, " ", ran === 1 ? 'has' : 'have', " run \u00B7 variables are kept between runs, so a later cell sees an earlier one's", colab.via === 'proxy' ? ' · the kernel’s socket is carried by the proxy, since the runtime would not take this page’s own' : ''] }), _jsxs("label", { className: "colab-switch", children: [_jsx("input", { type: "checkbox", checked: colab.gpuWatch, onChange: (event) => setGpuWatch(event.target.checked) }), _jsxs("span", { children: [_jsx("b", { children: "Watch the machine while cells run" }), _jsxs("small", { children: ["A few lines of the reader's own, in a second kernel, every two seconds: ", colab.runtime?.accelerator ? _jsx("code", { children: "nvidia-smi" }) : null, colab.runtime?.accelerator ? ', ' : '', "the CPU and memory counters (", _jsx("code", { children: "/proc" }), " on Linux, the kernel's own on a Mac or Windows PC) and the disk. Drawn in the Runtime pane as GPU and CPU use, VRAM and RAM \u2014 not under the cells.", ' ', _jsx("button", { type: "button", className: "link", onClick: () => setProbe(!probe), children: probe ? 'Hide the probe' : 'Show the probe' })] })] })] }), probe ? _jsx(CopyBlock, { className: "colab-probe", code: MACHINE_PROBE }) : null, _jsx("hr", {}), _jsxs("button", { type: "button", role: "menuitem", className: "colab-action", disabled: colab.status === 'busy' || !cells.length, onClick: () => {
                            close();
                            void runAll(cells);
                        }, children: [_jsxs("b", { children: ["Run all ", cells.length, " ", cells.length === 1 ? 'cell' : 'cells', ", top to bottom"] }), _jsx("span", { children: "At once; stops at the first error" })] }), colab.runtime && colab.backend.kind === 'colab' ? (_jsxs("a", { className: "colab-action", role: "menuitem", href: attachUrl(colab.runtime.endpoint), target: "_blank", rel: "noreferrer noopener", children: [_jsx("b", { children: "Open this runtime in Colab \u2197" }), _jsx("span", { children: "Colab's own notebook page on the same machine \u2014 for editing, plots, a terminal, or Drive, on purpose" })] })) : null, _jsxs("button", { type: "button", role: "menuitem", className: "colab-action", disabled: colab.status === 'busy', onClick: () => {
                            close();
                            void restartKernel();
                        }, children: [_jsx("b", { children: "Restart the kernel" }), _jsx("span", { children: "Forgets every variable; keeps the machine and the files on it" })] }), changing ? (_jsxs("div", { className: "colab-status", children: ["A new runtime on another machine; this one is stopped.", _jsx(MachinePicker, { machine: colab.machine, onPick: (machine) => {
                                    setMachine(machine);
                                    close();
                                    void stopRuntime().then(() => connect(machine));
                                } })] })) : (_jsxs("button", { type: "button", role: "menuitem", className: "colab-action", disabled: colab.status === 'busy', onClick: () => setChanging(true), children: [_jsx("b", { children: "Change machine\u2026" }), _jsx("span", { children: "CPU, T4, L4, A100 \u2014 a new runtime; this one is stopped" })] })), _jsx("hr", {}), _jsxs("button", { type: "button", role: "menuitem", className: "colab-action is-danger", onClick: () => {
                            close();
                            void stopRuntime();
                        }, children: [_jsx("b", { children: "Stop the runtime" }), _jsx("span", { children: "Releases the machine now. Colab stops an idle one itself after a while." })] }), _jsxs("button", { type: "button", role: "menuitem", className: "colab-action", onClick: () => {
                            close();
                            disconnect();
                        }, children: [_jsx("b", { children: "Forget Colab in this tab" }), _jsx("span", { children: "Drops the connection and the token here. The permission itself is removed at myaccount.google.com/permissions." })] })] })) : (_jsx(ConnectCard, { busy: colab.status === 'connecting', onClose: close, onConnect: (machine) => {
                    close();
                    void connect(machine).catch(() => undefined);
                } }))) : null] }));
}
/** A line under the bar while the runtime is gone or the last thing failed, with the way back. */
export function ColabBanner() {
    const colab = useColab();
    const [hidden, setHidden] = useState();
    if (!colab.error || hidden === colab.error || colab.status === 'connecting')
        return null;
    return (_jsxs("div", { className: `colab-banner is-${colab.status}`, role: "status", children: [_jsx(ColabMark, {}), _jsx("span", { className: "colab-banner-text", children: colab.error }), colab.status === 'lost' || colab.status === 'error' || colab.status === 'off' ? (_jsx("button", { type: "button", className: "btn sm", onClick: () => void connect(colab.machine).catch(() => undefined), children: colab.status === 'lost' ? `Start a new ${machineLabel(colab.machine)} runtime` : 'Try again' })) : null, _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setHidden(colab.error), children: "Dismiss" })] }));
}
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const seconds = (ms) => (ms === undefined ? '' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
/** What the header of a cell that has run, or is running, says about it. */
export function RunState({ run }) {
    if (run.state === 'queued')
        return _jsx("span", { className: "cell-state is-queued", children: "\u25CC Queued \u2014 runs after the cells before it" });
    if (run.state === 'running') {
        return (_jsxs("span", { className: "cell-state is-busy", children: [_jsx("span", { className: "spinner" }), " Running on ", run.where.replace(/^Colab · /, '')] }));
    }
    const label = run.state === 'ran' ? `✓ Ran in ${seconds(run.ms)}` : run.state === 'failed' ? `✕ Failed after ${seconds(run.ms)}` : '■ Stopped';
    return _jsx("span", { className: `cell-state is-${run.state}`, children: label });
}
function OutputView({ output, marked, offset }) {
    if (output.type === 'image')
        return _jsx("img", { className: "cell-image", alt: "A figure the cell drew", src: `data:${output.mime};base64,${output.data}` });
    if (output.type === 'error')
        return _jsx("pre", { className: "cell-error", children: output.traceback || `${output.ename}: ${output.evalue}` });
    const lines = output.text.replace(/\n$/, '').split('\n');
    return (_jsx("pre", { className: output.type === 'stream' && output.name === 'stderr' ? 'is-stderr' : undefined, children: lines.map((line, index) => (_jsxs("span", { className: marked.has(offset + index) ? 'is-diff' : undefined, children: [line, index < lines.length - 1 ? '\n' : ''] }, index))) }));
}
/**
 * Under a cell that has run: what it printed, where and when, how it
 * compares with what Claude wrote as the expected output, and the two
 * things to do about a difference — ask, or see the expectation.
 */
/**
 * What a cell printed when it ran, with the verdict against the expected
 * output the page's writer gave it. `asker` names the model the ask bar
 * answers with — whoever wrote the page — and `writer` the one that wrote
 * the expected output; both default to Claude, as the pages once always were.
 */
export function CellRunOutput({ run, expected, onAsk, onForget, asker = 'Claude', writer = 'Claude' }) {
    const [showExpected, setShowExpected] = useState(false);
    const live = run.state === 'running' || run.state === 'queued';
    const verdict = live ? 'none' : compareOutput(expected, run.outputs);
    const actual = outputText(run.outputs);
    const marked = verdict === 'differs' ? differingLines(expected, actual) : new Set();
    const failed = run.outputs.some((output) => output.type === 'error');
    // A training loop that prints its losses earns a curve. The machine's use while it ran is the Runtime pane's, not the cell's: under every cell it was only in the way.
    const losses = useMemo(() => lossSeries(actual), [actual]);
    const curve = hasCurve(losses);
    // Line offsets so the tint lands on the right line across several stream outputs.
    const offsets = [];
    let count = 0;
    for (const output of run.outputs) {
        offsets.push(count);
        if (output.type === 'stream' || output.type === 'text')
            count += output.text.replace(/\n$/, '').split('\n').length;
    }
    return (_jsxs("div", { className: `cell-output is-run${live ? ' is-live' : ''}${run.stale ? ' is-stale' : ''}`, children: [_jsxs("div", { className: "cell-output-label", children: [live ? _jsx("span", { className: "spinner" }) : null, _jsx("span", { children: live ? 'Output · streaming from Colab' : `Output · ${run.where} · ${time(run.startedAt)}${run.stale ? ' · that runtime has ended' : ''}` }), _jsx("span", { className: "spacer" }), !live ? (failed ? (_jsx("span", { className: "cell-verdict is-bad", children: "\u2715 Error" })) : verdict === 'match' ? (_jsxs("span", { className: "cell-verdict is-ok", children: ["\u2713 Matches what ", writer, " expected"] })) : verdict === 'differs' ? (_jsxs("span", { className: "cell-verdict is-diff", children: ["\u25D0 Differs from what ", writer, " expected"] })) : null) : null] }), run.outputs.length ? run.outputs.map((output, index) => _jsx(OutputView, { output: output, marked: marked, offset: offsets[index] }, index)) : !live ? _jsx("pre", { className: "is-empty", children: "(nothing printed)" }) : null, live && run.outputs.length ? _jsx("span", { className: "caret", "aria-hidden": "true" }) : null, curve ? _jsx(LossChart, { series: losses, live: live }) : null, !live ? (_jsxs("div", { className: "cell-actions", children: [onAsk && failed ? (_jsxs("button", { type: "button", className: "btn sm", onClick: () => onAsk(`This cell fails when run in Colab. The traceback:\n\n\`\`\`\n${actual.slice(0, 4000)}\n\`\`\`\n\nFix the cell so it runs, keep it short, and keep its expected output and explanation in step with the fix.`), children: ["Ask ", asker, " to fix this cell"] })) : onAsk && verdict === 'differs' ? (_jsxs("button", { type: "button", className: "btn sm", onClick: () => onAsk(`This cell was run in Colab and printed something other than the expected output you wrote. What it printed:\n\n\`\`\`\n${actual.slice(0, 4000)}\n\`\`\`\n\nExplain the difference in a sentence or two where the cell is, and if your expected output was wrong, correct it to what the code prints.`), children: ["Ask ", asker, " why it differs"] })) : null, expected ? (_jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setShowExpected(!showExpected), children: showExpected ? `Hide what ${writer} expected` : `Show what ${writer} expected` })) : null, _jsx("button", { type: "button", className: "btn sm ghost", onClick: onForget, title: "Put the expected output back, as if the cell had not run", children: "Clear" })] })) : null, showExpected && expected ? (_jsxs("div", { className: "cell-expected", children: [_jsx("div", { className: "cell-output-label", children: "Expected output \u00B7 written by Claude" }), _jsx("pre", { children: expected })] })) : null] }));
}
