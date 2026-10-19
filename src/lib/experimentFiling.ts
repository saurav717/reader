// ===========================================================================
//  Filing an experiment: a simulation run that is over, copied from the
//  machine to where it is kept — Google Drive by default, under the Koios
//  folder's Experiments/<project>/<run>, or a computer of yours — and recorded
//  in the project's logbook (src/lib/experiments.ts is the record,
//  src/lib/logbookStore.ts keeps it). Then the notes: written by the model
//  the app is set to, from the record and the project's LEARNING.md; or by
//  Claude Code or Codex on the machine, asked from the Experiments tab.
//
//  Runs are filed as they end by the workspace (src/components/
//  ExperimentFiler.tsx), which watches the runs' folders while the machine is
//  connected; what was filed is remembered here, in this browser, so a run is
//  filed once and the Sim pane can say so.
// ===========================================================================

import { useSyncExternalStore } from 'react';
import { getState as assistantState, modelSpec, streamModel } from './assistant';
import { db } from './db';
import { driveFolderLink, driveHost } from './driveFiles';
import type { Experiment, ExperimentWhere } from './experiments';
import { NOTES_SYSTEM, digestOf, experimentMarkdown, filesToFile, notesPrompt, FILE_CAP } from './experiments';
import { saveExperiment } from './logbookStore';
import type { JupyterServer } from './colab';
import type { FileHost, Playground } from './playground';
import { base64Of, driveConfigNow, homeHost, serverById, serverHost, slugOf } from './playground';
import type { Project } from './projects';
import type { SimRun } from './simTelemetry';
import { applyEvents, newRun, readMedia, readSimRuns } from './simTelemetry';

// ------------------------------------------------------------- choices ----

export interface ExperimentPrefs {
  /** File each run as it ends, without asking. */
  autoFile: boolean;
  /** Who writes the notes: the model the app is set to, a coding agent on the machine (asked from the tab), or no one. */
  notes: 'model' | 'cli' | 'off';
  /** Where the files go: Drive, or a server's id. */
  where: 'drive' | { serverId: string };
}

const PREFS_KEY = 'reader.experiments';
const DEFAULT_PREFS: ExperimentPrefs = { autoFile: true, notes: 'model', where: 'drive' };
let prefs: ExperimentPrefs = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<ExperimentPrefs> | null;
    return raw ? { ...DEFAULT_PREFS, ...raw } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export const experimentPrefs = () => prefs;
export function setExperimentPrefs(next: Partial<ExperimentPrefs>) {
  prefs = { ...prefs, ...next };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // kept for the session
  }
  emit();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useExperimentPrefs = () => useSyncExternalStore(subscribe, experimentPrefs);

// --------------------------------------------------------- what is filed ----

export interface Filed {
  at: number;
  where: ExperimentWhere;
  /** Filed into this project's logbook, when the playground belongs to one. */
  projectId?: string;
}

const INDEX_KEY = (playgroundId: string) => `experiments:filed:${playgroundId}`;
const indexes = new Map<string, Record<string, Filed>>();

export async function filedIndex(playgroundId: string): Promise<Record<string, Filed>> {
  let index = indexes.get(playgroundId);
  if (!index) {
    index = (await db.getKv<Record<string, Filed>>(INDEX_KEY(playgroundId)).catch(() => undefined)) ?? {};
    indexes.set(playgroundId, index);
  }
  return index;
}

async function markFiled(playgroundId: string, runId: string, filed: Filed) {
  const index = { ...(await filedIndex(playgroundId)), [runId]: filed };
  indexes.set(playgroundId, index);
  await db.setKv(INDEX_KEY(playgroundId), index).catch(() => undefined);
  emit();
}

/** What was filed of a playground's runs, for the Sim pane; read once, then as it changes. */
export function useFiled(playgroundId: string): Record<string, Filed> {
  const now = useSyncExternalStore(subscribe, () => indexes.get(playgroundId) ?? EMPTY);
  if (!indexes.has(playgroundId)) void filedIndex(playgroundId).then(emit);
  return now;
}
const EMPTY: Record<string, Filed> = {};

// ------------------------------------------------------------ the place ----

/** The folder a project's (or a lone playground's) experiments go to, under Experiments/ in Drive or experiments/ on a server. */
export const experimentsFolder = (playground: Pick<Playground, 'id' | 'title'>, project?: Pick<Project, 'id' | 'name'>) => `${slugOf(project?.name ?? playground.title)}-${project?.id ?? playground.id}`;

interface Place {
  host: FileHost & { writeBase64?(path: string, base64: string): Promise<void> };
  where: ExperimentWhere;
}

async function placeFor(where: ExperimentPrefs['where'], folder: string, runId: string): Promise<Place> {
  if (where === 'drive') {
    const config = driveConfigNow();
    if (!config) throw new Error('Google Drive isn’t connected: sign in with Drive, or choose a computer for the experiments.');
    const path = `${folder}/${runId}`;
    const host = driveHost(() => driveConfigNow(), path, 'Experiments');
    const link = await driveFolderLink(config, path, 'Experiments').catch(() => undefined);
    return { host, where: { kind: 'drive', label: 'Google Drive', path: `Experiments/${path}`, link } };
  }
  const server = serverById(where.serverId);
  if (!server) throw new Error('That computer isn’t in this browser’s list any more.');
  const path = `experiments/${folder}/${runId}`;
  return { host: serverHost(server, path), where: { kind: 'server', label: server.name, path, serverId: server.id } };
}

// ---------------------------------------------------------------- filing ----

/** The whole of a run's events.jsonl from the machine, in pieces, and the run parsed from it. */
export async function readWholeRun(folder: string, dir: string, scope?: string): Promise<{ run: SimRun; text: string; now: number }> {
  let offset = 0;
  const parts: string[] = [];
  let now = Date.now() / 1000;
  const run = newRun(dir);
  for (let i = 0; i < 400; i++) {
    const got = await readSimRuns(folder, { dir, offset }, scope);
    now = got.now;
    const listing = got.runs.find((r) => r.dir === dir);
    if (listing) run.meta = { ...run.meta, ...listing.meta };
    const f = got.focus;
    if (!f || f.dir !== dir) break;
    parts.push(f.text);
    applyEvents(run, f.text);
    offset = f.to;
    if (f.to >= f.size || !f.text.length) break;
  }
  run.offset = offset;
  return { run, text: parts.join(''), now };
}

const blobBase64 = async (blob: Blob) => base64Of(new Uint8Array(await blob.arrayBuffer()));

export interface FilingReport {
  experiment: Experiment;
  /** Files copied, and the ones left on the machine. */
  copied: string[];
  leftOut: string[];
  problems: string[];
}

/**
 * A run filed: its record, its events and its media copied to the place,
 * report.md and report.json written beside them, the record kept in the
 * project's logbook when the playground belongs to one, and remembered here.
 */
export async function fileRun(params: { playground: Playground; folder: string; dir: string; project?: Project; by: string; where?: ExperimentPrefs['where']; scope?: string; onStep?: (step: string) => void }): Promise<FilingReport> {
  const { playground, folder, dir, project, by, scope } = params;
  const say = params.onStep ?? (() => undefined);
  say('Reading the run');
  const { run, text, now } = await readWholeRun(folder, dir, scope);
  const digest = digestOf(run, { playgroundId: playground.id, playground: playground.title, by }, now);
  const place = await placeFor(params.where ?? prefs.where, experimentsFolder(playground, project), digest.id);
  const problems: string[] = [];
  const copied: string[] = [];
  // scene.rrd's size isn't in the events: fetched within the cap, or left out.
  let sceneBytes: number | null = null;
  let sceneBlob: Blob | null = null;
  if (run.live3d) {
    try {
      say('Fetching scene.rrd');
      sceneBlob = await readMedia(folder, dir, run.live3d.rrd, scope, undefined, FILE_CAP);
      sceneBytes = sceneBlob.size;
    } catch (error) {
      problems.push(`scene.rrd: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const plan = filesToFile(run, sceneBytes);
  const files: Experiment['files'] = [];
  for (const file of plan.take) {
    try {
      say(`Copying ${file.path}`);
      const blob = file.kind === 'scene' && sceneBlob ? sceneBlob : await readMedia(folder, dir, file.path, scope, undefined, FILE_CAP);
      if (!place.host.writeBase64) throw new Error('this place takes text only');
      await place.host.writeBase64(file.path, await blobBase64(blob));
      files.push({ ...file, bytes: blob.size });
      copied.push(file.path);
    } catch (error) {
      plan.leftOut.push(file.path);
      problems.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  say('Writing the record');
  await place.host.write('events.jsonl', text);
  files.push({ path: 'events.jsonl', bytes: text.length, kind: 'events' });
  const experiment: Experiment = { ...digest, where: place.where, files, leftOut: plan.leftOut };
  await place.host.write('report.json', `${JSON.stringify(experiment, null, 2)}\n`);
  await place.host.write('report.md', experimentMarkdown(experiment));
  experiment.files.push({ path: 'report.md', kind: 'report' });
  if (project) await saveExperiment(project, experiment);
  await markFiled(playground.id, digest.id, { at: Date.now(), where: place.where, projectId: project?.id });
  return { experiment, copied, leftOut: plan.leftOut, problems };
}

// ----------------------------------------------------------------- notes ----

/** The model the app is set to for Ask AI: the one that writes the notes. */
export const notesModel = () => {
  const state = assistantState();
  return state.prefs.askModel || state.prefs.model;
};

/**
 * The notes of an experiment, written by the model from its record and the
 * project's LEARNING.md, kept in the record and as summary.md beside the
 * files. Hands back the record with the notes in it.
 */
export async function writeNotes(experiment: Experiment, params: { playground?: Playground; project?: Project; model?: string; onText?: (text: string) => void }): Promise<Experiment> {
  const model = params.model ?? notesModel();
  let learning: string | undefined;
  if (params.playground) learning = (await homeHost(params.playground).read('LEARNING.md').catch(() => null)) ?? undefined;
  const stream = await streamModel({ model, maxTokens: 1400, system: [{ type: 'text', text: NOTES_SYSTEM }], messages: [{ role: 'user', content: notesPrompt(experiment, learning) }], effort: 'low' });
  let text = '';
  stream.on('text', (delta) => {
    text += delta;
    params.onText?.(text);
  });
  await stream.finalMessage();
  const noted: Experiment = { ...experiment, summary: { text: text.trim(), by: modelSpec(model).label || model, at: new Date().toISOString() } };
  try {
    const place = await placeFor(experiment.where.kind === 'server' && experiment.where.serverId ? { serverId: experiment.where.serverId } : 'drive', experiment.where.path.replace(/^(Experiments|experiments)\//, '').replace(/\/[^/]+$/, ''), experiment.id);
    await place.host.write('summary.md', `${noted.summary!.text}\n`);
    await place.host.write('report.md', experimentMarkdown(noted));
  } catch {
    // the record keeps the notes even when the folder can't be reached now
  }
  if (params.project) await saveExperiment(params.project, noted);
  return noted;
}

/** The folder of an experiment's run on the machine it ran on, for a coding agent there: runs/<id>. */
export const runFolderOf = (experiment: Experiment) => `runs/${experiment.id}`;

// ------------------------------------------------------------------ moving ----

/**
 * An experiment's files copied to another place — a computer of yours, or
 * back to Drive — and the record pointed at it. The old copy is left where it
 * was.
 */
export async function moveExperiment(experiment: Experiment, to: ExperimentPrefs['where'], project?: Project, onStep?: (step: string) => void): Promise<Experiment> {
  const from = await placeFor(experiment.where.kind === 'server' && experiment.where.serverId ? { serverId: experiment.where.serverId } : 'drive', experiment.where.path.replace(/^(Experiments|experiments)\//, '').replace(/\/[^/]+$/, ''), experiment.id);
  const dest = await placeFor(to, experiment.where.path.replace(/^(Experiments|experiments)\//, '').replace(/\/[^/]+$/, ''), experiment.id);
  const fromHost = from.host as FileHost & { readBase64?(path: string): Promise<string | null>; writeBase64?(path: string, base64: string): Promise<void> };
  for (const file of experiment.files) {
    onStep?.(`Copying ${file.path}`);
    if (file.kind === 'events' || file.kind === 'report') {
      const text = await fromHost.read(file.path);
      if (text !== null) await dest.host.write(file.path, text);
      continue;
    }
    if (!fromHost.readBase64 || !dest.host.writeBase64) continue;
    const data = await fromHost.readBase64(file.path);
    if (data) await dest.host.writeBase64(file.path, data);
  }
  if (experiment.summary) await dest.host.write('summary.md', `${experiment.summary.text}\n`);
  const moved: Experiment = { ...experiment, where: dest.where };
  await dest.host.write('report.json', `${JSON.stringify(moved, null, 2)}\n`);
  if (project) await saveExperiment(project, moved);
  await markFiled(experiment.playgroundId, experiment.id, { at: Date.now(), where: dest.where, projectId: project?.id });
  return moved;
}

/** The computers experiments can go to right now: the servers this browser knows. */
export const placesNow = (servers: JupyterServer[]) => servers.map((server) => ({ serverId: server.id, label: server.name }));
