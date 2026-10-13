import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ===========================================================================
//  The Metrics tab of the notebook's side pane: what the cells print as
//  they train, drawn the way TensorBoard's Scalars tab draws every tag —
//  one chart a metric (loss, accuracy, lr, perplexity…), a line a cell and
//  split, live while a cell runs, read off the cells' outputs and nothing
//  else. The reading is src/lib/telemetry.ts's metricSeries.
// ===========================================================================
import { useMemo, useState } from 'react';
import { metricSeries, short } from '../lib/telemetry';
import { LineChart } from './Charts';
/** The most lines one chart carries: the page's chart colours are four. */
const MAX_LINES = 4;
/** One chart a metric across the cells, the newest cells first, at most MAX_LINES lines. */
export function metricCharts(cells, only) {
    const charts = new Map();
    const read = cells
        .filter((cell) => cell.text.trim())
        .map((cell) => ({ cell, metrics: metricSeries(cell.text) }))
        .filter((entry) => entry.metrics.length)
        .sort((a, b) => b.cell.at - a.cell.at);
    for (const { cell, metrics } of read) {
        for (const metric of metrics) {
            let chart = charts.get(metric.name);
            if (!chart) {
                chart = { name: metric.name, lines: [], cells: [] };
                charts.set(metric.name, chart);
            }
            chart.cells.push({ id: cell.id, label: cell.label });
            if (only && cell.id !== only)
                continue;
            for (const series of metric.series) {
                if (chart.lines.length >= MAX_LINES)
                    break;
                const last = series.points[series.points.length - 1];
                chart.lines.push({ cellId: cell.id, cellLabel: cell.label, series: { ...series, name: `${cell.label}${series.name ? ` · ${series.name}` : ''}` }, last: last?.y ?? NaN });
            }
        }
    }
    return Array.from(charts.values()).filter((chart) => chart.lines.length);
}
export default function MetricsPane({ cells, running, onGoTo, colabUrl }) {
    const [only, setOnly] = useState(null);
    const charts = useMemo(() => metricCharts(cells, only), [cells, only]);
    const printers = useMemo(() => {
        const seen = new Map();
        for (const chart of metricCharts(cells, null))
            for (const cell of chart.cells)
                if (!seen.has(cell.id))
                    seen.set(cell.id, cell.label);
        return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
    }, [cells]);
    const live = Boolean(running && cells.some((cell) => cell.key === running));
    return (_jsxs("div", { className: "rt-pane rt-metrics", "aria-live": "polite", children: [_jsxs("div", { className: "rt-head", children: [_jsx("b", { children: "Metrics" }), _jsxs("span", { children: ["What the cells print as they train \u2014 loss, accuracy, lr, perplexity\u2026 \u2014 one chart a metric, ", live ? 'live' : 'as of their last run', "."] })] }), printers.length > 1 ? (_jsxs("div", { className: "segmented sm rt-metric-cells", role: "radiogroup", "aria-label": "Which cells", children: [_jsx("button", { type: "button", role: "radio", "aria-checked": only === null, "aria-pressed": only === null, onClick: () => setOnly(null), children: "All" }), printers.map((cell) => (_jsx("button", { type: "button", role: "radio", "aria-checked": only === cell.id, "aria-pressed": only === cell.id, onClick: () => setOnly(only === cell.id ? null : cell.id), children: cell.label }, cell.id)))] })) : null, charts.length ? (charts.map((chart) => (_jsxs("section", { className: "rt-metric", children: [_jsxs("div", { className: "rt-part-label", children: [chart.name, _jsxs("small", { children: [' · ', chart.lines.map((line) => `${line.series.name} ${Number.isFinite(line.last) ? short(line.last) : '—'}`).join(' · ')] })] }), _jsx(LineChart, { series: chart.lines.map((line) => line.series), title: `${chart.name}${live && chart.lines.some((line) => line.cellId === cells.find((c) => c.key === running)?.id) ? ' · live' : ''}`, xLabel: chart.lines.some((line) => line.series.stepped) ? 'step' : 'line' }), onGoTo ? (_jsx("div", { className: "rt-metric-cells-go", children: Array.from(new Map(chart.lines.map((line) => [line.cellId, line.cellLabel])).entries()).map(([id, label]) => (_jsxs("button", { type: "button", className: "rt-peak", onClick: () => onGoTo(id), title: "Go to the cell", children: [label, " \u2197"] }, id))) })) : null] }, chart.name)))) : (_jsxs("p", { className: "rt-empty", children: ["Nothing to plot yet. A cell that prints its numbers as it trains \u2014 ", _jsx("code", { children: "step 100 loss=0.42 val_loss=0.51 acc=0.88 lr=3e-4" }), " \u2014 draws here as it runs, a chart a metric, one line a cell."] })), _jsxs("p", { className: "rt-metric-note", children: ["For TensorBoard itself, with its event files: ", colabUrl ? _jsx("a", { href: colabUrl, target: "_blank", rel: "noreferrer noopener", children: "open this runtime in Colab \u2197" }) : 'open the runtime in Colab', " and run ", _jsx("code", { children: "%load_ext tensorboard" }), " and ", _jsx("code", { children: "%tensorboard --logdir runs" }), " there; it reads the same disk."] })] }));
}
