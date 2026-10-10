// The Playground: code of the person's own, not tied to one paper. A
// playground is a notebook and a folder of files, bound to a machine to run
// on — the person's Colab, or a Jupyter server of theirs on this PC or on a
// GPU elsewhere — with the files kept somewhere that outlives the machine:
// this browser, or a folder on a Jupyter server (usually this PC's).
//
// When the files live in one place and the code runs in another — "code on
// this PC, GPU in the cloud" — the folder is copied onto the machine before
// a command runs (what the sync rules let through), and what the run wrote
// under the folders named to bring back comes home after it. The cells and
// the console both run in the machine's kernel, so a variable a cell set is
// there for the next, and a command runs in a real shell on that machine.
//
// Kept in the signed-in account's Drive (playgroundsDrive.ts): each playground's
// record — title, where it runs and where its files are, by the computer's
// Companion id, its console and its notebook's cells — so any browser signed in
// as the account opens it. IndexedDB keeps a copy under `playground:<id>`, for
// a quick start and offline; the files of one that lives in this browser are
// under `playground-files:<id>`, and stay in it. The servers — addresses and
// tokens — stay in this browser's localStorage (or come from the account's
// list of computers, devices.ts).

import { useSyncExternalStore } from 'react';
import { db } from './db';
import type { Backend, JupyterServer, Machine, RuntimeEntry } from './colab';
import { JupyterRequestError, playgroundNotebook, jupyterDelete, jupyterFetch, jupyterList, jupyterRead, jupyterRename, jupyterWrite, runQuietly } from './colab';
import type { NbCell } from './notebook';
import { newCell, notebookFor, subscribeNotebook } from './notebook';
import type { CellType } from './notebook';
import type { PlaygroundSet } from './playgroundsDrive';
import { mergePlaygrounds, readPlaygroundsFromDrive, serialisePlaygrounds, writePlaygroundsToDrive } from './playgroundsDrive';
import type { CompanionPairing } from './companion';
import { secureAddress } from './companion';
import { currentAccount, onProxyChange } from './api';
import { driveFolderName, driveHost } from './driveFiles';

// ---------------------------------------------------------------- types ----

/** Where a playground's code runs. */
/** A computer as the record names it, for a browser that doesn't know it: its name, and whether it is a PC or a machine elsewhere. */
interface Named {
  name?: string;
  where?: 'pc' | 'remote';
}

export type Compute = { kind: 'colab'; machine: Machine; /** On the browser's Colab machine, with the paper pages and the other playgrounds that share it, rather than a machine of its own. */ shared?: boolean } | ({ kind: 'server'; serverId: string; /** The computer's Companion id: the same in every browser, where serverId is this browser's. */ deviceId?: string } & Named);

/**
 * Where its files are kept: a folder in the account's Google Drive, a folder
 * on a Jupyter server, or the disk of the machine it runs on. `browser` is
 * only for projects made before: their files are moved out on opening.
 */
export type FilesHome =
  | { kind: 'drive'; /** The folder's name under Papers_collection/Playgrounds. */ folder: string }
  | { kind: 'machine' }
  | ({ kind: 'server'; serverId: string; root: string; /** The computer's Companion id, as in Compute. */ deviceId?: string } & Named)
  | { kind: 'browser'; /** Which browser it was made in, in a few words ("Chrome on a Mac"), for the others. */ browser?: string };

/** This browser, in a few words: "Safari on a Mac", "Chrome on Windows". */
export function browserLabel(agent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const app = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'a browser';
  const os = /iPhone|iPad/.test(agent) ? 'an iPhone or iPad' : /Mac OS X|Macintosh/.test(agent) ? 'a Mac' : /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : '';
  return os ? `${app} on ${os}` : app;
}

export interface Cite {
  paperId: string;
  title: string;
}

export interface ConsoleEntry {
  id: string;
  command: string;
  at: number;
}

export interface Playground {
  id: string;
  title: string;
  /** What it opens on: the notebook, or the files and the console. */
  kind: 'notebook' | 'project';
  created: number;
  updated: number;
  compute: Compute;
  home: FilesHome;
  /** How a project's files are edited: the page's own editor, or VS Code from the Companion's computer, in the page. */
  editor?: 'reader' | 'vscode';
  /** The papers it came from or is about. */
  cites: Cite[];
  /** What is copied to the machine and what is left (gitignore-like, one a line), and what comes back after a run. */
  sync: { ignore: string; bringBack: string };
  /** The commands run in its console, newest last. */
  console: ConsoleEntry[];
  /** On Colab: stop the runtime after this many minutes with nothing running, while the tab is open; 0 is never. */
  idleStopMin: number;
  /** A first command for the console, waiting for a click — a repository's clone. */
  pending?: string;
  /** How it started, for the home's list. */
  start: 'blank' | 'paper' | 'repo' | 'model' | 'file' | 'copy';
  /** The notebook's cells as text (no outputs), so it opens in another browser: kept in Drive with the rest. */
  cells?: { type: CellType; source: string }[];
}

export const DEFAULT_IGNORE = ['.git/', '.reader/', 'reader-meta/', '__pycache__/', '.ipynb_checkpoints/', 'data/', '*.ckpt', '*.pt', '*.safetensors', 'wandb/'].join('\n');
export const DEFAULT_BRING_BACK = ['runs/', 'results/', 'outputs/', '*.csv', '*.json', '*.png'].join('\n');

// --------------------------------------------------------- the servers ----

const SERVERS_KEY = 'reader.playground.servers';

const readServers = (): JupyterServer[] => {
  try {
    const raw = localStorage.getItem(SERVERS_KEY);
    const parsed = raw ? (JSON.parse(raw) as JupyterServer[]) : [];
    return Array.isArray(parsed) ? parsed.filter((server) => server && typeof server.id === 'string' && typeof server.url === 'string') : [];
  } catch {
    return [];
  }
};

let servers: JupyterServer[] = typeof localStorage === 'undefined' ? [] : readServers();
// What the page shows: a Companion that belongs to a Google account only while signed in as that account.
const visibleOf = (all: JupyterServer[]) => {
  const account = currentAccount();
  return all.filter((server) => !server.account || server.account === account);
};
let visible = visibleOf(servers);
const serverListeners = new Set<() => void>();
const saveServers = (next: JupyterServer[]) => {
  servers = next;
  visible = visibleOf(next);
  try {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(next));
  } catch {
    // private mode: kept for this page load
  }
  serverListeners.forEach((listener) => listener());
};
// Signing in or out (or as someone else) changes whose computers show.
onProxyChange(() => {
  const next = visibleOf(servers);
  if (next.length === visible.length && next.every((server, i) => server === visible[i])) return;
  visible = next;
  serverListeners.forEach((listener) => listener());
});

/** Every server this browser keeps, whoever's: for the account sync, not for showing. */
export const allServers = () => servers;
export const serversNow = () => visible;
export const subscribeServers = (listener: () => void) => {
  serverListeners.add(listener);
  return () => {
    serverListeners.delete(listener);
  };
};
export const useServers = () => useSyncExternalStore(subscribeServers, serversNow);
export const serverById = (id: string | undefined) => visible.find((server) => server.id === id);

/** A Jupyter server's address as the page keeps it: the scheme, the host and the base path, with a trailing slash; any `?token=` lifted out. */
export function parseServerUrl(input: string): { url: string; token?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const token = url.searchParams.get('token') ?? undefined;
  // A link Jupyter prints goes to /tree or /lab; the server is the part before it.
  const base = url.pathname.replace(/\/(tree|lab|notebooks|api)(\/.*)?$/, '/').replace(/\/?$/, '/');
  return { url: `${url.protocol}//${url.host}${base}`, token };
}

export function saveServer(server: Omit<JupyterServer, 'id'> & { id?: string }): JupyterServer {
  const made: JupyterServer = { ...server, id: server.id ?? uid() };
  saveServers(servers.some((s) => s.id === made.id) ? servers.map((s) => (s.id === made.id ? made : s)) : [...servers, made]);
  return made;
}

/** Keeps a Companion's pairing as this browser's PC server, reached at `base` (its direct address or its tunnel's): the one already saved for that Companion, updated, or a new one. */
export function saveCompanion(pairing: CompanionPairing, base: string): JupyterServer {
  const same = servers.find((server) => (pairing.id && server.companionId === pairing.id) || server.url === base);
  return saveServer({ id: same?.id, name: pairing.name, where: 'pc', url: base, token: pairing.token, companionId: pairing.id, root: pairing.root || same?.root, account: same?.account });
}

/** Moves each Companion this browser reaches over plain http onto its https address, where this computer's certificate lets it: the same server, encrypted. */
export async function secureCompanions(): Promise<void> {
  for (const server of servers) {
    const secure = await secureAddress(server).catch(() => null);
    if (secure) saveServer({ ...server, url: secure });
  }
}

export const removeServer = (id: string) => saveServers(servers.filter((server) => server.id !== id));

// ------------------------------------------------------- the playgrounds --

const KEY = (id: string) => `playground:${id}`;
const FILES_KEY = (id: string) => `playground-files:${id}`;

let playgrounds: Playground[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));

/** A folder name from a title: lower case, dashes, nothing odd. */
export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'playground';

export function loadPlaygrounds(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = Promise.all([db.kvWithPrefix<Playground>('playground:'), db.getKv<Record<string, number>>(DELETED_KEY).catch(() => undefined)])
    .then(([found, gone]) => {
      playgrounds = found.map(([, value]) => normalise(value)).filter((p): p is Playground => Boolean(p));
      deleted = gone && typeof gone === 'object' ? gone : {};
      playgrounds = playgrounds.map(rebind);
    })
    .catch(() => {
      playgrounds = [];
    })
    .finally(() => {
      loaded = true;
      loading = null;
      emit();
    });
  return loading;
}

/** What is kept, made whole: an older record gets the fields added since. */
function normalise(value: Partial<Playground> | undefined): Playground | null {
  if (!value || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    title: value.title || 'Untitled playground',
    kind: value.kind === 'project' ? 'project' : 'notebook',
    created: value.created ?? Date.now(),
    updated: value.updated ?? value.created ?? Date.now(),
    compute: value.compute ?? { kind: 'colab', machine: { accelerator: 'NONE' } },
    home: value.home ?? { kind: 'browser' },
    cites: Array.isArray(value.cites) ? value.cites : [],
    sync: { ignore: value.sync?.ignore ?? DEFAULT_IGNORE, bringBack: value.sync?.bringBack ?? DEFAULT_BRING_BACK },
    console: Array.isArray(value.console) ? value.console : [],
    idleStopMin: typeof value.idleStopMin === 'number' ? value.idleStopMin : 30,
    pending: value.pending,
    start: value.start ?? 'blank',
    cells: Array.isArray(value.cells) ? value.cells : undefined,
  };
}

const snapshot = () => playgrounds;
export const subscribePlaygrounds = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const usePlaygrounds = () => useSyncExternalStore(subscribePlaygrounds, snapshot);
export const playgroundsLoaded = () => loaded;
/** The kernel backend a playground's compute names, when it can be had: Colab, or a server still in the list. */
export function backendOfPlayground(p: Playground): Backend | null {
  // On Colab: a machine of its own (its own notebook id, so Colab assigns it its own runtime), unless it shares the browser's.
  if (p.compute.kind === 'colab') return { kind: 'colab', notebook: p.compute.shared ? undefined : playgroundNotebook(p.id), machine: p.compute.machine };
  const server = serverById(p.compute.serverId);
  return server ? { kind: 'jupyter', server } : null;
}
/** Every playground, as the store holds them now. */
export const playgroundsNow = () => playgrounds;
export const playgroundById = (id: string | undefined) => playgrounds.find((p) => p.id === id);

/** Asks the app to open a playground — from a page that is not the Playground, like a paper's notebook. */
export const OPEN_PLAYGROUND = 'reader:open-playground';

/** The notebook's key in the notebook store: the playground's id, marked, so it is never taken for a paper's. */
export const notebookKey = (id: string) => `pg:${id}`;

function put(next: Playground) {
  playgrounds = playgrounds.some((p) => p.id === next.id) ? playgrounds.map((p) => (p.id === next.id ? next : p)) : [next, ...playgrounds];
  emit();
  void db.setKv(KEY(next.id), next).then(announce, () => undefined);
  scheduleSync();
}

// ------------------------------------------------- the computer, by id --

/**
 * A playground's computer as this browser knows it. Its record names the
 * server by this browser's id and by the Companion's (`deviceId`); in another
 * browser the first means nothing, so the server with that Companion id is
 * put in its place. The record is changed here only, not marked as edited.
 */
function rebind(p: Playground): Playground {
  const fix = <T extends Compute | FilesHome>(ref: T): T => {
    if (ref.kind !== 'server') return ref;
    const here = visible.find((server) => server.id === ref.serverId) ?? (ref.deviceId ? visible.find((server) => server.companionId === ref.deviceId) : undefined);
    if (!here) return ref;
    // Its id here, its Companion's id, and its name: the name goes with the record, so a browser that doesn't know the computer can still say which it is.
    const next = { ...ref, serverId: here.id, deviceId: here.companionId ?? ref.deviceId, name: here.name, where: here.where === 'pc' ? 'pc' : 'remote' } as T;
    return JSON.stringify(next) === JSON.stringify(ref) ? ref : next;
  };
  const compute = fix(p.compute);
  const home = fix(p.home);
  return compute === p.compute && home === p.home ? p : { ...p, compute, home };
}

function rebindAll() {
  let changed = false;
  playgrounds = playgrounds.map((p) => {
    const next = rebind(p);
    if (next !== p) {
      changed = true;
      void db.setKv(KEY(next.id), next).catch(() => undefined);
    }
    return next;
  });
  if (changed) emit();
}

// A computer that comes into this browser's list (the account's list synced, or one paired) takes its playgrounds.
subscribeServers(rebindAll);

// ---------------------------------------------------------- in Drive --

const DELETED_KEY = 'pg-deleted';
/** Playgrounds deleted here or in another browser: id → when, so a deletion carries over. */
let deleted: Record<string, number> = {};
let drive: { clientId: string; folderName?: string; account?: string } | null = null;
let where: 'browser' | 'drive' | 'error' = 'browser';
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncing: Promise<void> | null = null;
let syncAgain = false;

/** Where the list is kept now: this browser only (signed out, or Drive not connected), the account's Drive, or Drive failing. */
export const playgroundsWhere = () => where;
/** Whether Drive can keep a project's files now: signed in, with Drive connected. */
export const driveConnected = () => Boolean(drive);
export const useDriveConnected = () => useSyncExternalStore(subscribePlaygrounds, driveConnected);
export const usePlaygroundsWhere = () => useSyncExternalStore(subscribePlaygrounds, playgroundsWhere);

/** Signed in with Drive connected (or not): the store calls this, and the list is synced with that account's Drive. */
export function configurePlaygroundDrive(next: { clientId: string; folderName?: string; account?: string } | null) {
  const same = JSON.stringify(next) === JSON.stringify(drive);
  drive = next;
  if (!next) {
    where = 'browser';
    emit();
  }
  if (next && !same) void syncPlaygrounds();
}

// ------------------------------------------ the other windows and browsers --

/**
 * The list is read from Drive as the Playground page opens; a window left
 * open — the app's, a tab — would otherwise keep what it read then. So the
 * windows of one browser tell each other when the list in its database
 * changed, and each takes it from there at once; and Drive is read again
 * when a window comes back into view and every minute while it is in view,
 * so a playground made in another browser or on another computer shows up
 * without a reload.
 */
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('reader-playgrounds') : null;
const READ_DRIVE_EVERY_MS = 60_000;
/** Back in view sooner than this after a reading: not read again. */
const READ_DRIVE_AT_MOST_MS = 10_000;
let lastSync = 0;

function announce() {
  try {
    channel?.postMessage('changed');
  } catch {
    // A closed channel: the others read Drive on their own clock.
  }
}

/** The list as this browser's database has it now, merged in: another window wrote it. */
async function takeFromThisBrowser() {
  if (!loaded) return;
  const [found, gone] = await Promise.all([db.kvWithPrefix<Playground>('playground:'), db.getKv<Record<string, number>>(DELETED_KEY).catch(() => undefined)]).catch(() => [[], undefined] as const);
  const stored: PlaygroundSet = { playgrounds: found.map(([, value]) => normalise(value)).filter((p): p is Playground => Boolean(p)), deleted: gone && typeof gone === 'object' ? gone : {} };
  const merged = mergePlaygrounds({ playgrounds, deleted }, stored);
  const next = merged.playgrounds.map(rebind);
  if (serialisePlaygrounds({ playgrounds: next, deleted: merged.deleted }) === serialisePlaygrounds({ playgrounds, deleted })) return;
  playgrounds = next;
  deleted = merged.deleted;
  emit();
}

const inView = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function readDriveAgain() {
  if (!drive || !inView() || Date.now() - lastSync < READ_DRIVE_AT_MOST_MS) return;
  void syncPlaygrounds();
}

if (channel) {
  channel.onmessage = () => void takeFromThisBrowser();
  // Outside a page (the tests, under Node) an open channel would keep the process alive.
  (channel as { unref?: () => void }).unref?.();
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('focus', readDriveAgain);
  document.addEventListener('visibilitychange', readDriveAgain);
  window.setInterval(() => {
    if (drive && inView() && Date.now() - lastSync >= READ_DRIVE_EVERY_MS - 1000) void syncPlaygrounds();
  }, READ_DRIVE_EVERY_MS);
}

function scheduleSync() {
  if (!drive) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncPlaygrounds(), 1500);
}

/** This browser's list and the one in Drive, merged; both brought to the result. */
export function syncPlaygrounds(): Promise<void> {
  if (!drive) return Promise.resolve();
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  const config = drive;
  syncing = (async () => {
    await loadPlaygrounds();
    const remote = await readPlaygroundsFromDrive(config.clientId, config.folderName);
    const local: PlaygroundSet = { playgrounds, deleted };
    const merged = remote ? mergePlaygrounds(local, remote) : local;
    const before = new Map(playgrounds.map((p) => [p.id, p]));
    const next = merged.playgrounds.map((p) => normalise(p)).filter((p): p is Playground => Boolean(p)).map(rebind);
    const writes: Promise<unknown>[] = [];
    for (const p of next) if (JSON.stringify(before.get(p.id)) !== JSON.stringify(p)) writes.push(db.setKv(KEY(p.id), p));
    for (const id of before.keys()) if (!next.some((p) => p.id === id)) writes.push(db.deleteKv(KEY(id)));
    const changedHere = writes.length > 0;
    playgrounds = next;
    deleted = merged.deleted;
    writes.push(db.setKv(DELETED_KEY, deleted));
    const result: PlaygroundSet = { playgrounds, deleted };
    if (!remote || !remote.copiesAgree || serialisePlaygrounds(remote) !== serialisePlaygrounds(result)) await writePlaygroundsToDrive(config.clientId, config.folderName, result, config.account);
    where = 'drive';
    lastSync = Date.now();
    emit();
    await Promise.allSettled(writes);
    // What Drive brought, the other windows of this browser take from its database.
    if (changedHere) announce();
  })()
    .catch(() => {
      where = 'error';
      emit();
    })
    .finally(() => {
      syncing = null;
      if (syncAgain) {
        syncAgain = false;
        scheduleSync();
      }
    });
  return syncing;
}

// ------------------------------------------------- the notebook's cells --

// A playground's notebook, as text, goes into its record (and so to Drive) a moment after it changes.
const cellsWaiting = new Map<string, Playground['cells']>();
let cellsTimer: ReturnType<typeof setTimeout> | undefined;
subscribeNotebook(() => {
  for (const p of playgrounds) {
    const nb = notebookFor(notebookKey(p.id));
    if (!nb) continue;
    const cells = nb.cells.map((cell) => ({ type: cell.type, source: cell.source }));
    if (JSON.stringify(cells) !== JSON.stringify(p.cells)) cellsWaiting.set(p.id, cells);
  }
  if (!cellsWaiting.size) return;
  if (cellsTimer) clearTimeout(cellsTimer);
  cellsTimer = setTimeout(() => {
    for (const [id, cells] of cellsWaiting) {
      const current = playgroundById(id);
      if (current) put({ ...current, cells, updated: Date.now() });
    }
    cellsWaiting.clear();
  }, 2000);
});

export function updatePlayground(id: string, patch: Partial<Playground> | ((p: Playground) => Partial<Playground>)) {
  const current = playgroundById(id);
  if (!current) return;
  put(rebind({ ...current, ...(typeof patch === 'function' ? patch(current) : patch), updated: Date.now() }));
}

/** A playground kept in this browser, from before records said which browser: labelled now, so the others can say where its files are. */
export function labelBrowserHome(id: string) {
  const p = playgroundById(id);
  if (p && p.home.kind === 'browser' && !p.home.browser) put({ ...p, home: { kind: 'browser', browser: browserLabel() } });
}

export interface NewPlayground {
  title: string;
  kind: Playground['kind'];
  compute: Compute;
  home: FilesHome;
  start: Playground['start'];
  cites?: Cite[];
  /** The notebook's first cells. */
  cells?: NbCell[];
  /** Files to start the folder with, by path. */
  files?: Record<string, string>;
  pending?: string;
  idleStopMin?: number;
}

/** Notebook cells waiting for a playground's notebook to be opened the first time: its seed. */
const seeds = new Map<string, NbCell[]>();
export const takeSeed = (id: string): NbCell[] | undefined => {
  const seeded = seeds.get(id);
  if (seeded) return seeded;
  // Opened in a browser that hasn't had it before: the cells its record carries (from Drive).
  const kept = playgroundById(id)?.cells;
  return kept?.length ? kept.map((cell) => newCell(cell.type, cell.source)) : undefined;
};

/** A new project's home as it is kept: a server's folder named, Drive's folder named, and never the browser — Drive when it is connected, else the machine. */
function newHome(home: FilesHome, title: string, id: string): FilesHome {
  if (home.kind === 'server') return { ...home, root: home.root || `playgrounds/${slugOf(title)}`, deviceId: home.deviceId ?? serverById(home.serverId)?.companionId };
  if (home.kind === 'drive') return { kind: 'drive', folder: home.folder || driveFolderName(title, id) };
  if (home.kind === 'machine') return home;
  return drive ? { kind: 'drive', folder: driveFolderName(title, id) } : { kind: 'machine' };
}

export async function createPlayground(spec: NewPlayground): Promise<Playground> {
  await loadPlaygrounds();
  const now = Date.now();
  const id = uid();
  const made: Playground = rebind(normalise({
    id,
    title: spec.title,
    kind: spec.kind,
    created: now,
    updated: now,
    compute: spec.compute.kind === 'server' ? { ...spec.compute, deviceId: spec.compute.deviceId ?? serverById(spec.compute.serverId)?.companionId } : spec.compute,
    home: newHome(spec.home, spec.title, id),
    cites: spec.cites ?? [],
    console: [],
    pending: spec.pending,
    start: spec.start,
    idleStopMin: spec.idleStopMin,
  })!);
  if (spec.cells?.length) seeds.set(made.id, spec.cells);
  put(made);
  if (spec.files && Object.keys(spec.files).length) {
    const home = homeHost(made);
    for (const [path, text] of Object.entries(spec.files)) await home.write(path, text).catch(() => undefined);
  }
  return made;
}

/** A project's folder as a vscode:// link, when its files are on a Companion that said where its folder is. */
export function vscodeLink(playground: Playground): string | null {
  if (playground.home.kind !== 'server') return null;
  const server = serverById(playground.home.serverId);
  if (!server?.root) return null;
  const full = `${server.root.replace(/\\/g, '/').replace(/\/+$/, '')}/${playground.home.root}`;
  // /Users/me/Reader/… on macOS and Linux, /C:/Users/me/Reader/… on Windows; each part escaped, the drive's colon kept.
  const path = full.startsWith('/') ? full : `/${full}`;
  return `vscode://file${path.split('/').map((part) => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/')}`;
}

/**
 * `.reader/playground.json` in a project's folder: which playground it is and
 * where it lives on the web, so an editor (the Reader extension for VS Code)
 * can tie the folder back to its page. Written when the folder is made and
 * again when the project opens; nothing reads it back here.
 */
export async function markFolder(playground: Playground, site: string): Promise<void> {
  if (playground.home.kind !== 'server') return;
  const marker = {
    id: playground.id,
    title: playground.title,
    page: `${site.replace(/\/?$/, '/')}playground/${playground.id}`,
    cites: playground.cites.map((cite) => ({ paperId: cite.paperId, title: cite.title, page: `${site.replace(/\/?$/, '/')}paper/${encodeURIComponent(cite.paperId)}` })),
  };
  await homeHost(playground).write('.reader/playground.json', `${JSON.stringify(marker, null, 2)}\n`);
}

export async function deletePlayground(id: string) {
  playgrounds = playgrounds.filter((p) => p.id !== id);
  deleted = { ...deleted, [id]: Date.now() };
  const tombstone = db.setKv(DELETED_KEY, deleted).catch(() => undefined);
  emit();
  scheduleSync();
  await Promise.all([tombstone, db.deleteKv(KEY(id)), db.deleteKv(FILES_KEY(id)), db.deleteKv(`notebook:${notebookKey(id)}`), db.deleteKv(`notebook-ask:${notebookKey(id)}`)]).catch(() => undefined);
  announce();
}

// --------------------------------------------------------- first cells ----

export function blankCells(title: string): NbCell[] {
  return [newCell('markdown', `# ${title}\n\n*A playground of your own in Reader. Its cells run on the machine named in the bar; what they print is kept under them.*`), newCell('code', '')];
}

export function paperCells(title: string, paper: Cite & { abstract?: string; authors?: string[] }): NbCell[] {
  const byline = paper.authors?.length ? ` — ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}` : '';
  return [newCell('markdown', `# ${title}\n\n*Trying out* **${paper.title}**${byline}.${paper.abstract ? `\n\n> ${paper.abstract.replace(/\s+/g, ' ').slice(0, 900)}` : ''}`)];
}

/**
 * A project's first files when it starts from a paper: the paper in the README, a briefing the terminal agents read
 * on their own (AGENTS.md for Codex, CLAUDE.md for Claude Code), and an entry point that checks the machine.
 */
export function paperFiles(title: string, paper: Cite & { abstract?: string; authors?: string[]; published?: string; arxivId?: string; doi?: string }): Record<string, string> {
  const authors = paper.authors?.length ? `${paper.authors.slice(0, 6).join(', ')}${paper.authors.length > 6 ? ' et al.' : ''}` : '';
  const link = paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : paper.doi ? `https://doi.org/${paper.doi}` : '';
  const year = paper.published ? paper.published.slice(0, 4) : '';
  const abstract = paper.abstract?.replace(/\s+/g, ' ').trim();
  const cite = [`**${paper.title}**`, authors, year].filter(Boolean).join(' — ') + (link ? `\n${link}` : '');
  return {
    'README.md': `# ${title}\n\nAn implementation of\n\n${cite}\n${abstract ? `\n## Abstract\n\n> ${abstract}\n` : ''}\n## Layout\n\n- \`main.py\` — the entry point: checks the machine, then runs the experiment.\n- \`AGENTS.md\` — what a coding agent is told about this project.\n\nAsk the agent on the right to write the method, a training loop and an evaluation; run them from the console below.\n`,
    'AGENTS.md': `# ${title}\n\nThis project reproduces the method of the paper ${cite.replace(/\n/, ' — ')}.\n${abstract ? `\nAbstract:\n\n> ${abstract}\n` : ''}\nWhen asked to implement it: write the method as a small, faithful implementation in its own module, a seeded\nexperiment sized for the machine it runs on (use the GPU when torch.cuda.is_available(), else a smaller size on the\nCPU), and an evaluation that prints the paper's headline metric. Cite the paper's equation numbers in comments, say\nin the README where a detail the paper leaves out was chosen, and keep \`python main.py\` as the way to run it.\n`,
    'CLAUDE.md': '@AGENTS.md\n',
    'main.py': `"""${paper.title.replace(/"""/g, "'''")}: the entry point."""\n\nimport torch\n\n\ndef main():\n    device = "cuda" if torch.cuda.is_available() else "cpu"\n    print("torch", torch.__version__, "· device", device)\n    torch.manual_seed(0)\n    # TODO: the method, a training loop and an evaluation — ask the agent, or see AGENTS.md\n\n\nif __name__ == "__main__":\n    main()\n`,
  };
}

/** A Hugging Face model id, as typed or pasted from its page. */
export function modelIdOf(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\/(www\.)?huggingface\.co\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  const id = parts.slice(0, parts[0] === 'datasets' ? 3 : 2).join('/');
  return /^(datasets\/)?[\w.-]+\/[\w.-]+$/.test(id) ? id : null;
}

export function modelCells(id: string): NbCell[] {
  if (id.startsWith('datasets/')) {
    const name = id.slice('datasets/'.length);
    return [
      newCell('markdown', `# ${name}\n\nThe dataset from [huggingface.co/${id}](https://huggingface.co/${id}): loaded, and a look at the first rows.`),
      newCell('code', '%pip install -q datasets'),
      newCell('code', `from datasets import load_dataset\n\nds = load_dataset("${name}")\nprint(ds)\nsplit = next(iter(ds.values()))\nfor row in split.select(range(min(3, len(split)))):\n    print(row)`),
    ];
  }
  return [
    newCell('markdown', `# ${id}\n\nThe model from [huggingface.co/${id}](https://huggingface.co/${id}), loaded with \`transformers\` on the GPU when there is one, and run once.`),
    newCell('code', '%pip install -q transformers accelerate'),
    newCell('code', `import torch\nfrom transformers import pipeline\n\ndevice = 0 if torch.cuda.is_available() else -1\nprint("on", torch.cuda.get_device_name(0) if device == 0 else "the CPU")\npipe = pipeline(model="${id}", device=device)\nprint(pipe.task)`),
    newCell('code', `out = pipe("Hello, world.")\nprint(out)`),
  ];
}

/** A GitHub (or any git) repository's address, as pasted. */
export function repoUrlOf(input: string): string | null {
  const trimmed = input.trim();
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (short) return `https://github.com/${short[1]}/${short[2].replace(/\.git$/, '')}.git`;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'github.com' && parts.length >= 2) return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}.git`;
    return url.href;
  } catch {
    return null;
  }
}

export const repoNameOf = (url: string) => url.replace(/\.git$/, '').split('/').filter(Boolean).pop() ?? 'repository';

// ------------------------------------------------------------ the files ----

/** A place files are kept or run: list a folder, read a file, write one. Paths are relative to its root. */
export interface FileHost {
  label: string;
  list(path?: string): Promise<RuntimeEntry[]>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** A file or folder deleted (a folder with what is in it), where the host can. */
  remove?(path: string): Promise<void>;
  /** A file or folder renamed or moved, where the host can. */
  rename?(from: string, to: string): Promise<void>;
  /** An empty folder made, where the host can. */
  mkdir?(path: string): Promise<void>;
}

const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');

/** Whether this browser holds the files of a playground kept in a browser: false for one made in another browser. */
export async function filesHere(id: string): Promise<boolean> {
  return Boolean(await db.getKv<Record<string, string>>(FILES_KEY(id)).catch(() => undefined));
}

/**
 * Where a playground's code is, where it last ran, and what this browser
 * needs to open it. The code stays where it was made — a folder on one
 * computer, or the browser it was made in — while the list reaches every
 * browser through Drive, so a project needs that one place to open: its code
 * isn't anywhere else. Where it runs can be any machine of yours: the
 * computer with the code itself, or another with the folder copied there
 * before each run. A notebook's cells travel with the list, so it opens
 * anywhere. Computers are named from this browser's list, else by the name
 * the record carries from the browser that knew them.
 */
export interface Reach {
  /** Where its code is. */
  code: string;
  /** Where it last ran, and whether it must run there. */
  ran: string;
  /** What opening it takes: a specific computer or browser, or nothing. */
  needs: string;
  /** Why this browser can't open it, and what to do. */
  blocked?: string;
  /** It opens, but the computer with its code isn't answering now. */
  warn?: string;
}

export function reachOf(
  p: Pick<Playground, 'kind' | 'home' | 'compute'>,
  ctx: { serverName: (id: string) => string | undefined; down: (id: string) => boolean; browserHasFiles: boolean },
): Reach {
  const { home, compute } = p;
  const nameOf = (ref: { serverId: string; name?: string }) => ctx.serverName(ref.serverId) ?? ref.name;
  const homeName = home.kind === 'server' ? nameOf(home) : undefined;
  const computeName = compute.kind === 'colab' ? 'your Colab' : nameOf(compute) ?? 'a computer of yours';
  const sameMachine = home.kind === 'server' && compute.kind === 'server' && (compute.serverId === home.serverId || Boolean(compute.deviceId && compute.deviceId === home.deviceId));
  const anyMachine = 'any machine of yours can run it, with the folder copied there';
  if (p.kind === 'notebook' && home.kind === 'browser') {
    return { code: 'the notebook’s cells, in your Drive with this list', ran: `${computeName} — any machine of yours can run it`, needs: 'Nothing: it opens in any browser signed in to your Drive' };
  }
  if (home.kind === 'drive') {
    return { code: `your Google Drive · Papers_collection/Playgrounds/${home.folder}`, ran: `${computeName} — ${anyMachine}`, needs: 'Nothing but your Google account: it opens in any browser signed in with Drive' };
  }
  if (home.kind === 'machine') {
    return compute.kind === 'colab'
      ? { code: 'the Colab runtime’s disk', ran: computeName, needs: 'Your Colab', warn: 'Its files are on the Colab runtime’s disk: they go when the runtime ends. Move them to Drive from the project to keep them.' }
      : { code: `${computeName} · its own disk`, ran: computeName, needs: `${computeName} specifically: its code is there`, blocked: ctx.serverName(compute.serverId) ? undefined : `Its code is on ${computeName}, which isn’t connected to this browser.` };
  }
  if (home.kind === 'browser') {
    const there = home.browser ?? 'the browser it was made in';
    const here = ctx.browserHasFiles;
    return {
      code: here ? `this browser${home.browser ? ` (${home.browser})` : ''}` : there,
      ran: `${computeName} — ${anyMachine}`,
      needs: here ? 'This browser: its files are kept here' : `${there}: its files are kept there, and nowhere else`,
      blocked: here ? undefined : `Its files are kept in ${there}, not in this one, so its code isn’t here to open. Open it in ${there}; any machine can run it from there.`,
    };
  }
  const computer = homeName ?? 'a computer this browser has never been connected to';
  return {
    code: `${computer} · ${home.root}`,
    ran: sameMachine ? `${computeName}, where its code is — or ${anyMachine}` : `${computeName}, with the folder copied there — or any other machine of yours`,
    needs: `${homeName ?? 'That computer'} specifically: its code is there, and nowhere else`,
    blocked: ctx.serverName(home.serverId)
      ? undefined
      : `Its code is on ${computer}, which isn’t connected to this browser. Connect ${homeName ?? 'it'} here (Your compute → + Add a server, with the Reader app open on it), or sign in with the Google account it is under — or open the project on ${homeName ?? 'that computer'} itself. Once its code is reachable, any machine can run it.`,
    warn: ctx.serverName(home.serverId) && ctx.down(home.serverId) ? `${homeName} isn’t answering now: its code opens once its Companion is started (the project’s machine menu can start it).` : undefined,
  };
}

/** Files kept in this browser, by path, for a playground with no folder on a server. */
function browserHost(id: string): FileHost {
  const all = async () => (await db.getKv<Record<string, string>>(FILES_KEY(id)).catch(() => undefined)) ?? {};
  return {
    label: 'this browser',
    async list(path = '') {
      const files = await all();
      const prefix = path ? `${path.replace(/\/+$/, '')}/` : '';
      const seen = new Map<string, RuntimeEntry>();
      for (const [name, text] of Object.entries(files)) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        const [head, ...more] = rest.split('/');
        if (more.length) seen.set(head, { name: head, path: prefix + head, type: 'directory', size: null, modified: null });
        else seen.set(head, { name: head, path: name, type: 'file', size: text.length, modified: null });
      }
      return sortEntries([...seen.values()]);
    },
    async read(path) {
      return (await all())[path] ?? null;
    },
    async write(path, text) {
      const files = await all();
      files[path] = text;
      await db.setKv(FILES_KEY(id), files);
    },
  };
}

const sortEntries = (entries: RuntimeEntry[]) => entries.sort((a, b) => ((a.type === 'directory') === (b.type === 'directory') ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));

/** A folder on a Jupyter server, through its contents API. */
export function serverHost(server: JupyterServer, root: string): FileHost {
  const under = (path: string) => joinPath(root, path);
  const strip = (path: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path === root ? '' : path);
  return {
    label: server.name,
    async list(path = '') {
      try {
        const listing = await jupyterList(server, under(path));
        return sortEntries(listing.entries.map((entry) => ({ ...entry, path: strip(entry.path) })));
      } catch (error) {
        // A folder not made yet is an empty one.
        if (error instanceof JupyterRequestError && error.status === 404) return [];
        throw error;
      }
    },
    async read(path) {
      return (await jupyterRead(server, under(path)))?.text ?? null;
    },
    async write(path, text) {
      await jupyterWrite(server, under(path), text);
    },
    async remove(path) {
      await jupyterDelete(server, under(path));
    },
    async rename(from, to) {
      await jupyterRename(server, under(from), under(to));
    },
    async mkdir(path) {
      const parts = under(path).split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        try {
          await jupyterFetch(server, `api/contents/${parts.slice(0, i).map(encodeURIComponent).join('/')}`, { method: 'PUT', body: { type: 'directory' } });
        } catch (error) {
          if (!(error instanceof JupyterRequestError) || error.status === 0 || error.status === 401 || error.status === 403) throw error;
        }
      }
    },
  };
}

const py = (value: string) => JSON.stringify(value);

/** Bytes as base64, a slice at a time: spreading a whole file into fromCharCode overflows the stack past a hundred KB or so. */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * A folder on the Colab runtime (or any kernel the page is connected to),
 * through a few lines of Python in the page's small second kernel — Colab's
 * runtime takes no file writes from another site. Text files only, and only
 * while a runtime is connected.
 */
export function kernelHost(label: string, root: string): FileHost {
  const run = async (code: string) => {
    const answer = await runQuietly(code);
    if (!answer) throw new Error('No runtime is connected: run a cell, or connect from the bar, first.');
    if (!answer.ok) throw new Error(answer.text || 'The runtime could not do that.');
    return answer.text;
  };
  return {
    label,
    async list(path = '') {
      const text = await run(
        `import os, json\nd = os.path.join(${py(root)}, ${py(path)})\nout = []\nif os.path.isdir(d):\n    for n in sorted(os.listdir(d)):\n        p = os.path.join(d, n)\n        out.append([n, os.path.isdir(p), None if os.path.isdir(p) else os.path.getsize(p)])\nprint(json.dumps(out))`,
      );
      const rows = JSON.parse(text.trim().split('\n').pop() || '[]') as [string, boolean, number | null][];
      return sortEntries(rows.map(([name, dir, size]) => ({ name, path: joinPath(path, name), type: dir ? 'directory' : 'file', size, modified: null })));
    },
    async read(path) {
      const text = await run(`import os, base64\np = os.path.join(${py(root)}, ${py(path)})\nprint(base64.b64encode(open(p, 'rb').read()).decode() if os.path.isfile(p) else '-')`);
      const line = text.trim().split('\n').pop() ?? '-';
      if (line === '-') return null;
      return new TextDecoder().decode(Uint8Array.from(atob(line), (c) => c.charCodeAt(0)));
    },
    async write(path, text) {
      const data = base64Of(new TextEncoder().encode(text));
      await run(`import os, base64\np = os.path.join(${py(root)}, ${py(path)})\nos.makedirs(os.path.dirname(p) or '.', exist_ok=True)\nopen(p, 'wb').write(base64.b64decode(${py(data)}))\nprint('ok')`);
    },
    async remove(path) {
      await run(`import os, shutil\np = os.path.join(${py(root)}, ${py(path)})\nshutil.rmtree(p) if os.path.isdir(p) else os.remove(p)\nprint('ok')`);
    },
    async rename(from, to) {
      await run(`import os\na = os.path.join(${py(root)}, ${py(from)})\nb = os.path.join(${py(root)}, ${py(to)})\nos.makedirs(os.path.dirname(b) or '.', exist_ok=True)\nos.rename(a, b)\nprint('ok')`);
    },
    async mkdir(path) {
      await run(`import os\nos.makedirs(os.path.join(${py(root)}, ${py(path)}), exist_ok=True)\nprint('ok')`);
    },
  };
}

/** Drive's hosts, one a folder, so the ids each has looked up are kept for the session. */
const driveHosts = new Map<string, FileHost>();

/** Where a playground's files are kept. */
export function homeHost(playground: Playground): FileHost {
  const home = playground.home;
  if (home.kind === 'server') {
    const server = serverById(home.serverId);
    if (server) return serverHost(server, home.root);
    return unreachableHost(home.name ?? 'a computer this browser isn’t connected to');
  }
  if (home.kind === 'drive') {
    let host = driveHosts.get(home.folder);
    if (!host) driveHosts.set(home.folder, (host = driveHost(() => drive, home.folder)));
    return host;
  }
  if (home.kind === 'machine') return machineHost(playground, playground.compute.kind === 'colab' ? 'Colab' : 'the machine');
  return browserHost(playground.id);
}

/** A home whose computer isn't in this browser's list: it says so, and keeps nothing anywhere else. */
function unreachableHost(name: string): FileHost {
  const fail = async (): Promise<never> => {
    throw new Error(`The files are on ${name}, which isn’t connected to this browser.`);
  };
  return { label: name, list: fail, read: fail, write: fail };
}

/** Whether the files are kept on the machine the code runs on, so nothing needs copying. */
export const filesAreOnMachine = (playground: Playground) => playground.home.kind === 'machine' || (playground.home.kind === 'server' && playground.compute.kind === 'server' && playground.home.serverId === playground.compute.serverId);

/** Where the files are kept, in a few words, for the explorer and the status bar. */
export function homeLabelOf(playground: Playground, machineName: string): string {
  const home = playground.home;
  if (home.kind === 'drive') return 'Google Drive';
  if (home.kind === 'machine') return machineName;
  if (home.kind === 'server') return `${serverById(home.serverId)?.name ?? home.name ?? 'a server'} · ${home.root}`;
  return 'this browser (to move)';
}

/**
 * A project made before files left the browser: its files copied to the new
 * home — Drive, a computer's folder, the machine — and then taken out of this
 * browser. Nothing is removed until every file is written there.
 */
export async function moveFilesOutOfBrowser(id: string, to: FilesHome): Promise<number> {
  const p = playgroundById(id);
  if (!p || p.home.kind !== 'browser') return 0;
  const files = (await db.getKv<Record<string, string>>(FILES_KEY(id)).catch(() => undefined)) ?? {};
  const home = newHome(to, p.title, id);
  const next: Playground = { ...p, home, updated: Date.now() };
  const host = homeHost(next);
  for (const [path, text] of Object.entries(files)) await host.write(path, text);
  put(rebind(next));
  await db.deleteKv(FILES_KEY(id)).catch(() => undefined);
  return Object.keys(files).length;
}

/** The folder on the machine the code runs in, relative to where its kernel starts. */
export const machineRoot = (playground: Playground) => (playground.home.kind === 'server' && filesAreOnMachine(playground) ? playground.home.root : `playgrounds/${slugOf(playground.title)}-${playground.id}`);

/** The folder on the machine, as its files can be listed and written there. */
export function machineHost(playground: Playground, label: string): FileHost {
  if (playground.compute.kind === 'server') {
    const server = serverById(playground.compute.serverId);
    if (server) return serverHost(server, machineRoot(playground));
  }
  return kernelHost(label, machineRoot(playground));
}

// ------------------------------------------------------- the sync rules ----

/** Whether a path matches one gitignore-like line: `dir/` a folder anywhere, `*` within a name, `**` across folders, a leading `/` from the root. */
export function matchesRule(rule: string, path: string): boolean {
  const line = rule.trim();
  if (!line || line.startsWith('#')) return false;
  const anchored = line.startsWith('/');
  const dir = line.endsWith('/');
  const body = line.replace(/^\/+/, '').replace(/\/+$/, '');
  const pattern = body
    .split('/')
    .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')))
    .join('/')
    .replace(/\.\*\//g, '(?:.*/)?');
  const lead = anchored || body.includes('/') ? '^' : '^(?:.*/)?';
  const tail = dir ? '(?:/.*)?$' : '(?:/.*)?$';
  return new RegExp(`${lead}${pattern}${tail}`).test(path);
}

export const matchesAny = (rules: string, path: string) => rules.split('\n').some((rule) => matchesRule(rule, path));

/** Every file under `path` on a host, walked a few folders deep, skipping what `skip` says. */
export async function walk(host: FileHost, skip: (path: string, dir: boolean) => boolean, path = '', depth = 0, limit = 400): Promise<RuntimeEntry[]> {
  if (depth > 6) return [];
  const out: RuntimeEntry[] = [];
  for (const entry of await host.list(path)) {
    if (out.length >= limit) break;
    if (skip(entry.path, entry.type === 'directory')) continue;
    if (entry.type === 'directory') out.push(...(await walk(host, skip, entry.path, depth + 1, limit - out.length)));
    else out.push(entry);
  }
  return out;
}

/** Bigger than this, a file is left where it is: the page carries text, not checkpoints. */
export const SYNC_LIMIT = 2_000_000;

export interface SyncReport {
  sent: string[];
  skipped: string[];
  back: string[];
}

/**
 * The folder onto the machine: every file the ignore rules let through, as
 * it is at home. Text only, and nothing over SYNC_LIMIT — data and weights
 * belong on the machine, fetched there.
 */
export async function pushFolder(playground: Playground, machine: FileHost): Promise<SyncReport> {
  const home = homeHost(playground);
  const files = await walk(home, (path) => matchesAny(playground.sync.ignore, path));
  const report: SyncReport = { sent: [], skipped: [], back: [] };
  for (const file of files) {
    if (file.size !== null && file.size > SYNC_LIMIT) {
      report.skipped.push(file.path);
      continue;
    }
    const text = await home.read(file.path);
    if (text === null) continue;
    await machine.write(file.path, text);
    report.sent.push(file.path);
  }
  return report;
}

/** What a run wrote under the folders named to bring back, home from the machine — text files under SYNC_LIMIT. */
export async function pullBack(playground: Playground, machine: FileHost): Promise<SyncReport> {
  const home = homeHost(playground);
  const report: SyncReport = { sent: [], skipped: [], back: [] };
  const files = await walk(machine, (path, dir) => matchesAny(playground.sync.ignore, path) && !matchesAny(playground.sync.bringBack, path) && dir);
  for (const file of files) {
    if (!matchesAny(playground.sync.bringBack, file.path)) continue;
    if (file.size !== null && file.size > SYNC_LIMIT) {
      report.skipped.push(file.path);
      continue;
    }
    const text = await machine.read(file.path).catch(() => null);
    if (text === null) continue;
    const there = await home.read(file.path).catch(() => null);
    if (there === text) continue;
    await home.write(file.path, text);
    report.back.push(file.path);
  }
  return report;
}

/**
 * What an agent on the machine changed, home: every text file the ignore rules
 * let through that differs from the one kept at home (new ones too). Run after
 * Claude Code or Codex worked on the machine's copy of a folder kept in Drive
 * or on another computer — the bring-back rules are for a run's results, this
 * is for the code itself.
 */
export async function pullEdits(playground: Playground, machine: FileHost): Promise<SyncReport> {
  const home = homeHost(playground);
  const report: SyncReport = { sent: [], skipped: [], back: [] };
  const files = await walk(machine, (path) => matchesAny(playground.sync.ignore, path));
  for (const file of files) {
    if (file.size !== null && file.size > SYNC_LIMIT) {
      report.skipped.push(file.path);
      continue;
    }
    const text = await machine.read(file.path).catch(() => null);
    if (text === null) continue;
    const there = await home.read(file.path).catch(() => null);
    if (there === text) continue;
    await home.write(file.path, text);
    report.back.push(file.path);
  }
  return report;
}

/**
 * The project's own notes about itself — the agents' conversations, the
 * folder's marker — kept in .reader/ inside its folder. A plain Jupyter server
 * refuses hidden paths (its ContentsManager.allow_hidden is off; a Companion
 * turns it on), so there they go to a visible reader-meta/ instead; reading
 * looks in both.
 */
export async function writeMeta(host: FileHost, name: string, text: string): Promise<void> {
  try {
    await host.write(`.reader/${name}`, text);
  } catch {
    await host.write(`reader-meta/${name}`, text);
  }
}
export async function readMeta(host: FileHost, name: string): Promise<string | null> {
  const hidden = await host.read(`.reader/${name}`).catch(() => null);
  if (hidden !== null) return hidden;
  return host.read(`reader-meta/${name}`).catch(() => null);
}

/** The console's command as the kernel takes it: a bash cell, in the playground's folder on the machine. */
export function shellCell(root: string, command: string): string {
  const quoted = `'${root.replace(/'/g, `'\\''`)}'`;
  return `%%bash\nmkdir -p ${quoted} && cd ${quoted} || exit 1\n${command}`;
}
