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
import { buildWheel, downloads, installers, projectOf, setupInstallers } from './build-companion.mjs';

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
    assert.deepEqual(companion.pairFragment('#pair=abc-def&port=47400'), { code: 'ABC-DEF', port: 47400, tls: null, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABCDEF'), { code: 'ABC-DEF', port: companion.COMPANION_PORT, tls: null, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABC-DEF&port=99999&tls=0'), { code: 'ABC-DEF', port: companion.COMPANION_PORT, tls: null, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABC-DEF&port=47321&tls=47331'), { code: 'ABC-DEF', port: 47321, tls: 47331, via: null });
    assert.deepEqual(companion.pairFragment('#pair=ABC-DEF&port=47321&via=https%3A%2F%2Fbrave-otter.trycloudflare.com'), { code: 'ABC-DEF', port: 47321, tls: null, via: 'https://brave-otter.trycloudflare.com/' });
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
  it('tries the address on this computer first (https first, and only https in Safari), then the tunnel', () => {
    const via = 'https://brave-otter.trycloudflare.com/';
    // The others: https when it has it (encrypted), plain http on this computer if this browser can't use it, then the tunnel.
    assert.deepEqual(companion.companionRoutes(47321, via, false), ['https://127.0.0.1:47331/', 'http://127.0.0.1:47321/', via]);
    assert.deepEqual(companion.companionRoutes(47321, via, false, null), ['http://127.0.0.1:47321/', via]);
    // Safari: the Companion's https address on this computer, then the tunnel.
    assert.deepEqual(companion.companionRoutes(47321, via, true), ['https://127.0.0.1:47331/', via]);
    assert.deepEqual(companion.companionRoutes(47321, null, false), ['https://127.0.0.1:47331/', 'http://127.0.0.1:47321/']);
    assert.deepEqual(companion.companionRoutes(47321, null, true), ['https://127.0.0.1:47331/']);
    assert.deepEqual(companion.companionRoutes(47321, null, true, 47400), ['https://127.0.0.1:47400/']);
    assert.deepEqual(companion.companionRoutes(47321, via, true, null), [via]);
    assert.equal(companion.localBase(true), 'https://127.0.0.1:47331/');
    assert.equal(companion.localBase(false), 'http://127.0.0.1:47321/');
    assert.equal(companion.companionPort('https://127.0.0.1:47331/'), 47331);
    assert.equal(companion.isSecure('https://127.0.0.1:47331/'), true);
    assert.equal(companion.isSecure('http://127.0.0.1:47321/'), false);
  });
  it('moves a paired Companion to https only when the same Companion answers there', async () => {
    const real = globalThis.fetch;
    let answer = { app: 'reader-companion', name: 'Mac', id: 'abc', version: '0.6.0' };
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      return answer ? new Response(JSON.stringify(answer)) : Promise.reject(new TypeError('failed'));
    };
    try {
      assert.equal(await companion.secureAddress({ url: 'http://127.0.0.1:47321/', companionId: 'abc' }), 'https://127.0.0.1:47331/');
      assert.equal(asked.at(-1), 'https://127.0.0.1:47331/companion/info');
      // Another Companion, a server that isn't one, one already on https, and nothing answering: left as they are.
      assert.equal(await companion.secureAddress({ url: 'http://127.0.0.1:47321/', companionId: 'other' }), null);
      assert.equal(await companion.secureAddress({ url: 'http://127.0.0.1:8888/' }), null);
      assert.equal(await companion.secureAddress({ url: 'https://127.0.0.1:47331/', companionId: 'abc' }), null);
      answer = null;
      assert.equal(await companion.secureAddress({ url: 'http://127.0.0.1:47321/', companionId: 'abc' }), null);
    } finally {
      globalThis.fetch = real;
    }
  });
  it('shuts a Companion down with its token, and says when it is too old to', async () => {
    const real = globalThis.fetch;
    const calls = [];
    let status = 200;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(status === 200 ? { stopping: true } : {}), { status });
    };
    try {
      await companion.shutdownCompanion({ url: 'https://127.0.0.1:47331', token: 't0k' });
      assert.equal(calls[0].url, 'https://127.0.0.1:47331/companion/shutdown');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers.Authorization, 'token t0k');
      status = 404;
      await assert.rejects(companion.shutdownCompanion({ url: 'http://127.0.0.1:47321/', token: 't0k' }), /older than the Shut down button/);
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(companion.START_LINK, 'reader-companion://start');
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
    assert.equal(downloads.mac.href, 'https://saurav717.github.io/reader/download/Koios-Companion-mac.zip');
    assert.equal(downloads.mac.file, 'Koios Companion.command');
    assert.equal(downloads.windows.href, 'https://saurav717.github.io/reader/download/Koios-Companion-Setup.cmd');
    assert.equal(downloads.linux.href, 'https://saurav717.github.io/reader/download/koios-companion-setup.sh');
    assert.equal(downloads.linux.command, 'curl -LsSf https://saurav717.github.io/reader/companion-setup.sh | sh');
  });
  it('offers the newest Reader desktop app for each system, signed before unsigned, and nothing while there is none', async () => {
    const realFetch = globalThis.fetch;
    const store = new Map();
    globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
    const answer = (releases) => (globalThis.fetch = async () => new Response(JSON.stringify(releases), { status: 200 }));
    const asset = (name) => ({ name, browser_download_url: `https://x/${name}` });
    try {
      answer([
        { draft: true, assets: [asset('Reader-0.14.0.dmg')] },
        { tag_name: 'v9', assets: [asset('notes.txt')] },
        { assets: [asset('Reader-0.13.0-unsigned.dmg'), asset('Reader-Setup-0.13.0.exe'), asset('reader_0.13.0_amd64.deb'), asset('Reader-0.13.0-x86_64.AppImage'), asset('reader-0.13.0.x86_64.rpm')] },
        { assets: [asset('Reader.dmg')] },
      ]);
      const apps = await companion.latestDesktopApps();
      assert.deepEqual(apps.mac, { url: 'https://x/Reader-0.13.0-unsigned.dmg', file: 'Reader-0.13.0-unsigned.dmg', signed: false });
      assert.equal(apps.windows.file, 'Reader-Setup-0.13.0.exe');
      assert.equal(apps.linux.deb.file, 'reader_0.13.0_amd64.deb');
      assert.equal(apps.linux.rpm.file, 'reader-0.13.0.x86_64.rpm');
      assert.equal(apps.linux.appImage.file, 'Reader-0.13.0-x86_64.AppImage');
      store.clear();
      answer([{ assets: [asset('Reader-0.13.0-unsigned.dmg'), asset('Reader-0.13.0.dmg')] }]);
      assert.deepEqual(await companion.latestDesktopApps(), { mac: { url: 'https://x/Reader-0.13.0.dmg', file: 'Reader-0.13.0.dmg', signed: true } });
      // asked once a session
      answer([]);
      assert.equal((await companion.latestDesktopApps()).mac.file, 'Reader-0.13.0.dmg');
      store.clear();
      assert.deepEqual(await companion.latestDesktopApps(), {});
      assert.equal(companion.appAssetKind('Reader.dmg').kind, 'mac'); // the Swift launcher's releases still count
      assert.equal(companion.appAssetKind('Reader-Companion-Setup.cmd'), null);
      // What the app updates itself from, beside the installers: not offered as downloads.
      for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'Reader-0.14.312-mac.zip', 'Reader-Setup-0.14.312-unsigned.exe.blockmap']) assert.equal(companion.appAssetKind(name), null, name);
      assert.deepEqual(companion.appAssetKind('Reader-0.14.312-unsigned.dmg'), { kind: 'mac', signed: false });
      // Koios, from 0.16: the newest release's installers are offered under the new name, the older ones still found.
      for (const name of ['Koios-0.16.44-mac.zip', 'Koios-Setup-0.16.44-unsigned.exe.blockmap', 'Koios-Companion-Setup.cmd']) assert.equal(companion.appAssetKind(name), null, name);
      store.clear();
      answer([
        { assets: [asset('Koios-0.16.44-unsigned.dmg'), asset('Koios-Setup-0.16.44-unsigned.exe'), asset('koios_0.16.44_amd64.deb'), asset('Koios-0.16.44-x86_64.AppImage'), asset('koios-0.16.44.x86_64.rpm')] },
        { assets: [asset('Reader-0.16.43-unsigned.dmg')] },
      ]);
      const now = await companion.latestDesktopApps();
      assert.equal(now.mac.file, 'Koios-0.16.44-unsigned.dmg');
      assert.equal(now.windows.file, 'Koios-Setup-0.16.44-unsigned.exe');
      assert.equal(now.linux.deb.file, 'koios_0.16.44_amd64.deb');
      assert.equal(now.linux.rpm.file, 'koios-0.16.44.x86_64.rpm');
      assert.equal(now.linux.appImage.file, 'Koios-0.16.44-x86_64.AppImage');
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.sessionStorage;
    }
  });
  it('compares versions as numbers', () => {
    assert.equal(companion.isNewer('0.5.1', '0.5.0'), true);
    assert.equal(companion.isNewer('0.10.0', '0.9.2'), true);
    assert.equal(companion.isNewer('0.5.0', '0.5.0'), false);
    assert.equal(companion.isNewer('0.4.0', '0.5'), false);
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
    for (const name of ['reader_companion/__init__.py', 'reader_companion/cli.py', 'reader_companion/desktop.py', 'reader_companion/env.py', 'reader_companion/extension.py', 'reader_companion/state.py', 'reader_companion/tls.py', 'reader_companion/tunnel.py', `${info}/METADATA`, `${info}/WHEEL`, `${info}/RECORD`, `${info}/entry_points.txt`]) assert.ok(files.has(name), name);
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
  it('says which version an installed Companion updates itself to', () => {
    const { wheel: url } = installers('https://example.org/reader', wheel.name);
    assert.ok(url.startsWith('https://example.org/reader/companion/') && url.endsWith('.whl'));
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
    assert.deepEqual([...mac.keys()], ['Koios Companion.command']);
    assert.ok(mac.get('Koios Companion.command').toString().includes('curl -LsSf https://example.org/reader/companion-setup.sh | sh'));
    // Served under Koios's names, and under Reader's too for links from before 0.16.
    const files = downloads(setupInstallers('https://example.org/reader/', 'reader_companion-0.16.1-py3-none-any.whl'));
    assert.deepEqual(Object.keys(files).sort(), ['Koios-Companion-Setup.cmd', 'Koios-Companion-mac.zip', 'Reader-Companion-Setup.cmd', 'Reader-Companion-mac.zip', 'koios-companion-setup.sh', 'reader-companion-setup.sh']);
    assert.equal(files['Reader-Companion-mac.zip'], files['Koios-Companion-mac.zip']);
    const end = setup.mac.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = setup.mac.readUInt32LE(end + 16);
    assert.equal((setup.mac.readUInt32LE(central + 38) >>> 16) & 0o777, 0o755);
    // Windows: CRLF, and the setup script through PowerShell.
    assert.ok(!/[^\r]\n/.test(setup.cmd));
    assert.ok(setup.cmd.includes('irm https://example.org/reader/companion-setup.ps1 | iex'));
  });
});

describe('the folder VS Code in the page opens', () => {
  it('is a path from the root, with forward slashes, on every system', () => {
    assert.equal(companion.vscodeFolder('/Users/me/Reader/playgrounds/x'), '/Users/me/Reader/playgrounds/x');
    assert.equal(companion.vscodeFolder('C:\\Users\\me\\Reader\\playgrounds\\x'), '/C:/Users/me/Reader/playgrounds/x');
  });
});
