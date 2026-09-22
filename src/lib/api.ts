/**
 * Where the proxy lives.
 *
 * arXiv sends no CORS headers, so its search API, HTML renderings and PDFs can
 * only be reached through a server — and neither do the publishers and
 * repositories that host the open-access PDFs OpenAlex and Semantic Scholar
 * point at. Three deployments:
 *
 *   unset            same-origin `/api` — the dev server, or `npm start`.
 *   <a url>          a proxy elsewhere, e.g. the Cloudflare Worker in worker/.
 *                    Use this when the app is on a static host.
 *   "none"           no proxy at all. The app still runs: search falls back to
 *                    OpenAlex and Semantic Scholar, which do send CORS headers,
 *                    the reader shows abstracts, and PDFs become links out
 *                    rather than something you can read or save from here.
 */
// `import.meta.env` is Vite's, and is absent when these modules are imported
// by the test runner under plain Node, so it is read defensively.
const configured = (import.meta.env as ImportMetaEnv | undefined)?.VITE_API_BASE?.trim();

export const API_BASE: string | null =
  configured === 'none' ? null : (configured || '/api').replace(/\/$/, '');

export const hasProxy = API_BASE !== null;

export function api(path: string): string {
  if (!API_BASE) throw new Error('No proxy is configured for this deployment');
  return `${API_BASE}${path}`;
}

export const NO_PROXY_REASON =
  'This copy runs on a static host with no server, so the sites that hold the papers — which block direct browser requests — cannot be reached from here.';
