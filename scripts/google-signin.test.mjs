// Sign-in opens a popup, and a browser only opens one for a page that still
// holds the click that asked for it. Anything awaited in between — above all
// the download of Google's own script — spends that gesture, and the popup is
// blocked, which is what "Failed to open popup window" means. These assertions
// are about the click reaching Google's `requestAccessToken` in the same tick,
// and about saying something useful when it does not.
//
//   node --test scripts/google-signin.test.mjs

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

// The two globals the module touches, as much of them as it uses. A script
// element remembers its listeners so a test can decide when it finishes.
const scripts = [];

function element() {
  const listeners = {};
  const script = {
    listeners,
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
    remove: () => {
      const index = scripts.indexOf(script);
      if (index !== -1) scripts.splice(index, 1);
    },
  };
  return script;
}

globalThis.document = {
  createElement: element,
  querySelector: (selector) => scripts.find((script) => `script[src="${script.src}"]` === selector) ?? null,
  head: { appendChild: (script) => scripts.push(script) },
};
globalThis.window = {};

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
});

/**
 * A fresh copy of the module. It keeps the loaded script and the access token
 * in module state, so a test about either starts from nothing.
 */
const fresh = () => load('src/lib/google.ts');

const google = await fresh();

/** Google's library, as far as this module can tell. */
function install(behaviour) {
  const calls = [];
  globalThis.window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => ({
          requestAccessToken: () => {
            calls.push(config);
            behaviour(config);
          },
        }),
        revoke: () => {},
      },
    },
  };
  return calls;
}

const grant = (scope) => (config) => config.callback({ access_token: 'token', expires_in: 3600, scope });

const IDENTITY = 'openid email profile';
const WITH_DRIVE = `${IDENTITY} https://www.googleapis.com/auth/drive.file`;

beforeEach(() => {
  delete globalThis.window.google;
  scripts.length = 0;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ name: 'A Reader', email: 'reader@example.com' }),
  });
});

describe('reaching Google inside the click', () => {
  it('asks for the token synchronously when the script is already there', () => {
    const calls = install(grant(IDENTITY));
    let finished = false;
    void google.signIn('client-id').then(() => {
      finished = true;
    });
    // Nothing has been awaited yet: were the request behind a promise, the
    // popup would open outside the gesture and the browser would refuse it.
    assert.equal(calls.length, 1);
    assert.equal(finished, false);
  });

  it('asks for Drive in the same tick too, as a second consent', () => {
    const calls = install(grant(IDENTITY));
    void google.connectDrive('client-id').catch(() => undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0].scope, /drive\.file$/);
    assert.equal(calls[0].prompt, 'consent');
  });

  it('loads the script first when it is not there, and only then asks', async () => {
    const module = await fresh();
    const pending = module.signIn('client-id');
    assert.equal(scripts.length, 1);
    assert.equal(module.googleReady(), false);
    const calls = install(grant(IDENTITY));
    scripts[0].listeners.load();
    const user = await pending;
    assert.equal(calls.length, 1);
    assert.equal(user.email, 'reader@example.com');
  });

  it('warms the script up before anyone clicks', async () => {
    const module = await fresh();
    module.prepare();
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, 'https://accounts.google.com/gsi/client');
  });

  it('lets a click try again after the script failed to load', async () => {
    const module = await fresh();
    const pending = module.signIn('client-id');
    const failed = scripts[0];
    failed.listeners.error();
    await assert.rejects(pending, /Could not load Google Identity Services/);
    // A script element runs once, so the dead one is gone and the next attempt
    // appends a new one rather than waiting on a load that will never come.
    assert.equal(scripts.length, 0);
    void module.signIn('client-id').catch(() => undefined);
    assert.equal(scripts.length, 1);
    assert.notEqual(scripts[0], failed);
  });
});

describe('what the app says when Google refuses', () => {
  it("names the pop-up blocker rather than repeating Google's wording", async () => {
    install((config) => config.error_callback({ type: 'popup_failed_to_open', message: 'Failed to open popup window' }));
    await assert.rejects(google.signIn('client-id'), /blocked the Google sign-in window.*allow pop-ups/is);
  });

  // Google's block page is the end of its own window: nothing comes back from
  // it, so a consent screen still in Testing reaches the app as a closed window
  // and nothing else. The advice has to be in that message or it is nowhere.
  it('says a closed window is a closed window, and what a block page meant', async () => {
    install((config) => config.error_callback({ type: 'popup_closed', message: 'Popup window closed' }));
    await assert.rejects(google.signIn('client-id'), /closed before sign-in finished/);
    await assert.rejects(google.signIn('client-id'), /Test users/);
  });

  it('turns access_denied into the advice that fixes it', async () => {
    install((config) => config.callback({ error: 'access_denied' }));
    await assert.rejects(google.signIn('client-id'), /Test users/);
  });

  it('keeps any other description Google sends', async () => {
    install((config) => config.callback({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }));
    await assert.rejects(google.signIn('client-id'), /The OAuth client was not found\./);
  });
});

describe('what counts as connected', () => {
  it('reports the scopes that came back, not the ones asked for', async () => {
    const module = await fresh();
    install(grant(IDENTITY));
    await module.signIn('client-id');
    assert.equal(module.hasDriveAccess(), false);

    install(grant(WITH_DRIVE));
    await module.connectDrive('client-id');
    assert.equal(module.hasDriveAccess(), true);
  });

  it('refuses a Drive token that came back without the scope', async () => {
    const module = await fresh();
    install(grant(IDENTITY));
    await assert.rejects(module.ensureDriveToken('client-id'), /Drive access was not granted/);
  });

  it('reuses a live Drive token instead of asking again', async () => {
    const module = await fresh();
    const calls = install(grant(WITH_DRIVE));
    assert.equal(await module.ensureDriveToken('client-id'), 'token');
    assert.equal(await module.ensureDriveToken('client-id'), 'token');
    assert.equal(calls.length, 1);
  });
});
