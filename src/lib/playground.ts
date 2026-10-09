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
// Kept in IndexedDB: each playground under `playground:<id>`, the files of
// one that lives in this browser under `playground-files:<id>`. The servers
// — addresses and tokens of Jupyter servers the person runs — stay in this
// browser's localStorage and go nowhere else.

import { useSyncExternalStore } from 'react';
import { db } from './db';
import type { JupyterServer, Machine, RuntimeEntry } from './colab';
import { JupyterRequestError, jupyterList, jupyterRead, jupyterWrite, runQuietly } from './colab';
import type { NbCell } from './notebook';
import { newCell } from './notebook';
import type { CompanionPairing } from './companion';
import { secureAddress } from './companion';
import { currentAccount, onProxyChange } from './api';

// ---------------------------------------------------------------- types ----

/** Where a playground's code runs. */
export type Compute = { kind: 'colab'; machine: Machine } | { kind: 'server'; serverId: string };

/** Where its files are kept: this browser, or a folder on a Jupyter server. */
export type FilesHome = { kind: 'browser' } | { kind: 'server'; serverId: string; root: string };

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
}

export const DEFAULT_IGNORE = ['.git/', '__pycache__/', '.ipynb_checkpoints/', 'data/', '*.ckpt', '*.pt', '*.safetensors', 'wandb/'].join('\n');
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
  loading = db
    .kvWithPrefix<Playground>('playground:')
    .then((found) => {
      playgrounds = found.map(([, value]) => normalise(value)).filter((p): p is Playground => Boolean(p));
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
export const playgroundById = (id: string | undefined) => playgrounds.find((p) => p.id === id);

/** Asks the app to open a playground — from a page that is not the Playground, like a paper's notebook. */
export const OPEN_PLAYGROUND = 'reader:open-playground';

/** The notebook's key in the notebook store: the playground's id, marked, so it is never taken for a paper's. */
export const notebookKey = (id: string) => `pg:${id}`;

function put(next: Playground) {
  playgrounds = playgrounds.some((p) => p.id === next.id) ? playgrounds.map((p) => (p.id === next.id ? next : p)) : [next, ...playgrounds];
  emit();
  void db.setKv(KEY(next.id), next).catch(() => undefined);
}

export function updatePlayground(id: string, patch: Partial<Playground> | ((p: Playground) => Partial<Playground>)) {
  const current = playgroundById(id);
  if (!current) return;
  put({ ...current, ...(typeof patch === 'function' ? patch(current) : patch), updated: Date.now() });
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
export const takeSeed = (id: string) => seeds.get(id);

export async function createPlayground(spec: NewPlayground): Promise<Playground> {
  await loadPlaygrounds();
  const now = Date.now();
  const made: Playground = normalise({
    id: uid(),
    title: spec.title,
    kind: spec.kind,
    created: now,
    updated: now,
    compute: spec.compute,
    home: spec.home.kind === 'server' && !spec.home.root ? { ...spec.home, root: `playgrounds/${slugOf(spec.title)}` } : spec.home,
    cites: spec.cites ?? [],
    console: [],
    pending: spec.pending,
    start: spec.start,
    idleStopMin: spec.idleStopMin,
  })!;
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
  emit();
  await Promise.all([db.deleteKv(KEY(id)), db.deleteKv(FILES_KEY(id)), db.deleteKv(`notebook:${notebookKey(id)}`), db.deleteKv(`notebook-ask:${notebookKey(id)}`)]).catch(() => undefined);
}

// --------------------------------------------------------- first cells ----

export function blankCells(title: string): NbCell[] {
  return [newCell('markdown', `# ${title}\n\n*A playground of your own in Reader. Its cells run on the machine named in the bar; what they print is kept under them.*`), newCell('code', '')];
}

export function paperCells(title: string, paper: Cite & { abstract?: string; authors?: string[] }): NbCell[] {
  const byline = paper.authors?.length ? ` — ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}` : '';
  return [newCell('markdown', `# ${title}\n\n*Trying out* **${paper.title}**${byline}.${paper.abstract ? `\n\n> ${paper.abstract.replace(/\s+/g, ' ').slice(0, 900)}` : ''}`)];
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
}

const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');

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
  };
}

/** Where a playground's files are kept. */
export function homeHost(playground: Playground): FileHost {
  if (playground.home.kind === 'server') {
    const server = serverById(playground.home.serverId);
    if (server) return serverHost(server, playground.home.root);
  }
  return browserHost(playground.id);
}

/** Whether the files are kept on the machine the code runs on, so nothing needs copying. */
export const filesAreOnMachine = (playground: Playground) => playground.home.kind === 'server' && playground.compute.kind === 'server' && playground.home.serverId === playground.compute.serverId;

/** The folder on the machine the code runs in, relative to where its kernel starts. */
export const machineRoot = (playground: Playground) => (filesAreOnMachine(playground) && playground.home.kind === 'server' ? playground.home.root : `playgrounds/${slugOf(playground.title)}-${playground.id}`);

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

/** The console's command as the kernel takes it: a bash cell, in the playground's folder on the machine. */
export function shellCell(root: string, command: string): string {
  const quoted = `'${root.replace(/'/g, `'\\''`)}'`;
  return `%%bash\nmkdir -p ${quoted} && cd ${quoted} || exit 1\n${command}`;
}
