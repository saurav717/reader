import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// The peek beside a paper (Settings → Running playgrounds, E): reading a
// paper that a playground cites — or one picked with ⌘↵ in P's switcher —
// its cells are at the side of the page, live: what each printed, the one
// running now, Run on any cell and Stop. They run in the playground's own
// kernel, on its own machine (colab.ts runCellFor), without leaving the paper
// or bringing the playground to the foreground. Open goes to the playground.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { colabNow, outputText, runCellFor, subscribeColab } from '../lib/colab';
import { cellStatus, loadNotebook, notebookFor, runKey, subscribeNotebook } from '../lib/notebook';
import { backendOfPlayground, blankCells, loadPlaygrounds, notebookKey, takeSeed, usePlaygrounds } from '../lib/playground';
import { isLive, peekPlayground, stopPlayground, usePeeked, useRunBoard } from '../lib/playgroundRuns';
import { RunPill } from './PlaygroundRuns';
import { ChevronRightIcon, CloseIcon, CodeIcon } from './icons';
const FOLD_KEY = 'reader.playground.peek-folded';
const readFold = () => {
    try {
        return localStorage.getItem(FOLD_KEY) === '1';
    }
    catch {
        return false;
    }
};
/** The last lines of what a cell printed, and its pictures. */
function Printed({ outputs }) {
    const text = outputText(outputs.filter((output) => output.type !== 'image')).split('\n');
    const shown = text.slice(-12).join('\n').trimEnd();
    const images = outputs.filter((output) => output.type === 'image').slice(-2);
    const failed = outputs.some((output) => output.type === 'error');
    if (!shown && !images.length)
        return null;
    return (_jsxs("div", { className: `pk-out${failed ? ' is-error' : ''}`, children: [shown ? _jsx("pre", { children: text.length > 12 ? `…\n${shown}` : shown }) : null, images.map((image, i) => (_jsx("img", { src: `data:${image.mime};base64,${image.data}`, alt: "" }, i)))] }));
}
function PeekCell({ cell, index, run, onRun, busy }) {
    const status = cellStatus(cell, run);
    const outputs = run?.outputs ?? cell.outputs;
    const live = status === 'running' || status === 'queued';
    const lines = cell.source.split('\n');
    return (_jsxs("div", { className: `pk-cell is-${status ?? 'text'}`, children: [_jsxs("div", { className: "pk-cell-head", children: [_jsxs("span", { className: "pk-n", children: ["[", index + 1, "]"] }), _jsx("span", { className: "pk-state", children: live ? (status === 'queued' ? 'queued' : 'running') : status === 'failed' ? 'failed' : status === 'ran' ? 'ran' : status === 'stopped' ? 'stopped' : status === 'changed' ? 'changed since it ran' : '' }), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "link", disabled: busy || !cell.source.trim(), onClick: onRun, title: "Runs this cell in the playground's own kernel, on its machine", children: "Run" })] }), _jsxs("pre", { className: "pk-src", children: [lines.slice(0, 8).join('\n'), lines.length > 8 ? '\n…' : ''] }), _jsx(Printed, { outputs: outputs })] }));
}
/** On a paper's page: the peek, when Settings has it on or one was picked with ⌘↵ — and a playground to show. */
export default function PlaygroundPeek({ paperId, enabled, onOpen }) {
    const picked = usePeeked();
    if (!enabled && !picked)
        return null;
    return _jsx(Peek, { paperId: paperId, picked: picked, onOpen: onOpen });
}
function Peek({ paperId, picked, onOpen }) {
    useEffect(() => {
        void loadPlaygrounds();
    }, []);
    const list = usePlaygrounds();
    const board = useRunBoard(list);
    const citing = useMemo(() => list.filter((p) => p.cites.some((cite) => cite.paperId === paperId)), [list, paperId]);
    // The one picked; else of those citing the paper, one running, else the one changed last.
    const choices = picked && !citing.some((p) => p.id === picked) ? [...list.filter((p) => p.id === picked), ...citing] : citing;
    const ranked = [...choices].sort((a, b) => Number(isLive(board.find((r) => r.id === b.id) ?? { phase: 'never' })) - Number(isLive(board.find((r) => r.id === a.id) ?? { phase: 'never' })) || b.updated - a.updated);
    const [chosen, setChosen] = useState(null);
    const p = (picked ? list.find((x) => x.id === picked) : undefined) ?? ranked.find((x) => x.id === chosen) ?? ranked[0];
    const [folded, setFolded] = useState(readFold);
    const fold = (next) => {
        setFolded(next);
        try {
            localStorage.setItem(FOLD_KEY, next ? '1' : '0');
        }
        catch {
            // Only a convenience.
        }
    };
    const key = p ? notebookKey(p.id) : '';
    useEffect(() => {
        if (!p)
            return;
        void loadNotebook(key, p.title, () => takeSeed(p.id) ?? blankCells(p.title));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const nb = useSyncExternalStore(subscribeNotebook, () => (key ? notebookFor(key) : undefined));
    const colab = useSyncExternalStore(subscribeColab, colabNow);
    const [problem, setProblem] = useState(null);
    if (!p)
        return null;
    const run = board.find((r) => r.id === p.id);
    const backend = backendOfPlayground(p);
    const live = run ? isLive(run) : false;
    const code = (nb?.cells ?? []).map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.type === 'code' && cell.source.trim());
    const runOne = (cell) => {
        if (!backend)
            return setProblem('Its machine isn’t in your list here: open the playground to choose one.');
        setProblem(null);
        void runCellFor(backend, p.id, runKey(cell.id), cell.source).catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
    };
    if (folded) {
        return (_jsxs("button", { type: "button", className: "pk-pill", onClick: () => fold(false), title: `Show ${p.title} beside the paper`, children: [_jsx(CodeIcon, { size: 14 }), _jsx("span", { children: p.title }), run ? _jsx(RunPill, { run: run }) : null] }));
    }
    return (_jsxs("aside", { className: "pk", "aria-label": `${p.title}, beside the paper`, children: [_jsxs("header", { className: "pk-head", children: [_jsxs("div", { className: "pk-title", children: [_jsx("span", { className: "eyebrow", children: "Beside the paper" }), ranked.length > 1 && !picked ? (_jsx("select", { value: p.id, onChange: (event) => setChosen(event.target.value), "aria-label": "Which playground", children: ranked.map((x) => (_jsx("option", { value: x.id, children: x.title }, x.id))) })) : (_jsx("b", { title: p.title, children: p.title }))] }), _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Fold the peek", title: "Fold", onClick: () => fold(true), children: _jsx(ChevronRightIcon, { size: 15 }) }), picked ? (_jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close the peek", title: "Close", onClick: () => peekPlayground(null), children: _jsx(CloseIcon, { size: 14 }) })) : null] }), _jsxs("div", { className: "pk-bar", children: [run ? _jsx(RunPill, { run: run }) : null, _jsx("span", { className: "pk-where", children: run?.where }), _jsx("span", { className: "spacer" }), live ? (_jsx("button", { type: "button", className: "btn sm pr-stop", onClick: () => void stopPlayground(p.id), children: "Stop" })) : null, _jsx("button", { type: "button", className: "btn sm primary", onClick: () => onOpen(p.id), children: "Open" })] }), problem ? _jsx("p", { className: "pk-problem", children: problem }) : null, _jsx("div", { className: "pk-cells", children: code.length ? (code.map(({ cell }, i) => _jsx(PeekCell, { cell: cell, index: i, run: colab.runs[runKey(cell.id)], busy: Boolean(run && isLive(run) && run.session), onRun: () => runOne(cell) }, cell.id))) : (_jsx("p", { className: "pk-empty", children: "No code cells yet \u2014 Open writes them." })) })] }));
}
