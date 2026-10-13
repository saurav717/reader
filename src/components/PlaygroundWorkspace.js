import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// One playground, at /playground/<id>: its notebook, or its files with an
// editor and a console, on the machine it is bound to. The bar says where
// the kernel is and opens the machine's menu; the pane on the right is the
// sync (when the files live somewhere other than the machine), the runtime's
// meters and the metrics the runs print — the same panes the paper's
// notebook has. The store is src/lib/playground.ts.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { backendLabel, shutDownScope, chooseBackend, colabAvailable, colabNow, connect, forgetRun, interrupt, lastActivityAt, machineLabel, restartKernel, runCell, runQuietly, setMachine, stopRuntime } from '../lib/colab';
import { notebookFor, runKey, subscribeNotebook } from '../lib/notebook';
import { OPEN_PLAYGROUND, backendOfPlayground, blankCells, filesAreOnMachine, homeHost, pullEdits, homeLabelOf, moveFilesOutOfBrowser, useDriveConnected, machineHost, machineRoot, markFolder, notebookKey, pullBack, pushFolder, secureCompanions, serverById, shellCell, takeSeed, updatePlayground, useServers, vscodeLink } from '../lib/playground';
import { COMPANION_VERSION, STARTABLE, companionPort, companionTools, findCompanion, isNewer, isSecure, shutdownCompanion, startCompanion, updateCompanion, vscodeFolder, vscodeWeb, waitForVersion } from '../lib/companion';
import { AGENT_KEYS, AGENTS, agentCommand, saveAgentOptions, savedAgentOptions } from '../lib/agents';
import { ASSUMED_TOOLS, runPlan } from '../lib/languages';
import { useStore } from '../lib/store';
import { openedPlayground } from '../lib/playgroundRuns';
import { CellRunOutput, ColabMark, ConnectCard, MachinePicker, attachUrl, useColab } from './Colab';
import MetricsPane from './MetricsPane';
import NotebookPage from './Notebook';
import RuntimePane from './RuntimePane';
import Gutter, { DEFAULT_LAYOUT, TREE_FOLD, loadLayout, readLayout, saveLayout } from './Gutter';
import Terminal, { forgetTerminal, hasTerminals, typeInTerminal } from './Terminal';
import { WhereDialog } from './Playground';
import VsCodeExtension, { VsCodeMark, isCompanion } from './VsCodeExtension';
import { ArrowLeftIcon, ChartIcon, CloseIcon, DriveMark, PlusIcon, SearchIcon, SparkleIcon } from './icons';
import FileIcon, { languageOf } from './FileIcon';
import ProjectAgent from './ProjectAgent';
import CliAgent from './CliAgent';
import TensorBoardPane from './TensorBoardPane';
import KernelTerminal, { closeKernelTerminal } from './KernelTerminal';
import CodeEditor from './CodeEditor';
import { ContextMenu, FolderPlusGlyph, keyLabel, OpenEditors, OutlineGlyph, OutlineView, PaletteGlyph, QuickPick, SplitGlyph, SymbolMark } from './Workbench';
import { symbolPath, symbolsOf } from '../lib/editing';
import { clearAgentChat } from '../lib/projectAgent';
import { agentChatFor, listAll, loadAgentChats, subscribeAgent } from '../lib/projectAgent';
import { implementationFor, loadImplementation, subscribeImplement } from '../lib/implement';
import ProjectStart from './ProjectStart';
import { AwayCard, BringDialog, SnapshotView, useSnapshots } from './PlaygroundAway';
import { computerOf, useReach } from '../lib/away';
const RIGHT_TABS = [
    { id: 'agent', label: 'Agent', title: 'Claude Code, Codex, or the page’s own agent' },
    { id: 'runtime', label: 'Runtime', title: 'The machine: GPU, memory, disk, live' },
    { id: 'metrics', label: 'Metrics', title: 'The numbers the runs print: loss, accuracy' },
    { id: 'tensorboard', label: 'TensorBoard', title: 'The scalars your runs log for TensorBoard' },
];
const DEFAULT_EDITOR = { fontSize: 13, minimap: true, autoSave: false };
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const readLocal = (name, fallback) => {
    try {
        const raw = localStorage.getItem(name);
        return raw ? JSON.parse(raw) : fallback;
    }
    catch {
        return fallback;
    }
};
const writeLocal = (name, value) => {
    try {
        localStorage.setItem(name, JSON.stringify(value));
    }
    catch {
        // private mode: the layout starts over next time
    }
};
const FilesGlyph = () => (_jsxs("svg", { width: "19", height: "19", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx("path", { d: "M14 3H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" }), _jsx("path", { d: "M14 3v4h4M9 21h9a2 2 0 0 0 2-2V9" })] }));
const SyncGlyph = () => (_jsx("svg", { width: "19", height: "19", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: _jsx("path", { d: "M4 9a8 8 0 0 1 14.5-3.5L20 7M20 3v4h-4M20 15a8 8 0 0 1-14.5 3.5L4 17M4 21v-4h4" }) }));
const TbGlyph = () => (_jsxs("svg", { width: "19", height: "19", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx("path", { d: "M3 20h18M4 16l4.5-6 4 3.5L20 5" }), _jsx("circle", { cx: "20", cy: "5", r: "1.2", fill: "currentColor" })] }));
const GaugeGlyph = () => (_jsxs("svg", { width: "19", height: "19", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", "aria-hidden": "true", children: [_jsx("path", { d: "M4 18a8 8 0 1 1 16 0" }), _jsx("path", { d: "m12 18 4-6" })] }));
const clock = (since, now) => {
    if (!since)
        return '';
    const s = Math.max(0, Math.round((now - since) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const consoleKey = (playgroundId, entryId) => `pgsh:${playgroundId}:${entryId}`;
const uid = () => Math.random().toString(36).slice(2, 10);
/** The backend a playground's compute names, when it can be had: its Colab machine, or a server that is still in the list. */
const backendOf = (playground) => backendOfPlayground(playground);
/** `backLabel` names where Back goes when the workspace is opened somewhere other than the Playground — a paper's Explain page. */
export default function PlaygroundWorkspace({ playground, onBack, onOpenPaper, backLabel }) {
    const colab = useColab();
    const { papers, settings } = useStore();
    useServers();
    const [tab, setTab] = useState(playground.kind === 'project' ? 'files' : 'notebook');
    const [side, setSide] = useState(null);
    const [title, setTitle] = useState(playground.title);
    const [changing, setChanging] = useState(false);
    const [note, setNote] = useState(null);
    const backend = backendOf(playground);
    const machineName = backend
        ? backendLabel(backend, colab.backend.kind === backend.kind ? colab.runtime : undefined)
        : playground.compute.kind === 'server' && playground.compute.name
            ? `${playground.compute.name}, not connected here`
            : 'a computer not connected here';
    // Where the code is, when it is on one computer: here, or away — and what the reader chose to see of that.
    const [reach, retryReach] = useReach(playground);
    const away = reach.state === 'down' || reach.state === 'unknown' ? reach : null;
    const shows = settings.awayShows;
    const driveOn = useDriveConnected();
    const [snapView, setSnapView] = useState(false);
    const [bringing, setBringing] = useState(false);
    useSnapshots(playground, shows.snapshot && reach.state === 'here' && playground.home.kind === 'server' && driveOn);
    // This page is open: the dock and the toasts leave its own runs to it.
    useEffect(() => openedPlayground(playground.id), [playground.id]);
    // The kernel follows the playground: its own kernel, on its machine, comes to the foreground — the one this tab
    // already has for it, if it has one. Whatever another playground is running goes on in its own, behind.
    useEffect(() => {
        if (!backend)
            return;
        chooseBackend(backend, playground.id);
        if (playground.compute.kind === 'colab')
            setMachine(playground.compute.machine);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playground.id, playground.compute.kind === 'server' ? playground.compute.serverId : playground.compute.shared ? 'colab-shared' : 'colab', playground.compute.kind === 'colab' ? playground.compute.machine.accelerator : '', backend?.kind === 'jupyter' ? backend.server.url + backend.server.token : '']);
    // A Companion paired over plain http moves to its https address once this computer trusts its certificate.
    useEffect(() => {
        void secureCompanions();
    }, []);
    useEffect(() => {
        document.title = `${playground.title} · Playground · Reader`;
    }, [playground.title]);
    // Off the playground, the paper pages' cells run in their own Colab kernel again, as their buttons say. This
    // playground's kernel stays connected behind, running or idle, and comes back to the front when it opens again.
    useEffect(() => () => {
        chooseBackend({ kind: 'colab' });
    }, []);
    // On Colab: the runtime stopped after the idle time asked for, while the tab is open — a forgotten GPU is units spent.
    useEffect(() => {
        if (playground.compute.kind !== 'colab' || !playground.idleStopMin)
            return;
        const check = window.setInterval(() => {
            if (colabNow().status !== 'idle')
                return;
            if (Date.now() - lastActivityAt() < playground.idleStopMin * 60_000)
                return;
            void stopRuntime();
            setNote(`The Colab runtime was stopped after ${playground.idleStopMin} minutes with nothing running, as this playground asks. The next Run starts a new one.`);
        }, 30_000);
        return () => window.clearInterval(check);
    }, [playground.compute, playground.idleStopMin]);
    const cited = playground.cites.map((cite) => papers.find((paper) => paper.id === cite.paperId) ?? null);
    const screen = useCallback(async () => {
        const paper = cited.find(Boolean);
        return {
            where: `In the Playground — “${playground.title}”, running on ${machineName}`,
            paper: paper ? { id: paper.id, title: paper.title, authors: paper.authors, published: paper.published, arxivId: paper.arxivId, doi: paper.doi, abstract: paper.abstract } : undefined,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playground.title, machineName, cited.map((p) => p?.id).join()]);
    const nbKey = notebookKey(playground.id);
    const seed = useCallback(() => takeSeed(playground.id) ?? blankCells(playground.title), [playground.id, playground.title]);
    const connected = colab.status === 'idle' || colab.status === 'busy';
    const usable = Boolean(backend) && colabAvailable(settings.googleClientId);
    const vscode = vscodeLink(playground);
    const homeServer = playground.home.kind === 'server' ? serverById(playground.home.serverId) : undefined;
    // The folder says which playground it is, for VS Code's Reader extension; once per opening is enough.
    useEffect(() => {
        if (playground.home.kind !== 'server')
            return;
        void markFolder(playground, `${window.location.origin}${import.meta.env.BASE_URL}`).catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playground.id, playground.title, playground.cites.length, playground.home.kind === 'server' ? playground.home.serverId : '']);
    return (_jsxs("main", { className: "main pg-page pg-work", children: [_jsxs("header", { className: "pg-bar", children: [_jsxs("button", { type: "button", className: "btn sm ghost", onClick: onBack, title: backLabel ? `Back to the ${backLabel} page` : "The Playground's home", children: [_jsx(ArrowLeftIcon, { size: 15 }), " ", backLabel ?? 'Playground'] }), _jsx("input", { className: "pg-name", value: title, "aria-label": "The playground's name", onChange: (event) => setTitle(event.target.value), onBlur: () => title.trim() && title.trim() !== playground.title && updatePlayground(playground.id, { title: title.trim() }), onKeyDown: (event) => event.key === 'Enter' && event.target.blur() }), _jsxs("div", { className: "segmented", role: "tablist", "aria-label": "Show", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": tab === 'notebook', "aria-pressed": tab === 'notebook', onClick: () => setTab('notebook'), children: "Notebook" }), _jsx("button", { type: "button", role: "tab", "aria-selected": tab === 'files', "aria-pressed": tab === 'files', onClick: () => setTab('files'), children: "Files" })] }), playground.cites.length ? (_jsx("span", { className: "pg-cites", children: playground.cites.map((cite) => (_jsxs("button", { type: "button", className: "pg-cite", onClick: () => onOpenPaper(cite.paperId), title: "Open the paper", disabled: !papers.some((p) => p.id === cite.paperId), children: ["\u00B6 ", cite.title.length > 42 ? `${cite.title.slice(0, 42)}…` : cite.title] }, cite.paperId))) })) : null, _jsx("span", { className: "spacer" }), vscode ? (_jsxs("a", { className: "btn sm ghost", href: vscode, title: "Open this project's folder in VS Code (the Reader extension adds the papers, the machine and Open on the site)", children: [_jsx(VsCodeMark, {}), " Open in VS Code"] })) : null, vscode && homeServer ? _jsx(VsCodeExtension, { server: homeServer, compact: true }) : null, shows.bring && computerOf(playground) && reach.state === 'here' ? (_jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setBringing(true), title: `Its code is on ${computerOf(playground)} only: copy it, or move it to Drive so every computer opens it`, children: "Open everywhere\u2026" })) : null, _jsx(MachineChip, { playground: playground, name: machineName, usable: usable, onChange: () => setChanging(true), onNote: setNote }), tab === 'notebook' ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: `btn sm ghost${side === 'runtime' ? ' is-on' : ''}`, "aria-pressed": side === 'runtime', onClick: () => setSide(side === 'runtime' ? null : 'runtime'), children: "Runtime" }), _jsx("button", { type: "button", className: `btn sm ghost${side === 'metrics' ? ' is-on' : ''}`, "aria-pressed": side === 'metrics', onClick: () => setSide(side === 'metrics' ? null : 'metrics'), children: "Metrics" })] })) : null] }), !backend && away && shows.card && tab === 'files' ? null : !backend ? (_jsxs("div", { className: "pg-banner is-problem", children: ["This playground runs on ", playground.compute.kind === 'server' && playground.compute.name ? playground.compute.name : 'a computer', ", which isn\u2019t connected to this browser.", ' ', _jsx("button", { type: "button", className: "link", onClick: () => setChanging(true), children: "Choose where it runs" })] })) : !usable ? (_jsx("div", { className: "pg-banner is-problem", children: "Colab needs Settings \u2192 Google (a client ID) and Settings \u2192 Paper proxy before cells can run \u2014 or choose a Jupyter server of yours from the machine menu." })) : colab.error && colab.status !== 'connecting' ? (_jsx("div", { className: "pg-banner is-problem", children: colab.error })) : colab.sharing && colab.scope === playground.id ? (_jsx("div", { className: "pg-banner", children: colab.sharing })) : null, note ? (_jsxs("div", { className: "pg-banner", children: [note, _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Dismiss", onClick: () => setNote(null), children: _jsx(CloseIcon, { size: 13 }) })] })) : null, playground.home.kind === 'browser' && playground.kind === 'project' ? _jsx(MoveOutOfBrowser, { playground: playground, machineName: machineName, onNote: setNote }) : null, _jsx("div", { className: "pg-body", children: tab === 'notebook' ? (_jsx("div", { className: "pg-notebook", children: _jsx(NotebookPage, { paperId: nbKey, title: playground.title, screen: screen, side: side, onSide: setSide, sections: [], playground: { hasPaper: cited.some(Boolean), seed } }) })) : snapView && shows.snapshot ? (_jsx(SnapshotView, { playground: playground, reach: reach, onBring: shows.bring ? () => setBringing(true) : undefined, onBack: () => setSnapView(false) })) : away && shows.card ? (_jsx(AwayCard, { playground: playground, reach: away, onSnapshot: () => setSnapView(true), onBring: () => setBringing(true), onRetry: retryReach, onConnect: onBack, onNotebook: () => setTab('notebook') })) : (_jsx(FilesView, { playground: playground, connected: connected, usable: usable, machineName: machineName }, JSON.stringify(playground.home))) }), bringing ? _jsx(BringDialog, { playground: playground, reach: reach, onClose: () => setBringing(false), onOpen: (id) => window.dispatchEvent(new CustomEvent(OPEN_PLAYGROUND, { detail: { id } })) }) : null, changing ? (_jsx(WhereDialog, { draft: { title: playground.title, kind: playground.kind }, current: { compute: playground.compute, home: playground.home, idleStopMin: playground.idleStopMin }, onClose: () => setChanging(false), onCreate: (spec) => {
                    const movedFiles = JSON.stringify(spec.home) !== JSON.stringify(playground.home);
                    // Off a Colab machine of its own: that machine is stopped (when nothing runs on it), not left to use units until Colab's idle limit.
                    const ownColab = (c) => c.kind === 'colab' && !c.shared;
                    if (ownColab(playground.compute) && !ownColab(spec.compute))
                        void shutDownScope(playground.id);
                    updatePlayground(playground.id, { compute: spec.compute, home: spec.home.kind === 'server' && !spec.home.root ? { ...spec.home, root: playground.home.kind === 'server' ? playground.home.root : `playgrounds/${playground.id}` } : spec.home, idleStopMin: spec.idleStopMin });
                    setChanging(false);
                    setNote(movedFiles ? 'The files now live in the new place; the ones kept in the old place stay there — copy what you need across from the Files tab.' : `Cells now run on ${spec.compute.kind === 'colab' ? 'your Colab' : serverById(spec.compute.serverId)?.name}. The kernel there starts fresh: re-run the cells that set things up.`);
                } })) : null] }));
}
/** The chip in the bar: where the kernel is, how it is, and its menu — connect, interrupt, change, shut down; and for a Companion on this computer, shut it down and start it again. */
function MachineChip({ playground, name, usable, onChange, onNote }) {
    const colab = useColab();
    const [open, setOpen] = useState(false);
    const server = playground.compute.kind === 'server' ? serverById(playground.compute.serverId) : undefined;
    // A Companion on this computer: the page can shut it down, and start it again (a tunnel's address changes each start).
    const companion = server && server.where === 'pc' && isCompanion(server) && companionPort(server.url) !== null ? server : undefined;
    const [power, setPower] = useState('unknown');
    const [now, setNow] = useState(Date.now());
    const box = useRef(null);
    useEffect(() => {
        if (!colab.startedAt)
            return;
        const tick = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(tick);
    }, [colab.startedAt]);
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => !box.current?.contains(event.target) && setOpen(false);
        window.addEventListener('mousedown', away);
        return () => window.removeEventListener('mousedown', away);
    }, [open]);
    const connected = colab.status === 'idle' || colab.status === 'busy';
    const onColab = playground.compute.kind === 'colab';
    const colabMachine = playground.compute.kind === 'colab' ? playground.compute.machine : colab.machine;
    const [changingMachine, setChangingMachine] = useState(false);
    useEffect(() => {
        if (!open)
            setChangingMachine(false);
    }, [open]);
    /** The machine picked here becomes the playground's own, so it opens on it next time and in other browsers. */
    const pickMachine = (machine) => {
        setMachine(machine);
        if (playground.compute.kind === 'colab')
            updatePlayground(playground.id, { compute: { kind: 'colab', machine } });
    };
    // Whether the Companion answers, looked at when the menu opens and it isn't connected.
    useEffect(() => {
        if (!open || !companion || connected || power === 'stopping' || power === 'starting')
            return;
        let live = true;
        void findCompanion(companion.url, 2500).then((info) => live && setPower(info ? 'up' : 'down'));
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, companion?.url, connected]);
    useEffect(() => {
        if (connected)
            setPower('up');
    }, [connected]);
    const dot = colab.status === 'busy' || colab.status === 'connecting' || power === 'starting' || power === 'stopping' ? 'busy' : connected ? 'on' : colab.status === 'lost' || colab.status === 'error' ? 'lost' : 'off';
    const sample = colab.sample;
    const busy = sample ? [sample.gpu ? `GPU ${sample.gpu.util}%` : '', sample.cpu !== undefined ? `CPU ${sample.cpu}%` : ''].filter(Boolean).join(' · ') : '';
    const state = power === 'stopping' ? 'shutting down…' : power === 'starting' ? 'starting…' : colab.status === 'connecting' ? 'connecting…' : colab.reconnecting ? 'reconnecting…' : colab.status === 'busy' ? busy || 'running' : connected ? 'idle' : power === 'down' ? 'shut down' : colab.status === 'lost' ? 'ended' : playground.compute.kind === 'server' ? 'kernel not started' : 'not connected';
    const shutDown = async () => {
        if (!companion)
            return;
        if (colab.status === 'busy' && !window.confirm(`A cell is running on ${name}. Shut the Companion down anyway? What is running stops, and every variable goes.`))
            return;
        setPower('stopping');
        onNote(null);
        try {
            await stopRuntime();
            await shutdownCompanion(companion);
            setPower('down');
            onNote(`The Reader Companion on ${name} is shut down: no Jupyter server, no kernels. It stays off, at your next login too, until you start it — Start the Companion in this menu, the Reader app, or reader-companion start in a terminal.`);
        }
        catch (error) {
            setPower('unknown');
            onNote(error instanceof Error ? error.message : String(error));
        }
    };
    const startUp = async () => {
        if (!companion)
            return;
        setPower('starting');
        onNote(null);
        const info = await startCompanion(companion.url);
        if (!info) {
            setPower('down');
            onNote(`The Companion didn’t start from here. Open the Reader app on ${name}, or run reader-companion start in a terminal there. (The page can start a Companion from ${STARTABLE} on, installed with the Reader app or the installer: update it in Settings → Updates.)`);
            return;
        }
        setPower('up');
        await connect().catch(() => undefined);
    };
    return (_jsxs("div", { className: "menu-wrap", ref: box, children: [_jsxs("button", { type: "button", className: `colab-chip pg-chip is-${dot}`, "aria-haspopup": "menu", "aria-expanded": open, onClick: () => setOpen(!open), title: colab.error || (state === 'kernel not started' ? `Cells run on ${name}. Its kernel starts with the first cell or command; the terminal, the files and the agent don't need it — they reach the computer through its Companion.` : `Cells run on ${name}`), children: [playground.compute.kind === 'colab' ? _jsx(ColabMark, {}) : _jsx("span", { className: `pg-mark ${(serverById(playground.compute.serverId)?.where ?? playground.compute.where) === 'pc' ? 'is-pc' : 'is-gpu'}`, children: (serverById(playground.compute.serverId)?.where ?? playground.compute.where) === 'pc' ? 'PC' : 'GPU' }), _jsx("span", { className: `colab-dot is-${dot}`, "aria-hidden": "true" }), name, " \u00B7 ", state, connected && colab.startedAt ? ` · ${clock(colab.startedAt, now)}` : ''] }), open && onColab && !connected ? (
            // Colab, not connected: the same card as a paper's cells — the machine, what Google is asked for, what the reader can and can't do.
            _jsx(ConnectCard, { playground: true, initial: colabMachine, busy: colab.status === 'connecting', onClose: () => setOpen(false), onConnect: (machine) => {
                    setOpen(false);
                    pickMachine(machine);
                    void connect(machine).catch(() => undefined);
                }, footer: _jsxs("button", { type: "button", className: "colab-action", onClick: () => {
                        setOpen(false);
                        onChange();
                    }, children: [_jsx("b", { children: "Change where it runs\u2026" }), _jsx("span", { children: "This PC, a computer of yours, a GPU server \u2014 or the code on one machine and run on another" })] }) })) : open ? (_jsxs("div", { className: `menu right pg-chip-menu${onColab ? ' colab-menu' : ''}`, role: "menu", children: [_jsx("div", { className: "menu-label", children: "Where the code runs" }), _jsxs("p", { className: "pg-chip-note", children: [_jsx("b", { children: name }), colab.specs?.gpuName ? ` · ${colab.specs.gpuName}` : '', colab.specs?.ramTotalMb ? ` · ${Math.round(colab.specs.ramTotalMb / 1024)} GB RAM` : '', server ? (_jsx("small", { className: "pg-chip-secure", title: isSecure(server.url) ? 'The page and the server talk over https: encrypted, and the server’s certificate checked.' : 'The page and the Companion talk over plain http on 127.0.0.1: it never leaves this computer, and every call needs the Companion’s token. Safari, and the others once this computer trusts the Companion’s certificate, use https instead.', children: isSecure(server.url) ? 'HTTPS · encrypted' : companion ? 'HTTP · on this computer only' : 'HTTP · not encrypted' })) : null] }), companion && !connected && (power === 'down' || power === 'starting') ? (_jsx("button", { type: "button", role: "menuitem", disabled: power === 'starting', title: "Starts the Reader Companion (the Jupyter server on this computer) through the Reader app. Your browser asks once whether to open it.", onClick: () => {
                            setOpen(false);
                            void startUp();
                        }, children: power === 'starting' ? 'Starting the Companion…' : 'Start the Companion' })) : !connected ? (_jsx("button", { type: "button", role: "menuitem", disabled: !usable || colab.status === 'connecting', onClick: () => {
                            setOpen(false);
                            void connect().catch(() => undefined);
                        }, children: "Connect now" })) : (_jsx("button", { type: "button", role: "menuitem", disabled: colab.status !== 'busy', title: "Stops the cell that is running now, as Ctrl-C would. The kernel, its variables and the server stay.", onClick: () => {
                            setOpen(false);
                            void interrupt();
                        }, children: "Interrupt the running cell" })), onColab && connected ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "colab-stats", children: [_jsxs("div", { children: [_jsx("span", { className: "k", children: "Machine" }), _jsx("span", { className: "v", children: colab.runtime ? machineLabel(colab.runtime) : machineLabel(colabMachine) })] }), _jsxs("div", { children: [_jsx("span", { className: "k", children: "Up for" }), _jsx("span", { className: "v", children: clock(colab.startedAt, now) || '—' })] }), _jsxs("div", { children: [_jsx("span", { className: "k", children: "Compute units" }), _jsxs("span", { className: "v", children: [colab.units?.balance !== undefined ? colab.units.balance.toFixed(1) : colab.runtime?.accelerator ? 'your tier’s' : '0', colab.units?.ratePerHour ? _jsxs("small", { children: [" \u00B7 ", colab.units.ratePerHour.toFixed(2), "/h"] }) : !colab.runtime?.accelerator ? _jsx("small", { children: " \u00B7 free" }) : null] })] })] }), changingMachine ? (_jsxs("div", { className: "colab-status", children: ["A new runtime on another machine; this one is stopped, and every variable with it.", _jsx(MachinePicker, { machine: colabMachine, disabled: colab.status === 'busy', onPick: (machine) => {
                                            setOpen(false);
                                            setChangingMachine(false);
                                            pickMachine(machine);
                                            void stopRuntime().then(() => connect(machine));
                                        } })] })) : (_jsxs("button", { type: "button", role: "menuitem", className: "pg-chip-two", disabled: colab.status === 'busy', onClick: () => setChangingMachine(true), children: ["Change machine\u2026 ", _jsx("small", { className: "pg-chip-sub", children: "CPU, T4, L4, A100 \u2014 a new runtime" })] })), colab.runtime && colab.backend.kind === 'colab' ? (_jsx("a", { role: "menuitem", className: "pg-chip-link", href: attachUrl(colab.runtime.endpoint), target: "_blank", rel: "noreferrer noopener", title: "Colab's own notebook page on the same machine \u2014 for plots, a terminal, or Drive, on purpose", children: "Open this runtime in Colab \u2197" })) : null, _jsx("button", { type: "button", role: "menuitem", disabled: colab.status === 'busy', title: "Forgets every variable; keeps the machine and the files on it", onClick: () => {
                                    setOpen(false);
                                    void restartKernel();
                                }, children: "Restart the kernel" })] })) : null, _jsx("button", { type: "button", role: "menuitem", onClick: () => {
                            setOpen(false);
                            onChange();
                        }, children: "Change where it runs\u2026" }), connected || (companion && power === 'up') ? (_jsxs(_Fragment, { children: [_jsx("hr", {}), connected ? (_jsx("button", { type: "button", role: "menuitem", title: playground.compute.kind === 'colab' ? undefined : 'Ends this notebook’s Python process: its variables go. The Jupyter server keeps running.', onClick: () => {
                                    setOpen(false);
                                    void stopRuntime();
                                }, children: playground.compute.kind === 'colab' ? 'Stop the Colab runtime' : 'Shut down the kernel' })) : null, companion ? (_jsx("button", { type: "button", role: "menuitem", title: "Stops the Reader Companion, the Jupyter server on this computer, and every kernel in it. It stays off until you start it again from this menu or the Reader app.", onClick: () => {
                                    setOpen(false);
                                    void shutDown();
                                }, children: "Shut down the Companion" })) : null] })) : null] })) : null] }));
}
/** What a server's computer can run: a Companion says (/companion/tools); anything else is taken to be a Linux box with Python and a compiler. */
function useMachineTools(server) {
    const [found, setFound] = useState(null);
    useEffect(() => {
        if (!server || !isCompanion(server))
            return;
        let live = true;
        void companionTools(server).then((tools) => live && setFound({ id: server.id, tools }));
        return () => {
            live = false;
        };
    }, [server?.id, server?.url, server?.token]);
    const tools = server && found && found.id === server.id ? found.tools : null;
    return { tools: tools ?? ASSUMED_TOOLS, asked: Boolean(tools) };
}
/** The project's folder on the server's computer, absolute, when the page knows the Companion's: /Users/me/Reader/<root>. */
const absoluteFolder = (server, relative) => {
    if (!server?.root)
        return null;
    const windows = /^[A-Za-z]:\\/.test(server.root);
    const root = server.root.replace(/[\\/]+$/, '');
    return windows ? `${root}\\${relative.replace(/\//g, '\\')}` : `${root}/${relative}`;
};
const readSession = (name, fallback) => {
    try {
        const raw = sessionStorage.getItem(name);
        return raw ? JSON.parse(raw) : fallback;
    }
    catch {
        return fallback;
    }
};
const writeSession = (name, value) => {
    try {
        sessionStorage.setItem(name, JSON.stringify(value));
    }
    catch {
        // private mode: the tabs start over next time
    }
};
const shortId = () => Math.random().toString(36).slice(2, 8);
/**
 * The agent pane: a coding agent picked from the list, run in a terminal of
 * its own in the project's folder, beside the editor as in VS Code. Before it
 * starts, its options — the model, what it may do without asking, carrying
 * on the last conversation, any other flags — make up its command line, shown
 * as it will be typed; while it runs, its own slash commands and keys are
 * buttons. The session lives on the machine, so closing the pane and opening
 * it again finds the same conversation; Start again begins a new one.
 */
function AgentPane({ server, machineName, agents, asked, cwd, inFolder, playgroundId }) {
    const installed = new Set(agents.map((agent) => agent.id));
    // An agent the Companion found that the list doesn't name yet still shows, by its own name, with extra arguments only.
    const catalog = [...AGENTS, ...agents.filter((agent) => !AGENTS.some((known) => known.id === agent.id)).map((agent) => ({ ...agent, install: '' }))];
    const sorted = [...catalog].sort((a, b) => Number(installed.has(b.id)) - Number(installed.has(a.id)));
    const key = `pgagent:${playgroundId}`;
    const [session, setSession] = useState(() => readSession(key, null));
    const [pick, setPick] = useState(() => session?.agent ?? sorted.find((agent) => installed.has(agent.id))?.id ?? 'claude');
    const [allOptions, setAllOptions] = useState(savedAgentOptions);
    const [showOptions, setShowOptions] = useState(!session);
    const chosen = catalog.find((agent) => agent.id === pick) ?? catalog[0];
    const options = allOptions[chosen.id] ?? {};
    const setOptions = (patch) => {
        const next = { ...allOptions, [chosen.id]: { ...options, ...patch } };
        setAllOptions(next);
        saveAgentOptions(next);
    };
    const command = agentCommand(chosen, options);
    const isThere = installed.has(chosen.id);
    const running = session ? catalog.find((agent) => agent.id === session.agent) : undefined;
    // What a new session types, once its shell is open (queued until then by typeInTerminal).
    const pending = useRef(null);
    useEffect(() => {
        if (session && pending.current?.id === session.id) {
            typeInTerminal(session.id, pending.current.text);
            pending.current = null;
        }
    }, [session]);
    if (!server)
        return _jsx("p", { className: "pg-note pg-pad", children: "An agent runs in a terminal on the machine: choose a Jupyter server of yours \u2014 a Reader Companion \u2014 from the machine menu." });
    const start = (line) => {
        if (session)
            forgetTerminal(server, session.id);
        const next = { agent: chosen.id, id: `${playgroundId}~agent~${shortId()}`, command: line };
        pending.current = { id: next.id, text: `${inFolder(line)}\r` };
        writeSession(key, next);
        setSession(next);
        setShowOptions(false);
    };
    const stop = () => {
        if (session)
            forgetTerminal(server, session.id);
        writeSession(key, null);
        setSession(null);
        setShowOptions(true);
    };
    const send = (text) => session && typeInTerminal(session.id, text);
    return (_jsxs("div", { className: "pg-agent", children: [_jsxs("div", { className: "pg-agent-bar", children: [_jsx("select", { value: pick, onChange: (event) => setPick(event.target.value), "aria-label": "The coding agent", children: sorted.map((agent) => (_jsxs("option", { value: agent.id, children: [agent.name, installed.has(agent.id) ? '' : asked ? ' · not installed' : ''] }, agent.id))) }), isThere || !asked ? (_jsx("button", { type: "button", className: "btn sm primary", onClick: () => start(command), title: `${command} — in this project's folder on ${machineName}`, children: session ? 'Start again' : 'Start' })) : chosen.install ? (_jsx("button", { type: "button", className: "btn sm", onClick: () => start(chosen.install), title: chosen.install, children: "Install" })) : null, session ? (_jsx("button", { type: "button", className: "btn sm ghost", onClick: stop, title: "End this agent's terminal", children: "End" })) : null, _jsx("button", { type: "button", className: `icon-btn sm${showOptions ? ' is-on' : ''}`, "aria-expanded": showOptions, onClick: () => setShowOptions(!showOptions), title: "Its options: the model, permissions, and more", "aria-label": "Options", children: "\u2699" })] }), showOptions ? (_jsxs("div", { className: "pg-agent-options", children: [chosen.model ? (_jsxs("label", { children: [_jsx("span", { children: "Model" }), _jsx("input", { list: `pg-agent-models-${chosen.id}`, value: options.model ?? '', onChange: (event) => setOptions({ model: event.target.value }), placeholder: chosen.model.placeholder ?? 'its default', spellCheck: false }), chosen.model.suggestions ? (_jsx("datalist", { id: `pg-agent-models-${chosen.id}`, children: chosen.model.suggestions.map((model) => (_jsx("option", { value: model }, model))) })) : null] })) : null, (chosen.choices ?? []).map((choice) => (_jsxs("label", { children: [_jsx("span", { children: choice.label }), _jsx("select", { value: options.choices?.[choice.key] ?? '', onChange: (event) => setOptions({ choices: { ...options.choices, [choice.key]: event.target.value } }), children: choice.values.map((value) => (_jsx("option", { value: value.value, children: value.label }, value.value))) })] }, choice.key))), (chosen.toggles ?? []).map((toggle) => (_jsxs("label", { className: "pg-agent-check", children: [_jsx("input", { type: "checkbox", checked: Boolean(options.toggles?.[toggle.key]), onChange: (event) => setOptions({ toggles: { ...options.toggles, [toggle.key]: event.target.checked } }) }), _jsx("span", { children: toggle.label })] }, toggle.key))), chosen.resume ? (_jsxs("label", { className: "pg-agent-check", children: [_jsx("input", { type: "checkbox", checked: Boolean(options.resume), onChange: (event) => setOptions({ resume: event.target.checked }) }), _jsx("span", { children: "Carry on the last conversation in this folder" })] })) : null, _jsxs("label", { children: [_jsx("span", { children: "Other flags" }), _jsx("input", { value: options.extra ?? '', onChange: (event) => setOptions({ extra: event.target.value }), placeholder: "anything else it takes, as typed", spellCheck: false })] }), _jsxs("code", { className: "pg-agent-line", title: "What Start types, in the project's folder", children: ["$ ", command] })] })) : null, !asked ? _jsxs("p", { className: "pg-note pg-pad", children: ["The Companion on ", machineName, " can\u2019t say which agents are installed (update it in Settings \u2192 Updates): Start runs the command and the shell says if it is missing."] }) : null, session ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "pg-agent-keys", "aria-label": `${running?.name ?? session.agent}: its commands`, children: [(running?.slash ?? []).map((slash) => (_jsx("button", { type: "button", className: "pg-agent-key mono", onClick: () => send(`${slash}\r`), title: `Types ${slash} into ${running?.name ?? 'the agent'}`, children: slash }, slash))), AGENT_KEYS.map((key) => (_jsx("button", { type: "button", className: "pg-agent-key is-key", onClick: () => send(key.text), title: key.title, children: key.label }, key.label)))] }), _jsx("div", { className: "pg-agent-term", children: _jsx(Terminal, { server: server, cwd: cwd, sessionId: session.id, label: `${running?.name ?? session.agent} on ${machineName}`, playgroundId: playgroundId }, session.id) })] })) : (_jsxs("div", { className: "pg-agent-empty", children: [_jsxs("p", { children: [_jsx("b", { children: chosen.name }), " ", isThere ? `is on ${machineName}. Start it and it works in this project's folder, in a terminal of its own here.` : asked ? `isn’t on ${machineName} yet. Install types its installer into a terminal here; then Start.` : ''] }), !isThere && chosen.install ? _jsx("code", { className: "mono pg-note", children: chosen.install }) : null, _jsx("p", { className: "pg-note", children: agents.length ? `On ${machineName}: ${agents.map((agent) => agent.name).join(', ')}.` : asked ? `No agents found on ${machineName} yet.` : '' })] }))] }));
}
/** The page's editor or VS Code, for a project whose files are on a Companion with VS Code. */
function EditorSwitch({ playground }) {
    const mode = playground.editor ?? 'reader';
    return (_jsxs("div", { className: "segmented pg-seg pg-editor-switch", role: "radiogroup", "aria-label": "Editor", children: [_jsx("button", { type: "button", role: "radio", "aria-checked": mode === 'reader', className: mode === 'reader' ? 'on' : '', onClick: () => updatePlayground(playground.id, () => ({ editor: 'reader' })), children: "Editor" }), _jsx("button", { type: "button", role: "radio", "aria-checked": mode === 'vscode', className: mode === 'vscode' ? 'on' : '', onClick: () => updatePlayground(playground.id, () => ({ editor: 'vscode' })), title: "VS Code from that computer, in the page: your extensions and coding agents, on the same files", children: "VS Code" })] }));
}
/** VS Code from the Companion's computer, in the page (code serve-web, through the Companion): started on first open. */
function VsCodePane({ server, folder, playground }) {
    const [status, setStatus] = useState(null);
    const [problem, setProblem] = useState(null);
    const [round, setRound] = useState(0);
    const [showLog, setShowLog] = useState(false);
    // VS Code in the page leans on the Companion's fixes (0.7.2: started again when it stops answering): an older one is offered the update here.
    const [companion, setCompanion] = useState(null);
    useEffect(() => {
        let live = true;
        void findCompanion(server.url.replace(/\/?$/, '/'), 3000).then((info) => live && info && setCompanion({ version: info.version }));
        return () => {
            live = false;
        };
    }, [server.url, round]);
    const outdated = companion && isNewer(COMPANION_VERSION, companion.version) ? companion : null;
    const update = async () => {
        if (!outdated)
            return;
        setCompanion({ ...outdated, updating: true, error: undefined });
        try {
            const done = await updateCompanion(server);
            const back = done.updated ? await waitForVersion(server.url.replace(/\/?$/, '/'), done.version) : null;
            setCompanion({ version: back?.version ?? done.version });
            setRound((n) => n + 1);
        }
        catch (error) {
            setCompanion({ ...outdated, updating: false, error: error instanceof Error ? error.message : String(error) });
        }
    };
    useEffect(() => {
        let live = true;
        let timer = 0;
        setProblem(null);
        const look = async (start) => {
            try {
                const now = await vscodeWeb(server, folder, start);
                if (!live)
                    return;
                setStatus(now);
                if (now.state === 'starting' || (now.state === 'off' && !start))
                    timer = window.setTimeout(() => void look(now.state === 'off'), 1500);
                // Up: asked again now and then (start checks that it answers, and starts it again if not), so VS Code
                // stopping — the computer slept — shows here and comes back by itself.
                else if (now.state === 'ready')
                    timer = window.setTimeout(() => void look(true), 15_000);
            }
            catch (error) {
                if (live)
                    setProblem(error instanceof Error ? error.message : String(error));
            }
        };
        void look(true);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [server.id, server.url, server.token, folder, round]);
    const src = status?.state === 'ready' && status.path ? `${server.url.replace(/\/?$/, '/')}${status.path.replace(/^\//, '')}?folder=${encodeURIComponent(vscodeFolder(status.folder))}` : null;
    // A frame that came up again after a restart is a new one, so it loads VS Code afresh.
    const [frameRound, setFrameRound] = useState(0);
    const wasReady = useRef(true);
    useEffect(() => {
        const ready = status?.state === 'ready';
        if (ready && !wasReady.current)
            setFrameRound((n) => n + 1);
        wasReady.current = ready;
    }, [status?.state]);
    return (_jsxs("div", { className: "pg-vscode-pane", children: [_jsxs("div", { className: "pg-tabs pg-vscode-head", children: [_jsx(EditorSwitch, { playground: playground }), _jsx("span", { className: "pg-note mono", children: status?.folder || folder }), _jsx("span", { className: "spacer" }), status?.log.length ? (_jsx("button", { type: "button", className: `btn sm ghost${showLog ? ' is-on' : ''}`, "aria-pressed": showLog, onClick: () => setShowLog(!showLog), title: "What VS Code itself printed last, on that computer", children: "VS Code\u2019s output" })) : null, src ? (_jsx("a", { className: "btn sm ghost", href: src, target: "_blank", rel: "noreferrer", title: "If the frame stays blank (some browsers keep a frame from another site out of its sign-in), it opens in a tab of its own", children: "Open in a new tab" })) : null] }), outdated ? (_jsxs("div", { className: "pg-banner is-problem", children: [outdated.error ?? `The Companion on ${server.name} is ${outdated.version}; VS Code in the page needs ${COMPANION_VERSION}, which starts VS Code again when it stops answering and lets it connect through the HTTPS tunnel (before, it hung on “Reconnecting…” there).`, _jsx("button", { type: "button", className: "btn sm", disabled: outdated.updating, onClick: () => void update(), children: outdated.updating ? 'Updating…' : 'Update it' })] })) : null, showLog && status?.log.length ? _jsx("pre", { className: "pg-vscode-log", children: status.log.join('\n') }) : null, src ? (_jsx("iframe", { className: "pg-vscode-frame", src: src, title: `VS Code on ${server.name}`, allow: "clipboard-read; clipboard-write" }, frameRound)) : (_jsx("div", { className: "pg-vscode-wait", children: problem || status?.state === 'failed' ? (_jsxs(_Fragment, { children: [_jsx("p", { className: "pg-note is-problem", children: problem || status?.error }), _jsx("button", { type: "button", className: "btn sm", onClick: () => setRound((n) => n + 1), children: "Try again" })] })) : (_jsxs("p", { children: [_jsx("span", { className: "spinner" }), " Starting VS Code on ", server.name, "\u2026 The first time, it downloads VS Code\u2019s server (a minute or two), and your extensions \u2014 coding agents included \u2014 come from the VS Code installed there. Starting it accepts the", ' ', _jsx("a", { href: "https://code.visualstudio.com/license/server", target: "_blank", rel: "noreferrer", children: "VS Code Server license" }), "."] })) }))] }));
}
function FilesView({ playground, connected, usable, machineName }) {
    const colab = useColab();
    const { papers } = useStore();
    const servers = useServers();
    const split = !filesAreOnMachine(playground);
    // The hosts follow the servers' list, so an edited address is used at once.
    const home = useMemo(() => homeHost(playground), [playground, servers]);
    const machine = useMemo(() => machineHost(playground, machineName), [playground, machineName, servers]);
    const homeLabel = homeLabelOf(playground, machineName);
    // The workbench, as VS Code lays it out: the activity bar's view in the side bar, the agent on the right, the panel below.
    const [primary, setPrimary] = useState(() => readLocal('reader.pgPrimary', 'explorer'));
    const [agentOpen, setAgentOpenState] = useState(() => readLocal('reader.pgAgent', true));
    const [agentMode, setAgentMode] = useState(() => readLocal('reader.pgAgentMode', 'claude'));
    const [rightTab, setRightTabState] = useState(() => readLocal('reader.pgRight', 'agent'));
    const setRightTab = (tab) => (setRightTabState(tab), writeLocal('reader.pgRight', tab));
    /** The right-hand pane on a tab, or closed when that tab was already showing. */
    const toggleRight = (tab) => {
        if (agentOpen && rightTab === tab)
            setAgentOpen(false);
        else
            (setRightTab(tab), setAgentOpen(true));
    };
    const [panelOpen, setPanelOpen] = useState(true);
    const setAgentOpen = (open) => (setAgentOpenState(open), writeLocal('reader.pgAgent', open));
    useEffect(() => writeLocal('reader.pgPrimary', primary), [primary]);
    useEffect(() => writeLocal('reader.pgAgentMode', agentMode), [agentMode]);
    const [files, setFiles] = useState([]);
    // The editor groups, as VS Code's split editor: one, or two side by side, each with its tabs and the one shown.
    const [groups, setGroups] = useState([{ tabs: [], active: null }]);
    const [focus, setFocusState] = useState(0);
    const focused = Math.min(focus, groups.length - 1);
    const active = groups[focused]?.active ?? null;
    const setFocus = (index) => setFocusState(index);
    const editors = useRef([]);
    const goTo = useRef(null);
    const [cursor, setCursor] = useState(null);
    const [settings, setSettingsState] = useState(() => ({ ...DEFAULT_EDITOR, ...readLocal('reader.pgEditor', {}) }));
    const setSettings = (patch) => setSettingsState((now) => {
        const next = { ...now, ...patch };
        writeLocal('reader.pgEditor', next);
        return next;
    });
    const [zen, setZen] = useState(false);
    const [pick, setPick] = useState(null);
    const [menu, setMenu] = useState(null);
    const [splitAt, setSplitAt] = useState(50);
    const [dragging, setDragging] = useState(null);
    const root = useRef(null);
    const groupsBox = useRef(null);
    const splitFrom = useRef(50);
    const closed = useRef([]);
    const [problem, setProblem] = useState(null);
    const [refresh, setRefresh] = useState(0);
    const [report, setReport] = useState(null);
    const [syncing, setSyncing] = useState(null);
    const [command, setCommand] = useState(playground.pending ?? '');
    const [base, setBase] = useState(null);
    const current = files.find((file) => `${file.where}:${file.path}` === active) ?? null;
    // The file shown is read again from its folder every couple of seconds, and when the window comes back: an agent, a
    // terminal or another editor may have written it. Untouched here, it takes the new text; changed here too, the bar asks.
    // The panes' sizes and places, dragged and toggled; kept for every project.
    const [layout, setLayoutState] = useState(loadLayout);
    const setLayout = (patch) => setLayoutState((now) => {
        const next = readLayout({ ...now, ...patch });
        saveLayout(next);
        return next;
    });
    const dragFrom = useRef(layout);
    const centerBox = useRef(null);
    const [onDisk, setOnDisk] = useState(null);
    const dismissed = useRef(null);
    const currentKey = current ? `${current.where}:${current.path}` : null;
    useEffect(() => {
        if (!current || !currentKey)
            return;
        const { where, path } = current;
        const host = where === 'home' ? home : machine;
        let live = true;
        let reading = false;
        const check = async () => {
            if (reading || (typeof document !== 'undefined' && document.visibilityState === 'hidden'))
                return;
            reading = true;
            try {
                const disk = (await host.read(path)) ?? '';
                if (!live)
                    return;
                setFiles((list) => list.map((f) => (`${f.where}:${f.path}` === currentKey && disk !== f.saved && f.text === f.saved ? { ...f, text: disk, saved: disk } : f)));
                const shown = filesRef.current.find((f) => `${f.where}:${f.path}` === currentKey);
                const stale = shown && disk !== shown.saved && shown.text !== shown.saved && !(dismissed.current?.key === currentKey && dismissed.current.text === disk);
                setOnDisk(stale ? { key: currentKey, text: disk } : null);
            }
            catch {
                // not reachable now (the machine not connected): the next read tries again
            }
            finally {
                reading = false;
            }
        };
        const every = window.setInterval(() => void check(), 2000);
        window.addEventListener('focus', check);
        return () => {
            live = false;
            window.clearInterval(every);
            window.removeEventListener('focus', check);
        };
    }, [currentKey, home, machine]);
    const filesRef = useRef(files);
    filesRef.current = files;
    // A real terminal when the machine is a Jupyter server that offers one (a Reader Companion does); the command box otherwise, and on Colab.
    const computeServer = playground.compute.kind === 'server' ? servers.find((server) => server.id === (playground.compute.kind === 'server' ? playground.compute.serverId : '')) : undefined;
    const [terminals, setTerminals] = useState(null);
    useEffect(() => {
        setTerminals(null);
        if (!computeServer)
            return;
        let live = true;
        void hasTerminals(computeServer).then((yes) => live && setTerminals(yes));
        return () => {
            live = false;
        };
    }, [computeServer?.id, computeServer?.url, computeServer?.token]);
    // In split mode the command box copies the folder over before each command and brings results back; the terminal doesn't, so the box stays first there.
    const [shellView, setShellView] = useState(null);
    // Where the machine has no terminals API (Colab), the terminal is a shell the page runs through the kernel (KernelTerminal).
    const kernelTerms = !(terminals && computeServer);
    const view = shellView ?? 'terminal';
    const { tools: machineTools, asked } = useMachineTools(computeServer);
    const homeServer = playground.home.kind === 'server' ? servers.find((server) => server.id === (playground.home.kind === 'server' ? playground.home.serverId : '')) : undefined;
    const { tools: homeTools } = useMachineTools(homeServer);
    // VS Code in the page opens a folder on a Companion's computer: the project's, when its files are kept there —
    // in a folder of its (home) or on its own disk as the machine the code runs on.
    const vscodeAt = playground.home.kind === 'server' && homeServer && isCompanion(homeServer) && homeTools.vscode
        ? { server: homeServer, folder: playground.home.root }
        : playground.home.kind === 'machine' && computeServer && isCompanion(computeServer) && machineTools.vscode
            ? { server: computeServer, folder: machineRoot(playground) }
            : null;
    // VS Code in the page: for files on a Companion whose computer has VS Code.
    const vscodeHere = Boolean(vscodeAt);
    const terminalHere = Boolean(view === 'terminal' || (terminals && computeServer && !split));
    const projectFolder = terminalHere ? absoluteFolder(computeServer, machineRoot(playground)) : null;
    // The agent's terminal is its own, so it goes to the folder whatever the console below shows.
    const agentFolder = terminals && computeServer ? absoluteFolder(computeServer, machineRoot(playground)) : null;
    // Several shells, as tabs: the first is the playground's own (its session from before carries on), the others new ones. Each stays open while another is shown.
    const shellsKey = `pgshells:${playground.id}`;
    const [shells, setShells] = useState(() => {
        const kept = readSession(shellsKey, []);
        return kept.length ? kept : [playground.id];
    });
    const [activeShell, setActiveShell] = useState(shells[0]);
    const keepShells = (next) => {
        setShells(next);
        writeSession(shellsKey, next);
    };
    const addShell = () => {
        const id = `${playground.id}~${shortId()}`;
        keepShells([...shells, id]);
        setActiveShell(id);
    };
    const closeShell = (id) => {
        if (kernelTerms)
            closeKernelTerminal(id);
        else if (computeServer)
            forgetTerminal(computeServer, id);
        const left = shells.filter((shell) => shell !== id);
        const next = left.length ? left : [`${playground.id}~${shortId()}`];
        keepShells(next);
        if (id === activeShell)
            setActiveShell(next[Math.max(0, shells.indexOf(id) - 1)] ?? next[0]);
    };
    /** A command, in the project's folder when the page knows it: the agent pane's. */
    const inFolder = (command) => (agentFolder ? (machineTools.os === 'windows' ? `cd "${agentFolder}"; ${command}` : `cd '${agentFolder.replace(/'/g, `'\\''`)}' && ${command}`) : command);
    /** A command into the terminal shown below, in the project's folder: the Run button's. */
    const inTerminal = async (command) => {
        setShellView('terminal');
        setPanelOpen(true);
        // The folder kept elsewhere: copied over first, so the command runs the code on screen.
        if (split && !(await push()))
            return;
        typeInTerminal(activeShell, `${command}\r`);
    };
    /** A tab shown in a group (the focused one unless said; one past the last splits the editor), the group focused. */
    const show = (key, group = focused) => {
        setGroups((list) => {
            const next = group >= list.length ? [...list, { tabs: [], active: null }] : [...list];
            const g = next[Math.min(group, next.length - 1)];
            next[Math.min(group, next.length - 1)] = { tabs: g.tabs.includes(key) ? g.tabs : [...g.tabs, key], active: key };
            return next.slice(0, 2);
        });
        setFocus(Math.min(group, 1));
    };
    const open = async (where, path, at = {}) => {
        const key = `${where}:${path}`;
        const group = at.group ?? focused;
        if (at.line)
            goTo.current = { group: Math.min(group, 1), line: at.line };
        if (files.some((file) => `${file.where}:${file.path}` === key))
            return show(key, group);
        setProblem(null);
        try {
            const text = (await (where === 'home' ? home : machine).read(path)) ?? '';
            setFiles((list) => (list.some((f) => `${f.where}:${f.path}` === key) ? list : [...list, { where, path, text, saved: text }]));
            show(key, group);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
    };
    // A project started from a paper opens on its README the first time, the paper and its abstract in front.
    useEffect(() => {
        if (playground.start !== 'paper' || readLocal(`reader.pgFirstOpen:${playground.id}`, false))
            return;
        void home
            .read('README.md')
            .then((text) => {
            if (text === null)
                return;
            writeLocal(`reader.pgFirstOpen:${playground.id}`, true);
            void open('home', 'README.md');
        })
            .catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playground.id]);
    // A line asked for (Go to Line, Outline, search, Quick Open), once its editor is there.
    useEffect(() => {
        const want = goTo.current;
        if (!want)
            return;
        const editor = editors.current[want.group];
        if (!editor)
            return;
        goTo.current = null;
        window.requestAnimationFrame(() => editor.goToLine(want.line));
    });
    /** A tab closed in a group: asked first when it holds unsaved work shown nowhere else; the file let go when no group shows it. */
    const closeTab = (group, key, ask = true) => {
        const file = files.find((f) => `${f.where}:${f.path}` === key);
        const elsewhere = groups.some((g, index) => index !== group && g.tabs.includes(key));
        if (ask && file && file.text !== file.saved && !elsewhere && !window.confirm(`${file.path.split('/').pop()} has changes that aren’t saved. Close it and lose them?`))
            return false;
        const next = groups.map((g, index) => {
            if (index !== group)
                return g;
            const at = g.tabs.indexOf(key);
            const tabs = g.tabs.filter((t) => t !== key);
            return { tabs, active: g.active === key ? tabs[Math.min(at, tabs.length - 1)] ?? null : g.active };
        });
        const kept = next.filter((g, index) => g.tabs.length || index === 0 || next.length === 1);
        const merged = kept.length ? kept : [{ tabs: [], active: null }];
        setGroups(merged);
        if (focused >= merged.length)
            setFocus(merged.length - 1);
        if (!merged.some((g) => g.tabs.includes(key))) {
            setFiles((list) => list.filter((f) => `${f.where}:${f.path}` !== key));
            closed.current = [key, ...closed.current.filter((k) => k !== key)].slice(0, 20);
        }
        return true;
    };
    const closeMany = (group, keys) => {
        for (const key of keys)
            if (!closeTabRef.current(group, key))
                break;
    };
    const closeTabRef = useRef(closeTab);
    closeTabRef.current = closeTab;
    /** A tab moved to the other group (or to a new one on the right). */
    const moveTab = (from, key, to) => {
        if (from === to)
            return;
        setGroups((list) => {
            let next = list.map((g, index) => {
                if (index !== from)
                    return g;
                const tabs = g.tabs.filter((t) => t !== key);
                return { tabs, active: g.active === key ? tabs[tabs.length - 1] ?? null : g.active };
            });
            if (to >= next.length)
                next = [...next, { tabs: [], active: null }];
            next[to] = { tabs: next[to].tabs.includes(key) ? next[to].tabs : [...next[to].tabs, key], active: key };
            const kept = next.filter((g) => g.tabs.length);
            return (kept.length ? kept : [{ tabs: [], active: null }]).slice(0, 2);
        });
        setFocus(Math.min(to, 1));
    };
    /** ⌘\\ — the file in front, opened in the other group too (a second one made on the right). */
    const splitRight = () => {
        if (!active)
            return;
        show(active, groups.length === 1 ? 1 : focused === 0 ? 1 : 0);
    };
    const save = async (file) => {
        setProblem(null);
        try {
            await (file.where === 'home' ? home : machine).write(file.path, file.text);
            setFiles((list) => list.map((f) => (f === file ? { ...f, saved: f.text } : f)));
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
    };
    const fail = (error) => setProblem(error instanceof Error ? error.message : String(error));
    const newFile = async (dir = '') => {
        const path = window.prompt('A new file — its path in the folder:', dir ? `${dir}/` : 'train.py');
        if (!path?.trim() || path.trim().endsWith('/'))
            return;
        const clean = path.trim().replace(/^\/+/, '');
        try {
            if ((await home.read(clean).catch(() => null)) === null)
                await home.write(clean, '');
            setRefresh((n) => n + 1);
            await open('home', clean);
        }
        catch (error) {
            fail(error);
        }
    };
    const newFolder = async (dir = '') => {
        const path = window.prompt('A new folder — its path in the folder:', dir ? `${dir}/` : 'src');
        const clean = path?.trim().replace(/^\/+|\/+$/g, '');
        if (!clean)
            return;
        try {
            // A host that can't make an empty folder gets one with a placeholder in it, as git keeps one.
            if (home.mkdir)
                await home.mkdir(clean);
            else
                await home.write(`${clean}/.gitkeep`, '');
            setRefresh((n) => n + 1);
        }
        catch (error) {
            fail(error);
        }
    };
    /** A path renamed in the folder; open tabs of it, or of anything under it, follow. */
    const renamePath = async (from) => {
        if (!home.rename)
            return;
        const to = window.prompt(`Rename ${from} to:`, from)?.trim().replace(/^\/+|\/+$/g, '');
        if (!to || to === from)
            return;
        try {
            await home.rename(from, to);
            const moved = (key) => (key === `home:${from}` ? `home:${to}` : key.startsWith(`home:${from}/`) ? `home:${to}${key.slice(5 + from.length)}` : key);
            setFiles((list) => list.map((f) => (f.where === 'home' ? { ...f, path: moved(`home:${f.path}`).slice(5) } : f)));
            setGroups((list) => list.map((g) => ({ tabs: g.tabs.map(moved), active: g.active ? moved(g.active) : null })));
            setRefresh((n) => n + 1);
        }
        catch (error) {
            fail(error);
        }
    };
    /** A path deleted from the folder (Drive puts it in its trash), after asking; its tabs close. */
    const removePath = async (path, dir) => {
        if (!home.remove)
            return;
        const where = playground.home.kind === 'drive' ? ' It goes to your Drive’s trash, where it can be restored for 30 days.' : ' This can’t be undone.';
        if (!window.confirm(`Delete ${dir ? 'the folder ' : ''}${path}${dir ? ' and everything in it' : ''}?${where}`))
            return;
        try {
            await home.remove(path);
            const gone = (key) => key === `home:${path}` || key.startsWith(`home:${path}/`);
            setFiles((list) => list.filter((f) => !gone(`${f.where}:${f.path}`)));
            setGroups((list) => {
                const next = list.map((g) => {
                    const tabs = g.tabs.filter((t) => !gone(t));
                    return { tabs, active: g.active && !gone(g.active) ? g.active : tabs[tabs.length - 1] ?? null };
                });
                const kept = next.filter((g, index) => g.tabs.length || index === 0);
                return kept.length ? kept : [{ tabs: [], active: null }];
            });
            setRefresh((n) => n + 1);
        }
        catch (error) {
            fail(error);
        }
    };
    // The explorer follows the folder, as VS Code's does: a terminal, a run or an agent writes files there too. Read again
    // every few seconds while it shows and the tab is in view — a folder on a computer or the machine cheaply, Drive less often.
    useEffect(() => {
        if (primary !== 'explorer')
            return;
        const every = playground.home.kind === 'drive' ? 20_000 : 5_000;
        const timer = window.setInterval(() => document.visibilityState === 'visible' && setRefresh((n) => n + 1), every);
        return () => window.clearInterval(timer);
    }, [primary, playground.home.kind]);
    const saveAll = async () => {
        for (const file of filesRef.current)
            if (file.text !== file.saved)
                await save(file);
    };
    // Auto Save, as VS Code's afterDelay: a second after the typing stops, what has changed is saved.
    useEffect(() => {
        if (!settings.autoSave || !files.some((f) => f.text !== f.saved))
            return;
        const timer = window.setTimeout(() => void saveAll(), 1000);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files, settings.autoSave]);
    const push = async () => {
        setSyncing('push');
        setProblem(null);
        try {
            // Unsaved edits first: what is sent is what is on screen.
            for (const file of files)
                if (file.where === 'home' && file.text !== file.saved)
                    await save(file);
            const done = await pushFolder(playground, machine);
            setReport({ ...done, at: Date.now(), what: 'push' });
            return true;
        }
        catch (error) {
            setProblem(`Copying to ${machineName}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        finally {
            setSyncing(null);
        }
    };
    const pull = async () => {
        setSyncing('pull');
        try {
            const done = await pullBack(playground, machine);
            setReport({ ...done, at: Date.now(), what: 'pull' });
            if (done.back.length)
                setRefresh((n) => n + 1);
        }
        catch (error) {
            setProblem(`Bringing back from ${machineName}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            setSyncing(null);
        }
    };
    /** The folder on the machine, as an absolute path the shell can cd into: the small kernel's start, joined to the folder. */
    const folderOnMachine = async () => {
        if (base)
            return base;
        const answer = await runQuietly(`import os\nprint(os.path.abspath(${JSON.stringify(machineRoot(playground))}))`);
        const found = answer?.ok ? answer.text.trim().split('\n').pop() ?? null : null;
        if (found)
            setBase(found);
        return found ?? machineRoot(playground);
    };
    const run = async (text) => {
        const trimmed = text.trim();
        if (!trimmed || colab.running)
            return;
        setProblem(null);
        if (!connected) {
            try {
                await connect();
            }
            catch {
                return;
            }
        }
        if (split && !(await push()))
            return;
        const entry = { id: uid(), command: trimmed, at: Date.now() };
        updatePlayground(playground.id, (p) => ({ console: [...p.console, entry].slice(-40), pending: p.pending === trimmed ? undefined : p.pending }));
        setCommand('');
        const folder = await folderOnMachine();
        await runCell(consoleKey(playground.id, entry.id), shellCell(folder, trimmed));
        if (split)
            await pull();
        setRefresh((n) => n + 1);
    };
    const plan = current ? runPlan(current.path, terminalHere ? projectFolder : null, machineTools) : null;
    const runFile = async () => {
        if (!current || !plan || !('command' in plan))
            return;
        if (current.text !== current.saved)
            await save(current);
        if (terminalHere)
            inTerminal(plan.command);
        else
            void run(plan.command);
    };
    const consoleCells = playground.console.map((entry, index) => ({ key: consoleKey(playground.id, entry.id), id: entry.id, label: `command ${index + 1}` }));
    const nbCells = useSyncExternalStore(subscribeNotebook, () => notebookFor(notebookKey(playground.id)));
    const metricCells = useMemo(() => [
        ...playground.console.map((entry, index) => {
            const run = colab.runs[consoleKey(playground.id, entry.id)];
            return { key: consoleKey(playground.id, entry.id), id: entry.id, label: `$ ${entry.command.slice(0, 32)}${entry.command.length > 32 ? '…' : ''} (${index + 1})`, text: run ? run.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', at: run?.startedAt ?? entry.at };
        }),
        ...(nbCells?.cells ?? [])
            .map((cell, index) => ({ cell, index }))
            .filter(({ cell }) => cell.type === 'code')
            .map(({ cell, index }) => {
            const run = colab.runs[runKey(cell.id)];
            return { key: runKey(cell.id), id: cell.id, label: `cell ${index + 1}`, text: run ? run.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', at: run?.startedAt ?? 0 };
        }),
    ], [playground.console, colab.runs, nbCells, playground.id]);
    const dirty = current ? current.text !== current.saved : false;
    // The newest command in view from its top: what was typed, then what it printed.
    const consoleLog = useRef(null);
    useEffect(() => {
        const last = consoleLog.current?.querySelector('.pg-console-entry:last-of-type');
        if (last && consoleLog.current)
            consoleLog.current.scrollTop = last.offsetTop - 4;
    }, [playground.console.length]);
    const cited = playground.cites.map((cite) => papers.find((paper) => paper.id === cite.paperId)).find(Boolean);
    // The paper's Implementation page, when it has one: the plan goes with the agent's requests.
    useEffect(() => {
        if (cited)
            void loadImplementation(cited.id);
    }, [cited?.id]);
    const paperPlan = useSyncExternalStore(subscribeImplement, () => (cited ? implementationFor(cited.id)?.content : undefined));
    // A project from a paper starts with the model choosing and writing its files, until that is done or put aside.
    const startKey = `reader.pgStart:${playground.id}`;
    const [startState, setStartState] = useState(() => readLocal(startKey, null));
    const settleStart = (state) => (setStartState(state), writeLocal(startKey, state));
    const agentChat = useSyncExternalStore(subscribeAgent, () => agentChatFor(playground.id));
    useEffect(() => {
        if (playground.start === 'paper')
            void loadAgentChats(playground.id, home).catch(() => undefined);
    }, [playground.id, home]);
    const wroteBefore = agentChat.turns.some((turn) => turn.role === 'agent' && turn.changes?.length);
    const showStart = playground.start === 'paper' && !startState && !wroteBefore && Boolean(cited);
    /** The project as the agent reads it: the folder's files, the ones open, the last commands and what they printed. */
    const agentView = async () => ({
        where: `Files kept in ${homeLabel}; code runs on ${machineName}${split ? ', the folder copied there before each command' : ''}.`,
        paper: cited ? { title: cited.title, authors: cited.authors, published: cited.published, abstract: cited.abstract, plan: paperPlan } : undefined,
        listing: await listAll(home),
        open: files.filter((file) => file.where === 'home').map((file) => ({ path: file.path, text: file.text, active: `${file.where}:${file.path}` === active, unsaved: file.text !== file.saved })),
        console: playground.console.slice(-4).map((entry) => {
            const done = colab.runs[consoleKey(playground.id, entry.id)];
            return { command: entry.command, output: done ? done.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', state: done ? done.state : 'output not in this tab' };
        }),
    });
    /** Files the agent wrote (or put back): open ones take the new text unless edited here, and the explorer reads the folder again. */
    const tookAgentFiles = (changes) => {
        setFiles((list) => list.map((file) => {
            const change = file.where === 'home' ? changes.find((c) => c.path === file.path) : undefined;
            return change?.after !== undefined && file.text === file.saved ? { ...file, text: change.after, saved: change.after } : file;
        }));
        setRefresh((n) => n + 1);
        const first = changes.find((c) => c.after);
        if (first && !files.length)
            void open('home', first.path);
    };
    /** Open files read again from the folder, where they aren't being edited here: an agent or a run wrote them. */
    const reloadOpen = async () => {
        for (const file of filesRef.current) {
            if (file.text !== file.saved)
                continue;
            const disk = await (file.where === 'home' ? home : machine).read(file.path).catch(() => null);
            if (disk !== null && disk !== file.saved)
                setFiles((list) => list.map((f) => (f.where === file.where && f.path === file.path && f.text === f.saved ? { ...f, text: disk, saved: disk } : f)));
        }
    };
    /** Before Claude Code or Codex works: what is on screen saved, and the folder copied to the machine when it is kept elsewhere. */
    const beforeAgentRun = async () => {
        await saveAll();
        return split ? push() : true;
    };
    /** After: what it changed on the machine brought home (when the folder is kept elsewhere), and the explorer and open files read again. */
    const afterAgentRun = async () => {
        if (split) {
            try {
                const done = await pullEdits(playground, machine);
                setReport({ ...done, at: Date.now(), what: 'pull' });
            }
            catch (error) {
                setProblem(`Bringing the agent’s changes back from ${machineName}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        setRefresh((n) => n + 1);
        await reloadOpen();
    };
    // Back to the editor when a box closes — unless another has opened since (⇧⌘P, Esc, ⌘P in a row).
    const focusEditor = () => window.requestAnimationFrame(() => !document.querySelector('.vs-pick') && editors.current[focused]?.focus());
    const commands = [
        { id: 'files', label: 'Go to File…', keys: 'mod+p', run: () => setPick('') },
        { id: 'line', label: 'Go to Line/Column…', keys: 'ctrl+g', run: () => setPick(':') },
        { id: 'symbol', label: 'Go to Symbol in Editor…', keys: 'mod+shift+o', run: () => setPick('@') },
        { id: 'find', label: 'Find', keys: 'mod+f', run: () => editors.current[focused]?.openFind() },
        { id: 'replace', label: 'Replace', keys: isMac ? 'mod+alt+f' : 'ctrl+h', run: () => editors.current[focused]?.openFind(true) },
        { id: 'findFiles', label: 'Search: Find in Files', keys: 'mod+shift+f', run: () => setPrimary('search') },
        { id: 'newFile', label: 'File: New File…', run: () => void newFile() },
        { id: 'newFolder', label: 'File: New Folder…', run: () => void newFolder() },
        { id: 'save', label: 'File: Save', keys: 'mod+s', run: () => current && void save(current) },
        { id: 'saveAll', label: 'File: Save All', keys: 'mod+alt+s', run: () => void saveAll() },
        { id: 'autoSave', label: `File: ${settings.autoSave ? 'Turn Off' : 'Turn On'} Auto Save`, run: () => setSettings({ autoSave: !settings.autoSave }) },
        { id: 'close', label: 'View: Close Editor', keys: 'alt+w', run: () => active && closeTab(focused, active) },
        { id: 'closeAll', label: 'View: Close All Editors in Group', run: () => closeMany(focused, groups[focused]?.tabs ?? []) },
        { id: 'reopen', label: 'View: Reopen Closed Editor', keys: 'alt+shift+t', run: () => closed.current[0] && void open(closed.current[0].startsWith('home:') ? 'home' : 'machine', closed.current[0].slice(closed.current[0].indexOf(':') + 1)) },
        { id: 'split', label: 'View: Split Editor Right', keys: 'mod+\\', run: splitRight },
        { id: 'group1', label: 'View: Focus First Editor Group', keys: 'mod+1', run: () => (setFocus(0), focusEditor()) },
        { id: 'group2', label: 'View: Focus Second Editor Group', keys: 'mod+2', run: () => (groups.length > 1 ? (setFocus(1), focusEditor()) : splitRight()) },
        { id: 'sidebar', label: 'View: Toggle Primary Side Bar', keys: 'mod+b', run: () => setPrimary(primary ? null : 'explorer') },
        { id: 'explorer', label: 'View: Show Explorer', keys: 'mod+shift+e', run: () => setPrimary('explorer') },
        { id: 'outline', label: 'View: Show Outline', run: () => setPrimary('outline') },
        { id: 'panel', label: 'View: Toggle Panel', keys: 'mod+j', run: () => setPanelOpen(!panelOpen) },
        { id: 'terminal', label: 'View: Toggle Terminal', keys: 'ctrl+`', run: () => (setPanelOpen(!panelOpen || view !== 'terminal'), setShellView('terminal')) },
        { id: 'newTerminal', label: 'Terminal: Create New Terminal', keys: 'ctrl+shift+`', run: () => (setPanelOpen(true), setShellView('terminal'), addShell()) },
        { id: 'agent', label: 'View: Toggle Agent', keys: 'ctrl+alt+i', run: () => toggleRight('agent') },
        { id: 'runtimePane', label: 'View: Show Runtime', run: () => (setRightTab('runtime'), setAgentOpen(true)) },
        { id: 'metricsPane', label: 'View: Show Metrics', run: () => (setRightTab('metrics'), setAgentOpen(true)) },
        { id: 'tensorboard', label: 'View: Show TensorBoard', run: () => (setRightTab('tensorboard'), setAgentOpen(true)) },
        { id: 'claudeCode', label: 'Agent: Claude Code', run: () => (setAgentMode('claude'), setRightTab('agent'), setAgentOpen(true)) },
        { id: 'codex', label: 'Agent: Codex', run: () => (setAgentMode('codex'), setRightTab('agent'), setAgentOpen(true)) },
        { id: 'zen', label: 'View: Toggle Zen Mode', keys: 'mod+k z', run: () => setZen(!zen) },
        { id: 'minimap', label: 'View: Toggle Minimap', run: () => setSettings({ minimap: !settings.minimap }) },
        { id: 'zoomIn', label: 'View: Editor Font Bigger', keys: 'mod+=', run: () => setSettings({ fontSize: Math.min(24, settings.fontSize + 1) }) },
        { id: 'zoomOut', label: 'View: Editor Font Smaller', keys: 'mod+-', run: () => setSettings({ fontSize: Math.max(10, settings.fontSize - 1) }) },
        { id: 'zoomReset', label: 'View: Reset Editor Font Size', keys: 'mod+0', run: () => setSettings({ fontSize: DEFAULT_EDITOR.fontSize }) },
        ...(current && plan && 'command' in plan ? [{ id: 'run', label: `Run: ${plan.command}`, keys: 'mod+enter', run: () => void runFile() }] : []),
        ...(split ? [{ id: 'push', label: `Sync: Copy the Folder to ${machineName}`, run: () => void push() }, { id: 'pull', label: `Sync: Bring Results Back from ${machineName}`, run: () => void pull() }] : []),
        { id: 'refresh', label: 'Explorer: Refresh', run: () => setRefresh((n) => n + 1) },
        { id: 'newChat', label: 'Agent: New Chat', run: () => (setAgentOpen(true), clearAgentChat(playground.id, home)) },
        ...(vscodeAt ? [{ id: 'vscode', label: 'Open in VS Code (in the page)', run: () => updatePlayground(playground.id, () => ({ editor: 'vscode' })) }] : []),
    ];
    const commandsRef = useRef(commands);
    commandsRef.current = commands;
    // The workbench's keys, VS Code's, while the page is on it: taken before the site's own (⌘J, ⌘\\ mean the panel and split here).
    const chord = useRef(false);
    useEffect(() => {
        const onKey = (event) => {
            if (pick !== null || !root.current)
                return;
            const target = document.activeElement;
            if (target && target !== document.body && !root.current.contains(target))
                return;
            if (target instanceof HTMLElement && target.closest('.xterm') && !(event.metaKey || event.ctrlKey))
                return;
            const parts = [event.ctrlKey && !isMac ? 'mod' : event.ctrlKey ? 'ctrl' : '', event.metaKey && isMac ? 'mod' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : ''].filter(Boolean);
            const key = event.code === 'Backquote' ? '`' : event.code === 'Backslash' ? '\\' : event.code === 'Equal' ? '=' : event.code === 'Minus' ? '-' : event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.startsWith('Digit') ? event.code.slice(5) : event.key === 'Enter' ? 'enter' : event.key === 'F1' ? 'F1' : '';
            if (!key)
                return;
            const combo = [...parts, key].join('+');
            if (chord.current) {
                chord.current = false;
                const hit = commandsRef.current.find((c) => c.keys === `mod+k ${combo}`);
                if (hit) {
                    event.preventDefault();
                    event.stopPropagation();
                    hit.run();
                }
                return;
            }
            if (combo === 'mod+k') {
                chord.current = true;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (combo === 'mod+shift+p' || combo === 'F1') {
                event.preventDefault();
                event.stopPropagation();
                setPick('>');
                return;
            }
            // ⌘F and ⌘H inside the editor are its own (it opens its find bar); from anywhere else in the workbench, the focused editor's.
            const inEditor = target instanceof HTMLTextAreaElement && target.classList.contains('ce-text');
            const hit = commandsRef.current.find((c) => c.keys === combo && !(inEditor && (c.id === 'find' || c.id === 'replace')));
            if (!hit)
                return;
            event.preventDefault();
            event.stopPropagation();
            hit.run();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [pick]);
    // Zen mode leaves with Escape, as VS Code's does with a second press.
    useEffect(() => {
        if (!zen)
            return;
        const onKey = (event) => event.key === 'Escape' && !document.querySelector('.ce-find') && setZen(false);
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [zen]);
    const symbols = useMemo(() => (current ? symbolsOf(current.text, current.path) : []), [current?.text, current?.path]);
    if (vscodeAt && playground.editor === 'vscode') {
        return _jsx(VsCodePane, { server: vscodeAt.server, folder: vscodeAt.folder, playground: playground });
    }
    const cliAgents = Boolean(terminals && computeServer && isCompanion(computeServer));
    const mode = agentMode === 'cli' && !cliAgents ? 'claude' : agentMode;
    const agentChoices = [
        { id: 'claude', label: 'Claude Code', mark: '✳', title: `Anthropic’s Claude Code, on ${machineName}, signed in to your account` },
        { id: 'codex', label: 'Codex', mark: '◎', title: `OpenAI’s Codex, on ${machineName}, signed in to your account` },
        { id: 'reader', label: 'Reader AI', mark: '✦', title: 'The page’s own agent, answered by the model you pick in Settings → AI' },
        ...(cliAgents ? [{ id: 'cli', label: 'Terminal', mark: '$', title: `Any agent with a command line, in a terminal on ${machineName}` }] : []),
    ];
    const sideKey = mode === 'cli' ? 'agent' : 'side';
    const views = [
        { id: 'explorer', label: 'Explorer', icon: _jsx(FilesGlyph, {}), keys: 'mod+shift+e' },
        { id: 'search', label: 'Search', icon: _jsx(SearchIcon, { size: 19 }), keys: 'mod+shift+f' },
        { id: 'outline', label: 'Outline', icon: _jsx(OutlineGlyph, {}) },
        { id: 'sync', label: `Sync with ${machineName}`, icon: _jsx(SyncGlyph, {}), hidden: !split },
    ];
    const togglePrimary = (id) => setPrimary(primary === id ? null : id);
    const fileOf = (key) => (key ? files.find((f) => `${f.where}:${f.path}` === key) ?? null : null);
    const canEdit = { rename: Boolean(home.rename), remove: Boolean(home.remove) };
    const copy = (text) => void navigator.clipboard?.writeText(text).catch(() => undefined);
    const openMenu = (event, items) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY, items });
    };
    /** The explorer's right-click menu, on a file, a folder, or the empty space under them. */
    const explorerMenu = (event, entry) => {
        const dir = entry ? (entry.dir ? entry.path : entry.path.split('/').slice(0, -1).join('/')) : '';
        openMenu(event, [
            ...(entry && !entry.dir ? [{ label: 'Open', run: () => void open('home', entry.path) }, { label: 'Open to the Side', run: () => void open('home', entry.path, { group: groups.length === 1 ? 1 : focused === 0 ? 1 : 0 }) }, 'sep'] : []),
            { label: 'New File…', run: () => void newFile(dir) },
            { label: 'New Folder…', run: () => void newFolder(dir) },
            ...(entry
                ? [
                    'sep',
                    { label: 'Copy Path', run: () => copy(entry.path) },
                    'sep',
                    { label: 'Rename…', run: () => void renamePath(entry.path), disabled: !canEdit.rename },
                    { label: 'Delete', run: () => void removePath(entry.path, entry.dir), disabled: !canEdit.remove, danger: true },
                ]
                : ['sep', { label: 'Refresh', run: () => setRefresh((n) => n + 1) }]),
        ]);
    };
    const tabMenu = (event, group, key) => {
        const tabs = groups[group]?.tabs ?? [];
        const at = tabs.indexOf(key);
        const file = fileOf(key);
        openMenu(event, [
            { label: 'Close', keys: keyLabel('alt+w'), run: () => closeTab(group, key) },
            { label: 'Close Others', run: () => closeMany(group, tabs.filter((t) => t !== key)), disabled: tabs.length < 2 },
            { label: 'Close to the Right', run: () => closeMany(group, tabs.slice(at + 1)), disabled: at === tabs.length - 1 },
            { label: 'Close Saved', run: () => closeMany(group, tabs.filter((t) => { const f = fileOf(t); return f && f.text === f.saved; })) },
            { label: 'Close All', run: () => closeMany(group, tabs) },
            'sep',
            { label: 'Copy Path', run: () => file && copy(file.path) },
            { label: 'Reveal in Explorer', run: () => setPrimary('explorer') },
            'sep',
            groups.length === 1 ? { label: 'Split Right', keys: keyLabel('mod+\\'), run: () => show(key, 1) } : { label: `Move to the ${group === 0 ? 'Right' : 'Left'} Group`, run: () => moveTab(group, key, group === 0 ? 1 : 0) },
        ]);
    };
    /** One editor group: its tabs, the breadcrumbs, the editor; a drop target for a tab dragged from the other. */
    const renderGroup = (g, index) => {
        const file = fileOf(g.active);
        const isFocused = index === focused;
        const fileDirty = file ? file.text !== file.saved : false;
        const filePlan = file ? runPlan(file.path, terminalHere ? projectFolder : null, machineTools) : null;
        const path = file ? symbolPath(isFocused ? symbols : symbolsOf(file.text, file.path), isFocused ? cursor?.line ?? 1 : 1) : [];
        return (_jsxs("section", { className: `vs-group${isFocused ? ' is-focused' : ''}`, style: groups.length > 1 ? { flexBasis: `${index === 0 ? splitAt : 100 - splitAt}%` } : undefined, onMouseDown: () => index !== focused && setFocus(index), onDragOver: (event) => dragging && event.preventDefault(), onDrop: (event) => {
                event.preventDefault();
                if (dragging)
                    moveTab(dragging.group, dragging.key, index);
                setDragging(null);
            }, children: [_jsxs("div", { className: "pg-tabs vs-tabs", role: "tablist", "aria-label": groups.length > 1 ? `Editor group ${index + 1}` : 'Open editors', children: [g.tabs.map((key) => {
                            const tab = fileOf(key);
                            if (!tab)
                                return null;
                            const dirtyTab = tab.text !== tab.saved;
                            return (_jsxs("span", { className: `pg-tab vs-tab${key === g.active ? ' is-on' : ''}${dirtyTab ? ' is-dirty' : ''}`, draggable: true, onDragStart: (event) => {
                                    event.dataTransfer.effectAllowed = 'move';
                                    event.dataTransfer.setData('text/plain', tab.path);
                                    setDragging({ group: index, key });
                                }, onDragEnd: () => setDragging(null), onAuxClick: (event) => event.button === 1 && closeTab(index, key), onContextMenu: (event) => tabMenu(event, index, key), children: [_jsxs("button", { type: "button", role: "tab", "aria-selected": key === g.active, onClick: () => show(key, index), title: `${tab.where === 'home' ? homeLabel : machineName} · ${tab.path}`, children: [_jsx(FileIcon, { path: tab.path }), tab.where === 'machine' ? '⇣ ' : '', tab.path.split('/').pop()] }), _jsxs("button", { type: "button", className: "pg-tab-x", "aria-label": `Close ${tab.path}`, title: `Close (${keyLabel('alt+w')})`, onClick: () => closeTab(index, key), children: [_jsx("span", { className: "vs-dot", "aria-hidden": "true", children: "\u25CF" }), _jsx("span", { className: "vs-x", "aria-hidden": "true", children: "\u00D7" })] })] }, key));
                        }), _jsx("span", { className: "vs-tabs-fill" }), file ? (_jsxs("span", { className: "vs-tab-actions", children: [filePlan ? (_jsx("button", { type: "button", className: "vs-action is-run", disabled: !('command' in filePlan) || !usable, onClick: () => (setFocus(index), void runFile()), title: 'command' in filePlan ? `${filePlan.command}${asked ? '' : ` (${machineName} couldn’t say what is installed: this is a guess)`} — ${keyLabel('mod+enter')}` : `Running ${filePlan.language} needs ${filePlan.missing} on ${machineName}`, "aria-label": "Run the file", children: "\u25B6" })) : null, _jsx("button", { type: "button", className: "vs-action", onClick: () => (setFocus(index), groups.length === 1 ? show(g.active, 1) : show(g.active, index === 0 ? 1 : 0)), title: `Split Editor Right (${keyLabel('mod+\\')})`, "aria-label": "Split the editor", children: _jsx(SplitGlyph, {}) }), _jsx("button", { type: "button", className: "vs-action", onClick: (event) => openMenu(event, [
                                        { label: 'Close All', run: () => closeMany(index, g.tabs) },
                                        { label: 'Close Saved', run: () => closeMany(index, g.tabs.filter((t) => { const f = fileOf(t); return f && f.text === f.saved; })) },
                                        'sep',
                                        { label: settings.minimap ? 'Hide Minimap' : 'Show Minimap', run: () => setSettings({ minimap: !settings.minimap }) },
                                        { label: settings.autoSave ? 'Turn Off Auto Save' : 'Turn On Auto Save', run: () => setSettings({ autoSave: !settings.autoSave }) },
                                    ]), title: "More Actions\u2026", "aria-label": "More actions", children: "\u22EF" })] })) : null] }), file ? (_jsxs("div", { className: "vs-crumbs", children: [[file.where === 'home' ? homeLabel : machineName, ...file.path.split('/')].map((part, i, all) => (_jsxs("span", { className: i === all.length - 1 && !path.length ? 'is-last' : '', children: [i === all.length - 1 ? _jsx(FileIcon, { path: part }) : null, part] }, `${i}-${part}`))), path.map((symbol, i) => (_jsxs("button", { type: "button", className: `vs-crumb-sym is-${symbol.kind}${i === path.length - 1 ? ' is-last' : ''}`, onClick: () => (setFocus(index), setPick('@')), title: "Go to Symbol in Editor", children: [_jsx(SymbolMark, { kind: symbol.kind }), symbol.name] }, `${symbol.line}-${symbol.name}`))), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "vs-action", disabled: !fileDirty, onClick: () => void save(file), title: keyLabel('mod+s'), children: fileDirty ? 'Save' : settings.autoSave ? 'Auto Save' : 'Saved' }), vscodeHere && index === groups.length - 1 ? _jsx(EditorSwitch, { playground: playground }) : null] })) : null, _jsxs("div", { className: "vs-editor", children: [file ? (_jsx(CodeEditor, { ref: (handle) => (editors.current[index] = handle), value: file.text, path: file.path, fontSize: settings.fontSize, minimap: settings.minimap, onChange: (text) => setFiles((list) => list.map((f) => (f.where === file.where && f.path === file.path ? { ...f, text } : f))), onCursor: isFocused ? setCursor : undefined, onFocus: () => setFocus(index) }, g.active)) : (_jsxs("div", { className: "pg-editor-empty vs-welcome", children: [_jsx("b", { children: playground.title }), _jsx("dl", { className: "vs-keys", children: [
                                        ['Show All Commands', 'mod+shift+p'],
                                        ['Go to File', 'mod+p'],
                                        ['Find in Files', 'mod+shift+f'],
                                        ['Toggle Panel', 'mod+j'],
                                        ['Toggle Agent', 'ctrl+alt+i'],
                                    ].map(([label, combo]) => (_jsxs(Fragment, { children: [_jsx("dt", { children: label }), _jsx("dd", { children: _jsx("kbd", { children: keyLabel(combo) }) })] }, label))) }), _jsxs("div", { className: "vs-welcome-keys", children: [_jsx("button", { type: "button", className: "link", onClick: () => void newFile(), children: "New file\u2026" }), _jsx("button", { type: "button", className: "link", onClick: () => setPick(''), children: "Open a file\u2026" }), _jsx("button", { type: "button", className: "link", onClick: () => setAgentOpen(true), children: "Ask the agent" }), vscodeHere ? _jsx(EditorSwitch, { playground: playground }) : null] }), _jsx("p", { className: "pg-note", children: playground.home.kind === 'server'
                                        ? `The folder is ${playground.home.root} on ${serverById(playground.home.serverId)?.name ?? 'the server'} — a plain folder: edit it in any editor too.`
                                        : playground.home.kind === 'drive'
                                            ? `The files are kept in your Google Drive, in Papers_collection/Playgrounds/${playground.home.folder}${split ? `, and copied onto ${machineName} before each command` : ''}.`
                                            : playground.home.kind === 'machine'
                                                ? playground.compute.kind === 'colab'
                                                    ? 'The files are on the Colab runtime’s disk: they go when it stops. Change the machine to keep them in Drive.'
                                                    : `The files are on ${machineName}.`
                                                : 'These files are still kept in this browser: move them out from the banner above.' })] })), dragging && groups.length === 1 ? (_jsx("div", { className: "vs-drop-split", onDragOver: (event) => event.preventDefault(), onDrop: (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                moveTab(dragging.group, dragging.key, 1);
                                setDragging(null);
                            }, children: "Drop to split right" })) : null] }), file && onDisk && onDisk.key === `${file.where}:${file.path}` ? (_jsxs("div", { className: "pg-banner pg-disk-banner", children: [file.path.split('/').pop(), " changed in its folder while you were editing it here.", _jsx("button", { type: "button", className: "btn sm", onClick: () => (setFiles((list) => list.map((f) => (f === file ? { ...f, text: onDisk.text, saved: onDisk.text } : f))), setOnDisk(null)), children: "Load it" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => ((dismissed.current = onDisk), setOnDisk(null)), title: "Keep what is here; Save writes it over the folder's", children: "Keep mine" })] })) : null] }, index));
    };
    const openEditors = groups.flatMap((g, index) => g.tabs.map((key) => ({ key, group: index })));
    return (_jsxs("div", { className: `vs-shell${zen ? ' is-zen' : ''}`, ref: root, children: [_jsxs("div", { className: `pg-files vs-work${layout.big ? ` is-big-${layout.big}` : ''}${!panelOpen ? ' is-panel-closed' : ''}`, style: { '--pg-tree-w': `${Math.max(layout.tree, 200)}px`, '--pg-side-w': `${layout[sideKey]}px`, '--pg-console-h': `${layout.console}%` }, children: [!zen ? (_jsxs("nav", { className: "vs-activity", "aria-label": "Views", children: [views
                                .filter((v) => !v.hidden)
                                .map((v) => (_jsx("button", { type: "button", className: `vs-act${primary === v.id ? ' is-on' : ''}`, "aria-pressed": primary === v.id, onClick: () => togglePrimary(v.id), title: `${v.label}${v.keys ? ` (${keyLabel(v.keys)})` : ''}`, "aria-label": v.label, children: v.icon }, v.id))), _jsx("span", { className: "spacer" }), vscodeHere ? (_jsx("button", { type: "button", className: "vs-act", onClick: () => updatePlayground(playground.id, () => ({ editor: 'vscode' })), title: "Open in VS Code \u2014 the VS Code on that computer, in the page, with your extensions", "aria-label": "Open in VS Code", children: _jsx(VsCodeMark, {}) })) : null, _jsx("button", { type: "button", className: "vs-act", onClick: () => setPick('>'), title: `Command Palette (${keyLabel('mod+shift+p')})`, "aria-label": "Command palette", children: _jsx(PaletteGlyph, {}) }), _jsx("span", { className: "vs-act-sep", "aria-hidden": "true" }), _jsx("button", { type: "button", className: `vs-act${agentOpen && rightTab === 'runtime' ? ' is-on is-right' : ''}`, "aria-pressed": agentOpen && rightTab === 'runtime', onClick: () => toggleRight('runtime'), title: "Runtime \u2014 GPU, memory, disk (in the right-hand pane)", "aria-label": "Runtime", children: _jsx(GaugeGlyph, {}) }), _jsx("button", { type: "button", className: `vs-act${agentOpen && rightTab === 'metrics' ? ' is-on is-right' : ''}`, "aria-pressed": agentOpen && rightTab === 'metrics', onClick: () => toggleRight('metrics'), title: "Metrics the runs print (in the right-hand pane)", "aria-label": "Metrics", children: _jsx(ChartIcon, { size: 19 }) }), _jsx("button", { type: "button", className: `vs-act${agentOpen && rightTab === 'tensorboard' ? ' is-on is-right' : ''}`, "aria-pressed": agentOpen && rightTab === 'tensorboard', onClick: () => toggleRight('tensorboard'), title: "TensorBoard\u2019s scalars (in the right-hand pane)", "aria-label": "TensorBoard", children: _jsx(TbGlyph, {}) }), _jsx("button", { type: "button", className: `vs-act is-agent${agentOpen && rightTab === 'agent' ? ' is-on is-right' : ''}`, "aria-pressed": agentOpen && rightTab === 'agent', onClick: () => toggleRight('agent'), title: `The agent — Claude Code, Codex (${keyLabel('ctrl+alt+i')})`, "aria-label": "The agent", children: _jsx(SparkleIcon, { size: 19 }) })] })) : null, primary && !zen ? (_jsxs("aside", { className: "pg-tree vs-sidebar", children: [_jsxs("div", { className: "vs-side-title", children: [_jsx("span", { children: views.find((v) => v.id === primary)?.label.split(' —')[0] }), primary === 'explorer' ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "icon-btn sm", onClick: () => void newFile(), title: "New File\u2026", "aria-label": "New file", children: _jsx(PlusIcon, { size: 14 }) }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => void newFolder(), title: "New Folder\u2026", "aria-label": "New folder", children: _jsx(FolderPlusGlyph, {}) }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => setRefresh((n) => n + 1), title: "Refresh Explorer", "aria-label": "Refresh", children: "\u21BB" })] })) : null] }), primary === 'explorer' ? (_jsxs("div", { className: "vs-explorer", onContextMenu: (event) => explorerMenu(event, null), children: [openEditors.length ? (_jsx(OpenEditors, { items: openEditors.map(({ key, group }) => ({ key, group, file: fileOf(key) })).filter((item) => Boolean(item.file)), split: groups.length > 1, activeKey: active, focusedGroup: focused, onShow: (key, group) => show(key, group), onClose: (key, group) => closeTab(group, key) })) : null, _jsx(Tree, { version: refresh, host: home, label: homeLabel, icon: playground.home.kind === 'drive' ? _jsx(DriveMark, { size: 12 }) : undefined, onOpen: (path) => void open('home', path), activePath: current?.where === 'home' ? current.path : null, onContext: explorerMenu }), split ? _jsx(Tree, { version: refresh + (connected ? 1000 : 0), host: machine, label: `On ${machineName}`, note: connected ? undefined : 'Connect to see the folder on the machine.', disabled: !connected, onOpen: (path) => void open('machine', path), activePath: current?.where === 'machine' ? current.path : null }) : null] })) : primary === 'search' ? (_jsx(SearchView, { host: home, onOpen: (path, line) => void open('home', path, { line }) })) : primary === 'outline' ? (_jsx(OutlineView, { file: current, symbols: symbols, line: cursor?.line ?? 1, onGo: (line) => editors.current[focused]?.goToLine(line) })) : primary === 'sync' && split ? (_jsx(SyncPane, { playground: playground, homeLabel: homeLabel, machineName: machineName, report: report, syncing: syncing, connected: connected, onPush: () => void push(), onPull: () => void pull() })) : null] })) : null, primary && !zen ? (_jsx(Gutter, { axis: "x", label: "The side bar\u2019s width", onStart: () => (dragFrom.current = layout), onMove: (delta) => {
                            const width = dragFrom.current.tree + delta;
                            if (width < TREE_FOLD)
                                setPrimary(null);
                            else
                                setLayout({ tree: width });
                        }, onReset: () => setLayout({ tree: DEFAULT_LAYOUT.tree }) })) : null, _jsxs("section", { className: "pg-center", ref: centerBox, children: [showStart && cited ? (_jsx("div", { className: "pg-write-wrap", children: _jsx(ProjectStart, { projectId: playground.id, host: home, machineName: machineName, paperTitle: cited.title, hasPlan: Boolean(paperPlan), view: agentView, onWriting: () => (setAgentMode('reader'), setRightTab('agent'), setAgentOpen(true)), onWrote: (changes) => {
                                        tookAgentFiles(changes);
                                        const first = changes.find((c) => c.path === 'main.py' && c.after) ?? changes.find((c) => c.after && !/\.md$/.test(c.path));
                                        if (first)
                                            void open('home', first.path);
                                    }, onDone: () => settleStart('done'), onDismiss: () => settleStart('dismissed') }) })) : null, _jsxs("div", { className: `vs-groups${groups.length > 1 ? ' is-split' : ''}`, ref: groupsBox, hidden: showStart, children: [renderGroup(groups[0], 0), groups.length > 1 ? (_jsx(Gutter, { axis: "x", label: "The editor groups\u2019 widths", onStart: () => (splitFrom.current = splitAt), onMove: (delta) => setSplitAt(Math.min(85, Math.max(15, splitFrom.current + (delta / Math.max(1, groupsBox.current?.clientWidth ?? 1)) * 100))), onReset: () => setSplitAt(50) })) : null, groups.length > 1 ? renderGroup(groups[1], 1) : null] }), problem ? (_jsxs("p", { className: "pg-note is-problem vs-problem", children: [problem, _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Dismiss", onClick: () => setProblem(null), children: _jsx(CloseIcon, { size: 12 }) })] })) : null, panelOpen && !zen && layout.big !== 'console' ? (_jsx(Gutter, { axis: "y", label: "The panel\u2019s height", onStart: () => (dragFrom.current = layout), onMove: (delta) => setLayout({ console: dragFrom.current.console - (delta / Math.max(1, centerBox.current?.clientHeight ?? 1)) * 100 }), onReset: () => setLayout({ console: DEFAULT_LAYOUT.console }) })) : null, _jsxs("div", { className: `pg-console vs-panel${view === 'terminal' ? ' is-terminal' : ''}`, hidden: !panelOpen || zen, children: [_jsxs("div", { className: "pg-console-head vs-panel-head", children: [_jsxs("div", { className: "vs-panel-tabs", role: "tablist", "aria-label": "Panel", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": view === 'terminal', className: view === 'terminal' ? 'is-on' : '', onClick: () => setShellView('terminal'), title: kernelTerms ? `A shell on ${machineName}, run through its kernel` : `A shell on ${machineName}`, children: "Terminal" }), _jsx("button", { type: "button", role: "tab", "aria-selected": view === 'commands', className: view === 'commands' ? 'is-on' : '', onClick: () => setShellView('commands'), children: split ? 'Copy & run' : 'Console' })] }), view === 'terminal' ? (_jsxs("div", { className: "pg-shell-tabs", role: "tablist", "aria-label": "Terminals", children: [shells.map((id, index) => (_jsxs("span", { className: `pg-shell-tab${id === activeShell ? ' is-on' : ''}`, children: [_jsx("button", { type: "button", role: "tab", "aria-selected": id === activeShell, onClick: () => setActiveShell(id), children: index + 1 }), shells.length > 1 ? (_jsx("button", { type: "button", className: "pg-tab-x", "aria-label": `Close terminal ${index + 1}`, title: "Close this terminal (its shell ends)", onClick: () => closeShell(id), children: "\u00D7" })) : null] }, id))), _jsx("button", { type: "button", className: "icon-btn sm", onClick: addShell, "aria-label": "A new terminal", title: `New Terminal (${keyLabel('ctrl+shift+`')})`, children: "+" })] })) : null, _jsxs("span", { className: "vs-panel-where", title: `${machineName}:${base ?? machineRoot(playground)}`, children: [_jsx("span", { className: "vs-panel-machine", children: machineName }), _jsx("span", { className: "vs-panel-sep", "aria-hidden": "true", children: "\u203A" }), _jsx("span", { className: "vs-panel-folder", children: (base ?? machineRoot(playground)).split('/').filter(Boolean).pop() })] }), _jsx("span", { className: "spacer" }), split ? (_jsxs("button", { type: "button", className: `vs-copy-chip${syncing === 'push' ? ' is-busy' : ''}`, disabled: !connected || Boolean(syncing), onClick: () => void push(), title: `${view === 'terminal' ? 'The terminal works in' : 'Commands run in'} ${machineName}’s copy of the folder, which is kept in ${homeLabel}. ▶ Run and Copy & run copy it over first; this copies it now.`, children: [_jsx(SyncGlyph, {}), _jsxs("span", { children: [machineName.split(' · ')[0], "\u2019s copy"] }), _jsx("b", { children: syncing === 'push' ? 'Copying…' : report?.what === 'push' && Date.now() - report.at < 60_000 ? `✓ ${report.sent.length} copied` : '↑ Copy now' })] })) : null, view === 'commands' && colab.running?.startsWith('pgsh:') ? (_jsx("button", { type: "button", className: "btn sm colab-stop", onClick: () => void interrupt(), children: "\u25A0 Stop" })) : null, _jsx("button", { type: "button", className: `icon-btn sm${layout.big === 'console' ? ' is-on' : ''}`, onClick: () => setLayout({ big: layout.big === 'console' ? null : 'console' }), "aria-pressed": layout.big === 'console', title: layout.big === 'console' ? 'Restore Panel Size' : 'Maximize Panel Size', "aria-label": layout.big === 'console' ? 'Restore the panel' : 'Maximise the panel', children: layout.big === 'console' ? '⤡' : '⤢' }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => (setPanelOpen(false), layout.big === 'console' && setLayout({ big: null })), "aria-label": "Hide the panel", title: `Hide Panel (${keyLabel('mod+j')})`, children: _jsx(CloseIcon, { size: 13 }) })] }), view === 'terminal'
                                        ? shells.map((id) => (_jsx("div", { className: "pg-terminal-slot", hidden: id !== activeShell, children: kernelTerms || !computeServer ? _jsx(KernelTerminal, { name: id, cwd: machineRoot(playground), label: machineName, connected: connected, playgroundId: playground.id }) : _jsx(Terminal, { server: computeServer, cwd: machineRoot(playground), sessionId: id, label: machineName, playgroundId: playground.id }) }, id)))
                                        : null, _jsx("div", { className: "pg-console-log", ref: consoleLog, hidden: view === 'terminal', children: playground.console.slice(-12).map((entry) => {
                                            const key = consoleKey(playground.id, entry.id);
                                            const runNow = colab.runs[key];
                                            return (_jsxs("div", { className: "pg-console-entry", children: [_jsxs("div", { className: "pg-console-cmd", children: [_jsx("span", { className: "pg-prompt", children: "$" }), " ", entry.command, _jsx("button", { type: "button", className: "link", onClick: () => setCommand(entry.command), title: "Put it in the box again", children: "again" })] }), runNow ? _jsx(CellRunOutput, { run: runNow, onForget: () => forgetRun(key) }) : _jsxs("div", { className: "pg-note", children: ["ran ", new Date(entry.at).toLocaleString(), " \u2014 the output was in that tab"] })] }, entry.id));
                                        }) }), _jsxs("form", { hidden: view === 'terminal', className: "pg-console-input", onSubmit: (event) => {
                                            event.preventDefault();
                                            void run(command);
                                        }, children: [_jsx("span", { className: "pg-prompt", children: "$" }), _jsx("input", { value: command, onChange: (event) => setCommand(event.target.value), placeholder: `A command, run in a shell on ${machineName} — python main.py, pip install …, nvidia-smi`, spellCheck: false, "aria-label": "A command", disabled: !usable }), _jsx("button", { type: "submit", className: "btn sm primary", disabled: !usable || !command.trim() || Boolean(colab.running), children: split ? 'Copy & run' : 'Run' })] })] })] }), agentOpen && !zen ? (_jsx(Gutter, { axis: "x", className: "is-side", label: "The agent\u2019s width", onStart: () => (dragFrom.current = layout), onMove: (delta) => setLayout({ [sideKey]: dragFrom.current[sideKey] - delta, big: null }), onReset: () => setLayout({ [sideKey]: DEFAULT_LAYOUT[sideKey], big: null }) })) : null, agentOpen && !zen ? (_jsxs("aside", { className: `nb-side pg-side-pane vs-agent vs-right${rightTab === 'agent' && mode === 'cli' ? ' is-agent' : ''}`, children: [_jsxs("div", { className: "vs-agent-head vs-right-tabs", role: "tablist", "aria-label": "The right-hand pane", children: [RIGHT_TABS.map((tab) => (_jsx("button", { type: "button", role: "tab", "aria-selected": rightTab === tab.id, className: rightTab === tab.id ? 'is-on' : '', onClick: () => setRightTab(tab.id), title: tab.title, children: tab.label }, tab.id))), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: `icon-btn sm${layout.big === 'side' ? ' is-on' : ''}`, onClick: () => setLayout({ big: layout.big === 'side' ? null : 'side' }), "aria-pressed": layout.big === 'side', title: layout.big === 'side' ? 'Back to its width' : 'Give the pane most of the width', "aria-label": layout.big === 'side' ? 'Restore the pane' : 'Widen the pane', children: layout.big === 'side' ? '⤡' : '⤢' }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => setAgentOpen(false), "aria-label": "Close the pane", children: _jsx(CloseIcon, { size: 14 }) })] }), rightTab === 'agent' ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "vs-agent-pick", role: "radiogroup", "aria-label": "Which agent", children: agentChoices.map((choice) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": mode === choice.id, className: mode === choice.id ? 'is-on' : '', onClick: () => setAgentMode(choice.id), title: choice.title, children: [_jsx("span", { className: `cli-badge is-${choice.id} is-sm`, children: choice.mark }), choice.label] }, choice.id))) }), mode === 'cli' ? (_jsx(AgentPane, { server: computeServer, machineName: machineName, agents: machineTools.agents, asked: asked, cwd: machineRoot(playground), inFolder: inFolder, playgroundId: playground.id })) : mode === 'claude' || mode === 'codex' ? (_jsx(CliAgent, { agent: mode, projectId: playground.id, host: home, machineName: machineName, folder: machineRoot(playground), connected: connected, onConnect: () => void connect().catch(() => undefined), beforeRun: beforeAgentRun, afterRun: () => void afterAgentRun(), onOpen: (path) => void open('home', path) }, mode)) : (_jsx(ProjectAgent, { projectId: playground.id, host: home, machineName: machineName, view: agentView, context: { active: current?.path, open: files.length, commands: Math.min(4, playground.console.length), paper: cited?.title }, onOpen: (path) => void open('home', path), onRun: (line) => {
                                            setPanelOpen(true);
                                            if (terminalHere)
                                                inTerminal(line);
                                            else
                                                void run(line);
                                        }, onWrote: tookAgentFiles }))] })) : rightTab === 'runtime' ? (connected ? _jsx(RuntimePane, { cells: consoleCells, onGoTo: () => undefined }) : _jsxs("p", { className: "pg-note pg-pad", children: ["Connect from the bar, or run a command, and ", machineName, " is read here: GPU, memory, disk, live."] })) : rightTab === 'metrics' ? (_jsx(MetricsPane, { cells: metricCells, running: colab.running })) : (_jsx(TensorBoardPane, { folder: machineRoot(playground), connected: connected, machineName: machineName, busy: colab.status === 'busy' }))] })) : null] }), zen ? (_jsx("button", { type: "button", className: "vs-zen-exit", onClick: () => setZen(false), children: "Zen mode \u00B7 Esc to leave" })) : (_jsxs("footer", { className: "vs-status", "aria-label": "Status", children: [_jsxs("span", { className: `vs-status-item is-machine is-${connected ? 'on' : colab.status === 'connecting' ? 'busy' : 'off'}`, title: `Runs on ${machineName}`, children: [_jsx("span", { className: "colab-dot", "aria-hidden": "true" }), " ", machineName, colab.status === 'busy' ? ' · running' : connected ? '' : ' · not connected'] }), playground.home.kind !== 'machine' ? (_jsxs("span", { className: "vs-status-item", title: "Where the files are kept", children: [playground.home.kind === 'drive' ? _jsx(DriveMark, { size: 11 }) : null, " ", homeLabel] })) : null, split ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "vs-status-item is-btn", disabled: !connected || Boolean(syncing), onClick: () => void push(), title: `Copy the folder to ${machineName}`, children: syncing === 'push' ? 'Copying…' : '↑ Copy' }), _jsx("button", { type: "button", className: "vs-status-item is-btn", disabled: !connected || Boolean(syncing), onClick: () => void pull(), title: `Bring results back from ${machineName}`, children: syncing === 'pull' ? 'Bringing back…' : '↓ Bring back' })] })) : null, _jsx("span", { className: "spacer" }), current && cursor ? (_jsxs(_Fragment, { children: [_jsxs("button", { type: "button", className: "vs-status-item is-btn", onClick: () => setPick(':'), title: `Go to Line/Column (${keyLabel('ctrl+g')})`, children: ["Ln ", cursor.line, ", Col ", cursor.col, cursor.selected ? ` (${cursor.selected} selected)` : ''] }), _jsx("span", { className: "vs-status-item", children: "Spaces: 4" }), _jsx("span", { className: "vs-status-item", children: "UTF-8" }), _jsx("span", { className: "vs-status-item", children: "LF" })] })) : null, current ? _jsx("span", { className: "vs-status-item", children: languageOf(current.path) }) : null, settings.autoSave ? (_jsx("button", { type: "button", className: "vs-status-item is-btn", onClick: () => setSettings({ autoSave: false }), title: "Auto Save is on: a second after typing stops, changes are saved. Click to turn it off.", children: "Auto Save" })) : current ? (_jsx("span", { className: "vs-status-item", children: dirty ? '● Unsaved' : 'Saved' })) : null, settings.fontSize !== DEFAULT_EDITOR.fontSize ? (_jsxs("button", { type: "button", className: "vs-status-item is-btn", onClick: () => setSettings({ fontSize: DEFAULT_EDITOR.fontSize }), title: `Reset the editor's font size (${keyLabel('mod+0')})`, children: [settings.fontSize, "px"] })) : null, _jsx("button", { type: "button", className: `vs-status-item is-btn${panelOpen ? ' is-on' : ''}`, onClick: () => setPanelOpen(!panelOpen), title: `Toggle Panel (${keyLabel('mod+j')})`, children: view === 'terminal' ? 'Terminal' : 'Console' }), _jsxs("button", { type: "button", className: `vs-status-item is-btn is-agent${agentOpen ? ' is-on' : ''}`, onClick: () => setAgentOpen(!agentOpen), title: `Toggle Agent (${keyLabel('ctrl+alt+i')})`, children: [_jsx(SparkleIcon, { size: 11 }), " Agent"] })] })), menu ? _jsx(ContextMenu, { menu: menu, onClose: () => setMenu(null) }) : null, pick !== null ? (_jsx(QuickPick, { initial: pick, host: home, commands: commands, symbols: symbols, lines: current ? current.text.split('\n').length : 0, onClose: () => (setPick(null), focusEditor()), onFile: (path, side) => void open('home', path, side ? { group: groups.length === 1 ? 1 : focused === 0 ? 1 : 0 } : {}), onLine: (line) => editors.current[focused]?.goToLine(line) })) : null] }));
}
function Tree({ host, label, icon, note, disabled, onOpen, activePath, version = 0, onContext }) {
    const [open, setOpen] = useState(true);
    return (_jsxs("div", { className: "pg-tree-part", children: [_jsxs("button", { type: "button", className: `pg-tree-head vs-section${open ? ' is-open' : ''}`, "aria-expanded": open, onClick: () => setOpen(!open), children: [_jsx("span", { className: "vs-chev", "aria-hidden": "true", children: "\u203A" }), icon, _jsx("span", { children: label })] }), !open ? null : disabled ? _jsx("p", { className: "pg-note pg-pad", children: note }) : _jsx(Folder, { host: host, path: "", depth: 0, onOpen: onOpen, activePath: activePath, version: version, onContext: onContext })] }));
}
/** Search, as VS Code's: every text file in the folder read, and the lines that hold the words, by file. */
function SearchView({ host, onOpen }) {
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState(null);
    const [busy, setBusy] = useState(false);
    const search = async (words) => {
        if (!words.trim())
            return setHits(null);
        setBusy(true);
        const needle = words.toLowerCase();
        const found = [];
        for (const file of await listAll(host, 200)) {
            if (file.size !== null && file.size > 400_000)
                continue;
            if (/\.(png|jpe?g|gif|pt|pth|ckpt|safetensors|bin|npz|npy|h5|zip|gz)$/i.test(file.path))
                continue;
            const text = await host.read(file.path).catch(() => null);
            if (!text)
                continue;
            const lines = text.split('\n').flatMap((line, index) => (line.toLowerCase().includes(needle) ? [{ n: index + 1, text: line.trim().slice(0, 160) }] : [])).slice(0, 20);
            if (lines.length || file.path.toLowerCase().includes(needle))
                found.push({ path: file.path, lines });
        }
        setHits(found);
        setBusy(false);
    };
    return (_jsxs("div", { className: "vs-search", children: [_jsx("form", { onSubmit: (event) => {
                    event.preventDefault();
                    void search(query);
                }, children: _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Search \u2014 \u23CE", "aria-label": "Search the files", spellCheck: false }) }), busy ? (_jsxs("p", { className: "pg-note pg-pad", children: [_jsx("span", { className: "spinner" }), " Reading the files\u2026"] })) : hits ? (hits.length ? (_jsx("ul", { className: "vs-hits", children: hits.map((hit) => (_jsxs("li", { children: [_jsxs("button", { type: "button", className: "pg-entry", onClick: () => onOpen(hit.path), children: [_jsx(FileIcon, { path: hit.path }), hit.path, _jsx("small", { children: hit.lines.length })] }), hit.lines.map((line) => (_jsxs("button", { type: "button", className: "vs-hit-line mono", onClick: () => onOpen(hit.path, line.n), title: `Line ${line.n}`, children: [_jsx("i", { children: line.n }), " ", line.text] }, line.n)))] }, hit.path))) })) : (_jsxs("p", { className: "pg-note pg-pad", children: ["Nothing in the folder says \u201C", query, "\u201D."] }))) : (_jsx("p", { className: "pg-note pg-pad", children: "Words to find in every file of the folder." }))] }));
}
/**
 * A project made before files left the browser: its files are still there.
 * Moved to Drive, to a computer of yours, or to the machine, in one click;
 * nothing is taken out of the browser until it is all written there.
 */
function MoveOutOfBrowser({ playground, machineName, onNote }) {
    const driveOk = useDriveConnected();
    const [busy, setBusy] = useState(false);
    const move = async (to) => {
        setBusy(true);
        try {
            const n = await moveFilesOutOfBrowser(playground.id, to);
            onNote(`${n} ${n === 1 ? 'file' : 'files'} moved to ${to.kind === 'drive' ? 'your Google Drive' : machineName}; nothing of this project is kept in the browser now.`);
        }
        catch (error) {
            onNote(`The files stayed where they were: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "pg-banner is-problem", children: ["This project\u2019s files are still kept in this browser. Move them out \u2014 they are then kept only there:", _jsxs("button", { type: "button", className: "btn sm primary", disabled: !driveOk || busy, onClick: () => void move({ kind: 'drive', folder: '' }), title: driveOk ? 'Papers_collection/Playgrounds in your Drive' : 'Sign in with Google, with Drive, first', children: [_jsx(DriveMark, { size: 12 }), " To Google Drive"] }), playground.compute.kind === 'server' ? (_jsxs("button", { type: "button", className: "btn sm", disabled: busy, onClick: () => void move({ kind: 'machine' }), children: ["To ", machineName] })) : null] }));
}
function Folder({ host, path, depth, onOpen, activePath, version, onContext }) {
    const [entries, setEntries] = useState(null);
    const [problem, setProblem] = useState(null);
    const [openDirs, setOpenDirs] = useState(new Set());
    useEffect(() => {
        let live = true;
        host
            .list(path)
            .then((list) => live && setEntries(list))
            .catch((error) => live && setProblem(error instanceof Error ? error.message : String(error)));
        return () => {
            live = false;
        };
    }, [host, path, version]);
    if (problem)
        return _jsx("p", { className: "pg-note is-problem pg-pad", children: problem });
    if (!entries)
        return _jsx("p", { className: "pg-note pg-pad", children: "\u2026" });
    if (!entries.length && depth === 0)
        return _jsx("p", { className: "pg-note pg-pad", children: "Empty." });
    return (_jsx("ul", { className: "pg-folder", children: entries.map((entry) => (_jsx("li", { children: entry.type === 'directory' ? (_jsxs(_Fragment, { children: [_jsxs("button", { type: "button", className: `pg-entry is-dir${openDirs.has(entry.path) ? ' is-open' : ''}`, style: { paddingLeft: 8 + depth * 14 }, onContextMenu: (event) => onContext?.(event, { path: entry.path, dir: true }), onClick: () => setOpenDirs((set) => {
                            const next = new Set(set);
                            if (next.has(entry.path))
                                next.delete(entry.path);
                            else
                                next.add(entry.path);
                            return next;
                        }), children: [_jsx("span", { className: "vs-chev", "aria-hidden": "true", children: "\u203A" }), _jsx(FileIcon, { path: entry.path, folder: true, open: openDirs.has(entry.path) }), entry.name] }), openDirs.has(entry.path) ? _jsx(Folder, { host: host, path: entry.path, depth: depth + 1, onOpen: onOpen, activePath: activePath, version: version, onContext: onContext }) : null] })) : (_jsxs("button", { type: "button", className: `pg-entry${activePath === entry.path ? ' is-on' : ''}`, style: { paddingLeft: 8 + depth * 14 }, onClick: () => onOpen(entry.path), onContextMenu: (event) => onContext?.(event, { path: entry.path, dir: false }), children: [_jsx(FileIcon, { path: entry.path }), entry.name, entry.size !== null ? _jsx("small", { children: entry.size < 1024 ? `${entry.size} B` : entry.size < 1048576 ? `${Math.round(entry.size / 1024)} KB` : `${(entry.size / 1048576).toFixed(1)} MB` }) : null] })) }, entry.path))) }));
}
function SyncPane({ playground, homeLabel, machineName, report, syncing, connected, onPush, onPull }) {
    const [ignore, setIgnore] = useState(playground.sync.ignore);
    const [bringBack, setBringBack] = useState(playground.sync.bringBack);
    const changed = ignore !== playground.sync.ignore || bringBack !== playground.sync.bringBack;
    return (_jsxs("div", { className: "pg-sync", children: [_jsxs("div", { className: "pg-sync-flow", children: [_jsx("b", { children: homeLabel }), _jsx("span", { children: "\u21C4" }), _jsx("b", { children: machineName })] }), _jsx("p", { className: "pg-note", children: "The folder is copied onto the machine before each command in the console, and what a run writes under the folders below comes back after it. Text files up to 2 MB; data and weights stay on the machine \u2014 fetch them there." }), _jsxs("div", { className: "pg-machine-actions", children: [_jsx("button", { type: "button", className: "btn sm", disabled: !connected || Boolean(syncing), onClick: onPush, children: syncing === 'push' ? 'Copying…' : 'Copy to the machine now' }), _jsx("button", { type: "button", className: "btn sm", disabled: !connected || Boolean(syncing), onClick: onPull, children: syncing === 'pull' ? 'Bringing back…' : 'Bring results back' })] }), report ? (_jsxs("p", { className: "pg-ok", children: [report.what === 'push' ? `${report.sent.length} ${report.sent.length === 1 ? 'file' : 'files'} copied to the machine` : `${report.back.length} ${report.back.length === 1 ? 'file' : 'files'} brought back`, report.skipped.length ? ` · ${report.skipped.length} left where they were, over 2 MB` : '', " \u00B7 ", new Date(report.at).toLocaleTimeString()] })) : null, _jsxs("label", { className: "pg-rules", children: [_jsx("span", { children: "Not copied (like .gitignore)" }), _jsx("textarea", { value: ignore, onChange: (event) => setIgnore(event.target.value), rows: 6, spellCheck: false })] }), _jsxs("label", { className: "pg-rules", children: [_jsx("span", { children: "Brought back after a run" }), _jsx("textarea", { value: bringBack, onChange: (event) => setBringBack(event.target.value), rows: 5, spellCheck: false })] }), _jsx("button", { type: "button", className: "btn sm primary", disabled: !changed, onClick: () => updatePlayground(playground.id, { sync: { ignore, bringBack } }), children: "Keep these rules" })] }));
}
