// Google Colab, from the page's side: the Python cells Claude writes on the
// Explain and Implementation pages, run in the reader's own Colab runtime
// with one click, and what they print put under them.
//
// Three things live here. The runtime — one a browser, started with the
// machine the person chose, through the proxy (server/colab.js) with their
// own Google token, since Colab's session backend does not take requests
// from another origin. The kernel — a WebSocket from this page straight to
// the runtime's Jupyter server, speaking the Jupyter messaging protocol as
// Colab's own page does: an execute_request out; stream, display_data,
// execute_result, error and an execute_reply back. And the runs — one a
// cell, keyed by the cell's own code, so a cell Claude rewrites comes back
// as not run.
//
// The rules the page keeps (docs/colab-run.md): nothing runs without a
// click on that cell; exactly the code shown is what runs; the scope is
// asked for at the first Run and kept the way the Drive token is; the
// reader never mounts Drive or puts credentials in the kernel; output is
// text and pictures, never markup; and every output says where it ran.

import { api, apiFetch, hasProxy } from './api';
import { colabToken, connectColab, dropColab, hasColabAccess } from './google';
import type { GpuSample } from './telemetry';
import { GPU_PROBE, parseGpuSample } from './telemetry';

// ---------------------------------------------------------------- types ----

export type Accelerator = 'NONE' | 'T4' | 'L4' | 'A100';

export interface Machine {
  accelerator: Accelerator;
  highMem?: boolean;
}

/** The machines the first-run card offers, and what each costs the person. */
export const MACHINES: { accelerator: Accelerator; label: string; note: string }[] = [
  { accelerator: 'NONE', label: 'CPU only', note: 'free · starts in seconds' },
  { accelerator: 'T4', label: 'T4 GPU', note: 'free tier · when one is free' },
  { accelerator: 'L4', label: 'L4 GPU', note: 'Colab Pro · compute units' },
  { accelerator: 'A100', label: 'A100 GPU', note: 'Colab Pro+ · compute units' },
];

export const machineLabel = (machine: Pick<Machine, 'accelerator' | 'highMem'> | { accelerator: Accelerator | null; highMem?: boolean }) =>
  `${machine.accelerator && machine.accelerator !== 'NONE' ? machine.accelerator : 'CPU'}${machine.highMem ? ' · high RAM' : ''}`;

export interface RuntimeProxy {
  url: string;
  token: string;
  expiresAt: number;
}

export interface Runtime {
  endpoint: string;
  accelerator: Accelerator | null;
  highMem: boolean;
  proxy: RuntimeProxy;
}

export type Output =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'error'; ename: string; evalue: string; traceback: string };

export type RunState = 'queued' | 'running' | 'ran' | 'failed' | 'interrupted';

export interface CellRun {
  state: RunState;
  outputs: Output[];
  startedAt: number;
  /** How long it took, once it is over. */
  ms?: number;
  /** In [n] as the kernel counted it. */
  executionCount?: number;
  /** The machine it ran on, for the label under the output. */
  where: string;
  /** Set when the runtime it ran on has since gone. */
  stale?: boolean;
  /** The GPU's use while it ran, sampled every couple of seconds, when the machine has one and the watch is on. */
  gpu?: GpuSample[];
}

export type Status =
  /** Never connected in this tab. */
  | 'off'
  /** Google's window, then the runtime, then the kernel. */
  | 'connecting'
  | 'idle'
  | 'busy'
  /** The socket dropped; the page is opening another to the same kernel. */
  | 'reconnecting'
  /** Colab ended the runtime, or the kernel went away. */
  | 'lost'
  | 'error';

export interface ColabState {
  status: Status;
  machine: Machine;
  runtime?: Runtime;
  kernel?: string;
  startedAt?: number;
  /** The cell running now, by key. */
  running?: string;
  runs: Record<string, CellRun>;
  error?: string;
  /** Compute units, as Colab last reported them. */
  units?: { balance?: number; ratePerHour?: number };
  /** Whether the GPU is watched while a cell runs (the runtime menu's switch); on unless turned off. */
  gpuWatch: boolean;
  /** The last GPU sample taken, while a cell runs. */
  gpu?: GpuSample;
  /** How the kernel's socket is carried: straight to the runtime, or by the proxy when the runtime refused the page's own. */
  via?: 'direct' | 'proxy';
}

// ------------------------------------------------------------ the store ----

const MACHINE_KEY = 'reader.colab.machine';
const NOTEBOOK_KEY = 'reader.colab.notebook';
const RUNTIME_KEY = 'reader.colab.runtime';
const GPU_KEY = 'reader.colab.gpu-watch';
/** Once the page's own socket to a runtime has been refused, the proxy carries it from then on, in this tab. */
const VIA_KEY = 'reader.colab.via';

const read = <T>(storage: Storage | undefined, key: string): T | null => {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const write = (storage: Storage | undefined, key: string, value: unknown) => {
  try {
    if (value === null || value === undefined) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // private mode
  }
};
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

const isAccelerator = (value: unknown): value is Accelerator => value === 'NONE' || value === 'T4' || value === 'L4' || value === 'A100';
const savedMachine = (): Machine => {
  const saved = read<Partial<Machine>>(local(), MACHINE_KEY);
  return { accelerator: isAccelerator(saved?.accelerator) ? saved.accelerator : 'NONE', highMem: Boolean(saved?.highMem) };
};

/**
 * One notebook id a browser: Colab keys an assignment by the notebook it is
 * for, so one id means one runtime however many pages run cells in it.
 */
function notebookId(): string {
  const saved = read<string>(local(), NOTEBOOK_KEY);
  if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
  const made = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000';
  write(local(), NOTEBOOK_KEY, made);
  return made;
}

let state: ColabState = { status: 'off', machine: savedMachine(), runs: {}, gpuWatch: read<boolean>(local(), GPU_KEY) !== false };
const listeners = new Set<() => void>();
const set = (patch: Partial<ColabState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const setRun = (key: string, run: CellRun) => set({ runs: { ...state.runs, [key]: run } });

export const colabNow = () => state;
export function subscribeColab(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether cells can be run at all here: a proxy to reach Colab through, and a client ID to sign in with. */
export const colabAvailable = (clientId: string) => hasProxy() && Boolean(clientId.trim());

/** The GPU watch: nvidia-smi every couple of seconds in a second kernel while a cell runs, shown under the cell. */
export function setGpuWatch(on: boolean) {
  write(local(), GPU_KEY, on);
  set({ gpuWatch: on, gpu: on ? state.gpu : undefined });
  if (!on) stopWatching();
}

export function setMachine(machine: Machine) {
  write(local(), MACHINE_KEY, machine);
  set({ machine });
}

/**
 * The key a run is kept under: the cell's code, so a cell that comes back
 * from a revision with other code has no run, and one with the same code
 * keeps its output.
 */
export function cellKey(code: string): string {
  let hash = 2166136261;
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `c${(hash >>> 0).toString(36)}`;
}

// ---------------------------------------------------- the Jupyter protocol ---

interface JupyterHeader {
  msg_id: string;
  msg_type: string;
  session: string;
  username: string;
  version: string;
  date: string;
}

export interface JupyterMessage {
  header: JupyterHeader;
  parent_header: Partial<JupyterHeader>;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  channel: 'shell' | 'iopub' | 'stdin' | 'control';
  buffers?: unknown[];
}

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/** A message as the default WebSocket subprotocol carries it: one JSON object with its channel named. */
export function makeMessage(msgType: string, content: Record<string, unknown>, sessionId: string, channel: JupyterMessage['channel'] = 'shell'): JupyterMessage {
  return {
    header: { msg_id: uuid(), msg_type: msgType, session: sessionId, username: 'reader', version: '5.3', date: new Date().toISOString() },
    parent_header: {},
    metadata: {},
    content,
    channel,
    buffers: [],
  };
}

/** The request that runs a cell: the code as shown, nothing kept back, and no stdin — a cell that asks for input gets an error, not a prompt nobody can answer. */
export const executeRequest = (code: string, sessionId: string) =>
  makeMessage('execute_request', { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true }, sessionId);

/** Every half minute over an open socket: a kernel_info_request on the control channel, which a kernel answers even while a cell runs. */
export const HEARTBEAT_MS = 30_000;
export const heartbeatRequest = (sessionId: string) => makeMessage('kernel_info_request', {}, sessionId, 'control');

export function parseMessage(text: string): JupyterMessage | null {
  try {
    const parsed = JSON.parse(text) as Partial<JupyterMessage>;
    if (!parsed || typeof parsed !== 'object' || !parsed.header?.msg_type) return null;
    return { ...parsed, channel: parsed.channel ?? 'iopub', content: parsed.content ?? {}, parent_header: parsed.parent_header ?? {}, metadata: parsed.metadata ?? {} } as JupyterMessage;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- outputs ----

/** The most one cell's output may hold on the page; what comes after is cut, and the cut is said. */
export const OUTPUT_LIMIT = 200_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (text: string) => text.replace(ANSI, '');

const asText = (value: unknown) => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '');

/**
 * What a message from the kernel adds to a cell's output. Text and pictures
 * only: a display with HTML or JavaScript in it is shown by its text/plain,
 * or not at all — kernel output is data, never markup on this page.
 */
export function reduceOutputs(outputs: Output[], message: JupyterMessage): Output[] {
  const { msg_type: type } = message.header;
  const content = message.content;
  if (type === 'stream') {
    const name = content.name === 'stderr' ? 'stderr' : 'stdout';
    const text = stripAnsi(asText(content.text));
    if (!text) return outputs;
    const last = outputs[outputs.length - 1];
    if (last?.type === 'stream' && last.name === name) return [...outputs.slice(0, -1), { ...last, text: last.text + text }];
    return [...outputs, { type: 'stream', name, text }];
  }
  if (type === 'display_data' || type === 'execute_result' || type === 'update_display_data') {
    const data = (content.data ?? {}) as Record<string, unknown>;
    const image = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'].find((mime) => typeof data[mime] === 'string' || Array.isArray(data[mime]));
    if (image && image !== 'image/svg+xml') return [...outputs, { type: 'image', mime: image, data: asText(data[image]).replace(/\s+/g, '') }];
    const text = stripAnsi(asText(data['text/plain']));
    if (text) return [...outputs, { type: 'text', text }];
    if (image) return [...outputs, { type: 'text', text: '[an SVG figure — shown in Colab, not here]' }];
    return outputs;
  }
  if (type === 'error') {
    const traceback = stripAnsi(Array.isArray(content.traceback) ? (content.traceback as unknown[]).map(String).join('\n') : asText(content.traceback));
    return [...outputs, { type: 'error', ename: String(content.ename ?? 'Error'), evalue: String(content.evalue ?? ''), traceback }];
  }
  if (type === 'clear_output') return [];
  return outputs;
}

/** The cell's output as one piece of text, for the comparison and for a question to Claude. */
export function outputText(outputs: Output[]): string {
  return outputs
    .map((output) => (output.type === 'stream' || output.type === 'text' ? output.text : output.type === 'error' ? output.traceback || `${output.ename}: ${output.evalue}` : `[${output.mime}]`))
    .join('')
    .replace(/\s+$/, '');
}

/** The size of what is kept, so a cell that prints without end is cut off rather than kept whole. */
export const outputSize = (outputs: Output[]) => outputs.reduce((sum, output) => sum + (output.type === 'image' ? output.data.length : outputText([output]).length), 0);

export type Verdict = 'match' | 'differs' | 'none';

const normalise = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

/**
 * Whether what ran printed what Claude wrote as the expected output. Spacing
 * is forgiven; anything else is a difference, which the page turns into a
 * question rather than a verdict of its own.
 */
export function compareOutput(expected: string | undefined, outputs: Output[]): Verdict {
  if (expected === undefined || !expected.trim()) return 'none';
  if (outputs.some((output) => output.type === 'error')) return 'differs';
  return normalise(expected) === normalise(outputText(outputs)) ? 'match' : 'differs';
}

/** The lines of the actual output that are not in the expected one, by index — the ones to tint. */
export function differingLines(expected: string | undefined, actual: string): Set<number> {
  const wanted = new Set(normalise(expected ?? '').split('\n'));
  const lines = actual.split('\n');
  const marked = new Set<number>();
  lines.forEach((line, index) => {
    const clean = line.replace(/\s+/g, ' ').trim();
    if (clean && !wanted.has(clean)) marked.add(index);
  });
  return marked;
}

// ----------------------------------------------------------- the relay ----

class ColabRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly flags: { reauth?: boolean; gone?: boolean; limit?: boolean } = {},
  ) {
    super(message);
    this.name = 'ColabRequestError';
  }
}

async function relay<T>(path: string, googleToken: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const response = await apiFetch(path, {
    method: init.method ?? 'GET',
    headers: { Accept: 'application/json', 'X-Google-Token': googleToken, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; reauth?: boolean; gone?: boolean; limit?: boolean };
  if (!response.ok) throw new ColabRequestError(response.status, body.error || `The proxy answered ${response.status}.`, { reauth: body.reauth, gone: body.gone, limit: body.limit });
  return body;
}

// ------------------------------------------------------------ the kernel ---

type OnMessage = (message: JupyterMessage) => void;

/**
 * The WebSocket to the runtime's kernel. One session id for the page's
 * requests, so the kernel's replies can be told apart from other clients'.
 * Colab's proxy wants its token both as a query parameter and, where a
 * browser cannot set headers on a WebSocket, only there.
 */
class Kernel {
  private socket: WebSocket | null = null;
  private readonly sessionId = uuid();
  private readonly waiting = new Map<string, OnMessage>();
  private closed: (() => void) | null = null;
  /**
   * A heartbeat over the socket while it is open. Nothing on the path keeps
   * a quiet socket: Cloudflare closes one that has carried nothing for a
   * hundred seconds, and Colab counts a runtime with no client as idle. A
   * kernel_info_request every half minute is traffic both ways, and real
   * kernel activity.
   */
  private heartbeat: number | null = null;
  /** How the socket got there: straight to the runtime, or carried by the proxy. */
  via: 'direct' | 'proxy' = 'direct';

  constructor(
    private readonly proxy: RuntimeProxy,
    readonly id: string,
    private readonly onClose: (reason: string) => void,
    /** A ticket for the proxy to carry this kernel's socket, when the runtime will not take the page's own. */
    private readonly ticket?: (kernel: string, session: string) => Promise<string>,
  ) {}

  /**
   * The runtime's socket, straight from the page when the runtime allows
   * it, and through the proxy when it does not (Colab's runtime proxy takes
   * a socket from Colab's own page and from a client that can set headers,
   * not from another site). A refusal is remembered for the tab, so the
   * next connection goes the way that worked.
   */
  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    const remembered = read<string>(session(), VIA_KEY);
    if (remembered !== 'proxy') {
      try {
        await this.open(this.directUrl(), null);
        this.via = 'direct';
        return;
      } catch (error) {
        if (!this.ticket || !hasProxy()) throw error;
      }
    }
    if (!this.ticket) throw new Error('The runtime would not take a connection from this page, and there is no proxy to carry one.');
    const ticket = await this.ticket(this.id, this.sessionId);
    const bridge = new URL(api('/colab/socket'), window.location.href);
    bridge.protocol = bridge.protocol === 'http:' ? 'ws:' : 'wss:';
    bridge.searchParams.set('ticket', ticket);
    await this.open(bridge.href, JSON.stringify({ type: 'hello', token: this.proxy.token }));
    this.via = 'proxy';
    write(session(), VIA_KEY, 'proxy');
  }

  private directUrl(): string {
    const url = new URL(`api/kernels/${encodeURIComponent(this.id)}/channels`, this.proxy.url);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.searchParams.set('session_id', this.sessionId);
    url.searchParams.set('colab-runtime-proxy-token', this.proxy.token);
    return url.href;
  }

  /**
   * Opens one socket. With a `hello`, it is the proxy's bridge: the hello
   * goes first, and the socket counts as open when the bridge says the
   * runtime is on the other end.
   */
  private open(href: string, hello: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(href);
      let opened = false;
      let ready = hello === null;
      const timer = window.setTimeout(() => {
        if (!ready) {
          socket.close();
          reject(new Error('The runtime did not answer in time.'));
        }
      }, 25_000);
      const settle = () => {
        window.clearTimeout(timer);
        ready = true;
        this.stopHeartbeat();
        this.heartbeat = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(heartbeatRequest(this.sessionId)));
        }, HEARTBEAT_MS);
        resolve();
      };
      socket.addEventListener('open', () => {
        opened = true;
        if (hello) socket.send(hello);
        else settle();
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        if (!ready) {
          // The bridge's own word, before the kernel's: ready, or why not.
          try {
            const note = JSON.parse(event.data) as { type?: string; error?: string };
            if (note?.type === 'ready') {
              settle();
              return;
            }
          } catch {
            // the kernel's, then
          }
        }
        const message = parseMessage(event.data);
        if (!message) return;
        const parent = message.parent_header?.msg_id;
        const handler = parent ? this.waiting.get(parent) : undefined;
        handler?.(message);
      });
      socket.addEventListener('error', () => {
        if (!opened) {
          window.clearTimeout(timer);
          reject(new Error('Could not open a connection to the runtime — it may have ended, or its address may not take connections from this site.'));
        }
      });
      socket.addEventListener('close', (event) => {
        window.clearTimeout(timer);
        this.stopHeartbeat();
        if (this.socket === socket) this.socket = null;
        this.closed?.();
        if (!opened || !ready) reject(new Error(`The runtime closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ''}).`));
        else this.onClose(event.reason || `closed (${event.code})`);
      });
      this.socket = socket;
    });
  }

  /**
   * Runs code and resolves when the kernel says it is done, calling `onOutput`
   * for each message meant for this request on the way. The reply's status
   * says whether it ended in an error; the count is In [n].
   */
  execute(code: string, onOutput: (message: JupyterMessage) => void): Promise<{ status: 'ok' | 'error' | 'aborted'; executionCount?: number }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('The kernel is not connected.'));
        return;
      }
      const request = executeRequest(code, this.sessionId);
      let reply: { status: 'ok' | 'error' | 'aborted'; executionCount?: number } | null = null;
      let idle = false;
      const finish = () => {
        if (!reply || !idle) return;
        this.waiting.delete(request.header.msg_id);
        this.closed = null;
        resolve(reply);
      };
      this.closed = () => {
        this.waiting.delete(request.header.msg_id);
        this.closed = null;
        reject(new Error('The connection to the runtime closed while the cell was running.'));
      };
      this.waiting.set(request.header.msg_id, (message) => {
        const type = message.header.msg_type;
        if (type === 'execute_reply') {
          const status = message.content.status === 'ok' ? 'ok' : message.content.status === 'aborted' ? 'aborted' : 'error';
          const count = typeof message.content.execution_count === 'number' ? message.content.execution_count : undefined;
          reply = { status, executionCount: count };
          finish();
          return;
        }
        if (type === 'status') {
          if (message.content.execution_state === 'idle') {
            idle = true;
            finish();
          }
          return;
        }
        if (type === 'input_request') {
          // No stdin: the request said so, and a kernel that asks anyway gets nothing back.
          return;
        }
        onOutput(message);
      });
      socket.send(JSON.stringify(request));
    });
  }

  private stopHeartbeat() {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.closed = null;
    this.stopHeartbeat();
    socket?.close();
  }
}

// ------------------------------------------------------------ the actions --

let kernel: Kernel | null = null;
/** A second, small kernel on the same machine for the GPU watch, so the probe never waits on the cell. */
let monitor: Kernel | null = null;
let watching: number | null = null;
let clientIdNow = '';

const GPU_EVERY_MS = 2000;

function stopWatching() {
  if (watching !== null) window.clearTimeout(watching);
  watching = null;
}

/**
 * While `key` runs on a machine with a GPU: nvidia-smi in the monitor kernel
 * every couple of seconds, each sample onto the run and into the chip. Any
 * failure ends the watch quietly — it is a reading, not the work.
 */
async function watchGpu(key: string, runtime: Runtime, googleToken: string, started: number) {
  if (!state.gpuWatch || !runtime.accelerator) return;
  try {
    if (!monitor) {
      const made = await relay<{ kernel: { id: string } }>('/colab/kernels', googleToken, { method: 'POST', body: { proxy: runtime.proxy } });
      const attached = new Kernel(
        runtime.proxy,
        made.kernel.id,
        () => {
          if (monitor === attached) monitor = null;
        },
        ticketFor(runtime),
      );
      await attached.connect();
      monitor = attached;
    }
  } catch {
    return;
  }
  const tick = async () => {
    if (state.running !== key || !monitor) return;
    let text = '';
    try {
      await monitor.execute(GPU_PROBE, (incoming) => {
        if (incoming.header.msg_type === 'stream') text += asText(incoming.content.text);
      });
    } catch {
      return;
    }
    const sample = parseGpuSample(text, Math.round((Date.now() - started) / 100) / 10);
    if (sample && state.running === key) {
      const run = state.runs[key];
      if (run) setRun(key, { ...run, gpu: [...(run.gpu ?? []), sample] });
      set({ gpu: sample });
    }
    if (state.running === key) watching = window.setTimeout(() => void tick(), GPU_EVERY_MS);
  };
  watching = window.setTimeout(() => void tick(), 400);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Remembers the client ID the page is signed in with, for the quiet renewals. */
export const useClient = (clientId: string) => {
  clientIdNow = clientId;
};

async function tokenOrConnect(): Promise<string> {
  if (!clientIdNow) throw new Error('Google sign-in is not set up: Settings → Google needs a client ID.');
  const held = await colabToken(clientIdNow);
  if (held) return held;
  return connectColab(clientIdNow);
}

/** Where a run says it happened: the machine, from the runtime. */
const whereOf = (runtime: Runtime) => `Colab · ${machineLabel(runtime)}`;

const closeKernels = () => {
  stopWatching();
  kernel?.close();
  kernel = null;
  monitor?.close();
  monitor = null;
};

const lost = (reason: string) => {
  closeKernels();
  write(session(), RUNTIME_KEY, null);
  const runs = Object.fromEntries(Object.entries(state.runs).map(([key, run]) => [key, run.state === 'running' || run.state === 'queued' ? { ...run, state: 'interrupted' as RunState, stale: true, ms: Date.now() - run.startedAt } : { ...run, stale: true }]));
  set({ status: 'lost', kernel: undefined, running: undefined, runs, error: reason });
};

/** A ticket for the proxy to carry a kernel's socket: asked for as the page connects, with the person's own token. */
const ticketFor = (runtime: Runtime) => async (kernelId: string, sessionId: string) => {
  const googleToken = await tokenOrConnect();
  const answer = await relay<{ ticket: string }>('/colab/socket/ticket', googleToken, { method: 'POST', body: { proxy: { url: runtime.proxy.url }, kernel: kernelId, session: sessionId } });
  return answer.ticket;
};

async function attach(runtime: Runtime, googleToken: string): Promise<Kernel> {
  // The runtime's kernel, if it has one — a second kernel would be a second Python with none of the first's variables.
  const listed = await relay<{ kernels: { id: string }[] }>('/colab/kernels/list', googleToken, { method: 'POST', body: { proxy: runtime.proxy } }).catch(() => null);
  let id = state.kernel && listed?.kernels?.some((k) => k.id === state.kernel) ? state.kernel : listed?.kernels?.[0]?.id;
  if (!id) id = (await relay<{ kernel: { id: string } }>('/colab/kernels', googleToken, { method: 'POST', body: { proxy: runtime.proxy } })).kernel.id;
  const attached = new Kernel(
    runtime.proxy,
    id,
    (reason) => {
      if (kernel === attached) void dropped(runtime, reason);
    },
    ticketFor(runtime),
  );
  await attached.connect();
  return attached;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
let reconnecting = false;

/**
 * The work kernel's socket closed under us. A closed socket is not a gone
 * kernel: the runtime keeps its Python, and its variables, whether a page
 * is connected or not. So another socket is opened to the same kernel,
 * three times with a growing pause, and only when the runtime is gone —
 * or nothing answers — does the page say so. A kernel that was replaced
 * meanwhile is said too: the earlier runs are marked as from before.
 */
async function dropped(runtime: Runtime, reason: string) {
  if (reconnecting || state.status === 'off') return;
  reconnecting = true;
  kernel = null;
  set({ status: 'reconnecting', running: undefined, error: undefined });
  try {
    for (const pause of [800, 2500, 8000]) {
      await sleep(pause);
      if (state.status !== 'reconnecting') return;
      try {
        const googleToken = await tokenOrConnect();
        const previous = state.kernel;
        const attached = await attach(runtime, googleToken);
        kernel = attached;
        const same = attached.id === previous;
        const runs = same ? state.runs : Object.fromEntries(Object.entries(state.runs).map(([key, run]) => [key, { ...run, stale: true }]));
        set({ status: 'idle', kernel: attached.id, via: attached.via, runs, error: same ? undefined : 'The connection dropped and the kernel was gone; a new one started, so what earlier cells defined is lost.' });
        return;
      } catch (error) {
        if (error instanceof ColabRequestError && error.flags.gone) break;
      }
    }
    lost(`The connection to the runtime closed (${reason}) and could not be opened again.`);
  } finally {
    reconnecting = false;
  }
}

/** Waits out a connection in progress, so a click during one runs after it rather than starting another. */
async function settled(): Promise<void> {
  for (let waited = 0; (state.status === 'reconnecting' || state.status === 'connecting') && waited < 30_000; waited += 200) await sleep(200);
}

/**
 * A runtime and a kernel, from what is held or afresh: Google's window if
 * Colab was never connected in this tab, then Colab's assignment for this
 * browser's notebook, then a WebSocket to its kernel.
 */
export async function connect(machine: Machine = state.machine): Promise<void> {
  if (state.status === 'connecting') return;
  set({ status: 'connecting', error: undefined, machine });
  write(local(), MACHINE_KEY, machine);
  try {
    const googleToken = await tokenOrConnect();
    const held = state.runtime ?? read<Runtime>(session(), RUNTIME_KEY) ?? undefined;
    let runtime = held && held.proxy.expiresAt > Date.now() + 60_000 ? held : undefined;
    if (!runtime) {
      // The runtime Colab already has for this notebook, or one it starts now.
      runtime = (await relay<{ runtime: Runtime }>('/colab/runtimes', googleToken, { method: 'POST', body: { notebook: notebookId(), accelerator: machine.accelerator, highMem: Boolean(machine.highMem) } })).runtime;
    }
    closeKernels();
    kernel = await attach(runtime, googleToken);
    write(session(), RUNTIME_KEY, runtime);
    set({ status: 'idle', runtime, kernel: kernel.id, via: kernel.via, startedAt: state.runtime?.endpoint === runtime.endpoint && state.startedAt ? state.startedAt : Date.now(), error: undefined });
    void refreshUnits(googleToken);
  } catch (error) {
    const flags = error instanceof ColabRequestError ? error.flags : {};
    if (flags.gone) {
      lost('Colab has ended that runtime.');
      write(session(), RUNTIME_KEY, null);
      set({ runtime: undefined });
      return;
    }
    if (flags.reauth) dropColab();
    set({ status: state.runtime ? 'lost' : 'off', error: message(error) });
    throw error;
  }
}

async function refreshUnits(googleToken: string) {
  try {
    const units = await relay<Record<string, unknown>>('/colab/units', googleToken);
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    set({ units: { balance: number(units.balance ?? units.ccuBalance ?? units.remaining), ratePerHour: number(units.ratePerHour ?? units.consumptionRate ?? units.rate) } });
  } catch {
    // Colab did not say; the menu shows the tier instead.
  }
}

/**
 * Runs one cell — the code as shown — in the kernel, and keeps what it
 * prints under `key`. Connects first when there is nothing to run in, which
 * is the one place Google's window can open, so this is called from a click.
 */
export async function runCell(key: string, code: string): Promise<void> {
  if (state.running) return;
  await settled();
  if (!kernel || state.status === 'off' || state.status === 'lost' || state.status === 'error') await connect(state.machine);
  const runtime = state.runtime;
  if (!kernel || !runtime) return;
  const started = Date.now();
  const where = whereOf(runtime);
  set({ status: 'busy', running: key, gpu: undefined });
  setRun(key, { state: 'running', outputs: [], startedAt: started, where });
  if (runtime.accelerator && state.gpuWatch) void colabToken(clientIdNow).then((googleToken) => (googleToken ? watchGpu(key, runtime, googleToken, started) : undefined)).catch(() => undefined);
  let outputs: Output[] = [];
  let cut = false;
  try {
    const reply = await kernel.execute(code, (incoming) => {
      if (cut) return;
      outputs = reduceOutputs(outputs, incoming);
      if (outputSize(outputs) > OUTPUT_LIMIT) {
        cut = true;
        outputs = [...outputs, { type: 'stream', name: 'stderr', text: '\n[output cut here: more than 200 KB — run it in Colab to see the rest]' }];
        void interrupt();
      }
      setRun(key, { ...state.runs[key], state: 'running', outputs, startedAt: started, where });
    });
    setRun(key, { ...state.runs[key], state: reply.status === 'ok' ? 'ran' : reply.status === 'aborted' ? 'interrupted' : 'failed', outputs, startedAt: started, ms: Date.now() - started, executionCount: reply.executionCount, where });
  } catch (error) {
    setRun(key, { ...state.runs[key], state: 'interrupted', outputs, startedAt: started, ms: Date.now() - started, where, stale: true });
    if (state.status !== 'lost' && state.status !== 'reconnecting') set({ error: message(error) });
  } finally {
    stopWatching();
    if (state.status === 'busy') set({ status: 'idle', running: undefined });
    else if (state.status !== 'reconnecting') set({ running: undefined });
  }
}

/** Runs cells one after another, in the order given, and stops at the first that fails. */
export async function runAll(cells: { key: string; code: string }[]): Promise<void> {
  for (const cell of cells) {
    await runCell(cell.key, cell.code);
    const run = state.runs[cell.key];
    if (!run || run.state !== 'ran') break;
  }
}

/** Interrupts the cell running now; the kernel answers the cell's request with an error, which ends the run. */
export async function interrupt(): Promise<void> {
  if (!state.runtime || !state.kernel) return;
  try {
    const googleToken = await tokenOrConnect();
    await relay('/colab/kernels/interrupt', googleToken, { method: 'POST', body: { proxy: state.runtime.proxy, kernel: state.kernel } });
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Restarts the kernel: every variable goes, the machine and its files stay. Runs are kept, marked as from before. */
export async function restartKernel(): Promise<void> {
  if (!state.runtime || !state.kernel) return;
  try {
    const googleToken = await tokenOrConnect();
    await relay('/colab/kernels/restart', googleToken, { method: 'POST', body: { proxy: state.runtime.proxy, kernel: state.kernel } });
    const runs = Object.fromEntries(Object.entries(state.runs).map(([key, run]) => [key, { ...run, stale: true }]));
    set({ runs, error: undefined });
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Releases the runtime. The cells keep what they printed, marked as from a runtime that is gone. */
export async function stopRuntime(): Promise<void> {
  const runtime = state.runtime;
  closeKernels();
  write(session(), RUNTIME_KEY, null);
  const runs = Object.fromEntries(Object.entries(state.runs).map(([key, run]) => [key, { ...run, stale: true }]));
  set({ status: 'off', runtime: undefined, kernel: undefined, running: undefined, startedAt: undefined, runs, error: undefined, gpu: undefined });
  if (!runtime) return;
  try {
    const googleToken = await tokenOrConnect();
    await relay('/colab/runtimes/stop', googleToken, { method: 'POST', body: { endpoint: runtime.endpoint } });
  } catch (error) {
    set({ error: `The runtime may still be running: ${message(error)} Stop it in Colab under Runtime → Manage sessions.` });
  }
}

/** Forgets Colab in this tab: the connection, the runtime's address and the token. The runtime itself is left to Colab's idle timeout unless stopped first. */
export function disconnect(): void {
  closeKernels();
  write(session(), RUNTIME_KEY, null);
  dropColab();
  set({ status: 'off', runtime: undefined, kernel: undefined, running: undefined, startedAt: undefined, error: undefined, units: undefined });
}

/** Forgets one cell's run — for a cell whose code has changed, or on request. */
export function forgetRun(key: string) {
  if (!(key in state.runs)) return;
  const runs = { ...state.runs };
  delete runs[key];
  set({ runs });
}

/** Whether this tab holds a Colab grant already, so the first Run need not explain itself again. */
export const colabGranted = () => hasColabAccess();

/** A runtime this tab had before a reload, if Colab may still have it. */
export const rememberedRuntime = (): Runtime | undefined => {
  const held = read<Runtime>(session(), RUNTIME_KEY);
  return held && held.proxy?.expiresAt > Date.now() ? held : undefined;
};
