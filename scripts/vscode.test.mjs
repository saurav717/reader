// The Reader extension for VS Code, without VS Code: what it reads from the
// Companion's settings and a project's marker, the citations it links, the
// commands it runs, and the .vsix scripts/build-vscode.mjs makes, unzipped and
// checked against VS Code's layout. (It was also installed into code-server,
// VS Code 1.104, and driven in a browser: see the PR.)
//
//   node --test scripts/vscode.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { cleanup, load } from './bundle.mjs';
import { buildVsix, contentTypes, vsixManifest } from './build-vscode.mjs';
import { siteTokens, themeFiles, vscodeTheme } from './vscode-themes.mjs';

const ext = await load('vscode/src/companion.ts', { external: ['node:fs', 'node:os', 'node:path'] });
const site = await load('src/lib/companion.ts');
after(cleanup);

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

const cites = [
  { paperId: 'a', title: 'FlashAttention-2', page: 'https://x/reader/paper/a' },
  { paperId: 'b', title: 'FlashAttention', page: 'https://x/reader/paper/b' },
  { paperId: 'c', title: 'LoRA: Low-Rank Adaptation of Large Language Models', page: 'https://x/reader/paper/c' },
];

describe('the Companion, as the extension reads it', () => {
  it('reads its settings, and falls back to its defaults when it never ran', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-'));
    const none = await ext.readCompanion('https://x/reader', { READER_COMPANION_HOME: home });
    assert.equal(none.port, 47321);
    assert.equal(none.site, 'https://x/reader/');
    assert.match(none.root, /Reader$/);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 't', port: 47400, root: join(home, 'R'), site: 'https://y/reader', python: '/opt/conda/bin/python' }));
    const some = await ext.readCompanion('https://x/reader/', { READER_COMPANION_HOME: home });
    assert.deepEqual([some.port, some.root, some.site], [47400, join(home, 'R'), 'https://y/reader/']);
    assert.equal(ext.interpreterOf(some), '/opt/conda/bin/python');
    assert.equal(ext.interpreterOf({ ...some, config: {} }, 'linux'), join(home, 'R', '.venv', 'bin', 'python'));
  });
  it('lists the projects, with what each marker says, and finds the project a file is in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-'));
    const companion = { config: {}, root, port: 47321, site: 'https://x/reader/' };
    mkdirSync(join(root, 'playgrounds', 'sweep', '.reader'), { recursive: true });
    mkdirSync(join(root, 'playgrounds', 'bare'), { recursive: true });
    mkdirSync(join(root, 'playgrounds', '.hidden'), { recursive: true });
    writeFileSync(join(root, 'playgrounds', 'sweep', '.reader', 'playground.json'), JSON.stringify({ id: 'p1', title: 'Attention sweep', page: 'https://x/reader/playground/p1', cites }));
    const projects = await ext.listProjects(companion);
    assert.deepEqual(projects.map((p) => [p.name, p.marker?.title ?? null]), [['sweep', 'Attention sweep'], ['bare', null]]);
    assert.equal(ext.projectFolderOf(companion, join(root, 'playgrounds', 'sweep', 'src', 'train.py')), join(root, 'playgrounds', 'sweep'));
    assert.equal(ext.projectFolderOf(companion, join(root, 'elsewhere.py')), null);
  });
  it('ignores a marker that isn’t one', () => {
    assert.equal(ext.parseMarker('{'), null);
    assert.equal(ext.parseMarker('{"title":"no id"}'), null);
    assert.deepEqual(ext.parseMarker('{"id":"p","page":"https://x","cites":[{"title":"T","page":"https://y"},{"bad":1}]}').cites, [{ title: 'T', page: 'https://y' }]);
  });
  it('starts the Companion the way the site’s card does, without opening a browser', () => {
    assert.equal(ext.startCommand('https://x/reader', 'darwin'), 'curl -LsSf https://x/reader/companion.sh | sh -s -- --no-browser');
    assert.equal(ext.startCommand('https://x/reader/', 'darwin', true), 'curl -LsSf https://x/reader/companion.sh | sh -s -- --no-browser --tunnel');
    assert.match(ext.startCommand('https://x/reader/', 'win32'), /irm https:\/\/x\/reader\/companion\.ps1 \| iex/);
  });
});

describe('citations', () => {
  it('links a ¶ citation to the paper it names, the longest title that fits', () => {
    const found = ext.findCitations('# ¶ FlashAttention-2 §3.1 · Alg. 1 — tile Q, loop over K/V blocks', cites);
    assert.equal(found.length, 1);
    assert.equal(found[0].cite.paperId, 'a');
    assert.equal(found[0].place, '§3.1 · Alg. 1');
    assert.equal(found[0].start, 2);
    assert.equal(ext.findCitations('// ¶ FlashAttention §2', cites)[0].cite.paperId, 'b');
    assert.equal(ext.findCitations('¶ LoRA §4', cites)[0].cite.paperId, 'c');
  });
  it('leaves a line with no citation, or one to a paper the project doesn’t cite', () => {
    assert.deepEqual(ext.findCitations('x = 1  # no citation here', cites), []);
    assert.deepEqual(ext.findCitations('# ¶ Attention Is All You Need §3', cites), []);
  });
});

describe('the .vsix', () => {
  it('is laid out as VS Code installs it', async () => {
    const built = await buildVsix();
    const files = unzip(built.bytes);
    const pkg = JSON.parse(readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8'));
    assert.equal(built.name, `reader-playground-${pkg.version}.vsix`);
    for (const name of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/dist/extension.js', 'extension/README.md', 'extension/media/reader.svg', 'extension/media/icon.png']) assert.ok(files.has(name), name);
    const manifest = files.get('extension.vsixmanifest').toString();
    assert.match(manifest, new RegExp(`<Identity Language="en-US" Id="reader-playground" Version="${pkg.version}" Publisher="${pkg.publisher}" />`));
    assert.match(manifest, /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.85\.0"/);
    assert.match(files.get('[Content_Types].xml').toString(), /Extension="\.js" ContentType="application\/javascript"/);
    const bundled = files.get('extension/dist/extension.js').toString();
    assert.match(bundled, /require\("vscode"\)/);
    assert.match(bundled, /exports\.activate|activate:/);
    assert.equal(JSON.parse(files.get('extension/package.json')).main, './dist/extension.js');
  });
  it('builds the same bytes twice', async () => {
    assert.ok((await buildVsix()).bytes.equals((await buildVsix()).bytes));
  });
  it('escapes what goes into its XML', () => {
    assert.match(vsixManifest({ name: 'n', version: '1', publisher: 'p', description: 'a < b & "c"', engines: { vscode: '^1' } }, {}), /a &lt; b &amp; &quot;c&quot;/);
    assert.doesNotMatch(contentTypes(['a.weird']), /weird/);
  });
});

describe('the site’s VS Code tab', () => {
  it('installs the .vsix the site serves', () => {
    assert.equal(site.vscodeInstall('https://x/reader').command, 'curl -LsSfo /tmp/reader-playground.vsix https://x/reader/vscode/reader-playground.vsix && code --install-extension /tmp/reader-playground.vsix');
    assert.match(site.vscodeInstall('https://x/reader/', true).command, /irm https:\/\/x\/reader\/vscode\/reader-playground\.vsix -OutFile \$env:TEMP\\reader-playground\.vsix; code --install-extension/);
  });
});

describe('the site’s look in VS Code', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  it('reads the site’s tokens, light and dark', () => {
    const { light, dark } = siteTokens(css);
    assert.equal(light.paper, '#fbfaf6');
    assert.equal(dark.paper, '#15161a');
    assert.equal(light['tok-k'], '#8a3b8f');
    assert.equal(dark['tok-k'], '#d59ee0');
    assert.equal(dark['tok-n'] !== undefined && dark['accent-on'] !== undefined, true);
  });
  it('makes every colour a real one', () => {
    const { light, dark } = siteTokens(css);
    for (const [tokens, isDark] of [[light, false], [dark, true]]) {
      const theme = vscodeTheme(tokens, isDark);
      for (const [key, value] of Object.entries(theme.colors)) assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, key);
      for (const rule of theme.tokenColors) assert.match(rule.settings.foreground, /^#[0-9a-f]{6}$/i, String(rule.scope));
      assert.equal(theme.colors['editor.background'], tokens.paper);
      assert.equal(theme.colors['statusBar.background'], tokens.accent);
    }
  });
  it('ships themes that match the stylesheet, and names them in the manifest', async () => {
    const files = themeFiles(css);
    const pkg = JSON.parse(readFileSync(new URL('../vscode/package.json', import.meta.url), 'utf8'));
    for (const theme of pkg.contributes.themes) {
      const name = theme.path.replace(/^\.\//, '');
      assert.equal(readFileSync(new URL(`../vscode/${name}`, import.meta.url), 'utf8'), files[name], `${name} is out of date: node scripts/vscode-themes.mjs`);
    }
    const vsix = unzip((await buildVsix()).bytes);
    for (const name of Object.keys(files)) assert.equal(vsix.get(`extension/${name}`).toString(), files[name]);
  });
});
