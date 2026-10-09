// The Reader Companion, from the page's side: finding it on 127.0.0.1, pairing
// with the code it shows, and the commands that start it. The Companion itself
// is companion/ (a Python package); scripts/build-companion.mjs puts its wheel
// and the one-line installers into the site build. See docs/companion.md.

/** The Companion's version: the wheel the installers fetch. Kept equal to companion/pyproject.toml by scripts/companion.test.mjs. */
export const COMPANION_VERSION = '0.5.1';
/** Where the Companion listens unless told otherwise. */
export const COMPANION_PORT = 47321;
/** Its https address on this computer, for Safari, which won't call http://127.0.0.1 from an https page (companion/reader_companion/tls.py). */
export const COMPANION_TLS_PORT = 47331;

export interface CompanionInfo {
  app: 'reader-companion';
  /** Its https port on this computer, for Safari (0 when it has none). */
  tls?: number;
  version: string;
  /** The same for a Companion across restarts, while its address (a tunnel's) may change. */
  id?: string;
  name: string;
  hardware: string;
  root: string;
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
export async function pairCompanion(code: string, base = localBase()): Promise<CompanionPairing> {
  let response: Response;
  try {
    response = await fetch(`${base}companion/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: normaliseCode(code) }) });
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

/** Where to look for a Companion, in order: its address on this computer (https in Safari, when it has one), then its tunnel. */
export function companionRoutes(port: number, via: string | null, safari = isSafari(), tls: number | null = COMPANION_TLS_PORT): string[] {
  const local = safari ? (tls ? [secureBase(tls)] : []) : [directBase(port)];
  return [...local, ...(via ? [via] : [])];
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
