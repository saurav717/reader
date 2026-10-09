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
import { buildWheel, installers, projectOf } from './build-companion.mjs';

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
    assert.deepEqual(companion.pairFragment('#pair=abc-def&port=47400'), { code: 'ABC-DEF', port: 47400 });
    assert.deepEqual(companion.pairFragment('#pair=ABCDEF'), { code: 'ABC-DEF', port: companion.COMPANION_PORT });
    assert.deepEqual(companion.pairFragment('#pair=ABC-DEF&port=99999'), { code: 'ABC-DEF', port: companion.COMPANION_PORT });
    assert.equal(companion.pairFragment('#section-2'), null);
    assert.equal(companion.pairFragment(''), null);
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
    assert.match(commands.windows, /irm https:\/\/saurav717\.github\.io\/reader\/companion\.ps1 \| iex/);
    assert.match(commands.uv, new RegExp(`reader_companion-${companion.COMPANION_VERSION.replace(/\./g, '\\.')}-py3-none-any\\.whl reader-companion --site https://saurav717\\.github\\.io/reader/$`));
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
    for (const name of ['reader_companion/__init__.py', 'reader_companion/cli.py', 'reader_companion/extension.py', 'reader_companion/state.py', `${info}/METADATA`, `${info}/WHEEL`, `${info}/RECORD`, `${info}/entry_points.txt`]) assert.ok(files.has(name), name);
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
    assert.match(sh, /exec "\$UV" tool run --from "\$WHEEL" reader-companion --site "\$SITE" "\$@"/);
    assert.ok(ps1.includes(`$wheel = '${url}'`));
  });
});
