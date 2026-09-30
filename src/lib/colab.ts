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
import type { MachineSample, MachineSpecs } from './telemetry';
import { MACHINE_PROBE, parseMachineSample, specsOf } from './telemetry';

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
  /** The machine's use while it ran — GPU, CPU, memory, disk — sampled every couple of seconds while the watch is on. */
  samples?: MachineSample[];
}

export type Status =
  /** Never connected in this tab. */
  | 'off'
  /** Google's window, then the runtime, then the kernel. */
  | 'connecting'
  | 'idle'
  | 'busy'
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
  /** Whether the machine is watched while a cell runs (the runtime menu's switch); on unless turned off. */
  gpuWatch: boolean;
  /** The last sample taken: while a cell runs, or the one reading taken as the runtime connected. */
  sample?: MachineSample;
  /** What the runtime's machine is, read off the first sample: the GPU by name, the CPUs, the memory, the disk. */
  specs?: MachineSpecs;
  /** The samples of this runtime, running or idle, for the last while — the Runtime pane's timeline. */
  history: { at: number; sample: MachineSample }[];
  /** How the machine is read between cells (the pane's switch): live, every two seconds; slow, every half minute; or not at all. */
  pulse: Pulse;
  /** How the kernel's socket is carried: straight to the runtime, or by the proxy when the runtime refused the page's own. */
  via?: 'direct' | 'proxy';
  /** The kernel's socket dropped and is being opened again; the runtime and the kernel are still there. */
  reconnecting?: boolean;
  /** The cells still to run from Run all, by key, in order. */
  queue: string[];
  /** Run all is paused: the cell running finishes, and the rest wait for Resume. */
  paused: boolean;
}

// ------------------------------------------------------------ the store ----

const MACHINE_KEY = 'reader.colab.machine';
const NOTEBOOK_KEY = 'reader.colab.notebook';
const RUNTIME_KEY = 'reader.colab.runtime';
const GPU_KEY = 'reader.colab.gpu-watch';
const PULSE_KEY = 'reader.colab.pulse';
/** How much of the timeline is kept. */
export const HISTORY_MS = 10 * 60_000;
export type Pulse = 'live' | 'slow' | 'off';
/** How often the machine is read between cells, by pulse: live is the watch's own cadence, so the meters are as current idle as they are while a cell runs. */
export const PULSE_MS: Record<Pulse, number> = { live: 2000, slow: 30_000, off: 0 };
const isPulse = (value: unknown): value is Pulse => value === 'live' || value === 'slow' || value === 'off';
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

const savedPulse = (): Pulse => {
  const saved = read<unknown>(local(), PULSE_KEY);
  return isPulse(saved) ? saved : 'live';
};
let state: ColabState = { status: 'off', machine: savedMachine(), runs: {}, gpuWatch: read<boolean>(local(), GPU_KEY) !== false, history: [], pulse: savedPulse(), queue: [], paused: false };
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

/** The machine watch: the probe every couple of seconds in a second kernel while a cell runs, shown under the cell and in the chip. */
export function setGpuWatch(on: boolean) {
  write(local(), GPU_KEY, on);
  set({ gpuWatch: on, sample: on ? state.sample : undefined });
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

/** How often a frame goes to the kernel while nothing else does, so no hop on the way closes a silent socket. */
export const KEEPALIVE_MS = 15_000;
/** How long the page waits between its tries at opening a dropped socket again, before it gives the runtime up. */
export const RECONNECT_WAITS_MS = [1_000, 2_000, 4_000, 8_000];

/**
 * The WebSocket to the runtime's kernel. One session id for the page's
 * requests, so the kernel's replies can be told apart from other clients'.
 * Colab's proxy wants its token both as a query parameter and, where a
 * browser cannot set headers on a WebSocket, only there.
 *
 * The socket is a pipe, not the runtime: the kernel and everything in it
 * stay on the machine whether or not a socket is open to it, and Colab keeps
 * the machine for as long as its own idle limit allows — an hour and a half
 * or so on the free tier, twelve hours in all. What a quiet page loses is
 * the pipe, since Colab's tunnel, the Worker's bridge and the browser are
 * each free to close a connection that has carried nothing for a while. So
 * a frame goes out every few seconds when nothing else is going, and a
 * socket that closes anyway is opened again to the same kernel, with a few
 * tries a growing wait apart, before the page says the runtime is gone.
 */
class Kernel {
  private socket: WebSocket | null = null;
  private readonly sessionId = uuid();
  private readonly waiting = new Map<string, OnMessage>();
  private closed: (() => void) | null = null;
  private keepAlive: number | null = null;
  private lastKeepAlive: string | null = null;
  private reconnecting: Promise<void> | null = null;
  /** Closed on purpose: no reconnecting. */
  private ended = false;
  /** How the socket got there: straight to the runtime, or carried by the proxy. */
  via: 'direct' | 'proxy' = 'direct';

  constructor(
    private readonly proxy: RuntimeProxy,
    readonly id: string,
    private readonly onClose: (reason: string) => void,
    /** A ticket for the proxy to carry this kernel's socket, when the runtime will not take the page's own. */
    private readonly ticket?: (kernel: string, session: string) => Promise<string>,
    /** Told when the socket drops and when it is back. */
    private readonly onLink?: (link: 'open' | 'reconnecting') => void,
  ) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * A kernel_info_request every KEEPALIVE_MS, so the socket is never silent
   * long enough for anything on the way to give it up. The reply is not
   * waited on — while a cell runs the kernel answers after it — only dropped
   * when it comes, and its handler goes with the next request.
   */
  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAlive = window.setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.lastKeepAlive) this.waiting.delete(this.lastKeepAlive);
      const request = makeMessage('kernel_info_request', {}, this.sessionId);
      this.lastKeepAlive = request.header.msg_id;
      this.waiting.set(request.header.msg_id, (message) => {
        if (message.header.msg_type === 'kernel_info_reply') this.waiting.delete(request.header.msg_id);
      });
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // closing; the close event follows
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepAlive() {
    if (this.keepAlive !== null) window.clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  /**
   * The socket again, to the same kernel, after it closed on its own: a
   * few tries, a growing wait apart. A runtime that is gone — Colab says so
   * when the proxy asks for a ticket — is not tried again. When no try
   * opens one, the kernel is given up and `onClose` says why.
   */
  private reconnect(reason: string): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    this.onLink?.('reconnecting');
    this.reconnecting = (async () => {
      let why = reason;
      for (const wait of RECONNECT_WAITS_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, wait));
        if (this.ended) return;
        try {
          await this.connect();
          this.reconnecting = null;
          this.onLink?.('open');
          return;
        } catch (error) {
          why = message(error);
          if (error instanceof ColabRequestError && error.flags.gone) break;
        }
      }
      this.reconnecting = null;
      if (!this.ended) this.onClose(why);
    })();
    return this.reconnecting;
  }

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
        this.startKeepAlive();
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
        const mine = this.socket === socket;
        if (mine) {
          this.socket = null;
          this.stopKeepAlive();
        }
        this.closed?.();
        if (!opened || !ready) reject(new Error(`The runtime closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ''}).`));
        else if (mine && !this.ended) void this.reconnect(event.reason || `closed (${event.code})`);
      });
      this.socket = socket;
    });
  }

  /**
   * Runs code and resolves when the kernel says it is done, calling `onOutput`
   * for each message meant for this request on the way. The reply's status
   * says whether it ended in an error; the count is In [n].
   */
  async execute(code: string, onOutput: (message: JupyterMessage) => void): Promise<{ status: 'ok' | 'error' | 'aborted'; executionCount?: number }> {
    // A cell run while the socket is being opened again waits for it, rather than failing for a pipe that is a moment away.
    if (!this.connected && this.reconnecting) await this.reconnecting.catch(() => undefined);
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

  close() {
    this.ended = true;
    this.stopKeepAlive();
    const socket = this.socket;
    this.socket = null;
    this.closed = null;
    socket?.close();
  }
}

// ------------------------------------------------------------ the actions --

let kernel: Kernel | null = null;
/** A second, small kernel on the same machine for the watch, so the probe never waits on the cell. */
let monitor: Kernel | null = null;
let watching: number | null = null;
let clientIdNow = '';

const SAMPLE_EVERY_MS = 2000;

function stopWatching() {
  if (watching !== null) window.clearTimeout(watching);
  watching = null;
}

/** The monitor kernel being started, so two askers at once — the reading on connect and the watch of a first run — share one, not start two. */
let startingMonitor: Promise<Kernel | null> | null = null;

/** The monitor kernel, started on first need. Null when it could not be had — the watch is a reading, not the work. */
function ensureMonitor(runtime: Runtime, googleToken: string): Promise<Kernel | null> {
  if (monitor) return Promise.resolve(monitor);
  if (startingMonitor) return startingMonitor;
  startingMonitor = (async () => {
    try {
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
      return attached;
    } catch {
      return null;
    } finally {
      startingMonitor = null;
    }
  })();
  return startingMonitor;
}

/** One reading of the machine from the monitor kernel; null when the probe could not run or printed nothing readable. */
async function takeSample(t: number): Promise<MachineSample | null> {
  if (!monitor) return null;
  let text = '';
  try {
    await monitor.execute(MACHINE_PROBE, (incoming) => {
      if (incoming.header.msg_type === 'stream') text += asText(incoming.content.text);
    });
  } catch {
    return null;
  }
  return parseMachineSample(text, t);
}

/** A sample onto the store: the last reading, the machine's specs from it, and the timeline, kept to the last while. */
const keepSample = (sample: MachineSample) => {
  const at = Date.now();
  const history = [...state.history.filter((entry) => at - entry.at <= HISTORY_MS), { at, sample }];
  set({ sample, specs: { ...state.specs, ...specsOf(sample) }, history });
};

// ------------------------------------------------------------ idle pulse ---

let pulsing: number | null = null;

function stopPulse() {
  if (pulsing !== null) window.clearTimeout(pulsing);
  pulsing = null;
}

/** The machine read between cells at the pulse's cadence, while the runtime is idle; the watch takes over while a cell runs. */
function schedulePulse() {
  stopPulse();
  const every = PULSE_MS[state.pulse];
  if (!every || !state.gpuWatch || state.status !== 'idle') return;
  pulsing = window.setTimeout(() => {
    pulsing = null;
    void probeMachine().finally(() => schedulePulse());
  }, every);
}

/**
 * The pulse: the reading between cells, so the Runtime pane's meters and
 * timeline are real time rather than a record of the last run. Live is the
 * watch's own two seconds. Each reading runs a few lines in the second
 * kernel, which Colab may count as activity — welcome on the free tier,
 * where it keeps a runtime from idling out; on a machine billed in compute
 * units the runtime is being paid for while it is up either way, and the
 * reading itself is a negligible share of it. Remembered once switched.
 */
export function setPulse(pulse: Pulse) {
  write(local(), PULSE_KEY, pulse);
  set({ pulse });
  schedulePulse();
}

/**
 * While `key` runs: the probe in the monitor kernel every couple of seconds,
 * each sample onto the run and into the chip. Any failure ends the watch
 * quietly.
 */
async function watchMachine(key: string, runtime: Runtime, googleToken: string, started: number) {
  if (!state.gpuWatch) return;
  if (!(await ensureMonitor(runtime, googleToken))) return;
  const tick = async () => {
    if (state.running !== key || !monitor) return;
    const sample = await takeSample(Math.round((Date.now() - started) / 100) / 10);
    if (sample && state.running === key) {
      const run = state.runs[key];
      if (run) setRun(key, { ...run, samples: [...(run.samples ?? []), sample] });
      keepSample(sample);
    }
    if (state.running === key) watching = window.setTimeout(() => void tick(), SAMPLE_EVERY_MS);
  };
  watching = window.setTimeout(() => void tick(), 400);
}

/**
 * One reading of the runtime's machine now, between cells: what it is and
 * how busy it is. Taken as the runtime connects when the watch is on, and
 * on request from the Implementation page's Colab panel. Nothing while a
 * cell runs — the watch is already sampling.
 */
export async function probeMachine(): Promise<MachineSample | null> {
  const runtime = state.runtime;
  if (!runtime || !state.gpuWatch || state.running || state.status !== 'idle') return null;
  try {
    const googleToken = await colabToken(clientIdNow);
    if (!googleToken || !(await ensureMonitor(runtime, googleToken))) return null;
    const sample = await takeSample(0);
    if (sample) keepSample(sample);
    return sample;
  } catch {
    return null;
  }
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
  stopPulse();
  kernel?.close();
  kernel = null;
  monitor?.close();
  monitor = null;
};

const lost = (reason: string) => {
  closeKernels();
  write(session(), RUNTIME_KEY, null);
  const runs = Object.fromEntries(
    Object.entries(state.runs)
      .filter(([, run]) => run.state !== 'queued')
      .map(([key, run]) => [key, run.state === 'running' ? { ...run, state: 'interrupted' as RunState, stale: true, ms: Date.now() - run.startedAt } : { ...run, stale: true }]),
  );
  set({ status: 'lost', kernel: undefined, running: undefined, runs, error: reason, sample: undefined, reconnecting: false, queue: [], paused: false });
  wake();
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
      if (kernel === attached) lost(`The connection to the runtime closed and could not be opened again: ${reason}`);
    },
    ticketFor(runtime),
    (link) => {
      if (kernel === attached) set({ reconnecting: link === 'reconnecting', via: attached.via });
    },
  );
  await attached.connect();
  return attached;
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
    const same = state.runtime?.endpoint === runtime.endpoint;
    set({ status: 'idle', runtime, kernel: kernel.id, via: kernel.via, reconnecting: false, startedAt: same && state.startedAt ? state.startedAt : Date.now(), error: undefined, history: same ? state.history : [] });
    void refreshUnits(googleToken);
    // What the machine is, read once as it connects, so the page can say so before anything runs; then the pulse, if it is on.
    void probeMachine().finally(() => schedulePulse());
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
  if (!kernel || state.status === 'off' || state.status === 'lost' || state.status === 'error') await connect(state.machine);
  const runtime = state.runtime;
  if (!kernel || !runtime) return;
  const started = Date.now();
  const where = whereOf(runtime);
  stopPulse();
  set({ status: 'busy', running: key });
  setRun(key, { state: 'running', outputs: [], startedAt: started, where });
  if (state.gpuWatch) void colabToken(clientIdNow).then((googleToken) => (googleToken ? watchMachine(key, runtime, googleToken, started) : undefined)).catch(() => undefined);
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
    if (state.status !== 'lost') set({ error: message(error) });
  } finally {
    stopWatching();
    if (state.status === 'busy') set({ status: 'idle', running: undefined });
    else set({ running: undefined });
    schedulePulse();
  }
}

// ------------------------------------------------------------ run all -----
//
// Run all is a queue: every cell marked as queued at once, then run one
// after another. Pause lets the cell running finish and holds the rest for
// Resume; Stop interrupts the cell running and drops the rest. A cell that
// fails or is stopped ends the queue, as in Colab.

let resume: (() => void) | null = null;
const wake = () => {
  resume?.();
  resume = null;
};

/** Drops what is still queued, and their queued marks. */
function dropQueue() {
  const runs = { ...state.runs };
  for (const key of state.queue) if (runs[key]?.state === 'queued') delete runs[key];
  set({ runs, queue: [], paused: false });
  wake();
}

/** Runs cells one after another, in the order given, and stops at the first that fails. */
export async function runAll(cells: { key: string; code: string }[]): Promise<void> {
  if (!cells.length || state.running || state.queue.length) return;
  const where = state.runtime ? whereOf(state.runtime) : 'Colab';
  const runs = { ...state.runs };
  for (const cell of cells) runs[cell.key] = { state: 'queued', outputs: [], startedAt: 0, where };
  set({ runs, queue: cells.map((cell) => cell.key), paused: false });
  for (const cell of cells) {
    if (state.paused) await new Promise<void>((resolveResume) => (resume = resolveResume));
    // Stopped, or the runtime went, while this one waited.
    if (!state.queue.includes(cell.key)) break;
    set({ queue: state.queue.filter((key) => key !== cell.key) });
    await runCell(cell.key, cell.code);
    const run = state.runs[cell.key];
    if (!run || run.state !== 'ran') break;
  }
  dropQueue();
}

/** Pauses Run all: the cell running finishes; the rest wait. Nothing to pause when one cell runs on its own — Stop is for that. */
export function pauseRuns() {
  if (state.queue.length) set({ paused: true });
}

export function resumeRuns() {
  if (!state.paused) return;
  set({ paused: false });
  wake();
}

/** Stops the runs: the rest of the queue is dropped, and the cell running is interrupted. */
export async function stopRuns(): Promise<void> {
  dropQueue();
  if (state.running) await interrupt();
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
  set({ status: 'off', runtime: undefined, kernel: undefined, running: undefined, startedAt: undefined, runs, error: undefined, sample: undefined, specs: undefined, history: [], reconnecting: false, queue: [], paused: false });
  wake();
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
  set({ status: 'off', runtime: undefined, kernel: undefined, running: undefined, startedAt: undefined, error: undefined, units: undefined, sample: undefined, specs: undefined, history: [], reconnecting: false, queue: [], paused: false });
  wake();
}

export interface RuntimeEntry {
  name: string;
  path: string;
  type: 'directory' | 'notebook' | 'file';
  size: number | null;
  modified: string | null;
}

/** What is on the runtime's disk under `path` — the notebook page's Files pane. Needs a runtime. */
export async function listContents(path = ''): Promise<{ path: string; entries: RuntimeEntry[] }> {
  const runtime = state.runtime;
  if (!runtime || state.status === 'off' || state.status === 'lost') throw new Error('No runtime is connected.');
  const googleToken = await tokenOrConnect();
  return relay<{ path: string; entries: RuntimeEntry[] }>('/colab/contents', googleToken, { method: 'POST', body: { proxy: runtime.proxy, path } });
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
