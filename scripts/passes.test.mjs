// A pass to the proxy for anyone signed in with Google, in place of a pasted
// READER_TOKEN: that a pass is the Worker's own, signed with READER_TOKEN and
// good for thirty days; that a Google sign-in is only swapped for one when
// Google says it was made for this app, for a verified email; and that the
// Worker then lets the pass do what the token does — with a per-person limit
// on the paid Scholar routes, which the owner is not held to. Google itself is
// not asked: its tokeninfo answers are made up here in its documented shape.
//
//   node --test scripts/passes.test.mjs

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { emailAllowed, googleEmail, issuePass, isPass, PASS_DAYS, readPass } = await import('../server/passes.js');
const { default: worker } = await import('../worker/index.js');
const { forgetSerply } = await import('../server/serply.js');
const { forgetResting } = await import('../server/scholarServices.js');

const here = dirname(fileURLToPath(import.meta.url));
const SCHOLAR = await readFile(join(here, 'fixtures', 'serply-scholar.json'), 'utf8');

const CLIENT = 'client-123.apps.googleusercontent.com';
const SECRET = 'the-readers-token';
const SITE = 'https://saurav717.github.io';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Google's tokeninfo, as it answers for a token of `email` made for `aud`. */
const tokeninfo = ({ email = 'someone@gmail.com', aud = CLIENT, verified = 'true', expiresIn = '3599' } = {}) =>
  json({ aud, azp: aud, email, email_verified: verified, expires_in: expiresIn, scope: 'openid email profile' });

describe('a pass', () => {
  it('says whose it is, and until when', async () => {
    const now = Date.UTC(2026, 8, 26);
    const pass = await issuePass('someone@gmail.com', SECRET, now);
    assert.ok(isPass(pass));
    const read = await readPass(pass, SECRET, now);
    assert.equal(read.email, 'someone@gmail.com');
    assert.equal(read.expires, now + PASS_DAYS * 86400 * 1000);
  });

  it('is not one once it has run out', async () => {
    const now = Date.UTC(2026, 8, 26);
    const pass = await issuePass('someone@gmail.com', SECRET, now);
    assert.equal(await readPass(pass, SECRET, now + (PASS_DAYS + 1) * 86400 * 1000), null);
  });

  it('is not one under another secret — changing READER_TOKEN ends every pass', async () => {
    const pass = await issuePass('someone@gmail.com', SECRET);
    assert.equal(await readPass(pass, 'a-new-token'), null);
  });

  it('is not one when anything in it is changed', async () => {
    const pass = await issuePass('someone@gmail.com', SECRET);
    const [prefix, payload, signature] = [pass.slice(0, 4), ...pass.slice(4).split('.')];
    const forged = btoa(JSON.stringify({ e: 'owner@gmail.com', x: 9999999999 })).replace(/=+$/, '');
    assert.equal(await readPass(`${prefix}${forged}.${signature}`, SECRET), null);
    assert.equal(await readPass(`${prefix}${payload}.${signature.slice(0, -2)}xx`, SECRET), null);
    assert.equal(await readPass('rp1.garbage', SECRET), null);
    assert.equal(await readPass(pass, ''), null);
  });
});

describe('who may have a pass', () => {
  it('is anyone, with no list', () => {
    assert.equal(emailAllowed('anyone@gmail.com', ''), true);
    assert.equal(emailAllowed('anyone@gmail.com', undefined), true);
  });

  it('is who the list names — addresses, or everyone at a domain', () => {
    const list = 'me@gmail.com, Friend@Gmail.com @iith.ac.in';
    assert.equal(emailAllowed('me@gmail.com', list), true);
    assert.equal(emailAllowed('friend@gmail.com', list), true);
    assert.equal(emailAllowed('labmate@iith.ac.in', list), true);
    assert.equal(emailAllowed('stranger@gmail.com', list), false);
    assert.equal(emailAllowed('someone@notiith.ac.in.evil.com', list), false);
  });
});

describe('a Google sign-in', () => {
  it('is taken for a verified email, made for this app', async () => {
    assert.equal(await googleEmail('t', CLIENT, { fetchImpl: async () => tokeninfo({ email: 'Someone@Gmail.com' }) }), 'someone@gmail.com');
  });

  it('is not taken when it was made for another app', async () => {
    assert.equal(await googleEmail('t', CLIENT, { fetchImpl: async () => tokeninfo({ aud: 'other.apps.googleusercontent.com' }) }), null);
  });

  it('is not taken unverified, expired, or refused by Google', async () => {
    assert.equal(await googleEmail('t', CLIENT, { fetchImpl: async () => tokeninfo({ verified: 'false' }) }), null);
    assert.equal(await googleEmail('t', CLIENT, { fetchImpl: async () => tokeninfo({ expiresIn: '0' }) }), null);
    assert.equal(await googleEmail('t', CLIENT, { fetchImpl: async () => json({ error: 'invalid_token' }, 400) }), null);
    assert.equal(await googleEmail('', CLIENT, { fetchImpl: async () => tokeninfo() }), null);
  });
});

describe('the Worker, with passes', () => {
  const realFetch = globalThis.fetch;
  const env = (extra = {}) => ({ READER_TOKEN: SECRET, GOOGLE_CLIENT_ID: CLIENT, SERPLY_KEY: 'serply-key', ...extra });
  const post = (headers = {}) =>
    new Request('https://proxy.example/auth/google', { method: 'POST', headers: { Origin: SITE, 'X-Google-Token': 'google-token', ...headers } });
  const scholar = (auth) => new Request('https://proxy.example/scholar/search?q=attention', { headers: { Origin: SITE, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } });

  /** Google and Serply, as the Worker's fetch sees them. */
  const outside = (google = () => tokeninfo()) => {
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return google(url);
      if (url.startsWith('https://api.serply.io/')) return new Response(SCHOLAR);
      return json({ error: 'not expected in this test' }, 500);
    };
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    forgetSerply();
    forgetResting();
  });

  it('says on /health that it takes Google sign-ins', async () => {
    const health = await (await worker.fetch(new Request('https://proxy.example/health'), env())).json();
    assert.equal(health.google, true);
    const without = await (await worker.fetch(new Request('https://proxy.example/health'), env({ GOOGLE_CLIENT_ID: '' }))).json();
    assert.equal(without.google, false);
  });

  it('swaps a Google sign-in for a pass, which then does what the token does', async () => {
    outside();
    const response = await worker.fetch(post(), env());
    assert.equal(response.status, 200);
    const { pass, email, expires } = await response.json();
    assert.ok(isPass(pass));
    assert.equal(email, 'someone@gmail.com');
    assert.ok(expires > Date.now() + 29 * 86400 * 1000);

    const refused = await worker.fetch(scholar(), env());
    assert.equal(refused.status, 401);
    assert.match((await refused.json()).error, /sign in with Google/);

    const answered = await worker.fetch(scholar(pass), env());
    assert.equal(answered.status, 200);
    assert.equal((await answered.json()).results[0].title, 'Attention is all you need');
  });

  it('asks Google with the token it was given, and passes no Google token on to anything else', async () => {
    const asked = [];
    outside((url) => {
      asked.push(new URL(url).searchParams.get('access_token'));
      return tokeninfo();
    });
    await worker.fetch(post(), env());
    assert.deepEqual(asked, ['google-token']);
  });

  it('refuses a sign-in Google does not vouch for, one from elsewhere, and a GET', async () => {
    outside(() => tokeninfo({ aud: 'someone-elses-app' }));
    assert.equal((await worker.fetch(post(), env())).status, 401);
    assert.equal((await worker.fetch(post({ Origin: 'https://evil.example' }), env())).status, 403);
    assert.equal((await worker.fetch(new Request('https://proxy.example/auth/google', { headers: { Origin: SITE } }), env())).status, 405);
  });

  it('takes no sign-ins without READER_TOKEN to sign passes with, or without the client ID', async () => {
    outside();
    assert.equal((await worker.fetch(post(), env({ READER_TOKEN: '' }))).status, 501);
    assert.equal((await worker.fetch(post(), env({ GOOGLE_CLIENT_ID: '' }))).status, 501);
  });

  it('holds a signed-in person to the per-person limit on Scholar, and not the owner', async () => {
    outside();
    const { pass } = await (await worker.fetch(post(), env())).json();
    const keys = [];
    const PERSON_LIMIT = { limit: async ({ key }) => (keys.push(key), { success: false }) };
    const limited = await worker.fetch(scholar(pass), env({ PERSON_LIMIT }));
    assert.equal(limited.status, 429);
    assert.deepEqual(keys, ['someone@gmail.com']);

    const owner = await worker.fetch(scholar(SECRET), env({ PERSON_LIMIT }));
    assert.equal(owner.status, 200);
    assert.equal(keys.length, 1, 'the owner is not counted');
  });

  it('with READER_EMAILS: gives passes to those named only, and ends a pass once its owner is taken off', async () => {
    outside();
    const refused = await worker.fetch(post(), env({ READER_EMAILS: 'me@gmail.com' }));
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /not on this proxy's list/);

    const { pass } = await (await worker.fetch(post(), env())).json();
    assert.equal((await worker.fetch(scholar(pass), env({ READER_EMAILS: 'me@gmail.com' }))).status, 401);
    assert.equal((await worker.fetch(scholar(pass), env({ READER_EMAILS: 'me@gmail.com, someone@gmail.com' }))).status, 200);
  });

  it('stops taking a pass once READER_TOKEN has changed', async () => {
    outside();
    const { pass } = await (await worker.fetch(post(), env())).json();
    assert.equal((await worker.fetch(scholar(pass), env({ READER_TOKEN: 'rotated' }))).status, 401);
  });
});
