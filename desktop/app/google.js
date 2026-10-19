// Google sign-in that stays: the app signed in once keeps a refresh token on
// this computer, and signs in again by itself every time it opens, for as
// long as Google honours the grant — where the site's own sign-in lasts an
// hour (src/lib/google.ts: an access token, with no backend to renew it).
//
// Google turns sign-in down inside an app's window, so consent is given in the
// browser, by the authorization-code flow with PKCE: the app opens Google's
// consent page; Google sends the browser to the Worker's callback, which
// hands the code back here (a reader-app://google-code link); the app sends
// the code and its verifier to the Worker (worker/googleDesktop.js), which
// adds the client's secret and answers with the tokens. The refresh token is
// kept in the app's data folder, encrypted by the system (Electron's
// safeStorage: the Keychain on a Mac, DPAPI on Windows, the keyring on
// Linux), and never given to the page: the page asks for an access token
// (google:token), and gets one — renewed here, with no browser, while the
// grant lasts. Without a Worker that signs the app in (no GOOGLE_CLIENT_SECRET
// there), or with no way to keep a secret here, the older way stands: the
// site's app-sign-in page in the browser, an hour at a time.

const { app, BrowserWindow, ipcMain, net, safeStorage, shell } = require('electron');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 'reader-app';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;
/** A Worker's address, as the page has it: https, nothing after the host and path. */
const PROXY = /^https:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/;
const SIGN_IN_WAIT = 10 * 60_000;

let site = '';
let siteOrigin = '';
/** The sign-in waiting on the browser: { state, resolve, timer, verifier?, proxy?, request } — one at a time; a newer one is the one answered. */
let signingIn = null;
/** The Workers already asked whether they sign the app in, by address. */
const workers = new Map();

// -------------------------------------------------------------- the kept grants --

const keptPath = () => path.join(app.getPath('userData'), 'google-signin.json');

/** Whether a secret can be kept here: the system has somewhere to lock it. */
const canKeep = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

/** The grants kept: [{ clientId, email, refreshToken, scopes: [] }]; none when there is nowhere to keep them. */
function readKept() {
  if (!canKeep()) return [];
  try {
    const sealed = fs.readFileSync(keptPath());
    const grants = JSON.parse(safeStorage.decryptString(sealed));
    return Array.isArray(grants) ? grants.filter((grant) => grant && typeof grant.refreshToken === 'string' && typeof grant.clientId === 'string') : [];
  } catch {
    return [];
  }
}

function writeKept(grants) {
  if (!canKeep()) return;
  try {
    if (!grants.length) return fs.rmSync(keptPath(), { force: true });
    fs.mkdirSync(path.dirname(keptPath()), { recursive: true });
    fs.writeFileSync(keptPath(), safeStorage.encryptString(JSON.stringify(grants)), { mode: 0o600 });
  } catch {
    // a grant not kept is asked for again next time, in the browser
  }
}

const sameEmail = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Whether a grant's scopes cover these: identity comes under long names, so only the long ones count. */
const covers = (granted, wanted) => wanted.split(' ').every((scope) => !scope.startsWith('https://') || granted.includes(scope));

/** The grant kept for this client and account (any account when none is named) that covers the scopes. */
function keptFor(clientId, hint, scope) {
  return readKept().find((grant) => grant.clientId === clientId && (!hint || sameEmail(grant.email, hint)) && covers(grant.scopes ?? [], scope));
}

function keep(grant) {
  const grants = readKept().filter((kept) => !(kept.clientId === grant.clientId && sameEmail(kept.email, grant.email)));
  writeKept([...grants, grant]);
}

function forget(clientId, email) {
  const grants = readKept();
  const gone = grants.filter((kept) => kept.clientId === clientId && (!email || sameEmail(kept.email, email)));
  writeKept(grants.filter((kept) => !gone.includes(kept)));
  return gone;
}

// --------------------------------------------------------------------- the Worker --

/** Whether a Worker signs the app in (its /health says googleDesktop), remembered for the run. */
async function workerSignsIn(proxy) {
  if (!workers.has(proxy)) {
    workers.set(
      proxy,
      net
        .fetch(`${proxy}/health`, { cache: 'no-store' })
        .then((answer) => (answer.ok ? answer.json() : {}))
        .then((health) => Boolean(health?.googleDesktop))
        .catch(() => false),
    );
  }
  return workers.get(proxy);
}

async function askWorker(proxy, route, body) {
  const answer = await net.fetch(`${proxy}/google/desktop/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const said = await answer.json().catch(() => ({}));
  if (!answer.ok) {
    const error = new Error(said.error || `Koios’s server answered ${answer.status}`);
    error.google = said.google || null;
    throw error;
  }
  return said;
}

/** Whose token this is, from Google. */
async function emailOf(accessToken) {
  const answer = await net.fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!answer.ok) return '';
  const profile = await answer.json().catch(() => ({}));
  return typeof profile.email === 'string' ? profile.email.toLowerCase() : '';
}

// ------------------------------------------------------------------ signing in --

function endSignIn(answer) {
  if (!signingIn) return;
  clearTimeout(signingIn.timer);
  signingIn.resolve(answer);
  signingIn = null;
}

/** An access token for the page, as the page's token flow would answer: { access_token, expires_in, scope } or { error, error_description }. */
const granted = (said) => ({ access_token: said.access_token, expires_in: said.expires_in ?? 3600, scope: said.scope || '' });

/**
 * A token renewed from the kept grant, with no browser; null when there is
 * no grant for this (and the grant forgotten when Google no longer honours
 * it — revoked, or a testing app's week run out).
 */
async function renew(proxy, clientId, hint, scope) {
  const kept = keptFor(clientId, hint, scope);
  if (!kept) return null;
  try {
    const said = await askWorker(proxy, 'refresh', { refresh_token: kept.refreshToken });
    return granted({ ...said, scope: said.scope || kept.scopes.join(' ') });
  } catch (error) {
    if (error.google === 'invalid_grant') forget(clientId, kept.email);
    return null;
  }
}

/** The code flow, in the browser: consent given there, the code sent back here, exchanged on the Worker, the refresh token kept. */
function signInWithCode(proxy, clientId, scope, prompt, hint) {
  endSignIn({ error: 'popup_closed' });
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const consent = new URL(GOOGLE_AUTH);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: `${proxy}/google/desktop/callback`,
    response_type: 'code',
    scope,
    // offline: a refresh token, which Google gives on consent — so consent is asked for, once, when there is no grant kept.
    access_type: 'offline',
    prompt: prompt || (keptFor(clientId, hint, '') ? '' : 'consent'),
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(hint ? { login_hint: hint } : {}),
  })) {
    if (value) consent.searchParams.set(key, value);
  }
  return new Promise((resolve) => {
    signingIn = { state, resolve, verifier, proxy, clientId, scope, timer: setTimeout(() => endSignIn({ error: 'popup_closed' }), SIGN_IN_WAIT) };
    void shell.openExternal(consent.href);
  });
}

/** The code the browser brought back, for its tokens; what the page is answered. */
async function finishWithCode(waiting, code) {
  try {
    const said = await askWorker(waiting.proxy, 'token', { code, code_verifier: waiting.verifier });
    const scopes = (said.scope || waiting.scope).split(' ').filter(Boolean);
    if (said.refresh_token) {
      const email = await emailOf(said.access_token).catch(() => '');
      // Scopes granted before are kept with the new ones: Google's token names only what was asked this time.
      const before = readKept().find((kept) => kept.clientId === waiting.clientId && sameEmail(kept.email, email));
      keep({ clientId: waiting.clientId, email, refreshToken: said.refresh_token, scopes: [...new Set([...(before?.scopes ?? []), ...scopes])] });
    }
    return granted({ ...said, scope: scopes.join(' ') });
  } catch (error) {
    return { error: 'access_denied', error_description: error.message };
  }
}

/** The older way: the site's app-sign-in page in the browser, Google's token flow there, an hour at a time. */
function signInWithPage(clientId, scope, prompt, hint) {
  endSignIn({ error: 'popup_closed' });
  const state = randomBytes(24).toString('base64url');
  const page = new URL('app-sign-in/', site);
  for (const [key, value] of Object.entries({ state, client_id: clientId, scope, prompt, hint })) {
    if (value) page.searchParams.set(key, value);
  }
  return new Promise((resolve) => {
    signingIn = { state, resolve, timer: setTimeout(() => endSignIn({ error: 'popup_closed' }), SIGN_IN_WAIT) };
    void shell.openExternal(page.href);
  });
}

/** A reader-app:// link the browser opened: the sign-in's answer, when its state is the one waiting. Answers whether it was one. */
function openedSignInLink(url) {
  if (url.protocol !== `${PROTOCOL}:` || (url.hostname !== 'google-token' && url.hostname !== 'google-code')) return false;
  const values = url.searchParams;
  if (!signingIn || values.get('state') !== signingIn.state) return true;
  if (values.get('error')) {
    endSignIn({ error: values.get('error'), error_description: values.get('error_description') || '' });
    return true;
  }
  if (url.hostname === 'google-code' && signingIn.verifier) {
    const waiting = signingIn;
    const code = values.get('code') || '';
    clearTimeout(waiting.timer);
    signingIn = null;
    void finishWithCode(waiting, code).then(waiting.resolve);
    return true;
  }
  if (url.hostname === 'google-token' && !signingIn.verifier) {
    const expires = Number.parseInt(values.get('expires_in') || '', 10);
    endSignIn(values.get('access_token') ? { access_token: values.get('access_token'), expires_in: Number.isFinite(expires) ? expires : 3600, scope: values.get('scope') || '' } : { error: 'access_denied', error_description: '' });
  }
  return true;
}

/** The page asking for a token: kept grant first; else the browser, the code flow where the Worker allows, the page otherwise. */
async function token(request) {
  const { clientId = '', scope = '', prompt = '', hint = '', proxy = '' } = request ?? {};
  if (!CLIENT_ID.test(String(clientId)) || typeof scope !== 'string' || !scope) return { error: 'invalid_request', error_description: 'Which client, for what?' };
  const worker = PROXY.test(String(proxy)) ? String(proxy).replace(/\/$/, '') : '';
  const stays = Boolean(worker) && canKeep() && (await workerSignsIn(worker));
  if (stays) {
    const renewed = await renew(worker, clientId, hint, scope);
    if (renewed) return renewed;
    return signInWithCode(worker, clientId, scope, prompt, hint);
  }
  return signInWithPage(clientId, scope, prompt, hint);
}

/** Whether a sign-in is kept for this client (and account): the page signs in by itself when there is. */
function kept(request) {
  const { clientId = '', hint = '' } = request ?? {};
  const grant = CLIENT_ID.test(String(clientId)) ? keptFor(clientId, hint, '') : undefined;
  return grant ? { email: grant.email || '' } : null;
}

/** Signed out: the grant given back to Google and forgotten here. */
async function signOut(request) {
  const { clientId = '', email = '', proxy = '' } = request ?? {};
  const gone = CLIENT_ID.test(String(clientId)) ? forget(clientId, email) : [];
  const worker = PROXY.test(String(proxy)) ? String(proxy).replace(/\/$/, '') : '';
  if (worker) for (const grant of gone) await askWorker(worker, 'revoke', { token: grant.refreshToken }).catch(() => undefined);
  return { ok: true, forgotten: gone.length };
}

/** Wires sign-in to the app: `siteUrl` is the site (its app-sign-in page), whose pages alone may ask. */
function setUpGoogle({ siteUrl }) {
  site = siteUrl;
  siteOrigin = new URL(siteUrl).origin;
  const fromSite = (event) => (event.senderFrame?.url || '').startsWith(siteOrigin + '/');
  ipcMain.handle('google:token', (event, request) => (fromSite(event) ? token(request) : { error: 'access_denied', error_description: 'Not the Koios site.' }));
  ipcMain.handle('google:kept', (event, request) => (fromSite(event) ? kept(request) : null));
  ipcMain.handle('google:signout', (event, request) => (fromSite(event) ? signOut(request) : { ok: false }));
}

/** After a sign-in's answer: the app's window back in front. */
function showMain() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

module.exports = { setUpGoogle, openedSignInLink, showMain, covers, keptFor, keep, forget, readKept };
