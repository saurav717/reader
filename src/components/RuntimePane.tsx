// The Runtime pane, beside the notebook: what the runtime's machine is and
// how busy it is, live — meters for the GPU, VRAM, CPU, RAM and disk with
// the plan's needs as ticks on them; a timeline of the last ten minutes
// with a ruler of which cell ran when; how much of the session and of the
// compute units is left; the watch and the idle pulse; and the runtime's
// actions. Everything it shows comes from the Colab store (src/lib/colab.ts)
// — the probe's samples, kept as a history — and the sums are in
// src/lib/runtime.ts.

import { useEffect, useMemo, useState } from 'react';
import { connect, HISTORY_MS, IDLE_PULSE_MS, interrupt, machineLabel, probeMachine, restartKernel, setGpuWatch, setIdlePulse, setMachine, stopRuntime } from '../lib/colab';
import { nearFull, needMarkers, rulerSegments, sessionLeft, spanText, timeline, unitsLeft } from '../lib/runtime';
import type { Compute } from '../lib/hardware';
import { gigabytes } from '../lib/telemetry';
import { LineChart } from './Charts';
import { attachUrl, MachinePicker, useColab } from './Colab';

interface Props {
  /** The notebook's code cells by their run key, for the ruler's labels and for going to one. */
  cells: { key: string; label: string; id: string }[];
  /** The plan's compute block, when the paper has a plan: its needs become ticks on the meters. */
  compute?: Compute | null;
  onGoTo?: (id: string) => void;
}

const clock = (since: number | undefined, now: number) => {
  if (!since) return '—';
  const s = Math.max(0, Math.round((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

function Meter({ label, value, used, total, unit, need, note }: { label: string; value: string; used?: number; total?: number; unit?: string; need?: number; note?: string }) {
  const share = used !== undefined && total ? Math.min(1, used / total) : 0;
  const tick = need !== undefined && total ? Math.min(1, need / total) : undefined;
  const full = nearFull(used, total);
  return (
    <div className={`rt-meter${full ? ' is-full' : ''}${used === undefined ? ' is-empty' : ''}`}>
      <span className="rt-meter-label">{label}</span>
      <span className="rt-meter-bar" aria-hidden="true">
        <span className="rt-meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
        {tick !== undefined ? <span className="rt-meter-tick" style={{ left: `${Math.round(tick * 100)}%` }} title={`The plan needs ${need} ${unit ?? ''}`} /> : null}
      </span>
      <span className="rt-meter-value">{value}</span>
      {note ? <span className="rt-meter-note">{note}</span> : null}
    </div>
  );
}

export default function RuntimePane({ cells, compute, onGoTo }: Props) {
  const colab = useColab();
  const [now, setNow] = useState(Date.now());
  const [changing, setChanging] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);
  const connected = colab.status === 'idle' || colab.status === 'busy';
  const runtime = colab.runtime;
  const sample = colab.sample;
  const specs = colab.specs;
  const needs = useMemo(() => needMarkers(compute), [compute]);
  const { use, memory } = useMemo(() => timeline(colab.history, now, HISTORY_MS), [colab.history, now]);
  const segments = useMemo(() => rulerSegments(colab.runs, now, HISTORY_MS), [colab.runs, now]);
  const session = sessionLeft(runtime?.accelerator, colab.startedAt, now);
  const unitHours = unitsLeft(colab.units);
  const lastRun = Math.max(0, ...Object.values(colab.runs).map((run) => run.startedAt + (run.ms ?? 0)));
  const idleFor = connected && !colab.running && lastRun ? now - lastRun : 0;
  const labelOf = (key: string) => cells.find((cell) => cell.key === key)?.label ?? (key.startsWith('nb:') ? 'a cell' : 'a page cell');
  const vramGb = sample?.gpu ? sample.gpu.memUsedMb / 1024 : undefined;
  const vramTotalGb = specs?.vramMb ? specs.vramMb / 1024 : sample?.gpu ? sample.gpu.memTotalMb / 1024 : undefined;
  const ramGb = sample?.ramUsedMb !== undefined ? sample.ramUsedMb / 1024 : undefined;
  const ramTotalGb = specs?.ramTotalMb ? specs.ramTotalMb / 1024 : undefined;
  const diskUsed = sample?.diskFreeGb !== undefined && sample.diskTotalGb !== undefined ? sample.diskTotalGb - sample.diskFreeGb : undefined;
  const gpuMachine = Boolean(runtime?.accelerator);

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

  return (
    <div className="rt-pane">
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

      <div className="rt-part-label">Now{sample && !colab.running ? <small> · read {spanText(now - (colab.history[colab.history.length - 1]?.at ?? now))} ago</small> : null}</div>
      <div className="rt-meters">
        {gpuMachine ? <Meter label="GPU" value={sample?.gpu ? `${sample.gpu.util}%` : '—'} used={sample?.gpu?.util} total={100} /> : null}
        {gpuMachine ? (
          <Meter label="VRAM" value={vramGb !== undefined ? `${vramGb.toFixed(1)} / ${vramTotalGb?.toFixed(0) ?? '?'} GB` : '—'} used={vramGb} total={vramTotalGb} unit="GB" need={needs.vramGb} note={nearFull(vramGb, vramTotalGb) ? `Near the top${compute?.shrink ? ` — ${compute.shrink}` : ': a smaller micro-batch, gradient checkpointing, an 8-bit optimiser'}` : needs.vramGb !== undefined && vramTotalGb !== undefined ? (needs.vramGb > vramTotalGb ? `The plan needs ${needs.vramGb} GB; this card has ${vramTotalGb.toFixed(0)}` : `The plan needs ${needs.vramGb} GB of ${vramTotalGb.toFixed(0)}`) : undefined} />
        ) : null}
        <Meter label="CPU" value={sample?.cpu !== undefined ? `${sample.cpu}%` : '—'} used={sample?.cpu} total={100} />
        <Meter label="RAM" value={ramGb !== undefined ? `${ramGb.toFixed(1)} / ${ramTotalGb?.toFixed(0) ?? '?'} GB` : '—'} used={ramGb} total={ramTotalGb} unit="GB" need={needs.ramGb} note={needs.ramGb !== undefined && ramTotalGb !== undefined && needs.ramGb > ramTotalGb ? `The plan needs ${needs.ramGb} GB of RAM; this runtime has ${ramTotalGb.toFixed(0)} — a high-RAM one is in Change machine` : undefined} />
        <Meter label="Disk" value={sample?.diskFreeGb !== undefined ? `${sample.diskFreeGb} GB free` : '—'} used={diskUsed} total={sample?.diskTotalGb} unit="GB" />
      </div>

      <div className="rt-part-label">
        The last ten minutes
        {segments.length ? <small> · {segments.length} {segments.length === 1 ? 'run' : 'runs'}</small> : null}
      </div>
      {use.length >= 1 && use.some((s) => s.points.length >= 2) ? (
        <div className="rt-timeline">
          <LineChart series={use} title="Use" xLabel="min" unit="%" tableLabel={use.length === 1 ? `${use[0].name} %` : undefined} xRange={[-HISTORY_MS / 60_000, 0]} />
          <svg className="rt-ruler" viewBox="0 0 420 14" preserveAspectRatio="none" role="img" aria-label={segments.length ? `Cells that ran: ${segments.map((s) => labelOf(s.key)).join(', ')}` : 'No cell has run in the last ten minutes'}>
            <rect className="rt-ruler-track" x={40} y={4} width={326} height={6} rx={3} />
            {segments.map((segment) => {
              const x = 40 + ((segment.start + 10) / 10) * 326;
              const w = Math.max(2, ((segment.end - segment.start) / 10) * 326);
              const id = cells.find((cell) => cell.key === segment.key)?.id;
              return (
                <rect key={segment.key} className={`rt-ruler-run is-${segment.state}${id ? ' is-link' : ''}`} x={x} y={2} width={w} height={10} rx={2} onClick={() => id && onGoTo?.(id)}>
                  <title>
                    {labelOf(segment.key)} · {segment.live ? 'running' : segment.state}
                  </title>
                </rect>
              );
            })}
          </svg>
          {memory.length ? <LineChart series={memory} title="Memory" xLabel="min" unit=" GB" xRange={[-HISTORY_MS / 60_000, 0]} /> : null}
        </div>
      ) : (
        <p className="rt-note">{colab.gpuWatch ? 'A timeline draws here as the machine is read: every two seconds while a cell runs, and every half minute between cells while the pulse is on.' : 'The watch is off, so nothing is read; switch it on below.'}</p>
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
            <span>{colab.units?.balance !== undefined ? `${colab.units.balance.toFixed(1)}${unitHours !== null ? ` · about ${spanText(unitHours * 3_600_000)} at ${colab.units.ratePerHour?.toFixed(2)}/h` : gpuMachine ? '' : ' · this machine costs none'}` : gpuMachine ? 'your tier’s' : 'free'}</span>
          </span>
        </div>
        {idleFor > 15 * 60_000 ? <p className="rt-note is-warn">Nothing has run for {spanText(idleFor)}. Colab ends a runtime left idle for long; the pulse below keeps this one read, and the free tier counts that as activity.</p> : null}
      </div>

      <div className="rt-part-label">Reading the machine</div>
      <label className="colab-switch rt-switch">
        <input type="checkbox" checked={colab.gpuWatch} onChange={(event) => setGpuWatch(event.target.checked)} />
        <span>
          <b>Watch while cells run</b>
          <small>A few lines of the reader's own, in a second kernel, every two seconds — the probe in the chip's menu.</small>
        </span>
      </label>
      <label className="colab-switch rt-switch">
        <input type="checkbox" checked={colab.idlePulse} disabled={!colab.gpuWatch} onChange={(event) => setIdlePulse(event.target.checked)} />
        <span>
          <b>Pulse between cells</b>
          <small>
            The same reading every {Math.round(IDLE_PULSE_MS / 1000)} s while nothing runs, so the meters stay live. Colab may count it as activity: on the free tier that keeps the runtime up; on a machine billed in units it is a quiet cost, so it is off there unless you switch it on.
          </small>
        </span>
      </label>
      <button type="button" className="btn sm ghost rt-read" disabled={colab.status === 'busy' || !colab.gpuWatch} onClick={() => void probeMachine()}>
        Read now
      </button>

      <div className="rt-part-label">The runtime</div>
      <div className="rt-actions">
        {colab.status === 'busy' ? (
          <button type="button" className="btn sm colab-stop" onClick={() => void interrupt()}>
            ■ Stop the cell
          </button>
        ) : null}
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
