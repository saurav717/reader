// ===========================================================================
//  DeepSeek — the second provider behind Ask AI and Explain.
//
//  DeepSeek's API speaks the OpenAI chat-completions dialect, so there is no
//  SDK to load: one fetch to api.deepseek.com with the visitor's own key, read
//  as server-sent events. The stream it returns has the few methods the app
//  uses on Anthropic's MessageStream — on('text'), on('thinking'), abort()
//  and finalMessage() — so the callers need not care which one they hold.
//
//  Pictures — the pages in view in PDF mode, and screenshots — go as OpenAI's
//  image_url parts holding a base64 data URL; deepseek-flash (V4.1 Flash) reads
//  them. DeepSeek bills each picture at no more than 384 tokens, so it sees a
//  page at a lower resolution than Claude does: small print in an equation can
//  be lost where the paper's text is still there to fall back on.
//
//  Thinking is on by default on DeepSeek's models; `thinking` switches it on or
//  off per request, and `reasoning_effort` sets how hard it thinks.
//
//  Tools — the web, with Ask AI's Web button on (webTools.ts) — go as
//  OpenAI-style function declarations. When the model answers with
//  `tool_calls` instead of an answer, the stream runs each through the
//  `runTool` it was given, sends the results back as `tool` turns, and asks
//  again, round after round until the model answers in text or the cap on
//  calls is reached. DeepSeek wants the reasoning of every round that
//  called a tool sent back with it (`reasoning_content` on the assistant
//  turn), or it refuses the next request; so it is kept, round to round,
//  while the text of it also streams to the thinking listeners as before.
//
//  There are no cache breakpoints. DeepSeek caches a repeated prefix on its
//    own, so the paper, which leads the system prompt, is still cheap the
//    second time.
// ===========================================================================

import type { ToolSpec, WebStep } from './webTools';

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
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** A part as DeepSeek takes it: OpenAI's shape, pictures as data URLs. */
type WirePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface DeepSeekMessage {
  role: 'user' | 'assistant';
  content: string | Part[];
}

/** A tool call as the model makes it, assembled from the deltas of a stream. */
export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as JSON text, as the model wrote them. */
  arguments: string;
}

/**
 * A turn as it goes over the wire: the conversation's own, an assistant
 * turn that called tools (with the reasoning that led to it), or a tool's
 * answer.
 */
export type WireMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | WirePart[] }
  | { role: 'assistant'; content: string; reasoning_content?: string; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface DeepSeekParams {
  apiKey: string;
  model: string;
  maxTokens: number;
  /** The system prompt, as one text. */
  system: string;
  messages: DeepSeekMessage[];
  /** Think before answering, and how hard. Off answers straight away. */
  thinking: 'off' | 'low' | 'high' | 'max';
  /** Called once with the tokens the answer took, when DeepSeek says — once a round, when tools are in play. */
  onUsage?: (usage: DeepSeekUsage) => void;
  /** The tools the model may call, and how each is run; with neither, the answer is one request. */
  tools?: ToolSpec[];
  runTool?: (name: string, args: unknown, signal: AbortSignal) => Promise<{ text: string; step: WebStep | null }>;
  /** The most tool calls one answer may make, over every round. */
  maxToolCalls?: number;
  /** 'none' once the cap is reached: answer now, with no more calls. */
  toolChoice?: 'none';
}

/** What DeepSeek reports an answer took, in the last chunk of the stream. */
export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** Anthropic-style content, in the shape DeepSeek takes: a string stays a string. */
export function toWire(content: string | Part[]): string | WirePart[] {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } },
  );
}

/** The request body, as sent: the conversation, and the rounds of tool calls so far after it. */
export function requestBody(params: Omit<DeepSeekParams, 'apiKey' | 'onUsage' | 'runTool' | 'maxToolCalls'>, rounds: WireMessage[] = []) {
  return {
    model: params.model,
    max_tokens: params.maxTokens,
    stream: true,
    // One last chunk with the tokens the answer took, for the usage tally.
    stream_options: { include_usage: true },
    thinking: { type: params.thinking === 'off' ? ('disabled' as const) : ('enabled' as const) },
    ...(params.thinking === 'off' ? {} : { reasoning_effort: params.thinking }),
    ...(params.tools?.length
      ? {
          tools: params.tools.map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
          // Past the cap on calls the tools stay declared, so the rounds so far still parse, but may not be called again.
          ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
        }
      : {}),
    messages: [
      ...(params.system ? [{ role: 'system' as const, content: params.system }] : []),
      ...params.messages.map((message) => ({ role: message.role, content: toWire(message.content) })),
      ...rounds,
    ],
  };
}

/** Why the answer ended, in the words Anthropic uses, which is what the callers check for. */
export function stopReason(finish: string | null | undefined): string | null {
  if (!finish) return null;
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop') return 'end_turn';
  if (finish === 'tool_calls') return 'tool_use';
  return finish;
}

/** The arguments of a tool call, parsed; what would not parse goes as the text it was. */
export function parseArguments(text: string): unknown {
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

type Listener = (delta: string) => void;
type StepListener = (step: WebStep) => void;

/** What one request streamed back: the answer's text and reasoning, the tool calls it made, and why it stopped. */
interface Round {
  text: string;
  reasoning: string;
  calls: ToolCall[];
  stop: string | null;
}

export class DeepSeekStream {
  private controller = new AbortController();
  private listeners: { text: Listener[]; thinking: Listener[]; step: StepListener[] } = { text: [], thinking: [], step: [] };
  private done: Promise<{ stop_reason: string | null }>;

  constructor(params: DeepSeekParams, fetcher: typeof fetch = fetch) {
    this.done = this.run(params, fetcher);
    // A caller that never asks for the result must not leave an unhandled rejection behind.
    this.done.catch(() => {});
  }

  on(event: 'text' | 'thinking', listener: Listener): this;
  on(event: 'step', listener: StepListener): this;
  on(event: 'text' | 'thinking' | 'step', listener: Listener | StepListener) {
    (this.listeners[event] as unknown[]).push(listener);
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

  private step(step: WebStep) {
    for (const listener of this.listeners.step) listener(step);
  }

  /**
   * The answer: one request, or — with tools — a request a round, each
   * round's tool calls run and answered before the next, until the model
   * answers in text. Past the cap on calls the model is asked once more
   * with calling turned off, so it answers with what it has.
   */
  private async run(params: DeepSeekParams, fetcher: typeof fetch): Promise<{ stop_reason: string | null }> {
    const canCall = Boolean(params.tools?.length && params.runTool);
    const cap = params.maxToolCalls ?? 8;
    const rounds: WireMessage[] = [];
    let made = 0;
    for (;;) {
      const withTools = canCall && made < cap;
      const round = await this.request(canCall ? { ...params, ...(withTools ? {} : { toolChoice: 'none' }) } : params, rounds, fetcher);
      if (!withTools || !round.calls.length) return { stop_reason: round.stop === 'tool_use' ? 'end_turn' : round.stop };
      rounds.push({
        role: 'assistant',
        content: round.text,
        ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
        tool_calls: round.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
      });
      for (const call of round.calls) {
        made += 1;
        const args = parseArguments(call.arguments);
        let text: string;
        if (made > cap) {
          text = `The cap of ${cap} tool calls for one answer is reached; this call was not made. Answer with what you have.`;
        } else {
          const result = await params.runTool!(call.name, args, this.controller.signal);
          if (this.controller.signal.aborted) throw aborted();
          if (result.step) this.step(result.step);
          text = result.text;
        }
        rounds.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
  }

  /** One request, streamed: text and reasoning to the listeners as they come, the tool calls assembled, and why it stopped. */
  private async request(params: DeepSeekParams, rounds: WireMessage[], fetcher: typeof fetch): Promise<Round> {
    let response: Response;
    try {
      response = await fetcher(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` },
        body: JSON.stringify(requestBody(params, rounds)),
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
    const round: Round = { text: '', reasoning: '', calls: [], stop: null };
    // Tool calls arrive as deltas, each naming its place in the list.
    const calls = new Map<number, ToolCall>();
    const line = (raw: string) => {
      const text = raw.trim();
      // Blank lines end an event; ": keep-alive" is a comment, sent while the model thinks.
      if (!text.startsWith('data:')) return false;
      const data = text.slice(5).trim();
      if (data === '[DONE]') return true;
      let chunk: {
        choices?: {
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        error?: { message?: string };
        usage?: DeepSeekUsage | null;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        return false;
      }
      if (chunk.error) throw new DeepSeekError(500, chunk.error.message || 'DeepSeek stopped with an error.');
      if (chunk.usage && params.onUsage) {
        try {
          params.onUsage(chunk.usage);
        } catch {
          // counting never gets in the way of the answer
        }
      }
      const choice = chunk.choices?.[0];
      if (!choice) return false;
      if (choice.delta?.reasoning_content) {
        round.reasoning += choice.delta.reasoning_content;
        this.emit('thinking', choice.delta.reasoning_content);
      }
      if (choice.delta?.content) {
        round.text += choice.delta.content;
        this.emit('text', choice.delta.content);
      }
      for (const delta of choice.delta?.tool_calls ?? []) {
        const at = delta.index ?? calls.size;
        const call = calls.get(at) ?? { id: '', name: '', arguments: '' };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name += delta.function.name;
        if (delta.function?.arguments) call.arguments += delta.function.arguments;
        calls.set(at, call);
      }
      if (choice.finish_reason) {
        if (choice.finish_reason === 'insufficient_system_resource') {
          throw new DeepSeekError(503, 'DeepSeek ran short of capacity and cut the answer off.');
        }
        round.stop = stopReason(choice.finish_reason);
      }
      return false;
    };
    try {
      let ended = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        if (lines.some(line)) {
          ended = true;
          break;
        }
      }
      if (!ended) {
        buffer += decoder.decode();
        if (buffer) line(buffer);
      }
    } catch (error) {
      if (this.controller.signal.aborted) throw aborted();
      throw error instanceof DeepSeekError ? error : new DeepSeekError(0, String((error as Error)?.message ?? error));
    }
    round.calls = Array.from(calls.entries())
      .sort(([a], [b]) => a - b)
      .map(([, call], i) => ({ ...call, id: call.id || `call_${i}`, name: call.name || 'unknown' }));
    return round;
  }
}

function aborted() {
  const error = new Error('Stopped.');
  error.name = 'AbortError';
  return error;
}
