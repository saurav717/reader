// ===========================================================================
//  The Implementation page's own pieces. The page itself is Explain.tsx —
//  the same bar, outline, sections and ask bar, switched to the plan by the
//  tab in the bar — and these are what the plan has that the explanation
//  does not: a directory tree, starter files, a compute budget worked out
//  for the reader's machine, the picker for that machine, the empty state,
//  and the Colab menu that takes the scaffold out of the page.
// ===========================================================================

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { cellKey, colabAvailable, colabGranted, connect as connectColab, probeMachine, runAll, runCell, setMachine } from '../lib/colab';
import type { Accelerator } from '../lib/colab';
import { colabChoices, colabMachine, colabMachineOf, colabSteps, needsOn } from '../lib/colabRun';
import type { ColabStep } from '../lib/colabRun';
import type { Block, Section } from '../lib/explain';
import { commitFiles, targetFrom } from '../lib/github';
import type { RepoFiles } from '../lib/github';
import { DEFAULT_HARDWARE, estimate, FIT_TEXT, flopsText, GPUS, gpuById, hoursText, matchGpu, normaliseHardware, parseCompute, usdText } from '../lib/hardware';
import type { Compute, Estimate, Fit, Hardware } from '../lib/hardware';
import { colabUrl, computeOf, hardwareNow, parseTree, scaffold, scaffoldNotebook, scaffoldZip, setHardware, slugOf, subscribeHardware } from '../lib/implement';
import { useStore } from '../lib/store';
import { runInWorkspace, workspaceStatus, writeScaffold } from '../lib/workspace';
import type { WorkspaceStatus, Written } from '../lib/workspace';
import { gigabytes } from '../lib/telemetry';
import { MachineChart } from './Charts';
import { CellRunOutput, ColabMark, ConnectCard, RunState, useColab } from './Colab';
import { CloseIcon, ColabIcon, ExplainIcon, LocalIcon } from './icons';
import { highlightPython } from './Explain';
import { KeepButton } from './Keep';

/** The plan the page is showing — its title and sections — for the pieces that need more than their own block, such as the Colab panel under the budget. */
export const PlanContext = createContext<{ title: string; sections: Section[] } | null>(null);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const useHardware = () => useSyncExternalStore(subscribeHardware, hardwareNow);

// ---------------------------------------------------------------------------
// The local workspace, as the page sees it: the proxy's answer about the
// machine, the project written there, and the console running in it. Module
// state, so the tab can be switched and the run goes on.
// ---------------------------------------------------------------------------

interface LocalState {
  status?: WorkspaceStatus;
  checking: boolean;
  /** The project written to the workspace, for this page. */
  project?: { slug: string; dir: string; written: Written };
  console: { open: boolean; command: string; output: string; running: boolean; error?: string };
}

let local: LocalState = { checking: false, console: { open: false, command: '', output: '', running: false } };
const localListeners = new Set<() => void>();
const setLocal = (patch: Partial<LocalState>) => {
  local = { ...local, ...patch };
  localListeners.forEach((listener) => listener());
};
const setConsole = (patch: Partial<LocalState['console']>) => setLocal({ console: { ...local.console, ...patch } });
const subscribeLocal = (listener: () => void) => {
  localListeners.add(listener);
  return () => {
    localListeners.delete(listener);
  };
};
export const useLocal = () => useSyncExternalStore(subscribeLocal, () => local);

/** Asks the proxy about the machine, once, or again on `refresh`. */
export async function checkWorkspace(refresh = false) {
  if (local.checking || (local.status && !refresh)) return;
  setLocal({ checking: true });
  const status = await workspaceStatus();
  setLocal({ status, checking: false });
}

let controller: AbortController | null = null;

/** Runs a command in the project's directory, its output into the console. */
export async function runLocally(command: string) {
  const project = local.project;
  if (!project || local.console.running || !command.trim()) return;
  controller = new AbortController();
  setConsole({ open: true, command, output: '', running: true, error: undefined });
  try {
    await runInWorkspace(project.slug, command, (text) => setConsole({ output: text }), controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) setConsole({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    controller = null;
    setConsole({ running: false });
  }
}

export function stopLocally() {
  controller?.abort();
}

/** The commands the page suggests running: its shell cells, and the Makefile's targets. */
export function suggestedCommands(sections: Section[]): { label: string; command: string }[] {
  const out: { label: string; command: string }[] = [];
  for (const section of sections)
    for (const block of section.blocks) {
      if (block.kind === 'file' && /(^|\/)Makefile$/.test(block.path)) {
        for (const match of block.code.matchAll(/^([a-z][\w-]*):(?!=)/gm)) if (!out.some((c) => c.command === `make ${match[1]}`)) out.push({ label: `make ${match[1]}`, command: `make ${match[1]}` });
      }
      if (block.kind === 'code' && block.lang === 'bash' && !block.open) out.push({ label: block.title, command: block.code.trim() });
    }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// A directory tree
// ---------------------------------------------------------------------------

export function TreeBlock({ block }: { block: Extract<Block, { kind: 'tree' }> }) {
  const rows = useMemo(() => parseTree(block.text), [block.text]);
  return (
    <figure className="impl-tree">
      <header>
        <span className="cell-index">tree</span>
        <span className="cell-title">Repository layout</span>
      </header>
      <ol>
        {rows.map((row, index) => (
          <li key={index} className={row.dir ? 'is-dir' : 'is-file'} style={{ paddingLeft: 14 + row.depth * 18 }}>
            <span className="tree-icon" aria-hidden="true">
              {row.dir ? (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                  <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                  <path d="M4 1.5h5l3 3v10H4v-13Z" />
                  <path d="M9 1.5v3h3" />
                </svg>
              )}
            </span>
            <span className="tree-name">{row.name}</span>
            {row.note ? <span className="tree-note">{row.note}</span> : null}
          </li>
        ))}
        {block.open ? <li className="tree-writing">…</li> : null}
      </ol>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// A starter file
// ---------------------------------------------------------------------------

export function FileBlock({ block }: { block: Extract<Block, { kind: 'file' }> }) {
  const [copied, setCopied] = useState(false);
  const lines = block.code.replace(/\s+$/, '').split('\n').length;
  return (
    <figure className="impl-file" data-path={block.path}>
      <header>
        <span className="file-path" title={block.path}>
          <span className="file-dir">{block.path.includes('/') ? `${block.path.slice(0, block.path.lastIndexOf('/') + 1)}` : ''}</span>
          <b>{block.path.slice(block.path.lastIndexOf('/') + 1)}</b>
        </span>
        <span className="file-meta">
          {block.lang} · {lines} {lines === 1 ? 'line' : 'lines'}
        </span>
        <KeepButton selector=".impl-file" what="file" />
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(block.code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <pre className="cell-code">
        <code dangerouslySetInnerHTML={{ __html: block.lang === 'python' ? highlightPython(block.code) : esc(block.code) }} />
        {block.open ? <span className="caret" aria-hidden="true" /> : null}
      </pre>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// The reader's machine
// ---------------------------------------------------------------------------

const RAM_CHOICES = [8, 16, 32, 64, 128, 256, 512, 1024];
const DISK_CHOICES = [50, 100, 200, 500, 1000, 2000, 4000];

/**
 * The picker. What it sets is kept in this browser and sent to Claude with
 * every request, and the compute budget on the page recomputes from it as it
 * changes. `compact` is the version in the outline.
 */
export function HardwarePanel({ compact }: { compact?: boolean }) {
  const hardware = useHardware();
  const gpu = gpuById(hardware.gpu);
  const set = (patch: Partial<Hardware>) => setHardware(normaliseHardware({ ...hardware, ...patch }));
  const counts = Array.from({ length: gpu.maxCount }, (_, i) => i + 1);
  return (
    <div className={`hardware-panel${compact ? ' is-compact' : ''}`} role="group" aria-label="Your machine">
      <label className="hw-field hw-gpu">
        <span>Accelerator</span>
        <select value={hardware.gpu} onChange={(event) => set({ gpu: event.target.value, count: 1 })} aria-label="Accelerator">
          {['Colab', 'a desktop', 'rented', 'other'].map((group) => (
            <optgroup key={group} label={group === 'other' ? 'Elsewhere' : group === 'rented' ? 'Rented by the hour' : group === 'a desktop' ? 'Your own' : 'Google Colab'}>
              {GPUS.filter((g) => (group === 'Colab' ? g.colab : group === 'a desktop' ? g.where === 'a desktop' : group === 'rented' ? g.where.startsWith('rented') : !g.colab && g.where !== 'a desktop' && !g.where.startsWith('rented'))).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} — {g.where}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="hw-field">
        <span>Cards</span>
        <select value={hardware.count} disabled={gpu.maxCount === 1} onChange={(event) => set({ count: Number(event.target.value) })} aria-label="How many cards">
          {counts.map((n) => (
            <option key={n} value={n}>
              {n}×
            </option>
          ))}
        </select>
      </label>
      <label className="hw-field">
        <span>RAM</span>
        <select value={RAM_CHOICES.includes(hardware.ramGb) ? hardware.ramGb : 'custom'} onChange={(event) => set({ ramGb: Number(event.target.value) })} aria-label="System memory">
          {RAM_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n} GB
            </option>
          ))}
          {!RAM_CHOICES.includes(hardware.ramGb) ? <option value="custom">{hardware.ramGb} GB</option> : null}
        </select>
      </label>
      <label className="hw-field">
        <span>Free disk</span>
        <select value={DISK_CHOICES.includes(hardware.diskGb) ? hardware.diskGb : 'custom'} onChange={(event) => set({ diskGb: Number(event.target.value) })} aria-label="Free disk">
          {DISK_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n >= 1000 ? `${n / 1000} TB` : `${n} GB`}
            </option>
          ))}
          {!DISK_CHOICES.includes(hardware.diskGb) ? <option value="custom">{hardware.diskGb} GB</option> : null}
        </select>
      </label>
      {!compact ? (
        <>
          <label className="hw-field hw-range">
            <span>
              Hours a day <b>{hardware.hoursPerDay}</b>
            </span>
            <input type="range" min={1} max={24} step={1} value={hardware.hoursPerDay} onChange={(event) => set({ hoursPerDay: Number(event.target.value) })} aria-label="Hours a day the machine is yours" />
          </label>
          <label className="hw-field hw-range" title="Model FLOPs utilisation: the share of the card's peak that training really reaches. 30–50% is a well-tuned transformer; small batches and small models sit lower.">
            <span>
              Utilisation <b>{Math.round(hardware.mfu * 100)}%</b>
            </span>
            <input type="range" min={0.1} max={0.6} step={0.05} value={hardware.mfu} onChange={(event) => set({ mfu: Number(event.target.value) })} aria-label="Utilisation of the card's peak" />
          </label>
        </>
      ) : null}
      <UseThisMachine />
      <div className="hw-note">
        {gpu.id === 'cpu'
          ? 'No accelerator: only the smallest experiments are practical.'
          : `${hardware.count > 1 ? `${hardware.count}× ` : ''}${gpu.tflops} TFLOPS bf16 · ${gpu.vramGb} GB${hardware.count > 1 ? ` a card` : ''}${gpu.usdPerHour ? ` · about $${gpu.usdPerHour}/h${hardware.count > 1 ? ' a card' : ''}` : ' · no hourly cost'}${gpu.sessionHours ? ` · sessions of up to ${gpu.sessionHours} h` : ''}`}
        {hardware !== DEFAULT_HARDWARE ? null : ''}
      </div>
    </div>
  );
}

/** "Use this machine": what the proxy found under the desk, into the picker. */
function UseThisMachine() {
  const { status, checking } = useLocal();
  useEffect(() => {
    void checkWorkspace();
  }, []);
  if (!status?.available) return null;
  const { machine } = status;
  const card = machine.gpus[0];
  const matched = card ? matchGpu(card.name, card.vramGb) : null;
  const apply = () => {
    const hardware = hardwareNow();
    setHardware(
      normaliseHardware({
        ...hardware,
        gpu: matched?.id ?? 'cpu',
        count: matched ? Math.max(1, machine.gpus.length) : 1,
        ramGb: machine.ramGb || hardware.ramGb,
        diskGb: machine.diskFreeGb ?? hardware.diskGb,
        hoursPerDay: 24,
      }),
    );
  };
  return (
    <div className="hw-detect">
      <button type="button" className="btn sm" onClick={apply} disabled={checking} title={card ? `${machine.gpus.length}× ${card.name}${card.vramGb ? ` (${card.vramGb} GB)` : ''}, ${machine.ramGb} GB RAM` : 'No NVIDIA card was found; the CPU only'}>
        <LocalIcon size={14} /> Use this machine
      </button>
      <span>
        {machine.host}: {card ? `${machine.gpus.length > 1 ? `${machine.gpus.length}× ` : ''}${card.name}${card.vramGb ? ` · ${card.vramGb} GB` : ''}` : 'no NVIDIA GPU found'} · {machine.ramGb} GB RAM
        {matched && card && !new RegExp(matched.label.split(' ')[0], 'i').test(card.name) ? ` · nearest in the list: ${matched.label}` : ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The compute budget, for that machine
// ---------------------------------------------------------------------------

const fitClass = (fit: Fit) => `fit-${fit}`;

function FitChip({ fit }: { fit: Fit }) {
  return <span className={`fit-chip ${fitClass(fit)}`}>{FIT_TEXT[fit]}</span>;
}

export function ComputeBlock({ block }: { block: Extract<Block, { kind: 'compute' }> }) {
  const hardware = useHardware();
  const compute = useMemo(() => (block.open ? null : parseCompute(block.text)), [block.text, block.open]);
  if (!compute) {
    return (
      <figure className="impl-budget">
        <header>
          <span className="cell-index">budget</span>
          <span className="cell-title">Compute budget</span>
        </header>
        <div className="budget-empty">{block.open ? 'Working out the budget…' : 'The budget could not be read. Ask for it again from the bar: “Rewrite the compute block as valid JSON”.'}</div>
      </figure>
    );
  }
  return (
    <>
      <Budget compute={compute} hardware={hardware} />
      <ColabRunPanel compute={compute} hardware={hardware} />
    </>
  );
}

function Budget({ compute, hardware }: { compute: Compute; hardware: Hardware }) {
  const est = estimate(compute, hardware);
  const [editing, setEditing] = useState(false);
  const longest = Math.max(1e-9, ...est.phases.map((phase) => phase.hours));
  const gpu = est.gpu;
  const machine = gpu.id === 'cpu' ? 'CPU only' : `${hardware.count}× ${gpu.label}`;
  return (
    <figure className="impl-budget" id="compute-budget">
      <header>
        <span className="cell-index">budget</span>
        <span className="cell-title">
          Compute budget on <b>{machine}</b>
        </span>
        <KeepButton selector=".impl-budget" what="budget" />
        <button type="button" className="btn sm ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Change machine'}
        </button>
      </header>
      {editing ? <HardwarePanel /> : null}
      <div className="budget-summary">
        <div className="budget-stat">
          <span className="stat-label">Wall clock</span>
          <b>{hoursText(est.hours)}</b>
          <span className="stat-note">{est.days >= 1 ? `${est.days.toFixed(1).replace(/\.0$/, '')} days at ${hardware.hoursPerDay} h a day` : 'in one sitting'}</span>
        </div>
        <div className="budget-stat">
          <span className="stat-label">Cost</span>
          <b>{usdText(est.usd)}</b>
          <span className="stat-note">{gpu.usdPerHour ? `at about $${gpu.usdPerHour}/h a card` : gpu.colab ? 'on the free tier' : 'your own hardware'}</span>
        </div>
        <div className="budget-stat">
          <span className="stat-label">Memory</span>
          <FitChip fit={est.fit} />
          <span className="stat-note">
            {compute.minVramGb !== undefined ? `needs ${compute.minVramGb} GB · ${gpu.vramGb ? `${gpu.vramGb * hardware.count} GB here` : 'no card'}` : ''}
          </span>
        </div>
        {est.sessions !== undefined ? (
          <div className="budget-stat">
            <span className="stat-label">Colab sessions</span>
            <b>{est.sessions}</b>
            <span className="stat-note">{est.sessions > 1 ? 'checkpoint to Drive between them' : `up to ${gpu.sessionHours} h each`}</span>
          </div>
        ) : null}
      </div>
      <div className="budget-scroll">
      <table className="budget-table">
        <thead>
          <tr>
            <th>Phase</th>
            <th>Work</th>
            <th>On your machine</th>
            <th>Memory</th>
          </tr>
        </thead>
        <tbody>
          {est.phases.map((row, index) => (
            <tr key={index}>
              <td>
                <b>{row.phase.name}</b>
                {row.phase.note ? <span className="phase-note">{row.phase.note}</span> : null}
              </td>
              <td className="mono">
                {row.phase.flops !== undefined ? flopsText(row.phase.flops) : row.phase.h100Hours !== undefined ? `${row.phase.h100Hours} H100 h` : '—'}
                {row.phase.parallel === false ? <span className="phase-note">one card</span> : null}
              </td>
              <td>
                <div className="phase-bar" style={{ width: `${Math.max(2, (row.hours / longest) * 100)}%` }} />
                <span className="phase-hours">{hoursText(row.hours)}</span>
                {row.usd > 0 ? <span className="phase-usd">{usdText(row.usd)}</span> : null}
              </td>
              <td>
                {row.phase.memoryGb !== undefined ? <span className="mono">{row.phase.memoryGb} GB</span> : null} <FitChip fit={row.fit} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="budget-foot">
        {compute.diskGb !== undefined ? (
          <span className={est.disk === 'no' ? 'is-bad' : ''}>
            Disk: {compute.diskGb} GB needed, {hardware.diskGb} GB free{est.disk === 'no' ? ' — not enough' : ''}
          </span>
        ) : null}
        {compute.ramGb !== undefined ? (
          <span className={est.ram === 'no' ? 'is-bad' : ''}>
            RAM: {compute.ramGb} GB needed, {hardware.ramGb} GB here{est.ram === 'no' ? ' — not enough' : ''}
          </span>
        ) : null}
        {est.fit !== 'fits' && compute.shrink ? <span className="shrink">To get it to fit: {compute.shrink}</span> : null}
        <span className="assumption">
          Hours are FLOPs ÷ ({hardware.count > 1 ? `${hardware.count} × ` : ''}
          {gpu.tflops} TFLOPS × {Math.round(hardware.mfu * 100)}% utilisation); an estimate, not a promise.
        </span>
      </div>
    </figure>
  );
}

/** The budget in three lines, for the outline: the machine, the time, the fit. */
export function HardwareSummary({ sections }: { sections: Section[] }) {
  const hardware = useHardware();
  const compute = useMemo(() => computeOf(sections), [sections]);
  const gpu = gpuById(hardware.gpu);
  const est: Estimate | null = compute ? estimate(compute, hardware) : null;
  return (
    <div className="outline-hardware">
      <div className="aged-label">Your machine</div>
      <div className="hw-summary-line">
        <b>{gpu.id === 'cpu' ? 'CPU only' : `${hardware.count}× ${gpu.label}`}</b>
        <span>{gpu.where}</span>
      </div>
      {est ? (
        <div className="hw-summary-est">
          <span className="est-time">{hoursText(est.hours)}</span>
          <span className="est-cost">{usdText(est.usd)}</span>
          <FitChip fit={est.fit} />
        </div>
      ) : null}
      <a
        href="#compute-budget"
        className="hw-change"
        onClick={(event) => {
          event.preventDefault();
          const target = document.getElementById('compute-budget') ?? document.querySelector('.impl-budget');
          target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
        }}
      >
        Change machine
      </a>
      {est ? (
        <a
          href="#run-on-colab"
          className="hw-change"
          onClick={(event) => {
            event.preventDefault();
            openColabPanel();
          }}
        >
          Run it on Colab
        </a>
      ) : null}
    </div>
  );
}

/** Brings the Colab panel under the budget into view, opened. */
export function openColabPanel() {
  const target = document.getElementById('run-on-colab');
  if (!target) return;
  target.querySelector<HTMLButtonElement>('button[aria-expanded="false"].colab-panel-toggle')?.click();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Before there is a plan
// ---------------------------------------------------------------------------

export function ImplementEmpty({ title, byline, children }: { title: string; byline?: string; children: ReactNode }) {
  return (
    <div className="explain-empty impl-empty">
      <div className="explain-kicker pill">
        <ExplainIcon size={15} /> The paper, as a project
      </div>
      <h1>{title}</h1>
      {byline ? <div className="byline">{byline}</div> : null}
      <p className="explain-lede">
        The model reads the paper and plans how to <b>build it</b>: <mark>what to reproduce</mark> and what to leave out, <mark>which datasets</mark> and
        where to get them, how to <mark>lay the code out</mark>, the starter files, and <b>what it costs</b> — in hours and dollars on the machine you
        pick below.
      </p>
      <ul className="explain-promises impl-promises">
        <li className="p-data">
          <span className="promise-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <ellipse cx="12" cy="6" rx="7.5" ry="3" />
              <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
              <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
            </svg>
          </span>
          <b>Datasets</b>
          <span>what the paper used, what is public, how to get it</span>
        </li>
        <li className="p-tree">
          <span className="promise-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h5l2 2h9v11H4V5Z" />
              <path d="M4 10h16" />
            </svg>
          </span>
          <b>Repository &amp; starter files</b>
          <span>the layout, the skeletons, a zip or a commit</span>
        </li>
        <li className="p-budget">
          <span className="promise-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 7.5V12l3 2" />
            </svg>
          </span>
          <b>Compute budget</b>
          <span>hours, dollars and memory for your hardware</span>
        </li>
        <li className="p-colab">
          <span className="promise-icon" aria-hidden="true">
            <span className="colab-mark">co</span>
          </span>
          <b>Colab</b>
          <span>a notebook that lays the repository out and runs</span>
        </li>
      </ul>
      <div className="impl-machine">
        <div className="impl-machine-head">
          <b>Your machine</b>
          <span>The model plans for it: the scale, the batch sizes, the substitutions.</span>
        </div>
        <HardwarePanel />
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colab: the scaffold out of the page
// ---------------------------------------------------------------------------

type PushState = { state: 'idle' } | { state: 'pushing' } | { state: 'pushed'; url: string; commit: string | null } | { state: 'error'; message: string };

function download(name: string, blob: Blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/**
 * The menu under "Colab" in the bar. Colab opens a notebook it can fetch —
 * from GitHub, or uploaded by hand — so the surest route is the reader's own
 * Git mirror: the starter files, the plan and the notebook go there as one
 * commit, and Colab is opened on the notebook. Without a repository, the
 * notebook and the zip download, and Colab's upload takes them.
 */
export function ColabMenu({ title, content, sections }: { title: string; content: string; sections: Section[] }) {
  const { settings } = useStore();
  const target = targetFrom(settings);
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState<PushState>({ state: 'idle' });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const files = useMemo(() => scaffold(title, content, sections), [title, content, sections]);
  const fileCount = Object.keys(files.files).length - 2;
  const slug = slugOf(title);

  const pushToGitHub = async () => {
    if (!target) return;
    setPush({ state: 'pushing' });
    try {
      const result = await commitFiles(target, files.files as RepoFiles, `Implementation scaffold for “${title.slice(0, 72)}”, planned by Claude in Reader`);
      const url = colabUrl(target.owner, target.repo, target.branch, `${files.folder}/${slug}.ipynb`);
      setPush({ state: 'pushed', url, commit: result.commit });
      // The window opens from the click when the commit is quick; when it is not, the link in the menu is there.
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      setPush({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className="btn sm colab-open" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Take the scaffold to Google Colab, a zip, or your Git repository">
        <ColabIcon size={15} /> Colab
      </button>
      {open ? (
        <div className="menu right colab-menu" role="menu" aria-label="Colab">
          <div className="menu-label">
            {fileCount} starter {fileCount === 1 ? 'file' : 'files'}, the plan, and a notebook that writes them
          </div>
          <button
            type="button"
            role="menuitem"
            className="colab-action is-primary"
            onClick={() => {
              setOpen(false);
              openColabPanel();
            }}
          >
            <b>Run it on Colab, from this page</b>
            <span>Pick the machine, run the steps in order in your own runtime, and watch the GPU and CPU as they run — under the compute budget</span>
          </button>
          {target ? (
            <>
              <button type="button" role="menuitem" className="colab-action" disabled={push.state === 'pushing'} onClick={() => void pushToGitHub()}>
                <b>{push.state === 'pushing' ? 'Committing…' : 'Commit to GitHub and open in Colab'}</b>
                <span>
                  {files.folder}/ in {target.owner}/{target.repo} on {target.branch}
                </span>
              </button>
              {push.state === 'pushed' ? (
                <div className="colab-status is-ok">
                  {push.commit ? 'Committed. ' : 'Already up to date. '}
                  <a href={push.url} target="_blank" rel="noreferrer noopener">
                    Open in Colab ↗
                  </a>
                </div>
              ) : push.state === 'error' ? (
                <div className="colab-status is-error">{push.message}</div>
              ) : null}
            </>
          ) : (
            <div className="colab-status">
              <b>No repository connected.</b> Give Settings → Git repository a repo and a token, and one click commits the scaffold and opens it in Colab. Until then, the
              notebook below opens with <i>File → Upload notebook</i>.
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            className="colab-action"
            onClick={() => download(`${slug}.ipynb`, new Blob([scaffoldNotebook(title, sections)], { type: 'application/x-ipynb+json' }))}
          >
            <b>Download the notebook</b>
            <span>.ipynb — its first cells write the starter files, then the page's cells run</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="colab-action"
            onClick={() => download(`${slug}.zip`, new Blob([scaffoldZip(title, content, sections) as BlobPart], { type: 'application/zip' }))}
          >
            <b>Download the scaffold</b>
            <span>.zip — the directories and files, the plan as PLAN.md, the notebook</span>
          </button>
          <div className="colab-hint">
            <span className="colab-mark" aria-hidden="true">
              co
            </span>
            The notebook is the same cells for Colab's own page, and the one route to mounting Drive there.
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local: the scaffold onto the reader's own machine, and run there
// ---------------------------------------------------------------------------

/**
 * The menu under "Local" in the bar. The proxy on the reader's machine
 * (server/workspace.js) writes the starter files, the plan and the notebook
 * into READER_WORKSPACE/<paper>/ and runs the page's commands there, with
 * the output in a console at the bottom of the page. Without the proxy, or
 * without READER_WORKSPACE, it says what to set.
 */
export function LocalMenu({ title, content, sections }: { title: string; content: string; sections: Section[] }) {
  const { status, checking, project } = useLocal();
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState<'idle' | 'writing' | 'error'>('idle');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void checkWorkspace();
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const files = useMemo(() => scaffold(title, content, sections), [title, content, sections]);
  const slug = slugOf(title);
  const mine = project?.slug === slug ? project : undefined;
  const commands = useMemo(() => suggestedCommands(sections), [sections]);

  const write = async (overwrite = false) => {
    setWriting('writing');
    setError('');
    try {
      // The files without the implementations/ folder: the workspace has one folder a paper already.
      const flat: RepoFiles = {};
      for (const [path, text] of Object.entries(files.files)) flat[path.replace(/^implementations\/[^/]+\//, '')] = text;
      const written = await writeScaffold(slug, flat, overwrite);
      setLocal({ project: { slug, dir: written.dir, written } });
      setWriting('idle');
      void checkWorkspace(true);
    } catch (failure) {
      setWriting('error');
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={`btn sm local-open${mine ? ' is-on' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Write the scaffold onto this machine, through the reader's proxy, and run it there">
        <LocalIcon size={15} /> Local
      </button>
      {open ? (
        <div className="menu right local-menu" role="menu" aria-label="Local workspace">
          {checking && !status ? (
            <div className="colab-status">Asking the proxy about this machine…</div>
          ) : !status?.available ? (
            <div className="colab-status">
              <b>No local workspace.</b> {status?.reason ?? ''}
              <pre className="local-setup">{`READER_WORKSPACE=~/reader-workspace npm start`}</pre>
              then point Settings → Paper proxy at it, and the scaffold can be written and run here.
            </div>
          ) : (
            <>
              <div className="local-machine">
                <b>{status.machine.host}</b>
                <span>
                  {status.machine.gpus.length ? status.machine.gpus.map((gpu) => `${gpu.name}${gpu.vramGb ? ` ${gpu.vramGb} GB` : ''}`).join(', ') : 'no NVIDIA GPU'} · {status.machine.ramGb} GB RAM
                  {status.machine.diskFreeGb !== undefined ? ` · ${status.machine.diskFreeGb} GB free` : ''}
                </span>
                <span>
                  {status.machine.python ?? 'no python on the path'}
                  {status.machine.torch ? ` · torch ${status.machine.torch.version}${status.machine.torch.cuda ? ' with CUDA' : ', no CUDA'}` : ''}
                </span>
              </div>
              <button type="button" role="menuitem" className="colab-action" disabled={writing === 'writing'} onClick={() => void write(false)}>
                <b>{writing === 'writing' ? 'Writing…' : mine ? 'Write the scaffold again' : 'Write the scaffold here'}</b>
                <span>
                  {status.root}/{slug}/ — {Object.keys(files.files).length} files; one you have changed is left alone
                </span>
              </button>
              {mine ? (
                <div className="colab-status is-ok">
                  {mine.written.written.length} written{mine.written.skipped.length ? `, ${mine.written.skipped.length} left as you had ${mine.written.skipped.length === 1 ? 'it' : 'them'}` : ''}
                  {mine.written.skipped.length ? (
                    <>
                      {' · '}
                      <button type="button" className="link" onClick={() => void write(true)}>
                        replace {mine.written.skipped.length === 1 ? 'it' : 'them'}
                      </button>
                    </>
                  ) : null}
                  <div className="local-dir">{mine.dir}</div>
                </div>
              ) : null}
              {writing === 'error' ? <div className="colab-status is-error">{error}</div> : null}
              {mine ? (
                <>
                  <div className="menu-label">Run there</div>
                  {commands.slice(0, 6).map((command) => (
                    <button
                      key={command.command}
                      type="button"
                      role="menuitem"
                      className="colab-action local-command"
                      onClick={() => {
                        setOpen(false);
                        void runLocally(command.command);
                      }}
                    >
                      <b>{command.label}</b>
                      <span>{command.command.split('\n')[0]}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    className="colab-action"
                    onClick={() => {
                      setOpen(false);
                      setConsole({ open: true });
                    }}
                  >
                    <b>Open the console</b>
                    <span>any command, in the project's directory</span>
                  </button>
                </>
              ) : null}
              <div className="colab-hint">
                <LocalIcon size={14} /> Commands run as the user who started the proxy, in {status.root}.
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The console at the bottom of the page: a command, its output as it comes, Stop. */
export function RunConsole({ sections }: { sections: Section[] }) {
  const { project, console: state } = useLocal();
  const [draft, setDraft] = useState('');
  const out = useRef<HTMLPreElement>(null);
  const commands = useMemo(() => suggestedCommands(sections), [sections]);
  useEffect(() => {
    const element = out.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.output]);
  if (!state.open || !project) return null;
  return (
    <section className="run-console" role="region" aria-label="Local console">
      <header>
        <LocalIcon size={15} />
        <span className="console-dir" title={project.dir}>
          {project.dir}
        </span>
        {state.running ? (
          <span className="console-live">
            <span className="spinner" /> running
          </span>
        ) : null}
        <button type="button" className="icon-btn sm" aria-label="Close the console" onClick={() => setConsole({ open: false })}>
          <CloseIcon size={15} />
        </button>
      </header>
      <form
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runLocally(draft);
        }}
      >
        <span className="console-prompt">$</span>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="a command, in the project's directory — make test, python -m minitron.importance, nvidia-smi…" aria-label="Command to run" disabled={state.running} />
        {state.running ? (
          <button type="button" className="btn sm" onClick={stopLocally}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn sm primary" disabled={!draft.trim()}>
            Run
          </button>
        )}
      </form>
      {commands.length ? (
        <div className="console-suggestions">
          {commands.slice(0, 6).map((command) => (
            <button key={command.command} type="button" className="ask-suggestion" disabled={state.running} onClick={() => void runLocally(command.command)} title={command.command}>
              {command.label}
            </button>
          ))}
        </div>
      ) : null}
      {state.error ? <div className="console-error">{state.error}</div> : null}
      <pre className="console-out" ref={out}>
        {state.output || (state.running ? '' : 'Nothing has run yet.')}
      </pre>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Run it on Colab: the plan, run in the reader's own runtime from the page,
// with the machine watched while it does
// ---------------------------------------------------------------------------

const PANEL_KEY = 'reader.implement.colab-panel';

const bar = (needed: number | undefined, have: number | undefined) => {
  if (needed === undefined || !have) return 0;
  return Math.min(100, Math.round((needed / have) * 100));
};

/**
 * Under the compute budget: which of Colab's machines the plan fits on, what
 * it needs against what the machine has (measured, once a runtime is
 * connected), the steps to run in order — each a cell the kernel takes
 * exactly as shown — and the GPU, CPU, memory and disk as they run.
 */
export function ColabRunPanel({ compute, hardware }: { compute: Compute; hardware: Hardware }) {
  const plan = useContext(PlanContext);
  const colab = useColab();
  const { settings } = useStore();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(PANEL_KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const [card, setCard] = useState(false);
  const [showing, setShowing] = useState<string | null>(null);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(PANEL_KEY, open ? 'closed' : 'open');
    } catch {
      // private mode
    }
  };
  const choices = useMemo(() => colabChoices(compute, hardware), [compute, hardware]);
  const steps = useMemo(() => (plan ? colabSteps(plan.sections) : []), [plan]);
  // The machine: the runtime's while there is one, else the picker's when it is Colab's, else what the first-run card would start.
  const connected = colab.status === 'idle' || colab.status === 'busy';
  const accelerator: Accelerator = connected && colab.runtime ? (colab.runtime.accelerator ?? 'NONE') : (colabMachineOf(hardware)?.accelerator ?? colab.machine.accelerator);
  const choice = choices.find((c) => c.machine.accelerator === accelerator) ?? choices[0];
  const measured = connected && colab.specs && colab.runtime?.accelerator === (accelerator === 'NONE' ? null : accelerator) ? colab.specs : undefined;
  const needs = useMemo(() => needsOn(compute, choice, measured), [compute, choice, measured]);
  const available = colabAvailable(settings.googleClientId);
  const pick = (next: Accelerator) => {
    setMachine({ ...colab.machine, accelerator: next });
    setHardware(normaliseHardware({ ...hardware, gpu: colabMachine(next).gpu, count: 1 }));
  };
  const connectIt = () => {
    if (colab.status === 'off' && !colabGranted()) {
      setCard(true);
      return;
    }
    void connectColab({ ...colab.machine, accelerator }).catch(() => undefined);
  };
  const runStep = (step: ColabStep) => {
    if (colab.status === 'off' && !colabGranted()) {
      setCard(true);
      return;
    }
    void runCell(cellKey(step.code), step.code).catch(() => undefined);
  };
  const runs = steps.map((step) => colab.runs[cellKey(step.code)]);
  const done = runs.filter((run) => run?.state === 'ran').length;
  // The chart: the step running now, else the last one that ran with the machine watched.
  const charted = runs.filter((run) => run && run.samples && run.samples.length >= 2).sort((a, b) => (b!.startedAt ?? 0) - (a!.startedAt ?? 0))[0];
  const sample = colab.sample;
  const specs = colab.specs;
  return (
    <figure className={`impl-colab${open ? ' is-open' : ''}`} id="run-on-colab">
      <header>
        <span className="cell-index">
          <ColabMark />
        </span>
        <span className="cell-title">
          Run it on Colab{connected && colab.runtime ? <span className="colab-title-note"> · connected to {choice.machine.label.split(' · ')[0]}</span> : null}
        </span>
        <KeepButton selector=".impl-colab" what="panel" />
        <button type="button" className="btn sm ghost colab-panel-toggle" aria-expanded={open} onClick={toggle}>
          {open ? 'Hide' : 'Show'}
        </button>
      </header>
      {open ? (
        <>
          <p className="colab-lede">
            The plan, run in a Colab runtime of your own, from here: pick the machine, and the steps below run in order — each on its click, exactly as shown — with the GPU and the CPU watched while they do.
            {!available ? <b> Running cells needs a Google client ID and the reader's proxy (Settings → Google, Settings → Paper proxy).</b> : null}
          </p>

          <div className="colab-part-label">The machine</div>
          <div className="colab-machines" role="radiogroup" aria-label="Colab machine">
            {choices.map((c) => (
              <button
                key={c.machine.accelerator}
                type="button"
                role="radio"
                aria-checked={c.machine.accelerator === accelerator}
                className={`colab-machine${c.machine.accelerator === accelerator ? ' is-on' : ''}${c.recommended ? ' is-best' : ''}`}
                disabled={connected}
                title={connected ? 'Change machine from the runtime menu in the bar: a new runtime is started' : `Plan and run on a ${c.machine.label}`}
                onClick={() => pick(c.machine.accelerator)}
              >
                <span className="machine-head">
                  <b>{c.machine.label}</b>
                  {c.recommended ? <span className="machine-best">Smallest that fits</span> : null}
                </span>
                <small>{c.machine.tier}</small>
                <span className="machine-est">
                  <span>{hoursText(c.est.hours)}</span>
                  <span>{usdText(c.est.usd)}</span>
                  {c.est.sessions !== undefined && c.est.sessions > 1 ? <span>{c.est.sessions} sessions</span> : null}
                </span>
                <FitChip fit={c.est.fit} />
              </button>
            ))}
          </div>

          <div className="colab-part-label">What it needs, and what the {choice.machine.label.split(' · ')[0]} has{measured ? ' — measured' : ''}</div>
          <div className="colab-needs">
            {needs.map((need) => (
              <div key={need.id} className={`need-row fit-${need.fit}`}>
                <span className="need-label">{need.label}</span>
                <span className="need-bar" aria-hidden="true">
                  <span className={`need-fill${need.fit === 'no' ? ' is-over' : need.fit === 'tight' ? ' is-tight' : ''}`} style={{ width: `${need.id === 'time' ? Math.min(100, (need.needed ?? 1) * 25) : bar(need.needed, need.have)}%` }} />
                </span>
                <span className="need-numbers">
                  {need.id === 'time' ? (
                    <b>{need.needed}</b>
                  ) : need.needed !== undefined ? (
                    <>
                      <b>{need.needed} {need.unit}</b> needed · {need.have ? `${need.have} ${need.unit}` : 'none'}
                      {need.measured ? <span className="need-measured">measured</span> : null}
                    </>
                  ) : (
                    <>not said · {need.have ? `${need.have} ${need.unit}` : 'none'}</>
                  )}
                </span>
                {need.id === 'time' ? <span className={`fit-chip fit-${need.fit}`}>{(need.needed ?? 1) > 1 ? 'Checkpoint between them' : 'One session'}</span> : <FitChip fit={need.fit} />}
                <span className="need-note">{need.note}</span>
              </div>
            ))}
          </div>

          <div className="colab-part-label">
            <span>
              How to run it, in order{steps.length ? ` · ${done} of ${steps.length} ${done === 1 ? 'has' : 'have'} run` : ''}
            </span>
            {steps.length > 1 && connected ? (
              confirmAll ? (
                <span className="colab-run-all">
                  Run all {steps.length} steps, top to bottom? It stops at the first that fails.
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => {
                      setConfirmAll(false);
                      void runAll(steps.map((step) => ({ key: cellKey(step.code), code: step.code })));
                    }}
                  >
                    Run all
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setConfirmAll(false)}>
                    Not now
                  </button>
                </span>
              ) : (
                <button type="button" className="btn sm ghost" disabled={colab.status === 'busy'} onClick={() => setConfirmAll(true)}>
                  Run all steps
                </button>
              )
            ) : null}
          </div>
          <ol className="colab-steps">
            <li className={`colab-step is-connect${connected ? ' is-done' : ''}`}>
              <span className="step-number">{connected ? '✓' : '1'}</span>
              <div className="step-body">
                <b>{connected ? `Connected to your ${choice.machine.label.split(' · ')[0]} runtime` : `Connect a ${choice.machine.label.split(' · ')[0]} runtime`}</b>
                <span className="step-note">
                  {connected
                    ? specs
                      ? [specs.gpuName ? `${specs.gpuName} · ${specs.vramMb ? gigabytes(specs.vramMb) : ''}` : 'no GPU', specs.cpus ? `${specs.cpus} CPUs` : '', specs.ramTotalMb ? `${gigabytes(specs.ramTotalMb)} RAM` : '', specs.diskFreeGb !== undefined ? `${specs.diskFreeGb} GB disk free` : ''].filter(Boolean).join(' · ')
                      : colab.gpuWatch
                        ? 'Reading what the machine is…'
                        : 'The machine watch is off (runtime menu), so nothing is measured'
                    : colab.status === 'connecting'
                      ? 'Google’s window, then the runtime, then the kernel — about fifteen seconds the first time'
                      : 'Starts a runtime in your own Colab account, on your tier; the first time, a card says what will happen before anything does'}
                </span>
              </div>
              <div className="step-actions">
                {connected ? (
                  <button type="button" className="btn sm ghost" disabled={colab.status === 'busy' || !colab.gpuWatch} onClick={() => void probeMachine()} title="Read the machine again: its use now, and the disk free">
                    Measure again
                  </button>
                ) : (
                  <button type="button" className={`btn sm colab${available ? ' is-go' : ''}`} disabled={!available || colab.status === 'connecting'} onClick={connectIt}>
                    <ColabMark />
                    {colab.status === 'connecting' ? 'Connecting…' : colab.status === 'lost' ? '▶ Start a new runtime' : '▶ Connect'}
                  </button>
                )}
                {card ? (
                  <ConnectCard
                    busy={colab.status === 'connecting'}
                    onClose={() => setCard(false)}
                    onConnect={(machine) => {
                      void connectColab(machine)
                        .then(() => setCard(false))
                        .catch(() => undefined);
                    }}
                  />
                ) : null}
              </div>
            </li>
            {steps.map((step, index) => {
              const key = cellKey(step.code);
              const run = colab.runs[key];
              const live = run?.state === 'running' || run?.state === 'queued';
              return (
                <li key={key} className={`colab-step is-${step.kind}${run ? ` has-run is-${run.state}` : ''}`}>
                  <span className="step-number">{run?.state === 'ran' ? '✓' : live ? <span className="spinner" /> : index + 2}</span>
                  <div className="step-body">
                    <b>{step.title}</b>
                    <span className="step-note">
                      {step.note}
                      {' · '}
                      <button type="button" className="link" onClick={() => setShowing(showing === key ? null : key)}>
                        {showing === key ? 'Hide the cell' : 'Show the cell'}
                      </button>
                    </span>
                    {run ? <RunState run={run} /> : null}
                  </div>
                  <div className="step-actions">
                    <button type="button" className={`btn sm colab${connected && !run ? ' is-go' : ''}`} disabled={!available || colab.status === 'connecting' || Boolean(colab.running)} onClick={() => runStep(step)} title={connected ? 'Run exactly this cell in your runtime' : 'Connects first, then runs this cell'}>
                      <ColabMark />
                      {run ? '▶ Run again' : '▶ Run'}
                    </button>
                  </div>
                  {showing === key ? (
                    <pre className="cell-code step-code">
                      <code dangerouslySetInnerHTML={{ __html: step.kind === 'python' || step.kind === 'scaffold' ? highlightPython(step.code) : esc(step.code) }} />
                    </pre>
                  ) : null}
                  {run ? (
                    <div className="step-output">
                      <CellRunOutput run={run} onForget={() => undefined} />
                    </div>
                  ) : null}
                </li>
              );
            })}
            {!steps.length ? <li className="colab-step is-empty">No cells on the plan yet — the steps come from its shell cells, its Makefile and its Python cells.</li> : null}
          </ol>

          <div className="colab-part-label">The machine, as it runs</div>
          <div className={`colab-live${connected ? ' is-on' : ''}`}>
            <div className="live-tiles">
              <div className="live-tile">
                <span className="k">GPU</span>
                <b>{sample?.gpu ? `${sample.gpu.util}%` : specs?.gpuName ? '—' : accelerator === 'NONE' ? 'none' : '—'}</b>
                <small>{specs?.gpuName ?? (accelerator === 'NONE' ? 'CPU runtime' : choice.machine.label.split(' · ')[0])}</small>
              </div>
              <div className="live-tile">
                <span className="k">VRAM</span>
                <b>{sample?.gpu ? gigabytes(sample.gpu.memUsedMb) : '—'}</b>
                <small>of {specs?.vramMb ? gigabytes(specs.vramMb) : accelerator === 'NONE' ? 'none' : `${gpuById(choice.machine.gpu).vramGb} GB`}</small>
              </div>
              <div className="live-tile">
                <span className="k">CPU</span>
                <b>{sample?.cpu !== undefined ? `${sample.cpu}%` : '—'}</b>
                <small>{specs?.cpus ? `${specs.cpus} cores` : 'not measured yet'}</small>
              </div>
              <div className="live-tile">
                <span className="k">RAM</span>
                <b>{sample?.ramUsedMb !== undefined ? gigabytes(sample.ramUsedMb) : '—'}</b>
                <small>of {specs?.ramTotalMb ? gigabytes(specs.ramTotalMb) : `about ${choice.machine.ramGb} GB`}</small>
              </div>
              <div className="live-tile">
                <span className="k">Disk free</span>
                <b>{sample?.diskFreeGb !== undefined ? `${sample.diskFreeGb} GB` : specs?.diskFreeGb !== undefined ? `${specs.diskFreeGb} GB` : '—'}</b>
                <small>of {specs?.diskTotalGb !== undefined ? `${specs.diskTotalGb} GB` : `about ${choice.machine.diskGb} GB`}</small>
              </div>
            </div>
            {charted?.samples ? (
              <MachineChart samples={charted.samples} live={charted.state === 'running'} />
            ) : (
              <div className="live-empty">
                {connected
                  ? colab.gpuWatch
                    ? 'Run a step and its use is drawn here, every two seconds, as the loss curve is under a training cell.'
                    : 'Turn on “Watch the machine while cells run” in the runtime menu and its use is drawn here as steps run.'
                  : 'Connect a runtime and the tiles fill with what it is; run a step and its use is drawn here as it runs.'}
              </div>
            )}
            <div className="live-note">
              Read by a few lines of the reader's own — <code>nvidia-smi</code>, <code>/proc/stat</code>, <code>/proc/meminfo</code>, the disk — in a second kernel, every two seconds while a step runs and once as the runtime connects. Shown in the runtime menu; nothing runs unseen.
            </div>
          </div>
        </>
      ) : null}
    </figure>
  );
}
