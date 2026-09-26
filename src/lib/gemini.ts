// ===========================================================================
//  Gemini — the third provider behind Ask AI and Explain.
//
//  Google's Gemini API takes its own shape rather than OpenAI's: a system
//  instruction beside the conversation, turns of `user` and `model`, and each
//  turn a list of parts — text, or a picture as inline base64 data. There is
//  no SDK to load: one fetch to generativelanguage.googleapis.com with the
//  visitor's own key (an AI Studio key, "AIza…", in the x-goog-api-key
//  header), streamed back as server-sent events with `alt=sse`. The stream it
//  returns has the few methods the app uses on Anthropic's MessageStream —
//  on('text'), on('thinking'), abort() and finalMessage() — as DeepSeek's does.
//
//  Thinking. Gemini 3 models think before answering at a level — low, medium
//  or high — and `includeThoughts` streams a summary of it as parts marked
//  `thought`, which go to the thinking listeners. Thought tokens are billed
//  as output.
//
//  Caching is implicit: Gemini notices a repeated prefix on its own, and says
//  how much of the prompt it read from the cache in `cachedContentTokenCount`.
// ===========================================================================

export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

/** Where one model's answer streams from. */
export const geminiUrl = (model: string) => `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

/** A failure Gemini (or the way to it) reported. `status` is 0 when the request never got an answer. */
export class GeminiError extends Error {
  status: number;
  /** Google's own word for it: INVALID_ARGUMENT, PERMISSION_DENIED, RESOURCE_EXHAUSTED… */
  reason: string;
  constructor(status: number, message: string, reason = '') {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.reason = reason;
  }
}

type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** A part as Gemini takes it. */
type WirePart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiMessage {
  role: 'user' | 'assistant';
  content: string | Part[];
}

export interface GeminiParams {
  apiKey: string;
  model: string;
  maxTokens: number;
  /** The system prompt, as one text. */
  system: string;
  messages: GeminiMessage[];
  /** How hard to think before answering. */
  thinking: 'low' | 'medium' | 'high';
  /** Called once with the tokens the answer took, when Gemini says. */
  onUsage?: (usage: GeminiUsage) => void;
}

/** What Gemini reports an answer took, in `usageMetadata`. */
export interface GeminiUsage {
  /** The whole prompt, the cached part included. */
  promptTokenCount?: number;
  /** Of the prompt, what was read from the cache. */
  cachedContentTokenCount?: number;
  /** The answer. */
  candidatesTokenCount?: number;
  /** The thinking, billed as output. */
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

/** Anthropic-style content, as Gemini's parts: pictures as inline base64. */
export function toParts(content: string | Part[]): WirePart[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part) =>
    part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.source.media_type, data: part.source.data } },
  );
}

/** The request body, as sent. */
export function requestBody(params: Omit<GeminiParams, 'apiKey' | 'onUsage' | 'model'>) {
  return {
    ...(params.system ? { systemInstruction: { parts: [{ text: params.system }] } } : {}),
    // Gemini calls the assistant's turns the model's.
    contents: params.messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: toParts(message.content) })),
    generationConfig: {
      maxOutputTokens: params.maxTokens,
      thinkingConfig: { thinkingLevel: params.thinking, includeThoughts: true },
    },
  };
}

/** Why the answer ended, in the words Anthropic uses, which is what the callers check for. */
export function stopReason(finish: string | null | undefined): string | null {
  if (!finish || finish === 'FINISH_REASON_UNSPECIFIED') return null;
  if (finish === 'STOP') return 'end_turn';
  if (finish === 'MAX_TOKENS') return 'max_tokens';
  // Declined for safety, for reciting a source at length, or for what it would have said.
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(finish)) return 'refusal';
  return finish.toLowerCase();
}

/** The tokens an answer took, as the usage tally counts them: output includes the thinking. */
export function tokensOf(usage: GeminiUsage) {
  const cacheRead = usage.cachedContentTokenCount || 0;
  return {
    input: Math.max(0, (usage.promptTokenCount || 0) - cacheRead),
    cacheRead,
    output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
  };
}

type Listener = (delta: string) => void;

interface Chunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiStream {
  private controller = new AbortController();
  private listeners: Record<'text' | 'thinking', Listener[]> = { text: [], thinking: [] };
  private done: Promise<{ stop_reason: string | null }>;

  constructor(params: GeminiParams, fetcher: typeof fetch = fetch) {
    this.done = this.run(params, fetcher);
    // A caller that never asks for the result must not leave an unhandled rejection behind.
    this.done.catch(() => {});
  }

  on(event: 'text' | 'thinking', listener: Listener) {
    this.listeners[event].push(listener);
    return this;
  }

  abort() {
    this.controller.abort();
  }

  finalMessage() {
    return this.done;
  }

  private emit(event: 'text' | 'thinking', delta: string) {
    for (const listener of this.listeners[event]) listener(delta);
  }

  private async run(params: GeminiParams, fetcher: typeof fetch): Promise<{ stop_reason: string | null }> {
    let response: Response;
    try {
      response = await fetcher(geminiUrl(params.model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': params.apiKey },
        body: JSON.stringify(requestBody(params)),
        signal: this.controller.signal,
      });
    } catch (error) {
      if (this.controller.signal.aborted) throw aborted();
      throw new GeminiError(0, String((error as Error)?.message ?? error));
    }
    if (!response.ok) {
      let message = response.statusText;
      let reason = '';
      try {
        const body = await response.json();
        const error = (Array.isArray(body) ? body[0] : body)?.error;
        message = error?.message || message;
        reason = error?.status || '';
      } catch {
        // not JSON: the status line will do
      }
      throw new GeminiError(response.status, message || `HTTP ${response.status}`, reason);
    }
    if (!response.body) throw new GeminiError(response.status, 'The answer came back empty.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stop: string | null = null;
    // Each chunk carries the running total; the last one is the answer's.
    let usage: GeminiUsage | undefined;
    const line = (raw: string) => {
      const text = raw.trim();
      if (!text.startsWith('data:')) return;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(text.slice(5).trim());
      } catch {
        return;
      }
      if (chunk.error) throw new GeminiError(chunk.error.code || 500, chunk.error.message || 'Gemini stopped with an error.', chunk.error.status || '');
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      // The question itself was declined, before any answer.
      if (chunk.promptFeedback?.blockReason) stop = 'refusal';
      const candidate = chunk.candidates?.[0];
      if (!candidate) return;
      for (const part of candidate.content?.parts ?? []) {
        if (!part.text) continue;
        this.emit(part.thought ? 'thinking' : 'text', part.text);
      }
      if (candidate.finishReason) stop = stopReason(candidate.finishReason);
    };
    try {
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
    } catch (error) {
      if (this.controller.signal.aborted) throw aborted();
      throw error instanceof GeminiError ? error : new GeminiError(0, String((error as Error)?.message ?? error));
    }
    if (usage && params.onUsage) {
      try {
        params.onUsage(usage);
      } catch {
        // counting never gets in the way of the answer
      }
    }
    return { stop_reason: stop };
  }
}

function aborted() {
  const error = new Error('Stopped.');
  error.name = 'AbortError';
  return error;
}
