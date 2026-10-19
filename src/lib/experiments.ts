// ===========================================================================
//  An experiment: a simulation run, once it is over, digested into a record
//  the project's logbook keeps (src/lib/logbook.ts, Logbook.experiments) and
//  a folder the files go to — Google Drive by default, or a computer of yours
//  (src/lib/experimentFiling.ts does the filing; this is the arithmetic and
//  the words, with no network and no DOM, for scripts/experiments.test.mjs).
//
//  What is kept of a run: where it ran and what on, how it ended, its
//  returns first and last and best, its success rate, the last value of each
//  number, the findings (the same the Sim pane shows), the notes the code and
//  the agents left, the config, which files were filed and where, and the
//  notes a model wrote about it (summary). The run's own files — events.jsonl,
//  the videos, scene.rrd — stay whole in the folder; the record is what a
//  logbook can hold and a list can show.
// ===========================================================================

import type { Finding, SimRun } from './simTelemetry';
import { evaluationRows, latestEvaluations } from './simTelemetry';
import type { Evaluation } from './simTelemetry';
import { diagnose, mean, std } from './simTelemetry';

export type ExperimentStatus = 'finished' | 'crashed' | 'stopped';

export interface ExperimentWhere {
  kind: 'drive' | 'server';
  /** "Google Drive", or the computer's name. */
  label: string;
  /** The folder, from Drive's Koios folder (Experiments/<project>/<run>) or the server's root. */
  path: string;
  /** A link that opens the folder, when there is one (Drive). */
  link?: string;
  /** The server, when it is one. */
  serverId?: string;
}

export interface ExperimentNotes {
  /** Markdown. */
  text: string;
  /** Who wrote them: a model's name, "Claude Code", "Codex", or a person. */
  by: string;
  at: string;
}

/** An evaluation as the record keeps it (the run's, less its time). */
export type ExperimentEvaluation = Omit<Evaluation, 't'>;

export interface Experiment {
  /** The run's id (its folder's name). */
  id: string;
  playgroundId: string;
  /** The playground's title. */
  playground: string;
  /** The run's name. */
  title: string;
  /** "mujoco/Ant-v5". */
  sim?: string;
  status: ExperimentStatus;
  /** ISO. */
  started: string;
  ended: string;
  /** Environment steps, episodes. */
  steps: number;
  episodes: number;
  returns?: { first: number; last: number; best: number };
  /** Success over the last fifty episodes, 0–100, where the task reports it. */
  success?: number;
  /** The last value of each number logged, the first twelve. */
  last: Record<string, number>;
  /** The latest evaluation of each name: the paper's measure, ours against the paper's numbers. */
  evaluations?: ExperimentEvaluation[];
  findings: Finding[];
  notes: { step: number; by: string; text: string }[];
  config: Record<string, unknown>;
  /** The machine it ran on, in a few words. */
  machine?: string;
  where: ExperimentWhere;
  /** The files filed beside the record, from the run's folder: videos, dreams, scene.rrd. */
  files: { path: string; bytes?: number; kind: 'video' | 'image' | 'scene' | 'events' | 'report' }[];
  /** Files the cap left out, by path. */
  leftOut: string[];
  summary?: ExperimentNotes;
  /** Who filed it, and when. */
  by: string;
  at: string;
}

/** One file of a run's media is filed up to this, and a run's files together up to the second. */
export const FILE_CAP = 8 * 1024 * 1024;
export const RUN_CAP = 40 * 1024 * 1024;
/** How many notes, findings and numbers a record carries. */
export const NOTE_CAP = 30;
export const LAST_CAP = 12;
/** The config kept, as JSON. */
export const CONFIG_CAP = 6000;

export const runStatus = (status: SimRun['status']): ExperimentStatus => (status === 'crashed' ? 'crashed' : status === 'stopped' ? 'stopped' : 'finished');

const iso = (seconds: number | undefined, fallback: number) => new Date((seconds ?? fallback) * 1000).toISOString();

/** Returns first, last and best, over a tenth of the episodes at each end. */
export function returnsOf(run: SimRun): Experiment['returns'] | undefined {
  const returns = run.episodes.map((e) => e.ret).filter(Number.isFinite);
  if (!returns.length) return undefined;
  const k = Math.max(1, Math.floor(returns.length / 10));
  return { first: mean(returns.slice(0, k)), last: mean(returns.slice(-k)), best: Math.max(...returns) };
}

export function successOf(run: SimRun): number | undefined {
  const known = run.episodes.slice(-50).filter((e) => e.success !== undefined);
  return known.length ? Math.round((100 * known.filter((e) => e.success).length) / known.length) : undefined;
}

/** The last value of each number, the first LAST_CAP of them. */
export function lastValues(run: SimRun): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, points] of run.scalars) {
    if (Object.keys(out).length >= LAST_CAP) break;
    const last = [...points].reverse().find((p) => Number.isFinite(p.y));
    if (last) out[name] = last.y;
  }
  return out;
}

const trimmedConfig = (config: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!config) return {};
  const text = JSON.stringify(config);
  if (text.length <= CONFIG_CAP) return config;
  const out: Record<string, unknown> = {};
  let size = 2;
  for (const [key, value] of Object.entries(config)) {
    const part = JSON.stringify({ [key]: value }).length;
    if (size + part > CONFIG_CAP) {
      out['…'] = `${Object.keys(config).length - Object.keys(out).length} more`;
      break;
    }
    out[key] = value;
    size += part;
  }
  return out;
};

/**
 * A run, digested: everything the record holds but where it was filed and
 * the notes, which come after. `now` is the machine's clock, in seconds, for
 * the findings.
 */
export function digestOf(run: SimRun, about: { playgroundId: string; playground: string; by: string; machine?: string }, now: number): Omit<Experiment, 'where' | 'files' | 'leftOut' | 'summary'> {
  const config = (run.meta.config ?? {}) as Record<string, unknown>;
  return {
    id: run.meta.id ?? run.dir.split('/').pop() ?? run.dir,
    playgroundId: about.playgroundId,
    playground: about.playground,
    title: run.meta.name ?? run.dir.split('/').pop() ?? 'run',
    sim: run.meta.sim ?? undefined,
    status: runStatus(run.status),
    started: iso(run.meta.started ?? run.firstT, now),
    ended: iso(run.meta.ended ?? run.lastT, now),
    steps: run.step,
    episodes: run.episodes.length,
    returns: returnsOf(run),
    success: successOf(run),
    last: lastValues(run),
    ...(run.evaluations.length ? { evaluations: evaluationsOf(run) } : {}),
    findings: diagnose(run, now).filter((f) => f.id !== 'stalled'),
    notes: run.notes.filter((note) => note.tag !== 'spaces').slice(-NOTE_CAP).map((note) => ({ step: note.step, by: note.by, text: note.text.slice(0, 500) })),
    config: trimmedConfig(config),
    machine: about.machine ?? run.meta.host?.gpu ?? run.meta.host?.machine ?? undefined,
    by: about.by,
    at: new Date(now * 1000).toISOString(),
  };
}

/** The latest evaluation of each name, up to eight, each with up to twelve metrics. */
export function evaluationsOf(run: SimRun): ExperimentEvaluation[] {
  return latestEvaluations(run.evaluations)
    .slice(-8)
    .map(({ t, ...ev }) => {
      void t;
      const metrics = Object.fromEntries(Object.entries(ev.metrics).slice(0, 12));
      return { ...ev, metrics, ...(ev.paper ? { paper: Object.fromEntries(Object.entries(ev.paper).filter(([k]) => k in metrics)) } : {}) };
    });
}

/** An evaluation as lines of Markdown: a table of ours against the paper's, with the protocol under it. */
export function evaluationMarkdown(ev: ExperimentEvaluation): string[] {
  const rows = evaluationRows(ev);
  const withPaper = rows.some((row) => row.paper !== undefined);
  const lines = [`### ${ev.name} · step ${ev.step}${ev.episodes ? ` · ${ev.episodes} episodes` : ''}`, ''];
  lines.push(withPaper ? '| metric | ours | paper | vs paper |' : '| metric | ours |', withPaper ? '| --- | --- | --- | --- |' : '| --- | --- |');
  for (const row of rows) {
    const vs = row.delta ? `${row.delta.abs >= 0 ? '+' : ''}${g(row.delta.abs)}${row.delta.pct !== null ? ` (${row.delta.pct >= 0 ? '+' : ''}${Math.round(row.delta.pct)}%)` : ''}${row.delta.better === null ? '' : row.delta.better ? ' better' : ' worse'}` : row.paper !== undefined ? '—' : '';
    lines.push(withPaper ? `| ${row.metric} | ${g(row.ours)} | ${row.paper !== undefined ? g(row.paper) : '—'} | ${vs} |` : `| ${row.metric} | ${g(row.ours)} |`);
  }
  if (ev.protocol) lines.push('', `*Protocol:* ${ev.protocol}${ev.source ? ` · *paper:* ${ev.source}` : ''}`);
  else if (ev.source) lines.push('', `*Paper:* ${ev.source}`);
  return lines;
}

/** Which of a run's files to file, within the caps, and which are left out. */
export function filesToFile(run: SimRun, sceneBytes: number | null): { take: { path: string; bytes?: number; kind: Experiment['files'][number]['kind'] }[]; leftOut: string[] } {
  const candidates: { path: string; bytes?: number; kind: Experiment['files'][number]['kind'] }[] = [];
  for (const m of run.media) candidates.push({ path: m.path, bytes: m.bytes, kind: m.type === 'image' ? 'image' : 'video' });
  for (const d of run.dreams) if (d.path) candidates.push({ path: d.path, kind: 'video' });
  if (sceneBytes !== null) candidates.push({ path: run.live3d?.rrd ?? 'scene.rrd', bytes: sceneBytes, kind: 'scene' });
  const take: typeof candidates = [];
  const leftOut: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  // Newest first: the last videos are the ones that show what was learnt.
  for (const file of [...candidates].reverse()) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const size = file.bytes ?? 0;
    if (size > FILE_CAP || total + size > RUN_CAP) {
      leftOut.push(file.path);
      continue;
    }
    total += size;
    take.push(file);
  }
  return { take: take.reverse(), leftOut };
}

const g = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(4)).toString() : '—');

/** The record as a page of Markdown: report.md beside the files, and what a model is given to write about. */
export function experimentMarkdown(exp: Omit<Experiment, 'where' | 'files' | 'leftOut' | 'summary'> & Partial<Pick<Experiment, 'where' | 'files' | 'leftOut' | 'summary'>>): string {
  const lines: string[] = [`# ${exp.title}`, ''];
  lines.push(`- **Simulator:** ${exp.sim ?? 'not said'}`);
  lines.push(`- **Playground:** ${exp.playground}`);
  lines.push(`- **Ended:** ${exp.status}, ${exp.ended}${exp.machine ? ` on ${exp.machine}` : ''}`);
  lines.push(`- **Steps:** ${exp.steps} · **Episodes:** ${exp.episodes}`);
  if (exp.returns) lines.push(`- **Return:** first ${g(exp.returns.first)} → last ${g(exp.returns.last)} · best ${g(exp.returns.best)}`);
  if (exp.success !== undefined) lines.push(`- **Success:** ${exp.success}% over the last episodes`);
  if (exp.where) lines.push(`- **Files:** ${exp.where.label}, ${exp.where.path}${exp.where.link ? ` (${exp.where.link})` : ''}`);
  if (exp.evaluations?.length) {
    lines.push('', '## Evaluation', '');
    for (const ev of exp.evaluations) lines.push(...evaluationMarkdown(ev), '');
  }
  if (Object.keys(exp.last).length) {
    lines.push('', '## Last values', '');
    for (const [name, value] of Object.entries(exp.last)) lines.push(`- ${name}: ${g(value)}`);
  }
  if (exp.findings.length) {
    lines.push('', '## What the run looks like', '');
    for (const f of exp.findings) lines.push(`- **${f.title}** (${f.level}): ${f.detail} *Try:* ${f.try}`);
  }
  if (exp.notes.length) {
    lines.push('', '## Notes on the timeline', '');
    for (const note of exp.notes) lines.push(`- step ${note.step} [${note.by}]: ${note.text}`);
  }
  if (Object.keys(exp.config).length) lines.push('', '## Config', '', '```json', JSON.stringify(exp.config, null, 2), '```');
  if (exp.files?.length) {
    lines.push('', '## Files', '');
    for (const file of exp.files) lines.push(`- ${file.path}${file.bytes ? ` (${Math.max(1, Math.round(file.bytes / 1024))} KB)` : ''}`);
    if (exp.leftOut?.length) lines.push(`- left on the machine (over the cap): ${exp.leftOut.join(', ')}`);
  }
  if (exp.summary) lines.push('', `## Notes · ${exp.summary.by}, ${exp.summary.at}`, '', exp.summary.text);
  return `${lines.join('\n')}\n`;
}

export const NOTES_SYSTEM = `You write the notes of an experiment for someone learning reinforcement learning and world models: a research
logbook entry, not a report. Plain words, short sentences, no hype. Say what was tried and on what, what happened
(use the numbers), what the evaluation says against the paper's numbers when there are any, what the findings mean
and whether to trust the run, what you would try next and why. Explain
one idea the run touches in two sentences, as to a student. Markdown, under 350 words, with the headings
**What was tried**, **What happened**, **What it means**, **Next**. If the run crashed, say what the error points
at. Never invent numbers that are not in what you are given.`;

/** What a model is given to write the notes: the record, and the project's LEARNING.md when there is one. */
export function notesPrompt(exp: Experiment, learning?: string): string {
  const parts = [experimentMarkdown(exp)];
  if (learning?.trim()) parts.push(`## The project's LEARNING.md (the agents' own notes, newest first)\n\n${learning.trim().slice(0, 12_000)}`);
  return parts.join('\n\n');
}

/** What a coding agent on the machine is asked, when it writes the notes instead: it can read the run's files itself. */
export function cliNotesRequest(exp: Experiment, runDir: string): string {
  return `Write the notes of the experiment in ${runDir} into ${runDir}/summary.md, for someone learning RL and world models: what was tried (the config, the simulator ${exp.sim ?? ''}), what happened (read ${runDir}/events.jsonl and run \`python koios_telemetry.py summary\`), what the findings mean, what to try next, and one idea the run touches explained in two sentences. Markdown, under 350 words, headings **What was tried**, **What happened**, **What it means**, **Next**. Then add one line about it at the top of LEARNING.md. Do not change any other file.`;
}

export const experimentsInOrder = (list: Experiment[]): Experiment[] => [...list].sort((a, b) => b.ended.localeCompare(a.ended) || b.at.localeCompare(a.at));

export function withExperiment(list: Experiment[], exp: Experiment): Experiment[] {
  return experimentsInOrder([...list.filter((item) => item.id !== exp.id || item.playgroundId !== exp.playgroundId), exp]);
}

/** A line for a list: "Ant-v5 · PPO · −12 → 843 · finished 2 h ago". */
export function experimentLine(exp: Experiment): string {
  const parts = [exp.sim?.split('/').pop() ?? exp.title];
  if (exp.returns) parts.push(`${g(exp.returns.first)} → ${g(exp.returns.last)}`);
  if (exp.success !== undefined) parts.push(`${exp.success}% success`);
  const ev = exp.evaluations?.[exp.evaluations.length - 1];
  const first = ev && evaluationRows(ev)[0];
  if (first) parts.push(`eval ${first.metric} ${g(first.ours)}${first.paper !== undefined ? ` (paper ${g(first.paper)})` : ''}`);
  parts.push(exp.status);
  return parts.join(' · ');
}

/** How the run went, in one word for a pill, from the findings and the status. */
export function toneOf(exp: Experiment): 'good' | 'bad' | 'flat' {
  if (exp.status === 'crashed') return 'bad';
  if (exp.findings.some((f) => f.id === 'improving')) return 'good';
  if (exp.findings.some((f) => f.level === 'error' || f.id === 'collapse' || f.id === 'no-learning')) return 'bad';
  return 'flat';
}

/** The spread of returns, for "noisy" in the notes: the std over the mean of the last tenth. */
export const noise = (returns: number[]) => (returns.length > 4 ? std(returns) / (Math.abs(mean(returns)) || 1) : 0);
