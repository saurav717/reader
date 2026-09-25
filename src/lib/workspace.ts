// The local workspace, from the page's side: the proxy on the reader's own
// machine (server/workspace.js) says what the machine is, writes the
// Implementation page's scaffold to a directory there, and runs a command
// in it with the output streamed back. Nothing here works without the
// proxy; a static deployment, or the Worker, answers "not available" and
// the page says what to run instead.

import { apiFetch, hasProxy } from './api';
import type { RepoFiles } from './github';

export interface LocalGpu {
  name: string;
  vramGb?: number;
}

export interface LocalMachine {
  host: string;
  platform: string;
  cpu: string;
  cores: number;
  ramGb: number;
  diskFreeGb?: number;
  gpus: LocalGpu[];
  python: string | null;
  torch: { version: string; cuda: boolean } | null;
}

export interface LocalProject {
  slug: string;
  dir: string;
  modified: number;
}

export type WorkspaceStatus =
  | { available: false; reason: string }
  | { available: true; root: string; machine: LocalMachine; projects: LocalProject[] };

export const NO_PROXY_WORKSPACE = 'The local workspace needs the reader’s own proxy: `npm start` on your machine with READER_WORKSPACE set to a directory, and its address in Settings → Paper proxy.';

export async function workspaceStatus(): Promise<WorkspaceStatus> {
  if (!hasProxy()) return { available: false, reason: NO_PROXY_WORKSPACE };
  try {
    const response = await apiFetch('/workspace/status', { headers: { Accept: 'application/json' } });
    const body = (await response.json()) as WorkspaceStatus & { error?: string };
    if (!response.ok) return { available: false, reason: body.error || `The proxy answered ${response.status}.` };
    return body;
  } catch {
    return { available: false, reason: 'Could not reach the proxy.' };
  }
}

export interface Written {
  dir: string;
  written: string[];
  skipped: string[];
  refused: string[];
}

/** Writes the files under the workspace, one folder for the paper; files already there with other content are skipped unless `overwrite`. */
export async function writeScaffold(slug: string, files: RepoFiles, overwrite = false): Promise<Written> {
  const response = await apiFetch('/workspace/scaffold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, files, overwrite }),
  });
  const body = (await response.json()) as Written & { error?: string };
  if (!response.ok) throw new Error(body.error || `The proxy answered ${response.status}.`);
  return body;
}

/**
 * Runs a command in the project's directory. `onText` gets the output as it
 * arrives, everything so far each time; aborting the signal stops the
 * command, since the proxy kills it when the connection closes.
 */
export async function runInWorkspace(slug: string, command: string, onText: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const response = await apiFetch('/workspace/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, command }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `The proxy answered ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The proxy sent no output.');
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    onText(text);
  }
  text += decoder.decode();
  onText(text);
}
