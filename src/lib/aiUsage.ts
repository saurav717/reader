// ===========================================================================
//  AI usage, for the owner's tally.
//
//  Ask AI and Explain call Anthropic, DeepSeek and Google straight from this browser,
//  on the visitor's own key, so the proxy never sees them. Once an answer is
//  in, this tells the proxy how many tokens it took (`POST /usage/ai`, see
//  worker/usage.js), and the owner's Usage page shows it per person beside
//  Serply and SerpApi. Only for someone signed in to the proxy; nothing is
//  sent otherwise, and a failure is dropped — counting never gets in the way.
// ===========================================================================

import { apiFetch, hasProxy, hasProxyToken } from './api';

export type AiProvider = 'claude' | 'deepseek' | 'gemini';

export interface AiTokens {
  /** Input read at full price. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * `model` is the model the provider was asked for, which prices the answer;
 * `variant` is the one picked in the app, which the tally keeps apart — the
 * same DeepSeek model with thinking on or off.
 */
export function reportAiUsage(provider: AiProvider, model: string, tokens: AiTokens, variant: string = model): void {
  if (!hasProxy() || !hasProxyToken()) return;
  if (!(tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite)) return;
  try {
    void apiFetch('/usage/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, variant, ...tokens }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // no fetch here, or the proxy is misconfigured: not worth a word
  }
}
