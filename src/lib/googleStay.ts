// ===========================================================================
//  A Google sign-in that stays, in the browser.
//
//  Google's token flow in a page (src/lib/google.ts) gives an access token
//  that lasts an hour and nothing to renew it with: every hour, a window —
//  and a window opens only inside a click, so work in the background waits
//  for the person. The Reader app escapes this with the authorization-code
//  flow (desktop/app/google.js): a refresh token it keeps, renewed through
//  the Worker, which holds the client's secret (worker/googleDesktop.js).
//
//  This is the same flow for a browser page. Consent is given in a popup
//  that lands on the Worker's callback page, which hands the code back to
//  the page that opened it (postMessage); the page exchanges it at the
//  Worker with its PKCE verifier and keeps the refresh token in this
//  browser (localStorage), as the app keeps it on the computer. From then on
//  a token that has run out is renewed from the grant, with no window and no
//  click, for as long as Google honours the grant — months, for a published
//  OAuth client; a week, for one still in testing. Signing out gives the
//  grant back to Google.
//
//  Only where the Worker says it can (its /health: googleDesktop); elsewhere
//  the page's token flow goes on as before.
// ===========================================================================

import { apiBase, proxyHealth } from './api';

const KEPT_KEY = 'reader.google.grant';
/** How long the popup may take: the person reading Google's screens. */
const SIGN_IN_WAIT = 5 * 60_000;

export interface KeptGrant {
  clientId: string;
  email: string;
  refreshToken: string;
  /** Every scope granted so far, over however many consents. */
  scopes: string[];
}

export interface GrantedToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

interface Store {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

const storage = (): Store | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

/** The grants kept in this browser; none where there is nowhere to keep them. */
export function readKept(store: Store | null = storage()): KeptGrant[] {
  try {
    const raw = store?.getItem(KEPT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((g): g is KeptGrant => Boolean(g) && typeof g.refreshToken === 'string' && typeof g.clientId === 'string' && typeof g.email === 'string' && Array.isArray(g.scopes)) : [];
  } catch {
    return [];
  }
}

function writeKept(grants: KeptGrant[], store: Store | null = storage()): void {
  try {
    if (grants.length) store?.setItem(KEPT_KEY, JSON.stringify(grants));
    else store?.removeItem(KEPT_KEY);
  } catch {
    // Storage full or refused: the sign-in lasts the hour, as before.
  }
}

export const sameEmail = (a: string | undefined, b: string | undefined) => Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();

/** The grant for this client and account (any account when none is named), when its scopes cover what is wanted. */
export function keptGrantFor(clientId: string, email: string | undefined, scopes: string[] = [], store: Store | null = storage()): KeptGrant | null {
  const wanted = scopes.join(' ').split(' ').filter((scope) => scope.startsWith('https://'));
  return readKept(store).find((grant) => grant.clientId === clientId && (!email || sameEmail(grant.email, email)) && wanted.every((scope) => grant.scopes.includes(scope))) ?? null;
}

/** A grant kept: beside the account's earlier one, its scopes joined, or in its place. */
export function keep(grant: KeptGrant, store: Store | null = storage()): void {
  const others = readKept(store).filter((g) => !(g.clientId === grant.clientId && sameEmail(g.email, grant.email)));
  writeKept([...others, grant], store);
}

export function forgetKept(clientId: string, email?: string, store: Store | null = storage()): KeptGrant[] {
  const all = readKept(store);
  const gone = all.filter((g) => g.clientId === clientId && (!email || sameEmail(g.email, email)));
  writeKept(all.filter((g) => !gone.includes(g)), store);
  return gone;
}

// ------------------------------------------------------------------ PKCE --

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier (48 random bytes, base64url: 64 characters) and its S256 challenge. */
export async function pkce(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64url(random(48));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), state: base64url(random(32)) };
}

/** Google's consent address for the code flow, landing on the Worker's callback. */
export function consentUrl(params: { clientId: string; proxy: string; scope: string; prompt: string; hint?: string; challenge: string; state: string; first: boolean }): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const fields: Record<string, string> = {
    client_id: params.clientId,
    redirect_uri: `${params.proxy}/google/desktop/callback`,
    response_type: 'code',
    scope: params.scope,
    // offline: a refresh token, which Google gives on consent — asked for once, when there is no grant kept yet.
    access_type: 'offline',
    prompt: params.prompt || (params.first ? 'consent' : ''),
    include_granted_scopes: 'true',
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    ...(params.hint ? { login_hint: params.hint } : {}),
  };
  for (const [key, value] of Object.entries(fields)) if (value) url.searchParams.set(key, value);
  return url.href;
}

// ----------------------------------------------------------------- Worker --

let stays: boolean | null = null;
/** Asks the proxy once whether it signs in for keeps; the answer is kept for the sign-in's click. */
export function prepareStay(): void {
  if (stays !== null) return;
  void proxyHealth().then((health) => {
    stays = Boolean(health?.googleDesktop);
  });
}
/** Whether this page can keep a sign-in: the Worker exchanges codes and renews (known once /health has answered). */
export const staysAvailable = () => stays === true && Boolean(apiBase());
/** For the tests. */
export const setStays = (value: boolean | null) => {
  stays = value;
};

class WorkerError extends Error {
  constructor(
    message: string,
    public google: string | null = null,
    public status = 0,
  ) {
    super(message);
  }
}

async function askWorker(route: 'token' | 'refresh' | 'revoke', body: Record<string, string>, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const base = apiBase();
  if (!base) throw new WorkerError('no proxy');
  const answer = await fetcher(`${base}/google/desktop/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const said = (await answer.json().catch(() => ({}))) as Record<string, unknown>;
  if (!answer.ok) throw new WorkerError(typeof said.error === 'string' ? said.error : `the proxy answered ${answer.status}`, typeof said.google === 'string' ? said.google : null, answer.status);
  return said;
}

const granted = (said: Record<string, unknown>, scope: string): GrantedToken => ({
  accessToken: String(said.access_token),
  expiresAt: Date.now() + (Number(said.expires_in) || 3600) * 1000 - 60_000,
  scopes: (typeof said.scope === 'string' && said.scope ? said.scope : scope).split(' ').filter(Boolean),
});

/**
 * A new access token from the grant kept, with no window. Null when the grant
 * is gone — revoked, or a testing client's week over — and then forgotten,
 * so the next ask opens Google's window again.
 */
export async function renewFromKept(kept: KeptGrant, fetcher: typeof fetch = fetch): Promise<GrantedToken | null> {
  try {
    const said = await askWorker('refresh', { refresh_token: kept.refreshToken }, fetcher);
    return granted(said, kept.scopes.join(' '));
  } catch (error) {
    if (error instanceof WorkerError && (error.google === 'invalid_grant' || error.status === 400)) forgetKept(kept.clientId, kept.email);
    return null;
  }
}

/** The grant given back to Google, and forgotten here: sign-out. */
export async function revokeKept(clientId: string, email?: string, fetcher: typeof fetch = fetch): Promise<void> {
  for (const grant of forgetKept(clientId, email)) await askWorker('revoke', { token: grant.refreshToken }, fetcher).catch(() => undefined);
}

/**
 * The code flow, in a popup: consent there, the code handed back by the
 * Worker's callback page, exchanged for the tokens, the refresh token kept
 * under the account's email (read from the token afterwards by the caller,
 * through `onEmail`). Inside a click only, as any window.
 */
export function signInForKeeps(params: { clientId: string; scope: string; prompt: string; hint?: string; emailOf: (accessToken: string) => Promise<string> }): Promise<GrantedToken> {
  const proxy = apiBase();
  if (!proxy) return Promise.reject(new Error('no proxy'));
  // The window first, inside the click; its address once the verifier is made.
  const popup = window.open('about:blank', 'koios-google', 'popup,width=520,height=680');
  if (!popup) return Promise.reject(new Error('The browser blocked the sign-in window. Allow pop-ups for this site and try again.'));
  return new Promise<GrantedToken>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.clearInterval(watch);
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      fn();
    };
    const timer = window.setTimeout(() => finish(() => reject(new Error('Google did not answer in time.'))), SIGN_IN_WAIT);
    // The window closed by hand: nothing to wait for.
    const watch = window.setInterval(() => {
      if (popup.closed) window.setTimeout(() => finish(() => reject(new Error('The sign-in window was closed.'))), 800);
    }, 500);
    let state = '';
    let verifier = '';
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== new URL(proxy).origin || !event.data || typeof event.data !== 'object') return;
      const data = event.data as { type?: string; state?: string; code?: string; scope?: string; error?: string; error_description?: string };
      if (data.type !== 'koios-google-code' || data.state !== state) return;
      finish(() => {
        if (data.error || !data.code) {
          reject(new Error(data.error_description || data.error || 'Google sent no code.'));
          return;
        }
        askWorker('token', { code: data.code, code_verifier: verifier })
          .then(async (said) => {
            const token = granted(said, params.scope);
            if (typeof said.refresh_token === 'string' && said.refresh_token) {
              const email = await params.emailOf(token.accessToken).catch(() => '');
              const before = email ? keptGrantFor(params.clientId, email) : null;
              keep({ clientId: params.clientId, email, refreshToken: said.refresh_token, scopes: Array.from(new Set([...(before?.scopes ?? []), ...token.scopes])) });
            }
            resolve(token);
          })
          .catch(reject);
      });
    };
    window.addEventListener('message', onMessage);
    void pkce()
      .then((made) => {
        state = made.state;
        verifier = made.verifier;
        popup.location.href = consentUrl({ clientId: params.clientId, proxy, scope: params.scope, prompt: params.prompt, hint: params.hint, challenge: made.challenge, state: made.state, first: !keptGrantFor(params.clientId, params.hint) });
      })
      .catch((error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}
