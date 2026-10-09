// A sign-in shared between the reader's open tabs (src/lib/google.ts): a new
// tab asks the open ones on a BroadcastChannel and is handed a live token,
// renewals reach every tab, and so does a sign-out. Two copies of the module
// stand in for two tabs; Node's BroadcastChannel carries between them as a
// browser's does between tabs of one origin.
//
//   node --test scripts/google-tabs.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

globalThis.document = { createElement: () => ({}), querySelector: () => null, head: { appendChild: () => undefined } };
globalThis.window = { setTimeout, clearTimeout };
// Each "tab" has its own session storage: swapped in before a copy loads.
const sessions = [];
const sessionFor = () => {
  const stored = new Map();
  sessions.push(stored);
  return { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) };
};
globalThis.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
const SESSION_KEY = 'reader.google.session';
after(cleanup);

const hour = () => Date.now() + 3_600_000;
const session = (email, expiresAt = hour(), accessToken = `tok-${email}-${expiresAt}`) => ({
  accessToken,
  expiresAt,
  scopes: ['openid', 'https://www.googleapis.com/auth/drive.file'],
  user: { name: email, email },
});

/** A tab: its own session storage (with `held` in it, if given), then its own copy of the module. */
async function tab(held) {
  globalThis.sessionStorage = sessionFor();
  if (held) globalThis.sessionStorage.setItem(SESSION_KEY, JSON.stringify(held));
  return load('src/lib/google.ts');
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('which token a tab takes', () => {
  it('takes one when it has none, or a later one for the same person, and never another person’s', async () => {
    const google = await tab();
    const alice = session('alice@x.org');
    assert.equal(google.adoptable(null, alice), true);
    assert.equal(google.adoptable(session('alice@x.org', Date.now() - 1), alice), true);
    assert.equal(google.adoptable(session('alice@x.org', alice.expiresAt - 60_000), alice), true);
    assert.equal(google.adoptable(alice, session('alice@x.org', alice.expiresAt - 60_000)), false);
    assert.equal(google.adoptable(session('bob@x.org'), alice), false);
    assert.equal(google.adoptable(null, { ...alice, expiresAt: Date.now() - 1 }), false);
    assert.equal(google.adoptable(null, { ...alice, user: undefined }), false);
  });
});

describe('tabs', () => {
  it('hands a new tab the open tab’s sign-in, and a renewal, and a sign-out', async () => {
    const alice = session('alice@x.org');
    const first = await tab(alice);
    const second = await tab();
    assert.equal(second.liveAccessToken(), null);
    const heard = [];
    second.onSessionChange((change) => heard.push(change));

    assert.equal(await second.askOtherTabs(300), true);
    assert.equal(second.liveAccessToken(), alice.accessToken);
    assert.deepEqual(second.restoredUser(), alice.user);
    assert.equal(JSON.parse(sessions.at(-1).get(SESSION_KEY)).accessToken, alice.accessToken, 'kept in the new tab’s own session storage');

    first.signOut();
    await settle();
    assert.equal(second.liveAccessToken(), null);
    assert.deepEqual(heard, ['token', 'signout']);
  });

  it('finds nobody to ask when no tab is signed in, and says so in time', async () => {
    await tab();
    const lonely = await tab();
    const started = Date.now();
    assert.equal(await lonely.askOtherTabs(150), false);
    assert.ok(Date.now() - started < 1000);
  });

  it('does not answer with a token whose owner it doesn’t know yet', async () => {
    await tab({ ...session('carol@x.org'), user: undefined });
    const asking = await tab();
    assert.equal(await asking.askOtherTabs(150), false);
  });
});
