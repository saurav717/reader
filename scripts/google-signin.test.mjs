// Sign-in opens a popup, and a browser only opens one for a page that still
// holds the click that asked for it. Anything awaited in between — above all
// the download of Google's own script — spends that gesture, and the popup is
// blocked, which is what "Failed to open popup window" means. These assertions
// are about the click reaching Google's `requestAccessToken` in the same tick,
// and about saying something useful when it does not.
//
//   node --test scripts/google-signin.test.mjs

import { describe, it, after, afterEach, beforeEach } from 'node:test';
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

// Whether this moment is inside a click, as navigator.userActivation says: the
// only time a browser lets the page open Google's window. The tests below that
// stand for a click leave it on; background work turns it off.
let gesture = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get userActivation() { return { isActive: gesture }; }, userAgent: 'node' } });

// The browser's storage, as far as this module uses it: a session is kept
// in `sessionStorage` for the hour its token lasts, so a reload comes back
// signed in — and only there, never in `localStorage`, so a new tab does not.
const stored = new Map();
globalThis.sessionStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
const lasting = new Map();
globalThis.localStorage = {
  getItem: (key) => (lasting.has(key) ? lasting.get(key) : null),
  setItem: (key, value) => lasting.set(key, String(value)),
  removeItem: (key) => lasting.delete(key),
};
const SESSION_KEY = 'reader.google.session';

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

// A test's sign-in tells "the other tabs" (the module copies of earlier tests, on the same BroadcastChannel) a moment
// after it ends, once the profile is read: let that land before the next test makes its copy, or the copy adopts it.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 30)));

beforeEach(() => {
  gesture = true;
  delete globalThis.window.google;
  scripts.length = 0;
  stored.clear();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ name: 'A Reader', email: 'reader@example.com' }),
  });
});

describe('reaching Google inside the click', () => {
  it('asks for the token synchronously when the script is already there', () => {
    const calls = install(grant(WITH_DRIVE));
    let finished = false;
    void google.signIn('client-id').then(() => {
      finished = true;
    });
    // Nothing has been awaited yet: were the request behind a promise, the
    // popup would open outside the gesture and the browser would refuse it.
    assert.equal(calls.length, 1);
    assert.equal(finished, false);
  });

  it('asks for Drive in the sign-in itself, so one window does both', () => {
    const calls = install(grant(WITH_DRIVE));
    void google.signIn('client-id');
    assert.equal(calls.length, 1);
    assert.match(calls[0].scope, /^openid email profile .*drive\.file/);
    assert.match(calls[0].scope, /drive\.appdata/);
  });

  it('asks for Drive in the same tick too, as a second consent', () => {
    const calls = install(grant(IDENTITY));
    void google.connectDrive('client-id').catch(() => undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0].scope, /drive\.file/);
    assert.equal(calls[0].prompt, 'consent');
  });

  it('loads the script first when it is not there, and only then asks', async () => {
    const module = await fresh();
    const pending = module.signIn('client-id');
    assert.equal(scripts.length, 1);
    assert.equal(module.googleReady(), false);
    const calls = install(grant(WITH_DRIVE));
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
  it('is not a sign-in at all when Drive came back unticked', async () => {
    const module = await fresh();
    install(grant(IDENTITY));
    await assert.rejects(module.signIn('client-id'), /Drive was left unticked/);
    // Nothing is kept: not the token, and not a "signed in without Drive" state for the app to find.
    assert.equal(module.restoredUser(), null);
    assert.equal(module.hasDriveAccess(), false);
    assert.equal(stored.has(SESSION_KEY), false);

    install(grant(IDENTITY));
    await assert.rejects(module.connectDrive('client-id'), /Drive was left unticked/);
    assert.equal(module.restoredUser(), null);

    install(grant(WITH_DRIVE));
    await module.signIn('client-id');
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

describe('staying signed in across a reload', () => {
  it('keeps the token and who it belongs to, and a fresh page load has both', async () => {
    const first = await fresh();
    install(grant(WITH_DRIVE));
    await first.connectDrive('client-id');

    // A reload is a new copy of the module with the same storage underneath.
    const reloaded = await fresh();
    assert.deepEqual(reloaded.restoredUser(), { name: 'A Reader', email: 'reader@example.com' });
    assert.equal(reloaded.hasDriveAccess(), true);
    // And Drive is usable at once, without another window.
    const calls = install(grant(WITH_DRIVE));
    assert.equal(await reloaded.ensureDriveToken('client-id'), 'token');
    assert.equal(calls.length, 0);
  });

  it('starts over when the stored token has expired, and clears it', async () => {
    stored.set(
      SESSION_KEY,
      JSON.stringify({ accessToken: 'stale', expiresAt: Date.now() - 1, scopes: WITH_DRIVE.split(' '), user: { name: 'A', email: 'a@b' } }),
    );
    const module = await fresh();
    assert.equal(module.restoredUser(), null);
    assert.equal(module.hasDriveAccess(), false);
    assert.equal(stored.has(SESSION_KEY), false);
  });

  it('ignores anything in storage that is not a session', async () => {
    stored.set(SESSION_KEY, '{"accessToken": 42}');
    const module = await fresh();
    assert.equal(module.restoredUser(), null);
    assert.equal(stored.has(SESSION_KEY), false);
  });

  it('keeps the token out of localStorage, so it does not outlive the tab', async () => {
    const module = await fresh();
    install(grant(WITH_DRIVE));
    await module.connectDrive('client-id');
    assert.equal(stored.has(SESSION_KEY), true);
    assert.equal(lasting.size, 0);
  });

  it('forgets the session on sign-out', async () => {
    const module = await fresh();
    install(grant(WITH_DRIVE));
    await module.signIn('client-id');
    assert.equal(stored.has(SESSION_KEY), true);
    module.signOut();
    assert.equal(stored.has(SESSION_KEY), false);
    assert.equal((await fresh()).restoredUser(), null);
  });

  it('drops a token Drive refuses, so the next call asks Google again', async () => {
    const module = await fresh();
    install(grant(WITH_DRIVE));
    const accessToken = await module.ensureDriveToken('client-id');
    const profile = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Invalid Credentials' });
    await assert.rejects(module.findFile(accessToken, 'paper.pdf', 'folder'), (error) => error.status === 401 && /Reconnect Drive/.test(error.message));
    assert.equal(module.hasDriveAccess(), false);
    assert.equal(stored.has(SESSION_KEY), false);
    // The token went; whose sign-in this is did not, and the next ask is for them.
    assert.equal(module.heldUser()?.email, 'reader@example.com');
    globalThis.fetch = profile;
    const calls = install(grant(WITH_DRIVE));
    await module.ensureDriveToken('client-id');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hint, 'reader@example.com');
  });
});

describe('whose token it is', () => {
  // A browser signed in to two Google accounts is offered a chooser on every
  // window, a renewal's included. Pick the wrong one and, before this, the new
  // token was filed under the old name: the page went on showing the first
  // account while every Drive request went to the second's — its library read
  // into the first's page, and the first's written over it.

  /** A tab signed in as `email` whose hour is about to be up: loaded live, then the token runs out under it. */
  async function ranOut(email = 'reader@example.com', scopes = WITH_DRIVE) {
    const expiresAt = Date.now() + 250;
    stored.set(SESSION_KEY, JSON.stringify({ accessToken: 'old', expiresAt, scopes: scopes.split(' '), user: { name: 'A Reader', email } }));
    const module = await fresh();
    assert.equal(module.heldUser()?.email, email);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 5));
    assert.equal(module.restoredUser(), null, 'the token ran out');
    assert.equal(module.heldUser()?.email, email, 'whose it was did not');
    return module;
  }

  it('reads the profile on a renewal rather than assuming the same person', async () => {
    const module = await ranOut();
    let profiles = 0;
    globalThis.fetch = async () => {
      profiles += 1;
      return { ok: true, json: async () => ({ name: 'A Reader', email: 'reader@example.com' }) };
    };
    install(grant(WITH_DRIVE));
    assert.equal(await module.ensureDriveToken('client-id'), 'token');
    assert.equal(profiles, 1);
    assert.deepEqual(module.restoredUser(), { name: 'A Reader', email: 'reader@example.com', picture: undefined });
  });

  it('names the account a renewal is for, so Google need not ask which', async () => {
    const module = await ranOut();
    const calls = install(grant(WITH_DRIVE));
    await module.ensureDriveToken('client-id');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hint, 'reader@example.com');
  });

  it('names it as login_hint too, the name Google documents now', async () => {
    const module = await ranOut();
    const calls = install(grant(WITH_DRIVE));
    await module.ensureDriveToken('client-id');
    assert.equal(calls[0].login_hint, 'reader@example.com');
  });

  it('gives no hint on a first sign-in, where there is nobody to name', async () => {
    const module = await fresh();
    const calls = install(grant(WITH_DRIVE));
    await module.signIn('client-id');
    assert.equal(calls[0].hint, undefined);
    assert.equal(calls[0].login_hint, undefined);
  });

  it('refuses the waiting work another account’s token, and holds that token as their sign-in', async () => {
    const module = await ranOut();
    const changes = [];
    module.onSessionChange((change) => changes.push(change));
    gesture = false;
    const waiting = [module.ensureDriveToken('client-id'), module.ensureDriveToken('client-id')];
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(module.renewalWaiting(), true);
    // The click on the prompt; in Google's chooser, the other account.
    gesture = true;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: 'Someone Else', email: 'other@example.com' }) });
    install(grant(WITH_DRIVE));
    await assert.rejects(module.renewNow('client-id'), (error) => error instanceof module.AccountChangedError && /other@example\.com, not reader@example\.com/.test(error.message));
    // Nothing of the first account's goes to the second's Drive: the callers are told, not handed the token.
    for (const pending of waiting) await assert.rejects(pending, module.AccountChangedError);
    assert.equal(module.renewalWaiting(), false);
    // The token is the second account's sign-in, and the page hears, to open their library.
    assert.deepEqual(module.restoredUser(), { name: 'Someone Else', email: 'other@example.com', picture: undefined });
    assert.equal(module.heldUser()?.email, 'other@example.com');
    assert.deepEqual(changes, ['token']);
  });

  it('refuses it inside a click too, where no prompt was waiting', async () => {
    const module = await ranOut();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: 'Someone Else', email: 'other@example.com' }) });
    install(grant(WITH_DRIVE));
    await assert.rejects(module.ensureDriveToken('client-id'), module.AccountChangedError);
    assert.equal(module.heldUser()?.email, 'other@example.com');
  });

  it('carries on as the same person, whatever the case of the letters', async () => {
    const module = await ranOut('Reader@Example.com');
    install(grant(WITH_DRIVE));
    assert.equal(await module.ensureDriveToken('client-id'), 'token');
  });

  it('holds no token whose profile could not be read, and the next click asks again', async () => {
    const module = await ranOut();
    gesture = false;
    const pending = module.ensureDriveToken('client-id');
    gesture = true;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    install(grant(WITH_DRIVE));
    await assert.rejects(module.renewNow('client-id'), /Could not read your Google profile \(503\)/);
    assert.equal(module.liveAccessToken(), null);
    assert.equal(module.renewalWaiting(), true);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: 'A Reader', email: 'reader@example.com' }) });
    const calls = install(grant(WITH_DRIVE));
    await module.renewNow('client-id');
    assert.equal(await pending, 'token');
    assert.equal(calls.length, 1);
  });

  it('holds no token whose profile was still being read when the person signed out', async () => {
    const module = await fresh();
    let answer;
    globalThis.fetch = () => new Promise((resolve) => (answer = () => resolve({ ok: true, json: async () => ({ name: 'A Reader', email: 'reader@example.com' }) })));
    install(grant(WITH_DRIVE));
    const pending = module.signIn('client-id');
    await new Promise((resolve) => setTimeout(resolve, 10));
    module.signOut();
    answer();
    await assert.rejects(pending, /Signed out/);
    assert.equal(module.liveAccessToken(), null);
    assert.equal(module.heldUser(), null);
    assert.equal(stored.has(SESSION_KEY), false);
  });

  it('forgets whose it was on sign-out, so the next sign-in names nobody', async () => {
    const module = await fresh();
    install(grant(WITH_DRIVE));
    await module.connectDrive('client-id');
    assert.equal(module.heldUser()?.email, 'reader@example.com');
    module.signOut();
    assert.equal(module.heldUser(), null);
    const calls = install(grant(WITH_DRIVE));
    await module.signIn('client-id');
    assert.equal(calls[0].hint, undefined);
  });
});

describe('renewing for work in the background', () => {
  // Polling during a long run on Colab found the token gone at once from a dozen places; each asked Google for a
  // window, Safari blocked them all, and allowing pop-ups opened the whole queue. These are about that never recurring.
  it('opens no window outside a click, and one click renews every caller once', async () => {
    const module = await fresh();
    const calls = install(grant(WITH_DRIVE));
    gesture = false;
    const pending = Array.from({ length: 12 }, () => module.ensureDriveToken('client-id'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);
    assert.equal(module.renewalWaiting(), true);
    gesture = true;
    await module.renewNow('client-id');
    assert.deepEqual(await Promise.all(pending), Array(12).fill('token'));
    assert.equal(calls.length, 1);
    assert.equal(module.renewalWaiting(), false);
  });

  it('shares one window between callers inside the same click', async () => {
    const module = await fresh();
    const calls = install(grant(WITH_DRIVE));
    const all = await Promise.all([module.ensureDriveToken('client-id'), module.ensureDriveToken('client-id'), module.ensureDriveToken('client-id')]);
    assert.deepEqual(all, ['token', 'token', 'token']);
    assert.equal(calls.length, 1);
  });

  it('keeps everything waiting when the window is closed, for the prompt to try again', async () => {
    const module = await fresh();
    gesture = false;
    const pending = module.ensureDriveToken('client-id');
    gesture = true;
    install((config) => config.error_callback({ type: 'popup_closed' }));
    await assert.rejects(module.renewNow('client-id'), /closed/);
    assert.equal(module.renewalWaiting(), true);
    const calls = install(grant(WITH_DRIVE));
    await module.renewNow('client-id');
    assert.equal(await pending, 'token');
    assert.equal(calls.length, 1);
  });

  it('asks for the calendar after a Drive renewal already on its way, rather than saying it was refused', async () => {
    const CALENDAR = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
    const module = await fresh();
    // Drive's window is open when the calendar is clicked for: it answers with Drive alone, as it was asked.
    let answerDrive;
    const calls = install((config) => {
      if (/calendar/.test(config.scope)) grant(`${WITH_DRIVE} ${CALENDAR}`)(config);
      else answerDrive = () => grant(WITH_DRIVE)(config);
    });
    const drive = module.ensureDriveToken('client-id');
    const calendar = module.connectCalendar('client-id');
    answerDrive();
    assert.equal(await drive, 'token');
    assert.equal(await calendar, 'token');
    assert.equal(calls.length, 2);
    assert.match(calls[1].scope, /calendar\.events/);
    assert.equal(module.hasCalendarAccess(), true);
  });

  it('takes the renewal on its way when it already carries what is asked for', async () => {
    const module = await fresh();
    const calls = install(grant(WITH_DRIVE));
    const [first, second] = await Promise.all([module.ensureDriveToken('client-id'), module.ensureDriveToken('client-id')]);
    assert.deepEqual([first, second], ['token', 'token']);
    assert.equal(calls.length, 1);
  });

  it('asks for Drive with Colab even when the lapsed token in hand cannot vouch for it', async () => {
    // An hour on: the token has expired, so nothing in hand says Drive was granted. Colab's renewal must still
    // ask for it, or the token that comes back is a sign-in without Drive — which the app has no such thing as.
    stored.set(SESSION_KEY, JSON.stringify({ accessToken: 'old', expiresAt: Date.now() - 1, scopes: [...WITH_DRIVE.split(' '), 'https://www.googleapis.com/auth/colaboratory'], user: { name: 'A Reader', email: 'reader@example.com' } }));
    const later = await fresh();
    assert.equal(later.hasDriveAccess(), false);
    const calls = install(grant(`${WITH_DRIVE} https://www.googleapis.com/auth/colaboratory`));
    await later.connectColab('client-id');
    assert.equal(calls.length, 1);
    assert.match(calls[0].scope, /drive\.file/);
    assert.match(calls[0].scope, /colaboratory/);
    assert.equal(later.hasDriveAccess(), true);
  });

  it('asks for Colab on the same single window as Drive', async () => {
    const module = await fresh();
    install(grant(`${WITH_DRIVE} https://www.googleapis.com/auth/colaboratory`));
    await module.connectColab('client-id');
    // An hour later: the token is gone, and the run's readings and the explorer both need it.
    stored.set(SESSION_KEY, JSON.stringify({ accessToken: 'old', expiresAt: Date.now() - 1, scopes: [...WITH_DRIVE.split(' '), 'https://www.googleapis.com/auth/colaboratory'], user: { name: 'A Reader', email: 'reader@example.com' } }));
    const later = await fresh();
    install(grant(`${WITH_DRIVE} https://www.googleapis.com/auth/colaboratory`));
    gesture = false;
    const both = [later.ensureDriveToken('client-id'), later.connectColab('client-id')];
    gesture = true;
    const calls = install(grant(`${WITH_DRIVE} https://www.googleapis.com/auth/colaboratory`));
    await later.renewNow('client-id');
    assert.deepEqual(await Promise.all(both), ['token', 'token']);
    assert.equal(calls.length, 1);
    assert.match(calls[0].scope, /drive\.file/);
    assert.match(calls[0].scope, /colaboratory/);
  });
});
