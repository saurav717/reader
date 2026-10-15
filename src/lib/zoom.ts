// Zoom calls for the Calendar page's meetings. Three ways, the first that
// applies: a link pasted into the editor, the person's own Zoom room (kept in
// Settings → Meetings), or a meeting made for the occasion by the Worker
// (worker/meetings.js) — which needs a Zoom Server-to-Server OAuth app's
// credentials there, since Zoom gives no browser a way to make a meeting.
// The link then goes on the Google event (lib/calendar.ts, `toGoogleEvent`).

import { apiFetch, proxyHealth } from './api';
import type { EventDraft } from './calendar';
import { timeZone } from './calendar';

/** Whether the Worker can make Zoom meetings. */
export const canMakeZoom = async (): Promise<boolean> => Boolean((await proxyHealth())?.zoom);

/** A Zoom meeting made for a draft, at its time and for its length; its join link. */
export async function makeZoomMeeting(draft: Pick<EventDraft, 'title' | 'start' | 'end' | 'allDay'>): Promise<{ url: string; id: string; passcode?: string }> {
  const minutes = Math.max(15, Math.round((draft.end.getTime() - draft.start.getTime()) / 60_000));
  const response = await apiFetch('/zoom/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: draft.title.trim() || 'Meeting', start: draft.allDay ? undefined : draft.start.toISOString(), minutes: draft.allDay ? 60 : Math.min(minutes, 24 * 60), timezone: timeZone() }),
  });
  const body = (await response.json().catch(() => ({}))) as { url?: string; id?: string; passcode?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error || `Zoom could not be asked (${response.status}).`);
  return { url: body.url, id: String(body.id ?? ''), ...(body.passcode ? { passcode: body.passcode } : {}) };
}
