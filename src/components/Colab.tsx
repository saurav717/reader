// Google Colab on the Explain and Implementation pages: the chip in the bar
// that says what is running and opens to the runtime's menu, the card the
// first Run opens to say what will happen before anything does, and what a
// cell that has run shows under its code. The store, the runtime and the
// kernel are src/lib/colab.ts; the rules they keep are in docs/colab-run.md.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CellRun, Machine, Output } from '../lib/colab';
import { colabAvailable, colabNow, compareOutput, connect, differingLines, disconnect, MACHINES, machineLabel, outputText, restartKernel, runAll, setGpuWatch, setMachine, stopRuntime, subscribeColab } from '../lib/colab';
import { useStore } from '../lib/store';
import type { MachineSample, MachineSpecs } from '../lib/telemetry';
import { gigabytes, hasCurve, lossSeries, MACHINE_PROBE } from '../lib/telemetry';
import { LossChart } from './Charts';

export const useColab = () => useSyncExternalStore(subscribeColab, colabNow);

/** The Colab mark: the two rings, as the page draws them everywhere Colab is named. */
export const ColabMark = () => (
  <span className="colab-mark" aria-hidden="true">
    co
  </span>
);

const clock = (since: number | undefined, now: number) => {
  if (!since) return '';
  const s = Math.max(0, Math.round((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

/** The chip while a cell runs: the machine's use from the last sample, or just that it runs. */
const busyText = (sample: MachineSample | undefined) => {
  if (!sample) return 'running';
  const parts = [sample.gpu ? `GPU ${sample.gpu.util}%` : '', sample.cpu !== undefined ? `CPU ${sample.cpu}%` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'running';
};

/** The runtime's machine in a line: the card, the CPUs, the memory, the disk — what the probe read. */
export function specsText(specs: MachineSpecs | undefined): string {
  if (!specs) return '';
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
export const attachUrl = (endpoint: string) => {
  const host = 'https://colab.research.google.com';
  const path = `/tun/m/${endpoint}`;
  return `${host}/notebooks/empty.ipynb?dbu=${encodeURIComponent(path)}#datalabBackendUrl=${host}${path}`;
};

function useAway(open: boolean, close: () => void, box: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
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
export function MachinePicker({ machine, onPick, disabled }: { machine: Machine; onPick: (machine: Machine) => void; disabled?: boolean }) {
  return (
    <div className="colab-pick" role="radiogroup" aria-label="Machine">
      {MACHINES.map((option) => (
        <button
          key={option.accelerator}
          type="button"
          role="radio"
          aria-checked={machine.accelerator === option.accelerator}
          className={`colab-opt${machine.accelerator === option.accelerator ? ' is-on' : ''}`}
          disabled={disabled}
          onClick={() => onPick({ ...machine, accelerator: option.accelerator })}
        >
          <b>{option.label}</b>
          <small>{option.note}</small>
        </button>
      ))}
    </div>
  );
}

/**
 * What the first Run says before anything happens: that a runtime starts in
 * the person's own Colab, on which machine, that Google will ask once for
 * Colab, and what the reader can and cannot do with it.
 */
export function ConnectCard({ cellLabel, onConnect, onClose, busy }: { cellLabel?: string; onConnect: (machine: Machine) => void; onClose: () => void; busy?: boolean }) {
  const colab = useColab();
  const { settings } = useStore();
  const [machine, pick] = useState<Machine>(colab.machine);
  const box = useRef<HTMLDivElement>(null);
  useAway(true, onClose, box);
  const available = colabAvailable(settings.googleClientId);
  return (
    <div className="menu right colab-menu colab-connect" role="dialog" aria-label="Run in Google Colab" ref={box}>
      <div className="menu-label">
        <b>Run {cellLabel ? `${cellLabel} ` : 'this cell '}in your Google Colab.</b> The first run starts a runtime in your own Colab account — the same one colab.research.google.com uses — and every cell on this page can then run in it with one click.
      </div>
      <MachinePicker machine={machine} onPick={pick} disabled={busy} />
      <div className="colab-google">
        <span className="colab-g" aria-hidden="true" />
        <div>
          Google will ask once for <b>Colab</b> access{settings.googleClientId ? ' on top of the sign-in you have given' : ''} (<code>auth/colaboratory</code>). It is kept the way the Drive token is: in this tab, for an hour, never on disk.
        </div>
      </div>
      <div className="colab-can">
        <div>
          <b>The reader can</b>
          <ul>
            <li>run the cells on this page you click</li>
            <li>show what they print here — and loss curves, when a cell prints losses</li>
            <li>read the machine's use while a cell runs — {machine.accelerator !== 'NONE' ? 'GPU, ' : ''}CPU, memory, disk — with a few lines of its own, every two seconds</li>
          </ul>
        </div>
        <div>
          <b>It cannot</b>
          <ul>
            <li>run anything without a click</li>
            <li>mount your Drive or read your notebooks</li>
            <li>start more than one runtime</li>
          </ul>
        </div>
      </div>
      <hr />
      {available ? (
        <button type="button" className="colab-action is-primary" disabled={busy} onClick={() => onConnect(machine)}>
          <b>{busy ? 'Connecting…' : `Connect and run${cellLabel ? ` ${cellLabel}` : ''}`}</b>
          <span>Opens Google's window, starts the {machineLabel(machine)} runtime, runs the cell. About fifteen seconds the first time.</span>
        </button>
      ) : (
        <div className="colab-status">
          <b>Not available here.</b> {settings.googleClientId ? 'Running cells needs the reader’s proxy (Settings → Paper proxy), which makes the calls to Colab that a page cannot.' : 'Give Settings → Google a client ID first: the runtime is started as you.'}
        </div>
      )}
      <div className="colab-hint">
        <ColabMark />
        The code was written by a model, from the paper. Read it before you run it: it runs as you, on your Colab quota. <b>Colab → Download the notebook</b> in the bar is the same cells for Colab's own page instead.
      </div>
    </div>
  );
}

/**
 * The chip in the bar: the Colab mark, a dot for the state, the machine and
 * how long it has been up. It opens to the runtime's menu — what it is,
 * what it costs, what has run — and to starting one when there is none.
 */
export function ColabChip({ cells }: { cells: { key: string; code: string; label: string }[] }) {
  const colab = useColab();
  const { settings, user } = useStore();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [probe, setProbe] = useState(false);
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setChanging(false);
  };
  useAway(open, close, box);
  useEffect(() => {
    if (!colab.startedAt) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [colab.startedAt]);
  const available = colabAvailable(settings.googleClientId);
  if (!available && colab.status === 'off') return null;
  const connected = colab.status === 'idle' || colab.status === 'busy';
  const ran = cells.filter((cell) => colab.runs[cell.key]?.state === 'ran').length;
  const dot = colab.status === 'busy' ? 'busy' : colab.status === 'connecting' ? 'busy' : connected ? 'on' : colab.status === 'lost' || colab.status === 'error' ? 'lost' : 'off';
  const text =
    colab.status === 'connecting'
      ? 'Colab · connecting…'
      : connected && colab.runtime
        ? `${machineLabel(colab.runtime)} · ${colab.reconnecting ? 'reconnecting…' : colab.status === 'busy' ? busyText(colab.sample) : 'idle'} · ${clock(colab.startedAt, now)}`
        : colab.status === 'lost'
          ? `${colab.runtime ? machineLabel(colab.runtime) : 'Colab'} · runtime ended`
          : colab.status === 'error'
            ? 'Colab · not connected'
            : 'Colab · no runtime';
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={`colab-chip is-${dot}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={colab.error || 'Your Colab runtime: the cells on this page run in it'}>
        <ColabMark />
        <span className={`colab-dot is-${dot}`} aria-hidden="true" />
        {text}
      </button>
      {open ? (
        connected || colab.status === 'busy' ? (
          <div className="menu right colab-menu colab-runtime" role="menu" aria-label="Your Colab runtime">
            <div className="menu-label">
              <b>Your Colab runtime</b> · started from this page{user?.email ? `, as ${user.email}` : ''}
            </div>
            <div className="colab-stats">
              <div>
                <span className="k">Machine</span>
                <span className="v">{colab.runtime ? machineLabel(colab.runtime) : '—'}</span>
              </div>
              <div>
                <span className="k">Up for</span>
                <span className="v">{clock(colab.startedAt, now) || '—'}</span>
              </div>
              <div>
                <span className="k">Compute units</span>
                <span className="v">
                  {colab.units?.balance !== undefined ? colab.units.balance.toFixed(1) : colab.runtime?.accelerator ? 'your tier’s' : '0'}
                  {colab.units?.ratePerHour ? <small> · {colab.units.ratePerHour.toFixed(2)}/h</small> : !colab.runtime?.accelerator ? <small> · free</small> : null}
                </span>
              </div>
            </div>
            {colab.specs ? (
              <div className="colab-specs" title="Read off the machine by the probe below, as the runtime connected">
                {colab.specs.gpuName ? (
                  <span>
                    <b>{colab.specs.gpuName}</b>
                    {colab.specs.vramMb ? ` · ${gigabytes(colab.specs.vramMb)}` : ''}
                  </span>
                ) : (
                  <span>
                    <b>No GPU</b>
                  </span>
                )}
                {colab.specs.cpus ? <span>{colab.specs.cpus} CPUs</span> : null}
                {colab.specs.ramTotalMb ? <span>{gigabytes(colab.specs.ramTotalMb)} RAM</span> : null}
                {colab.specs.diskFreeGb !== undefined ? <span>{colab.specs.diskFreeGb} GB disk free</span> : null}
                {colab.sample?.cpu !== undefined && colab.status === 'idle' ? <span className="colab-specs-now">CPU {colab.sample.cpu}% now</span> : null}
              </div>
            ) : null}
            <div className="colab-hint">
              {cells.length} {cells.length === 1 ? 'cell' : 'cells'} on this page · {ran} {ran === 1 ? 'has' : 'have'} run · variables are kept between runs, so a later cell sees an earlier one's
              {colab.via === 'proxy' ? ' · the kernel’s socket is carried by the proxy, since the runtime would not take this page’s own' : ''}
            </div>
            <label className="colab-switch">
              <input type="checkbox" checked={colab.gpuWatch} onChange={(event) => setGpuWatch(event.target.checked)} />
              <span>
                <b>Watch the machine while cells run</b>
                <small>
                  A few lines of the reader's own, in a second kernel, every two seconds: {colab.runtime?.accelerator ? <code>nvidia-smi</code> : null}
                  {colab.runtime?.accelerator ? ', ' : ''}
                  <code>/proc/stat</code>, <code>/proc/meminfo</code> and the disk. Drawn in the Runtime pane as GPU and CPU use, VRAM and RAM — not under the cells.{' '}
                  <button type="button" className="link" onClick={() => setProbe(!probe)}>
                    {probe ? 'Hide the probe' : 'Show the probe'}
                  </button>
                </small>
              </span>
            </label>
            {probe ? <pre className="colab-probe">{MACHINE_PROBE}</pre> : null}
            <hr />
            <button
              type="button"
              role="menuitem"
              className="colab-action"
              disabled={colab.status === 'busy' || !cells.length}
              onClick={() => {
                close();
                void runAll(cells);
              }}
            >
              <b>Run all {cells.length} {cells.length === 1 ? 'cell' : 'cells'}, top to bottom</b>
              <span>At once; stops at the first error</span>
            </button>
            {colab.runtime ? (
              <a className="colab-action" role="menuitem" href={attachUrl(colab.runtime.endpoint)} target="_blank" rel="noreferrer noopener">
                <b>Open this runtime in Colab ↗</b>
                <span>Colab's own notebook page on the same machine — for editing, plots, a terminal, or Drive, on purpose</span>
              </a>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="colab-action"
              disabled={colab.status === 'busy'}
              onClick={() => {
                close();
                void restartKernel();
              }}
            >
              <b>Restart the kernel</b>
              <span>Forgets every variable; keeps the machine and the files on it</span>
            </button>
            {changing ? (
              <div className="colab-status">
                A new runtime on another machine; this one is stopped.
                <MachinePicker
                  machine={colab.machine}
                  onPick={(machine) => {
                    setMachine(machine);
                    close();
                    void stopRuntime().then(() => connect(machine));
                  }}
                />
              </div>
            ) : (
              <button type="button" role="menuitem" className="colab-action" disabled={colab.status === 'busy'} onClick={() => setChanging(true)}>
                <b>Change machine…</b>
                <span>CPU, T4, L4, A100 — a new runtime; this one is stopped</span>
              </button>
            )}
            <hr />
            <button
              type="button"
              role="menuitem"
              className="colab-action is-danger"
              onClick={() => {
                close();
                void stopRuntime();
              }}
            >
              <b>Stop the runtime</b>
              <span>Releases the machine now. Colab stops an idle one itself after a while.</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="colab-action"
              onClick={() => {
                close();
                disconnect();
              }}
            >
              <b>Forget Colab in this tab</b>
              <span>Drops the connection and the token here. The permission itself is removed at myaccount.google.com/permissions.</span>
            </button>
          </div>
        ) : (
          <ConnectCard
            busy={colab.status === 'connecting'}
            onClose={close}
            onConnect={(machine) => {
              close();
              void connect(machine).catch(() => undefined);
            }}
          />
        )
      ) : null}
    </div>
  );
}

/** A line under the bar while the runtime is gone or the last thing failed, with the way back. */
export function ColabBanner() {
  const colab = useColab();
  const [hidden, setHidden] = useState<string | undefined>();
  if (!colab.error || hidden === colab.error || colab.status === 'connecting') return null;
  return (
    <div className={`colab-banner is-${colab.status}`} role="status">
      <ColabMark />
      <span className="colab-banner-text">{colab.error}</span>
      {colab.status === 'lost' || colab.status === 'error' || colab.status === 'off' ? (
        <button type="button" className="btn sm" onClick={() => void connect(colab.machine).catch(() => undefined)}>
          {colab.status === 'lost' ? `Start a new ${machineLabel(colab.machine)} runtime` : 'Try again'}
        </button>
      ) : null}
      <button type="button" className="btn sm ghost" onClick={() => setHidden(colab.error)}>
        Dismiss
      </button>
    </div>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const seconds = (ms: number | undefined) => (ms === undefined ? '' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** What the header of a cell that has run, or is running, says about it. */
export function RunState({ run }: { run: CellRun }) {
  if (run.state === 'queued') return <span className="cell-state is-queued">◌ Queued — runs after the cells before it</span>;
  if (run.state === 'running') {
    return (
      <span className="cell-state is-busy">
        <span className="spinner" /> Running on {run.where.replace(/^Colab · /, '')}
      </span>
    );
  }
  const label = run.state === 'ran' ? `✓ Ran in ${seconds(run.ms)}` : run.state === 'failed' ? `✕ Failed after ${seconds(run.ms)}` : '■ Stopped';
  return <span className={`cell-state is-${run.state}`}>{label}</span>;
}

function OutputView({ output, marked, offset }: { output: Output; marked: Set<number>; offset: number }) {
  if (output.type === 'image') return <img className="cell-image" alt="A figure the cell drew" src={`data:${output.mime};base64,${output.data}`} />;
  if (output.type === 'error') return <pre className="cell-error">{output.traceback || `${output.ename}: ${output.evalue}`}</pre>;
  const lines = output.text.replace(/\n$/, '').split('\n');
  return (
    <pre className={output.type === 'stream' && output.name === 'stderr' ? 'is-stderr' : undefined}>
      {lines.map((line, index) => (
        <span key={index} className={marked.has(offset + index) ? 'is-diff' : undefined}>
          {line}
          {index < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
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
export function CellRunOutput({ run, expected, onAsk, onForget, asker = 'Claude', writer = 'Claude' }: { run: CellRun; expected?: string; onAsk?: (request: string) => void; onForget: () => void; asker?: string; writer?: string }) {
  const [showExpected, setShowExpected] = useState(false);
  const live = run.state === 'running' || run.state === 'queued';
  const verdict = live ? 'none' : compareOutput(expected, run.outputs);
  const actual = outputText(run.outputs);
  const marked = verdict === 'differs' ? differingLines(expected, actual) : new Set<number>();
  const failed = run.outputs.some((output) => output.type === 'error');
  // A training loop that prints its losses earns a curve. The machine's use while it ran is the Runtime pane's, not the cell's: under every cell it was only in the way.
  const losses = useMemo(() => lossSeries(actual), [actual]);
  const curve = hasCurve(losses);
  // Line offsets so the tint lands on the right line across several stream outputs.
  const offsets: number[] = [];
  let count = 0;
  for (const output of run.outputs) {
    offsets.push(count);
    if (output.type === 'stream' || output.type === 'text') count += output.text.replace(/\n$/, '').split('\n').length;
  }
  return (
    <div className={`cell-output is-run${live ? ' is-live' : ''}${run.stale ? ' is-stale' : ''}`}>
      <div className="cell-output-label">
        {live ? <span className="spinner" /> : null}
        <span>{live ? 'Output · streaming from Colab' : `Output · ${run.where} · ${time(run.startedAt)}${run.stale ? ' · that runtime has ended' : ''}`}</span>
        <span className="spacer" />
        {!live ? (
          failed ? (
            <span className="cell-verdict is-bad">✕ Error</span>
          ) : verdict === 'match' ? (
            <span className="cell-verdict is-ok">✓ Matches what {writer} expected</span>
          ) : verdict === 'differs' ? (
            <span className="cell-verdict is-diff">◐ Differs from what {writer} expected</span>
          ) : null
        ) : null}
      </div>
      {run.outputs.length ? run.outputs.map((output, index) => <OutputView key={index} output={output} marked={marked} offset={offsets[index]} />) : !live ? <pre className="is-empty">(nothing printed)</pre> : null}
      {live && run.outputs.length ? <span className="caret" aria-hidden="true" /> : null}
      {curve ? <LossChart series={losses} live={live} /> : null}
      {!live ? (
        <div className="cell-actions">
          {onAsk && failed ? (
            <button type="button" className="btn sm" onClick={() => onAsk(`This cell fails when run in Colab. The traceback:\n\n\`\`\`\n${actual.slice(0, 4000)}\n\`\`\`\n\nFix the cell so it runs, keep it short, and keep its expected output and explanation in step with the fix.`)}>
              Ask {asker} to fix this cell
            </button>
          ) : onAsk && verdict === 'differs' ? (
            <button type="button" className="btn sm" onClick={() => onAsk(`This cell was run in Colab and printed something other than the expected output you wrote. What it printed:\n\n\`\`\`\n${actual.slice(0, 4000)}\n\`\`\`\n\nExplain the difference in a sentence or two where the cell is, and if your expected output was wrong, correct it to what the code prints.`)}>
              Ask {asker} why it differs
            </button>
          ) : null}
          {expected ? (
            <button type="button" className="btn sm ghost" onClick={() => setShowExpected(!showExpected)}>
              {showExpected ? `Hide what ${writer} expected` : `Show what ${writer} expected`}
            </button>
          ) : null}
          <button type="button" className="btn sm ghost" onClick={onForget} title="Put the expected output back, as if the cell had not run">
            Clear
          </button>
        </div>
      ) : null}
      {showExpected && expected ? (
        <div className="cell-expected">
          <div className="cell-output-label">Expected output · written by Claude</div>
          <pre>{expected}</pre>
        </div>
      ) : null}
    </div>
  );
}
