/**
 * Google Colab, for the cells on the Explain and Implementation pages.
 *
 * A Python cell on those pages has a "Run in Colab" button. Pressing it runs
 * the cell in a Colab runtime of the signed-in person's own — the same
 * machines colab.research.google.com hands out, on their tier and their
 * compute units — and puts what it printed under the cell. This module is
 * the proxy's half of that: the calls to Colab's session backend that the
 * page cannot make from another origin, made with the person's own Google
 * token, which the page sends along in X-Google-Token as it does for a
 * sign-in. Nothing here is the owner's: no key of the proxy's is used, and
 * nothing is spent but the caller's own Colab allowance.
 *
 * The shape of the backend is the one Google's own Colab CLI
 * (github.com/googlecolab/google-colab-cli) is written against:
 *
 *   GET  /tun/m/assign?nbh=…&variant=GPU&accelerator=T4   → an XSRF token, or the
 *                                                          runtime already assigned
 *   POST the same, X-Goog-Colab-Token: <that token>       → { endpoint, accelerator,
 *                                                          runtimeProxyInfo: { url, token, tokenExpiresInSeconds } }
 *   GET  /tun/m/assignments                               every runtime the account has
 *   GET+POST /tun/m/unassign/<endpoint>                   release one
 *   GET  /tun/m/ccu-info                                  compute units, and the burn rate
 *
 * `runtimeProxyInfo.url` is a Jupyter server: `POST api/kernels` starts a
 * kernel, and the page then speaks the Jupyter protocol to it over a
 * WebSocket of its own (src/lib/colab.ts). The kernel calls the page cannot
 * make cross-origin — start, interrupt, restart — come through here too, and
 * only to a URL that is Colab's: a proxy that fetched whatever URL a page
 * named would be a proxy onto the owner's network.
 *
 * Written against web APIs only, so the Worker imports it as the Node proxy
 * does.
 */

export const COLAB_HOST = 'https://colab.research.google.com';
const TUN = '/tun/m';
const XSSI_PREFIX = ")]}'\n";
/** Who this is, to Colab; the CLI names itself the same way. */
const CLIENT_AGENT = 'reader';
const TIMEOUT_MS = 30_000;

/** The machines the page may ask for. TPUs and the newest GPUs are not offered: the pages write numpy and PyTorch. */
export const ACCELERATORS = ['NONE', 'T4', 'L4', 'A100'];

export class ColabRefused extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.forPerson = true;
    Object.assign(this, extra);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Colab identifies an assignment by the notebook it is for; the CLI makes a
 * UUID up and writes it the way Colab's own page does — dashes to
 * underscores, padded with dots to 44 characters. The reader keeps one UUID
 * a browser, so a browser has one runtime however many pages it runs.
 */
export function notebookHash(uuid) {
  const text = String(uuid).toLowerCase();
  if (!UUID.test(text)) throw new ColabRefused(400, 'the notebook id is not a UUID');
  return text.replace(/-/g, '_') + '.'.repeat(44 - text.length);
}

/** The request for a machine, checked: an accelerator from the list, and whether it should be the high-memory shape. */
export function checkMachine(body) {
  const accelerator = String(body?.accelerator ?? 'NONE').toUpperCase();
  if (!ACCELERATORS.includes(accelerator)) throw new ColabRefused(400, `no such machine: ${accelerator.slice(0, 20)} — one of ${ACCELERATORS.join(', ')}`);
  const highMem = Boolean(body?.highMem);
  const notebook = body?.notebook;
  if (typeof notebook !== 'string' || !UUID.test(notebook)) throw new ColabRefused(400, 'the request needs a notebook id (a UUID)');
  return { accelerator, highMem, notebook };
}

/**
 * The URL of a runtime's Jupyter server, as Colab gave it, and nothing else:
 * https, on Colab's own hosts. The page names this URL in its requests, so
 * it is the one input here a stranger could point somewhere of their choosing.
 */
export function checkRuntimeUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new ColabRefused(400, 'the runtime URL is not a URL');
  }
  const host = url.hostname.toLowerCase();
  // Where Colab puts a runtime's Jupyter server: its own hosts under
  // colab.dev (m-s-….us-west1-a.prod.colab.dev), googleusercontent.com, or
  // colab.research.google.com itself. Nothing else is fetched, whatever the
  // page says — and what was refused is named, so a new host of Colab's is
  // a one-line fix rather than a mystery.
  const colabs = host === 'colab.dev' || host.endsWith('.colab.dev') || host.endsWith('.googleusercontent.com') || host === 'colab.research.google.com' || host.endsWith('.colab.research.google.com') || host === 'colab.sandbox.google.com';
  if (url.protocol !== 'https:' || !colabs || url.username || url.password) throw new ColabRefused(400, `that is not a Colab runtime (${url.protocol}//${host})`);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

const stripXssi = (text) => (text.startsWith(XSSI_PREFIX) ? text.slice(XSSI_PREFIX.length) : text);

/** What Colab's status codes mean, in the page's terms. */
function refusal(status, body) {
  const detail = String(body || '').slice(0, 200).trim();
  if (status === 401) return new ColabRefused(401, 'Google did not accept the Colab sign-in; connect Colab again', { reauth: true });
  if (status === 403) return new ColabRefused(403, 'this Google account may not use Colab this way (is the Colab API on for the app, and the account allowed?)', { reauth: true });
  if (status === 412) return new ColabRefused(412, 'Colab says this account already has as many runtimes as its tier allows — stop one in Colab (Runtime → Manage sessions) and try again', { limit: true });
  if (status === 429) return new ColabRefused(429, 'Colab is asking for a pause; try again in a minute');
  if (status === 400) return new ColabRefused(400, `Colab refused the request${detail ? `: ${detail}` : ''} — often a machine this account has no entitlement for; try the CPU`);
  return new ColabRefused(502, `Colab answered ${status}${detail ? `: ${detail}` : ''}`);
}

/**
 * One request to Colab's session backend, as the signed-in person: their
 * token, `authuser=0`, and the client agent; the answer with its XSSI prefix
 * off, or a refusal that says what happened.
 */
async function colabFetch(googleToken, path, { method = 'GET', headers = {}, params = {} } = {}) {
  const url = new URL(`${TUN}${path}`, COLAB_HOST);
  url.searchParams.set('authuser', '0');
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${googleToken}`, Accept: 'application/json', 'X-Colab-Client-Agent': CLIENT_AGENT, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) throw refusal(response.status, text);
  const body = stripXssi(text).trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new ColabRefused(502, 'Colab answered with something other than JSON');
  }
}

const proxyOf = (info) => ({
  url: checkRuntimeUrl(info.url),
  token: String(info.token),
  expiresAt: Date.now() + Math.max(0, Number(info.tokenExpiresInSeconds) || 0) * 1000,
});

/** A runtime as the page keeps it: where it is, what it is, and how to reach its Jupyter server. */
function runtimeOf(record) {
  if (!record?.runtimeProxyInfo?.url || !record?.endpoint) throw new ColabRefused(502, 'Colab answered without a runtime');
  const accelerator = String(record.accelerator || 'NONE').toUpperCase();
  return {
    endpoint: String(record.endpoint),
    accelerator: accelerator === 'NONE' ? null : accelerator,
    highMem: record.machineShape === 1 || record.machineShape === 'HIGH_RAM',
    proxy: proxyOf(record.runtimeProxyInfo),
  };
}

/** Every runtime this Google account has, wherever it was started. */
export async function listRuntimes(googleToken) {
  const answer = await colabFetch(googleToken, '/assignments');
  return (answer?.assignments || []).map(runtimeOf);
}

function assignParams({ accelerator, highMem, notebook }) {
  const params = { nbh: notebookHash(notebook) };
  if (accelerator !== 'NONE') {
    params.variant = 'GPU';
    params.accelerator = accelerator;
    // L4 comes in one shape; the shape parameter is only for the others.
    if (highMem && accelerator !== 'L4') params.shape = 'hm';
  } else if (highMem) {
    params.shape = 'hm';
  }
  return params;
}

/**
 * A runtime for this notebook: the one Colab already has for it, or a new
 * one — the GET says which, and hands over the XSRF token the POST wants.
 */
export async function assignRuntime(googleToken, machine) {
  const checked = checkMachine(machine);
  const params = assignParams(checked);
  const first = await colabFetch(googleToken, '/assign', { params });
  if (first?.runtimeProxyInfo) return runtimeOf(first);
  if (!first?.token) throw new ColabRefused(502, 'Colab answered the request for a runtime without a token');
  const made = await colabFetch(googleToken, '/assign', { method: 'POST', params, headers: { 'X-Goog-Colab-Token': String(first.token) } });
  return runtimeOf(made);
}

/** Releases a runtime, by the endpoint the assignment named. */
export async function stopRuntime(googleToken, endpoint) {
  const name = String(endpoint || '').trim();
  if (!/^[\w.-]{1,200}$/.test(name)) throw new ColabRefused(400, 'the runtime to stop is not named');
  const first = await colabFetch(googleToken, `/unassign/${encodeURIComponent(name)}`);
  if (!first?.token) throw new ColabRefused(502, 'Colab answered the request to stop without a token');
  await colabFetch(googleToken, `/unassign/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Goog-Colab-Token': String(first.token) } });
  return { ok: true };
}

/** Compute units left and the rate at which they go, as Colab reports them; whatever shape Colab gives, passed on. */
export async function computeUnits(googleToken) {
  return (await colabFetch(googleToken, '/ccu-info')) || {};
}

// ------------------------------------------------------------- the kernel ---

/** A request to the runtime's Jupyter server, with the proxy token where Colab wants it. */
async function runtimeFetch(proxy, path, { method = 'GET', body } = {}) {
  const base = checkRuntimeUrl(proxy?.url);
  const token = String(proxy?.token || '');
  if (!token) throw new ColabRefused(400, 'the runtime request has no proxy token');
  const url = new URL(path, base);
  url.searchParams.set('colab-runtime-proxy-token', token);
  const response = await fetch(url, {
    method,
    headers: { Accept: 'application/json', 'X-Colab-Client-Agent': CLIENT_AGENT, 'X-Colab-Runtime-Proxy-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text().catch(() => '');
  if (response.status === 404 || response.status === 410) throw new ColabRefused(410, 'that runtime is gone — Colab ends idle ones; start another', { gone: true });
  if (!response.ok) throw refusal(response.status, text);
  const trimmed = stripXssi(text).trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

const kernelId = (value) => {
  const id = String(value || '').trim();
  if (!/^[\w-]{1,80}$/.test(id)) throw new ColabRefused(400, 'the kernel is not named');
  return id;
};

/** The kernels the runtime has; the page reattaches to one rather than starting a second. */
export async function listKernels(proxy) {
  const kernels = await runtimeFetch(proxy, 'api/kernels');
  return (Array.isArray(kernels) ? kernels : []).map((kernel) => ({ id: String(kernel.id), name: String(kernel.name || ''), state: String(kernel.execution_state || '') }));
}

/** A Python kernel on the runtime. */
export async function startKernel(proxy) {
  const kernel = await runtimeFetch(proxy, 'api/kernels', { method: 'POST', body: { name: 'python3' } });
  if (!kernel?.id) throw new ColabRefused(502, 'the runtime answered without a kernel');
  return { id: String(kernel.id), name: String(kernel.name || 'python3') };
}

export async function interruptKernel(proxy, id) {
  await runtimeFetch(proxy, `api/kernels/${encodeURIComponent(kernelId(id))}/interrupt`, { method: 'POST' });
  return { ok: true };
}

export async function restartKernel(proxy, id) {
  await runtimeFetch(proxy, `api/kernels/${encodeURIComponent(kernelId(id))}/restart`, { method: 'POST' });
  return { ok: true };
}

/** A path on the runtime's disk as the contents API takes it: relative, no climbing, nothing odd. */
export function contentsPath(value) {
  const path = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (path.length > 400 || path.split('/').some((part) => part === '..' || part === '.') || /[\0-\x1f]/.test(path)) throw new ColabRefused(400, 'that is not a path on the runtime');
  return path;
}

/**
 * What is on the runtime's disk under `path`, from its Jupyter contents API
 * — the notebook page's Files pane. Directories only: a file's content is
 * not fetched here, since a big one would be; the name, the size and the
 * date are what the pane shows.
 */
export async function listContents(proxy, path) {
  const dir = contentsPath(path);
  const listing = await runtimeFetch(proxy, `api/contents/${dir.split('/').map(encodeURIComponent).join('/')}?type=directory&content=1`);
  const entries = Array.isArray(listing?.content) ? listing.content : [];
  return {
    path: dir,
    entries: entries
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string')
      .map((entry) => ({ name: entry.name, path: String(entry.path || `${dir ? `${dir}/` : ''}${entry.name}`), type: entry.type === 'directory' ? 'directory' : entry.type === 'notebook' ? 'notebook' : 'file', size: typeof entry.size === 'number' ? entry.size : null, modified: typeof entry.last_modified === 'string' ? entry.last_modified : null }))
      .sort((a, b) => (a.type === 'directory') === (b.type === 'directory') ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1),
  };
}

// -------------------------------------------------------- the socket bridge ---
//
// Colab's runtime proxy takes a kernel's WebSocket from Colab's own page and
// from a client that can set headers, and not from another site's browser.
// So when the page's own socket is refused, the proxy carries it: the page
// asks for a ticket (a signed note of which runtime and kernel, good for a
// minute, from someone the gate let through), opens a WebSocket to
// /colab/socket?ticket=…, says hello with the runtime's proxy token, and
// the proxy dials the runtime with that token in the header and the query
// and pipes frames both ways, touching none of them. The ticket carries no
// secret — the proxy token travels once, inside the socket, never in a URL.

const TICKET_PREFIX = 'rct1.';
const TICKET_SECONDS = 60;
const encoder = new TextEncoder();
const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64url = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};
const ticketKey = (secret) => crypto.subtle.importKey('raw', encoder.encode(`reader-colab:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** A ticket for one kernel's socket on one runtime, good for a minute. */
export async function issueSocketTicket(secret, { url, kernel, session }, now = Date.now()) {
  if (!secret) throw new ColabRefused(501, 'this proxy cannot carry a kernel socket: it has no secret to sign a ticket with');
  const payload = base64url(encoder.encode(JSON.stringify({ u: checkRuntimeUrl(url), k: kernelId(kernel), s: String(session || '').slice(0, 80), x: Math.floor(now / 1000) + TICKET_SECONDS })));
  const signature = await crypto.subtle.sign('HMAC', await ticketKey(secret), encoder.encode(payload));
  return `${TICKET_PREFIX}${payload}.${base64url(signature)}`;
}

/** What a ticket names, or null: signed with this secret, not expired, and still a Colab runtime. */
export async function readSocketTicket(secret, ticket, now = Date.now()) {
  if (!secret || typeof ticket !== 'string' || !ticket.startsWith(TICKET_PREFIX)) return null;
  const [payload, signature] = ticket.slice(TICKET_PREFIX.length).split('.');
  if (!payload || !signature) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await ticketKey(secret), fromBase64url(signature), encoder.encode(payload));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof claims.u !== 'string' || typeof claims.k !== 'string' || typeof claims.x !== 'number' || claims.x * 1000 <= now) return null;
    return { url: checkRuntimeUrl(claims.u), kernel: kernelId(claims.k), session: typeof claims.s === 'string' ? claims.s : '' };
  } catch {
    return null;
  }
}

/** The first frame over the bridge: the runtime's proxy token, and nothing else. */
export function readHello(data) {
  try {
    const hello = JSON.parse(typeof data === 'string' ? data : '');
    return hello?.type === 'hello' && typeof hello.token === 'string' && hello.token.length > 0 && hello.token.length < 4096 ? hello.token : null;
  } catch {
    return null;
  }
}

/** Where the runtime's kernel socket is, and the headers Colab's own client sends with it. */
export function upstreamSocket({ url, kernel, session, token }) {
  const socket = new URL(`api/kernels/${encodeURIComponent(kernelId(kernel))}/channels`, checkRuntimeUrl(url));
  socket.protocol = 'wss:';
  if (session) socket.searchParams.set('session_id', session);
  socket.searchParams.set('colab-runtime-proxy-token', token);
  return {
    href: socket.href,
    headers: { 'X-Colab-Runtime-Proxy-Token': token, 'X-Colab-Client-Agent': CLIENT_AGENT, Origin: COLAB_HOST },
  };
}

/** A close code a WebSocket may be closed with; anything else becomes a plain close. */
export const closeCode = (code) => (Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) ? code : 1000);

/**
 * The page's request, routed: the path under /colab, its method, the Google
 * token and the JSON body. One function for both proxies, so the routes are
 * in step; it answers with { status, body }.
 */
export async function handleColab(path, method, googleToken, body, { secret = '' } = {}) {
  const token = String(googleToken || '').trim();
  if (!token) return { status: 401, body: { error: 'the request has no Google sign-in (X-Google-Token); connect Colab first', reauth: true } };
  try {
    if (path === '/colab/runtimes' && method === 'GET') return { status: 200, body: { runtimes: await listRuntimes(token) } };
    if (path === '/colab/runtimes' && method === 'POST') return { status: 200, body: { runtime: await assignRuntime(token, body) } };
    if (path === '/colab/runtimes/stop' && method === 'POST') return { status: 200, body: await stopRuntime(token, body?.endpoint) };
    if (path === '/colab/units' && method === 'GET') return { status: 200, body: await computeUnits(token) };
    if (path === '/colab/kernels/list' && method === 'POST') return { status: 200, body: { kernels: await listKernels(body?.proxy) } };
    if (path === '/colab/kernels' && method === 'POST') return { status: 200, body: { kernel: await startKernel(body?.proxy) } };
    if (path === '/colab/kernels/interrupt' && method === 'POST') return { status: 200, body: await interruptKernel(body?.proxy, body?.kernel) };
    if (path === '/colab/kernels/restart' && method === 'POST') return { status: 200, body: await restartKernel(body?.proxy, body?.kernel) };
    if (path === '/colab/contents' && method === 'POST') return { status: 200, body: await listContents(body?.proxy, body?.path) };
    if (path === '/colab/socket/ticket' && method === 'POST') return { status: 200, body: { ticket: await issueSocketTicket(secret, { url: body?.proxy?.url, kernel: body?.kernel, session: body?.session }) } };
    return { status: 404, body: { error: 'not found' } };
  } catch (error) {
    if (error instanceof ColabRefused) {
      const { status, message, reauth, limit, gone } = error;
      return { status, body: { error: message, ...(reauth ? { reauth } : {}), ...(limit ? { limit } : {}), ...(gone ? { gone } : {}) } };
    }
    if (error?.name === 'TimeoutError') return { status: 504, body: { error: 'Colab did not answer in time' } };
    return { status: 502, body: { error: 'could not reach Colab' } };
  }
}

/** The routes this module answers, for the proxies' gates. */
export const isColabPath = (path) => path === '/colab' || path.startsWith('/colab/');
