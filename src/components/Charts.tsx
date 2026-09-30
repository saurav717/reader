// The small charts a running cell can earn: its loss curves, read off what
// it prints, and the machine's use while it ran — GPU and CPU, VRAM and RAM. Drawn as SVG in the page's
// own colours (--viz-1, -2, -3, validated for light and dark), 2px lines, a
// legend whenever there are two series, the last value labelled at the end
// of each line, hairline gridlines, a crosshair with the values under the
// pointer, and the same numbers as a table one click away.

import { useMemo, useState } from 'react';
import type { MachineSample, Series } from '../lib/telemetry';
import { gigabytes, short, ticks } from '../lib/telemetry';

const W = 420;
const H = 150;
const PAD = { top: 10, right: 54, bottom: 22, left: 40 };
const COLOURS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--muted)'];

interface Drawn {
  name: string;
  colour: string;
  path: string;
  last: { x: number; y: number; px: number; py: number };
  points: { x: number; y: number; px: number; py: number }[];
}

function useScales(series: Series[]) {
  return useMemo(() => {
    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (yMax === yMin) {
      yMin -= 1;
      yMax += 1;
    }
    // A little air above and below, so the extremes do not sit on the frame.
    const air = (yMax - yMin) * 0.06;
    yMin -= air;
    yMax += air;
    const sx = (x: number) => PAD.left + (xMax === xMin ? 0.5 : (x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
    const sy = (y: number) => PAD.top + (1 - (y - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
    const drawn: Drawn[] = series.map((s, index) => {
      const points = s.points.map((p) => ({ ...p, px: sx(p.x), py: sy(p.y) }));
      return { name: s.name, colour: COLOURS[index] ?? COLOURS[3], path: points.map((p, i) => `${i ? 'L' : 'M'}${p.px.toFixed(1)} ${p.py.toFixed(1)}`).join(' '), last: points[points.length - 1], points };
    });
    return { xMin, xMax, yMin, yMax, sx, sy, drawn, yTicks: ticks(yMin, yMax, 3), xTicks: ticks(xMin, xMax, 4) };
  }, [series]);
}

/**
 * Lines over a shared x — a step, or the order of the lines — with the
 * value at each line's end and, under the pointer, every series' value at
 * the nearest x.
 */
export function LineChart({ series, title, xLabel, unit, tableLabel }: { series: Series[]; title: string; xLabel: string; unit?: string; tableLabel?: string }) {
  const { drawn, yTicks, xTicks, sx, sy, xMin, xMax } = useScales(series);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (!drawn.length) return null;
  const nearest = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const x = xMin + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (xMax - xMin);
    setHover(Math.max(xMin, Math.min(xMax, x)));
  };
  const under = hover === null ? null : drawn.map((line) => {
    let best = line.points[0];
    for (const point of line.points) if (Math.abs(point.x - hover) < Math.abs(best.x - hover)) best = point;
    return { line, point: best };
  });
  const hoverX = under?.[0] ? sx(under[0].point.x) : 0;
  const fmt = (value: number) => `${short(value)}${unit ?? ''}`;
  return (
    <figure className="cell-chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        {drawn.length > 1 ? (
          <span className="chart-legend" aria-label="Series">
            {drawn.map((line) => (
              <span key={line.name}>
                <i style={{ background: line.colour }} /> {line.name}
              </span>
            ))}
          </span>
        ) : null}
        <button type="button" className="chart-table-toggle" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? 'Chart' : 'Table'}
        </button>
      </figcaption>
      {table ? (
        <table className="chart-table">
          <thead>
            <tr>
              <th>{xLabel}</th>
              {drawn.map((line) => (
                <th key={line.name}>{tableLabel ?? line.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from(new Set(drawn.flatMap((line) => line.points.map((p) => p.x))))
              .sort((a, b) => a - b)
              .slice(-60)
              .map((x) => (
                <tr key={x}>
                  <td>{short(x)}</td>
                  {drawn.map((line) => {
                    const at = line.points.find((p) => p.x === x);
                    return <td key={line.name}>{at ? fmt(at.y) : ''}</td>;
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${drawn.map((line) => `${line.name} ends at ${fmt(line.last.y)}`).join(', ')}`} onMouseMove={nearest} onMouseLeave={() => setHover(null)}>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={sy(tick)} y2={sy(tick)} />
              <text className="tick" x={PAD.left - 6} y={sy(tick) + 3} textAnchor="end">
                {fmt(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick} className="tick" x={sx(tick)} y={H - 6} textAnchor="middle">
              {short(tick)}
            </text>
          ))}
          <text className="tick axis" x={W - PAD.right} y={H - 6} textAnchor="end">
            {xLabel}
          </text>
          {drawn.map((line) => (
            <g key={line.name}>
              <path className="series" d={line.path} style={{ stroke: line.colour }} />
              <circle className="end" cx={line.last.px} cy={line.last.py} r={4} style={{ fill: line.colour }} />
              <text className="end-label" x={line.last.px + 8} y={line.last.py + 3.5}>
                {fmt(line.last.y)}
              </text>
            </g>
          ))}
          {under ? (
            <g className="crosshair">
              <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={H - PAD.bottom} />
              {under.map(({ line, point }) => (
                <circle key={line.name} cx={point.px} cy={point.py} r={4} style={{ fill: line.colour }} />
              ))}
              <g transform={`translate(${hoverX + (hoverX > W / 2 ? -8 : 8)}, ${PAD.top + 4})`}>
                <rect className="tip" x={hoverX > W / 2 ? -118 : 0} y={0} width={118} height={12 + 13 * (under.length + 1)} rx={5} />
                <text className="tip-text" x={hoverX > W / 2 ? -111 : 7} y={14}>
                  {xLabel} {short(under[0].point.x)}
                </text>
                {under.map(({ line, point }, index) => (
                  <text key={line.name} className="tip-text" x={hoverX > W / 2 ? -111 : 7} y={27 + 13 * index}>
                    {line.name} · {fmt(point.y)}
                  </text>
                ))}
              </g>
            </g>
          ) : null}
        </svg>
      )}
    </figure>
  );
}

/** Loss curves, from the lines the cell printed. */
export const LossChart = ({ series, live }: { series: Series[]; live?: boolean }) => (
  <LineChart series={series} title={`Loss, read from what the cell print${live ? 's' : 'ed'}`} xLabel={series.some((s) => s.stepped) ? 'step' : 'line'} />
);

/**
 * The machine while the cell ran: GPU and CPU utilisation over time on one
 * chart, and the memory in use — the card's and the system's — on another,
 * each drawn from whatever the samples have. A CPU runtime gets the CPU and
 * the RAM; a GPU runtime gets all four.
 */
export function MachineChart({ samples, live }: { samples: MachineSample[]; live?: boolean }) {
  const { use, memory, last } = useMemo(() => {
    const withGpu = samples.filter((s) => s.gpu);
    const withCpu = samples.filter((s) => s.cpu !== undefined);
    const withRam = samples.filter((s) => s.ramUsedMb !== undefined);
    const use: Series[] = [];
    if (withGpu.length) use.push({ name: 'GPU', stepped: true, points: withGpu.map((s) => ({ x: s.t, y: s.gpu!.util })) });
    if (withCpu.length) use.push({ name: 'CPU', stepped: true, points: withCpu.map((s) => ({ x: s.t, y: s.cpu! })) });
    const memory: Series[] = [];
    if (withGpu.length) memory.push({ name: 'VRAM', stepped: true, points: withGpu.map((s) => ({ x: s.t, y: s.gpu!.memUsedMb / 1024 })) });
    if (withRam.length) memory.push({ name: 'RAM', stepped: true, points: withRam.map((s) => ({ x: s.t, y: s.ramUsedMb! / 1024 })) });
    return { use, memory, last: samples[samples.length - 1] };
  }, [samples]);
  if (!last || !use.length) return null;
  const peakGpu = Math.max(0, ...samples.map((s) => s.gpu?.util ?? 0));
  const peakCpu = Math.max(0, ...samples.map((s) => s.cpu ?? 0));
  const useTitle = [last.gpu ? `GPU ${live ? last.gpu.util : peakGpu}%` : '', last.cpu !== undefined ? `CPU ${live ? last.cpu : peakCpu}%` : ''].filter(Boolean).join(' · ');
  const memTitle = [last.gpu ? `VRAM ${gigabytes(last.gpu.memUsedMb)} of ${gigabytes(last.gpu.memTotalMb)}` : '', last.ramUsedMb !== undefined ? `RAM ${gigabytes(last.ramUsedMb)} of ${gigabytes(last.ramTotalMb ?? 0)}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="cell-machine">
      <LineChart series={use} title={`${live ? 'Now' : 'Peak'} · ${useTitle}`} xLabel="s" unit="%" tableLabel={use.length === 1 ? `${use[0].name} %` : undefined} />
      {memory.length ? <LineChart series={memory} title={`Memory · ${memTitle}`} xLabel="s" unit=" GB" /> : null}
    </div>
  );
}
