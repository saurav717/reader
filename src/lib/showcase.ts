/**
 * The showcase's replay: what the model and Colab would do, done here —
 * instantly, for free, and the same every time — so a first visit can watch
 * a paper be asked about, explained, planned and run without a key, a Colab
 * sign-in or a wait.
 *
 * While it is installed, window.fetch answers the model's endpoints (Claude,
 * direct or through the proxy) from the fixtures in src/showcase/, as the
 * same SSE stream the real API sends, and the proxy's /colab routes as a
 * runtime on a T4; window.WebSocket answers that runtime's kernel socket
 * with a stand-in kernel that "runs" the notebook's cells. The way the smoke
 * scripts do it, inside the page. Everything else goes out as it always did.
 */
import { replaying, setReplaying } from './replayFlag';
import { refreshKeys } from './assistant';
import { setMachine } from './colab';
import { MACHINE_PROBE } from './telemetry';
import EXPLANATION from '../showcase/explain.md?raw';
import PLAN from '../showcase/implement.md?raw';
import NOTEBOOK from '../showcase/notebook.md?raw';
import ANSWER from '../showcase/answer.md?raw';

/** The event that starts the showcase from anywhere: the tour's last card, Settings, the palette. */
export const START_SHOWCASE = 'reader:showcase';

export function startShowcase(): void {
  window.dispatchEvent(new CustomEvent(START_SHOWCASE));
}

/** The paper the showcase is about. */
export const SHOWCASE_PAPER = { query: 'Attention is all you need', arxivId: '1706.03762', title: /attention is all you need/i };

/** The stand-in runtime's address: a host that cannot resolve, so nothing real is ever reached. */
const RUNTIME_HOST = 'showcase-runtime.invalid';
const RUNTIME_URL = `https://${RUNTIME_HOST}/`;

// ----------------------------------------------------------- the model ---

const encoder = new TextEncoder();

/** Claude's stream for a reply, event by event — the shape the SDK reads. */
function sseEvents(text: string, size: number): string[] {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const events = [
    event('message_start', { type: 'message_start', message: { id: 'msg_showcase', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9000, output_tokens: 1 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let i = 0; i < text.length; i += size) events.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  events.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  events.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } }));
  events.push(event('message_stop', { type: 'message_stop' }));
  return events;
}

function streamed(events: string[], everyMs: number): Response {
  const stream = new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
        if (everyMs) await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_showcase' } });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Which page a request to the model is for, by the system prompt it carries. */
function replyFor(body: string): { text: string; size: number; everyMs: number } {
  if (/writing the explanation page of a research-paper reader/.test(body)) return { text: EXPLANATION, size: 180, everyMs: 22 };
  if (/writing the IMPLEMENTATION page of a research-paper reader/.test(body)) return { text: PLAN, size: 180, everyMs: 22 };
  if (/writing cells for a Jupyter notebook/.test(body)) return { text: NOTEBOOK, size: 120, everyMs: 18 };
  return { text: ANSWER, size: 40, everyMs: 28 };
}

const isModelUrl = (url: string) => url.startsWith('https://api.anthropic.com/') || /\/ai\/anthropic(\/|\?|$)/.test(url);
const isColabUrl = (url: string) => /\/colab\//.test(new URL(url, window.location.href).pathname);

// ----------------------------------------------------------- the runtime ---

/** The runtime's disk, as the contents route lists it. */
const DISK: Record<string, { name: string; path: string; type: 'file' | 'directory'; size: number | null; modified: string | null }[]> = {
  '': [
    { name: 'sample_data', path: 'sample_data', type: 'directory', size: null, modified: null },
    { name: 'attention.ipynb', path: 'attention.ipynb', type: 'file', size: 18_402, modified: new Date().toISOString() },
  ],
  sample_data: [{ name: 'README.md', path: 'sample_data/README.md', type: 'file', size: 930, modified: null }],
};

let kernelCount = 0;

function colabReply(path: string, method: string): Response {
  if (path.endsWith('/colab/runtimes') && method === 'POST') {
    return json({ runtime: { endpoint: 'm-s-showcase-t4', accelerator: 'T4', highMem: false, proxy: { url: RUNTIME_URL, token: 'showcase-proxy-token', expiresAt: Date.now() + 3_600_000 } } });
  }
  if (path.endsWith('/colab/runtimes/stop')) return json({ ok: true });
  if (path.endsWith('/colab/units')) return json({ balance: 0 });
  if (path.endsWith('/colab/kernels/list')) return json({ kernels: Array.from({ length: kernelCount }, (_, i) => ({ id: `showcase-kernel-${i + 1}` })) });
  if (path.endsWith('/colab/kernels') && method === 'POST') {
    kernelCount += 1;
    return json({ kernel: { id: `showcase-kernel-${kernelCount}` } });
  }
  if (path.endsWith('/colab/kernels/interrupt') || path.endsWith('/colab/kernels/restart')) return json({ ok: true });
  if (path.endsWith('/colab/contents')) return json({ path: '', entries: DISK[''] });
  if (path.endsWith('/colab/socket/ticket')) return json({ ticket: 'showcase-ticket' });
  return json({ error: `the stand-in has no ${method} ${path}` }, 500);
}

// ------------------------------------------------------------ the kernel ---

/** What a cell prints, by the marker on its first line (src/showcase/notebook.md); each line after a pause. */
const OUTPUTS: Record<string, { lines: string[]; everyMs?: number }> = {
  setup: { lines: ['device: cuda - Tesla T4', 'torch 2.4.1+cu121'] },
  attention: {
    lines: ['attention weights (rows sum to 1):', '[[0.41 0.12 0.27 0.2 ]', ' [0.09 0.62 0.11 0.18]', ' [0.22 0.15 0.49 0.14]', ' [0.17 0.3  0.08 0.45]]', 'output shape: (1, 4, 8)'],
  },
  heads: { lines: ['multi-head output: (2, 10, 512)', 'parameters: 1050624'] },
  train: { lines: Array.from({ length: 8 }, (_, i) => `step ${String((i + 1) * 50).padStart(4)}  loss=${(4.16 * Math.exp(-(i + 1) / 2.6) + 0.07).toFixed(3)}  ${((i + 1) * 1.9 + 0.4).toFixed(1).padStart(5)}s`), everyMs: 900 },
  eval: { lines: ['accuracy on held-out sequences: 99.2%', 'peak GPU memory: 318 MB'] },
};

/** How busy the machine is: a cell running pushes the numbers up, and they settle after. */
let busySince = 0;

function probeLine(): string {
  const t = busySince ? (Date.now() - busySince) / 1000 : 0;
  const busy = busySince ? Math.min(1, t / 3) : 0;
  const wave = 0.5 + 0.5 * Math.sin(t / 1.3);
  return JSON.stringify({
    gpu: `Tesla T4, ${Math.round(busy * (58 + 34 * wave))}, ${Math.round(412 + busy * (2600 + 500 * wave))}, 15360`,
    cpu: Math.round(6 + busy * (30 + 22 * (1 - wave))),
    cpus: 2,
    ram: [Math.round(1900 + busy * 1400), 13012],
    disk: [71, 78],
  });
}

function answerFor(code: string): { lines: string[]; everyMs: number; probe: boolean } {
  if (code.startsWith(MACHINE_PROBE.slice(0, 40))) return { lines: [probeLine()], everyMs: 0, probe: true };
  const marker = /#\s*showcase:\s*(\w+)/.exec(code);
  if (marker && OUTPUTS[marker[1]]) return { lines: OUTPUTS[marker[1]].lines, everyMs: OUTPUTS[marker[1]].everyMs ?? 120, probe: false };
  const printed = [...code.matchAll(/^print\((["'])(.*?)\1\)$/gm)].map((m) => m[2]);
  return { lines: printed.length ? printed : /^\s*$/.test(code) ? [] : ['ok'], everyMs: 60, probe: false };
}

interface KernelMessage {
  header: { msg_id: string; msg_type: string };
  content?: { code?: string };
}

let executionCount = 0;

/**
 * A kernel's socket: opens at once, answers kernel_info, and runs an
 * execute_request by printing the cell's lines one by one. Any other
 * address is handed to the real WebSocket.
 */
class ShowcaseSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  readonly url: string;
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private timers: number[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    window.setTimeout(() => {
      this.readyState = 1;
      const event = new Event('open');
      this.onopen?.(event);
      this.dispatchEvent(event);
    }, 60);
  }

  private emit(data: string) {
    if (this.readyState !== 1) return;
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  private reply(type: string, content: unknown, parent: string, channel = 'iopub') {
    const header = { msg_id: `k-${Math.random().toString(36).slice(2)}`, msg_type: type, session: 'showcase', username: 'kernel', version: '5.3', date: new Date().toISOString() };
    this.emit(JSON.stringify({ header, parent_header: { msg_id: parent }, metadata: {}, content, channel, buffers: [] }));
  }

  send(data: string) {
    let message: KernelMessage;
    try {
      message = JSON.parse(data) as KernelMessage;
    } catch {
      return;
    }
    const parent = message.header?.msg_id;
    if (message.header?.msg_type === 'kernel_info_request') {
      this.reply('kernel_info_reply', { status: 'ok', protocol_version: '5.3', implementation: 'showcase' }, parent, 'shell');
      return;
    }
    if (message.header?.msg_type !== 'execute_request') return;
    const { lines, everyMs, probe } = answerFor(String(message.content?.code ?? ''));
    if (!probe) busySince = Date.now();
    this.reply('status', { execution_state: 'busy' }, parent);
    let at = 0;
    const step = () => {
      if (at < lines.length) {
        this.reply('stream', { name: 'stdout', text: `${lines[at]}\n` }, parent);
        at += 1;
        this.timers.push(window.setTimeout(step, everyMs));
        return;
      }
      if (!probe) {
        executionCount += 1;
        busySince = 0;
      }
      this.reply('execute_reply', { status: 'ok', execution_count: probe ? undefined : executionCount }, parent, 'shell');
      this.reply('status', { execution_state: 'idle' }, parent);
    };
    this.timers.push(window.setTimeout(step, probe ? 0 : 250));
  }

  close() {
    this.readyState = 3;
    for (const timer of this.timers) window.clearTimeout(timer);
    const event = new Event('close');
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}

// ------------------------------------------------------------ install ---

let uninstall: (() => void) | null = null;

/**
 * Stands the model and Colab in. Returns the function that takes them out;
 * calling install again while installed is a no-op that returns the same.
 */
export function installReplay(): () => void {
  if (uninstall) return uninstall;
  const realFetch = window.fetch.bind(window);
  const RealSocket = window.WebSocket;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isModelUrl(url)) {
      const body = typeof init?.body === 'string' ? init.body : '';
      const { text, size, everyMs } = replyFor(body);
      return streamed(sseEvents(text, size), everyMs);
    }
    if (isColabUrl(url)) return colabReply(new URL(url, window.location.href).pathname, (init?.method ?? 'GET').toUpperCase());
    return realFetch(input, init);
  };
  window.WebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const href = String(url);
    return href.includes(RUNTIME_HOST) ? (new ShowcaseSocket(href) as unknown as WebSocket) : new RealSocket(url, protocols);
  } as unknown as typeof WebSocket;
  for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) Object.defineProperty(window.WebSocket, name, { value: RealSocket[name] });
  setReplaying(true);
  refreshKeys();
  setMachine({ accelerator: 'T4', highMem: false });
  uninstall = () => {
    window.fetch = realFetch;
    window.WebSocket = RealSocket;
    setReplaying(false);
    refreshKeys();
    uninstall = null;
  };
  return uninstall;
}

export { replaying };
