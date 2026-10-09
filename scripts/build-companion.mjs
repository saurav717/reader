// Builds the Reader Companion into a site build: its wheel, and the two one-line
// installers the Playground's "Connect this computer" card shows.
//   node scripts/build-companion.mjs <outDir> [siteUrl]
// writes <outDir>/companion/reader_companion-<version>-py3-none-any.whl,
// <outDir>/companion.sh and <outDir>/companion.ps1. The wheel is made here, in
// Node, so building the site needs no Python: a wheel is a zip of the package
// and a few metadata files. siteUrl is the address the build is served at
// (https://saurav717.github.io/reader/ by default, or READER_SITE); the
// installers fetch the wheel from it, and the Companion pairs back with it.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'companion');

/** The name, version and dependencies out of companion/pyproject.toml — the few keys it has. */
export function projectOf(toml) {
  const field = (key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  const list = (key) => [...(toml.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const scripts = [...(toml.split('[project.scripts]')[1]?.split(/^\[/m)[0] ?? '').matchAll(/^([\w-]+)\s*=\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]);
  return { name: field('name'), version: field('version'), summary: field('description'), requiresPython: field('requires-python'), dependencies: list('dependencies'), scripts };
}

// ------------------------------------------------------------------ zip ----

/** A zip of [name, bytes] pairs, deflated, with fixed dates so a rebuild is byte-for-byte the same. */
export function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by: Unix
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// ---------------------------------------------------------------- wheel ----

const digest = (data) => `sha256=${createHash('sha256').update(data).digest('base64url')}`;

/** The wheel's file name and bytes, from companion/. */
export function buildWheel(dir = source) {
  const project = projectOf(readFileSync(join(dir, 'pyproject.toml'), 'utf8'));
  const pkg = project.name.replace(/-/g, '_');
  const info = `${pkg}-${project.version}.dist-info`;
  const files = readdirSync(join(dir, pkg))
    .filter((file) => file.endsWith('.py'))
    .sort()
    .map((file) => [`${pkg}/${file}`, readFileSync(join(dir, pkg, file))]);
  const metadata = [
    'Metadata-Version: 2.1',
    `Name: ${project.name}`,
    `Version: ${project.version}`,
    `Summary: ${project.summary ?? ''}`,
    ...(project.requiresPython ? [`Requires-Python: ${project.requiresPython}`] : []),
    ...project.dependencies.map((dep) => `Requires-Dist: ${dep}`),
    '',
    '',
  ].join('\n');
  files.push([`${info}/METADATA`, Buffer.from(metadata)]);
  files.push([`${info}/WHEEL`, Buffer.from('Wheel-Version: 1.0\nGenerator: reader scripts/build-companion.mjs\nRoot-Is-Purelib: true\nTag: py3-none-any\n')]);
  files.push([`${info}/entry_points.txt`, Buffer.from(`[console_scripts]\n${project.scripts.map(([name, target]) => `${name} = ${target}`).join('\n')}\n`)]);
  const record = files.map(([name, data]) => `${name},${digest(data)},${data.length}`).concat(`${info}/RECORD,,`).join('\n') + '\n';
  files.push([`${info}/RECORD`, Buffer.from(record)]);
  return { name: `${pkg}-${project.version}-py3-none-any.whl`, version: project.version, bytes: zip(files) };
}

// ----------------------------------------------------------- installers ----

export function installers(site, wheelName) {
  const base = site.replace(/\/?$/, '/');
  const wheel = `${base}companion/${wheelName}`;
  const sh = `#!/bin/sh
# Reader Companion: connects this computer to the reader's Playground at ${base}
#   curl -LsSf ${base}companion.sh | sh
# Installs uv (https://docs.astral.sh/uv/) once if it isn't there, then runs the
# Companion with it. Anything after "sh -s --" is passed on: --no-browser, --root DIR.
set -e
WHEEL="${wheel}"
SITE="${base}"
if command -v uv >/dev/null 2>&1; then
  UV=uv
elif [ -x "$HOME/.local/bin/uv" ]; then
  UV="$HOME/.local/bin/uv"
elif [ -x "$HOME/.cargo/bin/uv" ]; then
  UV="$HOME/.cargo/bin/uv"
else
  echo "Installing uv, once (https://astral.sh/uv)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi
exec "$UV" tool run --from "$WHEEL" reader-companion --site "$SITE" "$@"
`;
  const ps1 = `# Reader Companion: connects this computer to the reader's Playground at ${base}
#   powershell -ExecutionPolicy ByPass -c "irm ${base}companion.ps1 | iex"
$ErrorActionPreference = 'Stop'
$wheel = '${wheel}'
$site = '${base}'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing uv, once (https://astral.sh/uv)...'
  irm https://astral.sh/uv/install.ps1 | iex
  $env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"
}
uv tool run --from $wheel reader-companion --site $site @args
`;
  return { sh, ps1, wheel };
}

// ------------------------------------------------------------------ main ----

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/build-companion.mjs <outDir> [siteUrl]');
    process.exit(2);
  }
  const site = process.argv[3] || process.env.READER_SITE || 'https://saurav717.github.io/reader/';
  const built = buildWheel();
  mkdirSync(join(out, 'companion'), { recursive: true });
  writeFileSync(join(out, 'companion', built.name), built.bytes);
  const { sh, ps1, wheel } = installers(site, built.name);
  writeFileSync(join(out, 'companion.sh'), sh);
  writeFileSync(join(out, 'companion.ps1'), ps1);
  console.log(`companion ${built.version}: ${wheel} (${built.bytes.length} bytes), companion.sh, companion.ps1`);
}
