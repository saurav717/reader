// A Google sign-in that stays, in the browser (src/lib/googleStay.ts), without one: the grants kept and found by
// client, account and scopes; PKCE's verifier and challenge; Google's consent address; a renewal from the grant and
// a grant Google no longer honours, forgotten.
//
//   node --test scripts/google-stay.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { cleanup, load, loadTogether } from './bundle.mjs';

const stay = await load('src/lib/googleStay.ts');
after(cleanup);

const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const COLAB = 'https://www.googleapis.com/auth/colab';
const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
};

describe('the grants kept', () => {
  it('are found by client, account and the scopes wanted, and joined for one account', () => {
    const store = memory();
    stay.keep({ clientId: 'c', email: 'Ann@Example.com', refreshToken: 'r1', scopes: [DRIVE] }, store);
    stay.keep({ clientId: 'c', email: 'bob@example.com', refreshToken: 'r2', scopes: [DRIVE, COLAB] }, store);
    assert.equal(stay.keptGrantFor('c', 'ann@example.com', ['openid email', DRIVE], store)?.refreshToken, 'r1');
    assert.equal(stay.keptGrantFor('c', 'ann@example.com', [COLAB], store), null);
    assert.equal(stay.keptGrantFor('c', undefined, [COLAB], store)?.refreshToken, 'r2');
    assert.equal(stay.keptGrantFor('other', 'bob@example.com', [], store), null);
    stay.keep({ clientId: 'c', email: 'ann@example.com', refreshToken: 'r3', scopes: [DRIVE, COLAB] }, store);
    assert.deepEqual(stay.readKept(store).map((g) => g.refreshToken), ['r2', 'r3']);
    assert.deepEqual(stay.forgetKept('c', 'ann@example.com', store).map((g) => g.refreshToken), ['r3']);
    assert.deepEqual(stay.readKept(store).map((g) => g.refreshToken), ['r2']);
  });
  it('reads nothing from a store that is empty, missing or broken', () => {
    assert.deepEqual(stay.readKept(null), []);
    const broken = memory();
    broken.setItem('reader.google.grant', '{not json');
    assert.deepEqual(stay.readKept(broken), []);
    broken.setItem('reader.google.grant', JSON.stringify([{ clientId: 'c' }, 7]));
    assert.deepEqual(stay.readKept(broken), []);
  });
});

describe('the code flow', () => {
  it('makes a PKCE verifier and its S256 challenge, and a state', async () => {
    let fill = 1;
    const made = await stay.pkce((n) => new Uint8Array(n).map(() => fill++ % 251));
    assert.match(made.verifier, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(made.challenge, createHash('sha256').update(made.verifier).digest('base64url'));
    assert.match(made.state, /^[A-Za-z0-9_-]{43}$/);
  });
  it('asks Google for a code for the Worker’s callback, offline, with consent only the first time', () => {
    const url = new URL(stay.consentUrl({ clientId: 'c', proxy: 'https://w.example', scope: `openid ${DRIVE}`, prompt: '', hint: 'ann@example.com', challenge: 'ch', state: 'st', first: true }));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://w.example/google/desktop/callback');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('login_hint'), 'ann@example.com');
    const again = new URL(stay.consentUrl({ clientId: 'c', proxy: 'https://w.example', scope: DRIVE, prompt: '', challenge: 'ch', state: 'st', first: false }));
    assert.equal(again.searchParams.get('prompt'), null);
  });
});

describe('a renewal from the grant', () => {
  const grant = { clientId: 'c', email: 'ann@example.com', refreshToken: 'r1', scopes: [DRIVE] };
  it('asks the Worker with the refresh token; takes the token back; forgets a grant Google no longer honours', async () => {
    const both = await loadTogether(['src/lib/googleStay.ts', 'src/lib/api.ts']);
    both.setProxyBase('https://w.example');
    const store = memory();
    both.keep(grant, store);
    const calls = [];
    const answer = (status, body) => async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), { ok: status === 200, status, json: async () => body });
    const got = await both.renewFromKept(grant, answer(200, { access_token: 'a2', expires_in: 1800, scope: '' }));
    assert.equal(got.accessToken, 'a2');
    assert.deepEqual(got.scopes, [DRIVE]);
    assert.ok(got.expiresAt > Date.now() + 1700_000 && got.expiresAt < Date.now() + 1800_000);
    assert.deepEqual(calls, [{ url: 'https://w.example/google/desktop/refresh', body: { refresh_token: 'r1' } }]);
    // The grant revoked: null, and the kept grant gone, so the next ask opens Google's window.
    globalThis.localStorage = store;
    assert.equal(await both.renewFromKept(grant, answer(400, { error: 'Token has been expired or revoked.', google: 'invalid_grant' })), null);
    assert.deepEqual(both.readKept(store), []);
    delete globalThis.localStorage;
    // The Worker down: null too, and the grant kept for the next try.
    both.keep(grant, store);
    globalThis.localStorage = store;
    assert.equal(await both.renewFromKept(grant, answer(502, { error: 'Google answered 503' })), null);
    assert.equal(both.readKept(store).length, 1);
    delete globalThis.localStorage;
  });
});
