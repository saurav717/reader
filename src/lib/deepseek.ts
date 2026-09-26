// ===========================================================================
//  DeepSeek — the second provider behind Ask AI and Explain.
//
//  DeepSeek's API speaks the OpenAI chat-completions dialect, so there is no
//  SDK to load: one fetch to api.deepseek.com with the visitor's own key, read
//  as server-sent events. The stream it returns has the few methods the app
//  uses on Anthropic's MessageStream — on('text'), on('thinking'), abort()
//  and finalMessage() — so the callers need not care which one they hold.
//
//  Two differences the app has to live with:
//  - The models read text only. Pictures of the pages in view and screenshots
//    are left out, and a line in their place says so.
//  - There are no cache breakpoints. DeepSeek caches a repeated prefix on its
//    own, so the paper, which leads the system prompt, is still cheap the
//    second time.
// ===========================================================================

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/** A failure DeepSeek (or the way to it) reported. `status` is 0 when the request never got an answer. */
export class DeepSeekError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
  }
}

type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; source: unknown };

export interface DeepSeekMessage {
  role: 'user' | 'assistant';
  content: string | Part[];
}

export interface DeepSeekParams {
  apiKey: string;
  model: string;
  maxTokens: number;
  /** The system prompt, as one text. */
  system: string;
  messages: DeepSeekMessage[];
}

export const PICTURE_LEFT_OUT = '[A picture went here, but this model reads text only, so it was left out.]';

/** Anthropic-style content, flattened to the plain text DeepSeek takes. */
export function flatten(content: string | Part[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : PICTURE_LEFT_OUT))
    .filter(Boolean)
    .join('\n\n');
}

/** The request body, as sent. */
export function requestBody(params: Omit<DeepSeekParams, 'apiKey'>) {
  return {
    model: params.model,
    max_tokens: params.maxTokens,
    stream: true,
    messages: [
      ...(params.system ? [{ role: 'system' as const, content: params.system }] : []),
      ...params.messages.map((message) => ({ role: message.role, content: flatten(message.content) })),
    ],
  };
}

/** Why the answer ended, in the words Anthropic uses, which is what the callers check for. */
export function stopReason(finish: string | null | undefined): string | null {
  if (!finish) return null;
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop') return 'end_turn';
  return finish;
}

type Listener = (delta: string) => void;

export class DeepSeekStream {
  private controller = new AbortController();
  private listeners: Record<'text' | 'thinking', Listener[]> = { text: [], thinking: [] };
  private done: Promise<{ stop_reason: string | null }>;

  constructor(params: DeepSeekParams, fetcher: typeof fetch = fetch) {
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

  private async run(params: DeepSeekParams, fetcher: typeof fetch): Promise<{ stop_reason: string | null }> {
    let response: Response;
    try {
      response = await fetcher(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` },
        body: JSON.stringify(requestBody(params)),
        signal: this.controller.signal,
      });
    } catch (error) {
      if (this.controller.signal.aborted) throw aborted();
      throw new DeepSeekError(0, String((error as Error)?.message ?? error));
    }
    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
      } catch {
        // not JSON: the status line will do
      }
      throw new DeepSeekError(response.status, message || `HTTP ${response.status}`);
    }
    if (!response.body) throw new DeepSeekError(response.status, 'The answer came back empty.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stop: string | null = null;
    const line = (raw: string) => {
      const text = raw.trim();
      // Blank lines end an event; ": keep-alive" is a comment, sent while the model thinks.
      if (!text.startsWith('data:')) return false;
      const data = text.slice(5).trim();
      if (data === '[DONE]') return true;
      let chunk: { choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]; error?: { message?: string } };
      try {
        chunk = JSON.parse(data);
      } catch {
        return false;
      }
      if (chunk.error) throw new DeepSeekError(500, chunk.error.message || 'DeepSeek stopped with an error.');
      const choice = chunk.choices?.[0];
      if (!choice) return false;
      if (choice.delta?.reasoning_content) this.emit('thinking', choice.delta.reasoning_content);
      if (choice.delta?.content) this.emit('text', choice.delta.content);
      if (choice.finish_reason) {
        if (choice.finish_reason === 'insufficient_system_resource') {
          throw new DeepSeekError(503, 'DeepSeek ran short of capacity and cut the answer off.');
        }
        stop = stopReason(choice.finish_reason);
      }
      return false;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        if (lines.some(line)) return { stop_reason: stop };
      }
      buffer += decoder.decode();
      if (buffer) line(buffer);
    } catch (error) {
      if (this.controller.signal.aborted) throw aborted();
      throw error instanceof DeepSeekError ? error : new DeepSeekError(0, String((error as Error)?.message ?? error));
    }
    return { stop_reason: stop };
  }
}

function aborted() {
  const error = new Error('Stopped.');
  error.name = 'AbortError';
  return error;
}
