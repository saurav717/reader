// The local workspace: the Implementation page's scaffold, written onto the
// machine the proxy runs on, and run there.
//
// Colab is the easy case — a notebook, uploaded or opened from GitHub. The
// harder one is a paper whose reproduction wants a machine of one's own: a
// GPU under the desk, days of training, a directory to keep coming back to.
// The proxy already runs on that machine, so it can do three things for the
// page: say what the machine is (its GPUs, memory and disk, so the compute
// budget is worked out for the real thing), write the starter files into a
// directory there, and run a command in that directory with its output
// streamed back.
//
// None of it is on unless READER_WORKSPACE names a directory: the reader
// does not write to a disk it was not pointed at. Files only ever go under
// that directory, one folder a paper; a path that climbs out of it is
// refused, and a file that already exists is left alone unless the page
// says to overwrite it. A command runs as whoever started the proxy — it
// is their machine and their shell — so the routes are gated like the
// browser's: the token when one is wanted, and only from this app.

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The directory implementations are written under, or '' when the workspace is off. */
export const root = () => {
  const value = (process.env.READER_WORKSPACE || '').trim();
  return value ? path.resolve(value.replace(/^~(?=$|\/)/, os.homedir())) : '';
};

export const available = () => Boolean(root());

/** A folder name a paper's project may have: letters, digits and dashes, nothing that names a path. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A path inside a project: relative, forward slashes, no climbing, no hidden system files. */
function insideProject(dir, relative) {
  const cleaned = String(relative || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!cleaned || cleaned.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(cleaned) || /\0/.test(cleaned)) return null;
  const full = path.resolve(dir, cleaned);
  return full.startsWith(dir + path.sep) ? full : null;
}

const worded = (message) => Object.assign(new Error(message), { forPerson: true });

/** How long a detection command may take before the machine is reported without it. */
const PROBE_MS = 4000;

/** Runs a command for its stdout, or '' when it is not there or takes too long. */
function probe(command, args) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', () => finish(''));
      child.on('close', (code) => finish(code === 0 ? out : ''));
      setTimeout(() => {
        child.kill();
        finish('');
      }, PROBE_MS).unref();
    } catch {
      finish('');
    }
  });
}

/** The GPUs nvidia-smi sees: name and memory, one a line. */
export function parseNvidiaSmi(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, memory] = line.split(',').map((part) => part.trim());
      const mib = Number(memory);
      return { name: name || 'GPU', vramGb: Number.isFinite(mib) ? Math.round(mib / 1024) : undefined };
    });
}

/** What this machine is: GPUs, memory, free disk under the workspace, and which Python it has. */
export async function machine() {
  const dir = root();
  const [smi, python, torch] = await Promise.all([
    probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']),
    probe('python3', ['--version']).then((v) => v || probe('python', ['--version'])),
    probe('python3', ['-c', 'import torch;print(torch.__version__, torch.cuda.is_available())']),
  ]);
  let diskFreeGb;
  try {
    const fs = await statfs(dir || os.homedir());
    diskFreeGb = Math.round((Number(fs.bavail) * Number(fs.bsize)) / 1e9);
  } catch {
    // statfs is not everywhere
  }
  const [torchVersion, cuda] = torch.trim().split(' ');
  return {
    host: os.hostname(),
    platform: `${os.type()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model?.trim() || '',
    cores: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 1e9),
    diskFreeGb,
    gpus: parseNvidiaSmi(smi),
    python: python.trim() || null,
    torch: torchVersion ? { version: torchVersion, cuda: cuda === 'True' } : null,
  };
}

/** The projects already in the workspace, newest first. */
export async function projects() {
  const dir = root();
  if (!dir) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
        .map(async (entry) => {
          const info = await stat(path.join(dir, entry.name));
          return { slug: entry.name, dir: path.join(dir, entry.name), modified: info.mtimeMs };
        }),
    );
    return found.sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

/** Everything the status route says. */
export async function status() {
  if (!available()) return { available: false, reason: 'READER_WORKSPACE is not set on the proxy, so it writes nothing to disk.' };
  return { available: true, root: root(), machine: await machine(), projects: await projects() };
}

/**
 * Writes a project's files under the workspace. A file that is already
 * there with other content is skipped and named, so the page can ask
 * before it is replaced; `overwrite` replaces it.
 */
export async function writeScaffold({ slug, files, overwrite = false }) {
  if (!available()) throw worded('READER_WORKSPACE is not set on the proxy.');
  if (!SLUG.test(String(slug || ''))) throw worded('that project name will not do as a folder name');
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw worded('no files to write');
  const dir = path.join(root(), slug);
  await mkdir(dir, { recursive: true });
  const written = [];
  const skipped = [];
  const refused = [];
  for (const [relative, content] of Object.entries(files)) {
    const full = insideProject(dir, relative);
    if (!full || typeof content !== 'string') {
      refused.push(relative);
      continue;
    }
    let existing = null;
    try {
      existing = await readFile(full, 'utf8');
    } catch {
      // new file
    }
    if (existing !== null && existing !== content && !overwrite) {
      skipped.push(relative);
      continue;
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    written.push(relative);
  }
  return { dir, written, skipped, refused };
}

/** How long a run may go on: training runs for days, so this is a ceiling, not a budget. */
const RUN_MAX_MS = 7 * 24 * 3600 * 1000;

/**
 * Runs a shell command in a project's directory, writing its output to
 * `res` as it comes, and ends when it does. Closing the response kills it,
 * so the page's Stop is the connection going away. The environment is the
 * proxy's own — the person's shell, their CUDA, their Python — with the
 * project's directory first on the path for its scripts.
 */
export function run({ slug, command }, res, req) {
  if (!available()) throw worded('READER_WORKSPACE is not set on the proxy.');
  if (!SLUG.test(String(slug || ''))) throw worded('that project name will not do as a folder name');
  const text = String(command || '').trim();
  if (!text || text.length > 4000) throw worded('no command to run');
  const dir = path.join(root(), slug);
  const shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? ['/c', text] : ['-lc', text];
  const child = spawn(shell, args, {
    cwd: dir,
    env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', TERM: 'dumb', READER_PROJECT: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write(`$ ${text}\n`);
  const started = Date.now();
  const forward = (chunk) => {
    if (!res.writableEnded) res.write(chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_MAX_MS);
  timer.unref();
  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  };
  req?.on('close', stop);
  res.on('close', stop);
  child.on('error', (error) => {
    forward(`\n[reader] could not start ${shell}: ${error.message}\n`);
    if (!res.writableEnded) res.end();
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    forward(`\n[reader] ${signal ? `stopped (${signal})` : `exit ${code}`} after ${seconds}s\n`);
    if (!res.writableEnded) res.end();
  });
  return child;
}
