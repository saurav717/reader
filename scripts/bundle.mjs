// Loads a TypeScript module from src/ into the test runner.
//
// Node can strip the types by itself, but it will not resolve the
// extension-less imports the app is written with — that is the bundler's job —
// so the module under test is bundled to a temporary file and imported from
// there. `import.meta.env` is Vite's, and is replaced with an empty object so
// that the modules behave as they do on a deployment with no proxy configured
// beyond the default.

import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = [];

/** Vite's `?raw` imports (a file's text as the default export), which esbuild does not know by itself. */
const raw = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`, loader: 'js' }));
  },
};

/**
 * `external` names packages to leave as imports rather than bundle — for a
 * module that loads one lazily and whose tests never reach that path. With
 * `imports`, those packages are imported for real: the bundle is written
 * inside the repository, where Node can find them in node_modules.
 */
export async function load(entry, { external = [], imports = false } = {}) {
  const base = imports ? resolve('node_modules/.cache') : tmpdir();
  if (imports) await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'reader-test-'));
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
    external,
    plugins: [raw],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

/**
 * Several modules bundled together, so that they share the one instance of
 * everything they import. Module-level state — the contact address, the proxy
 * base — is per bundle, so a test that sets it through one module and reads it
 * through another has to load both at once or it is talking to two different
 * copies.
 */
export async function loadTogether(entries, { external = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reader-test-'));
  temporary.push(directory);
  const barrel = join(directory, 'entry.mjs');
  await writeFile(
    barrel,
    entries.map((entry) => `export * from ${JSON.stringify(resolve(entry))};`).join('\n'),
  );
  const outfile = join(directory, 'bundle.mjs');
  await build({
    entryPoints: [barrel],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    banner: { js: 'const __viteEnv = {};' },
    define: { 'import.meta.env': '__viteEnv' },
    external,
    plugins: [raw],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

export async function cleanup() {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
  temporary.length = 0;
}
