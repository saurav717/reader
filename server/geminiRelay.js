/**
 * Gemini, asked by the proxy on its own key, for the app's Ask AI and
 * Explain.
 *
 * Claude and DeepSeek are called straight from the browser on the visitor's
 * own key. Gemini is not: its key is the proxy's (GEMINI_KEY — a secret for
 * the Worker, an environment variable for `npm start`), so it is never typed
 * into the page, kept in a browser, or seen by anyone using the site. The app
 * sends the request it would have sent Google to `POST /ai/gemini`, with the
 * model beside it; the proxy checks who is asking, sends it on with the key
 * in a header, and streams Google's answer back as it comes. The tokens the
 * answer took are read off the stream on the way through and put on the
 * owner's usage tally — the proxy knows them first-hand, so the app reports
 * nothing.
 *
 * What is sent on is only what Ask AI and Explain use — the system
 * instruction, the turns and the generation settings — for one of the models
 * the app offers. A tool (Google Search, code execution) cannot be slipped in
 * to spend the owner's allowance on something else.
 *
 * Written against web APIs only, so the Worker imports it as the Node proxy
 * does.
 */

export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

/** The models the app offers (src/lib/assistant.ts), and the only ones relayed. */
export const GEMINI_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

/** The most one answer may be asked to write: the models' own ceiling. */
const MAX_OUTPUT = 64000;
/** A paper's text and a few pages as pictures fit well inside this. */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

export class GeminiRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One part of a turn: text, or a picture as inline base64. Anything else is dropped. */
function part(value) {
  if (!isObject(value)) return null;
  if (typeof value.text === 'string') return value.thought ? { text: value.text, thought: true } : { text: value.text };
  const inline = value.inlineData;
  if (isObject(inline) && typeof inline.mimeType === 'string' && /^image\/[\w.+-]+$/.test(inline.mimeType) && typeof inline.data === 'string') {
    return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
  }
  return null;
}

/**
 * The request as the app sent it — `{ model, request }` — kept to what the
 * app sends, or a refusal saying what is wrong with it.
 */
export function checkRequest(input) {
  if (!isObject(input)) throw new GeminiRefused(400, 'send { model, request } as JSON');
  const model = String(input.model || '');
  if (!GEMINI_MODELS.includes(model)) throw new GeminiRefused(400, `not a model this proxy relays: ${model || '(none)'}`);
  const request = isObject(input.request) ? input.request : {};
  const contents = (Array.isArray(request.contents) ? request.contents : [])
    .filter(isObject)
    .map((turn) => ({ role: turn.role === 'model' ? 'model' : 'user', parts: (Array.isArray(turn.parts) ? turn.parts : []).map(part).filter(Boolean) }))
    .filter((turn) => turn.parts.length);
  if (!contents.length) throw new GeminiRefused(400, 'there is no question in that request');
  const system = (request.systemInstruction?.parts || []).map(part).filter((p) => p && p.text !== undefined);
  const config = isObject(request.generationConfig) ? request.generationConfig : {};
  const thinking = isObject(config.thinkingConfig) ? config.thinkingConfig : {};
  return {
    model,
    request: {
      ...(system.length ? { systemInstruction: { parts: system } } : {}),
      contents,
      generationConfig: {
        maxOutputTokens: Math.max(1, Math.min(MAX_OUTPUT, Math.floor(Number(config.maxOutputTokens) || 8192))),
        thinkingConfig: {
          ...(LEVELS.has(thinking.thinkingLevel) ? { thinkingLevel: thinking.thinkingLevel } : {}),
          includeThoughts: thinking.includeThoughts !== false,
        },
      },
    },
  };
}

/** The tokens an answer took, as the usage tally counts them: output includes the thinking. */
export function tokensOf(usage) {
  const cacheRead = Number(usage?.cachedContentTokenCount) || 0;
  return {
    input: Math.max(0, (Number(usage?.promptTokenCount) || 0) - cacheRead),
    cacheRead,
    output: (Number(usage?.candidatesTokenCount) || 0) + (Number(usage?.thoughtsTokenCount) || 0),
  };
}

/** The last `usageMetadata` in a stream of Gemini's server-sent events — each chunk carries the running total. */
export async function usageIn(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  const line = (raw) => {
    const text = raw.trim();
    if (!text.startsWith('data:')) return;
    try {
      const chunk = JSON.parse(text.slice(5).trim());
      if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    } catch {
      // not a chunk of ours
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(line);
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  return usage;
}

/**
 * Ask Google, and hand back its answer to stream on as it is — `response`,
 * with Google's status, and its error as Google words it when there is one —
 * and `usage`, which settles once the stream has been read through with what
 * the answer took (null for an error, or if it could not be read).
 */
export async function relayGemini({ model, request }, key, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const upstream = await fetchImpl(`${GEMINI_HOST}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(request),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return { response: new Response(text || JSON.stringify({ error: { message: `Google answered ${upstream.status}` } }), { status: upstream.status || 502, headers: { 'Content-Type': 'application/json' } }), usage: Promise.resolve(null) };
  }
  const [toApp, toTally] = upstream.body.tee();
  return {
    response: new Response(toApp, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    usage: usageIn(toTally).catch(() => null),
  };
}
