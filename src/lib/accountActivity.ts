/**
 * What runs on the account now, wherever it was started — this tab, the Koios app on a laptop, another browser — so
 * any page signed in as the account can say which projects are running, on what, and from where.
 *
 * Two sources: Colab's own list of the account's runtimes (colab.ts accountRuntimes), which says what is up; and the
 * account's rows (continuity.ts), which every browser and the app write as a project connects and runs — which
 * project is on which machine, the commands and cells running there, and from which browser. A project is running
 * when its Colab runtime is in Colab's list, or when its row has runs going (a Jupyter server's, a Companion's).
 * Read every half minute while something shows it.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { accountRuntimes } from './colab';
import type { AccountRuntime } from './colab';
import { recallAll } from './continuity';

export interface Activity {
  scope: string;
  /** "Colab · T4", or the computer's name for a Jupyter server. */
  machine: string;
  /** The machine is up (Colab's list has it), or the row has runs going. */
  live: boolean;
  /** Commands and cells running there now, by the row. */
  running: number;
  /** The browser or app that used it last ("Chrome on a Mac"). */
  by?: string;
  /** This tab is connected to it. */
  here: boolean;
  updatedAt: number;
}

interface State {
  byScope: Map<string, Activity>;
  runtimes: AccountRuntime[] | null;
  at: number;
}

let state: State = { byScope: new Map(), runtimes: null, at: 0 };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
let users = 0;
let timer = 0;
let asking: Promise<void> | null = null;

/** Rows with runs going are taken as live for this long after they were last written (a page closed mid-run). */
const ROW_FRESH_MS = 6 * 3_600_000;

export async function readActivity(): Promise<void> {
  if (asking) return asking;
  asking = (async () => {
    try {
      const [runtimes, rows] = await Promise.all([accountRuntimes().catch(() => null), recallAll(true).catch(() => [])]);
      const up = new Map((runtimes ?? []).map((runtime) => [runtime.endpoint, runtime]));
      const byScope = new Map<string, Activity>();
      for (const row of rows) {
        const runtime = up.get(row.endpoint);
        const running = Object.values(row.runs ?? {}).filter((note) => note.state === 'running').length;
        const jupyter = row.endpoint.startsWith('jupyter:');
        const live = Boolean(runtime) || (running > 0 && Date.now() - row.updatedAt < ROW_FRESH_MS && (jupyter || runtimes === null));
        if (!live) continue;
        byScope.set(row.scope, { scope: row.scope, machine: runtime?.label ?? (jupyter ? 'a computer of yours' : 'Colab'), live, running, by: row.by, here: Boolean(runtime?.here), updatedAt: row.updatedAt });
      }
      state = { byScope, runtimes, at: Date.now() };
      notify();
    } finally {
      asking = null;
    }
  })();
  return asking;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** What runs on the account now, read while a component shows it (every 30 s, and once as it mounts). */
export function useAccountActivity(): State {
  useEffect(() => {
    users++;
    if (users === 1) {
      void readActivity();
      timer = window.setInterval(() => document.visibilityState === 'visible' && void readActivity(), 30_000);
    }
    return () => {
      users--;
      if (!users) window.clearInterval(timer);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}

/** "in the Koios app on a Mac" / "in Chrome on a Mac": where it was started, as a person says it. */
export const startedIn = (by: string | undefined) => (by ? `in ${by}` : '');
