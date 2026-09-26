/**
 * Where the proxy lives.
 *
 * arXiv sends no CORS headers, so its search API, HTML renderings and PDFs can
 * only be reached through a server — and neither do the publishers and
 * repositories that hold everything else. Three deployments:
 *
 *   unset            same-origin `/api` — the dev server, or `npm start`.
 *   <a url>          a proxy elsewhere, e.g. the Cloudflare Worker in worker/.
 *                    Use this when the app is on a static host.
 *   "none"           no proxy at all. The app still runs: search falls back to
 *                    OpenAlex, Crossref and Semantic Scholar, which do send
 *                    CORS headers, the reader shows abstracts, and PDFs become
 *                    links out rather than something you can read or save.
 *
 * The build-time value is only the default. A static build — GitHub Pages,
 * where `none` is the only honest thing to compile in — can be pointed at a
 * proxy at runtime from Settings, which is the difference between rebuilding
 * and redeploying the site and pasting a URL into a box. That address lives in
 * the same `reader.settings` blob as everything else in Settings, and is read
 * from there directly here so that the very first render already knows whether
 * there is a proxy: the store sets it again on load, and on every change.
 */
// `import.meta.env` is Vite's, and is absent when these modules are imported
// by the test runner under plain Node, so it is read defensively.
const configured = (import.meta.env as ImportMetaEnv | undefined)?.VITE_API_BASE?.trim();

/** The build-time default, with `none` meaning "no proxy at all". */
export const BUILT_IN_BASE: string | null =
  configured === 'none' ? null : (configured || '/api').replace(/\/$/, '');

const SETTINGS_KEY = 'reader.settings';

/**
 * A proxy address has to be same-origin or https: the app is served over
 * https, and a browser will not let an https page call an http one. Anything
 * else is dropped rather than silently producing requests that cannot work.
 */
export function normaliseProxyBase(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim().replace(/\/$/, '');
  if (!trimmed) return null;
  if (trimmed === 'none') return null;
  if (trimmed.startsWith('/')) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'https:') return trimmed;
    // http is fine when it is your own machine, and only then.
    if (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

function fromStorage(): { base: string | null; token: string } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { base: null, token: '' };
    const parsed = JSON.parse(raw) as { proxyBase?: string; proxyToken?: string };
    return { base: normaliseProxyBase(parsed.proxyBase), token: (parsed.proxyToken || '').trim() };
  } catch {
    // No localStorage (a test runner, a locked-down browser), or nothing saved.
    return { base: null, token: '' };
  }
}

const saved = fromStorage();
let override: string | null = saved.base;
/**
 * The proxy's token, where it has one. A proxy on the open internet is
 * reachable by anyone who reads its address out of this site's JavaScript,
 * so what drives a browser, keeps or uses a sign-in, or spends a metered
 * account takes a token, set on the proxy (the READER_TOKEN secret of the
 * Worker, or of `npm start`) and pasted here once. It goes only to the
 * proxy, as a header; arXiv and open-access PDFs need none.
 */
let token = saved.token;

/** Called by the store whenever Settings changes, and once on load. */
export function setProxyBase(value: string | null | undefined): void {
  override = normaliseProxyBase(value);
}

export function setProxyToken(value: string | null | undefined): void {
  token = (value || '').trim();
}

export function hasProxyToken(): boolean {
  return token !== '';
}

const CLIENT_KEY = 'reader.client-id';

/**
 * Which browser this is, to the proxy: an id made up once and kept, under
 * which the proxy keeps this browser's session and sign-in and no other's.
 * A name, not a secret — the token above is the secret.
 */
export function clientId(): string {
  try {
    const kept = localStorage.getItem(CLIENT_KEY);
    if (kept && /^[A-Za-z0-9_-]{16,64}$/.test(kept)) return kept;
    const fresh = crypto.randomUUID();
    localStorage.setItem(CLIENT_KEY, fresh);
    return fresh;
  } catch {
    return 'no-storage-0000-0000';
  }
}

/** The headers every request to the proxy carries: who this is, and the token when there is one. */
export function apiHeaders(extra: HeadersInit = {}): Record<string, string> {
  const headers: Record<string, string> = { 'X-Reader-Client': clientId() };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { ...headers, ...(extra instanceof Headers ? Object.fromEntries(extra.entries()) : Array.isArray(extra) ? Object.fromEntries(extra) : extra) };
}

/** `fetch`, to the proxy, with those headers on. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(api(path), { ...init, headers: apiHeaders(init.headers) });
}

/**
 * A pass from the proxy, in place of a pasted token, for anyone signed in
 * with Google: the proxy asks Google whose sign-in it is, and answers with a
 * pass of its own, good for thirty days (see server/passes.js). The Google
 * token goes to this app's own proxy only — the one compiled in, or one on
 * this machine — never to an address typed into Settings, which could be
 * anyone's.
 */
export function mayAskForPass(): boolean {
  const base = apiBase();
  if (!base) return false;
  if (base === BUILT_IN_BASE || base.startsWith('/')) return true;
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(base).hostname);
  } catch {
    return false;
  }
}

const PASS_PREFIX = 'rp1.';

/** Whether a token is a proxy pass rather than one pasted by hand. */
export const isPass = (value: string) => value.startsWith(PASS_PREFIX);

/** When a pass runs out, from the part of it that is only signed, not secret; 0 when unreadable. */
export function passExpires(value: string): number {
  if (!isPass(value)) return 0;
  try {
    const payload = value.slice(PASS_PREFIX.length).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4))) as { x?: number };
    return typeof claims.x === 'number' ? claims.x * 1000 : 0;
  } catch {
    return 0;
  }
}

/** A Google sign-in, swapped for a proxy pass. Null when the proxy does not take them. */
export async function passForGoogle(googleToken: string): Promise<string | null> {
  if (!mayAskForPass()) return null;
  const response = await fetch(api('/auth/google'), {
    method: 'POST',
    headers: { 'X-Google-Token': googleToken, 'X-Reader-Client': clientId() },
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as { pass?: string };
  return payload.pass && isPass(payload.pass) ? payload.pass : null;
}

/** The proxy in use, or null when this deployment has none. */
export function apiBase(): string | null {
  return override ?? BUILT_IN_BASE;
}

export function hasProxy(): boolean {
  return apiBase() !== null;
}

export function api(path: string): string {
  const base = apiBase();
  if (!base) throw new Error('No proxy is configured for this deployment');
  return `${base}${path}`;
}

/**
 * Whether an address answers as one of our proxies. Used by Settings to tell
 * "wrong URL" from "right URL, origin not allowed" before anything depends on
 * it — a Worker that does not list this site in ALLOWED_ORIGINS fails CORS,
 * which from the page is indistinguishable from the host being down.
 */
export async function checkProxy(value: string): Promise<{ ok: boolean; message: string }> {
  const base = normaliseProxyBase(value);
  if (!base) return { ok: false, message: 'That is not an https address.' };
  try {
    const response = await fetch(`${base}/health`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return { ok: false, message: `The proxy answered ${response.status}.` };
    const payload = (await response.json()) as { ok?: boolean; auth?: boolean };
    if (!payload?.ok) return { ok: false, message: 'Something answered, but it is not this app’s proxy.' };
    if (payload.auth && !token) {
      return { ok: true, message: 'The proxy answered. It takes a token for the browser inside the reader, sign-ins and Scholar — paste it below.' };
    }
    if (payload.auth === false) {
      return { ok: true, message: 'The proxy answered. It has no READER_TOKEN set, so the browser inside the reader and kept sign-ins are off on it.' };
    }
    return { ok: true, message: 'The proxy answered. arXiv and PDFs are available.' };
  } catch {
    return {
      ok: false,
      message:
        'Could not reach it. Check the URL, and that this site’s origin is in the proxy’s ALLOWED_ORIGINS.',
    };
  }
}

export const NO_PROXY_REASON =
  'This copy runs on a static host with no server, so the sites that hold the papers — which block direct browser requests — cannot be reached from here.';

/** What to tell someone who could fix it, rather than only what is wrong. */
export const NO_PROXY_FIX =
  'Deploy the Cloudflare Worker in worker/ and paste its URL into Settings → Paper proxy, and arXiv, the full text and the PDFs all come back.';
