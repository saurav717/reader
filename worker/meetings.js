/**
 * Meetings: a Zoom call made for one on the Calendar page, and the notes of
 * one read back from Granola (src/lib/zoom.ts, src/lib/granola.ts).
 *
 * Zoom gives no browser a way to make a meeting, so the Worker does it, as a
 * Zoom Server-to-Server OAuth app of the site's own: in wrangler.toml's vars
 * or as secrets,
 *
 *   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET   the app's credentials
 *   ZOOM_USER                                            whose meetings (an email; "me" when unset)
 *
 * with the scope `meeting:write:meeting:admin` (or `meeting:write:admin`).
 * Without them the editor takes a pasted link or the person's own room.
 *
 * Granola's API answers no browser on another site either, so its two reads —
 * the list of notes, and one note — are passed through with the person's own
 * key, sent as `X-Granola-Key` and never kept or logged.
 */

export const GRANOLA_API = 'https://public-api.granola.ai/v1';
const ZOOM_TOKEN = 'https://zoom.us/oauth/token';
const ZOOM_API = 'https://api.zoom.us/v2';

export const zoomConfigured = (env = {}) => Boolean(String(env.ZOOM_ACCOUNT_ID || '').trim() && String(env.ZOOM_CLIENT_ID || '').trim() && String(env.ZOOM_CLIENT_SECRET || '').trim());

/** The account's token, kept until a minute before Zoom says it ends. */
let held = null;

async function zoomToken(env, doFetch) {
  if (held && held.until > Date.now() && held.account === env.ZOOM_ACCOUNT_ID) return held.token;
  const basic = btoa(`${String(env.ZOOM_CLIENT_ID).trim()}:${String(env.ZOOM_CLIENT_SECRET).trim()}`);
  const answer = await doFetch(`${ZOOM_TOKEN}?grant_type=account_credentials&account_id=${encodeURIComponent(String(env.ZOOM_ACCOUNT_ID).trim())}`, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok || !body.access_token) throw Object.assign(new Error(`Zoom refused the site’s credentials: ${body.reason || body.error || answer.status}`), { status: 502 });
  held = { token: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60_000, account: env.ZOOM_ACCOUNT_ID };
  return held.token;
}

/** What a page asks for, cleaned: a topic, a start (or none, for a meeting with no set time), a length, a zone. */
export function zoomRequest(raw) {
  const topic = typeof raw?.topic === 'string' && raw.topic.trim() ? raw.topic.trim().slice(0, 200) : 'Meeting';
  const start = typeof raw?.start === 'string' && !Number.isNaN(Date.parse(raw.start)) ? new Date(raw.start).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
  const minutes = Number.isFinite(raw?.minutes) ? Math.max(15, Math.min(24 * 60, Math.round(raw.minutes))) : 60;
  const timezone = typeof raw?.timezone === 'string' && /^[\w/+-]{1,60}$/.test(raw.timezone) ? raw.timezone : 'UTC';
  return {
    topic,
    type: start ? 2 : 3,
    ...(start ? { start_time: start } : {}),
    duration: minutes,
    timezone,
    settings: { join_before_host: true, waiting_room: false, mute_upon_entry: true, approval_type: 2 },
  };
}

/** A Zoom meeting made; its join link, id and passcode. */
export async function makeZoomMeeting(env, raw, doFetch = globalThis.fetch) {
  const token = await zoomToken(env, doFetch);
  const user = String(env.ZOOM_USER || 'me').trim() || 'me';
  const answer = await doFetch(`${ZOOM_API}/users/${encodeURIComponent(user)}/meetings`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(zoomRequest(raw)) });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok || !body.join_url) throw Object.assign(new Error(`Zoom did not make the meeting: ${body.message || answer.status}`), { status: answer.status === 429 ? 429 : 502 });
  return { url: body.join_url, id: String(body.id ?? ''), ...(body.password ? { passcode: String(body.password) } : {}) };
}

/** The Granola path a page may ask for — the list of notes, or one — and its query, kept to what is read; null for anything else. */
export function granolaPath(path, search) {
  const rest = path.replace(/^\/granola/, '');
  const one = /^\/notes\/([\w-]{1,100})$/.exec(rest);
  if (one) return `/notes/${one[1]}`;
  if (rest !== '/notes') return null;
  const asked = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of ['created_after', 'created_before', 'updated_after', 'cursor', 'page_size', 'folder_id']) {
    const value = asked.get(key);
    if (value && value.length <= 200) kept.set(key, value);
  }
  const query = kept.toString();
  return `/notes${query ? `?${query}` : ''}`;
}

/** A read from Granola with the person's key; Granola's answer, as it gave it. */
export async function askGranola(key, path, doFetch = globalThis.fetch) {
  const answer = await doFetch(`${GRANOLA_API}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const body = await answer.json().catch(() => ({ error: `Granola answered ${answer.status}` }));
  return { status: answer.status, body };
}

export const granolaKeyOf = (request) => {
  const key = (request.headers.get('X-Granola-Key') || '').trim();
  return /^[\w.-]{10,300}$/.test(key) ? key : null;
};

// ------------------------------------------------- notes on this computer --
//
// Reader's desktop app records a meeting with Recall.ai's Desktop Recording
// SDK (desktop/app/main.js): no bot joins. Each recording needs an upload
// token, made here with the site's Recall key, which never leaves the Worker:
//
//   npx wrangler secret put RECALL_API_KEY
//   # and in wrangler.toml, under [vars]:
//   # RECALL_API_URL = "https://us-west-2.recall.ai"   # the region the workspace is in
//   # RECALL_TRANSCRIPT = "recallai_streaming"         # the transcription provider set up in Recall
//
// The transcript comes back to the desktop app as it is spoken (a
// `desktop_sdk_callback` realtime endpoint), not to the Worker: the page
// writes it up and files it, and nothing of the meeting is kept here.

export const recallConfigured = (env = {}) => Boolean(String(env.RECALL_API_KEY || '').trim());

/** The region's address, for the desktop app's SDK and for the token; Recall's US region when none is set. */
export function recallApiUrl(env = {}) {
  const url = String(env.RECALL_API_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[\w.-]+\.recall\.ai$/.test(url) ? url : 'https://us-west-2.recall.ai';
}

/** What a recording is set up with: transcribed as it goes, the words and who joined sent back to the app. */
export function uploadRequest(env = {}) {
  const provider = /^[a-z0-9_]{3,60}$/.test(String(env.RECALL_TRANSCRIPT || '')) ? env.RECALL_TRANSCRIPT : 'recallai_streaming';
  return {
    recording_config: {
      transcript: { provider: { [provider]: {} } },
      realtime_endpoints: [{ type: 'desktop_sdk_callback', events: ['transcript.data', 'participant_events.join'] }],
    },
  };
}

/** A Desktop SDK upload: its token, for the app to record one meeting with. */
export async function makeUpload(env, doFetch = globalThis.fetch) {
  const answer = await doFetch(`${recallApiUrl(env)}/api/v1/sdk_upload/`, {
    method: 'POST',
    headers: { Authorization: `Token ${String(env.RECALL_API_KEY).trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(uploadRequest(env)),
  });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok || !body.upload_token) throw Object.assign(new Error(`Recall did not take the recording: ${body.detail || body.message || answer.status}`), { status: answer.status === 429 ? 429 : 502 });
  return { uploadToken: body.upload_token, id: String(body.id ?? '') };
}
