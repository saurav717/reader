// The site's look: `koios` — the night, the gold hairlines, the Titan where
// a page is empty — or `classic`, the theme before it. One choice for the
// whole site, made by the owner on Usage → The site and kept on the Worker
// (GET and PUT /site/look); every visit reads it. index.html applies the
// last answer before the first paint, from this browser's copy, so the
// page does not change look as it loads.

import { apiFetch, hasProxy } from './api';
import { ownerFetch } from './owner';

export type Look = 'koios' | 'classic';

const LOOK_KEY = 'reader.look';

export function currentLook(): Look {
  return document.documentElement.dataset.look === 'classic' ? 'classic' : 'koios';
}

export function applyLook(look: Look): void {
  document.documentElement.dataset.look = look;
  try {
    localStorage.setItem(LOOK_KEY, look);
  } catch {
    // Storage closed to us: the look still applies to this page.
  }
}

/** The Worker's answer, applied; nothing without a proxy, where the browser's copy stands. */
export async function syncLook(): Promise<void> {
  if (!hasProxy()) return;
  try {
    const response = await apiFetch('/site/look');
    if (!response.ok) return;
    const { look } = (await response.json()) as { look?: string };
    if (look === 'koios' || look === 'classic') applyLook(look);
  } catch {
    // Offline, or an older Worker: the look stays as it was.
  }
}

/** The owner's choice, kept on the Worker and applied here at once. */
export async function setSiteLook(look: Look): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await ownerFetch('/site/look', undefined, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ look }) });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) return { ok: false, error: body.error || `The proxy answered ${response.status}.` };
  applyLook(look);
  return { ok: true };
}
