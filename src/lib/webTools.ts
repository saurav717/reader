// ===========================================================================
//  The web, for Ask AI — the two tools behind the window's Web button.
//
//  With the button on, the model answering may look things up as it goes:
//  search the web, and read a page it found. Neither happens in this page.
//  The model asks for a tool call; the app runs it through the paper proxy's
//  `/web/search` and `/web/page` (server/webSearch.js), which hold the search
//  key and can fetch what a browser cannot; and the result goes back to the
//  model as the next turn. DeepSeek does this by OpenAI-style function
//  calling, in a loop in deepseek.ts. Claude has a search of Anthropic's
//  own, run on Anthropic's side, so the Claude path uses that instead and
//  needs nothing from here but the readiness check. Gemini's relay lets no
//  tool through, by design, so the button is off for its models.
//
//  Each search is metered on the proxy owner's account, which is why the
//  routes want the proxy's token or a pass, and why the button is off by
//  default: a question about the paper costs what it always did.
// ===========================================================================

import { apiFetch, hasProxy, hasProxyToken, proxyHealth } from './api';

/** A tool as every provider's function calling describes one: a name, what it does, and a JSON schema for its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The most tool calls one answer may make, over every round: a cap on spend, not a budget. */
export const MAX_TOOL_CALLS = 8;
/** How much of a search result's snippet, or a page, the model gets. */
const PAGE_CHARS_TO_MODEL = 24_000;

export const WEB_TOOLS: ToolSpec[] = [
  {
    name: 'web_search',
    description:
      'Search the web. Returns up to eight results, each a title, a URL and a snippet. Use it for what the paper on screen cannot answer: later work that cites or builds on it, what a cited paper actually found, a term or method the paper assumes, code or data releases, and what has happened since it was written. Write a short, specific query, as you would in a search box.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The words to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'read_page',
    description:
      'Read a web page as text, by its URL — one that a search returned, or one named in the paper or by the reader. Returns the page’s title and its text, cut to a length. Read a page when a snippet is not enough to answer from.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full address of the page, with its scheme.' } },
      required: ['url'],
    },
  },
];

/** One thing the model did on the web, for the line under its answer. */
export interface WebStep {
  tool: 'web_search' | 'read_page';
  /** The query, or the page's address. */
  what: string;
  /** How it went: results found, a title read, or what went wrong. */
  outcome?: string;
}

/** The argument a tool call named, as a string, whatever the model sent. */
const argument = (args: unknown, name: string): string => {
  const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
};

/** The step a tool call is, before it runs — so the window can say what the model is doing. */
export function stepOf(name: string, args: unknown): WebStep | null {
  if (name === 'web_search') return { tool: 'web_search', what: argument(args, 'query') };
  if (name === 'read_page') return { tool: 'read_page', what: argument(args, 'url') };
  return null;
}

/** What the proxy said was wrong, in a sentence the model can act on. */
async function problem(response: Response): Promise<string> {
  let message = `the paper proxy answered ${response.status}`;
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') message = body.error;
  } catch {
    // not JSON
  }
  if (response.status === 401) return 'The paper proxy wants its token or a sign-in before it will search (Settings → Paper proxy).';
  if (response.status === 501) return 'The paper proxy has no web search key: its owner sets BRAVE_KEY, SERPLY_KEY or SERPAPI_KEY.';
  if (response.status === 429) return 'Too many searches at once; wait a minute before searching again.';
  return message;
}

/**
 * One tool call, run through the proxy: the text the model reads next.
 * Nothing here throws for the model's sake — a page that would not load,
 * a search that failed, an unknown tool — each comes back as a sentence
 * saying so, which the model carries on from; a stop (the signal) does.
 */
export async function runWebTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ text: string; step: WebStep | null }> {
  const step = stepOf(name, args);
  if (!step) return { text: `There is no tool called ${name}. The tools are web_search and read_page.`, step: null };
  if (!step.what) return { text: `${name} needs its ${step.tool === 'web_search' ? 'query' : 'url'}.`, step: { ...step, outcome: 'nothing asked' } };
  let response: Response;
  try {
    response = await apiFetch(step.tool === 'web_search' ? `/web/search?q=${encodeURIComponent(step.what)}` : `/web/page?url=${encodeURIComponent(step.what)}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: 'The paper proxy could not be reached, so the web is out of reach for now. Answer from the paper and say so.', step: { ...step, outcome: 'the proxy could not be reached' } };
  }
  if (!response.ok) {
    const why = await problem(response);
    return { text: `${step.tool === 'web_search' ? 'The search' : 'Reading that page'} failed: ${why} Carry on without it, and tell the reader if it matters.`, step: { ...step, outcome: why } };
  }
  const body = await response.json();
  if (step.tool === 'web_search') {
    const results = (Array.isArray(body?.results) ? body.results : []) as { title: string; url: string; snippet: string; age?: string }[];
    if (!results.length) return { text: `No results for “${step.what}”. Try other words, or answer from what you have.`, step: { ...step, outcome: 'no results' } };
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.age ? `\n   (${r.age})` : ''}${r.snippet ? `\n   ${r.snippet}` : ''}`);
    return { text: `Results for “${step.what}”:\n\n${lines.join('\n\n')}`, step: { ...step, outcome: `${results.length} result${results.length === 1 ? '' : 's'}` } };
  }
  if (typeof body?.note === 'string' && !body.text) return { text: body.note, step: { ...step, outcome: 'not a page' } };
  const text = String(body?.text || '');
  const cut = text.length > PAGE_CHARS_TO_MODEL;
  const head = [body?.title ? `Title: ${body.title}` : '', `URL: ${body?.url || step.what}`, cut || body?.truncated ? '(The page is longer; this is its start.)' : ''].filter(Boolean).join('\n');
  return { text: `${head}\n\n${cut ? text.slice(0, PAGE_CHARS_TO_MODEL) : text}`, step: { ...step, outcome: String(body?.title || '').trim() || 'read' } };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Where the web stands on this proxy, for the button: ready; no proxy at
 * all; a proxy with no search key; one that wants its token or a sign-in
 * first; or not yet known.
 */
export type WebReadiness = 'ready' | 'no-proxy' | 'no-key' | 'sign-in' | 'checking';

/** Ask the proxy's /health whether it can search, and whether this browser may ask it to. */
export async function checkWeb(): Promise<WebReadiness> {
  if (!hasProxy()) return 'no-proxy';
  const health = await proxyHealth();
  if (!health) return 'no-proxy';
  if (!health.web) return 'no-key';
  return health.auth && !hasProxyToken() ? 'sign-in' : 'ready';
}

/** Where the web stands, in a sentence for the button's title. */
export function webNote(readiness: WebReadiness): string {
  switch (readiness) {
    case 'ready':
      return 'The model may search the web and read pages, through the paper proxy';
    case 'no-proxy':
      return 'Searching the web needs a paper proxy — Settings → Paper proxy';
    case 'no-key':
      return 'The paper proxy has no web search key yet — its owner sets BRAVE_KEY, SERPLY_KEY or SERPAPI_KEY';
    case 'sign-in':
      return 'Sign in to the paper proxy to search the web — with Google, or its token under Settings → Paper proxy';
    default:
      return 'Checking whether the paper proxy can search the web…';
  }
}
