// The Reader app keeping its Google sign-in (desktop/app/google.js): the
// grants kept, sealed by the system, and found again for a client, an
// account and the scopes asked; and the browser's answer, a reader-app://
// link, taken only for the sign-in waiting. The exchange itself is the
// Worker's (scripts/google-desktop.test.mjs).
//
//   node --test scripts/desktop-google.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'reader-google-'));
// Electron stands in: safeStorage that "seals" by reversing, an app with a data folder.
const seal = (text) => Buffer.from([...text].reverse().join(''));
const electron = {
  app: { getPath: () => userData, getVersion: () => '0.14.20', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => seal(text), decryptString: (buffer) => [...buffer.toString()].reverse().join('') },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
  net: { fetch: async () => new Response('{}') },
  shell: { openExternal: async () => undefined },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};
const google = createRequire(import.meta.url)('../desktop/app/google.js');
Module._load = load;

const CLIENT = '1234-abc.apps.googleusercontent.com';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const CAL = 'https://www.googleapis.com/auth/calendar.readonly';

describe('the Reader app’s kept Google sign-in', () => {
  before(() => rmSync(join(userData, 'google-signin.json'), { force: true }));
  after(() => rmSync(userData, { recursive: true, force: true }));

  it('keeps a grant sealed, never in the clear, and finds it for its client, account and scopes', () => {
    google.keep({ clientId: CLIENT, email: 'Me@Example.org', refreshToken: '1//secret', scopes: ['openid', DRIVE] });
    const file = join(userData, 'google-signin.json');
    assert.ok(existsSync(file));
    assert.ok(!readFileSync(file, 'utf8').includes('1//secret'), 'the refresh token is not on disk in the clear');
    assert.equal(google.keptFor(CLIENT, '', `openid email ${DRIVE}`)?.refreshToken, '1//secret', 'identity scopes come under long names: only those count');
    assert.equal(google.keptFor(CLIENT, 'me@example.org', DRIVE)?.email, 'Me@Example.org');
    assert.equal(google.keptFor(CLIENT, 'other@example.org', DRIVE), undefined, 'another account’s ask is not answered with this one');
    assert.equal(google.keptFor(CLIENT, '', `${DRIVE} ${CAL}`), undefined, 'a scope not granted is asked for');
    assert.equal(google.keptFor('other.apps.googleusercontent.com', '', DRIVE), undefined);
  });

  it('a grant for the same account replaces the one before; forgetting takes it away', () => {
    google.keep({ clientId: CLIENT, email: 'me@example.org', refreshToken: '1//newer', scopes: ['openid', DRIVE, CAL] });
    assert.equal(google.readKept().length, 1);
    assert.equal(google.keptFor(CLIENT, '', `${DRIVE} ${CAL}`)?.refreshToken, '1//newer');
    const gone = google.forget(CLIENT, 'me@example.org');
    assert.deepEqual(gone.map((grant) => grant.refreshToken), ['1//newer']);
    assert.equal(google.readKept().length, 0);
    assert.ok(!existsSync(join(userData, 'google-signin.json')), 'nothing kept, no file');
  });

  it('takes the browser’s answer only for the sign-in waiting', () => {
    assert.equal(google.openedSignInLink(new URL('reader-app://google-code?state=nobody-waiting&code=abc')), true, 'ours to handle, though nothing waits');
    assert.equal(google.openedSignInLink(new URL('reader-app://something-else')), false);
    assert.equal(google.openedSignInLink(new URL('https://example.org/')), false);
  });

  it('knows scopes', () => {
    assert.equal(google.covers(['openid', DRIVE], `openid email profile ${DRIVE}`), true);
    assert.equal(google.covers([DRIVE], `${DRIVE} ${CAL}`), false);
  });
});
