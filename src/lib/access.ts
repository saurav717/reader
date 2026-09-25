/**
 * Signing in with an institution, for the papers behind a login.
 *
 * A publisher hands its PDF to a browser that has signed in through a
 * university and a web page to everyone else, and the proxy is everyone else.
 * The page cannot fix that on its own: it may open the publisher in a new tab,
 * but it may not read what comes back, cookies or no cookies. So the sign-in
 * happens where the fetching happens — the proxy opens a real browser window
 * on its own machine, the person signs in there, and a copy that came back
 * as a login wall is asked for again through that browser's profile.
 *
 * That takes a proxy with a screen: `npm start` on your own machine, which
 * the site can be pointed at from Settings. The Cloudflare Worker cannot do
 * it, and `/access/status` is how this side finds out which it is talking to
 * — so the offer is made where it can work, and explained where it cannot.
 */
import { apiBase, apiFetch, hasProxy } from './api';

export interface AccessStatus {
  /** Whether this proxy can open a sign-in window at all. */
  available: boolean;
  /** Why not, worded for the person who could fix it. */
  reason?: string;
  /** Whether a sign-in window is open right now. */
  window: 'open' | 'closed';
  /** Whether anyone has ever signed in on this proxy. */
  everSignedIn: boolean;
  /** Where the proxy keeps the signed-in profile, for Settings to say. */
  profile?: string;
  /**
   * Whether the proxy can open a browser inside the reader instead — its
   * Chromium, headless, on the same profile — which needs no screen. See
   * src/lib/browse.ts.
   */
  browse?: { available: boolean; reason?: string };
}

const UNAVAILABLE: AccessStatus = {
  available: false,
  window: 'closed',
  everSignedIn: false,
  reason: 'There is no proxy configured, so there is nothing to sign in through.',
};

async function ask(path: string, init?: RequestInit): Promise<AccessStatus> {
  const response = await apiFetch(path, { ...init, headers: { Accept: 'application/json' } });
  const payload = (await response.json().catch(() => ({}))) as Partial<AccessStatus> & { error?: string };
  if (!response.ok) throw new Error(payload.error || `The proxy answered ${response.status}.`);
  return { ...UNAVAILABLE, ...payload };
}

/** The proxy's answer, fresh. */
export async function accessStatus(): Promise<AccessStatus> {
  if (!hasProxy()) return UNAVAILABLE;
  try {
    return await ask('/access/status');
  } catch {
    // An older proxy without the route, or one that is down: no sign-in.
    return { ...UNAVAILABLE, reason: 'This proxy does not know how to open a sign-in window. Update it and restart.' };
  }
}

// One answer per proxy address: the button that offers a sign-in is drawn on
// every failed result, and availability does not change between two of them.
let cached: { base: string | null; answer: Promise<AccessStatus> } | null = null;

/** Whether the current proxy can sign in, remembered per proxy address. */
export function accessAvailable(): Promise<AccessStatus> {
  const base = apiBase();
  if (!cached || cached.base !== base) {
    cached = { base, answer: accessStatus() };
  }
  return cached.answer;
}

/** Forget the remembered answer — after Settings changes the proxy, say. */
export function forgetAccess(): void {
  cached = null;
}

/** Open the sign-in window at a publisher's page. */
export async function requestSignIn(url: string): Promise<void> {
  await ask(`/access/signin?url=${encodeURIComponent(url)}`, { method: 'POST' });
}

/** "I have signed in": close the window, so the fetches can use the profile. */
export async function finishSignIn(): Promise<void> {
  await ask('/access/close', { method: 'POST' }).catch(() => undefined);
}

/** Sign out of everything the proxy has signed in to. */
export async function forgetSignIns(): Promise<void> {
  await ask('/access/forget', { method: 'POST' });
}

/**
 * Resolves once the sign-in window has been closed — by the person, when they
 * are done, or by `finishSignIn`. Polls, because the proxy has no way to call
 * back, and gives up quietly on abort.
 */
export async function waitForSignIn(signal?: AbortSignal, intervalMs = 1500): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const status = await accessStatus();
    if (status.window !== 'open') return;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}
