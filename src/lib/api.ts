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

function fromStorage(): string | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { proxyBase?: string };
    return normaliseProxyBase(parsed.proxyBase);
  } catch {
    // No localStorage (a test runner, a locked-down browser), or nothing saved.
    return null;
  }
}

let override: string | null = fromStorage();

/** Called by the store whenever Settings changes, and once on load. */
export function setProxyBase(value: string | null | undefined): void {
  override = normaliseProxyBase(value);
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
    const payload = (await response.json()) as { ok?: boolean };
    return payload?.ok
      ? { ok: true, message: 'The proxy answered. arXiv and PDFs are available.' }
      : { ok: false, message: 'Something answered, but it is not this app’s proxy.' };
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
