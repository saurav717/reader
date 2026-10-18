/**
 * The kernels and runs a Google account has going: one Durable Object per
 * email, a row per kernel scope (a project's, or a pool member's — see
 * src/lib/playground.ts, memberScope).
 *
 * A browser that runs a project keeps, in the row: which machine the project
 * is on (the runtime's endpoint), the kernel on it for each scope and for
 * the machine watch, and what is running there — each run's key, when it
 * started, the kernel and the request it is, and where its output is logged
 * on the machine. Another browser signed in as the same account reads the
 * row when it opens the project (`GET /kernels`), joins the same kernel
 * instead of starting a second Python, and follows the runs that are still
 * going (src/lib/continuity.ts). Rows carry no tokens and no output: the
 * machine itself is reached as always, by asking Colab for the project's
 * runtime, or the server by its address.
 *
 * `POST /kernels/put` writes a row (the newest `updatedAt` wins, so two
 * browsers writing at once do not take turns undoing each other); `POST
 * /kernels/drop` removes one; `/erase` empties the object when the account
 * is deleted (worker/account.js). Everything takes the account's pass.
 */

/** The most rows an account keeps; the oldest go first. */
export const MAX_SCOPES = 200;
/** The most runs a row keeps. */
export const MAX_RUNS = 30;
/** A row untouched this long is dropped: no runtime lives that long. */
export const STALE_MS = 2 * 86_400_000;
/** The most a row may weigh, as JSON. */
export const MAX_BYTES = 24_000;

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A row as the page sent it, cut to what is kept: strings bounded, runs bounded, nothing else. */
export function cleanRecord(body, now = Date.now()) {
  const scope = text(body?.scope, 120);
  if (!/^[A-Za-z0-9_#:.-]{1,120}$/.test(scope)) return null;
  const endpoint = text(body?.endpoint, 400);
  if (!endpoint) return null;
  const kernels = {};
  for (const [key, id] of Object.entries(body?.kernels ?? {})) {
    if (Object.keys(kernels).length >= 8) break;
    const k = text(key, 120);
    const v = text(id, 120);
    if (k && v) kernels[k] = v;
  }
  const runs = {};
  const given = Object.entries(body?.runs ?? {})
    .map(([key, run]) => [text(key, 200), run])
    .filter(([key, run]) => key && run && typeof run === 'object')
    .sort((a, b) => (finite(b[1].startedAt) ?? 0) - (finite(a[1].startedAt) ?? 0))
    .slice(0, MAX_RUNS);
  for (const [key, run] of given) {
    const startedAt = finite(run.startedAt);
    if (!startedAt) continue;
    runs[key] = {
      startedAt,
      state: run.state === 'running' ? 'running' : 'done',
      msgId: text(run.msgId, 120),
      kernelId: text(run.kernelId, 120),
      where: text(run.where, 120),
      ...(text(run.log, 400) ? { log: text(run.log, 400) } : {}),
      ...(finite(run.ms) !== undefined ? { ms: finite(run.ms) } : {}),
      ...(text(run.outcome, 20) ? { outcome: text(run.outcome, 20) } : {}),
    };
  }
  const record = { scope, endpoint, kernels, runs, updatedAt: finite(body?.updatedAt) ?? now, by: text(body?.by, 80) };
  if (JSON.stringify(record).length > MAX_BYTES) {
    // Too heavy: the runs go first, newest kept, until it fits.
    const keys = Object.keys(record.runs);
    while (keys.length && JSON.stringify(record).length > MAX_BYTES) delete record.runs[keys.pop()];
  }
  return record;
}

export class Kernels {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const now = Date.now();
    if (url.pathname === '/list') {
      const rows = await this.state.storage.list({ prefix: 'scope:' });
      const fresh = [];
      for (const [key, row] of rows) {
        if (now - (row.updatedAt ?? 0) > STALE_MS) await this.state.storage.delete(key);
        else fresh.push(row);
      }
      return Response.json({ kernels: fresh.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) });
    }
    if (url.pathname === '/erase') {
      const rows = await this.state.storage.list({ prefix: 'scope:' });
      await this.state.storage.deleteAll();
      return Response.json({ ok: true, scopes: rows.size });
    }
    if (url.pathname === '/put') {
      const record = cleanRecord(body, now);
      if (!record) return Response.json({ error: 'which scope, on which machine?' }, { status: 400 });
      const key = `scope:${record.scope}`;
      const was = await this.state.storage.get(key);
      // The newest word wins: a slower browser's older row does not undo a newer one.
      if (was && (was.updatedAt ?? 0) > record.updatedAt) return Response.json({ ok: true, kept: was });
      await this.state.storage.put(key, record);
      // Bounded: the rows least recently touched go when there are too many.
      const rows = await this.state.storage.list({ prefix: 'scope:' });
      if (rows.size > MAX_SCOPES) {
        const oldest = [...rows.entries()].sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0)).slice(0, rows.size - MAX_SCOPES);
        for (const [k] of oldest) await this.state.storage.delete(k);
      }
      return Response.json({ ok: true, kept: record });
    }
    if (url.pathname === '/drop') {
      const scope = text(body.scope, 120);
      if (!scope) return Response.json({ error: 'which scope?' }, { status: 400 });
      await this.state.storage.delete(`scope:${scope}`);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
