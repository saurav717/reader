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

/** Whether the Worker has this person's Overleaf Git token. */
export async function overleafTokenKnown(): Promise<boolean> {
  const response = await apiFetch('/latex/overleaf/token', { cache: 'no-store' });
  if (!response.ok) return false;
  return Boolean(((await response.json().catch(() => ({}))) as { known?: boolean }).known);
}

/** The person's Overleaf Git token, forgotten by the Worker. */
export async function forgetOverleafToken(): Promise<void> {
  await apiFetch('/latex/overleaf/token', { method: 'DELETE' });
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
}

/**
 * The paper in Drive and the Overleaf project at `url`, in step: what changed
 * here goes there, what changed there comes here. `token` is the Overleaf Git
 * token, given once; the Worker keeps it.
 */
export async function cloudSync(store: PaperStore, url: string, message: string, token?: string): Promise<Synced & { needToken?: boolean }> {
  const state = await readState(store);
  const files = await current(store);
  const manifest = Object.fromEntries([...files].map(([path, file]) => [path, file.sha]));
  // Never synced: nothing here is a change to send — Overleaf's files come in over it (a paper brought into Drive from Overleaf).
  const changed = state.commit ? [...files].filter(([path, file]) => state.files[path] !== file.sha).map(([path, file]) => ({ path, base64: file.base64 })) : [];
  const deleted = state.commit ? Object.keys(state.files).filter((path) => !files.has(path)) : [];
  const response = await apiFetch('/latex/overleaf/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, base: state.commit, changed, deleted, manifest, message, ...(token ? { token } : {}) }),
  });
  const answer = (await response.json().catch(() => ({}))) as Answer;
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
    ...(conflicts.length ? { error: 'Overleaf changed the same lines: the files are marked with <<<<<<< where they differ. Fix them, and the next sync carries on.' } : answer.error ? { error: answer.error } : {}),
  };
}
