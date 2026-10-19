// ===========================================================================
//  What a move of a project's files is, before anything is asked of a
//  machine (docs/storage-moves.md): where the files go as a home, which of
//  the three ways they get there, and which end does each step. Pure, so the
//  tests check every pair of places without a browser; src/lib/moves.ts does
//  the asking.
//
//    archive     a machine to a machine: the source packs one archive into
//                R2, through the Worker, and the destination unpacks it
//    drive-pull  Google Drive to a machine: the destination fetches from Drive
//    drive-push  a machine to Google Drive: the source sends to Drive
// ===========================================================================

import type { Compute, FilesHome } from './playground';

export type MovePlan = 'archive' | 'drive-pull' | 'drive-push';

/** Where a project's files could go: the account's Drive, one of the person's computers, or the project's own Colab machine's disk. */
export type Destination = { kind: 'drive' } | { kind: 'server'; serverId: string; name: string; deviceId?: string } | { kind: 'machine' };

/** One end of a move, as the Worker keeps it: what to call it, and what a machine there needs to find the folder. */
export interface MoveEnd {
  kind: 'drive' | 'server' | 'machine';
  label: string;
  deviceId?: string;
  root?: string;
  folder?: string;
}

export const slugOfTitle = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'playground';

/** The folder a project gets in a new place: its name and id, as a new project's would be. */
export function homeFor(project: { id: string; title: string }, to: Destination, driveFolderName: (title: string, id: string) => string): FilesHome {
  if (to.kind === 'drive') return { kind: 'drive', folder: driveFolderName(project.title, project.id) };
  if (to.kind === 'machine') return { kind: 'machine' };
  return { kind: 'server', serverId: to.serverId, root: `playgrounds/${slugOfTitle(project.title)}-${project.id}`, name: to.name, ...(to.deviceId ? { deviceId: to.deviceId } : {}) };
}

/** Whether two homes are the same place, so there is nothing to move. */
export function sameHome(a: FilesHome, b: FilesHome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'drive' && b.kind === 'drive') return true;
  if (a.kind === 'server' && b.kind === 'server') return a.serverId === b.serverId || Boolean(a.deviceId && a.deviceId === b.deviceId);
  return a.kind === b.kind;
}

/** How the files get from one home to another, or why they can't. */
export function planOf(from: FilesHome, to: FilesHome): { plan: MovePlan } | { refused: string } {
  if (sameHome(from, to)) return { refused: 'The files are already there.' };
  if (from.kind === 'browser') return { refused: 'These files are kept in this browser: move them to Drive or a computer from the explorer first.' };
  if (to.kind === 'browser') return { refused: 'Files are no longer kept in a browser.' };
  if (from.kind === 'drive') return { plan: 'drive-pull' };
  if (to.kind === 'drive') return { plan: 'drive-push' };
  return { plan: 'archive' };
}

/** Which end does the first step, and which the second (none for the Drive ways, where one machine does it all). */
export function stepsOf(plan: MovePlan): { first: 'source' | 'destination'; firstMode: 'pack' | 'drive-pull' | 'drive-push'; second?: 'unpack' } {
  if (plan === 'drive-pull') return { first: 'destination', firstMode: 'drive-pull' };
  if (plan === 'drive-push') return { first: 'source', firstMode: 'drive-push' };
  return { first: 'source', firstMode: 'pack', second: 'unpack' };
}

/** A project whose files are on its own Colab machine's disk can't leave that machine without moving them first. */
export function computeChangeRefused(home: FilesHome, now: Compute, next: Compute): string | null {
  if (home.kind !== 'machine') return null;
  const same = now.kind === next.kind && (now.kind === 'colab' || (next.kind === 'server' && now.kind === 'server' && now.serverId === next.serverId));
  return same ? null : 'The files are on this machine’s own disk: move them to Drive or a computer first, or they stay behind on it.';
}

/** The lines that start the mover on a machine with no Companion, in its small kernel: the mover written there and started on its own. */
export function launchCode(config: Record<string, string>, script: string): string {
  return [
    'import os, json, sys, subprocess',
    "_d = os.path.expanduser('~/.reader-agent')",
    'os.makedirs(_d, exist_ok=True)',
    "_p = os.path.join(_d, 'mover.py')",
    `open(_p, 'w').write(${JSON.stringify(script)})`,
    `_c = json.loads(${JSON.stringify(JSON.stringify(config))})`,
    "_c['root'] = os.path.abspath(os.path.expanduser(_c['root']))",
    "_f = os.path.join(_d, 'move-%s-%s.json' % (_c.get('id') or 'x', _c['mode']))",
    '_fd = os.open(_f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)',
    'os.write(_fd, json.dumps(_c).encode())',
    'os.close(_fd)',
    "_l = open(os.path.join(_d, 'move-%s.log' % (_c.get('id') or 'x')), 'ab')",
    '_pr = subprocess.Popen([sys.executable, _p, _f], stdout=_l, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)',
    "print(json.dumps({'pid': _pr.pid}))",
  ].join('\n');
}

/** A size in words: 4.2 MB. */
export function sizeOf(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** What a step reported, in words, for the progress card. */
export function stepWords(step: string, plan: MovePlan, from: string, to: string): string {
  switch (step) {
    case 'started':
      return plan === 'drive-pull' ? `Asking ${to} to fetch the files from Drive` : `Asking ${from} to pack the files`;
    case 'packing':
      return `${from} is packing the files`;
    case 'packed':
      return `Packed — waiting for ${to} to unpack`;
    case 'unpacking':
      return `${to} is unpacking and checking every file`;
    case 'pulling':
      return `${to} is fetching the files from Drive`;
    case 'pushing':
      return `${from} is sending the files to Drive`;
    case 'waiting':
      return 'Waiting for your Google sign-in to be renewed — open the project to carry on';
    case 'unpacked':
    case 'pulled':
    case 'pushed':
      return `Every file is in ${to}, and checked`;
    case 'failed':
      return 'It stopped';
    default:
      return step;
  }
}
