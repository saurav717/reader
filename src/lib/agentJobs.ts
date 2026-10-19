// ===========================================================================
//  A model's answer written on the proxy rather than here (worker/agentJobs.js),
//  so a page that loses its connection, is reloaded or is closed halfway
//  through doesn't lose it: the agent writing a project is minutes of
//  streaming, and a dropped Wi-Fi used to end it.
//
//  `jobFetch` stands in for `fetch` under the provider's own client (the
//  Anthropic SDK, DeepSeekStream, GeminiStream): the request it would have
//  sent the provider starts a job instead, and the answer it hands back is
//  the provider's own stream, read from the job a piece at a time — so the
//  client parses it exactly as it would have. Lost connections in between
//  are waited out, the read picking up from where it was; only Stop ends the
//  job. Whether the site offers this at all is its owner's switch, on Usage →
//  The site (/site/agent-jobs).
// ===========================================================================

import { apiFetch, hasProxy, hasProxyToken } from './api';
import { ownerFetch } from './owner';

export type JobProvider = 'anthropic' | 'deepseek' | 'gemini';

export const newJobId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The site's switch as the proxy last told it, for a minute. */
let known: { at: number; enabled: boolean; available: boolean; stored: boolean } | null = null;

export async function serverJobs(fresh = false): Promise<{ enabled: boolean; available: boolean; stored: boolean }> {
  if (!hasProxy()) return { enabled: false, available: false, stored: false };
  if (!fresh && known && Date.now() - known.at < 60_000) return known;
  try {
    const response = await apiFetch('/site/agent-jobs', fresh ? { cache: 'no-store' } : {});
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { enabled?: boolean; available?: boolean; stored?: boolean };
    known = { at: Date.now(), enabled: Boolean(body.enabled), available: Boolean(body.available), stored: Boolean(body.stored) };
  } catch {
    // Offline, or an older proxy without the route: answered here, as before.
    known = { at: Date.now(), enabled: false, available: false, stored: false };
  }
  return known;
}

/** Whether an answer may be written on the proxy now: the switch on, and someone signed in to it. */
export async function useServerJobs(): Promise<boolean> {
  return hasProxyToken() && (await serverJobs()).enabled;
}

/** The owner's choice, kept on the Worker for every visitor. */
export async function setServerJobs(enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await ownerFetch('/site/agent-jobs', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  const body = (await response.json().catch(() => ({}))) as { error?: string; enabled?: boolean; available?: boolean; stored?: boolean };
  if (!response.ok) return { ok: false, error: body.error || `The proxy answered ${response.status}.` };
  known = { at: Date.now(), enabled: Boolean(body.enabled), available: Boolean(body.available), stored: Boolean(body.stored) };
  return { ok: true };
}

const abortError = () => new DOMException('The request was aborted.', 'AbortError');

/** A pause before trying again, cut short when the browser says it is back online, and ended by an abort. */
function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  const page = typeof window === 'undefined' ? null : window;
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      page?.removeEventListener('online', done);
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      clearTimeout(timer);
      page?.removeEventListener('online', done);
      reject(abortError());
    };
    const timer = setTimeout(done, ms);
    page?.addEventListener('online', done);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** A call to the proxy, tried again — for as long as it takes — while the network is down or the proxy hiccups. */
async function patiently<T>(signal: AbortSignal | null | undefined, onLink: ((online: boolean) => void) | undefined, call: () => Promise<{ response: Response; body: T }>): Promise<{ response: Response; body: T }> {
  for (let tries = 0; ; tries++) {
    if (signal?.aborted) throw abortError();
    try {
      const answer = await call();
      // The proxy itself, or Cloudflare in front of it, between deploys or overloaded: as good as offline.
      if (answer.response.status >= 502 && answer.response.status <= 504) throw new Error(String(answer.response.status));
      onLink?.(true);
      return answer;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      onLink?.(false);
      await pause(Math.min(15_000, 1000 * 2 ** Math.min(tries, 4)), signal);
    }
  }
}

interface ReadAnswer {
  data?: string;
  offset?: number;
  done?: boolean;
  status?: number | null;
  error?: string;
  stopped?: boolean;
  interrupted?: boolean;
}

/** A refusal handed on as the provider's client expects one, and not one it should try again. */
const refusal = (status: number, text: string) => new Response(text, { status, headers: { 'Content-Type': 'application/json', 'x-should-retry': 'false' } });

/**
 * `fetch`, for one answer, through a job on the proxy. Used once: the request
 * it is given starts job `id` (or joins it, when the page started it before a
 * reload), and the response is the provider's stream, read from the job.
 */
export function jobFetch(params: { id: string; provider: JobProvider; ownKey?: string; onLink?: (online: boolean) => void }): typeof fetch {
  const { id, provider, ownKey, onLink } = params;
  return async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const signal = init.signal;
    let request: unknown;
    try {
      request = JSON.parse(String(init.body ?? ''));
    } catch {
      return refusal(400, JSON.stringify({ error: 'The request could not be read.' }));
    }
    const started = await patiently(signal, onLink, async () => {
      const response = await apiFetch('/agent-jobs/start', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', ...(ownKey ? { 'X-Provider-Key': ownKey } : {}) },
        body: JSON.stringify({ id, provider, request }),
      });
      return { response, body: await response.text() };
    });
    if (!started.response.ok) return refusal(started.response.status, started.body);
    // Stop is the only thing that ends the job; a page closed or offline leaves it writing.
    signal?.addEventListener('abort', () => void apiFetch('/agent-jobs/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => undefined), { once: true });

    let offset = 0;
    const read = async (wait: number): Promise<ReadAnswer> => {
      const { response, body } = await patiently(signal, onLink, async () => {
        const response = await apiFetch(`/agent-jobs/read?id=${id}&from=${offset}&wait=${wait}`, { signal, cache: 'no-store' });
        return { response, body: (await response.json()) as ReadAnswer };
      });
      if (!response.ok) throw new Error(body.error || `The proxy answered ${response.status}.`);
      offset = body.offset ?? offset;
      return body;
    };
    // The first piece, or the end: what the provider said first decides the status.
    let first: ReadAnswer;
    try {
      do first = await read(20_000);
      while (!first.data && !first.done);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return refusal(502, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    const status = first.status ?? 200;
    if (status >= 400) {
      // A refusal: read to its end, and handed on whole.
      let text = first.data ?? '';
      try {
        for (let more = first; !more.done; text += more.data ?? '') more = await read(20_000);
      } catch {
        // what came will do
      }
      return refusal(status, text || JSON.stringify({ error: first.error || `The provider answered ${status}.` }));
    }
    if (first.done && first.stopped) throw abortError();
    const encoder = new TextEncoder();
    let last: ReadAnswer = first;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.data) controller.enqueue(encoder.encode(first.data));
      },
      async pull(controller) {
        try {
          while (!last.done) {
            last = await read(20_000);
            if (last.data) {
              controller.enqueue(encoder.encode(last.data));
              if (!last.done) return;
            }
          }
          if (last.stopped) controller.error(abortError());
          else if (last.interrupted || (last.error && status < 400)) controller.error(new Error(last.error || 'The answer was cut off on the server.'));
          else controller.close();
        } catch (error) {
          controller.error(signal?.aborted ? abortError() : error);
        }
      },
    });
    return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  };
}

/** Stop a job the page no longer follows (one left from before a reload, put aside). */
export async function stopJob(id: string): Promise<void> {
  await apiFetch('/agent-jobs/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => undefined);
}
