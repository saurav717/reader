// Puts what the app sets the Companion up from into desktop/app/companion/, which
// electron-builder copies into the app's resources (extraResources):
//   uv (uv.exe on Windows)   checked against the hashes below
//   reader_companion-<version>-py3-none-any.whl   built from companion/
//   python/<release>/cpython-…-install_only_stripped.tar.gz   the Python uv installs, checked too
//   info.json                { version, site, wheel, python }
//   node scripts/prepare-companion.mjs [--platform darwin|win32|linux] [--arch x64|arm64|universal]
// The platform and arch default to this computer's; a macOS app is universal, its uv
// both architectures in one binary (lipo, so only on a Mac). READER_SITE is the site the
// app opens and pairs with (https://koios.dev/ by default).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWheel } from '../../../scripts/build-companion.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'companion');

export const UV_VERSION = '0.7.2';
// From https://github.com/astral-sh/uv/releases/download/<version>/<file>.sha256
export const UV = {
  'darwin-arm64': ['uv-aarch64-apple-darwin.tar.gz', '8edc0bea8a9e35409f970b352036326393e79a6039577d8cc9ef63872c178a99'],
  'darwin-x64': ['uv-x86_64-apple-darwin.tar.gz', '7d30b59d54900c97c492f3c07ff21cc3387a9e5bd8ca6db2d502462eaaeefd68'],
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', '35fd793df52fd13773425c9a97cc94cc13c8ee63abec6380b5083c183c688019'],
  'win32-arm64': ['uv-aarch64-pc-windows-msvc.zip', 'a3d7affcd62e617bd2dd2a91fde679dd8d68a84762c8f3aaac294606ec14ffe5'],
  'linux-x64': ['uv-x86_64-unknown-linux-gnu.tar.gz', 'cfaab1b5166a6439ff66f020333d3a12bbdf622deee3b510718283e8f06c9de7'],
  'linux-arm64': ['uv-aarch64-unknown-linux-gnu.tar.gz', '2872fdf4785666575d129ba90590c44e6508e22584735f3e7e8a30d773dfc3db'],
};

// The Python inside the app: the 3.12 this uv installs (`uv python list --all-platforms --show-urls 3.12`), from
// https://github.com/astral-sh/python-build-standalone/releases/download/<release>/SHA256SUMS. The app points uv
// at it (UV_PYTHON_INSTALL_MIRROR), so setting up downloads no Python: from GitHub, a slow connection timed out.
// A new UV_VERSION may want a newer 3.12, and would download it as before: update the two together.
// None for a platform (Windows on Arm, which this uv has no 3.12.10 for): the app downloads it there, as before.
export const PYTHON_RELEASE = '20250409';
const PYTHON_VERSION = '3.12.10';
export const PYTHON = {
  'darwin-arm64': ['aarch64-apple-darwin', '0be1fe0b35a4d3c382141764ef16ed3b8cc2b4620b657f678daa7b7f8df39699'],
  'darwin-x64': ['x86_64-apple-darwin', 'ad3bef94b6054adcf8e0a47886e21b00dfc6a37f22eea229cf0f8725bd0e1023'],
  'win32-x64': ['x86_64-pc-windows-msvc', '08670ab68f041481b8127b2ea27e01ddf56131e61fcf845f489024fddcd3deec'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '8c59b9ac6bff2dc3934181d7bc82594f9f59a613afed8d72c9e89d7194e790ee'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', 'e1f450b77b81a250411855bb5e5cbd0f0acbc9ad46b5ea97f224452831bb3276'],
};

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

/** A file, downloaded and checked against its sha256. */
async function download(url, sha) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha) throw new Error(`${url}: sha256 ${got}, expected ${sha}`);
  return bytes;
}

/** Python for one platform and arch, where uv looks for it under a mirror: <mirror>/<release>/<file>. */
async function fetchPython(key, mirror) {
  const [triple, sha] = PYTHON[key] ?? [];
  if (!triple) return false;
  const file = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const bytes = await download(`https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(file)}`, sha);
  mkdirSync(join(mirror, PYTHON_RELEASE), { recursive: true });
  writeFileSync(join(mirror, PYTHON_RELEASE, file), bytes);
  return true;
}

/** The uv binary for one platform and arch, downloaded and checked, unpacked into `work`. Its path. */
async function fetchUv(key, work) {
  const [file, sha] = UV[key] ?? [];
  if (!file) throw new Error(`no uv for ${key}`);
  const bytes = await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${file}`, sha);
  const archive = join(work, file);
  writeFileSync(archive, bytes);
  const into = join(work, key);
  mkdirSync(into, { recursive: true });
  if (!file.endsWith('.zip')) execFileSync('tar', ['-xzf', archive, '-C', into]);
  // A zip (uv for Windows): PowerShell's on Windows (bash's tar there is GNU tar, which can't), unzip elsewhere.
  else if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`]);
  else execFileSync('unzip', ['-q', '-o', archive, '-d', into]);
  const exe = key.startsWith('win32') ? 'uv.exe' : 'uv';
  const found = [join(into, exe), ...readdirSync(into).map((name) => join(into, name, exe))].find((path) => {
    try {
      return readFileSync(path).length > 0;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`uv ${file}: no ${exe} inside`);
  return found;
}

export async function prepare({ platform = process.platform, arch = process.arch, site = process.env.READER_SITE || 'https://koios.dev/' } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  let python = true;
  const work = mkdtempSync(join(tmpdir(), 'reader-uv-'));
  try {
    const exe = platform === 'win32' ? 'uv.exe' : 'uv';
    if (platform === 'darwin' && arch === 'universal') {
      const arm = await fetchUv('darwin-arm64', work);
      const intel = await fetchUv('darwin-x64', work);
      execFileSync('lipo', ['-create', '-output', join(out, exe), arm, intel]);
    } else {
      copyFileSync(await fetchUv(`${platform}-${arch}`, work), join(out, exe));
    }
    if (platform !== 'win32') chmodSync(join(out, exe), 0o755);
    const arches = platform === 'darwin' && arch === 'universal' ? ['arm64', 'x64'] : [arch];
    for (const one of arches) python = (await fetchPython(`${platform}-${one}`, join(out, 'python'))) && python;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const wheel = buildWheel();
  writeFileSync(join(out, wheel.name), wheel.bytes);
  const info = { version: wheel.version, site: site.replace(/\/?$/, '/'), wheel: wheel.name, ...(python && { python: 'python' }) };
  writeFileSync(join(out, 'info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`desktop/app/companion: uv ${UV_VERSION} (${platform}-${arch}), ${python ? `Python ${PYTHON_VERSION}` : 'no Python'}, ${wheel.name}, for ${info.site}`);
  return info;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const platform = option('platform', process.platform);
  await prepare({ platform, arch: option('arch', platform === 'darwin' ? 'universal' : process.arch) });
}
