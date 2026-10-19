/**
 * A project's files moved from one place to another, behind the scenes (docs/storage-moves.md): the page asks for
 * the move here, and the machines at each end do the work, so the files never pass through the page and the move
 * doesn't stop when the page does.
 *
 * One `ProjectMove` Durable Object per move holds where it is: what moves where, how far each end has got, the
 * key the machines answer with, the account's Google token while Drive is one end. The archive itself is in R2 (the
 * MOVES bucket), written in parts as the source machine packs it (`PUT /moves/part`, an R2 multipart upload) and
 * read back by the destination as one stream that can pick up where it broke (`GET /moves/archive`, with a Range).
 * A destination that is a computer with the Reader Companion is told to unpack by this Worker itself, through the
 * computer's tunnel, the moment the archive is whole — so a move from Colab to a laptop finishes with no page
 * open at all. The archive is deleted once it is unpacked; anything left is deleted after a week.
 *
 * The routes:
 *
 *   page, with its pass                      machines, with the move's key (X-Move-Key)
 *   POST /moves/start   {id, project, …}     PUT  /moves/part?id&n      one part of the archive
 *   GET  /moves/status?id                    POST /moves/report?id      how far it has got; the manifest at the end
 *   POST /moves/drive-token {id, token}      GET  /moves/manifest?id    every file, its size and SHA-256
 *   POST /moves/cancel {id}                  GET  /moves/archive?id     the archive, from a Range when asked
 *   POST /moves/settled {id}                 GET  /moves/token?id       the account's Google token, for Drive
 */

const DAY = 86_400_000;
/** How long a move is kept for a page or a machine to come back to it. */
export const KEEP_MS = 7 * DAY;
/** The most parts one archive may have: 64 MB each, so 640 GB — far more than a project; a runaway stops here. */
export const MAX_PARTS = 10_000;
/** The most one part may weigh: under what a Worker takes in one request. */
export const MAX_PART_BYTES = 95 * 1024 * 1024;
/** How long a machine at work may say nothing before another may take its step over. */
export const RUNNER_QUIET_MS = 2 * 60_000;
const PLANS = ['archive', 'drive-pull', 'drive-push'];
const KINDS = ['drive', 'server', 'machine'];
const STEPS = ['listing', 'packing', 'packed', 'unpacking', 'unpacked', 'pulling', 'pulled', 'pushing', 'pushed', 'waiting', 'failed', 'removed'];

export const isMoveId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const archiveKey = (id) => `moves/${id}/archive.tar.gz`;
const manifestKey = (id) => `moves/${id}/manifest.json`;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('');

function sameSecret(given, expected) {
  const a = new TextEncoder().encode(String(given || ''));
  const b = new TextEncoder().encode(String(expected || ''));
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) differ |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return differ === 0;
}

/** One end of a move, as the page describes it: kept to what the Worker needs and the page shows. */
export function cleanEnd(raw) {
  if (!raw || !KINDS.includes(raw.kind)) return null;
  return {
    kind: raw.kind,
    label: text(raw.label, 120) || raw.kind,
    ...(raw.deviceId && /^[0-9a-f]{8,64}$/.test(raw.deviceId) ? { deviceId: raw.deviceId } : {}),
    ...(typeof raw.root === 'string' ? { root: text(raw.root, 500) } : {}),
    ...(typeof raw.folder === 'string' ? { folder: text(raw.folder, 200) } : {}),
  };
}

/** What the page and the Usage pages see of a move: never the key, never the token. */
export function shown(meta) {
  const { key: _k, token: _t, uploadId: _u, parts: _p, ...rest } = meta;
  return { ...rest, partsIn: Object.keys(meta.parts || {}).length };
}

export class ProjectMove {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
  }

  async meta() {
    return (await this.state.storage.get('meta')) ?? null;
  }

  async save(meta) {
    meta.updated = Date.now();
    await this.state.storage.put('meta', meta);
    return meta;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const meta = await this.meta();
    const now = Date.now();

    if (url.pathname === '/start') {
      if (meta) return Response.json({ ok: true, existing: true, key: meta.email === body.email ? meta.key : undefined, move: shown(meta) });
      const from = cleanEnd(body.from);
      const to = cleanEnd(body.to);
      if (!from || !to || !PLANS.includes(body.plan)) return Response.json({ error: 'from, to and a plan' }, { status: 400 });
      const made = {
        id: body.id,
        email: text(body.email, 200) || 'owner',
        project: text(body.project, 80),
        title: text(body.title, 200),
        from,
        to,
        plan: body.plan,
        api: text(body.api, 300),
        origin: text(body.origin, 200),
        key: newKey(),
        token: text(body.token, 4000),
        removeOld: body.removeOld === true,
        uploadId: text(body.uploadId, 400),
        parts: {},
        status: 'started',
        step: 'started',
        progress: { files: 0, bytes: 0, totalFiles: 0, totalBytes: 0 },
        created: now,
        updated: now,
      };
      await this.save(made);
      await this.state.storage.setAlarm(now + KEEP_MS);
      return Response.json({ ok: true, key: made.key, move: shown(made) });
    }
    if (!meta) return Response.json({ error: 'no such move — it ended more than a week ago, or never started' }, { status: 404 });

    // The page's calls carry the account; the machines', the key.
    if (url.searchParams.has('email')) {
      if (url.searchParams.get('email').toLowerCase() !== meta.email.toLowerCase()) return Response.json({ error: 'not your move' }, { status: 403 });
    } else if (!sameSecret(url.searchParams.get('key'), meta.key)) {
      return Response.json({ error: 'not this move’s key' }, { status: 403 });
    }
    const over = ['cancelled', 'failed'].includes(meta.status);

    switch (url.pathname) {
      case '/status':
        return Response.json({ move: shown(meta) });
      case '/inner':
        // The route's own look at what it needs to talk to R2 and the machines: never sent to a page.
        return Response.json({ meta });
      case '/drive-token':
        meta.token = text(body.token, 4000);
        await this.save(meta);
        return Response.json({ ok: true });
      case '/token':
        return Response.json({ token: over ? '' : meta.token });
      case '/cancel':
        if (meta.status !== 'done') {
          meta.status = 'cancelled';
          meta.token = '';
          await this.save(meta);
        }
        return Response.json({ ok: true, move: shown(meta) });
      case '/settled':
        meta.settled = now;
        meta.token = '';
        await this.save(meta);
        return Response.json({ ok: true, move: shown(meta) });
      case '/part': {
        if (over) return Response.json({ error: 'the move was cancelled', cancelled: true }, { status: 409 });
        const n = finite(body.n);
        meta.parts = { ...meta.parts, [n]: { etag: text(body.etag, 200), size: finite(body.size) } };
        if (meta.status === 'started') meta.status = 'packing';
        await this.save(meta);
        return Response.json({ ok: true });
      }
      case '/report': {
        if (over) return Response.json({ ok: true, cancelled: true });
        const step = STEPS.includes(body.step) ? body.step : null;
        if (!step) return Response.json({ error: 'which step?' }, { status: 400 });
        // One machine at a time: a second one started for the same step (the Worker and a page both told it to
        // unpack) is told to stop, unless the first has gone quiet.
        const runner = text(body.runner, 64);
        const between = ['started', 'packed', 'done'].includes(meta.status);
        if (runner && meta.runner && meta.runner !== runner && !between && now - meta.updated < RUNNER_QUIET_MS) return Response.json({ ok: true, cancelled: true, duplicate: true });
        if (runner) meta.runner = runner;
        meta.step = step;
        meta.progress = { files: finite(body.files), bytes: finite(body.bytes), totalFiles: finite(body.totalFiles), totalBytes: finite(body.totalBytes) };
        if (step === 'waiting') meta.waiting = text(body.waiting, 40) || 'google';
        else delete meta.waiting;
        if (step === 'failed') {
          meta.status = 'failed';
          meta.error = text(body.error, 600) || 'A machine stopped with an error.';
          meta.token = '';
        } else if (step === 'packed') {
          meta.status = 'packed';
          meta.archiveBytes = finite(body.archiveBytes);
          meta.manifestFiles = finite(body.manifestFiles);
        } else if (step === 'unpacked' || step === 'pulled' || step === 'pushed') {
          meta.status = 'done';
          meta.verified = finite(body.verified);
          meta.done = now;
          meta.token = '';
          // What met an older copy there (mover.py, Arrival): kept beside, kept, and gone.
          meta.met = {
            conflicts: finite(body.conflicts),
            conflictPaths: (Array.isArray(body.conflictPaths) ? body.conflictPaths : []).slice(0, 50).map((path) => text(path, 300)),
            kept: finite(body.kept),
            keptPaths: (Array.isArray(body.keptPaths) ? body.keptPaths : []).slice(0, 50).map((path) => text(path, 300)),
            stale: finite(body.stale),
          };
          // The old copy, when it was to go: removed by the Worker (Drive, a Companion), or left for the page.
          if (meta.removeOld) meta.oldCopy = ['removed', 'pending', 'failed'].includes(body.oldCopy) ? body.oldCopy : 'pending';
          if (body.oldCopyError) meta.oldCopyError = text(body.oldCopyError, 300);
        } else if (step === 'removed') {
          meta.removed = now;
        } else if (step !== 'waiting') {
          meta.status = step;
        }
        await this.save(meta);
        return Response.json({ ok: true, move: shown(meta) });
      }
      default:
        return Response.json({ error: 'not found' }, { status: 404 });
    }
  }

  /** A week on: whatever is left of the move goes, in R2 and here. */
  async alarm() {
    const meta = await this.meta();
    if (meta && this.env.MOVES) {
      await this.env.MOVES.delete([archiveKey(meta.id), manifestKey(meta.id)]).catch(() => undefined);
      if (meta.uploadId && meta.status !== 'packed' && meta.status !== 'done') {
        await this.env.MOVES.resumeMultipartUpload(archiveKey(meta.id), meta.uploadId).abort().catch(() => undefined);
      }
    }
    await this.state.storage.deleteAll();
  }
}

/** Whether a path is one of the moves' routes. */
export const isMovesPath = (path) => path.startsWith('/moves/');
/** The routes the machines call: no Origin, no pass — the key. */
const MACHINE_ROUTES = ['/moves/part', '/moves/report', '/moves/manifest', '/moves/archive', '/moves/token'];

/**
 * The moves' routes. `helpers` are the Worker's own: who is asking (`authorized`), the JSON reply, the CORS
 * headers, the app's origins, and the refusal for no pass.
 */
export async function handleMoves(request, env, ctx, path, helpers) {
  const { authorized, json, headers, allowedOrigins, needsToken } = helpers;
  const url = new URL(request.url);
  if (!env.MOVES || !env.PROJECT_MOVES) return json({ error: 'moves need an R2 bucket (MOVES) and the PROJECT_MOVES object — see docs/storage-moves.md', setup: true }, 501, headers);
  const object = (id) => env.PROJECT_MOVES.get(env.PROJECT_MOVES.idFromName(`move:${id}`));
  const noStore = { ...headers, 'Cache-Control': 'no-store' };

  // ---------------------------------------------------------------- the machines --
  if (MACHINE_ROUTES.includes(path)) {
    const id = url.searchParams.get('id');
    const key = request.headers.get('X-Move-Key') || '';
    if (!isMoveId(id) || !key) return json({ error: 'which move, with its key?' }, 400, headers);
    const asMachine = (route, init) => object(id).fetch(`https://move${route}?key=${encodeURIComponent(key)}`, init);
    const inner = await asMachine('/inner');
    if (!inner.ok) return json(await inner.json(), inner.status, noStore);
    const { meta } = await inner.json();
    const over = ['cancelled', 'failed'].includes(meta.status);

    if (path === '/moves/part') {
      if (request.method !== 'PUT') return json({ error: 'PUT' }, 405, headers);
      if (over) return json({ error: 'the move was cancelled', cancelled: true }, 409, headers);
      const n = Number(url.searchParams.get('n'));
      if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return json({ error: 'which part?' }, 400, headers);
      const size = Number(request.headers.get('Content-Length') || 0);
      if (!size && n > 1) return json({ error: 'an empty part' }, 400, headers);
      if (size > MAX_PART_BYTES) return json({ error: 'that part is too large' }, 413, headers);
      const upload = env.MOVES.resumeMultipartUpload(archiveKey(id), meta.uploadId);
      const part = await upload.uploadPart(n, request.body);
      const answer = await asMachine('/part', { method: 'POST', body: JSON.stringify({ n, etag: part.etag, size }) });
      return json(await answer.json(), answer.status, noStore);
    }
    if (path === '/moves/report') {
      if (request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
      const report = await request.json().catch(() => ({}));
      // The manifest goes to R2, beside the archive; the object keeps its count.
      if (Array.isArray(report.manifest)) {
        await env.MOVES.put(manifestKey(id), JSON.stringify({ files: report.manifest }), { httpMetadata: { contentType: 'application/json' } });
        report.manifestFiles = report.manifest.length;
        delete report.manifest;
      }
      if (report.step === 'packed') {
        const parts = Object.entries(meta.parts || {}).map(([n, part]) => ({ partNumber: Number(n), etag: part.etag })).sort((a, b) => a.partNumber - b.partNumber);
        try {
          await env.MOVES.resumeMultipartUpload(archiveKey(id), meta.uploadId).complete(parts);
        } catch (error) {
          report.step = 'failed';
          report.error = `The archive couldn't be put together in R2: ${String(error?.message || error)}`;
        }
      }
      // Every file in and checked: the old copy goes now, when it was asked to and the Worker can reach it.
      if (['unpacked', 'pulled', 'pushed'].includes(report.step) && meta.removeOld && !['cancelled', 'failed', 'done'].includes(meta.status)) {
        const removal = await removeSource(env, meta, request);
        report.oldCopy = removal.state;
        if (removal.error) report.oldCopyError = removal.error;
      }
      const answer = await asMachine('/report', { method: 'POST', body: JSON.stringify(report) });
      const reply = await answer.json();
      if (report.step === 'packed' && answer.ok) {
        // The destination, told to unpack by this Worker when it is a computer with the Companion: no page needed.
        const told = tellDestination(env, meta, request);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(told);
      }
      if (report.step === 'unpacked') {
        const gone = env.MOVES.delete(archiveKey(id)).catch(() => undefined);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(gone);
      }
      return json(reply, answer.status, noStore);
    }
    if (path === '/moves/manifest') {
      const kept = await env.MOVES.get(manifestKey(id));
      if (!kept) return json({ error: 'no manifest yet' }, 404, noStore);
      return new Response(kept.body, { status: 200, headers: { ...noStore, 'Content-Type': 'application/json' } });
    }
    if (path === '/moves/archive') {
      if (over) return json({ error: 'the move was cancelled', cancelled: true }, 409, headers);
      const range = /^bytes=(\d+)-$/.exec(request.headers.get('Range') || '');
      const kept = await env.MOVES.get(archiveKey(id), range ? { range: { offset: Number(range[1]) } } : {});
      if (!kept) return json({ error: 'the archive isn’t in yet' }, 404, noStore);
      return new Response(kept.body, { status: range ? 206 : 200, headers: { ...noStore, 'Content-Type': 'application/gzip', ...(kept.size ? { 'X-Archive-Bytes': String(kept.size) } : {}) } });
    }
    if (path === '/moves/token') {
      const answer = await asMachine('/token');
      return json(await answer.json(), answer.status, noStore);
    }
  }

  // -------------------------------------------------------------------- the page --
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins.includes(origin)) return json({ error: 'not from this app' }, 403, headers);
  const who = await authorized(request, env);
  if (!who) return needsToken(env, headers);
  const email = who.email || 'owner';
  const asPage = (id, route, init) => object(id).fetch(`https://move${route}?email=${encodeURIComponent(email)}`, init);

  if (path === '/moves/status') {
    const id = url.searchParams.get('id');
    if (!isMoveId(id)) return json({ error: 'which move?' }, 400, headers);
    const answer = await asPage(id, '/status');
    return json(await answer.json(), answer.status, noStore);
  }
  if (request.method !== 'POST') return json({ error: 'POST' }, 405, headers);
  const body = await request.json().catch(() => ({}));
  if (!isMoveId(body.id)) return json({ error: 'which move?' }, 400, headers);

  if (path === '/moves/start') {
    if (!PLANS.includes(body.plan)) return json({ error: 'archive, drive-pull or drive-push' }, 400, headers);
    // The archive's upload is opened now, so each part has somewhere to go as it comes.
    const uploadId = body.plan === 'archive' ? (await env.MOVES.createMultipartUpload(archiveKey(body.id), { httpMetadata: { contentType: 'application/gzip' } })).uploadId : '';
    const api = `${url.origin}${url.pathname.startsWith('/api/') ? '/api' : ''}`;
    const answer = await object(body.id).fetch('https://move/start', { method: 'POST', body: JSON.stringify({ ...body, email, uploadId, api, origin }) });
    const reply = await answer.json();
    if (reply.existing && uploadId) await env.MOVES.resumeMultipartUpload(archiveKey(body.id), uploadId).abort().catch(() => undefined);
    return json({ ...reply, api }, answer.status, noStore);
  }
  if (path === '/moves/drive-token' || path === '/moves/cancel' || path === '/moves/settled') {
    const route = path.slice('/moves'.length);
    const answer = await asPage(body.id, route, { method: 'POST', body: JSON.stringify(body) });
    const reply = await answer.json();
    if (path === '/moves/cancel' && answer.ok) {
      const inner = await (await object(body.id).fetch(`https://move/inner?email=${encodeURIComponent(email)}`)).json();
      if (inner.meta?.uploadId) await env.MOVES.resumeMultipartUpload(archiveKey(body.id), inner.meta.uploadId).abort().catch(() => undefined);
      await env.MOVES.delete([archiveKey(body.id), manifestKey(body.id)]).catch(() => undefined);
    }
    return json(reply, answer.status, noStore);
  }
  return json({ error: 'not found' }, 404, headers);
}

/**
 * The destination told to unpack, when it is a computer with the Reader Companion: its address and token from the
 * account's list of computers (worker/devices.js), and the Companion's `companion/move` (MOVER_VERSION and later).
 * A computer that is off, or an older Companion, is left for the page, which starts the unpack when it is next open.
 */
/** A computer of the account's, by its Companion's id: its tunnel and token from the account's list (worker/devices.js), or null when it is off or unknown. */
/** The Companion whose mover weighs an arrival over an older copy three ways (src/lib/moves.ts, MOVER_VERSION). */
export const MOVER_VERSION = '0.16.0';
/** Whether version a is at least b, for dotted numbers. */
export function atLeast(a, b) {
  const x = String(a || '0').split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
}

async function companionOf(env, email, deviceId) {
  if (!deviceId || !env.DEVICES) return null;
  const list = await (await env.DEVICES.get(env.DEVICES.idFromName(`devices:${email.toLowerCase()}`)).fetch('https://devices/list', { method: 'POST', body: '{}' })).json();
  const device = (list.devices || []).find((d) => d.id === deviceId);
  return device?.url && device.token && !device.off ? device : null;
}

/** A call on a computer's Companion through its tunnel, as the site: its token and the site's origin. */
const callCompanion = (device, meta, request, body, fetchImpl) =>
  fetchImpl(`${device.url.replace(/\/?$/, '/')}companion/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${device.token}`, Origin: meta.origin || request.headers.get('Origin') || '' },
    body: JSON.stringify(body),
  });

/**
 * The destination told to unpack, when it is a computer with the Reader Companion: its address and token from the
 * account's list of computers (worker/devices.js), and the Companion's `companion/move` (MOVER_VERSION and later).
 * A computer that is off, or an older Companion, is left for the page, which starts the unpack when it is next open.
 */
export async function tellDestination(env, meta, request, fetchImpl = (...args) => fetch(...args)) {
  try {
    const device = await companionOf(env, meta.email, meta.to?.deviceId);
    // An older Companion's mover would write over an old copy there: the page offers it the update instead.
    if (!device || !atLeast(device.version, MOVER_VERSION)) return false;
    const answer = await callCompanion(device, meta, request, { mode: 'unpack', api: meta.api, id: meta.id, key: meta.key, root: meta.to.root || '' }, fetchImpl);
    return answer.ok;
  } catch {
    return false;
  }
}

/**
 * The old copy removed, once every file is in and checked at the new place, when the move was started with "delete
 * the old copy": Drive's folder sent to the bin with the account's token (Drive keeps it 30 days); a computer's
 * folder deleted by its Companion (a linked folder only unlinked). Colab's disk, or a computer that is off, is left
 * for the page: 'pending'. Never when the two ends are one folder.
 */
export async function removeSource(env, meta, request, fetchImpl = (...args) => fetch(...args)) {
  const from = meta.from || {};
  const to = meta.to || {};
  if (from.kind === to.kind && (from.kind === 'drive' ? from.folder === to.folder : from.deviceId === to.deviceId && (from.root || '') === (to.root || ''))) return { state: 'failed', error: 'the old place and the new one are the same folder' };
  try {
    if (from.kind === 'drive') {
      if (!from.folder || !meta.token) return { state: 'pending' };
      const answer = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(from.folder)}?fields=id`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${meta.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      return answer.ok ? { state: 'removed' } : { state: 'pending', error: `Drive answered ${answer.status}` };
    }
    if (!from.root) return { state: 'pending' };
    const device = await companionOf(env, meta.email, from.deviceId);
    if (!device) return { state: 'pending' };
    const answer = await callCompanion(device, meta, request, { mode: 'remove', root: from.root }, fetchImpl);
    return answer.ok ? { state: 'removed' } : { state: 'pending', error: `the Companion answered ${answer.status}` };
  } catch (error) {
    return { state: 'pending', error: String(error?.message || error).slice(0, 200) };
  }
}
