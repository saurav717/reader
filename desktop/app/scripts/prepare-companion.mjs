// Puts what the app sets the Companion up from into desktop/app/companion/, which
// electron-builder copies into the app's resources (extraResources):
//   uv (uv.exe on Windows)   checked against the hashes below
//   reader_companion-<version>-py3-none-any.whl   built from companion/
//   info.json                { version, site, wheel }
//   node scripts/prepare-companion.mjs [--platform darwin|win32|linux] [--arch x64|arm64|universal]
// The platform and arch default to this computer's; a macOS app is universal, its uv
// both architectures in one binary (lipo, so only on a Mac). READER_SITE is the site the
// app opens and pairs with (https://saurav717.github.io/reader/ by default).
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

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

/** The uv binary for one platform and arch, downloaded and checked, unpacked into `work`. Its path. */
async function fetchUv(key, work) {
  const [file, sha] = UV[key] ?? [];
  if (!file) throw new Error(`no uv for ${key}`);
  const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${file}`);
  if (!response.ok) throw new Error(`uv ${file}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha) throw new Error(`uv ${file}: sha256 ${got}, expected ${sha}`);
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

export async function prepare({ platform = process.platform, arch = process.arch, site = process.env.READER_SITE || 'https://saurav717.github.io/reader/' } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const wheel = buildWheel();
  writeFileSync(join(out, wheel.name), wheel.bytes);
  const info = { version: wheel.version, site: site.replace(/\/?$/, '/'), wheel: wheel.name };
  writeFileSync(join(out, 'info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`desktop/app/companion: uv ${UV_VERSION} (${platform}-${arch}), ${wheel.name}, for ${info.site}`);
  return info;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const platform = option('platform', process.platform);
  await prepare({ platform, arch: option('arch', platform === 'darwin' ? 'universal' : process.arch) });
}
