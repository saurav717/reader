import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
// TensorBoard's scalars in the side pane: each tag a chart, every run under
// the project's folder a line in it, read again every few seconds while a
// run is writing (src/lib/tensorboard.ts). Runs can be hidden, tags filtered.
import { useEffect, useMemo, useState } from 'react';
import { readTensorBoard, tagsOf } from '../lib/tensorboard';
import { LineChart } from './Charts';
export default function TensorBoardPane({ folder, connected, machineName, busy }) {
    const [read, setRead] = useState(null);
    const [problem, setProblem] = useState(null);
    const [hidden, setHidden] = useState(new Set());
    const [filter, setFilter] = useState('');
    const [round, setRound] = useState(0);
    const [at, setAt] = useState(null);
    useEffect(() => {
        if (!connected)
            return;
        let live = true;
        let timer = 0;
        const look = async () => {
            try {
                const next = await readTensorBoard(folder);
                if (!live)
                    return;
                setRead(next);
                setProblem(null);
                setAt(Date.now());
            }
            catch (error) {
                if (live)
                    setProblem(error instanceof Error ? error.message : String(error));
            }
            // Every five seconds while a cell or command runs, every fifteen otherwise (a terminal's run counts as otherwise).
            if (live)
                timer = window.setTimeout(() => void look(), busy ? 5000 : 15000);
        };
        void look();
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [folder, connected, busy, round]);
    const runs = read?.runs ?? [];
    const shown = runs.filter((run) => !hidden.has(run.name));
    const tags = useMemo(() => tagsOf(shown).filter((tag) => !filter || tag.toLowerCase().includes(filter.toLowerCase())), [shown, filter]);
    if (!connected)
        return _jsxs("p", { className: "pg-note pg-pad", children: ["Connect to ", machineName, ", and the TensorBoard logs your runs write are charted here."] });
    if (problem && !read)
        return _jsx("p", { className: "pg-note is-problem pg-pad", children: problem });
    if (!read)
        return (_jsxs("p", { className: "pg-note pg-pad", children: [_jsx("span", { className: "spinner" }), " Reading TensorBoard\u2019s logs on ", machineName, "\u2026"] }));
    if (!runs.length) {
        return (_jsxs("div", { className: "tb-empty pg-pad", children: [read.note === 'no-tensorboard' ? (_jsxs("p", { children: ["There are TensorBoard logs in the folder, but TensorBoard isn\u2019t installed on ", machineName, " to read them: run ", _jsx("code", { children: "pip install tensorboard" }), " in the console."] })) : (_jsxs(_Fragment, { children: [_jsxs("p", { children: ["No TensorBoard logs in ", folder, " yet. Write some from your training loop, and they are charted here as they come:"] }), _jsx("pre", { className: "tb-snippet", children: `from torch.utils.tensorboard import SummaryWriter
writer = SummaryWriter("runs/exp1")
writer.add_scalar("train/loss", loss.item(), step)` })] })), _jsx("button", { type: "button", className: "btn sm", onClick: () => setRound((n) => n + 1), children: "Look again" })] }));
    }
    return (_jsxs("div", { className: "tb-pane", children: [_jsxs("div", { className: "tb-bar", children: [_jsx("input", { value: filter, onChange: (event) => setFilter(event.target.value), placeholder: "Filter tags (loss, acc, lr\u2026)", "aria-label": "Filter tags", spellCheck: false }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => setRound((n) => n + 1), title: at ? `Read ${new Date(at).toLocaleTimeString()} — read again` : 'Read again', "aria-label": "Refresh", children: "\u21BB" })] }), _jsx("div", { className: "tb-runs", role: "group", "aria-label": "Runs", children: runs.map((run) => (_jsxs("label", { className: "tb-run", title: `Last written ${new Date(run.updated).toLocaleString()}`, children: [_jsx("input", { type: "checkbox", checked: !hidden.has(run.name), onChange: () => setHidden((now) => {
                                const next = new Set(now);
                                if (next.has(run.name))
                                    next.delete(run.name);
                                else
                                    next.add(run.name);
                                return next;
                            }) }), _jsx("span", { className: "mono", children: run.name }), Date.now() - run.updated < 60_000 ? _jsx("span", { className: "tb-live", children: "live" }) : null] }, run.name))) }), tags.map((tag) => {
                const series = shown
                    .filter((run) => run.scalars[tag]?.length)
                    .slice(0, 6)
                    .map((run) => ({ name: shown.length > 1 ? run.name : tag.split('/').pop() ?? tag, stepped: true, points: run.scalars[tag].map(([x, y]) => ({ x, y })) }));
                return series.length ? _jsx(LineChart, { series: series, title: tag, xLabel: "step" }, tag) : null;
            }), problem ? _jsx("p", { className: "pg-note is-problem", children: problem }) : null] }));
}
