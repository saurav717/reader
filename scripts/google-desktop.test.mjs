// The Reader app staying signed in to Google (worker/googleDesktop.js): the
// code from Google's consent handed to the app, exchanged here with the
// client's secret, renewed, and given back — nothing kept.
//
//   node --test scripts/google-desktop.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callbackUrl, googleDesktopConfigured, handleGoogleDesktop, isGoogleDesktopPath } from '../worker/googleDesktop.js';

const STATE = 'a'.repeat(43);
const VERIFIER = 'v'.repeat(64);

function setup(t, { configured = true, google = {} } = {}) {
  const env = configured ? { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh' } : { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' };
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null });
    if (String(url).includes('/revoke')) return new Response('', { status: 200 });
    const grant = new URLSearchParams(String(init.body)).get('grant_type');
    const answer = google[grant];
    if (!answer) return Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 });
    return Response.json(answer);
  });
  const tools = { json: (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers }), headers: {}, origins: ['https://saurav717.github.io'] };
  const ask = (path, init = {}) => handleGoogleDesktop(new Request(`https://w.example${path}`, init), env, path.split('?')[0], tools);
  return { ask, sent, env };
}

const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the Reader app’s Google sign-in, on the Worker', () => {
  it('knows its paths and whether it is set up', () => {
    assert.ok(isGoogleDesktopPath('/google/desktop/token') && !isGoogleDesktopPath('/google/desktop') && !isGoogleDesktopPath('/auth/google'));
    assert.equal(googleDesktopConfigured({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }), true);
    assert.equal(googleDesktopConfigured({ GOOGLE_CLIENT_ID: 'x' }), false);
    assert.equal(callbackUrl(new Request('https://w.example/google/desktop/token')), 'https://w.example/google/desktop/callback');
  });

  it('hands the code from Google’s consent to the app, and keeps none of it', async (t) => {
    const { ask, sent } = setup(t);
    const page = await ask(`/google/desktop/callback?state=${STATE}&code=4%2F0AbCd-ef_gh&scope=openid%20email`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    const html = await page.text();
    assert.ok(html.includes(`reader-app://google-code?state=${STATE}&code=4%2F0AbCd-ef_gh&scope=openid+email`), html);
    assert.equal(sent.length, 0, 'the code is not exchanged here: the app has the PKCE verifier');
    // A state that is not the app's shape, or Google's refusal: told, not opened.
    assert.equal((await ask('/google/desktop/callback?state=short&code=abcdefgh')).status, 400);
    const refused = await ask(`/google/desktop/callback?state=${STATE}&error=access_denied&error_description=The%20user%20denied`);
    assert.equal(refused.status, 400);
    assert.ok((await refused.text()).includes('reader-app://google-code?state=' + STATE + '&error=access_denied'));
  });

  it('exchanges the code with the client’s secret and the app’s verifier, for this Worker’s callback', async (t) => {
    const { ask, sent } = setup(t, { google: { authorization_code: { access_token: 'ya29.x', expires_in: 3599, refresh_token: '1//r', scope: 'openid https://www.googleapis.com/auth/drive.file' } } });
    const answer = await ask('/google/desktop/token', post({ code: '4/0AbCd-ef_gh', code_verifier: VERIFIER }));
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { access_token: 'ya29.x', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/drive.file', refresh_token: '1//r' });
    assert.equal(sent[0].url, 'https://oauth2.googleapis.com/token');
    assert.deepEqual(sent[0].body, { client_id: 'id.apps.googleusercontent.com', client_secret: 'shh', grant_type: 'authorization_code', code: '4/0AbCd-ef_gh', code_verifier: VERIFIER, redirect_uri: 'https://w.example/google/desktop/callback' });
    assert.equal((await ask('/google/desktop/token', post({ code: '4/0AbCd-ef_gh' }))).status, 400, 'no verifier, no exchange');
  });

  it('renews with the refresh token, and says when Google will not', async (t) => {
    const { ask, sent } = setup(t, { google: { refresh_token: { access_token: 'ya29.y', expires_in: 3599, scope: 'openid' } } });
    const renewed = await ask('/google/desktop/refresh', post({ refresh_token: '1//r' }));
    assert.deepEqual(await renewed.json(), { access_token: 'ya29.y', expires_in: 3599, scope: 'openid' });
    assert.deepEqual(sent[0].body, { client_id: 'id.apps.googleusercontent.com', client_secret: 'shh', grant_type: 'refresh_token', refresh_token: '1//r' });
    const { ask: askGone } = setup(t, { google: {} });
    const gone = await askGone('/google/desktop/refresh', post({ refresh_token: '1//old' }));
    assert.equal(gone.status, 400);
    assert.equal((await gone.json()).google, 'invalid_grant');
  });

  it('gives the grant back to Google on sign-out', async (t) => {
    const { ask, sent } = setup(t);
    assert.deepEqual(await (await ask('/google/desktop/revoke', post({ token: '1//r' }))).json(), { ok: true });
    assert.equal(sent[0].url, 'https://oauth2.googleapis.com/revoke?token=1%2F%2Fr');
  });

  it('refuses a page from elsewhere, and says what is missing when the secret is not set', async (t) => {
    const { ask } = setup(t);
    assert.equal((await ask('/google/desktop/token', post({ code: 'abcdefghij', code_verifier: VERIFIER }, { Origin: 'https://evil.example' }))).status, 403);
    assert.equal((await ask('/google/desktop/token', { method: 'GET' })).status, 405);
    const { ask: askUnset } = setup(t, { configured: false });
    const unset = await askUnset('/google/desktop/refresh', post({ refresh_token: '1//r' }));
    assert.equal(unset.status, 501);
    assert.match((await unset.json()).error, /GOOGLE_CLIENT_SECRET/);
  });
});
