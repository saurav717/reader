// The Reader Companion, from the page's side: finding it on 127.0.0.1, pairing
// with the code it shows, and the commands that start it. The Companion itself
// is companion/ (a Python package); scripts/build-companion.mjs puts its wheel
// and the one-line installers into the site build. See docs/companion.md.

/** The Companion's version: the wheel the installers fetch. Kept equal to companion/pyproject.toml by scripts/companion.test.mjs. */
export const COMPANION_VERSION = '0.10.0';
/** Where the Companion listens unless told otherwise. */
export const COMPANION_PORT = 47321;
/** Its https address on this computer, for Safari, which won't call http://127.0.0.1 from an https page (companion/reader_companion/tls.py). */
export const COMPANION_TLS_PORT = 47331;

export interface CompanionInfo {
  app: 'reader-companion';
  /** Its https port on this computer, for Safari (0 when it has none). */
  tls?: number;
  version: string;
  /** Whether it shuts down with the Reader app's window (0.7.4 on; absent before). */
  stopWithApp?: boolean;
  /** The same for a Companion across restarts, while its address (a tunnel's) may change. */
  id?: string;
  name: string;
  hardware: string;
  root: string;
  /** Connected to a Google account (from 0.7.0): only a page signed in as it pairs. */
  owned?: boolean;
  /** That account, partly hidden (sa•••@gmail.com). */
  owner?: string;
}

export interface CompanionPairing {
  /** The direct address, http://127.0.0.1:port/. */
  url: string;
  /** Its https address through a quick tunnel, when it opened one ('' when not). */
  tunnel?: string;
  id?: string;
  root?: string;
  token: string;
  name: string;
  hardware: string;
  version: string;
}

/** The Companion's direct address on this computer. */
export const directBase = (port = COMPANION_PORT) => `http://127.0.0.1:${port}/`;
/** Its https address on this computer: what Safari can reach, once the Mac trusts its certificate. */
export const secureBase = (port = COMPANION_TLS_PORT) => `https://127.0.0.1:${port}/`;
/** Where this browser can reach a Companion on this computer: https in Safari, http everywhere else. */
export const localBase = (safari = isSafari(), port = COMPANION_PORT, tlsPort = COMPANION_TLS_PORT) => (safari ? secureBase(tlsPort) : directBase(port));

/** A quick tunnel's address, and only that: a pairing link can't send the page to any other server. */
export function tunnelBase(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(parsed.hostname) && !parsed.port ? `https://${parsed.hostname}/` : null;
  } catch {
    return null;
  }
}

/** The Companion at `base` (its direct address, or its tunnel's), or null when nothing answers (not running, another program on the port, or the browser won't let the page reach it). */
export async function findCompanion(base = localBase(), timeoutMs = 1500): Promise<CompanionInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}companion/info`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const info = (await response.json()) as Partial<CompanionInfo>;
    return info && info.app === 'reader-companion' && typeof info.name === 'string' ? (info as CompanionInfo) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Trades the code the Companion printed for its server's address and token. */
export async function pairCompanion(code: string, base = localBase(), pass?: string | null): Promise<CompanionPairing> {
  let response: Response;
  try {
    // The page's pass, when signed in: a Companion connected to an account pairs only with a page signed in as it.
    response = await fetch(`${base}companion/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: normaliseCode(code), ...(pass ? { pass } : {}) }) });
  } catch {
    throw new Error('The Companion stopped answering. Is it still running in the terminal?');
  }
  const body = (await response.json().catch(() => ({}))) as Partial<CompanionPairing> & { error?: string };
  if (!response.ok || typeof body.url !== 'string' || typeof body.token !== 'string') throw new Error(body.error || `The Companion said ${response.status}.`);
  return body as CompanionPairing;
}

/**
 * Asks the Companion to put its pairing code on its computer's screen, for a
 * browser that found it but has no code (it runs in the background, with no
 * terminal to read). False when that computer has nothing to show it with.
 */
export async function showCompanionCode(base = localBase()): Promise<boolean> {
  try {
    const response = await fetch(`${base}companion/show-code`, { method: 'POST' });
    if (response.status === 429) return true;
    const body = (await response.json().catch(() => ({}))) as { shown?: boolean };
    return response.ok && body.shown === true;
  } catch {
    return false;
  }
}

/** "abc def", "ABCDEF" and "ABC-DEF" are the same code. */
export function normaliseCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

/** `#pair=ABC-DEF&port=47321[&via=https://….trycloudflare.com]`, as the Companion opens the page with, or null. */
export function pairFragment(hash: string): { code: string; port: number; tls: number | null; via: string | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const code = params.get('pair');
  if (!code) return null;
  const valid = (value: number) => Number.isInteger(value) && value > 0 && value < 65536;
  const port = Number(params.get('port'));
  const tls = Number(params.get('tls'));
  return { code: normaliseCode(code), port: valid(port) ? port : COMPANION_PORT, tls: valid(tls) ? tls : null, via: tunnelBase(params.get('via')) };
}

/**
 * Where to look for a Companion, in order: its https address on this computer
 * when it has one (encrypted, and the only way in for Safari), its plain http
 * one (not for Safari; it never leaves this computer either), then its tunnel.
 */
export function companionRoutes(port: number, via: string | null, safari = isSafari(), tls: number | null = COMPANION_TLS_PORT): string[] {
  const secure = tls ? [secureBase(tls)] : [];
  const local = safari ? secure : [...secure, directBase(port)];
  return [...local, ...(via ? [via] : [])];
}

/** The Companion on this computer, at its https address when this browser can reach it there, else at its http one (never for Safari). */
export async function findLocalCompanion(safari = isSafari(), timeoutMs = 1500): Promise<{ base: string; info: CompanionInfo } | null> {
  for (const base of companionRoutes(COMPANION_PORT, null, safari)) {
    const info = await findCompanion(base, timeoutMs);
    if (info) return { base, info };
  }
  return null;
}

/** Whether a saved server is reached over https (or through its tunnel, which is https too): encrypted all the way. */
export const isSecure = (url: string) => url.startsWith('https://');

/**
 * The https address of a Companion this browser reaches over plain http on
 * this computer, once it answers there as the same Companion (its certificate
 * trusted by this computer); null when it doesn't, or the server is something else.
 */
export async function secureAddress(server: { url: string; companionId?: string }, tlsPort = COMPANION_TLS_PORT): Promise<string | null> {
  if (isSecure(server.url) || !server.companionId || companionPort(server.url) === null) return null;
  const base = secureBase(tlsPort);
  const info = await findCompanion(base, 2500);
  return info?.id === server.companionId ? base : null;
}

/** A saved server that is a Companion on this computer: its port, or null. */
export function companionPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname === '127.0.0.1' && parsed.pathname === '/' && parsed.port ? Number(parsed.port) : null;
  } catch {
    return null;
  }
}

/** The commands that start the Companion, for a site served at `site` (its origin plus base path); with the tunnel, for Safari. */
export function companionCommands(site: string, { tunnel = false } = {}): { unix: string; windows: string; uv: string } {
  const base = site.replace(/\/?$/, '/');
  return {
    unix: `curl -LsSf ${base}companion.sh | sh${tunnel ? ' -s -- --tunnel' : ''}`,
    windows: `powershell -ExecutionPolicy ByPass -c "irm ${base}companion.ps1 | iex"`,
    uv: `uvx --from ${base}companion/reader_companion-${COMPANION_VERSION}-py3-none-any.whl reader-companion --site ${base}${tunnel ? ' --tunnel' : ''}`,
  };
}

export type DesktopSystem = 'mac' | 'windows' | 'linux';

/** Which installer to offer first: this computer's system, from what the browser says. */
export function desktopSystem(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): DesktopSystem {
  if (/Windows|Win64|Win32/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  return 'linux';
}

/**
 * The installers to download and double-click (scripts/build-companion.mjs):
 * each installs the Companion for good, with the VS Code extension, starts it
 * at every login and opens the page to pair (`reader-companion setup`). Linux
 * has no file manager that runs a script on a double-click, so there it is a
 * line to paste, and the file for `sh` beside it.
 */
export function companionDownloads(site: string): Record<DesktopSystem, { label: string; href: string; file: string; command: string }> {
  const base = site.replace(/\/?$/, '/');
  return {
    mac: { label: 'macOS', href: `${base}download/Reader-Companion-mac.zip`, file: 'Reader Companion.command', command: `curl -LsSf ${base}companion-setup.sh | sh` },
    windows: { label: 'Windows', href: `${base}download/Reader-Companion-Setup.cmd`, file: 'Reader-Companion-Setup.cmd', command: `powershell -ExecutionPolicy ByPass -c "irm ${base}companion-setup.ps1 | iex"` },
    linux: { label: 'Linux', href: `${base}download/reader-companion-setup.sh`, file: 'reader-companion-setup.sh', command: `curl -LsSf ${base}companion-setup.sh | sh` },
  };
}

/** The Reader extension for VS Code, as the site serves it (scripts/build-vscode.mjs): the .vsix and the line that installs it. */
export function vscodeInstall(site: string, windows = false): { vsix: string; command: string } {
  const vsix = `${site.replace(/\/?$/, '/')}vscode/reader-playground.vsix`;
  return {
    vsix,
    command: windows
      ? `powershell -c "irm ${vsix} -OutFile $env:TEMP\\reader-playground.vsix; code --install-extension $env:TEMP\\reader-playground.vsix"`
      : `curl -LsSfo /tmp/reader-playground.vsix ${vsix} && code --install-extension /tmp/reader-playground.vsix`,
  };
}

/** Safari will not let an https page call http://127.0.0.1, so the Companion can't be reached from it. */
export function isSafari(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Safari\//.test(userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//.test(userAgent);
}

/** The VS Code-like editors on a Companion's computer, and whether each has the Reader extension. */
export interface VsCodeStatus {
  editors: { name: string; installed: boolean }[];
}

/**
 * Asks a paired Companion about VS Code (`GET`), or to install the Reader
 * extension into it (`install`): the extension isn't on the Marketplace, and a
 * page can't run `code --install-extension`, but the Companion can.
 */
export async function companionVsCode(server: { url: string; token: string }, install = false): Promise<VsCodeStatus> {
  let response: Response;
  try {
    response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/vscode`, { method: install ? 'POST' : 'GET', headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
  } catch {
    throw new Error('The Companion isn’t answering. Open the Reader app, or start it again.');
  }
  const body = (await response.json().catch(() => ({}))) as Partial<VsCodeStatus> & { error?: string };
  if (response.status === 404 && !body.error) throw new Error('This Companion is older than the VS Code button: run the installer again to update it.');
  if (!response.ok) throw new Error(body.error || `The Companion said ${response.status}.`);
  return { editors: Array.isArray(body.editors) ? body.editors : [] };
}

/** Where the signed, notarized Reader.dmg is published: the macOS app workflow's GitHub Releases. */
export const MAC_RELEASES = 'saurav717/reader';

/** A published Reader.app for macOS: notarized (opens with no warning) or not (macOS stops it once). */
export interface MacDmg {
  url: string;
  notarized: boolean;
}

/**
 * The newest published Reader.app .dmg (the macOS app workflow, see
 * docs/macos-app.md): Reader.dmg when it is notarized, Reader-unsigned.dmg when
 * it isn't. Null while there is neither: then the Mac download stays the
 * .command in a zip.
 */
export async function latestMacDmg(repo = MAC_RELEASES): Promise<MacDmg | null> {
  try {
    const cached = sessionStorage.getItem('reader.macDmg');
    if (cached !== null) return cached ? (JSON.parse(cached) as MacDmg) : null;
  } catch {
    // no storage, or not ours: ask
  }
  let found: MacDmg | null = null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const releases = (await response.json()) as { draft?: boolean; prerelease?: boolean; assets?: { name?: string; browser_download_url?: string }[] }[];
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const signed = release.assets?.find((asset) => asset.name === 'Reader.dmg');
      const unsigned = release.assets?.find((asset) => asset.name === 'Reader-unsigned.dmg');
      const asset = signed ?? unsigned;
      if (asset?.browser_download_url) {
        found = { url: asset.browser_download_url, notarized: asset === signed };
        break;
      }
    }
  } catch {
    return null;
  }
  try {
    sessionStorage.setItem('reader.macDmg', found ? JSON.stringify(found) : '');
  } catch {
    // fine
  }
  return found;
}

/** Whether `version` is newer than `than` (dotted numbers: 0.10.0 is newer than 0.9.2). */
export function isNewer(version: string, than: string): boolean {
  const parts = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Asks a paired Companion to update itself to the newest version the site
 * serves (POST /companion/update): it installs it, refreshes the VS Code
 * extension where it is installed, and starts again. Resolves with the version
 * it is updating to, once it has installed it (it restarts after answering).
 */
export async function updateCompanion(server: { url: string; token: string }): Promise<{ version: string; updated: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/update`, { method: 'POST', headers: { Authorization: `token ${server.token}` } });
  } catch {
    throw new Error('The Companion isn’t answering. Open the Reader app, or start it again.');
  }
  const body = (await response.json().catch(() => ({}))) as { version?: string; updated?: boolean; error?: string };
  if (!response.ok || typeof body.version !== 'string') throw new Error(body.error || `The Companion said ${response.status}.`);
  return { version: body.version, updated: Boolean(body.updated) };
}

/** Waits for the Companion at `base` to answer as `version` (or newer) after it restarts. */
export async function waitForVersion(base: string, version: string, forMs = 120_000): Promise<CompanionInfo | null> {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const info = await findCompanion(base, 3000);
    if (info && !isNewer(version, info.version)) return info;
  }
  return null;
}

/** The first Companion the page can shut down and start again (POST /companion/shutdown, and reader-companion:// links). */
export const STARTABLE = '0.6.0';

/** The first Companion a page that hasn't paired with it can shut down, from this computer (not through its tunnel). */
export const STOPPABLE_UNPAIRED = '0.7.0';

/** The first Companion that belongs to a Google account (POST /companion/claim). */
export const ACCOUNTS = '0.7.0';

/**
 * Shuts a Companion down (POST /companion/shutdown): its kernels, its Jupyter
 * server and the process. It stays off, at the next login too, until it is
 * started on purpose: startCompanion, the Reader app, or `reader-companion start`.
 * Without a token (a Companion found but not paired), only on this computer and
 * from STOPPABLE_UNPAIRED on.
 */
export async function shutdownCompanion(server: { url: string; token?: string }): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/shutdown`, { method: 'POST', headers: server.token ? { Authorization: `token ${server.token}` } : {} });
  } catch {
    throw new Error('The Companion isn’t answering: it may be off already.');
  }
  if (response.status === 404) throw new Error(`This Companion is older than the Shut down button (${STARTABLE}): update it in Settings → Updates, then try again.`);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.status === 403 && !server.token) throw new Error(`This Companion turns off from here only once paired, or from ${STOPPABLE_UNPAIRED} on: connect it with its code first, or stop it with Ctrl-C in its terminal.`);
  if (!response.ok) throw new Error(body.error || `The Companion said ${response.status}.`);
}

/**
 * Connects a paired Companion to the Google account the page is signed in as
 * (POST /companion/claim, from 0.7.0): it goes on that account's list of
 * computers on the Worker at `api`, opens its HTTPS tunnel, and takes a new
 * token, which it answers with — the one the browser had stops working.
 */
export async function claimCompanion(server: { url: string; token: string }, pass: string, api: string): Promise<{ email: string; token: string; tunnel: string; id: string }> {
  let response: Response;
  try {
    response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/claim`, { method: 'POST', headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pass, api }) });
  } catch {
    throw new Error('The Companion isn’t answering.');
  }
  if (response.status === 404) throw new Error('This Companion is older than accounts (0.7.0): update it in Settings → Updates to connect it to your Google account.');
  const body = (await response.json().catch(() => ({}))) as { email?: string; token?: string; tunnel?: string; id?: string; error?: string };
  if (!response.ok || typeof body.token !== 'string' || typeof body.email !== 'string') throw new Error(body.error || `The Companion said ${response.status}.`);
  return { email: body.email, token: body.token, tunnel: body.tunnel || '', id: body.id || '' };
}

/** What the paired Companion's computer can run (GET /companion/tools, from 0.7.0): null when it can't say. */
export async function companionTools(server: { url: string; token: string }): Promise<{ os: 'mac' | 'linux' | 'windows'; tools: Record<string, string>; agents: { id: string; name: string }[]; vscode: boolean } | null> {
  try {
    const response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/tools`, { headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { os?: string; tools?: Record<string, string>; agents?: { id: string; name: string }[]; vscode?: boolean };
    if (!body.tools || !Array.isArray(body.agents)) return null;
    return { os: body.os === 'windows' ? 'windows' : body.os === 'linux' ? 'linux' : 'mac', tools: body.tools, agents: body.agents, vscode: Boolean(body.vscode) };
  } catch {
    return null;
  }
}

export interface VsCodeWeb {
  state: 'off' | 'starting' | 'ready' | 'failed';
  error: string;
  /** Where it is on the Companion, with its secret, once ready: /companion/vscode/<secret>/. */
  path: string;
  /** The folder it opens, absolute on that computer. */
  folder: string;
  /** VS Code's own last lines of output (Companion 0.7.3 on), for when something is wrong. */
  log: string[];
}

/**
 * VS Code for the browser on the Companion's computer (/companion/vscode-web,
 * from 0.7.0): `start` starts it (the first time downloads VS Code's server),
 * otherwise only says how it is. `folder` is the project's, under the Companion's.
 */
export async function vscodeWeb(server: { url: string; token: string }, folder: string, start = false): Promise<VsCodeWeb> {
  const base = `${server.url.replace(/\/?$/, '/')}companion/vscode-web`;
  let response: Response;
  try {
    response = start
      ? await fetch(base, { method: 'POST', headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) })
      : await fetch(`${base}?folder=${encodeURIComponent(folder)}`, { headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
  } catch {
    throw new Error('The Companion isn’t answering.');
  }
  if (response.status === 404) throw new Error('This Companion is older than VS Code in the page (0.7.0): update it in Settings → Updates.');
  const body = (await response.json().catch(() => ({}))) as Partial<VsCodeWeb> & { error?: string };
  if (!response.ok) throw new Error(body.error || `The Companion said ${response.status}.`);
  return { state: body.state ?? 'off', error: body.error ?? '', path: body.path ?? '', folder: body.folder ?? '', log: Array.isArray(body.log) ? body.log.filter((line): line is string => typeof line === 'string') : [] };
}

/**
 * A folder as VS Code's address takes it: a path from the root, with forward
 * slashes — /Users/me/Reader/x, and on Windows /C:/Users/me/Reader/x (as
 * C:\Users\… it isn't a path VS Code's address can hold, and it opens with
 * no folder).
 */
export function vscodeFolder(path: string): string {
  const forward = path.replace(/\\/g, '/');
  return forward.startsWith('/') ? forward : `/${forward}`;
}

/** The link that starts the Companion on this computer: `reader-companion setup` hands the scheme to `reader-companion start`. */
export const START_LINK = 'reader-companion://start';

/**
 * Asks this computer to start its Companion, by opening START_LINK (the
 * browser asks once whether to open it), then waits for it to answer at
 * `base`. Null when it doesn't within `forMs`: nothing here takes the link (a
 * Companion from before STARTABLE, or not installed for good), or it didn't start.
 */
export async function startCompanion(base: string, forMs = 90_000): Promise<CompanionInfo | null> {
  if (typeof window !== 'undefined') window.location.href = START_LINK;
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const info = await findCompanion(base, 3000);
    if (info) return info;
  }
  return null;
}

/** Whether the Companion shuts down with the Reader app's window (true) or keeps running once it is closed. */
export async function setStopWithApp(server: { url: string; token: string }, on: boolean): Promise<boolean> {
  const response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/app`, {
    method: 'POST',
    headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'setting', stopWithApp: on }),
  });
  const body = (await response.json().catch(() => ({}))) as { stopWithApp?: boolean; error?: string };
  if (!response.ok || typeof body.stopWithApp !== 'boolean') throw new Error(body.error || `The Companion said ${response.status}: update it in Settings → Updates.`);
  return body.stopWithApp;
}

// ------------------------------------------------- folders anywhere (0.8.0) --

/** The first Companion that lists folders anywhere on its computer and links one in (/companion/folders). */
export const FOLDERS_VERSION = '0.8.0';

export interface FolderListing {
  /** The folder listed, absolute on that computer. */
  path: string;
  parent: string | null;
  home: string;
  sep: string;
  entries: { name: string; dir: boolean; size: number | null }[];
  more: boolean;
  places: { name: string; path: string }[];
}

const foldersUrl = (server: { url: string }) => `${server.url.replace(/\/?$/, '/')}companion/folders`;

async function foldersCall<T>(server: { url: string; token: string }, init?: RequestInit, query = ''): Promise<T> {
  const response = await fetch(`${foldersUrl(server)}${query}`, { ...init, headers: { Authorization: `token ${server.token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || (response.status === 404 ? 'This Companion can’t list folders: update it.' : `The Companion answered ${response.status}.`));
  return body;
}

/** A folder anywhere on the Companion's computer, listed: '' is its home folder. */
export const listFolder = (server: { url: string; token: string }, path = '', hidden = false) => foldersCall<FolderListing>(server, undefined, `?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`);

/** A folder on the Companion's computer linked into its own folder: the root a project then uses, relative to it. */
export const linkFolder = (server: { url: string; token: string }, path: string) => foldersCall<{ root: string; path: string }>(server, { method: 'POST', body: JSON.stringify({ action: 'link', path }) });

/** That computer's own folder chooser, on its screen: the folder picked, or null when cancelled. */
export const chooseFolder = (server: { url: string; token: string }) => foldersCall<{ path: string | null }>(server, { method: 'POST', body: JSON.stringify({ action: 'choose' }) });

// ------------------------------------------- browsers on this computer (0.9.0) --

/** The first Companion that lists this computer's browsers and their profiles, and opens a link in one (/companion/browsers). */
export const BROWSERS_VERSION = '0.9.0';

export interface BrowserProfile {
  /** What the browser calls it on the command line: a Chromium profile's folder ("Profile 1"), a Firefox profile's name. */
  id: string;
  name: string;
  /** The Google account signed in to a Chromium profile, when there is one. */
  account: string;
}

export interface InstalledBrowser {
  id: string;
  name: string;
  profiles: BrowserProfile[];
}

const browsersUrl = (server: { url: string }) => `${server.url.replace(/\/?$/, '/')}companion/browsers`;

async function browsersCall<T>(server: { url: string; token: string }, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(browsersUrl(server), { ...init, headers: { Authorization: `token ${server.token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
  } catch {
    throw new Error('The Companion on this computer didn’t answer. Is it running?');
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 404) throw new Error(`This computer’s Companion is older than ${BROWSERS_VERSION}: update it to open links in another browser.`);
  if (!response.ok) throw new Error(body.error || `The Companion said ${response.status}.`);
  return body;
}

/** The browsers on the Companion's computer, each with its profiles. */
export const listBrowsers = (server: { url: string; token: string }) => browsersCall<{ browsers: InstalledBrowser[] }>(server).then((body) => body.browsers);

/** Opens an https link in that browser and profile on the Companion's computer ('default' for its default browser). */
export const openInBrowser = (server: { url: string; token: string }, url: string, browser: string, profile?: string) =>
  browsersCall<{ opened: boolean }>(server, { method: 'POST', body: JSON.stringify({ url, browser, ...(profile ? { profile } : {}) }) });

// ------------------------------------------- a project's paper here (0.10.0) --

/** The first Companion that compiles a paper and syncs it with Overleaf's Git (/companion/paper). */
export const PAPER_VERSION = '0.10.0';

export interface PaperEngines {
  /** Where each is, '' when it isn't here. */
  latexmk: string;
  tectonic: string;
  git: string;
  /** Whether the Companion can fetch Tectonic for this computer. */
  tectonicInstallable: boolean;
}

export interface TexProblem {
  file: string;
  line: number | null;
  message: string;
}

export interface Compiled {
  ok: boolean;
  main: string;
  engine: string;
  /** The PDF, base64; '' when none was made. */
  pdf: string;
  errors: TexProblem[];
  warnings: TexProblem[];
  log: string;
  ms: number;
}

export interface Synced {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  /** Files changed elsewhere (in Overleaf) and taken in. */
  incoming?: string[];
  /** Files left with conflict markers. */
  conflicts: string[];
  error?: string;
  at?: number;
}

async function paperCall<T>(server: { url: string; token: string }, init?: { action: string } & Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/paper`, {
      method: init ? 'POST' : 'GET',
      headers: { Authorization: `token ${server.token}`, ...(init ? { 'Content-Type': 'application/json' } : {}) },
      ...(init ? { body: JSON.stringify(init) } : {}),
      cache: 'no-store',
    });
  } catch {
    throw new Error('This computer’s Companion didn’t answer. Is it running?');
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 404) throw new Error(`This computer’s Companion is older than ${PAPER_VERSION}: update it to compile and sync the paper here.`);
  if (!response.ok) throw new Error(body.error || `The Companion said ${response.status}.`);
  return body;
}

/** What compiles a paper on the Companion's computer, and whether git is there. */
export const paperEngines = (server: { url: string; token: string }) => paperCall<PaperEngines>(server);
/** Compiles the paper in `folder` (relative to the Companion's folder). */
export const compilePaper = (server: { url: string; token: string }, folder: string, engine: 'auto' | 'latexmk' | 'tectonic', main?: string) =>
  paperCall<Compiled>(server, { action: 'compile', folder, engine, ...(main ? { main } : {}) });
/** Fetches Tectonic onto the Companion's computer. */
export const installTectonic = (server: { url: string; token: string }) => paperCall<{ tectonic: string }>(server, { action: 'install-tectonic' });
/** Clones Overleaf's Git (or a GitHub repository) into `folder`; the token is kept by the Companion for that remote. */
export const clonePaper = (server: { url: string; token: string }, folder: string, url: string, token: string) => paperCall<{ folder: string }>(server, { action: 'clone', folder, url, token });
/** Commits what changed here, takes in what changed in Overleaf, and pushes. */
export const syncPaper = (server: { url: string; token: string }, folder: string, message: string, token?: string) =>
  paperCall<Synced>(server, { action: 'sync', folder, message, ...(token ? { token } : {}) });
/** Where the folder syncs to, and whether the Companion has a token for it. */
export const paperRemote = (server: { url: string; token: string }, folder: string) => paperCall<{ url: string; token: boolean }>(server, { action: 'remote', folder });
