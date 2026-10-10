// ===========================================================================
//  Away — a project whose code is on another computer.
//
//  A project's folder can live on one computer only (a Companion's folder, or
//  a Jupyter server's). Opened in a browser on another computer, the code may
//  not be there to open: that computer isn't connected to this browser, or it
//  is and doesn't answer. This says which, by the computer's name, and offers
//  what can be done from here, in the ways the reader picked under "Code on
//  another computer…" (settings.awayShows):
//
//    A  the Playground's list grouped by where each project's code is
//    B  a card in the editor's place saying where the code is and what to do
//    C  a read-only snapshot of the code, kept in Drive by the computer that
//       has it, to read (and copy) while that computer is away
//    D  "Bring the code here": a copy as a new project, in Drive or on this
//       computer, or the project moved to Drive so it opens everywhere
// ===========================================================================

import { useEffect, useState } from 'react';
import type { AwayShows } from '../types';
import { createPlayground, homeHost, serverById, updatePlayground } from './playground';
import type { FileHost, FilesHome, Playground, Snapshot } from './playground';
import { listAll } from './projectAgent';
import { newCell } from './notebook';

export const AWAY_DEFAULT: AwayShows = { group: true, card: true, snapshot: false, bring: true };

export const AWAY_SHOWS: { id: keyof AwayShows; label: string; note: string }[] = [
  { id: 'group', label: 'A · Grouped by computer, on the Playground’s home', note: 'The playgrounds listed by where their code is — this computer, your Drive, each other computer with whether it answers — with a filter for the ones that open here.' },
  { id: 'card', label: 'B · Where the code is, in the editor’s place', note: 'Opening a project whose computer isn’t reachable shows which computer has it, when it was last seen, and what to do — instead of an empty editor.' },
  { id: 'snapshot', label: 'C · A read-only snapshot, kept in Drive', note: 'While a project is open on the computer that has it, its code (not data or checkpoints) is copied to your Drive every few minutes; elsewhere, that copy opens read-only.' },
  { id: 'bring', label: 'D · Bring the code here', note: 'Copy a project into a new one, in Drive or on this computer, or move it to Drive so every computer opens it.' },
];

// ------------------------------------------------------- where the code is --

/** Whether this browser can open a project's code: here, on a computer that doesn't answer, or one it doesn't know. */
export type Reach = { state: 'here' } | { state: 'checking' | 'down' | 'unknown'; computer: string; seen?: number };

/** The computer a project's folder is on, by name, when it is on one. */
export function computerOf(p: Pick<Playground, 'home'>): string | null {
  if (p.home.kind !== 'server') return null;
  return serverById(p.home.serverId)?.name ?? p.home.name ?? 'a computer this browser has never been connected to';
}

/** Whether the code opens from here: a folder on a computer is looked at (every half minute, or on `retry`), any other kind of home is here. */
export function useReach(p: Playground): [Reach, () => void] {
  const [nonce, setNonce] = useState(0);
  const retry = () => setNonce((n) => n + 1);
  const computer = computerOf(p);
  const server = p.home.kind === 'server' ? serverById(p.home.serverId) : undefined;
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');
  const key = server ? `${server.id}@${server.url}@${p.home.kind === 'server' ? p.home.root : ''}` : '';
  useEffect(() => {
    if (!server) return;
    let alive = true;
    let timer = 0;
    const look = async () => {
      const ok = await Promise.race([
        homeHost(p)
          .list('')
          .then(() => true)
          .catch(() => false),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 6000)),
      ]);
      if (!alive) return;
      setState(ok ? 'up' : 'down');
      timer = window.setTimeout(() => void look(), 30_000);
    };
    setState('checking');
    void look();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  if (!computer) return [{ state: 'here' }, retry];
  if (!server) return [{ state: 'unknown', computer, seen: p.snapshot?.at }, retry];
  if (state === 'up') return [{ state: 'here' }, retry];
  return [{ state, computer, seen: server.seen ?? p.snapshot?.at }, retry];
}

/** "3 days ago", "just now": for when a computer was last seen or a snapshot taken. */
export function since(at: number | undefined, now = Date.now()): string {
  if (!at) return 'some time ago';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

// ------------------------------------------------------------- snapshots --

/** What a snapshot keeps: code and small text files, never data, checkpoints or what the folder's ignore names. */
const SNAP_SKIP = /(^|\/)(\.git|\.reader|reader-meta|__pycache__|\.ipynb_checkpoints|node_modules|data|datasets|checkpoints|runs|wandb|outputs|\.venv|venv)(\/|$)/;
const SNAP_BINARY = /\.(pt|pth|ckpt|safetensors|bin|npy|npz|pkl|h5|onnx|zip|tar|gz|png|jpe?g|gif|pdf|parquet|arrow|mp4|wav)$/i;
export const SNAP_FILE_MAX = 200_000;
const SNAP_TOTAL_MAX = 4_000_000;
const SNAP_FILES_MAX = 300;
const MANIFEST = '.snapshot.json';

export interface SnapshotManifest {
  at: number;
  computer: string;
  files: { path: string; size: number }[];
  /** Folders and files left out, and why: shown so the snapshot is honest about what it isn't. */
  left: string[];
}

/** Which files a snapshot takes from a listing, and what it leaves. */
export function snapshotPlan(listing: { path: string; size: number | null }[]): { take: { path: string; size: number }[]; left: string[] } {
  const take: { path: string; size: number }[] = [];
  const left = new Set<string>();
  let total = 0;
  for (const file of listing) {
    const skip = SNAP_SKIP.exec(file.path);
    if (skip) {
      left.add(file.path.slice(0, (skip.index ?? 0) + skip[0].length).replace(/^\//, ''));
      continue;
    }
    const size = file.size ?? 0;
    if (SNAP_BINARY.test(file.path) || size > SNAP_FILE_MAX) {
      left.add(file.path);
      continue;
    }
    if (take.length >= SNAP_FILES_MAX || total + size > SNAP_TOTAL_MAX) {
      left.add(file.path);
      continue;
    }
    take.push({ path: file.path, size });
    total += size;
  }
  return { take, left: [...left].sort() };
}

/** The Drive folder a project's snapshot is kept in, beside the projects kept in Drive: Playgrounds/Snapshot-<id>. */
const snapshotHome = (p: Pick<Playground, 'id'>): FilesHome => ({ kind: 'drive', folder: `Snapshot-${p.id}` });
export const snapshotHost = (p: Playground): FileHost => homeHost({ ...p, home: snapshotHome(p) });

/** What was last written to each project's snapshot, so an unchanged file isn't written again. */
const written = new Map<string, Map<string, string>>();

/**
 * The project's code, copied to its snapshot in Drive: the files that changed since the last one, and a manifest.
 * Run where the code is; it needs Drive. Returns the manifest, or null when there was nothing to read.
 */
export async function takeSnapshot(p: Playground): Promise<SnapshotManifest | null> {
  const computer = computerOf(p);
  if (!computer) return null;
  const home = homeHost(p);
  const plan = snapshotPlan(await listAll(home));
  const target = snapshotHost(p);
  const last = written.get(p.id) ?? new Map<string, string>();
  for (const file of plan.take) {
    const text = await home.read(file.path).catch(() => null);
    if (text === null || last.get(file.path) === text) continue;
    await target.write(file.path, text);
    last.set(file.path, text);
  }
  written.set(p.id, last);
  const manifest: SnapshotManifest = { at: Date.now(), computer, files: plan.take, left: plan.left };
  await target.write(MANIFEST, JSON.stringify(manifest));
  updatePlayground(p.id, { snapshot: { at: manifest.at, computer, files: plan.take.length } satisfies Snapshot });
  return manifest;
}

export async function readManifest(p: Playground): Promise<SnapshotManifest | null> {
  const text = await snapshotHost(p).read(MANIFEST).catch(() => null);
  if (!text) return null;
  try {
    const manifest = JSON.parse(text) as SnapshotManifest;
    return Array.isArray(manifest.files) ? manifest : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- bringing it here --

/** Every file a copy takes, from the project's own folder when it answers here, else from its snapshot. */
export async function filesToCopy(p: Playground, from: 'home' | 'snapshot'): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (from === 'snapshot') {
    const manifest = await readManifest(p);
    const host = snapshotHost(p);
    for (const file of manifest?.files ?? []) {
      const text = await host.read(file.path).catch(() => null);
      if (text !== null) out[file.path] = text;
    }
    return out;
  }
  const home = homeHost(p);
  for (const file of snapshotPlan(await listAll(home)).take) {
    const text = await home.read(file.path).catch(() => null);
    if (text !== null) out[file.path] = text;
  }
  return out;
}

/** A copy as a new project, kept in `home`, running where the original runs. */
export async function copyProject(p: Playground, from: 'home' | 'snapshot', home: FilesHome): Promise<Playground> {
  const files = await filesToCopy(p, from);
  return createPlayground({
    title: `${p.title} (copy)`,
    kind: p.kind,
    compute: p.compute,
    home,
    start: 'copy',
    cites: p.cites,
    files,
    cells: p.cells?.map((cell) => newCell(cell.type, cell.source)),
    idleStopMin: p.idleStopMin,
  });
}

/** The project moved to Drive: its code copied there, and the project's home pointed at it. The old folder stays as it was. */
export async function moveToDrive(p: Playground, folder: string): Promise<number> {
  const files = await filesToCopy(p, 'home');
  const target = homeHost({ ...p, home: { kind: 'drive', folder } });
  for (const [path, text] of Object.entries(files)) await target.write(path, text);
  updatePlayground(p.id, { home: { kind: 'drive', folder } });
  return Object.keys(files).length;
}
