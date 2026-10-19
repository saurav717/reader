// ===========================================================================
//  A project's files moved to another place by the machines at each end,
//  behind the scenes (docs/storage-moves.md). The page asks the Worker for a
//  move (worker/moves.js), tells the machine that goes first to start, and
//  from then on only watches: the archive goes from machine to machine
//  through R2, or between a machine and Drive directly, at the machines' own
//  speed, and a page closed meanwhile doesn't stop it. When the destination
//  says every file is in and checked, the project's home becomes the new
//  place. The old copy stays until the person removes it.
//
//  A machine is told to start one of two ways: a computer with the Reader
//  Companion (0.15.0 and later) by its `companion/move`; Colab or another
//  Jupyter server, which has no Companion, by a few lines in the project's
//  own small kernel that write the mover there and start it on its own.
// ===========================================================================

import { apiFetch } from './api';
import { runQuietly, type JupyterServer } from './colab';
import { driveFolderName } from './driveFiles';
import { trashFile } from './google';
import MOVER from './moverScript';
import { homeFor, launchCode, planOf, sameHome, stepsOf, type Destination, type MoveEnd, type MovePlan } from './movePlan';
import { driveFolderIdOf, driveTokenNow, machineRoot, serverById, updatePlayground, type FilesHome, type Playground } from './playground';

export interface MoveState {
  id: string;
  status: 'started' | 'packing' | 'packed' | 'unpacking' | 'pulling' | 'pushing' | 'done' | 'failed' | 'cancelled';
  step: string;
  plan: MovePlan;
  from: MoveEnd;
  to: MoveEnd;
  progress: { files: number; bytes: number; totalFiles: number; totalBytes: number };
  error?: string;
  waiting?: string;
  verified?: number;
  archiveBytes?: number;
  created: number;
  updated: number;
  done?: number;
  removeOld?: boolean;
  /** The old copy, when the move was to delete it: removed by the Worker, still to go (the page does it), or refused. */
  oldCopy?: 'removed' | 'pending' | 'failed';
  oldCopyError?: string;
  /** What met an older copy at the new place (mover.py, Arrival). */
  met?: { conflicts: number; conflictPaths: string[]; kept: number; keptPaths: string[]; stale: number };
}

/** How a machine is told to do a step: its Companion, or the project's own kernel on it. */
export type Runner = { how: 'companion'; server: JupyterServer } | { how: 'kernel'; scope: string };

const keyStore = (id: string) => `reader.moveKey.${id}`;
const keepKey = (id: string, key: string | null) => {
  try {
    if (key) localStorage.setItem(keyStore(id), key);
    else localStorage.removeItem(keyStore(id));
  } catch {
    // Storage closed to us: the Worker and the machines carry on; this browser can't start the second step.
  }
};
export const keyOf = (id: string) => {
  try {
    return localStorage.getItem(keyStore(id));
  } catch {
    return null;
  }
};
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// ----------------------------------------------------------- the Companion --

const companionBase = (server: JupyterServer) => server.url.replace(/\/?$/, '/');
const probes = new Map<string, { at: number; info: CompanionDisk | null }>();
export interface CompanionDisk {
  free: number;
  total: number;
  version?: string;
}

/** A Companion's free disk where the project's folder is, and whether it moves files at all (0.15.0): null when it can't say. */
export async function companionDisk(server: JupyterServer, root = '', fresh = false): Promise<CompanionDisk | null> {
  const key = `${server.id}:${root}`;
  const held = probes.get(key);
  if (!fresh && held && Date.now() - held.at < 30_000) return held.info;
  let info: CompanionDisk | null = null;
  try {
    const response = await fetch(`${companionBase(server)}companion/move?root=${encodeURIComponent(root)}`, { headers: { Authorization: `token ${server.token}` }, cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (response.ok) info = (await response.json()) as CompanionDisk;
  } catch {
    // off, asleep, or an older Companion
  }
  probes.set(key, { at: Date.now(), info });
  return info;
}

/** Free disk on the project's own machine, through its small kernel: null when it isn't connected. */
export async function kernelDisk(scope: string, root: string): Promise<CompanionDisk | null> {
  const answer = await runQuietly(`import os, shutil, json\n_r = os.path.abspath(os.path.expanduser(${JSON.stringify(root)}))\nwhile not os.path.exists(_r): _r = os.path.dirname(_r)\n_u = shutil.disk_usage(_r)\nprint(json.dumps({'free': _u.free, 'total': _u.total}))`, scope).catch(() => null);
  try {
    return answer?.ok ? (JSON.parse(answer.text.trim().split('\n').pop() || 'null') as CompanionDisk) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- the ends --

/** A home as one end of a move: its name, and where a machine there finds the folder. */
export function endOf(playground: Playground, home: FilesHome, machineName: string, driveFolder?: string): MoveEnd | null {
  if (home.kind === 'drive') return { kind: 'drive', label: 'Google Drive', ...(driveFolder ? { folder: driveFolder } : {}) };
  if (home.kind === 'server') {
    const server = serverById(home.serverId);
    return { kind: 'server', label: server?.name ?? home.name ?? 'a computer', root: home.root, ...((home.deviceId ?? server?.companionId) ? { deviceId: home.deviceId ?? server?.companionId } : {}) };
  }
  if (home.kind === 'machine') return { kind: 'machine', label: machineName, root: machineRoot({ ...playground, home }) };
  return null;
}

/**
 * How the machine holding a home is told to do a step, here and now: a Companion that moves files, or the
 * project's own kernel when the home is on the machine it is connected to. Null: it can't be, from this page now.
 */
export async function runnerFor(playground: Playground, home: FilesHome, connected: boolean): Promise<Runner | null> {
  if (home.kind === 'server') {
    const server = serverById(home.serverId);
    if (server && (await companionDisk(server, home.root))) return { how: 'companion', server };
    const onCompute = playground.compute.kind === 'server' && playground.compute.serverId === home.serverId;
    return onCompute && connected ? { how: 'kernel', scope: playground.id } : null;
  }
  if (home.kind === 'machine') return connected ? { how: 'kernel', scope: playground.id } : null;
  return null;
}

/** Why a home's machine can't be told now, in words, for the panel. */
export function whyNoRunner(home: FilesHome, machineName: string): string {
  if (home.kind === 'server') {
    const name = serverById(home.serverId)?.name ?? home.name ?? 'That computer';
    return `${name} isn’t reachable with a Companion that moves files (0.15.0 or later): start it, or update it.`;
  }
  if (home.kind === 'machine') return `Connect to ${machineName} first: its disk is reached through its kernel.`;
  return '';
}

/** One step started on a machine. */
export async function runStep(runner: Runner, config: Record<string, string>): Promise<void> {
  if (runner.how === 'companion') {
    const response = await fetch(`${companionBase(runner.server)}companion/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `token ${runner.server.token}` }, body: JSON.stringify(config) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `${runner.server.name} answered ${response.status}.`);
    return;
  }
  const answer = await runQuietly(launchCode(config, MOVER), runner.scope);
  if (!answer?.ok) throw new Error(`The mover didn’t start on the machine${answer?.text ? `: ${answer.text.slice(-300)}` : '.'}`);
}

// --------------------------------------------------------------- the move --

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error || `The proxy answered ${response.status}.`);
  return answer;
}

export const moveStatus = (id: string) => call<{ move: MoveState }>(`/moves/status?id=${id}`).then((answer) => answer.move);

/**
 * A move started: the Worker's job, the project marked as moving, and the first step started on its machine.
 * Throws, with nothing started, when the machine that goes first can't be told now.
 */
export async function startMove(playground: Playground, to: Destination, machineName: string, connected: boolean, options: { removeOld?: boolean } = {}): Promise<string> {
  const toHome = homeFor(playground, to, driveFolderName);
  const planned = planOf(playground.home, toHome);
  if ('refused' in planned) throw new Error(planned.refused);
  const { plan } = planned;
  const steps = stepsOf(plan);
  const firstHome = steps.first === 'source' ? playground.home : toHome;
  const runner = await runnerFor(playground, firstHome, connected);
  if (!runner) throw new Error(whyNoRunner(firstHome, machineName));
  // Drive at one end: its folder's id, made when it is the new place, and the account's token for the machine.
  const driveHome = plan === 'drive-pull' ? playground.home : plan === 'drive-push' ? toHome : null;
  const driveFolder = driveHome ? await driveFolderIdOf(driveHome) : undefined;
  const token = driveHome ? await driveTokenNow() : undefined;
  const from = endOf(playground, playground.home, machineName, plan === 'drive-pull' ? driveFolder : undefined)!;
  const toEnd = endOf(playground, toHome, machineName, plan === 'drive-push' ? driveFolder : undefined)!;
  const id = newId();
  const removeOld = Boolean(options.removeOld);
  const started = await call<{ key: string; api: string }>('/moves/start', { id, project: playground.id, title: playground.title, plan, from, to: toEnd, token, removeOld });
  keepKey(id, started.key);
  updatePlayground(playground.id, { moving: { id, to: toHome, plan, started: Date.now(), ...(removeOld ? { removeOld } : {}) } });
  const root = (steps.first === 'source' ? from : toEnd).root ?? '';
  try {
    await runStep(runner, { mode: steps.firstMode, api: started.api, id, key: started.key, root, ...(driveFolder ? { drive: driveFolder } : {}) });
  } catch (error) {
    await call('/moves/cancel', { id }).catch(() => undefined);
    updatePlayground(playground.id, { moving: undefined });
    keepKey(id, null);
    throw error;
  }
  return id;
}

/**
 * The second step of an archive move, the unpack, started from this page: when the destination is Colab or a
 * server without the Companion — or a Companion the Worker couldn't reach when the archive was ready.
 */
export async function startUnpack(playground: Playground, move: MoveState, connected: boolean, api: string): Promise<boolean> {
  const key = keyOf(move.id);
  const to = playground.moving?.to;
  if (!key || !to) return false;
  const runner = await runnerFor(playground, to, connected);
  if (!runner) return false;
  await runStep(runner, { mode: 'unpack', api, id: move.id, key, root: move.to.root ?? '' });
  return true;
}

/** The Worker's address as the machines call it: the proxy's, absolute. */
export function workerAddress(base: string | null): string {
  if (!base) return '';
  return new URL(base, window.location.href).href.replace(/\/$/, '');
}

/** The move done: the project's home is the new place, the old one remembered until its copy is removed. */
export async function settleMove(playground: Playground, move: MoveState): Promise<void> {
  const moving = playground.moving;
  if (!moving || moving.id !== move.id) return;
  const met = move.met;
  const removed = move.oldCopy === 'removed';
  updatePlayground(playground.id, {
    home: moving.to,
    moving: undefined,
    movedFrom: {
      home: playground.home,
      at: Date.now(),
      move: move.id,
      ...(removed ? { removed } : {}),
      ...(moving.removeOld && !removed && move.oldCopy !== 'failed' ? { removeWanted: true } : {}),
      ...(met?.conflicts ? { conflicts: met.conflicts, conflictPaths: met.conflictPaths.slice(0, 20) } : {}),
      ...(met?.kept ? { kept: met.kept } : {}),
    },
  });
  await call('/moves/settled', { id: move.id }).catch(() => undefined);
}

export async function cancelMove(playground: Playground): Promise<void> {
  const moving = playground.moving;
  if (!moving) return;
  await call('/moves/cancel', { id: moving.id }).catch(() => undefined);
  keepKey(moving.id, null);
  updatePlayground(playground.id, { moving: undefined });
}

/** The account's Google token handed on again, while the page is open: a move to or from Drive that runs past an hour carries on. */
export async function renewDriveToken(id: string): Promise<void> {
  await call('/moves/drive-token', { id, token: await driveTokenNow() });
}

/** The old copy, removed once the move is checked: Drive's folder to the bin; a computer's or a machine's folder deleted (a linked folder only unlinked). */
export async function removeOldCopy(playground: Playground, connected: boolean, machineName: string): Promise<void> {
  const old = playground.movedFrom;
  if (!old || old.removed) return;
  // Never the folder the files are in now.
  const sameFolder = sameHome(old.home, playground.home) || (old.home.kind === 'machine' && playground.home.kind === 'server' && playground.compute.kind === 'server' && playground.compute.serverId === playground.home.serverId && machineRoot({ ...playground, home: old.home }) === playground.home.root);
  if (sameFolder) throw new Error('The old place and the new one are the same folder: there is nothing to remove.');
  if (old.home.kind === 'drive') {
    await trashFile(await driveTokenNow(), await driveFolderIdOf(old.home));
  } else {
    const runner = await runnerFor(playground, old.home, connected);
    if (!runner) throw new Error(whyNoRunner(old.home, machineName));
    const root = old.home.kind === 'server' ? old.home.root : machineRoot({ ...playground, home: old.home });
    await runStep(runner, { mode: 'remove', api: '', id: '', key: '', root });
  }
  updatePlayground(playground.id, { movedFrom: { ...old, removed: true, removeWanted: undefined } });
}

/** The old copy kept for good: the project forgets it was moved. */
export const keepOldCopy = (playground: Playground) => updatePlayground(playground.id, { movedFrom: undefined });
