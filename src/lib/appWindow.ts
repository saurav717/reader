/**
 * The page in the Reader app's own window (the app opens the site marked
 * #app=1, companion/reader_companion/cli.py): it keeps this computer's
 * Companion company. Every half minute it says it is open, and as it closes
 * it says goodbye; the Companion shuts down a few seconds after a goodbye
 * with no hello after it (a reload says hello again at once), or once it
 * has heard nothing for a few minutes — unless set to keep running, the
 * switch on this computer under Your compute. A tab of the site in a
 * browser is never the app's window, so closing one changes nothing.
 */
import { companionPort } from './companion';
import { serversNow } from './playground';

const FLAG = 'reader.appWindow';
const EVERY_MS = 30_000;

/** Reads the app's mark off the address (keeping a pairing link's own part), remembering it for this window's reloads. */
function markFromAddress() {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  if (params.get('app') !== '1') return;
  try {
    sessionStorage.setItem(FLAG, '1');
  } catch {
    // no storage: this load still counts
  }
  params.delete('app');
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
  (window as Window & { readerAppWindow?: boolean }).readerAppWindow = true;
}

export function isAppWindow(): boolean {
  if ((window as Window & { readerAppWindow?: boolean }).readerAppWindow) return true;
  try {
    return sessionStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

/** This computer's Companion as this browser knows it: at 127.0.0.1 or localhost, with its token. */
const localCompanion = () => serversNow().find((server) => server.token && companionPort(server.url) !== null && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(server.url));

function say(event: 'hello' | 'goodbye') {
  const server = localCompanion();
  if (!server) return;
  // keepalive: the goodbye is sent as the window closes, and still goes out after it has.
  void fetch(`${server.url.replace(/\/?$/, '/')}companion/app`, {
    method: 'POST',
    keepalive: event === 'goodbye',
    headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
  }).catch(() => undefined);
}

/** Called once as the page starts: in the app's window, says hello now and every half minute, and goodbye as it closes. */
export function keepCompanionCompany() {
  if (typeof window === 'undefined') return;
  markFromAddress();
  if (!isAppWindow()) return;
  say('hello');
  // The list of servers may come in a moment after the first hello: once more soon, then on the clock.
  window.setTimeout(() => say('hello'), 3000);
  window.setInterval(() => say('hello'), EVERY_MS);
  window.addEventListener('pagehide', () => say('goodbye'));
  window.addEventListener('pageshow', (event) => event.persisted && say('hello'));
}
