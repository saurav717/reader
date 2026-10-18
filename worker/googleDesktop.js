// The Reader app staying signed in to Google (desktop/app/google.js): the
// authorization-code flow, which gives a refresh token the app keeps on the
// computer, where the page's token flow (src/lib/google.ts) gives an access
// token that lasts an hour and nothing to renew it with. Google's token
// endpoint wants the OAuth client's secret with the code, so the exchange is
// made here, with GOOGLE_CLIENT_SECRET; the Worker keeps nothing of what
// comes back — the tokens go to the app that asked, and only ever to it.
//
//   GET  /google/desktop/callback   where Google sends the browser after consent: a page that
//                                   hands the code to the app (reader-app://google-code?code&state)
//   POST /google/desktop/token      { code, code_verifier, redirect_uri }: the code for its tokens
//   POST /google/desktop/refresh    { refresh_token }: a new access token
//   POST /google/desktop/revoke     { token }: the grant given back to Google (sign-out)
//
// A code is good for one exchange and only with the PKCE verifier the app
// made, so a code read off the callback's address by anyone else opens
// nothing. The client's redirect URI is this callback, on this Worker:
// Google sends the code nowhere else.

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const PROTOCOL = 'reader-app';
/** The app's `state`: what desktop/app/google.js makes (base64url, 32 bytes). */
const STATE = /^[A-Za-z0-9_-]{32,64}$/;
const CODE = /^[\w./-]{8,512}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export const PATHS = ['/google/desktop/callback', '/google/desktop/token', '/google/desktop/refresh', '/google/desktop/revoke'];
export const isGoogleDesktopPath = (path) => PATHS.includes(path);

/** Whether this Worker can sign the app in: the client's id and secret are set. */
export const googleDesktopConfigured = (env) => Boolean(String(env.GOOGLE_CLIENT_ID || '').trim() && String(env.GOOGLE_CLIENT_SECRET || '').trim());

/** Where Google sends the browser back, for this Worker: what the OAuth client must list under its redirect URIs. */
export const callbackUrl = (request) => new URL('/google/desktop/callback', request.url).href;

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * The page the browser lands on after consent: it opens the app with the
 * code (a reader-app:// link; the browser may ask once whether to), and says
 * so. Nothing of the code is kept here, and the page is never cached.
 */
function callbackPage(params) {
  const link = `${PROTOCOL}://google-code?${new URLSearchParams(params).toString()}`;
  const failed = Boolean(params.error);
  const text = failed ? `Google didn’t sign you in: ${params.error_description || params.error}. Go back to Koios and try again.` : 'Signed in. Go back to Koios: you can close this tab. (If your browser asked, allow it to open Reader.)';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Koios · Google</title>
<body style="font:15.5px/1.6 system-ui,sans-serif;margin:48px auto;max-width:420px;padding:0 16px;color:#1a1a17;background:#fbfaf6">
<h1 style="font-size:20px;margin:0 0 8px">${failed ? 'Not signed in' : 'Signed in'}</h1>
<p style="color:#6f6c63">${escape(text)}</p>
${failed ? '' : `<p><a href="${escape(link)}" style="display:inline-block;font-weight:600;border-radius:8px;padding:10px 18px;background:#1f5e52;color:#f6f4ec;text-decoration:none">Open Koios</a></p>`}
<script>location.href=${JSON.stringify(link).replace(/</g, '\\u003c')}</script></body>`;
  return new Response(html, {
    status: failed ? 400 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' },
  });
}

/** Google's token endpoint, with the client: what it answered, or why not. */
async function askGoogle(env, url, params) {
  const body = new URLSearchParams({ client_id: String(env.GOOGLE_CLIENT_ID).trim(), client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(), ...params });
  const answer = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
  const said = await answer.json().catch(() => ({}));
  return { ok: answer.ok, status: answer.status, said };
}

/**
 * The routes above. `origins` are the site's: a browser page from anywhere
 * else is refused (the app itself sends no Origin). `overLimit` is the
 * sign-in rate limit, by address.
 */
export async function handleGoogleDesktop(request, env, path, { json, headers, origins = [], overLimit = async () => false }) {
  const noStore = { ...headers, 'Cache-Control': 'no-store' };
  if (path === '/google/desktop/callback') {
    if (request.method !== 'GET') return json({ error: 'GET' }, 405, headers);
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || '';
    if (!STATE.test(state)) return callbackPage({ error: 'invalid_state', error_description: 'this sign-in isn’t one the Koios app started' });
    const error = url.searchParams.get('error');
    if (error) return callbackPage({ state, error: error.slice(0, 80), error_description: (url.searchParams.get('error_description') || '').slice(0, 300) });
    const code = url.searchParams.get('code') || '';
    if (!CODE.test(code)) return callbackPage({ state, error: 'invalid_request', error_description: 'Google sent no code' });
    return callbackPage({ state, code, scope: (url.searchParams.get('scope') || '').slice(0, 1000) });
  }

  if (request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
  const origin = request.headers.get('Origin');
  if (origin && !origins.includes(origin)) return json({ error: 'not from this app' }, 403, headers);
  if (!googleDesktopConfigured(env)) return json({ error: 'this Worker does not sign the Koios app in: it needs GOOGLE_CLIENT_ID and the GOOGLE_CLIENT_SECRET secret — see wrangler.toml' }, 501, headers);
  if (await overLimit(env, request)) return json({ error: 'too many sign-ins from this address; wait a minute and try again', limited: true }, 429, { ...headers, 'Retry-After': '60' });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'a JSON body' }, 400, headers);

  if (path === '/google/desktop/token') {
    const code = typeof body.code === 'string' ? body.code : '';
    const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
    if (!CODE.test(code) || !VERIFIER.test(verifier)) return json({ error: 'code and code_verifier' }, 400, headers);
    // The code was issued for this Worker's callback and for no other address.
    const { ok, status, said } = await askGoogle(env, GOOGLE_TOKEN, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callbackUrl(request) });
    if (!ok || !said.access_token) return json({ error: said.error_description || said.error || `Google answered ${status}`, google: said.error || null }, status === 400 || status === 401 ? 400 : 502, noStore);
    return json({ access_token: said.access_token, expires_in: Number(said.expires_in) || 3600, scope: typeof said.scope === 'string' ? said.scope : '', refresh_token: typeof said.refresh_token === 'string' ? said.refresh_token : null }, 200, noStore);
  }

  if (path === '/google/desktop/refresh') {
    const refresh = typeof body.refresh_token === 'string' ? body.refresh_token.slice(0, 1024) : '';
    if (!refresh) return json({ error: 'refresh_token' }, 400, headers);
    const { ok, status, said } = await askGoogle(env, GOOGLE_TOKEN, { grant_type: 'refresh_token', refresh_token: refresh });
    // invalid_grant: the person revoked it, or a testing app's week ran out. The app forgets the token and asks again.
    if (!ok || !said.access_token) return json({ error: said.error_description || said.error || `Google answered ${status}`, google: said.error || null }, status === 400 || status === 401 ? 400 : 502, noStore);
    return json({ access_token: said.access_token, expires_in: Number(said.expires_in) || 3600, scope: typeof said.scope === 'string' ? said.scope : '' }, 200, noStore);
  }

  if (path === '/google/desktop/revoke') {
    const token = typeof body.token === 'string' ? body.token.slice(0, 1024) : '';
    if (!token) return json({ error: 'token' }, 400, headers);
    // Google takes either token; revoking the refresh token ends the access tokens from it too.
    const answer = await fetch(`${GOOGLE_REVOKE}?${new URLSearchParams({ token })}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => null);
    return json({ ok: Boolean(answer?.ok) }, 200, noStore);
  }
  return json({ error: 'not found' }, 404, headers);
}
