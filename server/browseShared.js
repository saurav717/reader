// What the browser inside the reader shares between the Node proxy
// (server/browse.js) and the Worker (worker/browse.js): the size of the page
// the person sees, which keys are passed on, and the shape of a session's
// answer. Web APIs only.

/** The size of the page the person sees. Frames are the same size, so the app scales them, not the proxy. */
export const VIEWPORT = { width: 1280, height: 800 };

/** Playwright's and Puppeteer's key names are the DOM's, near enough; this is what is let through. */
export function acceptKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key.length === 1) return true; // a printable character, case and all
  return /^(?:F[1-9]|F1[0-2]|[A-Z][A-Za-z0-9]{1,20})$/.test(key) && !['Dead', 'Unidentified', 'Process'].includes(key);
}

export const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
export const BUTTONS = new Set(['left', 'middle', 'right']);
export const clicks = (value) => Math.max(1, Math.min(3, Number(value) || 1));

/** True for the first bytes of a PDF. */
export const startsWithPdf = (bytes) =>
  bytes && bytes.length > 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) === '%PDF-';

/** The one error a route turns into "no browser is open". */
export const closedError = () => Object.assign(new Error('no browser is open'), { code: 'closed' });

// ---------------------------------------------- the file, from the browser ----

/**
 * The first PDF among the URLs, fetched by the page itself — `fetch()` run
 * inside it, with its own cookies — rather than by the proxy with the page's
 * cookies copied onto a request of its own.
 *
 * The two are not the same to a site behind a bot check. The clearance
 * Cloudflare grants once the box is ticked is a cookie bound to the browser
 * that ticked it, and a request from anywhere else carrying that cookie is
 * challenged again and answered with the check's page, not the file. The
 * Worker's own fetch leaves from another address than Cloudflare's browser,
 * and the Node proxy's from another user-agent than its page, so a file from
 * such a site has to be fetched by the page that was let in. The page can
 * fetch its own site's URLs and any site's that allows it; one it may not
 * read (another site's, without CORS) is skipped, for the proxy's own fetch
 * to try after.
 *
 * Works on a Playwright page and a Puppeteer page alike: `page.evaluate`
 * with one argument is the same on both.
 *
 * @returns {Promise<Uint8Array|null>} the file, or null when none of the URLs gave one.
 */
export async function fetchFileInPage(page, urls, maxBytes = 64 * 1024 * 1024) {
  const seen = new Set();
  for (const url of urls) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    let answer;
    try {
      answer = await page.evaluate(
        async ({ url, max }) => {
          try {
            const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
            if (!response.ok) return null;
            if (Number(response.headers.get('content-length') || 0) > max) return { tooLarge: true };
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > max) return { tooLarge: true };
            if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') return null;
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return { base64: btoa(binary) };
          } catch {
            return null; // another site's, without CORS; or the network
          }
        },
        { url, max: maxBytes },
      );
    } catch {
      continue; // the page is mid-navigation, or cannot run scripts
    }
    if (answer?.tooLarge) throw new Error('that PDF is too large to fetch');
    if (typeof answer?.base64 !== 'string' || !answer.base64) continue;
    const binary = atob(answer.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (startsWithPdf(bytes)) return bytes;
  }
  return null;
}
