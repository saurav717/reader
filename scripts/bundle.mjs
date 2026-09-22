// Loads a TypeScript module from src/ into the test runner.
//
// Node can strip the types by itself, but it will not resolve the
// extension-less imports the app is written with — that is the bundler's job —
// so the module under test is bundled to a temporary file and imported from
// there. `import.meta.env` is Vite's, and is replaced with an empty object so
// that the modules behave as they do on a deployment with no proxy configured
// beyond the default.

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = [];

export async function load(entry) {
  const directory = await mkdtemp(join(tmpdir(), 'reader-test-'));
  temporary.push(directory);
  const outfile = join(directory, 'bundle.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    banner: { js: 'const __viteEnv = {};' },
    define: { 'import.meta.env': '__viteEnv' },
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

export async function cleanup() {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
  temporary.length = 0;
}
