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
import { MACHINE_PROBE, parseMachineSample, specsOf } from './telemetry';
/** The machines the first-run card offers, and what each costs the person. */
export const MACHINES = [
    { accelerator: 'NONE', label: 'CPU only', note: 'free · starts in seconds' },
    { accelerator: 'T4', label: 'T4 GPU', note: 'free tier · when one is free' },
    { accelerator: 'L4', label: 'L4 GPU', note: 'Colab Pro · compute units' },
    { accelerator: 'A100', label: 'A100 GPU', note: 'Colab Pro+ · compute units' },
];
export const machineLabel = (machine) => `${machine.accelerator && machine.accelerator !== 'NONE' ? machine.accelerator : 'CPU'}${machine.highMem ? ' · high RAM' : ''}`;
// ------------------------------------------------------------ the store ----
const MACHINE_KEY = 'reader.colab.machine';
const NOTEBOOK_KEY = 'reader.colab.notebook';
const RUNTIME_KEY = 'reader.colab.runtime';
const GPU_KEY = 'reader.colab.gpu-watch';
const PULSE_KEY = 'reader.colab.pulse';
/** How much of the timeline is kept. */
export const HISTORY_MS = 10 * 60_000;
/** How often the machine is read between cells, by pulse: live is the watch's own cadence, so the meters are as current idle as they are while a cell runs. */
export const PULSE_MS = { live: 2000, slow: 30_000, off: 0 };
const isPulse = (value) => value === 'live' || value === 'slow' || value === 'off';
/** Once the page's own socket to a runtime has been refused, the proxy carries it from then on, in this tab. */
const VIA_KEY = 'reader.colab.via';
const read = (storage, key) => {
    try {
        const raw = storage?.getItem(key);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
};
const write = (storage, key, value) => {
    try {
        if (value === null || value === undefined)
            storage?.removeItem(key);
        else
            storage?.setItem(key, JSON.stringify(value));
    }
    catch {
        // private mode
    }
};
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
const isAccelerator = (value) => value === 'NONE' || value === 'T4' || value === 'L4' || value === 'A100';
const savedMachine = () => {
    const saved = read(local(), MACHINE_KEY);
    return { accelerator: isAccelerator(saved?.accelerator) ? saved.accelerator : 'NONE', highMem: Boolean(saved?.highMem) };
};
/**
 * One notebook id a browser: Colab keys an assignment by the notebook it is
 * for, so one id means one runtime however many pages run cells in it.
 */
function notebookId() {
    const saved = read(local(), NOTEBOOK_KEY);
    if (saved && /^[0-9a-f-]{36}$/i.test(saved))
        return saved;
    const made = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000';
    write(local(), NOTEBOOK_KEY, made);
    return made;
}
/**
 * A playground's own notebook id, so Colab gives it a machine of its own:
 * made from the playground's id, so it is the same in every browser the
 * account signs in to (and the same machine, while Colab keeps it), with
 * nothing to store. UUID-shaped, as Colab's assignment asks.
 */
export function playgroundNotebook(playgroundId) {
    const words = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => {
        let hash = seed >>> 0;
        for (const ch of `reader-playground:${playgroundId}`) {
            hash ^= ch.charCodeAt(0);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    });
    const hex = words.join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** The notebook a Colab backend's machine is assigned by: its own, or the browser's. */
const notebookOf = (backend) => (backend.kind === 'colab' ? backend.notebook ?? notebookId() : undefined);
/** The runtimes this tab holds, by notebook: the browser's under RUNTIME_KEY (as before), the playgrounds' own under RUNTIMES_KEY. */
const RUNTIMES_KEY = 'reader.colab.runtimes';
function readRuntime(notebook) {
    if (notebook === notebookId())
        return read(session(), RUNTIME_KEY) ?? undefined;
    return read(session(), RUNTIMES_KEY)?.[notebook];
}
function writeRuntime(notebook, runtime) {
    if (notebook === notebookId())
        return write(session(), RUNTIME_KEY, runtime);
    const all = { ...(read(session(), RUNTIMES_KEY) ?? {}) };
    if (runtime)
        all[notebook] = runtime;
    else
        delete all[notebook];
    write(session(), RUNTIMES_KEY, all);
}
/** Every runtime held under any notebook that is this machine (`endpoint`) let go — it stopped. */
function forgetRuntime(endpoint) {
    if (read(session(), RUNTIME_KEY)?.endpoint === endpoint)
        write(session(), RUNTIME_KEY, null);
    const all = read(session(), RUNTIMES_KEY) ?? {};
    write(session(), RUNTIMES_KEY, Object.fromEntries(Object.entries(all).filter(([, runtime]) => runtime.endpoint !== endpoint)));
    forgetColabKernels(endpoint);
}
const savedPulse = () => {
    const saved = read(local(), PULSE_KEY);
    return isPulse(saved) ? saved : 'live';
};
/** Whom a kernel is for: a playground, by its id, or the paper pages (Explain, Implementation, a paper's notebook), which share one. */
export const PAGES = 'pages';
const backendKey = (backend) => (backend.kind === 'colab' ? (backend.notebook ? `colab:${backend.notebook}` : 'colab') : `jupyter:${backend.server.id}`);
const sessionIdOf = (backend, scope) => `${backendKey(backend)}#${scope}`;
/** The kernel this tab keeps on each Jupyter server, by server and scope, so a reload — or a playground opened again — comes back to the same Python. */
const SERVER_KERNELS_KEY = 'reader.jupyter.kernels';
/** The kernels this tab keeps on its Colab runtimes, by the runtime's endpoint and then by scope; the machine watch's own is under MONITOR. */
const COLAB_KERNELS_KEY = 'reader.colab.kernels';
const MONITOR = '#monitor';
/** The paper pages' kernel is kept under the server's id alone, as it was before playgrounds had their own. */
const keptName = (serverId, scope) => (scope === PAGES ? serverId : `${serverId}#${scope}`);
function keptKernel(serverId, scope = PAGES) {
    return read(session(), SERVER_KERNELS_KEY)?.[keptName(serverId, scope)];
}
function keepKernel(serverId, scope, kernelId) {
    const all = { ...(read(session(), SERVER_KERNELS_KEY) ?? {}) };
    if (kernelId)
        all[keptName(serverId, scope)] = kernelId;
    else
        delete all[keptName(serverId, scope)];
    write(session(), SERVER_KERNELS_KEY, all);
}
const allColabKernels = () => {
    const kept = read(session(), COLAB_KERNELS_KEY) ?? {};
    // Kept by scope alone, before playgrounds had machines of their own: those are the browser's runtime's.
    if (Object.values(kept).some((value) => typeof value === 'string')) {
        const endpoint = read(session(), RUNTIME_KEY)?.endpoint;
        return endpoint ? { [endpoint]: kept } : {};
    }
    return kept;
};
function colabKernels(endpoint) {
    return allColabKernels()[endpoint] ?? {};
}
function keepColabKernel(endpoint, scope, kernelId) {
    const all = allColabKernels();
    const mine = { ...(all[endpoint] ?? {}) };
    if (kernelId)
        mine[scope] = kernelId;
    else
        delete mine[scope];
    write(session(), COLAB_KERNELS_KEY, { ...all, [endpoint]: mine });
}
function forgetColabKernels(endpoint) {
    const all = allColabKernels();
    delete all[endpoint];
    write(session(), COLAB_KERNELS_KEY, all);
}
/** What every session shares: the machine asked for on Colab, and the watch's switches. */
const shared = { machine: savedMachine(), gpuWatch: read(local(), GPU_KEY) !== false, pulse: savedPulse() };
function makeSession(backend, scope) {
    const id = sessionIdOf(backend, scope);
    const kept = backend.kind === 'jupyter' ? keptKernel(backend.server.id, scope) : undefined;
    return {
        id,
        scope,
        state: { id, scope, backend, status: 'off', kernel: kept, machine: backend.kind === 'colab' && backend.machine ? backend.machine : shared.machine, gpuWatch: shared.gpuWatch, history: [], pulse: shared.pulse, queue: [], paused: false },
        kernel: null,
        keys: new Set(),
        notebook: notebookOf(backend),
        watching: null,
        pulsing: null,
        resume: null,
        lastActivity: Date.now(),
    };
}
const sessions = new Map();
let current = makeSession({ kind: 'colab' }, PAGES);
sessions.set(current.id, current);
/** Every run, by key, from every session: the keys are a cell's own, so they never collide. */
let runs = {};
const listeners = new Set();
const compose = (s) => ({ ...s.state, runs });
let snapshot = compose(current);
let every = null;
const emit = () => {
    snapshot = compose(current);
    every = null;
    listeners.forEach((listener) => listener());
};
const set = (s, patch) => {
    s.state = { ...s.state, ...patch };
    emit();
};
const setRun = (s, key, run) => {
    s?.keys.add(key);
    runs = { ...runs, [key]: run };
    emit();
};
/** This session's runs, marked as from a kernel that is gone or was restarted. */
const staleRuns = (s, drop = () => false) => {
    const next = { ...runs };
    for (const key of s.keys) {
        const run = next[key];
        if (!run)
            continue;
        if (drop(run))
            delete next[key];
        else
            next[key] = { ...run, stale: true };
    }
    runs = next;
};
/** The foreground session: what the page's chip, panes and Run buttons are about. */
export const colabNow = () => snapshot;
/** Every session in this tab — the foreground and the ones behind it — as the store has them now. */
export const sessionsNow = () => (every ??= [...sessions.values()].map(compose));
export function subscribeColab(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
/** Whether cells can be run at all here: a proxy to reach Colab through, and a client ID to sign in with. */
export const colabAvailable = (clientId) => current.state.backend.kind === 'jupyter' || (hasProxy() && Boolean(clientId.trim()));
/** Whether the connected runtime is Colab's, so Colab's own page can be opened on it. */
export const onColab = () => current.state.backend.kind === 'colab';
/** The machine watch: the probe every couple of seconds in a second kernel while a cell runs, shown under the cell and in the chip. */
export function setGpuWatch(on) {
    write(local(), GPU_KEY, on);
    shared.gpuWatch = on;
    for (const s of sessions.values()) {
        s.state = { ...s.state, gpuWatch: on, sample: on ? s.state.sample : undefined };
        if (!on)
            stopWatching(s);
    }
    emit();
}
/** The kind of machine the foreground session asks for at its next connection (a playground's own, its own), and the default for the rest. */
export function setMachine(machine) {
    write(local(), MACHINE_KEY, machine);
    shared.machine = machine;
    current.state = { ...current.state, machine };
    emit();
}
/**
 * The key a run is kept under: the cell's code, so a cell that comes back
 * from a revision with other code has no run, and one with the same code
 * keeps its output.
 */
export function cellKey(code) {
    let hash = 2166136261;
    for (let i = 0; i < code.length; i += 1) {
        hash ^= code.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `c${(hash >>> 0).toString(36)}`;
}
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
/** A message as the default WebSocket subprotocol carries it: one JSON object with its channel named. */
export function makeMessage(msgType, content, sessionId, channel = 'shell') {
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
export const executeRequest = (code, sessionId) => makeMessage('execute_request', { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true }, sessionId);
export function parseMessage(text) {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.header?.msg_type)
            return null;
        return { ...parsed, channel: parsed.channel ?? 'iopub', content: parsed.content ?? {}, parent_header: parsed.parent_header ?? {}, metadata: parsed.metadata ?? {} };
    }
    catch {
        return null;
    }
}
// -------------------------------------------------------------- outputs ----
/** The most one cell's output may hold on the page; what comes after is cut, and the cut is said. */
export const OUTPUT_LIMIT = 200_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text) => text.replace(ANSI, '');
const asText = (value) => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '');
/**
 * What a message from the kernel adds to a cell's output. Text and pictures
 * only: a display with HTML or JavaScript in it is shown by its text/plain,
 * or not at all — kernel output is data, never markup on this page.
 */
export function reduceOutputs(outputs, message) {
    const { msg_type: type } = message.header;
    const content = message.content;
    if (type === 'stream') {
        const name = content.name === 'stderr' ? 'stderr' : 'stdout';
        const text = stripAnsi(asText(content.text));
        if (!text)
            return outputs;
        const last = outputs[outputs.length - 1];
        if (last?.type === 'stream' && last.name === name)
            return [...outputs.slice(0, -1), { ...last, text: last.text + text }];
        return [...outputs, { type: 'stream', name, text }];
    }
    if (type === 'display_data' || type === 'execute_result' || type === 'update_display_data') {
        const data = (content.data ?? {});
        const image = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'].find((mime) => typeof data[mime] === 'string' || Array.isArray(data[mime]));
        if (image && image !== 'image/svg+xml')
            return [...outputs, { type: 'image', mime: image, data: asText(data[image]).replace(/\s+/g, '') }];
        const text = stripAnsi(asText(data['text/plain']));
        if (text)
            return [...outputs, { type: 'text', text }];
        if (image)
            return [...outputs, { type: 'text', text: '[an SVG figure — shown in Colab, not here]' }];
        return outputs;
    }
    if (type === 'error') {
        const traceback = stripAnsi(Array.isArray(content.traceback) ? content.traceback.map(String).join('\n') : asText(content.traceback));
        return [...outputs, { type: 'error', ename: String(content.ename ?? 'Error'), evalue: String(content.evalue ?? ''), traceback }];
    }
    if (type === 'clear_output')
        return [];
    return outputs;
}
/** The cell's output as one piece of text, for the comparison and for a question to Claude. */
export function outputText(outputs) {
    return outputs
        .map((output) => (output.type === 'stream' || output.type === 'text' ? output.text : output.type === 'error' ? output.traceback || `${output.ename}: ${output.evalue}` : `[${output.mime}]`))
        .join('')
        .replace(/\s+$/, '');
}
/** The size of what is kept, so a cell that prints without end is cut off rather than kept whole. */
export const outputSize = (outputs) => outputs.reduce((sum, output) => sum + (output.type === 'image' ? output.data.length : outputText([output]).length), 0);
const normalise = (text) => text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
/**
 * Whether what ran printed what Claude wrote as the expected output. Spacing
 * is forgiven; anything else is a difference, which the page turns into a
 * question rather than a verdict of its own.
 */
export function compareOutput(expected, outputs) {
    if (expected === undefined || !expected.trim())
        return 'none';
    if (outputs.some((output) => output.type === 'error'))
        return 'differs';
    return normalise(expected) === normalise(outputText(outputs)) ? 'match' : 'differs';
}
/** The lines of the actual output that are not in the expected one, by index — the ones to tint. */
export function differingLines(expected, actual) {
    const wanted = new Set(normalise(expected ?? '').split('\n'));
    const lines = actual.split('\n');
    const marked = new Set();
    lines.forEach((line, index) => {
        const clean = line.replace(/\s+/g, ' ').trim();
        if (clean && !wanted.has(clean))
            marked.add(index);
    });
    return marked;
}
// ----------------------------------------------------------- the relay ----
class ColabRequestError extends Error {
    status;
    flags;
    constructor(status, message, flags = {}) {
        super(message);
        this.status = status;
        this.flags = flags;
        this.name = 'ColabRequestError';
    }
}
async function relay(path, googleToken, init = {}) {
    const response = await apiFetch(path, {
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', 'X-Google-Token': googleToken, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const body = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new ColabRequestError(response.status, body.error || `The proxy answered ${response.status}.`, { reauth: body.reauth, gone: body.gone, limit: body.limit });
    return body;
}
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
    proxy;
    id;
    onClose;
    ticket;
    onLink;
    socket = null;
    sessionId = uuid();
    waiting = new Map();
    /** The cells running, each told when the socket closes under it. */
    closers = new Set();
    keepAlive = null;
    lastKeepAlive = null;
    reconnecting = null;
    /** Closed on purpose: no reconnecting. */
    ended = false;
    /** How the socket got there: straight to the runtime, or carried by the proxy. */
    via = 'direct';
    constructor(proxy, id, onClose, 
    /** A ticket for the proxy to carry this kernel's socket, when the runtime will not take the page's own. */
    ticket, 
    /** Told when the socket drops and when it is back. */
    onLink) {
        this.proxy = proxy;
        this.id = id;
        this.onClose = onClose;
        this.ticket = ticket;
        this.onLink = onLink;
    }
    get connected() {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }
    /**
     * A kernel_info_request every KEEPALIVE_MS, so the socket is never silent
     * long enough for anything on the way to give it up. The reply is not
     * waited on — while a cell runs the kernel answers after it — only dropped
     * when it comes, and its handler goes with the next request.
     */
    startKeepAlive() {
        this.stopKeepAlive();
        this.keepAlive = window.setInterval(() => {
            const socket = this.socket;
            if (!socket || socket.readyState !== WebSocket.OPEN)
                return;
            if (this.lastKeepAlive)
                this.waiting.delete(this.lastKeepAlive);
            const request = makeMessage('kernel_info_request', {}, this.sessionId);
            this.lastKeepAlive = request.header.msg_id;
            this.waiting.set(request.header.msg_id, (message) => {
                if (message.header.msg_type === 'kernel_info_reply')
                    this.waiting.delete(request.header.msg_id);
            });
            try {
                socket.send(JSON.stringify(request));
            }
            catch {
                // closing; the close event follows
            }
        }, KEEPALIVE_MS);
    }
    stopKeepAlive() {
        if (this.keepAlive !== null)
            window.clearInterval(this.keepAlive);
        this.keepAlive = null;
    }
    /**
     * The socket again, to the same kernel, after it closed on its own: a
     * few tries, a growing wait apart. A runtime that is gone — Colab says so
     * when the proxy asks for a ticket — is not tried again. When no try
     * opens one, the kernel is given up and `onClose` says why.
     */
    reconnect(reason) {
        if (this.reconnecting)
            return this.reconnecting;
        this.onLink?.('reconnecting');
        this.reconnecting = (async () => {
            let why = reason;
            for (const wait of RECONNECT_WAITS_MS) {
                await new Promise((resolve) => window.setTimeout(resolve, wait));
                if (this.ended)
                    return;
                try {
                    await this.connect();
                    this.reconnecting = null;
                    this.onLink?.('open');
                    return;
                }
                catch (error) {
                    why = message(error);
                    if (error instanceof ColabRequestError && error.flags.gone)
                        break;
                }
            }
            this.reconnecting = null;
            if (!this.ended)
                this.onClose(why);
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
    async connect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN)
            return;
        const remembered = read(session(), VIA_KEY);
        if (remembered !== 'proxy') {
            try {
                await this.open(this.directUrl(), null);
                this.via = 'direct';
                return;
            }
            catch (error) {
                if (!this.ticket || !hasProxy())
                    throw error;
            }
        }
        if (!this.ticket)
            throw new Error('The runtime would not take a connection from this page, and there is no proxy to carry one.');
        const ticket = await this.ticket(this.id, this.sessionId);
        const bridge = new URL(api('/colab/socket'), window.location.href);
        bridge.protocol = bridge.protocol === 'http:' ? 'ws:' : 'wss:';
        bridge.searchParams.set('ticket', ticket);
        await this.open(bridge.href, JSON.stringify({ type: 'hello', token: this.proxy.token }));
        this.via = 'proxy';
        write(session(), VIA_KEY, 'proxy');
    }
    directUrl() {
        const url = new URL(`api/kernels/${encodeURIComponent(this.id)}/channels`, this.proxy.url);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        url.searchParams.set('session_id', this.sessionId);
        if (this.proxy.kind === 'jupyter') {
            if (this.proxy.token)
                url.searchParams.set('token', this.proxy.token);
        }
        else
            url.searchParams.set('colab-runtime-proxy-token', this.proxy.token);
        return url.href;
    }
    /**
     * Opens one socket. With a `hello`, it is the proxy's bridge: the hello
     * goes first, and the socket counts as open when the bridge says the
     * runtime is on the other end.
     */
    open(href, hello) {
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
                if (hello)
                    socket.send(hello);
                else
                    settle();
            });
            socket.addEventListener('message', (event) => {
                if (typeof event.data !== 'string')
                    return;
                if (!ready) {
                    // The bridge's own word, before the kernel's: ready, or why not.
                    try {
                        const note = JSON.parse(event.data);
                        if (note?.type === 'ready') {
                            settle();
                            return;
                        }
                    }
                    catch {
                        // the kernel's, then
                    }
                }
                const message = parseMessage(event.data);
                if (!message)
                    return;
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
                for (const close of [...this.closers])
                    close();
                if (!opened || !ready)
                    reject(new Error(`The runtime closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ''}).`));
                else if (mine && !this.ended)
                    void this.reconnect(event.reason || `closed (${event.code})`);
            });
            this.socket = socket;
        });
    }
    /**
     * Runs code and resolves when the kernel says it is done, calling `onOutput`
     * for each message meant for this request on the way. The reply's status
     * says whether it ended in an error; the count is In [n].
     */
    async execute(code, onOutput) {
        // A cell run while the socket is being opened again waits for it, rather than failing for a pipe that is a moment away.
        if (!this.connected && this.reconnecting)
            await this.reconnecting.catch(() => undefined);
        return new Promise((resolve, reject) => {
            const socket = this.socket;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                reject(new Error('The kernel is not connected.'));
                return;
            }
            const request = executeRequest(code, this.sessionId);
            let reply = null;
            let idle = false;
            const finish = () => {
                if (!reply || !idle)
                    return;
                this.waiting.delete(request.header.msg_id);
                this.closers.delete(closed);
                resolve(reply);
            };
            const closed = () => {
                this.waiting.delete(request.header.msg_id);
                this.closers.delete(closed);
                reject(new Error('The connection to the runtime closed while the cell was running.'));
            };
            this.closers.add(closed);
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
        // A cell running when the socket is closed on purpose ends now, as stopped, rather than waiting for ever.
        for (const close of [...this.closers])
            close();
        socket?.close();
    }
}
export class JupyterRequestError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'JupyterRequestError';
    }
}
/** The server's base URL with a trailing slash, for `new URL(path, base)`. */
export const serverBase = (url) => (url.endsWith('/') ? url : `${url}/`);
/** A request to a Jupyter server of the person's own, with its token; JSON back. */
export async function jupyterFetch(server, path, init = {}) {
    const url = new URL(path, serverBase(server.url));
    let response;
    try {
        response = await fetch(url.href, {
            method: init.method ?? 'GET',
            // Never from the browser's cache: Jupyter answers with Last-Modified and no Cache-Control, so a
            // browser (Safari, above all) may hand back a file or a folder listing as it was minutes ago.
            cache: 'no-store',
            headers: { Accept: 'application/json', ...(server.token ? { Authorization: `token ${server.token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
    }
    catch {
        throw new JupyterRequestError(0, `Could not reach ${url.origin}. Is the Jupyter server running, and started with --ServerApp.allow_origin set to this site?`);
    }
    if (response.status === 204)
        return undefined;
    const body = (await response.json().catch(() => ({})));
    if (response.status === 401 || response.status === 403)
        throw new JupyterRequestError(response.status, `${url.origin} refused the token (${response.status}).`);
    if (!response.ok)
        throw new JupyterRequestError(response.status, body.message || `${url.origin} answered ${response.status}.`);
    return body;
}
const entryOf = (model) => ({ name: model.name, path: model.path, type: model.type, size: model.size ?? null, modified: model.last_modified ?? null });
const contentsUrl = (path) => `api/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
/** What is under `path` on a Jupyter server, folders first. */
export async function jupyterList(server, path = '') {
    const model = await jupyterFetch(server, `${contentsUrl(path)}?type=directory&content=1`);
    const entries = (Array.isArray(model.content) ? model.content : []).map(entryOf);
    entries.sort((a, b) => (a.type === 'directory') === (b.type === 'directory') ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
    return { path: model.path ?? path, entries };
}
/** A text file on a Jupyter server; null when there is none. */
export async function jupyterRead(server, path) {
    try {
        const model = await jupyterFetch(server, `${contentsUrl(path)}?type=file&format=text&content=1`);
        return { text: typeof model.content === 'string' ? model.content : '', modified: model.last_modified ?? null };
    }
    catch (error) {
        if (error instanceof JupyterRequestError && (error.status === 404 || error.status === 400))
            return null;
        throw error;
    }
}
/** Writes a text file on a Jupyter server, making the folders on the way. */
/** A file on a Jupyter server as base64, whatever it holds: a figure, a font. */
export async function jupyterReadBase64(server, path) {
    const model = await jupyterFetch(server, `${contentsUrl(path)}?type=file&format=base64&content=1`);
    return typeof model.content === 'string' ? model.content.replace(/\s+/g, '') : '';
}
export async function jupyterWrite(server, path, text) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        try {
            await jupyterFetch(server, contentsUrl(dir), { method: 'PUT', body: { type: 'directory' } });
        }
        catch (error) {
            // 409 and the like: there already
            if (!(error instanceof JupyterRequestError) || error.status === 0 || error.status === 401 || error.status === 403)
                throw error;
        }
    }
    const model = await jupyterFetch(server, contentsUrl(path), { method: 'PUT', body: { type: 'file', format: 'text', content: text } });
    return { modified: model?.last_modified ?? null };
}
/** Writes a file of any kind on a Jupyter server, given as base64 (an image, a PDF), making the folders on the way. */
export async function jupyterWriteBase64(server, path, base64) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
        await jupyterFetch(server, contentsUrl(parts.slice(0, i).join('/')), { method: 'PUT', body: { type: 'directory' } }).catch((error) => {
            if (!(error instanceof JupyterRequestError) || error.status === 0 || error.status === 401 || error.status === 403)
                throw error;
        });
    }
    await jupyterFetch(server, contentsUrl(path), { method: 'PUT', body: { type: 'file', format: 'base64', content: base64 } });
}
/** Makes a folder on a Jupyter server. */
export async function jupyterMkdir(server, path) {
    await jupyterFetch(server, contentsUrl(path), { method: 'PUT', body: { type: 'directory' } });
}
/** A file or folder on a Jupyter server, deleted (a folder with what is in it). */
export async function jupyterDelete(server, path) {
    await jupyterFetch(server, contentsUrl(path), { method: 'DELETE' });
}
/** A file or folder on a Jupyter server, renamed or moved within it. */
export async function jupyterRename(server, from, to) {
    await jupyterFetch(server, contentsUrl(from), { method: 'PATCH', body: { path: to.split('/').filter(Boolean).join('/') } });
}
/** Whether a Jupyter server answers with this token: its version, or why not. */
export async function checkJupyter(server) {
    try {
        const about = await jupyterFetch(server, 'api');
        await jupyterFetch(server, 'api/kernels');
        return { ok: true, version: about?.version };
    }
    catch (error) {
        return { ok: false, error: message(error) };
    }
}
const runtimeOfServer = (server) => ({
    endpoint: `jupyter:${server.id}`,
    accelerator: null,
    highMem: false,
    proxy: { url: serverBase(server.url), token: server.token, expiresAt: Number.MAX_SAFE_INTEGER, kind: 'jupyter' },
});
function jupyterHost(server) {
    return {
        runtime: runtimeOfServer(server),
        listKernels: () => jupyterFetch(server, 'api/kernels'),
        startKernel: async () => (await jupyterFetch(server, 'api/kernels', { method: 'POST', body: { name: 'python3' } })).id,
        interrupt: async (id) => {
            await jupyterFetch(server, `api/kernels/${encodeURIComponent(id)}/interrupt`, { method: 'POST', body: {} });
        },
        restart: async (id) => {
            await jupyterFetch(server, `api/kernels/${encodeURIComponent(id)}/restart`, { method: 'POST', body: {} });
        },
        contents: (path) => jupyterList(server, path),
    };
}
/** Colab's runtime as a host: each call through the proxy, with the Google token `token` gives. */
function colabHost(runtime, token) {
    return {
        runtime,
        listKernels: async () => (await relay('/colab/kernels/list', await token(), { method: 'POST', body: { proxy: runtime.proxy } })).kernels ?? [],
        startKernel: async () => (await relay('/colab/kernels', await token(), { method: 'POST', body: { proxy: runtime.proxy } })).kernel.id,
        interrupt: async (id) => {
            await relay('/colab/kernels/interrupt', await token(), { method: 'POST', body: { proxy: runtime.proxy, kernel: id } });
        },
        restart: async (id) => {
            await relay('/colab/kernels/restart', await token(), { method: 'POST', body: { proxy: runtime.proxy, kernel: id } });
        },
        contents: async (path) => relay('/colab/contents', await token(), { method: 'POST', body: { proxy: runtime.proxy, path } }),
        ticket: async (kernelId, sessionId) => (await relay('/colab/socket/ticket', await token(), { method: 'POST', body: { proxy: { url: runtime.proxy.url }, kernel: kernelId, session: sessionId } })).ticket,
    };
}
/** The Google token without a window: for the readings, which must never open one. */
async function quietToken() {
    const held = await colabToken(clientIdNow);
    if (!held)
        throw new Error('Not connected to Colab.');
    return held;
}
/** The host a session's runtime is on; null when nothing is connected. `quiet`: never open Google's window for it. */
function hostOf(s, quiet = false) {
    const runtime = s.state.runtime;
    if (!runtime)
        return null;
    if (s.state.backend.kind === 'jupyter')
        return jupyterHost(s.state.backend.server);
    return colabHost(runtime, quiet ? quietToken : tokenOrConnect);
}
// ------------------------------------------------------------ the actions --
let clientIdNow = '';
const SAMPLE_EVERY_MS = 2000;
function stopWatching(s) {
    if (s.watching !== null)
        window.clearTimeout(s.watching);
    s.watching = null;
}
/**
 * The monitor kernels — a second, small kernel on each machine for the watch
 * and the page's own housekeeping, so a probe never waits on a cell — by the
 * runtime they are on, shared by the sessions there.
 */
const monitors = new Map();
/** A monitor being started, so two askers at once — the reading on connect and the watch of a first run — share one, not start two. */
const startingMonitors = new Map();
/** The monitor kernel on `host`'s machine, started on first need. Null when it could not be had — the watch is a reading, not the work. */
function ensureMonitor(host) {
    const endpoint = host.runtime.endpoint;
    const held = monitors.get(endpoint);
    if (held)
        return Promise.resolve(held);
    const starting = startingMonitors.get(endpoint);
    if (starting)
        return starting;
    const made = (async () => {
        try {
            const keptId = host.runtime.proxy.kind === 'jupyter' ? undefined : colabKernels(endpoint)[MONITOR];
            const listed = keptId ? await host.listKernels().catch(() => null) : null;
            const id = keptId && listed?.some((k) => k.id === keptId) ? keptId : await host.startKernel();
            if (host.runtime.proxy.kind !== 'jupyter')
                keepColabKernel(endpoint, MONITOR, id);
            const attached = new Kernel(host.runtime.proxy, id, () => {
                if (monitors.get(endpoint) === attached)
                    monitors.delete(endpoint);
            }, host.ticket);
            await attached.connect();
            monitors.set(endpoint, attached);
            return attached;
        }
        catch {
            return null;
        }
        finally {
            startingMonitors.delete(endpoint);
        }
    })();
    startingMonitors.set(endpoint, made);
    return made;
}
/** Closes the monitor on a machine no session is connected to any more. */
function releaseMonitor(endpoint) {
    if (!endpoint)
        return;
    if ([...sessions.values()].some((s) => s.kernel && s.state.runtime?.endpoint === endpoint))
        return;
    monitors.get(endpoint)?.close();
    monitors.delete(endpoint);
}
/** One reading of the machine from its monitor kernel; null when the probe could not run or printed nothing readable. */
async function takeSample(monitor, t) {
    let text = '';
    try {
        await monitor.execute(MACHINE_PROBE, (incoming) => {
            if (incoming.header.msg_type === 'stream')
                text += asText(incoming.content.text);
        });
    }
    catch {
        return null;
    }
    return parseMachineSample(text, t);
}
/** A sample onto a session: the last reading, the machine's specs from it, and the timeline, kept to the last while. */
const keepSample = (s, sample) => {
    const at = Date.now();
    const history = [...s.state.history.filter((entry) => at - entry.at <= HISTORY_MS), { at, sample }];
    set(s, { sample, specs: { ...s.state.specs, ...specsOf(sample) }, history });
};
/** The session for a scope: the foreground one when it is that scope's, else the scope's connected one. */
const sessionOfScope = (scope) => !scope || current.scope === scope ? current : [...sessions.values()].find((s) => s.scope === scope && s.kernel) ?? [...sessions.values()].find((s) => s.scope === scope);
/**
 * Runs code in the monitor kernel — the small second one — and gives back
 * what it printed. For the page's own housekeeping (a file written into the
 * runtime, a listing, a coding agent's job), never for a cell: those run in
 * the kernel the person sees. On the foreground session's machine, or on the
 * machine of `scope`'s session (a playground's, from anywhere). Null when
 * there is no runtime to run it in.
 */
export async function runQuietly(code, scope) {
    const s = sessionOfScope(scope);
    const host = s ? hostOf(s, true) : null;
    const monitor = host ? await ensureMonitor(host) : null;
    if (!monitor)
        return null;
    let text = '';
    let failed = false;
    const reply = await monitor.execute(code, (incoming) => {
        const type = incoming.header.msg_type;
        if (type === 'stream')
            text += asText(incoming.content.text);
        else if (type === 'error') {
            failed = true;
            text += `${asText(incoming.content.ename)}: ${asText(incoming.content.evalue)}`;
        }
    });
    return { ok: !failed && reply.status === 'ok', text };
}
// ------------------------------------------------------------ idle pulse ---
function stopPulse(s) {
    if (s.pulsing !== null)
        window.clearTimeout(s.pulsing);
    s.pulsing = null;
}
/** The machine read between cells at the pulse's cadence, while the foreground runtime is idle; the watch takes over while a cell runs. */
function schedulePulse(s) {
    stopPulse(s);
    const every = PULSE_MS[s.state.pulse];
    if (s !== current || !every || !s.state.gpuWatch || s.state.status !== 'idle')
        return;
    s.pulsing = window.setTimeout(() => {
        s.pulsing = null;
        void probeSession(s).finally(() => schedulePulse(s));
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
 * Only the foreground session pulses: the ones behind it are read while
 * their cells run.
 */
export function setPulse(pulse) {
    write(local(), PULSE_KEY, pulse);
    shared.pulse = pulse;
    for (const s of sessions.values())
        s.state = { ...s.state, pulse };
    emit();
    schedulePulse(current);
}
/**
 * While `key` runs: the probe in the monitor kernel every couple of seconds,
 * each sample onto the run and into the session. Any failure ends the watch
 * quietly.
 */
async function watchMachine(s, key, host, started) {
    if (!s.state.gpuWatch)
        return;
    const monitor = await ensureMonitor(host);
    if (!monitor)
        return;
    const tick = async () => {
        if (s.state.running !== key)
            return;
        const sample = await takeSample(monitor, Math.round((Date.now() - started) / 100) / 10);
        if (sample && s.state.running === key) {
            const run = runs[key];
            if (run)
                setRun(s, key, { ...run, samples: [...(run.samples ?? []), sample] });
            keepSample(s, sample);
        }
        if (s.state.running === key)
            s.watching = window.setTimeout(() => void tick(), SAMPLE_EVERY_MS);
    };
    s.watching = window.setTimeout(() => void tick(), 400);
}
/** One reading of a session's machine now, between its cells. */
async function probeSession(s) {
    if (!s.state.runtime || !s.state.gpuWatch || s.state.running || s.state.status !== 'idle')
        return null;
    try {
        const host = hostOf(s, true);
        const monitor = host ? await ensureMonitor(host) : null;
        if (!monitor)
            return null;
        const sample = await takeSample(monitor, 0);
        if (sample)
            keepSample(s, sample);
        return sample;
    }
    catch {
        return null;
    }
}
/**
 * One reading of the runtime's machine now, between cells: what it is and
 * how busy it is. Taken as the runtime connects when the watch is on, and
 * on request from the Implementation page's Colab panel. Nothing while a
 * cell runs — the watch is already sampling.
 */
export const probeMachine = () => probeSession(current);
const message = (error) => (error instanceof Error ? error.message : String(error));
/** Remembers the client ID the page is signed in with, for the quiet renewals. */
export const useClient = (clientId) => {
    clientIdNow = clientId;
};
async function tokenOrConnect() {
    if (!clientIdNow)
        throw new Error('Google sign-in is not set up: Settings → Google needs a client ID.');
    const held = await colabToken(clientIdNow);
    if (held)
        return held;
    return connectColab(clientIdNow);
}
/** Where a run says it happened: the machine, from the runtime — or the Jupyter server, by the name it was given. */
const whereOf = (s, runtime) => (s.state.backend.kind === 'jupyter' ? `${s.state.backend.server.name}${s.state.specs?.gpuName ? ` · ${s.state.specs.gpuName}` : ''}` : `Colab · ${machineLabel(runtime)}`);
/** What the kernel is on, in a few words: "Colab · T4", "This PC". */
export const backendLabel = (backend = current.state.backend, runtime = current.state.runtime) => (backend.kind === 'jupyter' ? backend.server.name : runtime ? `Colab · ${machineLabel(runtime)}` : 'Colab');
/** Closes a session's socket to its kernel; the kernel itself stays on its machine. */
const closeKernel = (s) => {
    stopWatching(s);
    stopPulse(s);
    const endpoint = s.state.runtime?.endpoint;
    s.kernel?.close();
    s.kernel = null;
    releaseMonitor(endpoint);
};
/** Wakes a paused Run all of a session, so it can see it was stopped. */
const wake = (s) => {
    s.resume?.();
    s.resume = null;
};
const lost = (s, reason) => {
    closeKernel(s);
    if (s.state.backend.kind === 'colab')
        writeRuntime(s.notebook ?? notebookOf(s.state.backend), null);
    const next = { ...runs };
    for (const key of s.keys) {
        const run = next[key];
        if (!run)
            continue;
        if (run.state === 'queued')
            delete next[key];
        else
            next[key] = run.state === 'running' ? { ...run, state: 'interrupted', stale: true, ms: Date.now() - run.startedAt } : { ...run, stale: true };
    }
    runs = next;
    set(s, { status: 'lost', kernel: undefined, running: undefined, error: reason, sample: undefined, reconnecting: false, queue: [], paused: false });
    wake(s);
};
async function attach(s, host) {
    // The session's kernel, if the machine still has it — a second kernel would be a second Python with none of the first's variables.
    const listed = await host.listKernels().catch(() => null);
    const has = (id) => Boolean(id && listed?.some((k) => k.id === id));
    let id;
    if (s.state.backend.kind === 'jupyter')
        id = has(s.state.kernel) ? s.state.kernel : undefined;
    else {
        const kept = colabKernels(host.runtime.endpoint);
        id = has(s.state.kernel) ? s.state.kernel : has(kept[s.scope]) ? kept[s.scope] : undefined;
        // The paper pages' kernel from before kernels were kept by scope: the runtime's first, if no other scope claims it.
        if (!id && s.scope === PAGES && !Object.keys(kept).length)
            id = listed?.[0]?.id;
    }
    if (!id)
        id = await host.startKernel();
    if (s.state.backend.kind === 'colab')
        keepColabKernel(host.runtime.endpoint, s.scope, id);
    const attached = new Kernel(host.runtime.proxy, id, (reason) => {
        if (s.kernel === attached)
            lost(s, `The connection to the runtime closed and could not be opened again: ${reason}`);
    }, host.ticket, (link) => {
        if (s.kernel === attached)
            set(s, { reconnecting: link === 'reconnecting', via: attached.via });
    });
    await attached.connect();
    return attached;
}
/** The kernel this tab keeps on a Jupyter server for a scope — its variables in it — if it keeps one. */
export const keptKernelFor = (serverId, scope = PAGES) => keptKernel(serverId, scope);
const sameBackend = (a, b) => (a.kind === 'colab' ? b.kind === 'colab' && (a.notebook ?? '') === (b.notebook ?? '') : b.kind === 'jupyter' && a.server.id === b.server.id && a.server.url === b.server.url && a.server.token === b.server.token);
/** The session for a backend and a scope, made if there is none; the foreground stays as it is. */
function sessionFor(backend, scope) {
    const id = sessionIdOf(backend, scope);
    let s = sessions.get(id);
    if (s && !sameBackend(s.state.backend, backend)) {
        // The same server under a new address or token: what is held for the old one is let go.
        if (!s.state.running && !s.state.queue.length) {
            closeKernel(s);
            sessions.delete(id);
            s = undefined;
        }
    }
    if (!s) {
        s = makeSession(backend, scope);
        sessions.set(id, s);
    }
    else if (backend.kind === 'jupyter' && s.state.backend.kind === 'jupyter' && backend.server.name !== s.state.backend.server.name) {
        s.state = { ...s.state, backend };
    }
    else if (backend.kind === 'colab' && backend.machine && backend.machine.accelerator !== s.state.machine.accelerator) {
        // The kind of machine asked for, at the next connection; one already up is changed from the machine menu.
        s.state = { ...s.state, backend, machine: backend.machine };
    }
    return s;
}
/**
 * Where the next cell runs, and for whom: Colab or a Jupyter server of the
 * person's, for a playground (its id) or the paper pages. That session — its
 * kernel, if it has one already — becomes the foreground; the one that was
 * is left as it is, running or not, its kernel still connected.
 */
export function chooseBackend(backend, scope = PAGES) {
    const s = sessionFor(backend, scope);
    if (s !== current) {
        stopPulse(current);
        current = s;
        schedulePulse(s);
    }
    // A scope moved to another machine: its session on the old one, if nothing runs there, is let go (its kernel stays
    // on that machine, kept for the scope). One still running is left to finish.
    for (const other of [...sessions.values()]) {
        if (other !== s && other.scope === scope && !other.state.running && !other.state.queue.length) {
            closeKernel(other);
            sessions.delete(other.id);
        }
    }
    emit();
}
/** The runtime a Colab session holds now for a notebook, so another scope on the same machine joins it. */
const colabRuntimeHeld = (notebook) => [...sessions.values()].find((s) => s.notebook === notebook && s.state.runtime && s.kernel)?.state.runtime;
/**
 * A runtime and a kernel, from what is held or afresh. On Colab: Google's
 * window if Colab was never connected in this tab, then Colab's assignment
 * for this browser's notebook, then a WebSocket to its kernel. On a Jupyter
 * server: its kernel — the one this tab started there before, or a new one.
 */
export const connect = (machine = current.state.machine) => connectSession(current, machine);
async function connectSession(s, machine = s.state.machine) {
    if (s.state.status === 'connecting')
        return;
    if (s.state.backend.kind === 'jupyter') {
        const { server } = s.state.backend;
        set(s, { status: 'connecting', error: undefined });
        try {
            const host = jupyterHost(server);
            closeKernel(s);
            if (!s.state.kernel)
                s.state = { ...s.state, kernel: keptKernel(server.id, s.scope) };
            s.kernel = await attach(s, host);
            keepKernel(server.id, s.scope, s.kernel.id);
            const same = s.state.runtime?.endpoint === host.runtime.endpoint;
            set(s, { status: 'idle', runtime: host.runtime, kernel: s.kernel.id, via: 'direct', reconnecting: false, startedAt: same && s.state.startedAt ? s.state.startedAt : Date.now(), error: undefined, history: same ? s.state.history : [] });
            void probeSession(s).finally(() => schedulePulse(s));
        }
        catch (error) {
            set(s, { status: s.state.runtime ? 'lost' : 'error', error: message(error) });
            throw error;
        }
        return;
    }
    set(s, { status: 'connecting', error: undefined, machine });
    write(local(), MACHINE_KEY, machine);
    try {
        const googleToken = await tokenOrConnect();
        const own = notebookOf(s.state.backend);
        const usable = (runtime) => (runtime && runtime.proxy.expiresAt > Date.now() + 60_000 && runtime.proxy.kind !== 'jupyter' ? runtime : undefined);
        /** The runtime for a notebook: the one held, or the one Colab has for it (or starts now). */
        const runtimeFor = async (notebook) => {
            const held = usable((s.notebook === notebook ? s.state.runtime : undefined) ?? colabRuntimeHeld(notebook) ?? readRuntime(notebook));
            if (held)
                return held;
            const made = (await relay('/colab/runtimes', googleToken, { method: 'POST', body: { notebook, accelerator: machine.accelerator, highMem: Boolean(machine.highMem) } })).runtime;
            // A machine new to this tab: no kernels are kept on it yet.
            forgetColabKernels(made.endpoint);
            return made;
        };
        let runtime;
        let notebook = own;
        let sharing;
        try {
            runtime = await runtimeFor(own);
        }
        catch (error) {
            // The tier allows no more machines at once: this one runs on the browser's machine, beside the paper pages, and says so.
            if (!(error instanceof ColabRequestError && error.flags.limit) || own === notebookId())
                throw error;
            notebook = notebookId();
            runtime = await runtimeFor(notebook);
            sharing = 'Colab allows no more machines at once on your plan, so this playground shares your other Colab machine for now. Stop one in Colab (Runtime → Manage sessions), then reconnect, for a machine of its own.';
        }
        closeKernel(s);
        s.notebook = notebook;
        s.kernel = await attach(s, colabHost(runtime, tokenOrConnect));
        writeRuntime(notebook, runtime);
        const same = s.state.runtime?.endpoint === runtime.endpoint;
        set(s, { status: 'idle', runtime, kernel: s.kernel.id, via: s.kernel.via, reconnecting: false, startedAt: same && s.state.startedAt ? s.state.startedAt : Date.now(), error: undefined, history: same ? s.state.history : [], sharing });
        void refreshUnits(googleToken);
        // What the machine is, read once as it connects, so the page can say so before anything runs; then the pulse, if it is on.
        void probeSession(s).finally(() => schedulePulse(s));
    }
    catch (error) {
        const flags = error instanceof ColabRequestError ? error.flags : {};
        if (flags.gone) {
            lost(s, 'Colab has ended that runtime.');
            if (s.state.runtime)
                forgetRuntime(s.state.runtime.endpoint);
            writeRuntime(s.notebook ?? notebookOf(s.state.backend), null);
            set(s, { runtime: undefined });
            return;
        }
        if (flags.reauth)
            dropColab();
        set(s, { status: s.state.runtime ? 'lost' : 'off', error: message(error) });
        throw error;
    }
}
async function refreshUnits(googleToken) {
    try {
        const units = await relay('/colab/units', googleToken);
        const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
        const now = { balance: number(units.balance ?? units.ccuBalance ?? units.remaining), ratePerHour: number(units.ratePerHour ?? units.consumptionRate ?? units.rate) };
        for (const s of sessions.values())
            if (s.state.backend.kind === 'colab')
                s.state = { ...s.state, units: now };
        emit();
    }
    catch {
        // Colab did not say; the menu shows the tier instead.
    }
}
/** When the foreground session's last cell finished, or started: the idle stop counts from here. */
export const lastActivityAt = () => current.lastActivity;
/**
 * Runs one cell — the code as shown — in the foreground session's kernel,
 * and keeps what it prints under `key`. Connects first when there is
 * nothing to run in, which is the one place Google's window can open, so
 * this is called from a click. The run belongs to its session: it goes on,
 * and is kept, whatever the page shows next.
 */
export const runCell = (key, code) => runIn(current, key, code);
/** Runs one cell in a scope's own kernel on `backend` — a playground's, from a page that is not it — without bringing it to the foreground. */
export const runCellFor = (backend, scope, key, code) => runIn(sessionFor(backend, scope), key, code);
async function runIn(s, key, code) {
    if (s.state.running)
        return;
    if (!s.kernel || s.state.status === 'off' || s.state.status === 'lost' || s.state.status === 'error')
        await connectSession(s, s.state.machine);
    const runtime = s.state.runtime;
    const kernel = s.kernel;
    if (!kernel || !runtime)
        return;
    const started = Date.now();
    s.lastActivity = started;
    const where = whereOf(s, runtime);
    stopPulse(s);
    set(s, { status: 'busy', running: key });
    setRun(s, key, { state: 'running', outputs: [], startedAt: started, where });
    const host = hostOf(s, true);
    if (s.state.gpuWatch && host)
        void watchMachine(s, key, host, started).catch(() => undefined);
    let outputs = [];
    let cut = false;
    try {
        const reply = await kernel.execute(code, (incoming) => {
            if (cut)
                return;
            outputs = reduceOutputs(outputs, incoming);
            if (outputSize(outputs) > OUTPUT_LIMIT) {
                cut = true;
                outputs = [...outputs, { type: 'stream', name: 'stderr', text: '\n[output cut here: more than 200 KB — run it in Colab to see the rest]' }];
                void interruptSession(s);
            }
            setRun(s, key, { ...runs[key], state: 'running', outputs, startedAt: started, where });
        });
        setRun(s, key, { ...runs[key], state: reply.status === 'ok' ? 'ran' : reply.status === 'aborted' ? 'interrupted' : 'failed', outputs, startedAt: started, ms: Date.now() - started, executionCount: reply.executionCount, where });
    }
    catch (error) {
        setRun(s, key, { ...runs[key], state: 'interrupted', outputs, startedAt: started, ms: Date.now() - started, where, stale: true });
        if (s.state.status !== 'lost')
            set(s, { error: message(error) });
    }
    finally {
        s.lastActivity = Date.now();
        stopWatching(s);
        if (s.state.status === 'busy')
            set(s, { status: 'idle', running: undefined });
        else
            set(s, { running: undefined });
        schedulePulse(s);
    }
}
// ------------------------------------------------------------ run all -----
//
// Run all is a queue, a session's own: every cell marked as queued at once,
// then run one after another. Pause lets the cell running finish and holds
// the rest for Resume; Stop interrupts the cell running and drops the rest.
// A cell that fails or is stopped ends the queue, as in Colab.
/** Drops what is still queued in a session, and their queued marks. */
function dropQueue(s) {
    const next = { ...runs };
    for (const key of s.state.queue)
        if (next[key]?.state === 'queued')
            delete next[key];
    runs = next;
    set(s, { queue: [], paused: false });
    wake(s);
}
/** Runs cells one after another, in the order given, in the foreground session, and stops at the first that fails. */
export async function runAll(cells) {
    const s = current;
    if (!cells.length || s.state.running || s.state.queue.length)
        return;
    const where = s.state.runtime ? whereOf(s, s.state.runtime) : backendLabel(s.state.backend, s.state.runtime);
    const next = { ...runs };
    for (const cell of cells) {
        next[cell.key] = { state: 'queued', outputs: [], startedAt: 0, where };
        s.keys.add(cell.key);
    }
    runs = next;
    set(s, { queue: cells.map((cell) => cell.key), paused: false });
    for (const cell of cells) {
        if (s.state.paused)
            await new Promise((resolveResume) => (s.resume = resolveResume));
        // Stopped, or the runtime went, while this one waited.
        if (!s.state.queue.includes(cell.key))
            break;
        set(s, { queue: s.state.queue.filter((key) => key !== cell.key) });
        await runIn(s, cell.key, cell.code);
        const run = runs[cell.key];
        if (!run || run.state !== 'ran')
            break;
    }
    dropQueue(s);
}
/** Pauses Run all: the cell running finishes; the rest wait. Nothing to pause when one cell runs on its own — Stop is for that. */
export function pauseRuns() {
    if (current.state.queue.length)
        set(current, { paused: true });
}
export function resumeRuns() {
    const s = current;
    if (!s.state.paused)
        return;
    set(s, { paused: false });
    wake(s);
}
/** Stops the foreground session's runs: the rest of the queue is dropped, and the cell running is interrupted. */
export const stopRuns = () => stopSessionRuns(current);
/** Stops the runs of the session with this id (from `sessionsNow()`), foreground or not. */
export async function stopRunsIn(sessionId) {
    const s = sessions.get(sessionId);
    if (s)
        await stopSessionRuns(s);
}
async function stopSessionRuns(s) {
    dropQueue(s);
    if (s.state.running)
        await interruptSession(s);
}
/** Interrupts the cell running now; the kernel answers the cell's request with an error, which ends the run. */
export const interrupt = () => interruptSession(current);
async function interruptSession(s) {
    const host = hostOf(s);
    if (!host || !s.state.kernel)
        return;
    try {
        await host.interrupt(s.state.kernel);
    }
    catch (error) {
        set(s, { error: message(error) });
    }
}
/** Restarts the kernel: every variable goes, the machine and its files stay. Runs are kept, marked as from before. */
export const restartKernel = () => restartSession(current);
async function restartSession(s) {
    const host = hostOf(s);
    if (!host || !s.state.kernel)
        return;
    try {
        await host.restart(s.state.kernel);
        staleRuns(s);
        set(s, { error: undefined });
    }
    catch (error) {
        set(s, { error: message(error) });
    }
}
/** A session's runs and kernel let go: the session goes back to off. */
function released(s) {
    closeKernel(s);
    staleRuns(s);
    set(s, { status: 'off', runtime: undefined, kernel: undefined, running: undefined, startedAt: undefined, error: undefined, sample: undefined, specs: undefined, history: [], reconnecting: false, queue: [], paused: false });
    wake(s);
}
/**
 * Releases the foreground runtime. The cells keep what they printed, marked
 * as from a runtime that is gone. On Colab this machine stops, so every
 * session on it goes with it (a playground on a machine of its own stops
 * alone); on a Jupyter server of the person's own the server is theirs and
 * stays up, and the page shuts down this session's kernel there.
 */
export const stopRuntime = () => stopSessionRuntime(current);
async function stopSessionRuntime(s) {
    const runtime = s.state.runtime;
    const backend = s.state.backend;
    const kernelId = s.state.kernel;
    if (backend.kind === 'colab') {
        // This machine stops, and every session on it with it — the other Colab machines go on.
        if (runtime)
            forgetRuntime(runtime.endpoint);
        writeRuntime(s.notebook ?? notebookOf(backend), null);
        for (const other of sessions.values())
            if (other === s || (runtime && other.state.runtime?.endpoint === runtime.endpoint))
                released(other);
    }
    else {
        keepKernel(backend.server.id, s.scope, undefined);
        released(s);
    }
    if (!runtime)
        return;
    if (backend.kind === 'jupyter') {
        if (kernelId)
            await jupyterFetch(backend.server, `api/kernels/${encodeURIComponent(kernelId)}`, { method: 'DELETE' }).catch(() => undefined);
        return;
    }
    try {
        const googleToken = await tokenOrConnect();
        await relay('/colab/runtimes/stop', googleToken, { method: 'POST', body: { endpoint: runtime.endpoint } });
    }
    catch (error) {
        set(s, { error: `The runtime may still be running: ${message(error)} Stop it in Colab under Runtime → Manage sessions.` });
    }
}
/** Stops every Colab machine this tab has a runtime on — what spends units — whichever sessions are on them. */
export async function stopColabRuntimes() {
    const stopped = new Set();
    for (const s of [...sessions.values()]) {
        const endpoint = s.state.runtime?.endpoint;
        if (s.state.backend.kind !== 'colab' || !endpoint || stopped.has(endpoint))
            continue;
        stopped.add(endpoint);
        await stopSessionRuntime(s);
    }
}
/**
 * Shuts a scope's kernel down — a playground's, from anywhere: its variables
 * go. On a Jupyter server, the kernel is shut down there, connected or only
 * kept. On Colab, its machine stops when no other scope has a kernel on it
 * (so it uses no more units) — always, for a playground on a machine of its
 * own; otherwise this scope's kernel is restarted empty and let go, the
 * others left running.
 */
export async function shutDownScope(scope, server) {
    const mine = [...sessions.values()].filter((s) => s.scope === scope);
    for (const s of mine) {
        if (s.state.running || s.state.queue.length)
            continue;
        if (s.state.backend.kind === 'jupyter') {
            if (s.kernel || s.state.kernel)
                await stopSessionRuntime(s);
            continue;
        }
        if (!s.kernel)
            continue;
        // Its machine stops when nothing else is on it — a machine of its own always — else its kernel alone is emptied.
        const endpoint = s.state.runtime?.endpoint;
        const others = [...sessions.values()].some((o) => o !== s && o.kernel && o.state.runtime?.endpoint === endpoint);
        if (!others)
            await stopSessionRuntime(s);
        else {
            await restartSession(s);
            if (endpoint)
                keepColabKernel(endpoint, scope, undefined);
            released(s);
        }
    }
    // A kernel kept on a server from before — this tab's, not connected now.
    if (server && !mine.some((s) => s.state.backend.kind === 'jupyter' && s.state.backend.server.id === server.id && s.kernel)) {
        const kernelId = keptKernel(server.id, scope);
        if (kernelId) {
            keepKernel(server.id, scope, undefined);
            emit();
            await jupyterFetch(server, `api/kernels/${encodeURIComponent(kernelId)}`, { method: 'DELETE' }).catch(() => undefined);
        }
    }
}
/** Forgets Colab in this tab: the connections, the runtime's address and the token. The runtime itself is left to Colab's idle timeout unless stopped first. */
export function disconnect() {
    write(session(), RUNTIME_KEY, null);
    write(session(), RUNTIMES_KEY, null);
    write(session(), COLAB_KERNELS_KEY, null);
    if (current.state.backend.kind === 'colab')
        dropColab();
    for (const s of sessions.values()) {
        if (s.state.backend.kind !== 'colab')
            continue;
        closeKernel(s);
        set(s, { status: 'off', runtime: undefined, kernel: undefined, running: undefined, startedAt: undefined, error: undefined, units: undefined, sample: undefined, specs: undefined, history: [], reconnecting: false, queue: [], paused: false });
        wake(s);
    }
}
/** What is on the runtime's disk under `path` — the notebook page's Files pane. Needs a runtime. */
export async function listContents(path = '') {
    const host = hostOf(current);
    if (!host || current.state.status === 'off' || current.state.status === 'lost')
        throw new Error('No runtime is connected.');
    return host.contents(path);
}
/** Forgets one cell's run — for a cell whose code has changed, or on request. */
export function forgetRun(key) {
    if (!(key in runs))
        return;
    const next = { ...runs };
    delete next[key];
    runs = next;
    emit();
}
/** Whether this tab holds a Colab grant already, so the first Run need not explain itself again. A Jupyter server needs none. */
export const colabGranted = () => current.state.backend.kind === 'jupyter' || hasColabAccess();
/** A runtime this tab had before a reload, if Colab may still have it. */
export const rememberedRuntime = () => {
    const held = read(session(), RUNTIME_KEY);
    return held && held.proxy?.expiresAt > Date.now() && held.proxy.kind !== 'jupyter' ? held : undefined;
};
