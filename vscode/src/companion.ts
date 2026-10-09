// What the extension knows about the Reader Companion without VS Code: its
// settings on disk, whether it answers, the projects in its folder and what
// each project's marker says. Kept apart from extension.ts so the tests can
// load it in plain Node (scripts/vscode.test.mjs).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 47321;
export const DEFAULT_SITE = 'https://saurav717.github.io/reader/';

/** ~/.reader-companion/config.json, as companion/reader_companion/cli.py writes it. */
export interface CompanionConfig {
  token?: string;
  id?: string;
  port?: number;
  root?: string;
  site?: string;
  name?: string;
  python?: string;
  tunnel?: boolean;
}

export interface Companion {
  config: CompanionConfig;
  /** The folder the Companion serves, absolute. */
  root: string;
  port: number;
  site: string;
}

/** .reader/playground.json in a project's folder, as the site writes it (markFolder in src/lib/playground.ts). */
export interface Marker {
  id: string;
  title: string;
  page: string;
  cites: { paperId: string; title: string; page: string }[];
}

export interface Project {
  name: string;
  folder: string;
  marker: Marker | null;
}

export const configDir = (env: NodeJS.ProcessEnv = process.env) => env.READER_COMPANION_HOME || path.join(os.homedir(), '.reader-companion');

const expandHome = (value: string) => (value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value);

/** The Companion's settings, or the defaults it would use when it has never run. */
export async function readCompanion(fallbackSite = DEFAULT_SITE, env: NodeJS.ProcessEnv = process.env): Promise<Companion> {
  let config: CompanionConfig = {};
  try {
    config = JSON.parse(await fs.readFile(path.join(configDir(env), 'config.json'), 'utf8')) as CompanionConfig;
  } catch {
    // never run: defaults
  }
  return {
    config,
    root: path.resolve(expandHome(config.root || '~/Reader')),
    port: Number(config.port) || DEFAULT_PORT,
    site: (config.site || fallbackSite).replace(/\/?$/, '/'),
  };
}

/** Whether the Companion answers on its port with its token: Jupyter's version when it does. */
export async function ping(companion: Companion, timeoutMs = 1500): Promise<string | null> {
  if (!companion.config.token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${companion.port}/api`, { headers: { Authorization: `token ${companion.config.token}` }, signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: string };
    return body.version ?? '';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseMarker(text: string): Marker | null {
  try {
    const value = JSON.parse(text) as Partial<Marker>;
    if (typeof value.id !== 'string' || typeof value.page !== 'string') return null;
    return {
      id: value.id,
      title: typeof value.title === 'string' ? value.title : value.id,
      page: value.page,
      cites: Array.isArray(value.cites) ? value.cites.filter((c) => c && typeof c.page === 'string' && typeof c.title === 'string') : [],
    };
  } catch {
    return null;
  }
}

export async function readMarker(folder: string): Promise<Marker | null> {
  try {
    return parseMarker(await fs.readFile(path.join(folder, '.reader', 'playground.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** The projects in the Companion's folder: ~/Reader/playgrounds/<name>, each with its marker when the site wrote one. */
export async function listProjects(companion: Companion): Promise<Project[]> {
  const base = path.join(companion.root, 'playgrounds');
  let names: string[] = [];
  try {
    names = (await fs.readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  } catch {
    return [];
  }
  const projects = await Promise.all(names.map(async (name) => ({ name, folder: path.join(base, name), marker: await readMarker(path.join(base, name)) })));
  return projects.sort((a, b) => (a.marker?.title ?? a.name).localeCompare(b.marker?.title ?? b.name));
}

/** The project a file or folder is in, if it is under the Companion's playgrounds. */
export function projectFolderOf(companion: Companion, file: string): string | null {
  const base = path.join(companion.root, 'playgrounds') + path.sep;
  if (!file.startsWith(base)) return null;
  const name = file.slice(base.length).split(path.sep)[0];
  return name ? path.join(base, name) : null;
}

/** The Companion's Python for a project: --python if it was given one, else ~/Reader/.venv. */
export function interpreterOf(companion: Companion, platform = process.platform): string {
  if (companion.config.python) return expandHome(companion.config.python);
  return platform === 'win32' ? path.join(companion.root, '.venv', 'Scripts', 'python.exe') : path.join(companion.root, '.venv', 'bin', 'python');
}

/** The command that starts the Companion, as the site's card gives it. */
export function startCommand(site: string, platform = process.platform, tunnel = false): string {
  const base = site.replace(/\/?$/, '/');
  if (platform === 'win32') return `powershell -ExecutionPolicy ByPass -c "irm ${base}companion.ps1 | iex"`;
  return `curl -LsSf ${base}companion.sh | sh -s -- --no-browser${tunnel ? ' --tunnel' : ''}`;
}

/**
 * `¶ Title §3.1` in a line, as the site writes a citation into a cell or a
 * file: where it is and the cite it names (by title, the longest that fits).
 */
export function findCitations(line: string, cites: Marker['cites']): { start: number; end: number; cite: Marker['cites'][number]; place: string }[] {
  const found: { start: number; end: number; cite: Marker['cites'][number]; place: string }[] = [];
  const pattern = /¶\s*([^§\n]+?)\s*(§\s*[\w.]+(?:\s*·\s*[^\n]*?)?)?(?=\s+[—–-]\s|$|\s*\*\/|\s*-->)/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const named = match[1].trim().toLowerCase();
    // The title itself, else the longest title the citation starts with (it may say more), else a title it shortens.
    const byLength = [...cites].sort((a, b) => b.title.length - a.title.length);
    const cite =
      cites.find((c) => c.title.toLowerCase() === named) ??
      byLength.find((c) => named.startsWith(c.title.toLowerCase())) ??
      byLength.find((c) => c.title.toLowerCase().startsWith(named));
    if (cite) found.push({ start: match.index, end: match.index + match[0].trimEnd().length, cite, place: (match[2] ?? '').trim() });
  }
  return found;
}
