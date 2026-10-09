// The Reader Companion, from the page's side: finding it on 127.0.0.1, pairing
// with the code it shows, and the commands that start it. The Companion itself
// is companion/ (a Python package); scripts/build-companion.mjs puts its wheel
// and the one-line installers into the site build. See docs/companion.md.

/** The Companion's version: the wheel the installers fetch. Kept equal to companion/pyproject.toml by scripts/companion.test.mjs. */
export const COMPANION_VERSION = '0.2.1';
/** Where the Companion listens unless told otherwise. */
export const COMPANION_PORT = 47321;

export interface CompanionInfo {
  app: 'reader-companion';
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
export async function findCompanion(base = directBase(), timeoutMs = 1500): Promise<CompanionInfo | null> {
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
export async function pairCompanion(code: string, base = directBase()): Promise<CompanionPairing> {
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

/** "abc def", "ABCDEF" and "ABC-DEF" are the same code. */
export function normaliseCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

/** `#pair=ABC-DEF&port=47321[&via=https://….trycloudflare.com]`, as the Companion opens the page with, or null. */
export function pairFragment(hash: string): { code: string; port: number; via: string | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const code = params.get('pair');
  if (!code) return null;
  const port = Number(params.get('port'));
  return { code: normaliseCode(code), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : COMPANION_PORT, via: tunnelBase(params.get('via')) };
}

/** Where to look for a Companion, in order: its direct address unless the browser can't reach it, then its tunnel. */
export function companionRoutes(port: number, via: string | null, safari = isSafari()): string[] {
  return [...(safari ? [] : [directBase(port)]), ...(via ? [via] : [])];
}

/** A saved server that is a Companion on this computer: its port, or null. */
export function companionPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' && parsed.pathname === '/' && parsed.port ? Number(parsed.port) : null;
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
