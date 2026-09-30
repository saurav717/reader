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
import type { CellRun, Pulse } from '../lib/colab';
import { bins, nearFull, needMarkers, peakOf, peaksByCell, recent, rulerSegments, sessionLeft, spanText, timeline, unitsLeft } from '../lib/runtime';
import type { RulerSegment } from '../lib/runtime';
import type { Compute } from '../lib/hardware';
import type { MachineSample } from '../lib/telemetry';
import { gigabytes } from '../lib/telemetry';
import { LineChart } from './Charts';
import { attachUrl, MachinePicker, useColab } from './Colab';

export type PaneStyle = 'meters' | 'tiles' | 'rings';
const STYLE_KEY = 'reader.colab.pane-style';
export const STYLES: { id: PaneStyle; label: string; note: string }[] = [
  { id: 'meters', label: 'Meters', note: 'Bars for each resource, and the last ten minutes as line charts' },
  { id: 'tiles', label: 'Tiles', note: 'The value large with its last minute, and the ten minutes as heat strips in step with the runs' },
  { id: 'rings', label: 'Rings', note: 'Dials for the rates, memory as a budget against the plan, and the hungriest cells' },
];
const readStyle = (): PaneStyle => {
  try {
    const kept = localStorage.getItem(STYLE_KEY);
    return kept === 'meters' || kept === 'rings' ? kept : 'tiles';
  } catch {
    return 'tiles';
  }
};

const BIN_MS = 10_000;
const MINUTE = 60_000;

interface Props {
  /** The notebook's code cells by their run key, for the ruler's labels and for going to one. */
  cells: { key: string; label: string; id: string }[];
  /** The plan's compute block, when the paper has a plan: its needs become ticks and headroom on the memory. */
  compute?: Compute | null;
  onGoTo?: (id: string) => void;
  /** Run every code cell, from the pane's own button (it asks first). */
  onRunAll?: () => void;
  /** The cell picked in the notebook, when it is a code cell: its label, and how to run it. */
  picked?: { label: string; run: () => void };
}

const clock = (since: number | undefined, now: number) => {
  if (!since) return '—';
  const s = Math.max(0, Math.round((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

/** The fill's colour by how full: the accent, then warning past three quarters, then danger past nine tenths. */
const severity = (share: number) => (share >= 0.9 ? 'is-bad' : share >= 0.75 ? 'is-warn' : '');

// The quantities, each with a fixed colour wherever it is drawn: the GPU and its memory in the first series colour, the CPU and the system's in the second.
const GPU_HUE = 'var(--viz-1)';
const CPU_HUE = 'var(--viz-2)';
const gpuUtil = (s: MachineSample) => s.gpu?.util;
const vramGb = (s: MachineSample) => (s.gpu ? s.gpu.memUsedMb / 1024 : undefined);
const cpuUtil = (s: MachineSample) => s.cpu;
const ramGb = (s: MachineSample) => (s.ramUsedMb === undefined ? undefined : s.ramUsedMb / 1024);

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Meter({ label, value, used, total, unit, need, note, hue }: { label: string; value: string; used?: number; total?: number; unit?: string; need?: number; note?: string; hue?: string }) {
  const share = used !== undefined && total ? Math.min(1, used / total) : 0;
  const tick = need !== undefined && total ? Math.min(1, need / total) : undefined;
  return (
    <div className={`rt-meter ${severity(share)}${used === undefined ? ' is-empty' : ''}`}>
      <span className="rt-meter-label">{label}</span>
      <span className="rt-meter-bar" aria-hidden="true">
        <span className="rt-meter-fill" style={{ width: `${Math.round(share * 100)}%`, ...(hue && !severity(share) ? { background: hue } : {}) }} />
        {tick !== undefined ? <span className="rt-meter-tick" style={{ left: `${Math.round(tick * 100)}%` }} title={`The plan needs ${need} ${unit ?? ''}`} /> : null}
      </span>
      <span className="rt-meter-value">{value}</span>
      {note ? <span className="rt-meter-note">{note}</span> : null}
    </div>
  );
}

/** The last minute of one value, as a small line; the y range is fixed so the tiles read against each other. */
function Sparkline({ points, max, hue }: { points: { x: number; y: number }[]; max: number; hue: string }) {
  if (points.length < 2) return <svg className="rt-spark" viewBox="0 0 120 22" aria-hidden="true" />;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${(120 + (p.x / 60) * 120).toFixed(1)} ${(20 - (Math.min(max, p.y) / max) * 18).toFixed(1)}`).join(' ');
  return (
    <svg className="rt-spark" viewBox="0 0 120 22" aria-hidden="true">
      <path d={path} style={{ stroke: hue }} />
    </svg>
  );
}

function Tile({ label, value, unit, note, points, max, hue }: { label: string; value: string; unit?: string; note?: string; points: { x: number; y: number }[]; max: number; hue: string }) {
  return (
    <div className="rt-tile">
      <span className="rt-tile-k">{label}</span>
      <span className="rt-tile-n">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
      {note ? <span className="rt-tile-note">{note}</span> : null}
      <Sparkline points={points} max={max} hue={hue} />
    </div>
  );
}

/** One resource over the window as a strip of bins, one hue light to dark by value, with its peak at the end. */
function Strip({ label, values, max, hue, unit, format }: { label: string; values: (number | undefined)[]; max: number; hue: string; unit: string; format?: (v: number) => string }) {
  const peak = peakOf(values);
  return (
    <>
      <b>{label}</b>
      <span className="rt-strip" role="img" aria-label={`${label} over the last ten minutes${peak !== undefined ? `, peak ${format ? format(peak) : peak}${unit}` : ''}`}>
        {values.map((value, index) => (
          <i key={index} style={value === undefined ? undefined : { background: `color-mix(in srgb, ${hue} ${Math.round(12 + 88 * Math.min(1, value / max))}%, var(--surface))` }} />
        ))}
      </span>
      <span className="rt-strip-peak">{peak !== undefined ? `peak ${format ? format(peak) : peak}${unit}` : '—'}</span>
    </>
  );
}

/** Which cell ran when, along the window — the same width as the strips and the charts above it. */
function Ruler({ segments, labelOf, idOf, onGoTo, wide }: { segments: RulerSegment[]; labelOf: (key: string) => string; idOf: (key: string) => string | undefined; onGoTo?: (id: string) => void; wide?: boolean }) {
  const left = wide ? 0 : 40;
  const width = wide ? 420 : 326;
  return (
    <svg className="rt-ruler" viewBox="0 0 420 14" preserveAspectRatio="none" role="img" aria-label={segments.length ? `Cells that ran: ${segments.map((s) => labelOf(s.key)).join(', ')}` : 'No cell has run in the last ten minutes'}>
      <rect className="rt-ruler-track" x={left} y={4} width={width} height={6} rx={3} />
      {segments.map((segment) => {
        const x = left + ((segment.start + 10) / 10) * width;
        const w = Math.max(2, ((segment.end - segment.start) / 10) * width);
        const id = idOf(segment.key);
        return (
          <rect key={segment.key} className={`rt-ruler-run is-${segment.state}${id ? ' is-link' : ''}`} x={x} y={2} width={w} height={10} rx={2} onClick={() => id && onGoTo?.(id)}>
            <title>
              {labelOf(segment.key)} · {segment.live ? 'running' : segment.state}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function Ring({ label, value, share, hue }: { label: string; value: string; share: number | undefined; hue: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const cls = share === undefined ? '' : severity(share);
  return (
    <div className={`rt-ring ${cls}`}>
      <svg viewBox="0 0 76 76" role="img" aria-label={`${label} ${value}`}>
        <circle className="rt-ring-track" cx={38} cy={38} r={r} />
        {share !== undefined ? <circle className="rt-ring-fill" cx={38} cy={38} r={r} style={cls ? undefined : { stroke: hue }} strokeDasharray={`${c * Math.min(1, share)} ${c}`} transform="rotate(-90 38 38)" /> : null}
        <text x={38} y={43} textAnchor="middle">
          {value}
        </text>
      </svg>
      <span className="rt-ring-k">{label}</span>
    </div>
  );
}

/** Memory as a budget: used and free of the total, with the plan's need marked, and said when it is over. */
function Budget({ label, used, total, need, hue }: { label: string; used?: number; total?: number; need?: number; hue: string }) {
  const share = used !== undefined && total ? Math.min(1, used / total) : 0;
  const over = need !== undefined && total !== undefined && need > total;
  const tick = need !== undefined && total ? Math.min(1, need / total) : undefined;
  return (
    <div className={`rt-budget ${severity(share)}`}>
      <span className="rt-budget-row">
        <b>{label}</b>
        <span>{used !== undefined && total !== undefined ? `${used.toFixed(1)} used · ${(total - used).toFixed(1)} free of ${total.toFixed(0)} GB` : '—'}</span>
      </span>
      <span className="rt-budget-bar" aria-hidden="true">
        <span className="rt-budget-used" style={{ width: `${Math.round(share * 100)}%`, ...(severity(share) ? {} : { background: hue }) }} />
        {tick !== undefined ? <span className={`rt-budget-need${over ? ' is-over' : ''}`} style={{ left: `${Math.round(tick * 100)}%` }} /> : null}
      </span>
      {need !== undefined ? <span className={`rt-budget-note${over ? ' is-over' : ''}`}>{over ? `The plan needs ${need} GB — more than this machine has` : `The plan needs ${need} GB${total ? ` · headroom ${Math.max(0, total - (used ?? 0)).toFixed(1)} GB` : ''}`}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export default function RuntimePane({ cells, compute, onGoTo, onRunAll, picked }: Props) {
  const colab = useColab();
  const [now, setNow] = useState(Date.now());
  const [style, setStyleState] = useState<PaneStyle>(readStyle);
  const [changing, setChanging] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);
  const setStyle = (next: PaneStyle) => {
    setStyleState(next);
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {
      // private mode
    }
  };
  const connected = colab.status === 'idle' || colab.status === 'busy';
  const runtime = colab.runtime;
  const sample = colab.sample;
  const specs = colab.specs;
  const gpuMachine = Boolean(runtime?.accelerator);
  const needs = useMemo(() => needMarkers(compute), [compute]);
  const history = colab.history;
  const { use, memory } = useMemo(() => timeline(history, now, HISTORY_MS), [history, now]);
  const segments = useMemo(() => rulerSegments(colab.runs, now, HISTORY_MS), [colab.runs, now]);
  const peaks = useMemo(() => peaksByCell(colab.runs, now, HISTORY_MS), [colab.runs, now]);
  const strips = useMemo(
    () => ({
      gpu: bins(history, now, HISTORY_MS, BIN_MS, gpuUtil),
      cpu: bins(history, now, HISTORY_MS, BIN_MS, cpuUtil),
      vram: bins(history, now, HISTORY_MS, BIN_MS, vramGb),
      ram: bins(history, now, HISTORY_MS, BIN_MS, ramGb),
    }),
    [history, now],
  );
  const sparks = useMemo(
    () => ({ gpu: recent(history, now, MINUTE, gpuUtil), cpu: recent(history, now, MINUTE, cpuUtil), vram: recent(history, now, MINUTE, vramGb), ram: recent(history, now, MINUTE, ramGb) }),
    [history, now],
  );
  const session = sessionLeft(runtime?.accelerator, colab.startedAt, now);
  const unitHours = unitsLeft(colab.units);
  const lastRun = Math.max(0, ...Object.values(colab.runs).map((run: CellRun) => run.startedAt + (run.ms ?? 0)));
  const idleFor = connected && !colab.running && lastRun ? now - lastRun : 0;
  const labelOf = (key: string) => cells.find((cell) => cell.key === key)?.label ?? (key.startsWith('nb:') ? 'a cell' : 'a page cell');
  const idOf = (key: string) => cells.find((cell) => cell.key === key)?.id;
  const vramNow = sample?.gpu ? sample.gpu.memUsedMb / 1024 : undefined;
  const vramTotal = specs?.vramMb ? specs.vramMb / 1024 : sample?.gpu ? sample.gpu.memTotalMb / 1024 : undefined;
  const ramNow = sample?.ramUsedMb !== undefined ? sample.ramUsedMb / 1024 : undefined;
  const ramTotal = specs?.ramTotalMb ? specs.ramTotalMb / 1024 : undefined;
  const diskUsed = sample?.diskFreeGb !== undefined && sample.diskTotalGb !== undefined ? sample.diskTotalGb - sample.diskFreeGb : undefined;
  const readAgo = history.length ? now - history[history.length - 1].at : undefined;
  const live = colab.gpuWatch && (colab.running ? true : colab.pulse === 'live');
  const headroom = (need: number | undefined, used: number | undefined, total: number | undefined) =>
    total === undefined ? undefined : need !== undefined && need > total ? `the plan needs ${need} GB — over` : `headroom ${Math.max(0, total - (used ?? 0)).toFixed(1)} GB${need !== undefined ? ` · the plan needs ${need}` : ''}`;

  if (!connected || !runtime) {
    return (
      <div className="rt-pane">
        <p className="rt-empty">
          {colab.status === 'connecting' ? (
            <>
              <span className="spinner" /> Connecting…
            </>
          ) : colab.status === 'lost' ? (
            'The runtime has ended. Start another from the chip in the bar, or run a cell.'
          ) : (
            'No runtime yet. Run a cell, or start one from the chip in the bar, and the machine shows here: what it is, how busy it is, and how much of the session is left.'
          )}
        </p>
      </div>
    );
  }

  const nowLabel = (
    <div className="rt-part-label">
      Now
      <small>
        {' · '}
        {live ? (
          <span className="rt-live">
            <span className="rt-live-dot" aria-hidden="true" /> live, every {PULSE_MS.live / 1000} s
          </span>
        ) : readAgo !== undefined ? (
          `read ${spanText(readAgo)} ago`
        ) : (
          'not read yet'
        )}
      </small>
    </div>
  );
  const tenLabel = (
    <div className="rt-part-label">
      The last ten minutes
      {segments.length ? <small> · {segments.length} {segments.length === 1 ? 'run' : 'runs'}</small> : null}
    </div>
  );
  const ruler = <Ruler segments={segments} labelOf={labelOf} idOf={idOf} onGoTo={onGoTo} wide={style === 'tiles'} />;

  return (
    <div className={`rt-pane is-${style}`}>
      <div className="rt-head">
        <b>{specs?.gpuName ?? (gpuMachine ? `${machineLabel(runtime)} — reading the machine…` : 'CPU runtime')}</b>
        <span>
          {[specs?.vramMb ? gigabytes(specs.vramMb) : '', specs?.cpus ? `${specs.cpus} CPUs` : '', specs?.ramTotalMb ? `${gigabytes(specs.ramTotalMb)} RAM` : '', specs?.diskTotalGb !== undefined ? `${specs.diskTotalGb} GB disk` : ''].filter(Boolean).join(' · ') || machineLabel(runtime)}
        </span>
        <span className="rt-state">
          <span className={`colab-dot is-${colab.status === 'busy' ? 'busy' : 'on'}`} aria-hidden="true" />
          {colab.status === 'busy' ? `running ${labelOf(colab.running ?? '')}` : 'idle'} · up {clock(colab.startedAt, now)}
        </span>
      </div>
      <div className="rt-run" role="group" aria-label="Runs">
        {colab.status === 'busy' || colab.queue.length ? (
          <>
            <span className="rt-run-state">
              <span className={`colab-dot is-${colab.running ? 'busy' : 'on'}`} aria-hidden="true" />
              {colab.running ? `running ${labelOf(colab.running)}` : colab.paused ? 'paused' : 'starting'}
              {colab.queue.length ? ` · ${colab.queue.length} queued` : ''}
              {colab.paused ? (colab.running ? ' · pauses after this cell' : '') : ''}
            </span>
            {colab.paused ? (
              <button type="button" className="btn sm primary" onClick={resumeRuns} title="Goes on with the cells that wait">
                ▶ Resume
              </button>
            ) : (
              <button type="button" className="btn sm" disabled={!colab.queue.length} onClick={pauseRuns} title={colab.queue.length ? 'The cell running finishes; the rest wait for Resume' : 'One cell runs on its own: a running cell cannot be paused, only stopped'}>
                ⏸ Pause
              </button>
            )}
            <button type="button" className="btn sm colab-stop" onClick={() => void stopRuns()} title="Interrupts the cell running and drops the rest">
              ■ Stop
            </button>
          </>
        ) : confirmAll ? (
          <span className="rt-confirm">
            Run every code cell, top to bottom? It stops at the first that fails.
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                setConfirmAll(false);
                onRunAll?.();
              }}
            >
              Run all
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirmAll(false)}>
              Not now
            </button>
          </span>
        ) : (
          <>
            {picked ? (
              <button type="button" className="btn sm colab" onClick={picked.run} title="Runs the cell picked in the notebook">
                ▶ Run {picked.label}
              </button>
            ) : null}
            <button type="button" className="btn sm colab" disabled={!onRunAll || !cells.length} onClick={() => setConfirmAll(true)} title="Every code cell in order; asks first">
              ▶ Run all
            </button>
            <button type="button" className="btn sm" disabled title="Nothing is running">
              ⏸ Pause
            </button>
            <button type="button" className="btn sm" disabled title="Nothing is running">
              ■ Stop
            </button>
          </>
        )}
      </div>
      <div className="segmented rt-styles" role="radiogroup" aria-label="How the machine is shown">
        {STYLES.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={style === option.id} aria-pressed={style === option.id} title={option.note} onClick={() => setStyle(option.id)}>
            {option.label}
          </button>
        ))}
      </div>

      {style === 'meters' ? (
        <>
          {nowLabel}
          <div className="rt-meters">
            {gpuMachine ? <Meter label="GPU" value={sample?.gpu ? `${sample.gpu.util}%` : '—'} used={sample?.gpu?.util} total={100} hue={GPU_HUE} /> : null}
            {gpuMachine ? (
              <Meter label="VRAM" value={vramNow !== undefined ? `${vramNow.toFixed(1)} / ${vramTotal?.toFixed(0) ?? '?'} GB` : '—'} used={vramNow} total={vramTotal} unit="GB" need={needs.vramGb} hue={GPU_HUE} note={nearFull(vramNow, vramTotal) ? `Near the top${compute?.shrink ? ` — ${compute.shrink}` : ': a smaller micro-batch, gradient checkpointing, an 8-bit optimiser'}` : headroom(needs.vramGb, vramNow, vramTotal)} />
            ) : null}
            <Meter label="CPU" value={sample?.cpu !== undefined ? `${sample.cpu}%` : '—'} used={sample?.cpu} total={100} hue={CPU_HUE} />
            <Meter label="RAM" value={ramNow !== undefined ? `${ramNow.toFixed(1)} / ${ramTotal?.toFixed(0) ?? '?'} GB` : '—'} used={ramNow} total={ramTotal} unit="GB" need={needs.ramGb} hue={CPU_HUE} note={headroom(needs.ramGb, ramNow, ramTotal)} />
            <Meter label="Disk" value={sample?.diskFreeGb !== undefined ? `${diskUsed} used · ${sample.diskFreeGb} GB free` : '—'} used={diskUsed} total={sample?.diskTotalGb} unit="GB" hue="var(--muted)" />
          </div>
          {tenLabel}
          {use.some((s) => s.points.length >= 2) ? (
            <div className="rt-timeline">
              <LineChart series={use} title="Use" xLabel="min" unit="%" tableLabel={use.length === 1 ? `${use[0].name} %` : undefined} xRange={[-HISTORY_MS / MINUTE, 0]} />
              {ruler}
              {memory.length ? <LineChart series={memory} title="Memory" xLabel="min" unit=" GB" xRange={[-HISTORY_MS / MINUTE, 0]} /> : null}
            </div>
          ) : (
            <p className="rt-note">{colab.gpuWatch ? 'A timeline draws here as the machine is read.' : 'The watch is off, so nothing is read; switch it on below.'}</p>
          )}
        </>
      ) : style === 'tiles' ? (
        <>
          {nowLabel}
          <div className="rt-tiles">
            {gpuMachine ? <Tile label="GPU" value={sample?.gpu ? `${sample.gpu.util}` : '—'} unit="%" points={sparks.gpu} max={100} hue={GPU_HUE} /> : null}
            {gpuMachine ? <Tile label="VRAM" value={vramNow !== undefined ? vramNow.toFixed(1) : '—'} unit={vramTotal ? `of ${vramTotal.toFixed(0)} GB` : 'GB'} note={headroom(needs.vramGb, vramNow, vramTotal)} points={sparks.vram} max={vramTotal ?? 16} hue={GPU_HUE} /> : null}
            <Tile label="CPU" value={sample?.cpu !== undefined ? `${sample.cpu}` : '—'} unit="%" points={sparks.cpu} max={100} hue={CPU_HUE} />
            <Tile label="RAM" value={ramNow !== undefined ? ramNow.toFixed(1) : '—'} unit={ramTotal ? `of ${ramTotal.toFixed(0)} GB` : 'GB'} note={headroom(needs.ramGb, ramNow, ramTotal)} points={sparks.ram} max={ramTotal ?? 16} hue={CPU_HUE} />
          </div>
          {tenLabel}
          <div className="rt-strips">
            {gpuMachine ? <Strip label="GPU" values={strips.gpu} max={100} hue={GPU_HUE} unit="%" /> : null}
            <Strip label="CPU" values={strips.cpu} max={100} hue={CPU_HUE} unit="%" />
            {gpuMachine ? <Strip label="VRAM" values={strips.vram} max={vramTotal ?? 16} hue={GPU_HUE} unit=" GB" format={(v) => v.toFixed(1)} /> : null}
            <Strip label="RAM" values={strips.ram} max={ramTotal ?? 16} hue={CPU_HUE} unit=" GB" format={(v) => v.toFixed(1)} />
            <span />
            {ruler}
            <span />
            <span />
            <span className="rt-strip-axis">
              <span>10 min ago</span>
              <span>{segments.length ? `${labelOf(segments[segments.length - 1].key)} ${segments[segments.length - 1].live ? 'running' : 'ran'}` : ''}</span>
              <span>now</span>
            </span>
            <span />
          </div>
          <div className="rt-part-label">Disk</div>
          <div className="rt-meters">
            <Meter label={sample?.diskFreeGb !== undefined ? `${sample.diskFreeGb} GB` : 'Disk'} value={sample?.diskTotalGb !== undefined ? `free of ${sample.diskTotalGb}` : '—'} used={diskUsed} total={sample?.diskTotalGb} unit="GB" hue="var(--muted)" />
          </div>
        </>
      ) : (
        <>
          {nowLabel}
          <div className="rt-rings">
            {gpuMachine ? <Ring label="GPU" value={sample?.gpu ? `${sample.gpu.util}%` : '—'} share={sample?.gpu ? sample.gpu.util / 100 : undefined} hue={GPU_HUE} /> : null}
            <Ring label="CPU" value={sample?.cpu !== undefined ? `${sample.cpu}%` : '—'} share={sample?.cpu !== undefined ? sample.cpu / 100 : undefined} hue={CPU_HUE} />
            {gpuMachine ? (
              <Ring label="VRAM" value={vramNow !== undefined && vramTotal ? `${Math.round((vramNow / vramTotal) * 100)}%` : '—'} share={vramNow !== undefined && vramTotal ? vramNow / vramTotal : undefined} hue={GPU_HUE} />
            ) : (
              <Ring label="RAM" value={ramNow !== undefined && ramTotal ? `${Math.round((ramNow / ramTotal) * 100)}%` : '—'} share={ramNow !== undefined && ramTotal ? ramNow / ramTotal : undefined} hue={CPU_HUE} />
            )}
          </div>
          <div className="rt-part-label">Memory{compute ? ', against the plan' : ''}</div>
          <div className="rt-budgets">
            {gpuMachine ? <Budget label="VRAM" used={vramNow} total={vramTotal} need={needs.vramGb} hue={GPU_HUE} /> : null}
            <Budget label="RAM" used={ramNow} total={ramTotal} need={needs.ramGb} hue={CPU_HUE} />
            <div className="rt-legend">
              <span>
                <i style={{ background: GPU_HUE }} /> used
              </span>
              <span>
                <i className="is-free" /> free
              </span>
              {compute ? (
                <span>
                  <i className="is-need" /> the plan's need
                </span>
              ) : null}
            </div>
          </div>
          <div className="rt-part-label">
            Peaks, by cell
            <small> · last ten minutes</small>
          </div>
          {peaks.length ? (
            <div className="rt-peaks">
              {peaks.map((peak) => {
                const id = idOf(peak.key);
                const top = peak.gpu !== undefined ? peak.gpu : (peak.cpu ?? 0);
                const memText = peak.vramMb !== undefined ? `${(peak.vramMb / 1024).toFixed(1)} GB VRAM` : peak.ramMb !== undefined ? `${(peak.ramMb / 1024).toFixed(1)} GB RAM` : '';
                return (
                  <button key={peak.key} type="button" className="rt-peak" disabled={!id} onClick={() => id && onGoTo?.(id)} title={id ? 'Go to the cell' : undefined}>
                    <b>{labelOf(peak.key)}</b>
                    <span className="rt-meter-bar" aria-hidden="true">
                      <span className="rt-meter-fill" style={{ width: `${Math.round(top)}%`, background: peak.gpu !== undefined ? GPU_HUE : CPU_HUE }} />
                    </span>
                    <span className="rt-peak-v">
                      {top}% {peak.gpu !== undefined ? 'GPU' : 'CPU'}
                      {memText ? <small>{memText}</small> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rt-note">A cell that runs while the machine is watched is listed here with its peaks.</p>
          )}
        </>
      )}

      <div className="rt-part-label">Limits</div>
      <div className="rt-limits">
        <div className="rt-limit">
          <span className="rt-limit-row">
            <b>Session</b>
            <span>{spanText(session.leftMs)} left of {session.capHours} h</span>
          </span>
          <span className="rt-meter-bar" aria-hidden="true">
            <span className={`rt-meter-fill${session.share > 0.9 ? ' is-warn' : ''}`} style={{ width: `${Math.round(session.share * 100)}%` }} />
          </span>
        </div>
        <div className="rt-limit">
          <span className="rt-limit-row">
            <b>Compute units</b>
            <span>{!gpuMachine || runtime.accelerator === 'T4' ? 'free tier' : colab.units?.balance !== undefined ? `${colab.units.balance.toFixed(1)}${unitHours !== null ? ` · about ${spanText(unitHours * 3_600_000)} at ${colab.units.ratePerHour?.toFixed(2)}/h` : ''}` : 'your tier’s'}</span>
          </span>
        </div>
        {idleFor > 15 * MINUTE ? <p className="rt-note is-warn">Nothing has run for {spanText(idleFor)}. Colab ends a runtime left idle for long; the pulse keeps this one read, which the free tier counts as activity.</p> : null}
      </div>

      <div className="rt-part-label">Reading the machine</div>
      <label className="colab-switch rt-switch">
        <input type="checkbox" checked={colab.gpuWatch} onChange={(event) => setGpuWatch(event.target.checked)} />
        <span>
          <b>Watch while cells run</b>
          <small>A few lines of the reader's own, in a second kernel, every two seconds — the probe in the chip's menu.</small>
        </span>
      </label>
      <div className="rt-pulse">
        <span className="rt-pulse-label">
          <b>Between cells</b>
          <small>The same reading while nothing runs, so the numbers are the machine now, not the last run. Colab may count it as activity: on the free tier that keeps the runtime up; on a machine billed in units the runtime is paid for while it is up either way, and the reading is a negligible share.</small>
        </span>
        <div className="segmented rt-pulse-pick" role="radiogroup" aria-label="How often the machine is read between cells">
          {(
            [
              ['live', 'Live · 2 s'],
              ['slow', 'Every 30 s'],
              ['off', 'Off'],
            ] as [Pulse, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={colab.pulse === id} aria-pressed={colab.pulse === id} disabled={!colab.gpuWatch} onClick={() => setPulse(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="btn sm ghost rt-read" disabled={colab.status === 'busy' || !colab.gpuWatch} onClick={() => void probeMachine()}>
        Read now
      </button>

      <div className="rt-part-label">The runtime</div>
      <div className="rt-actions">
        <button type="button" className="btn sm" disabled={colab.status === 'busy'} onClick={() => void restartKernel()} title="Forgets every variable; keeps the machine and the files on it">
          Restart the kernel
        </button>
        <button type="button" className="btn sm" disabled={colab.status === 'busy'} aria-expanded={changing} onClick={() => setChanging(!changing)}>
          Change machine…
        </button>
        <a className="btn sm" href={attachUrl(runtime.endpoint)} target="_blank" rel="noreferrer noopener" title="Colab's own notebook page on the same machine — for Drive, on purpose">
          Open in Colab ↗
        </a>
        {confirmStop ? (
          <span className="rt-confirm">
            Release the machine now?
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                setConfirmStop(false);
                void stopRuntime();
              }}
            >
              Stop
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirmStop(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <button type="button" className="btn sm colab-stop" onClick={() => setConfirmStop(true)}>
            Stop the runtime
          </button>
        )}
      </div>
      {changing ? (
        <div className="rt-change">
          A new runtime on another machine; this one is stopped, and its variables and files go with it.
          <MachinePicker
            machine={colab.machine}
            onPick={(machine) => {
              setMachine(machine);
              setChanging(false);
              void stopRuntime().then(() => connect(machine));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
