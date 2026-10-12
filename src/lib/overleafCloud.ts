// A paper kept in Drive, in step with Overleaf through Reader's server: the
// Worker (worker/latex.js) keeps the person's Overleaf Git token encrypted and
// hands the sync to the compiler on Cloud Run (cloudrun/latex/server.py), which
// clones the project, merges, pushes, and answers what changed. Nothing is
// kept on this computer, nor by the server between syncs.
//
// The paper's Drive folder holds .reader-sync.json: the Overleaf commit last
// synced and each file's fingerprint then (the SHA-256 of its base64). A sync
// sends the files that changed since and the ones gone; Overleaf's changes come
// back, and where both sides changed the same lines the files come back with
// <<<<<<< marks, nothing pushed, and the next sync goes on from Overleaf's.

import { apiFetch } from './api';
import type { Synced } from './companion';
import { isBuildFile } from './overleaf';
import type { PaperStore } from './paperStore';

export const SYNC_STATE = '.reader-sync.json';

interface SyncState {
  commit: string;
  files: Record<string, string>;
  /** A paper moved in from a computer, not yet synced from here: its files' Git ids then, to find their commit by. */
  blobs?: Record<string, string>;
  /** A folder that was never synced with Overleaf: all of it goes, the first time. */
  pushAll?: boolean;
}

/** A file's Git id: SHA-1 of "blob <size>\0" and its bytes, as Git names it. */
async function gitBlob(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const digest = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A paper just moved into Drive from a computer, recorded as such: its files
 * as they were then, and either their Git ids (a clone, synced with Overleaf
 * before the move: the first sync from here finds that commit and goes on from
 * it) or that all of it is to be sent (a folder never synced with Overleaf).
 */
export async function recordMove(store: PaperStore, files: { path: string; base64: string }[], how: 'synced' | 'unsynced'): Promise<void> {
  const state: SyncState = { commit: '', files: {} };
  if (how === 'synced') state.blobs = {};
  else state.pushAll = true;
  for (const file of files) {
    state.files[file.path] = await fingerprint(file.base64);
    if (state.blobs) state.blobs[file.path] = await gitBlob(file.base64);
  }
  await store.writeText(SYNC_STATE, JSON.stringify(state));
}

const fingerprint = async (base64: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** What has been read of each paper, by when it last changed: a sync reads only what changed since. */
const seen = new WeakMap<PaperStore, Map<string, { stamp: string; sha: string; base64: string }>>();

async function current(store: PaperStore): Promise<Map<string, { stamp: string; sha: string; base64: string }>> {
  const known = seen.get(store) ?? new Map();
  seen.set(store, known);
  const listed: { path: string; stamp: string }[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of await store.list(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'directory') await walk(entry.path, depth + 1);
      else if (!isBuildFile(entry.path)) listed.push({ path: entry.path, stamp: `${entry.modified ?? ''}|${entry.size ?? ''}` });
    }
  };
  await walk('', 0);
  const now = new Map<string, { stamp: string; sha: string; base64: string }>();
  for (const { path, stamp } of listed) {
    let file = known.get(path);
    if (!file || file.stamp !== stamp || !stamp.replace('|', '')) {
      const base64 = await store.readBase64(path);
      file = { stamp, sha: await fingerprint(base64), base64 };
    }
    now.set(path, file);
  }
  seen.set(store, now);
  return now;
}

async function readState(store: PaperStore): Promise<SyncState> {
  try {
    const read = await store.readText(SYNC_STATE);
    const state = read ? (JSON.parse(read.text) as SyncState) : null;
    if (state && typeof state.commit === 'string' && state.files && typeof state.files === 'object') return state;
  } catch {
    // none yet, or not readable: synced as if for the first time
  }
  return { commit: '', files: {} };
}

/** An Overleaf account connected to Reader's server, as the page sees it: never its token. */
export interface OverleafAccount {
  id: string;
  label: string;
  addedAt: string;
}

type Listeners = Set<(accounts: OverleafAccount[]) => void>;
const listeners: Listeners = new Set();
const told = (accounts: OverleafAccount[]) => {
  for (const listener of listeners) listener(accounts);
  return accounts;
};
/** Told whenever the accounts change on this page: connected, forgotten, or found by a sync. */
export const onOverleafAccounts = (listener: (accounts: OverleafAccount[]) => void) => (listeners.add(listener), () => void listeners.delete(listener));

/** The Overleaf accounts connected, for every project and every device of this Reader account. */
export async function overleafAccounts(): Promise<OverleafAccount[]> {
  const response = await apiFetch('/latex/overleaf/token', { cache: 'no-store' });
  if (!response.ok) return [];
  return told(((await response.json().catch(() => ({}))) as { accounts?: OverleafAccount[] }).accounts ?? []);
}

/** Whether any Overleaf account is connected. */
export async function overleafTokenKnown(): Promise<boolean> {
  return (await overleafAccounts()).length > 0;
}

/**
 * An Overleaf account connected: its Git token given to the Worker, kept sealed there; the account's id back.
 * `project`, the Git address of one of the account's projects, is opened with the token first: a token
 * from another account can't open it, and is refused rather than kept.
 */
export async function connectOverleaf(token: string, label = '', project?: string): Promise<string> {
  const response = await apiFetch('/latex/overleaf/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, label, ...(project ? { url: project } : {}) }) });
  const body = (await response.json().catch(() => ({}))) as { error?: string; account?: string; accounts?: OverleafAccount[] };
  if (!response.ok || !body.account) throw new Error(body.error ?? `Reader’s server answered ${response.status}.`);
  told(body.accounts ?? []);
  return body.account;
}

/** One Overleaf account forgotten by the Worker, or all of them. */
export async function forgetOverleafToken(account?: string): Promise<void> {
  const response = await apiFetch(`/latex/overleaf/token${account ? `?account=${encodeURIComponent(account)}` : ''}`, { method: 'DELETE' });
  told((((await response.json().catch(() => ({}))) as { accounts?: OverleafAccount[] }).accounts) ?? []);
}

interface Answer {
  ok?: boolean;
  commit?: string;
  committed?: boolean;
  pushed?: boolean;
  files?: { path: string; base64: string }[];
  deleted?: string[];
  conflicts?: string[];
  error?: string;
  needToken?: boolean;
  /** Each file's fingerprint at `commit`: what the next sync compares Drive against. */
  tree?: Record<string, string>;
  /** The Overleaf account that opened the project. */
  account?: string;
  accountLabel?: string;
  /** The account asked for couldn't open the project (unshared, or its token revoked): `account` did. */
  fellBackFrom?: string;
}

/**
 * The paper in Drive and the Overleaf project at `url`, in step: what changed
 * here goes there, what changed there comes here. `token` is an Overleaf Git
 * token, given once; the Worker keeps it as one of the person's accounts.
 * `account` is the account the project was last synced with, tried first;
 * the one that opened it comes back.
 */
export async function cloudSync(store: PaperStore, url: string, message: string, token?: string, options: { firstPushes?: boolean; account?: string } = {}): Promise<Synced & { needToken?: boolean; account?: string; accountLabel?: string; fellBackFrom?: string }> {
  const state = await readState(store);
  const files = await current(store);
  const manifest = Object.fromEntries([...files].map(([path, file]) => [path, file.sha]));
  // Never synced: nothing here is a change to send — Overleaf's files come in over it (a paper brought into Drive
  // from Overleaf) — unless `firstPushes`: then what is here goes to Overleaf, on top of what it has (a folder
  // that was never synced with it, moved into Drive).
  const pushAll = options.firstPushes || (!state.commit && state.pushAll);
  // Moved in from a computer and not synced from here yet: what changed since the move.
  const sinceMove = !state.commit && Boolean(state.blobs);
  const changed = state.commit || pushAll || sinceMove ? [...files].filter(([path, file]) => pushAll || state.files[path] !== file.sha).map(([path, file]) => ({ path, base64: file.base64 })) : [];
  const deleted = state.commit || sinceMove ? Object.keys(state.files).filter((path) => !files.has(path)) : [];
  const response = await apiFetch('/latex/overleaf/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, base: state.commit, ...(!state.commit && state.blobs ? { baseTree: state.blobs } : {}), changed, deleted, manifest, message, ...(token ? { token } : {}), ...(options.account ? { account: options.account } : {}) }),
  });
  const answer = (await response.json().catch(() => ({}))) as Answer;
  // A token given now, or the accounts tried: the page's list brought up to date.
  if (token || answer.needToken) void overleafAccounts().catch(() => undefined);
  if (!response.ok || !answer.commit) {
    return { ok: false, committed: false, pushed: false, conflicts: [], error: answer.error ?? `Reader’s server answered ${response.status}.`, needToken: answer.needToken };
  }
  // What Overleaf has that this paper hadn't: written into Drive.
  const incoming: string[] = [];
  const next = { ...manifest };
  for (const file of answer.files ?? []) {
    await store.writeBase64(file.path, file.base64);
    next[file.path] = await fingerprint(file.base64);
    incoming.push(file.path);
  }
  for (const path of answer.deleted ?? []) {
    await store.remove(path).catch(() => undefined);
    delete next[path];
    incoming.push(path);
  }
  seen.delete(store);
  // The next sync goes on from the commit answered — Overleaf's own when the same lines changed, so all
  // that differs here from it (the merge, the marks being fixed) goes the next time.
  await store.writeText(SYNC_STATE, JSON.stringify({ commit: answer.commit, files: answer.tree ?? next } satisfies SyncState));
  const conflicts = answer.conflicts ?? [];
  return {
    ok: !conflicts.length && answer.ok !== false,
    committed: Boolean(answer.committed),
    pushed: Boolean(answer.pushed),
    incoming,
    conflicts,
    at: Date.now(),
    ...(answer.account ? { account: answer.account, accountLabel: answer.accountLabel } : {}),
    ...(answer.fellBackFrom ? { fellBackFrom: answer.fellBackFrom } : {}),
    ...(conflicts.length ? { error: 'Overleaf changed the same lines: the files are marked with <<<<<<< where they differ. Fix them, and the next sync carries on.' } : answer.error ? { error: answer.error } : {}),
  };
}
