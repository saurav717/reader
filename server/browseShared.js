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
