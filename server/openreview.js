// Papers on OpenReview, fetched the way OpenReview means programs to.
//
// openreview.net answers an anonymous fetch of a paper's PDF with a 403 and
// sends the browser to a check of its own — /challenge?redirect=/pdf?id=…,
// "Verifying your browser", with Cloudflare's Turnstile box inside. It is
// not Cloudflare's challenge page, so it carries no `cf-mitigated` header,
// but it is Cloudflare's box, and from the Worker's browser — Cloudflare's
// own, which Cloudflare tells every site is a bot — it never passes: the
// box ticks, says "Verification hiccup, retrying…", and comes back. But
// OpenReview keeps an API for programs (the one its own Python client
// talks to), on api2.openreview.net for the venues of its current API and
// api.openreview.net for the older ones, and both serve a note's PDF at
// /pdf?id=… with no check in the way. So an OpenReview URL is asked for
// there first, and the web site only if the API has no file for it.
//
// Web APIs only: the Worker imports this file too.

const HOSTS = new Set(['openreview.net', 'api.openreview.net', 'api2.openreview.net']);
const ID = /^[A-Za-z0-9_-]{5,40}$/;

/**
 * The note a URL of OpenReview's names — `/pdf?id=`, `/forum?id=`,
 * `/attachment?id=`, or the `/challenge?redirect=` page that stands in
 * front of any of them — as `{ id, name }`, `name` being the attachment's
 * field when it is not the paper itself. Null for any other URL.
 */
export function openReviewNoteIn(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.has(host)) return null;
  if (/^\/challenge\/?$/i.test(url.pathname)) {
    const redirect = url.searchParams.get('redirect');
    if (!redirect || !redirect.startsWith('/')) return null;
    return openReviewNoteIn(new URL(redirect, 'https://openreview.net/').href);
  }
  const route = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (!['/pdf', '/forum', '/attachment'].includes(route)) return null;
  const id = url.searchParams.get('id') || '';
  if (!ID.test(id)) return null;
  const name = route.endsWith('/attachment') ? url.searchParams.get('name') || '' : '';
  if (name && !/^[A-Za-z0-9_-]{1,40}$/.test(name)) return null;
  return { id, name: name && name !== 'pdf' ? name : '' };
}

/**
 * The URLs on OpenReview's API that serve the file an OpenReview URL
 * names, in the order worth trying — or none, when the URL is not
 * OpenReview's. The current API first, since that is where every venue of
 * the last few years lives; the old one for the venues before it.
 */
export function openReviewFiles(target) {
  const note = openReviewNoteIn(target);
  if (!note) return [];
  const query = note.name
    ? `attachment?id=${encodeURIComponent(note.id)}&name=${encodeURIComponent(note.name)}`
    : `pdf?id=${encodeURIComponent(note.id)}`;
  return [`https://api2.openreview.net/${query}`, `https://api.openreview.net/${query}`];
}

/**
 * Whether a URL is OpenReview's check for a person: the page openreview.net
 * sends a browser to instead of the one it asked for.
 */
export function isOpenReviewChallenge(target) {
  try {
    const url = new URL(target);
    return url.hostname.toLowerCase().replace(/^www\./, '') === 'openreview.net' && /^\/challenge\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}
