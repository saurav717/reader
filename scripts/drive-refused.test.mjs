// Drive refusing a token it was just given: the 401 Google sends when a
// Workspace admin has Drive switched off for the account ("Active session is
// invalid. Error code: 4" — a school's alumni account, say), or when a token
// has lapsed. The page renews once and tries again; a second refusal is told
// in a plain sentence, and the sign-in is marked as needing Drive reconnected
// rather than asked for again and again. Google is stubbed throughout.
//
//   node --test scripts/drive-refused.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const google = await load('src/lib/google.ts');

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const DISABLED = { error: { code: 401, message: 'Active session is invalid. Error code: 4', errors: [{ message: 'Active session is invalid. Error code: 4', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }], status: 'UNAUTHENTICATED' } };
const LAPSED = { error: { code: 401, message: 'Invalid Credentials', errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }], status: 'UNAUTHENTICATED' } };

/** Google Identity Services, handing out numbered tokens, and a Drive that answers each token as told. */
function stubGoogle(answer) {
  let issued = 0;
  const calls = { tokens: 0, drive: [] };
  globalThis.window = {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: ({ callback }) => ({
            requestAccessToken: () => {
              calls.tokens += 1;
              issued += 1;
              callback({ access_token: `token-${issued}`, expires_in: 3600, scope: `openid email profile ${DRIVE}` });
            },
          }),
          revoke() {},
        },
      },
    },
  };
  globalThis.document = { querySelector: () => ({}), head: { appendChild() {} }, createElement: () => ({ addEventListener() {} }) };
  // Inside a click, as a Save to Drive is: the only time the page may ask Google for a token.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: { isActive: true }, userAgent: 'node' } });
  globalThis.fetch = async (url, init = {}) => {
    const request = new URL(String(url));
    if (request.pathname === '/oauth2/v3/userinfo') return new Response(JSON.stringify({ name: 'An Alum', email: 'alum@alumni.example.edu' }), { headers: { 'Content-Type': 'application/json' } });
    const bearer = (init.headers || {}).Authorization?.replace('Bearer ', '');
    calls.drive.push(bearer);
    const body = answer(bearer, calls.drive.length);
    if (body === 'ok') return new Response(JSON.stringify({ files: [] }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 401, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const FILES = 'https://www.googleapis.com/drive/v3/files?q=x';

describe('Drive refusing the token', () => {
  beforeEach(() => {
    google.signOut();
    google.clearDriveTrouble();
  });

  it('renews once and tries again, so a token that merely lapsed costs one retry', async () => {
    const calls = stubGoogle((bearer) => (bearer === 'token-1' ? LAPSED : 'ok'));
    const token = await google.ensureDriveToken('client');
    assert.equal(token, 'token-1');
    const response = await google.driveFetch(token, FILES);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.drive, ['token-1', 'token-2']);
    assert.equal(calls.tokens, 2);
    assert.equal(google.driveTrouble(), null, 'a retry that worked leaves nothing to show');
  });

  it('says in a sentence that the account has no Drive, and does not keep asking Google', async () => {
    const calls = stubGoogle(() => DISABLED);
    const token = await google.ensureDriveToken('client');
    await assert.rejects(
      () => google.driveFetch(token, FILES),
      (error) => {
        assert.equal(error.name, 'DriveRequestError');
        assert.equal(error.status, 401);
        assert.equal(error.reason, 'no-drive');
        assert.match(error.message, /Drive is switched off for alum@alumni\.example\.edu/);
        assert.doesNotMatch(error.message, /Active session|\{|Error code/, 'Google’s JSON is not what the person reads');
        return true;
      },
    );
    assert.deepEqual(calls.drive, ['token-1', 'token-2'], 'one renewal, one retry');
    assert.match(google.driveTrouble() ?? '', /switched off/);
    assert.ok(google.hasDriveAccess(), 'the sign-in itself stands: Google granted it, Drive is what is missing');

    // The next thing that needs Drive is refused at once, with the same sentence: no third token, no prompt.
    const again = await google.ensureDriveToken('client');
    await assert.rejects(() => google.driveFetch(again, FILES), /switched off/);
    assert.equal(calls.tokens, 2);
    assert.equal(calls.drive.length, 2);
  });

  it('a token refused twice for no reason it can name asks for Drive to be reconnected', async () => {
    stubGoogle(() => LAPSED);
    const token = await google.ensureDriveToken('client');
    await assert.rejects(() => google.driveFetch(token, FILES), (error) => {
      assert.equal(error.reason, 'reconnect');
      assert.match(error.message, /Reconnect Drive/);
      return true;
    });
    assert.match(google.driveTrouble() ?? '', /Reconnect Drive/);
  });

  it('a fresh consent clears the trouble, so Reconnect is a real second chance', async () => {
    let refuse = true;
    const calls = stubGoogle(() => (refuse ? DISABLED : 'ok'));
    await assert.rejects(() => google.ensureDriveToken('client').then((t) => google.driveFetch(t, FILES)));
    assert.ok(google.driveTrouble());
    refuse = false;
    await google.connectDrive('client');
    assert.equal(google.driveTrouble(), null);
    const third = await google.ensureDriveToken('client');
    const response = await google.driveFetch(third, FILES);
    assert.equal(response.status, 200);
    assert.equal(calls.tokens, 3);
  });

  it('describes the common refusals in plain words', () => {
    assert.equal(google.describeDriveRefusal(401, JSON.stringify(DISABLED), 'x@y.edu').reason, 'no-drive');
    assert.equal(google.describeDriveRefusal(401, JSON.stringify(LAPSED), 'x@y.edu').reason, 'reconnect');
    assert.equal(google.describeDriveRefusal(403, JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }), 'x@y.edu').reason, 'scope');
    assert.match(google.describeDriveRefusal(500, 'Backend Error', 'x@y.edu').message, /Drive did not answer \(500\)/);
    assert.doesNotMatch(google.describeDriveRefusal(404, '{"error":{"message":"File not found: abc."}}', 'x@y.edu').message, /\{/);
  });
});
