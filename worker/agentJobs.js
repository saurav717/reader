/**
 * A model's answer written on the Worker rather than in the page, so that a
 * page that loses its connection, is closed, or is signed out of halfway
 * through does not lose it: the playground's agent writing a project
 * (src/lib/projectAgent.ts) is the long one, minutes of streaming.
 *
 * One Durable Object per job. `POST /start` takes the request the page would
 * have sent the provider (checked as the relay checks it: server/aiRelay.js,
 * server/geminiRelay.js) and sets an alarm; the alarm asks the provider and
 * keeps what it streams back, exactly as it came, in the object's storage as
 * it arrives. `GET /read?from=` hands the page what is there past `from`,
 * waiting a little for more while the answer is still coming, so the page
 * feeds it to the same parser it would have fed the provider's own stream —
 * and a page that comes back, in this browser or after a reload, reads on
 * from where it was. `POST /stop` ends it. A day after it ends the object
 * empties itself.
 *
 * The key: the site's own (ANTHROPIC_KEY, DEEPSEEK_KEY, GEMINI_KEY), read
 * from the environment when the alarm runs, on the same terms as the relay;
 * or the person's own, sent with the start, kept only until the provider has
 * answered and deleted then. Answers on the site's key go on the tally from
 * here; the page reports its own key's, as it always has.
 *
 * Whether the site offers this at all is the owner's switch, on Usage → The
 * site (`/site/agent-jobs`); with it off the page streams from the provider
 * itself, as before.
 */

import { aiKey, relayAi, relayedUsage } from '../server/aiRelay.js';
import { relayGemini, tokensOf as geminiTokens } from '../server/geminiRelay.js';
import { aiCounts } from './usage.js';

/** How long a finished job is kept for a page to come back to it. */
export const KEEP_MS = 24 * 3600_000;
/** The most an answer's stream may weigh, as it came; past it the job stops. */
export const MAX_CHARS = 24_000_000;
/** The most one read hands back. */
export const READ_CHARS = 512_000;
/** How long a read waits for more before it answers with nothing new. */
export const WAIT_MS = 20_000;
/** What is kept in one storage entry, and how often it is written while the answer comes. */
const CHUNK_CHARS = 64_000;
const FLUSH_MS = 1000;

export const PROVIDERS = ['anthropic', 'deepseek', 'gemini'];
export const isJobId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const chunkKey = (n) => `c:${String(n).padStart(6, '0')}`;

/** What a read says about a job, beside its text. */
const summary = (meta) => ({
  state: meta.status,
  done: meta.status === 'done',
  status: meta.httpStatus ?? null,
  ...(meta.error ? { error: meta.error } : {}),
  ...(meta.stopped ? { stopped: true } : {}),
  ...(meta.interrupted ? { interrupted: true } : {}),
});

export class AgentJob {
  constructor(state, env, { fetchImpl } = {}) {
    this.state = state;
    this.env = env || {};
    this.fetchImpl = fetchImpl;
    /** The stream so far, in memory while this object lives; read back from storage otherwise. */
    this.text = null;
    this.waiters = new Set();
    this.controller = null;
  }

  async loadText() {
    if (this.text !== null) return this.text;
    const chunks = await this.state.storage.list({ prefix: 'c:' });
    this.text = [...chunks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => value).join('');
    return this.text;
  }

  wake() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const meta = await this.state.storage.get('meta');
    if (url.pathname === '/start') {
      const body = await request.json().catch(() => null);
      // The same job started twice (a retried request): the one there stands.
      if (meta) return Response.json({ ok: true, existing: true, ...summary(meta) });
      if (!body?.id || !PROVIDERS.includes(body.provider) || !body.request) return Response.json({ error: 'a job id, a provider and its request' }, { status: 400 });
      const now = Date.now();
      await this.state.storage.put('request', { provider: body.provider, request: body.request });
      if (body.key) await this.state.storage.put('key', String(body.key));
      await this.state.storage.put('meta', { id: body.id, email: String(body.email || 'owner'), provider: body.provider, site: !body.key, status: 'queued', started: now, updated: now, length: 0, chunks: 0 });
      await this.state.storage.setAlarm(now);
      return Response.json({ ok: true, state: 'queued', done: false });
    }
    if (!meta) return Response.json({ error: 'no such job — it ended more than a day ago, or never started' }, { status: 404 });
    // Only whoever started it reads or stops it.
    const asker = url.searchParams.get('email') || 'owner';
    if (asker.toLowerCase() !== meta.email.toLowerCase()) return Response.json({ error: 'not your job' }, { status: 403 });
    if (url.pathname === '/read') {
      const from = Math.max(0, Math.floor(Number(url.searchParams.get('from')) || 0));
      let text = await this.loadText();
      let now = (await this.state.storage.get('meta')) ?? meta;
      if (from >= text.length && now.status !== 'done') {
        const wait = Math.max(0, Math.min(WAIT_MS, Number(url.searchParams.get('wait') ?? WAIT_MS)));
        if (wait) {
          await new Promise((resolve) => {
            const timer = setTimeout(done, wait);
            function done() {
              clearTimeout(timer);
              resolve();
            }
            this.waiters.add(done);
          });
          text = await this.loadText();
          now = (await this.state.storage.get('meta')) ?? now;
        }
      }
      const data = text.slice(from, from + READ_CHARS);
      const offset = from + data.length;
      // Done only once the whole of it has been read.
      return Response.json({ data, offset, ...summary(now), done: now.status === 'done' && offset >= text.length });
    }
    if (url.pathname === '/stop') {
      if (meta.status === 'done') return Response.json({ ok: true, ...summary(meta) });
      const stopped = { ...meta, stopped: true, updated: Date.now() };
      if (meta.status === 'queued') {
        Object.assign(stopped, { status: 'done', httpStatus: 499, error: 'Stopped.' });
        await this.state.storage.delete('key');
        await this.state.storage.setAlarm(Date.now() + KEEP_MS);
      }
      await this.state.storage.put('meta', stopped);
      this.controller?.abort();
      this.wake();
      return Response.json({ ok: true, ...summary(stopped) });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  async alarm() {
    const meta = await this.state.storage.get('meta');
    if (!meta) return;
    if (meta.status === 'done') {
      if (Date.now() >= meta.started + KEEP_MS || Date.now() >= (meta.updated ?? 0) + KEEP_MS) await this.state.storage.deleteAll();
      else await this.state.storage.setAlarm((meta.updated ?? Date.now()) + KEEP_MS);
      return;
    }
    if (meta.status === 'running') {
      // An alarm that ran before and was cut off — the object restarted, or ran past the platform's limit on one
      // alarm. A provider's stream can't be picked up halfway, so what came is what there is.
      await this.finish({ ...meta, interrupted: true, error: 'The server stopped writing this answer partway (it ran too long, or restarted). What it had written is kept; ask again to finish it.' });
      return;
    }
    await this.run(meta);
  }

  async finish(meta) {
    const done = { ...meta, status: 'done', updated: Date.now() };
    await this.state.storage.delete('key');
    await this.state.storage.put('meta', done);
    await this.state.storage.setAlarm(done.updated + KEEP_MS);
    this.controller = null;
    this.wake();
    return done;
  }

  async run(queued) {
    let meta = { ...queued, status: 'running', updated: Date.now() };
    await this.state.storage.put('meta', meta);
    const asked = await this.state.storage.get('request');
    const key = meta.site ? aiKey(this.env, meta.provider) : await this.state.storage.get('key');
    if (!asked || !key) return this.finish({ ...meta, httpStatus: 500, error: meta.site ? 'The site has no key for this model any more.' : 'The key for this job is gone.' });
    this.controller = new AbortController();
    const options = { signal: this.controller.signal, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) };
    let text = await this.loadText();
    let pending = '';
    let lastFlush = Date.now();
    const flush = async () => {
      if (!pending) return;
      await this.state.storage.put(chunkKey(meta.chunks), pending);
      meta = { ...meta, chunks: meta.chunks + 1, length: text.length, updated: Date.now() };
      await this.state.storage.put('meta', meta);
      pending = '';
      lastFlush = Date.now();
    };
    let relayed = null;
    try {
      relayed = meta.provider === 'gemini' ? await relayGemini(asked.request, key, options) : await relayAi(meta.provider, asked.request, key, options);
      // The provider has it: the person's own key is needed no longer.
      await this.state.storage.delete('key');
      meta = { ...meta, httpStatus: relayed.response.status };
      await this.state.storage.put('meta', meta);
      const reader = relayed.response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        const piece = done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (piece) {
          text += piece;
          pending += piece;
          this.text = text;
          this.wake();
        }
        if (done) break;
        if (text.length > MAX_CHARS) {
          this.controller.abort();
          meta = { ...meta, error: 'The answer grew past what the server keeps for one job.' };
          break;
        }
        if (pending.length >= CHUNK_CHARS || Date.now() - lastFlush >= FLUSH_MS) await flush();
      }
      await flush();
    } catch (error) {
      await flush().catch(() => undefined);
      const latest = (await this.state.storage.get('meta')) ?? meta;
      if (latest.stopped) meta = { ...meta, stopped: true, error: 'Stopped.' };
      else meta = { ...meta, httpStatus: meta.httpStatus ?? 502, error: `The server lost the answer: ${String(error?.message || error)}` };
    }
    const latest = (await this.state.storage.get('meta')) ?? meta;
    if (latest.stopped) meta = { ...meta, stopped: true, error: meta.error || 'Stopped.' };
    // The site's key: what it took, on the tally of whoever asked.
    if (meta.site && relayed && this.env.USAGE) {
      const used = await relayed.usage.catch(() => null);
      const counts = used ? aiCounts(meta.provider === 'gemini' ? { provider: 'gemini', model: asked.request.model, ...geminiTokens(used) } : relayedUsage(meta.provider, asked.request, used)) : null;
      if (counts) {
        await this.env.USAGE.get(this.env.USAGE.idFromName('usage'))
          .fetch('https://usage/record', { method: 'POST', body: JSON.stringify({ email: meta.email, counts, at: Date.now() }) })
          .catch(() => undefined);
      }
    }
    return this.finish(meta);
  }
}

/** The site's switch: on unless the owner has turned it off. */
export async function jobsEnabled(env) {
  if (!env.AGENT_JOBS) return false;
  const kept = env.SESSIONS ? await env.SESSIONS.get('site:agentJobs').catch(() => null) : null;
  return kept !== 'off';
}
