/**
 * Claude and DeepSeek, asked by the proxy on its own keys, for the app's Ask
 * AI and Explain — the way Gemini is (server/geminiRelay.js).
 *
 * The site comes with the owner's keys: ANTHROPIC_KEY and DEEPSEEK_KEY, a
 * secret each for the Worker, an environment variable each for `npm start`.
 * They are never typed into the page, kept in a browser, or seen by anyone
 * using the site. Someone who would rather spend their own account pastes
 * their own key under Settings, and the app then goes straight to the
 * provider as it always has; without one, it sends the request it would have
 * sent the provider to `POST /ai/anthropic` or `POST /ai/deepseek`, and the
 * proxy checks who is asking, sends it on with its key, and streams the
 * answer back as it comes. The tokens it took are read off the stream on the
 * way through and put on the tally, so the app reports nothing.
 *
 * What is sent on is only what Ask AI, Explain and Implementation use — the
 * system prompt, the turns, the thinking and output settings, and the web
 * tools of Ask AI's Web button — for one of the models the app offers. A
 * tool of the provider's own (code execution, a computer, files) cannot be
 * slipped in to spend the owner's account on something else.
 *
 * Written against web APIs only, so the Worker imports it as the Node proxy
 * does.
 */

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/** The models the app offers (src/lib/assistant.ts), and the only ones relayed — by the id each provider's API takes. */
export const RELAYED_MODELS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
};

/** The most one answer may be asked to write: what Explain and Implementation ask for. */
const MAX_OUTPUT = 64000;
/** The most web lookups one answer may make (src/lib/webTools.ts). */
const MAX_TOOL_CALLS = 8;
const MAX_TOOLS = 8;
const EFFORTS = new Set(['low', 'medium', 'high']);
const DEEPSEEK_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const IMAGE_TYPE = /^image\/(jpeg|png|gif|webp)$/;

export class AiRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const outputCap = (value, fallback) => Math.max(1, Math.min(MAX_OUTPUT, Math.floor(Number(value) || fallback)));
const ephemeral = (block) => (block?.cache_control?.type === 'ephemeral' ? { cache_control: { type: 'ephemeral' } } : {});

// ------------------------------------------------------------ anthropic ----

/** One block of a Claude turn or system prompt: text, or a picture as base64. Anything else is dropped. */
function claudeBlock(block, { images = true } = {}) {
  if (typeof block === 'string') return { type: 'text', text: block };
  if (!isObject(block)) return null;
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text, ...ephemeral(block) };
  const source = block.source;
  if (images && block.type === 'image' && isObject(source) && source.type === 'base64' && IMAGE_TYPE.test(source.media_type) && typeof source.data === 'string') {
    return { type: 'image', source: { type: 'base64', media_type: source.media_type, data: source.data }, ...ephemeral(block) };
  }
  return null;
}

/**
 * A Messages API request as the app's Anthropic SDK sent it, kept to what the
 * app sends, or a refusal saying what is wrong with it.
 */
export function checkAnthropic(input) {
  if (!isObject(input)) throw new AiRefused(400, 'send the Messages API request as JSON');
  const model = String(input.model || '');
  if (!RELAYED_MODELS.anthropic.includes(model)) throw new AiRefused(400, `not a model this proxy relays: ${model || '(none)'}`);
  const messages = list(input.messages)
    .filter(isObject)
    .map((turn) => {
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      if (typeof turn.content === 'string') return { role, content: turn.content };
      return { role, content: list(turn.content).map((block) => claudeBlock(block)).filter(Boolean) };
    })
    .filter((turn) => turn.content.length);
  if (!messages.length) throw new AiRefused(400, 'there is no question in that request');
  const system = typeof input.system === 'string' ? input.system : list(input.system).map((block) => claudeBlock(block, { images: false })).filter(Boolean);
  const thinking = isObject(input.thinking) && input.thinking.type === 'adaptive' ? { type: 'adaptive', ...(input.thinking.display === 'summarized' ? { display: 'summarized' } : {}) } : null;
  const effort = isObject(input.output_config) && EFFORTS.has(input.output_config.effort) ? input.output_config.effort : null;
  // Anthropic's own web search, with Ask AI's Web button on — and nothing else.
  const search = list(input.tools).find((tool) => isObject(tool) && tool.type === 'web_search_20250305');
  return {
    model,
    max_tokens: outputCap(input.max_tokens, 16000),
    stream: true,
    ...(system.length ? { system } : {}),
    messages,
    ...(thinking ? { thinking } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...(search ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.max(1, Math.min(MAX_TOOL_CALLS, Math.floor(Number(search.max_uses) || MAX_TOOL_CALLS))) }] } : {}),
  };
}

/** The tokens a Claude answer took, as the tally counts them, from the usage its stream reported. */
export function anthropicTokens(usage) {
  return {
    input: Number(usage?.input_tokens) || 0,
    output: Number(usage?.output_tokens) || 0,
    cacheRead: Number(usage?.cache_read_input_tokens) || 0,
    cacheWrite: Number(usage?.cache_creation_input_tokens) || 0,
  };
}

// ------------------------------------------------------------- deepseek ----

/** One part of a DeepSeek turn: text, or a picture as a data URL. Anything else is dropped. */
function deepseekPart(part) {
  if (!isObject(part)) return null;
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  const url = part.image_url?.url;
  if (part.type === 'image_url' && typeof url === 'string' && /^data:image\/(jpeg|png|gif|webp);base64,/.test(url)) return { type: 'image_url', image_url: { url } };
  return null;
}

function deepseekTurn(turn) {
  if (!isObject(turn)) return null;
  if (turn.role === 'tool') {
    return typeof turn.tool_call_id === 'string' ? { role: 'tool', tool_call_id: turn.tool_call_id, content: String(turn.content ?? '') } : null;
  }
  const role = ['system', 'user', 'assistant'].includes(turn.role) ? turn.role : 'user';
  if (role === 'assistant' && Array.isArray(turn.tool_calls)) {
    const calls = turn.tool_calls
      .filter((call) => isObject(call) && isObject(call.function) && typeof call.id === 'string')
      .map((call) => ({ id: call.id, type: 'function', function: { name: String(call.function.name || ''), arguments: String(call.function.arguments ?? '') } }));
    return {
      role,
      content: typeof turn.content === 'string' ? turn.content : '',
      ...(typeof turn.reasoning_content === 'string' ? { reasoning_content: turn.reasoning_content } : {}),
      tool_calls: calls,
    };
  }
  if (typeof turn.content === 'string') return turn.content ? { role, content: turn.content } : null;
  const parts = list(turn.content).map(deepseekPart).filter(Boolean);
  return parts.length ? { role, content: parts } : null;
}

/**
 * A chat-completions request as the app sent it to DeepSeek, kept to what the
 * app sends — the web tools are the app's own functions, which it runs
 * itself, so they are passed on as declared — or a refusal.
 */
export function checkDeepSeek(input) {
  if (!isObject(input)) throw new AiRefused(400, 'send the chat-completions request as JSON');
  const model = String(input.model || '');
  if (!RELAYED_MODELS.deepseek.includes(model)) throw new AiRefused(400, `not a model this proxy relays: ${model || '(none)'}`);
  const messages = list(input.messages).map(deepseekTurn).filter(Boolean);
  if (!messages.some((turn) => turn.role === 'user')) throw new AiRefused(400, 'there is no question in that request');
  const thinking = input.thinking?.type === 'disabled' ? 'disabled' : 'enabled';
  const tools = list(input.tools)
    .filter((tool) => isObject(tool) && tool.type === 'function' && isObject(tool.function) && typeof tool.function.name === 'string')
    .slice(0, MAX_TOOLS)
    .map((tool) => ({ type: 'function', function: { name: tool.function.name, description: String(tool.function.description || ''), parameters: isObject(tool.function.parameters) ? tool.function.parameters : { type: 'object' } } }));
  return {
    model,
    max_tokens: outputCap(input.max_tokens, 16000),
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: thinking },
    ...(thinking === 'enabled' && DEEPSEEK_EFFORTS.has(input.reasoning_effort) ? { reasoning_effort: input.reasoning_effort } : {}),
    ...(tools.length ? { tools, ...(input.tool_choice === 'none' ? { tool_choice: 'none' } : {}) } : {}),
    messages,
  };
}

/** The tokens a DeepSeek answer took, as the tally counts them: what it read from its cache apart. */
export function deepseekTokens(usage) {
  const hit = Number(usage?.prompt_cache_hit_tokens) || 0;
  const miss = usage?.prompt_cache_miss_tokens ?? Math.max(0, (Number(usage?.prompt_tokens) || 0) - hit);
  return { input: Number(miss) || 0, cacheRead: hit, output: Number(usage?.completion_tokens) || 0 };
}

/** The entry the app picked, which the tally keeps apart: DeepSeek Flash with its thinking off is its own. */
export const deepseekVariant = (request) => (request.model === 'deepseek-flash' && request.thinking?.type === 'disabled' ? 'deepseek-flash-fast' : request.model);

// --------------------------------------------------------------- shared ----

/**
 * The usage a stream of server-sent events reported, gathered as it goes by:
 * Claude's arrives in message_start and grows in message_delta; DeepSeek's is
 * in its last chunk.
 */
export async function usageIn(stream, provider) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  const line = (raw) => {
    const text = raw.trim();
    if (!text.startsWith('data:')) return;
    try {
      const chunk = JSON.parse(text.slice(5).trim());
      if (provider === 'anthropic') {
        if (chunk?.type === 'message_start' && chunk.message?.usage) usage = { ...chunk.message.usage };
        else if (chunk?.type === 'message_delta' && chunk.usage) usage = { ...(usage || {}), ...Object.fromEntries(Object.entries(chunk.usage).filter(([, value]) => value !== null)) };
      } else if (chunk?.usage) {
        usage = chunk.usage;
      }
    } catch {
      // [DONE], or not a chunk of ours
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
 * Ask the provider, and hand back its answer to stream on as it is —
 * `response`, with the provider's status, and its error as the provider words
 * it when there is one — and `usage`, which settles once the stream has been
 * read through with what the answer took (null for an error, or if it could
 * not be read).
 */
export async function relayAi(provider, request, key, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const headers =
    provider === 'anthropic'
      ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  const upstream = await fetchImpl(provider === 'anthropic' ? ANTHROPIC_URL : DEEPSEEK_URL, { method: 'POST', signal, headers, body: JSON.stringify(request) });
  const name = provider === 'anthropic' ? 'Anthropic' : 'DeepSeek';
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return {
      response: new Response(text || JSON.stringify({ error: { message: `${name} answered ${upstream.status}` } }), { status: upstream.status || 502, headers: { 'Content-Type': 'application/json' } }),
      usage: Promise.resolve(null),
    };
  }
  const [toApp, toTally] = upstream.body.tee();
  return {
    response: new Response(toApp, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    usage: usageIn(toTally, provider).catch(() => null),
  };
}

/** Check a request for a provider: the relayed one, or a refusal. */
export const checkAi = (provider, input) => (provider === 'anthropic' ? checkAnthropic(input) : checkDeepSeek(input));

/** The tally's counts for an answer the proxy relayed — its provider's name there, the model, the variant, the tokens. */
export function relayedUsage(provider, request, usage) {
  if (provider === 'anthropic') return { provider: 'claude', model: request.model, ...anthropicTokens(usage) };
  return { provider: 'deepseek', model: request.model, variant: deepseekVariant(request), ...deepseekTokens(usage) };
}

/**
 * Whether someone who is not the owner may spend the proxy's AI keys:
 * AI_FOR is "everyone", or — as before there was one setting for all three
 * — GEMINI_FOR is, for Gemini alone.
 */
export function aiForEveryone(env, provider) {
  const all = String(env.AI_FOR || '').trim().toLowerCase();
  if (all) return all === 'everyone';
  return provider === 'gemini' && String(env.GEMINI_FOR || '').trim().toLowerCase() === 'everyone';
}

/** The proxy's key for a provider — the name it is set under. */
export const KEY_NAMES = { anthropic: 'ANTHROPIC_KEY', deepseek: 'DEEPSEEK_KEY', gemini: 'GEMINI_KEY' };
export const aiKey = (env, provider) => String(env[KEY_NAMES[provider]] || '').trim();
/** Which providers the proxy holds a key for — what /health tells the app. */
export const aiKeys = (env) => ({ anthropic: Boolean(aiKey(env, 'anthropic')), deepseek: Boolean(aiKey(env, 'deepseek')), gemini: Boolean(aiKey(env, 'gemini')) });
