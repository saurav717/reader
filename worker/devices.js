/**
 * The computers a Google account has connected: one Durable Object per email,
 * holding a row per Reader Companion that account owns.
 *
 * The files stay on the computer. All that is kept here is how to reach it:
 * its name and hardware, its address (the Companion's HTTPS tunnel, which
 * changes each time it starts), the token its Jupyter server takes, and when
 * it last said so. A browser signed in as that account reads the list
 * (`GET /devices` with its pass) and finds the computer from anywhere; one
 * signed in as anyone else reads its own list, which doesn't have it.
 *
 * A row is made by the Companion itself (`POST /devices/claim`, with the pass
 * of the page that claimed it), which gets a secret back. With that secret it
 * keeps the row current (`POST /devices/beat`) when it starts, every few
 * minutes, when its tunnel changes and when it is shut down, and takes it off
 * the list when it is released (`forget`) — no pass needed,
 * so it keeps working after the page's thirty days. Only the hash of the
 * secret is kept. `POST /devices/forget` drops a row.
 */

const encoder = new TextEncoder();

/** How long a computer that stopped saying anything is still called on. */
export const FRESH_MS = 15 * 60_000;

export async function hashSecret(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`reader-device:${secret}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** Only an https address (a tunnel), or the computer's own 127.0.0.1: nothing a row could point a browser at otherwise. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:' || (url.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(url.hostname))) return url.href;
  } catch {
    // not an address
  }
  return '';
}

/** What a browser of the owner sees of a row: no secret hash. */
export function shown(row, now = Date.now()) {
  const { secretHash, ...rest } = row;
  return { ...rest, online: !row.off && Boolean(row.seen) && now - row.seen < FRESH_MS };
}

export class Devices {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const id = text(body.id, 64);
    const now = Date.now();
    if (url.pathname === '/list') {
      const rows = await this.state.storage.list({ prefix: 'device:' });
      return Response.json({ devices: [...rows.values()].map((row) => shown(row, now)).sort((a, b) => (b.seen || 0) - (a.seen || 0)) });
    }
    if (!/^[0-9a-f]{8,64}$/.test(id)) return Response.json({ error: 'which computer?' }, { status: 400 });
    const key = `device:${id}`;
    if (url.pathname === '/claim') {
      // Again by the same account (a Companion set up anew, or its secret lost) takes the row over.
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const was = (await this.state.storage.get(key)) || {};
      await this.state.storage.put(key, { ...was, id, name: text(body.name, 120) || was.name || 'A computer', hardware: text(body.hardware, 200), version: text(body.version, 20), secretHash: await hashSecret(secret), claimed: now });
      return Response.json({ secret });
    }
    if (url.pathname === '/beat') {
      const row = await this.state.storage.get(key);
      if (!row || row.secretHash !== (await hashSecret(text(body.secret, 200)))) return Response.json({ error: 'not this computer’s' }, { status: 403 });
      // Released from the account (reader-companion release): it comes off the list, with the token it no longer takes.
      if (body.forget) {
        await this.state.storage.delete(key);
        return Response.json({ ok: true, forgotten: true });
      }
      const next = { ...row, seen: now, off: Boolean(body.off), url: safeUrl(body.url), local: safeUrl(body.local), token: text(body.token, 200) };
      for (const field of ['name', 'hardware', 'version', 'root']) if (typeof body[field] === 'string') next[field] = text(body[field], 200);
      await this.state.storage.put(key, next);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/forget') {
      await this.state.storage.delete(key);
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}
