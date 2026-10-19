// The project's compute, linked to the computer its files are on: when the files are on a computer with the Koios
// Companion and the code runs on Colab (or a server of yours), the page hands that Companion the way to reach the
// machine — its Jupyter address and a pass, renewed while the page is open (companion/compute, from 0.17.0). Then the
// shell on that computer works on the files there, at a local shell's speed, and `koios run`, `koios shell`,
// `koios push` and `koios pull` reach the machine straight from it (companion/reader_companion/compute.py): one
// socket to a kernel of its own there, what it prints pushed back as it prints, files sent as one archive.

import type { JupyterServer, RuntimeProxy } from './colab';

/** The Companion that adds compute links. */
export const LINK_VERSION = '0.17.0';

export interface ComputeTarget {
  kind: 'colab' | 'jupyter';
  url: string;
  token: string;
  expiresAt: number;
  /** What the shell calls it: "Colab · T4". */
  label: string;
  /** The project's folder there, as the page's own runs use it. */
  folder: string;
  /** The project's ignore rules (Playground.sync.ignore): left out of every push. */
  ignore: string;
}

export interface LinkState {
  linked: boolean;
  label?: string;
  expiresAt?: number;
}

export interface PushReport {
  sent: string[];
  bytes: number;
  removed: string[];
  unchanged: number;
  big: string[];
  seconds: number;
  words: string;
}

const base = (server: JupyterServer) => server.url.replace(/\/?$/, '/');

/** Colab's runtime as a target, from the runtime proxy the page holds. */
export function colabTarget(proxy: RuntimeProxy, label: string, folder: string, ignore: string): ComputeTarget {
  return { kind: 'colab', url: proxy.url, token: proxy.token, expiresAt: proxy.expiresAt, label, folder, ignore };
}

/** A Jupyter server of the person's as a target. */
export function serverTarget(server: JupyterServer, folder: string, ignore: string): ComputeTarget {
  return { kind: 'jupyter', url: server.url, token: server.token, expiresAt: 0, label: server.name, folder, ignore };
}

/**
 * The link handed to the Companion (or forgotten, with null). Null back when the Companion is older than
 * LINK_VERSION (it has no companion/compute) or can't be reached: the page's own ways carry on then.
 */
export async function linkCompute(server: JupyterServer, root: string, target: ComputeTarget | null): Promise<LinkState | null> {
  try {
    const response = await fetch(`${base(server)}companion/compute`, {
      method: 'POST',
      headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, compute: target }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    return (await response.json()) as LinkState;
  } catch {
    return null;
  }
}

/** The changed files copied over by the Companion, as one archive: what the Copy chip and ▶ Run use while linked. */
export async function pushThroughCompanion(server: JupyterServer, root: string): Promise<PushReport> {
  const response = await fetch(`${base(server)}companion/compute`, {
    method: 'POST',
    headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, action: 'push' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const body = (await response.json().catch(() => ({}))) as PushReport & { error?: string };
  if (!response.ok) throw new Error(body.error || `the Companion answered ${response.status}`);
  return body;
}

/** When the pass should be renewed: ten minutes before it runs out, or null when it doesn't (a server's token). */
export function renewAt(target: Pick<ComputeTarget, 'kind' | 'expiresAt'>, now = Date.now()): number | null {
  if (target.kind !== 'colab' || !target.expiresAt) return null;
  return Math.max(now + 30_000, target.expiresAt - 10 * 60_000);
}

/** A line typed into a shell on the files' computer that runs `command` on the compute, there, with its output here. */
export function remoteLine(command: string): string {
  return `koios run --no-push -c '${command.replace(/'/g, `'\\''`)}'`;
}

/** What a compute tab types into its shell on the files' computer: a shell on the compute, the tab closed with it. */
export const COMPUTE_SHELL = 'koios shell; exit';
