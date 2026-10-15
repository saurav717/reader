// How the Reader app tells there is a newer version of itself (desktop/app/updates.js): the update
// files electron-builder writes (latest-mac.yml and the like) read, and versions compared. The
// rest — downloading, putting the new app in place — needs the app itself.
//
//   node --test scripts/desktop-updates.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

// updates.js is the app's: Electron stands in for what it takes from it at load.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getVersion: () => '0.14.0', isPackaged: false }, BrowserWindow: {}, dialog: {}, ipcMain: {}, net: {}, shell: {} };
  return load.call(this, request, ...rest);
};
const { compareVersions, parseUpdateInfo, RELEASES } = createRequire(import.meta.url)('../desktop/app/updates.js');
Module._load = load;

describe('the app’s updates', () => {
  it('reads latest-mac.yml as electron-builder writes it', () => {
    const info = parseUpdateInfo(`version: 0.14.312
files:
  - url: Reader-0.14.312-mac.zip
    sha512: X0CTnVVzFV58I1Evv/R3cOD+nyRYY4==
    size: 126195745
    blockMapSize: 133173
  - url: Reader-0.14.312-unsigned.dmg
    sha512: 'qdpgRG5jCSlAa9D4vA4juL44atOggdcF3cyIB9XCo6eze0YA3Awp7ZO0WNmotkjbnCCPlgkaWzdWMUqPXMEjpA=='
    size: 99751892
path: Reader-0.14.312-mac.zip
sha512: X0CTnVVzFV58I1Evv/R3cOD+nyRYY4==
releaseDate: '2026-10-15T11:54:52.114Z'
`);
    assert.equal(info.version, '0.14.312');
    assert.deepEqual(info.files, [
      { url: 'Reader-0.14.312-mac.zip', sha512: 'X0CTnVVzFV58I1Evv/R3cOD+nyRYY4==', size: 126195745 },
      { url: 'Reader-0.14.312-unsigned.dmg', sha512: 'qdpgRG5jCSlAa9D4vA4juL44atOggdcF3cyIB9XCo6eze0YA3Awp7ZO0WNmotkjbnCCPlgkaWzdWMUqPXMEjpA==', size: 99751892 },
    ]);
  });

  it('leaves out a file with no checksum, and reads nothing from what is not one', () => {
    assert.deepEqual(parseUpdateInfo('version: 1.2.3\nfiles:\n  - url: a.zip\n    size: 3\n').files, []);
    assert.deepEqual(parseUpdateInfo('<html>Not Found</html>'), { version: '', files: [] });
  });

  it('compares versions by number, a prerelease before its release', () => {
    assert.ok(compareVersions('0.14.312', '0.14.0') > 0);
    assert.ok(compareVersions('0.14.10', '0.14.9') > 0); // not as text
    assert.ok(compareVersions('0.15.400', '0.14.999') > 0);
    assert.equal(compareVersions('0.14.0', '0.14.0'), 0);
    assert.equal(compareVersions('v0.14.3', '0.14.3'), 0);
    assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
    assert.ok(compareVersions('0.14.2', '0.14.12') < 0);
  });

  it('sends people to every release', () => {
    assert.equal(RELEASES, 'https://github.com/saurav717/reader/releases');
  });
});
