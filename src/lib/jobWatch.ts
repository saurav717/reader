// What a playground runs outside its cells — a command in one of its
// terminals, a coding agent at work — followed from any page, so the dock,
// the shelf and the toasts count it as a run (src/lib/playgroundRuns.ts,
// reportJob).
//
// A terminal on a Jupyter server: the page keeps its own small socket to it
// (terminado takes several), open after the terminal pane closes, and reads
// what it prints. Which command runs is asked of the Companion
// (/companion/terminals: the pty's foreground process group, exact); on a
// Jupyter server without it, the screen says — a prompt at the end of it, or
// not. A shell on Colab's runtime (src/lib/kernelShell.ts) is asked the same
// of its pty, through the playground's own kernel session.

import type { JupyterServer } from './colab';
import { serverBase } from './colab';
import { b64, shellCall } from './kernelShell';
import { isAgentRunning, stopAgent, subscribeAgent } from './projectAgent';
import { serverById } from './playground';
import { clearJob, reportJob } from './playgroundRuns';

// ------------------------------------------------- reading a screen ----

/** What a terminal shows, as plain lines, and where its cursor is on the last one. */
export interface Screen {
  lines: string[];
  col: number;
}
export const emptyScreen = (): Screen => ({ lines: [''], col: 0 });
const KEPT_LINES = 200;
/** An escape sequence (CSI, OSC, or a two-character one), or a run of anything else. */
const TOKEN = /\u001b\[([0-9;?<>=!]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[()*+][A-Za-z0-9]|\u001b.|[^\u001b]+/g;

/**
 * A screen after `data`, as a terminal would draw it, but only as far as
 * the page needs: a carriage return back to the line's start (a progress bar
 * redrawn), a newline, a backspace, erase to the end of the line, clear the
 * screen; colours and other cursor moves dropped. The last couple of hundred
 * lines kept.
 */
export function appendScreen(screen: Screen, data: string): Screen {
  const lines = [...screen.lines];
  let col = screen.col;
  const put = (text: string) => {
    for (const ch of text) {
      const at = lines.length - 1;
      if (ch === '\r') col = 0;
      else if (ch === '\n') {
        lines.push('');
        col = 0;
      } else if (ch === '\b') col = Math.max(0, col - 1);
      else if (ch === '\t' || ch >= ' ') {
        const line = lines[at].padEnd(col, ' ');
        lines[at] = line.slice(0, col) + ch + line.slice(col + 1);
        col += 1;
      }
    }
  };
  for (const match of data.matchAll(TOKEN)) {
    const token = match[0];
    if (token[0] !== '\u001b') put(token);
    else if (match[2] === 'K') {
      // Erase in line: 0 (or none) from the cursor to the end, 1 to the start, 2 all of it.
      const at = lines.length - 1;
      const mode = match[1] || '0';
      if (mode === '0') lines[at] = lines[at].slice(0, col);
      else if (mode === '2') lines[at] = '';
      else lines[at] = ' '.repeat(col) + lines[at].slice(col);
    } else if (match[2] === 'J' && (match[1] === '2' || match[1] === '3')) {
      lines.length = 0;
      lines.push('');
      col = 0;
    }
  }
  return { lines: lines.length > KEPT_LINES ? lines.slice(lines.length - KEPT_LINES) : lines, col };
}

/** The last line with something on it. */
export function lastLine(screen: Screen): string {
  for (let i = screen.lines.length - 1; i >= 0; i -= 1) if (screen.lines[i].trim()) return screen.lines[i].trimEnd();
  return '';
}

/**
 * Whether a line is a shell's prompt with nothing typed after it: it ends in
 * $, #, %, >, ❯, ➜ or λ — or it is oh-my-zsh's own, the arrow first and the
 * folder (and the branch) after: "➜  reader git:(main) ✗".
 */
export const isPrompt = (line: string) => /[$#%>❯➜λ»]\s*$/.test(line) || /^(?:\(\S+\)\s+)?[➜❯λ→]\s+\S+(?:\s+git:\(\S+\))?(?:\s+[✗✔])?\s*$/.test(line);

/** The command typed at the last prompt that has one after it: "python train.py" from "you@mac proj % python train.py". */
export function commandAtPrompt(screen: Screen): string | undefined {
  for (let i = screen.lines.length - 1; i >= 0; i -= 1) {
    const match = /(?:^|\s)[$#%❯➜λ»]\s+(\S.*)$/.exec(screen.lines[i]);
    if (match) return match[1].trim().slice(0, 120);
  }
  return undefined;
}

// --------------------------------------------------------- terminals ----

interface Watched {
  key: string;
  playgroundId: string;
  kind: 'server' | 'kernel';
  /** The terminal's name on its server (terminado's), or the kernel shell's. */
  name: string;
  /** The page's own id for the shell, what typeInTerminal is keyed by. */
  sessionId?: string;
  serverId?: string;
  socket: WebSocket | null;
  tries: number;
  retry: number;
  screen: Screen;
  lastOutput: number;
  /** The command entered last — typed at the keyboard, or by the page (a Run, an agent) — when, and whether a prompt has come back since. */
  typed?: { text: string; at: number; done?: boolean };
  /** What the Companion or the kernel shell says it runs; undefined when there is no one to ask. */
  exact?: { busy: boolean; command?: string };
  since?: number;
  closed: boolean;
}

const watched = new Map<string, Watched>();
const LIST_KEY = 'reader.terminals.watched';
type Saved = Pick<Watched, 'playgroundId' | 'kind' | 'name' | 'sessionId' | 'serverId'>;

const save = () => {
  try {
    const list: Saved[] = [...watched.values()].map(({ playgroundId, kind, name, sessionId, serverId }) => ({ playgroundId, kind, name, sessionId, serverId }));
    sessionStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    // Only so a reload goes on watching.
  }
};

/** Whether the shell is running something now, and what. */
function stateOf(w: Watched): { busy: boolean; command?: string; tail: string } {
  const tail = lastLine(w.screen);
  if (w.exact) return { busy: w.exact.busy, command: w.exact.command || w.typed?.text || commandAtPrompt(w.screen), tail };
  // No one to ask: a command entered runs until the shell's prompt comes back.
  return { busy: Boolean(w.typed && !w.typed.done), command: w.typed?.text, tail };
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function report(w: Watched) {
  if (w.closed) return;
  const now = stateOf(w);
  if (now.busy && !w.since) w.since = Date.now();
  if (!now.busy) w.since = undefined;
  reportJob({
    id: `terminal:${w.name}`,
    playgroundId: w.playgroundId,
    kind: 'terminal',
    label: `terminal · ${clip(now.command ?? 'a command', 60)}`,
    busy: now.busy,
    tail: now.busy && now.tail !== now.command ? now.tail : undefined,
    since: w.since,
    stop: () => interruptTerminal(w),
  });
}

function interruptTerminal(w: Watched) {
  if (w.kind === 'server') {
    if (w.socket?.readyState === WebSocket.OPEN) w.socket.send(JSON.stringify(['stdin', '\u0003']));
  } else {
    void shellCall(`_rt_write(${JSON.stringify(w.name)}, ${JSON.stringify(b64('\u0003'))}, 0)`, w.playgroundId).catch(() => undefined);
  }
}

function openSocket(w: Watched) {
  const server = w.serverId ? serverById(w.serverId) : undefined;
  if (!server || w.closed) return;
  const url = new URL(`terminals/websocket/${encodeURIComponent(w.name)}`, serverBase(server.url));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (server.token) url.searchParams.set('token', server.token);
  let socket: WebSocket;
  try {
    socket = new WebSocket(url.href);
  } catch {
    return;
  }
  w.socket = socket;
  // terminado replays the shell's recent output to a new client: the screen starts from it.
  w.screen = emptyScreen();
  socket.onopen = () => {
    w.tries = 0;
  };
  socket.onmessage = (event) => {
    try {
      const [kind, data] = JSON.parse(String(event.data)) as [string, string];
      if (kind === 'stdout') {
        w.screen = appendScreen(w.screen, data);
        w.lastOutput = Date.now();
        // The prompt back after a command: it has ended (the echo of the command itself comes first, so not at once).
        if (w.typed && !w.typed.done && Date.now() - w.typed.at > 150 && isPrompt(lastLine(w.screen))) w.typed.done = true;
        report(w);
      } else if (kind === 'disconnect') {
        // The shell ended: nothing runs in it any more.
        unwatch(w.key);
      }
    } catch {
      // not terminado's
    }
  };
  socket.onclose = () => {
    if (w.closed || w.socket !== socket) return;
    w.socket = null;
    // A dropped socket (the machine asleep, a tunnel restarting): tried again, a growing wait apart; then let go.
    if (w.tries >= 8) return unwatch(w.key);
    w.tries += 1;
    w.retry = window.setTimeout(() => openSocket(w), Math.min(60_000, 2000 * 2 ** (w.tries - 1)));
  };
}

function unwatch(key: string) {
  const w = watched.get(key);
  if (!w) return;
  w.closed = true;
  window.clearTimeout(w.retry);
  const socket = w.socket;
  w.socket = null;
  socket?.close();
  watched.delete(key);
  clearJob(w.playgroundId, `terminal:${w.name}`);
  save();
  if (!watched.size) stopPolling();
}

/** A terminal on a Jupyter server, followed from now on — its pane open or not — until its shell ends or it is forgotten. */
export function watchTerminal(spec: { playgroundId: string; server: JupyterServer; name: string; sessionId?: string }) {
  const key = `server:${spec.server.id}:${spec.name}`;
  // The page's shell now has another terminal on the server (a new shell): the one it had is let go.
  for (const other of [...watched.values()]) if (other.key !== key && other.sessionId && other.sessionId === spec.sessionId && other.serverId === spec.server.id) unwatch(other.key);
  if (watched.has(key)) {
    const w = watched.get(key)!;
    w.sessionId = spec.sessionId ?? w.sessionId;
    return;
  }
  const w: Watched = { key, playgroundId: spec.playgroundId, kind: 'server', name: spec.name, sessionId: spec.sessionId, serverId: spec.server.id, socket: null, tries: 0, retry: 0, screen: emptyScreen(), lastOutput: 0, closed: false };
  watched.set(key, w);
  save();
  openSocket(w);
  startPolling();
}

/** A shell on a Colab runtime (KernelTerminal's), followed through the playground's own kernel session. */
export function watchKernelTerminal(spec: { playgroundId: string; name: string }) {
  const key = `kernel:${spec.playgroundId}:${spec.name}`;
  if (watched.has(key)) return;
  watched.set(key, { key, playgroundId: spec.playgroundId, kind: 'kernel', name: spec.name, sessionId: spec.name, socket: null, tries: 0, retry: 0, screen: emptyScreen(), lastOutput: 0, closed: false });
  save();
  startPolling();
}

/** A terminal let go — forgotten, or its shell closed from the page. */
export function unwatchTerminal(name: string) {
  for (const w of [...watched.values()]) if (w.name === name || w.sessionId === name) unwatch(w.key);
}

/** A command entered into a terminal (keyed as typeInTerminal is): what it runs, until the Companion or a prompt says otherwise. */
export function noteTyped(sessionId: string, text: string) {
  const line = text.replace(/[\r\n]+$/, '').split(/\r|\n/).pop()?.trim();
  if (!line) return;
  for (const w of watched.values()) {
    if (w.sessionId !== sessionId) continue;
    w.typed = { text: line.slice(0, 120), at: Date.now() };
    report(w);
  }
}

/** What is being typed at each shell's prompt, key by key, until Enter. */
const lines = new Map<string, string>();

/**
 * The keys typed into a terminal pane, as xterm sends them: the line being
 * typed, kept until Enter enters it as a command. Backspace takes a
 * character, Ctrl-C or Ctrl-U drops the line, arrows and other escapes are
 * left out (a command recalled from history shows as what was typed after).
 */
export function noteKeys(sessionId: string, data: string) {
  let line = lines.get(sessionId) ?? '';
  for (const part of data.match(/\u001b(?:\[[0-9;?]*[@-~]|O.|.)|[\s\S]/g) ?? []) {
    if (part[0] === '\u001b') continue;
    if (part === '\r' || part === '\n') {
      if (line.trim()) noteTyped(sessionId, line);
      line = '';
    } else if (part === '\u007f' || part === '\b') line = line.slice(0, -1);
    else if (part === '\u0003' || part === '\u0015') line = '';
    else if (part >= ' ') line += part;
  }
  lines.set(sessionId, line.slice(-400));
}

// --------------------------------------------- asking what runs ----

/** Companions that answered /companion/terminals, and ones that didn't (a plain Jupyter server, an older Companion): by server id. */
const companionAnswers = new Map<string, { ok: boolean; at: number }>();
let polling = 0;

async function askCompanion(server: JupyterServer): Promise<Record<string, { alive: boolean; busy: boolean; command?: string }> | null> {
  const known = companionAnswers.get(server.id);
  if (known && !known.ok && Date.now() - known.at < 5 * 60_000) return null;
  try {
    const response = await fetch(`${serverBase(server.url)}companion/terminals`, { headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { terminals?: Record<string, { alive: boolean; busy: boolean; command?: string }> };
    companionAnswers.set(server.id, { ok: true, at: Date.now() });
    return body.terminals ?? {};
  } catch {
    companionAnswers.set(server.id, { ok: false, at: Date.now() });
    return null;
  }
}

async function poll() {
  const list = [...watched.values()];
  const servers = new Map<string, Watched[]>();
  const kernels = new Map<string, Watched[]>();
  for (const w of list) {
    if (w.kind === 'server' && w.serverId) servers.set(w.serverId, [...(servers.get(w.serverId) ?? []), w]);
    if (w.kind === 'kernel') kernels.set(w.playgroundId, [...(kernels.get(w.playgroundId) ?? []), w]);
  }
  await Promise.all([
    ...[...servers.entries()].map(async ([serverId, terms]) => {
      const server = serverById(serverId);
      const answer = server ? await askCompanion(server) : null;
      for (const w of terms) {
        const one = answer?.[w.name];
        w.exact = one ? { busy: one.busy, command: one.command } : undefined;
        if (answer && !one) unwatch(w.key);
        else report(w);
      }
    }),
    ...[...kernels.entries()].map(async ([playgroundId, terms]) => {
      let status: Record<string, { alive: boolean; busy: boolean; command: string; tail: string }> | null = null;
      try {
        status = JSON.parse(await shellCall('_rt_status()', playgroundId));
      } catch {
        status = null;
      }
      for (const w of terms) {
        const one = status?.[w.name];
        if (status && (!one || !one.alive)) {
          unwatch(w.key);
          continue;
        }
        if (one) {
          w.exact = { busy: one.busy, command: one.command };
          w.screen = appendScreen(emptyScreen(), one.tail);
          report(w);
        }
      }
    }),
  ]);
}

function startPolling() {
  if (polling) return;
  const tick = async () => {
    await poll().catch(() => undefined);
    if (polling) polling = window.setTimeout(() => void tick(), 3000);
  };
  polling = window.setTimeout(() => void tick(), 500);
}

function stopPolling() {
  window.clearTimeout(polling);
  polling = 0;
}

// ------------------------------------------------------------ agents ----

/** The playgrounds whose project agent is followed: opened in this tab. */
const agentProjects = new Set<string>();
const agentSince = new Map<string, number>();

/** The project agent's state, as a job: busy while it reads and writes the files. */
function onAgent() {
  for (const id of agentProjects) {
    const busy = isAgentRunning(id);
    if (busy && !agentSince.has(id)) agentSince.set(id, Date.now());
    if (!busy) agentSince.delete(id);
    reportJob({ id: 'agent:reader', playgroundId: id, kind: 'agent', label: 'AI agent · working on the files', busy, since: agentSince.get(id), stop: () => stopAgent() });
  }
}

/** A playground's project agent pane opened: its requests are followed from now on, its pane open or not. */
export function followProjectAgent(playgroundId: string) {
  agentProjects.add(playgroundId);
  onAgent();
}

/** A coding agent on the machine (Claude Code, Codex) says whether a request is running, and how to stop it. */
export function reportCliAgent(playgroundId: string, agent: string, name: string, busy: boolean, tail?: string, stop?: () => void) {
  reportJob({ id: `agent:${agent}`, playgroundId, kind: 'agent', label: `${name} · working`, busy, tail, stop });
}

let started = false;
/** Starts following: the agents, and the terminals this tab followed before a reload. */
export function startJobWatch() {
  if (started) return;
  started = true;
  subscribeAgent(onAgent);
  try {
    const list = JSON.parse(sessionStorage.getItem(LIST_KEY) ?? '[]') as Saved[];
    for (const saved of list) {
      if (saved.kind === 'kernel') watchKernelTerminal({ playgroundId: saved.playgroundId, name: saved.name });
      else {
        const server = saved.serverId ? serverById(saved.serverId) : undefined;
        if (server) watchTerminal({ playgroundId: saved.playgroundId, server, name: saved.name, sessionId: saved.sessionId });
      }
    }
  } catch {
    // nothing kept
  }
}
