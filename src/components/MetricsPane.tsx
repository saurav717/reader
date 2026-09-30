// ===========================================================================
//  The Metrics tab of the notebook's side pane: what the cells print as
//  they train, drawn the way TensorBoard's Scalars tab draws every tag —
//  one chart a metric (loss, accuracy, lr, perplexity…), a line a cell and
//  split, live while a cell runs, read off the cells' outputs and nothing
//  else. The reading is src/lib/telemetry.ts's metricSeries.
// ===========================================================================

import { useMemo, useState } from 'react';
import type { Metric, Series } from '../lib/telemetry';
import { metricSeries, short } from '../lib/telemetry';
import { LineChart } from './Charts';

export interface MetricCell {
  key: string;
  id: string;
  label: string;
  /** What the cell printed, as text, live while it runs. */
  text: string;
  /** When it last started, so the newest cells come first. */
  at: number;
}

/** The most lines one chart carries: the page's chart colours are four. */
const MAX_LINES = 4;

interface Line {
  cellId: string;
  cellLabel: string;
  series: Series;
  last: number;
}

interface Chart {
  name: string;
  lines: Line[];
  /** Every cell that printed this metric, newest first, for the picker. */
  cells: { id: string; label: string }[];
}

/** One chart a metric across the cells, the newest cells first, at most MAX_LINES lines. */
export function metricCharts(cells: MetricCell[], only: string | null): Chart[] {
  const charts = new Map<string, Chart>();
  const read: { cell: MetricCell; metrics: Metric[] }[] = cells
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
      if (only && cell.id !== only) continue;
      for (const series of metric.series) {
        if (chart.lines.length >= MAX_LINES) break;
        const last = series.points[series.points.length - 1];
        chart.lines.push({ cellId: cell.id, cellLabel: cell.label, series: { ...series, name: `${cell.label}${series.name ? ` · ${series.name}` : ''}` }, last: last?.y ?? NaN });
      }
    }
  }
  return Array.from(charts.values()).filter((chart) => chart.lines.length);
}

export default function MetricsPane({ cells, running, onGoTo, colabUrl }: { cells: MetricCell[]; running?: string; onGoTo?: (id: string) => void; colabUrl?: string }) {
  const [only, setOnly] = useState<string | null>(null);
  const charts = useMemo(() => metricCharts(cells, only), [cells, only]);
  const printers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const chart of metricCharts(cells, null)) for (const cell of chart.cells) if (!seen.has(cell.id)) seen.set(cell.id, cell.label);
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [cells]);
  const live = Boolean(running && cells.some((cell) => cell.key === running));
  return (
    <div className="rt-pane rt-metrics" aria-live="polite">
      <div className="rt-head">
        <b>Metrics</b>
        <span>What the cells print as they train — loss, accuracy, lr, perplexity… — one chart a metric, {live ? 'live' : 'as of their last run'}.</span>
      </div>
      {printers.length > 1 ? (
        <div className="segmented sm rt-metric-cells" role="radiogroup" aria-label="Which cells">
          <button type="button" role="radio" aria-checked={only === null} aria-pressed={only === null} onClick={() => setOnly(null)}>
            All
          </button>
          {printers.map((cell) => (
            <button key={cell.id} type="button" role="radio" aria-checked={only === cell.id} aria-pressed={only === cell.id} onClick={() => setOnly(only === cell.id ? null : cell.id)}>
              {cell.label}
            </button>
          ))}
        </div>
      ) : null}
      {charts.length ? (
        charts.map((chart) => (
          <section key={chart.name} className="rt-metric">
            <div className="rt-part-label">
              {chart.name}
              <small>
                {' · '}
                {chart.lines.map((line) => `${line.series.name} ${Number.isFinite(line.last) ? short(line.last) : '—'}`).join(' · ')}
              </small>
            </div>
            <LineChart series={chart.lines.map((line) => line.series)} title={`${chart.name}${live && chart.lines.some((line) => line.cellId === cells.find((c) => c.key === running)?.id) ? ' · live' : ''}`} xLabel={chart.lines.some((line) => line.series.stepped) ? 'step' : 'line'} />
            {onGoTo ? (
              <div className="rt-metric-cells-go">
                {Array.from(new Map(chart.lines.map((line) => [line.cellId, line.cellLabel])).entries()).map(([id, label]) => (
                  <button key={id} type="button" className="rt-peak" onClick={() => onGoTo(id)} title="Go to the cell">
                    {label} ↗
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ))
      ) : (
        <p className="rt-empty">
          Nothing to plot yet. A cell that prints its numbers as it trains — <code>step 100 loss=0.42 val_loss=0.51 acc=0.88 lr=3e-4</code> — draws here as it runs, a chart a metric, one line a cell.
        </p>
      )}
      <p className="rt-metric-note">
        For TensorBoard itself, with its event files: {colabUrl ? <a href={colabUrl} target="_blank" rel="noreferrer noopener">open this runtime in Colab ↗</a> : 'open the runtime in Colab'} and run <code>%load_ext tensorboard</code> and <code>%tensorboard --logdir runs</code> there; it reads the same disk.
      </p>
    </div>
  );
}
