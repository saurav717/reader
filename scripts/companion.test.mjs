// The Reader Companion, without running it: the page's side (the pairing link,
// the code, the commands, Safari), and the wheel and installers the site build
// carries (scripts/build-companion.mjs), unzipped again and checked. The
// Companion's own tests are Python: python -m unittest discover companion/tests.
//
//   node --test scripts/companion.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { cleanup, load } from './bundle.mjs';
import { buildWheel, installers, projectOf, setupInstallers } from './build-companion.mjs';

const companion = await load('src/lib/companion.ts');
after(cleanup);

/** The files in a zip, by name, read back through its central directory. */
function unzip(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    files.set(name, inflateRawSync(bytes.subarray(start, start + size)));
    at += 46 + nameLength + extra;
  }
  return files;
}

describe('the page’s side', () => {
  it('reads the link the Companion opens', () => {
    assert.deepEqual(companion.pairFragment('#pair=abc-def&port=47400'), { code: 'ABC-DEF', port: 47400, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABCDEF'), { code: 'ABC-DEF', port: companion.COMPANION_PORT, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABC-DEF&port=99999'), { code: 'ABC-DEF', port: companion.COMPANION_PORT, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABC-DEF&port=47321&via=https%3A%2F%2Fbrave-otter.trycloudflare.com'), { code: 'ABC-DEF', port: 47321, via: 'https://brave-otter.trycloudflare.com/' });
    assert.equal(companion.pairFragment('#section-2'), null);
    assert.equal(companion.pairFragment(''), null);
  });
  it('takes only a quick tunnel’s address from a link, so a link can’t point the page at another server', () => {
    assert.equal(companion.tunnelBase('https://brave-otter.trycloudflare.com'), 'https://brave-otter.trycloudflare.com/');
    assert.equal(companion.tunnelBase('https://brave-otter.trycloudflare.com/x?y'), 'https://brave-otter.trycloudflare.com/');
    assert.equal(companion.tunnelBase('http://brave-otter.trycloudflare.com'), null);
    assert.equal(companion.tunnelBase('https://evil.example/?.trycloudflare.com'), null);
    assert.equal(companion.tunnelBase('https://trycloudflare.com.evil.example'), null);
    assert.equal(companion.tunnelBase('https://a.b.trycloudflare.com'), null);
    assert.equal(companion.tunnelBase(null), null);
  });
  it('tries the direct address first, and only the tunnel in Safari', () => {
    const via = 'https://brave-otter.trycloudflare.com/';
    assert.deepEqual(companion.companionRoutes(47321, via, false), ['http://127.0.0.1:47321/', via]);
    assert.deepEqual(companion.companionRoutes(47321, via, true), [via]);
    assert.deepEqual(companion.companionRoutes(47321, null, false), ['http://127.0.0.1:47321/']);
    assert.deepEqual(companion.companionRoutes(47321, null, true), []);
  });
  it('takes a code however it is typed', () => {
    assert.equal(companion.normaliseCode(' abc def '), 'ABC-DEF');
    assert.equal(companion.normaliseCode('ABC-DEF'), 'ABC-DEF');
    assert.equal(companion.normaliseCode('AB'), 'AB');
  });
  it('knows a Companion’s address from any other server’s', () => {
    assert.equal(companion.companionPort('http://127.0.0.1:47321/'), 47321);
    assert.equal(companion.companionPort('http://localhost:8888/'), null);
    assert.equal(companion.companionPort('https://pod-8888.proxy.runpod.net/'), null);
  });
  it('gives the commands for the site it is served from', () => {
    const commands = companion.companionCommands('https://saurav717.github.io/reader');
    assert.equal(commands.unix, 'curl -LsSf https://saurav717.github.io/reader/companion.sh | sh');
    assert.equal(companion.companionCommands('https://saurav717.github.io/reader/', { tunnel: true }).unix, 'curl -LsSf https://saurav717.github.io/reader/companion.sh | sh -s -- --tunnel');
    assert.match(commands.windows, /irm https:\/\/saurav717\.github\.io\/reader\/companion\.ps1 \| iex/);
    assert.match(commands.uv, new RegExp(`reader_companion-${companion.COMPANION_VERSION.replace(/\./g, '\\.')}-py3-none-any\\.whl reader-companion --site https://saurav717\\.github\\.io/reader/$`));
  });
  it('offers the installer for this computer’s system', () => {
    assert.equal(companion.desktopSystem('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'), 'mac');
    assert.equal(companion.desktopSystem('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'windows');
    assert.equal(companion.desktopSystem('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'linux');
    const downloads = companion.companionDownloads('https://saurav717.github.io/reader');
    assert.equal(downloads.mac.href, 'https://saurav717.github.io/reader/download/Reader-Companion-mac.zip');
    assert.equal(downloads.windows.href, 'https://saurav717.github.io/reader/download/Reader-Companion-Setup.cmd');
    assert.equal(downloads.linux.command, 'curl -LsSf https://saurav717.github.io/reader/companion-setup.sh | sh');
  });
  it('offers the newest Reader.app .dmg, notarized or not, and nothing while there is none', async () => {
    const realFetch = globalThis.fetch;
    const store = new Map();
    globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
    const answer = (releases) => (globalThis.fetch = async () => new Response(JSON.stringify(releases), { status: 200 }));
    try {
      answer([
        { draft: true, assets: [{ name: 'Reader.dmg', browser_download_url: 'https://x/draft.dmg' }] },
        { tag_name: 'v9', assets: [{ name: 'notes.txt', browser_download_url: 'https://x/notes' }] },
        { assets: [{ name: 'Reader-unsigned.dmg', browser_download_url: 'https://x/unsigned.dmg' }] },
      ]);
      assert.deepEqual(await companion.latestMacDmg(), { url: 'https://x/unsigned.dmg', notarized: false });
      store.clear();
      answer([{ assets: [{ name: 'Reader-unsigned.dmg', browser_download_url: 'https://x/u.dmg' }, { name: 'Reader.dmg', browser_download_url: 'https://x/signed.dmg' }] }]);
      assert.deepEqual(await companion.latestMacDmg(), { url: 'https://x/signed.dmg', notarized: true });
      // asked once a session
      answer([]);
      assert.deepEqual(await companion.latestMacDmg(), { url: 'https://x/signed.dmg', notarized: true });
      store.clear();
      assert.equal(await companion.latestMacDmg(), null);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.sessionStorage;
    }
  });
  it('tells Safari from the browsers that say Safari too', () => {
    assert.equal(companion.isSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), true);
    assert.equal(companion.isSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'), false);
    assert.equal(companion.isSafari('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), false);
    assert.equal(companion.isSafari('Mozilla/5.0 (Macintosh; rv:131.0) Gecko/20100101 Firefox/131.0'), false);
  });
});

describe('the wheel and the installers', () => {
  const toml = readFileSync(new URL('../companion/pyproject.toml', import.meta.url), 'utf8');
  const project = projectOf(toml);
  const wheel = buildWheel();
  const files = unzip(wheel.bytes);

  it('is the version the page asks for, and the package says it is', () => {
    assert.equal(project.version, companion.COMPANION_VERSION);
    const init = readFileSync(new URL('../companion/reader_companion/__init__.py', import.meta.url), 'utf8');
    assert.match(init, new RegExp(`__version__ = "${project.version}"`));
    assert.equal(wheel.name, `reader_companion-${project.version}-py3-none-any.whl`);
  });
  it('holds the package, its metadata and its command', () => {
    const info = `reader_companion-${project.version}.dist-info`;
    for (const name of ['reader_companion/__init__.py', 'reader_companion/cli.py', 'reader_companion/desktop.py', 'reader_companion/env.py', 'reader_companion/extension.py', 'reader_companion/state.py', 'reader_companion/tunnel.py', `${info}/METADATA`, `${info}/WHEEL`, `${info}/RECORD`, `${info}/entry_points.txt`]) assert.ok(files.has(name), name);
    const metadata = files.get(`${info}/METADATA`).toString();
    assert.match(metadata, /^Name: reader-companion$/m);
    for (const dep of project.dependencies) assert.ok(metadata.includes(`Requires-Dist: ${dep}`), dep);
    assert.match(files.get(`${info}/entry_points.txt`).toString(), /^reader-companion = reader_companion\.cli:main$/m);
  });
  it('records every file with its hash and size', () => {
    const info = `reader_companion-${project.version}.dist-info`;
    const rows = files.get(`${info}/RECORD`).toString().trim().split('\n').map((row) => row.split(','));
    assert.equal(rows.length, files.size);
    for (const [name, hash, size] of rows) {
      if (name === `${info}/RECORD`) continue;
      const data = files.get(name);
      assert.equal(hash, `sha256=${createHash('sha256').update(data).digest('base64url')}`, name);
      assert.equal(Number(size), data.length, name);
    }
  });
  it('builds the same bytes twice', () => {
    assert.ok(buildWheel().bytes.equals(wheel.bytes));
  });
  it('points the installers at the wheel and the site', () => {
    const { sh, ps1, wheel: url } = installers('https://example.org/reader', wheel.name);
    assert.equal(url, `https://example.org/reader/companion/${wheel.name}`);
    assert.ok(sh.includes(`WHEEL="${url}"`) && sh.includes('SITE="https://example.org/reader/"'));
    assert.match(sh, /exec "\$UV" tool run --python 3.12 --from "\$WHEEL" reader-companion --site "\$SITE" "\$@"/);
    assert.ok(ps1.includes(`$wheel = '${url}'`));
  });
  it('installs it for good from the setup scripts, and runs those from the double-click files', () => {
    const setup = setupInstallers('https://example.org/reader', wheel.name);
    const url = `https://example.org/reader/companion/${wheel.name}`;
    assert.match(setup.sh, new RegExp(`tool install --force --quiet --python 3.12 --from "\\$WHEEL" reader-companion`));
    assert.ok(setup.sh.includes(`WHEEL="${url}"`));
    assert.match(setup.sh, /exec "\$BIN\/reader-companion" setup --site "\$SITE" "\$@"/);
    assert.ok(setup.ps1.includes(`$wheel = '${url}'`) && setup.ps1.includes("'reader-companion.exe') setup --site $site"));
    // The Mac's .command, executable inside its zip, as a bare download wouldn't be.
    const mac = unzip(setup.mac);
    assert.deepEqual([...mac.keys()], ['Reader Companion.command']);
    assert.ok(mac.get('Reader Companion.command').toString().includes('curl -LsSf https://example.org/reader/companion-setup.sh | sh'));
    const end = setup.mac.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = setup.mac.readUInt32LE(end + 16);
    assert.equal((setup.mac.readUInt32LE(central + 38) >>> 16) & 0o777, 0o755);
    // Windows: CRLF, and the setup script through PowerShell.
    assert.ok(!/[^\r]\n/.test(setup.cmd));
    assert.ok(setup.cmd.includes('irm https://example.org/reader/companion-setup.ps1 | iex'));
  });
});
