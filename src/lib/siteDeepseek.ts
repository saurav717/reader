// ===========================================================================
//  The site's DeepSeek switch (worker/deepseekSwitch.js): whether anything
//  may go to DeepSeek from this site at all — the relay, the agent's jobs,
//  the Scholar and contribution readers, and a key of a person's own. Off
//  unless the owner turns it on, from Usage → The site: DeepSeek's terms let
//  it train on what it is sent, and Google's data policy forbids passing it
//  what came through Google's APIs. /health carries the answer too, which is
//  how the pickers hide its models (assistant.ts, offeredModels).
// ===========================================================================

import { apiFetch, hasProxy } from './api';
import { ownerFetch } from './owner';

export interface DeepseekSwitch {
  enabled: boolean;
  /** Whether the Worker can keep the choice (a SESSIONS namespace bound). */
  stored: boolean;
}

/** The switch as the proxy last told it, for a minute. */
let known: { at: number } & DeepseekSwitch = { at: 0, enabled: false, stored: false };

export async function siteDeepseek(fresh = false): Promise<DeepseekSwitch> {
  if (!hasProxy()) return { enabled: false, stored: false };
  if (!fresh && known.at && Date.now() - known.at < 60_000) return known;
  try {
    const response = await apiFetch('/site/deepseek', fresh ? { cache: 'no-store' } : {});
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { enabled?: boolean; stored?: boolean };
    known = { at: Date.now(), enabled: body.enabled === true, stored: Boolean(body.stored) };
  } catch {
    // Offline, or a proxy from before the switch: off, the safe reading.
    known = { at: Date.now(), enabled: false, stored: false };
  }
  return known;
}

/** The owner's choice, kept on the Worker for every visitor. */
export async function setSiteDeepseek(enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await ownerFetch('/site/deepseek', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  const body = (await response.json().catch(() => ({}))) as { error?: string; enabled?: boolean; stored?: boolean };
  if (!response.ok) return { ok: false, error: body.error || `The proxy answered ${response.status}.` };
  known = { at: Date.now(), enabled: body.enabled === true, stored: Boolean(body.stored) };
  return { ok: true };
}
