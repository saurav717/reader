import { ownerFetch } from '../lib/owner';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { card, dollars, muted } from './AiUsage';
import type { DeepSeekAccount } from './AiUsage';
import type { TavilyAccount } from './WebUsage';
import type { CloudOverview } from './CloudUsage';
import type { UsageReport } from './UsageView';
import { GROUPS, GUIDES } from '../lib/usageGuide';
import type { UsageTab } from '../lib/usageGuide';
import { ChevronRightIcon } from './icons';

/**
 * The Usage page's Overview: every service Reader runs on, one card each —
 * what it is for, how it stands against its plan, and whether anything needs
 * the owner — with what needs attention first. Each card opens its tab.
 * It asks each service's own route once on opening and again at most every
 * couple of minutes; the people's tally comes from the page.
 */

type Tone = 'ok' | 'warn' | 'danger' | 'off' | 'unknown';
interface Status {
  tone: Tone;
  /** The headline: a number, or a word. */
  figure: ReactNode;
  /** Under it: against what, or why. */
  note: ReactNode;
  /** When it needs the owner: what to do, in a line. */
  attention?: string;
  /** The pill's words, where the tone's own would mislead. */
  label?: string;
}

const TONE_COLOR: Record<Tone, string> = { ok: 'var(--viz-1)', warn: 'var(--viz-2)', danger: 'var(--danger)', off: 'var(--muted)', unknown: 'var(--muted)' };
const TONE_LABEL: Record<Tone, string> = { ok: 'OK', warn: 'Near a limit', danger: 'Needs you', off: 'Not set up', unknown: 'Checking…' };

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const whole = (value: number) => Math.round(value).toLocaleString('en-US');
const toneOfShare = (share: number): Tone => (share >= 0.9 ? 'danger' : share >= 0.7 ? 'warn' : 'ok');

/** An owner route, asked on opening and again when the page refreshes, at most every `minMs`. undefined while waiting, null when it did not answer. */
function useOwnerJson<T>(path: string, refreshedAt: number, minMs = 120_000): T | null | undefined {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  const asked = useRef(0);
  useEffect(() => {
    if (asked.current && Date.now() - asked.current < minMs) return;
    asked.current = Date.now();
    let live = true;
    ownerFetch(path)
      .then((response) => (response.ok ? (response.json() as Promise<T>) : null))
      .then((answer) => live && setValue((before) => answer ?? before ?? null))
      .catch(() => live && setValue((before) => before ?? null));
    return () => {
      live = false;
    };
  }, [path, refreshedAt, minMs]);
  return value;
}

interface CloudflareMeters {
  configured: boolean;
  meters: { group: string; label: string; used: number | null; limit: number }[];
}
interface MailState {
  configured: boolean;
  providerName: string | null;
  limits: { daily: number | null; monthly: number | null };
  used: { today: number; month: number };
  log: { today: { failed: number } } | null;
  sender: { verified: boolean | null } | null;
  account: { error?: string } | null;
}
interface InvitesTotals {
  totals: { sent: number; converted: number };
}

const num = (value: unknown) => Number(value) || 0;

export default function UsageOverview({ report, days, refreshedAt, onOpen }: { report: UsageReport | null | undefined; days: number; refreshedAt: number; onOpen: (tab: UsageTab) => void }) {
  const cloudflare = useOwnerJson<CloudflareMeters>('/usage/cloudflare', refreshedAt);
  const mail = useOwnerJson<MailState>('/usage/mail', refreshedAt);
  const tavily = useOwnerJson<TavilyAccount>('/usage/tavily?days=30', refreshedAt);
  const deepseek = useOwnerJson<DeepSeekAccount>('/usage/deepseek?days=30', refreshedAt);
  const cloud = useOwnerJson<CloudOverview>('/usage/gcloud', refreshedAt, 300_000);
  const invites = useOwnerJson<InvitesTotals>('/usage/invites', refreshedAt);
  const totals = report?.totals ?? {};
  const period = days === 1 ? 'today' : `in the last ${days} days`;

  const status: Partial<Record<UsageTab, Status>> = {};

  // People: who signed in and used anything.
  status.people =
    report === undefined
      ? { tone: 'unknown', figure: '…', note: 'asking the proxy' }
      : report === null
      ? { tone: 'danger', figure: '—', note: 'the proxy did not answer', attention: 'The tally did not load: sign in again, or check that the proxy names your email as an owner.' }
      : { tone: 'ok', figure: whole(report.people.length), note: `${report.people.length === 1 ? 'person' : 'people'} used the paid features ${period} · ${whole(num(totals.signin))} sign-ins` };

  // Invitations: sent, and how many took.
  status.invites =
    invites === undefined
      ? { tone: 'unknown', figure: '…', note: 'reading the ledger' }
      : invites === null
      ? { tone: 'off', figure: '—', note: 'no INVITES ledger on this Worker' }
      : { tone: 'ok', figure: whole(invites.totals.sent), note: `invitations sent or made · ${whole(invites.totals.converted)} took` };

  // AI: what the answers cost, and DeepSeek's balance.
  const aiCost = num(totals.claude_cost) + num(totals.deepseek_cost) + num(totals.gemini_cost);
  const balance = deepseek?.configured ? deepseek.balance : null;
  status.ai =
    report === undefined
      ? { tone: 'unknown', figure: '…', note: 'asking the proxy' }
      : {
          tone: balance && !balance.available ? 'danger' : 'ok',
          figure: dollars(aiCost),
          note: (
            <>
              {whole(num(totals.claude) + num(totals.deepseek) + num(totals.gemini))} answers {period}
              {balance ? ` · DeepSeek balance ${balance.currency === 'CNY' ? '¥' : '$'}${balance.total.toFixed(2)}` : ''}
            </>
          ),
          attention: balance && !balance.available ? 'DeepSeek’s balance is too low to answer: top it up at platform.deepseek.com.' : undefined,
        };

  // Search: Scholar through Serply / SerpApi, and Tavily's plan for the Web button.
  const account = tavily?.configured ? tavily.account : null;
  const tavilyShare = account?.planLimit ? Math.min(1, account.planUsage / account.planLimit) : null;
  status.search =
    report === undefined && tavily === undefined
      ? { tone: 'unknown', figure: '…', note: 'asking the proxy' }
      : {
          tone: tavilyShare !== null ? toneOfShare(tavilyShare) : 'ok',
          figure: whole(num(totals.scholar) + num(totals.web)),
          note: (
            <>
              searches {period}: {whole(num(totals.scholar))} Scholar, {whole(num(totals.web))} web
              {account?.planLimit ? ` · Tavily ${whole(account.planUsage)} of ${whole(account.planLimit)} credits this cycle (${percent(tavilyShare!)})` : ''}
            </>
          ),
          attention:
            tavilyShare !== null && tavilyShare >= 0.9
              ? 'Tavily’s monthly credits are nearly spent: past them the Web button’s searches fail until the cycle resets, unless pay as you go is on at Tavily.'
              : undefined,
        };

  // Email: today against the daily sends, and refusals.
  const mailShare = mail?.configured && mail.limits.daily ? Math.min(1, mail.used.today / mail.limits.daily) : mail?.configured && mail.limits.monthly ? Math.min(1, mail.used.month / mail.limits.monthly) : null;
  const refused = mail?.log?.today.failed ?? 0;
  status.mail =
    mail === undefined
      ? { tone: 'unknown', figure: '…', note: 'asking the provider' }
      : mail === null
      ? { tone: 'unknown', figure: '—', note: 'the proxy did not answer' }
      : !mail.configured
      ? { tone: 'off', figure: 'Off', note: 'invitations are not emailed: the share dialog says to send the link by hand', attention: 'Email is not set up: set MAIL_API_KEY and MAIL_FROM to email invitations.' }
      : {
          tone: mail.sender?.verified === false ? 'danger' : refused ? 'warn' : mailShare !== null ? toneOfShare(mailShare) : 'ok',
          label: mail.sender?.verified === false ? 'Sender not verified' : refused && !(mailShare !== null && mailShare >= 0.7) ? `${refused} refused` : undefined,
          figure: mail.limits.daily ? `${whole(mail.used.today)} / ${whole(mail.limits.daily)}` : mail.limits.monthly ? `${whole(mail.used.month)} / ${whole(mail.limits.monthly)}` : whole(mail.used.today),
          note: `${mail.limits.daily ? 'emails today' : 'emails this month'} on ${mail.providerName}${refused ? ` · ${refused} refused today` : ''}`,
          attention:
            mail.sender?.verified === false
              ? `The sender in MAIL_FROM is not verified on ${mail.providerName}: invitations are refused until it is.`
              : refused
              ? `${refused} email${refused === 1 ? ' was' : 's were'} refused today — the Email tab says why.`
              : mailShare !== null && mailShare >= 0.9
              ? 'The day’s emails are nearly used up: past them, invitations go without an email until the limit resets.'
              : undefined,
        };

  // Cloudflare: the meter closest to its daily allowance.
  const measured = (cloudflare?.meters ?? []).filter((meter) => meter.used !== null && meter.limit);
  const closest = measured.reduce<CloudflareMeters['meters'][number] | null>((best, meter) => (!best || meter.used! / meter.limit > best.used! / best.limit ? meter : best), null);
  const cfShare = closest ? Math.min(1, closest.used! / closest.limit) : null;
  status.cloudflare =
    cloudflare === undefined
      ? { tone: 'unknown', figure: '…', note: 'asking Cloudflare' }
      : cloudflare === null
      ? { tone: 'unknown', figure: '—', note: 'the proxy did not answer' }
      : {
          tone: cfShare !== null ? toneOfShare(cfShare) : cloudflare.configured ? 'ok' : 'off',
          figure: cfShare !== null ? percent(cfShare) : '—',
          note: closest ? `closest to its limit: ${closest.group} ${closest.label.toLowerCase()}` : 'connect the account’s analytics to see Workers, Durable Objects and KV',
          attention: cfShare !== null && cfShare >= 0.9 ? `Cloudflare: ${closest!.group} ${closest!.label.toLowerCase()} is at ${percent(cfShare)} of today’s Free allowance.` : undefined,
        };

  // Google Cloud: this month's cost, billing, and services up.
  const costs = cloud?.costs;
  const services = cloud?.services ?? [];
  const running = services.filter((service) => service.status === 'running').length;
  const idleBilled = services.filter((service) => service.billedIdle && service.status === 'running').length;
  const currency = costs?.currency || cloud?.billing?.currency || 'USD';
  status.cloud =
    cloud === undefined
      ? { tone: 'unknown', figure: '…', note: 'asking Google Cloud' }
      : cloud === null
      ? { tone: 'unknown', figure: '—', note: 'the proxy did not answer' }
      : !cloud.configured
      ? { tone: 'off', figure: 'Off', note: 'connect the project to see its services, billing and cost' }
      : {
          tone: cloud.billing && cloud.billing.enabled === false ? 'danger' : idleBilled ? 'warn' : 'ok',
          figure: costs && costs.net !== undefined ? costs.net.toLocaleString('en-US', { style: 'currency', currency }) : `${running} of ${services.length}`,
          note: `${costs && costs.net !== undefined ? 'this month after credits · ' : ''}${running} of ${services.length} services running`,
          attention:
            cloud.billing && cloud.billing.enabled === false
              ? 'Google Cloud billing is off: the LaTeX compiler on Cloud Run stops working until it is on again.'
              : idleBilled
              ? `${idleBilled} Cloud Run service${idleBilled === 1 ? ' is' : 's are'} billed even while idle (minimum instances) — the Google Cloud tab shows which.`
              : undefined,
        };

  const attention = GROUPS.flatMap((group) => group.tabs)
    .map((tab) => ({ tab, status: status[tab] }))
    .filter((item): item is { tab: UsageTab; status: Status } => Boolean(item.status?.attention));

  return (
    <>
      <div
        style={{
          ...card,
          padding: '14px 16px',
          marginBottom: 20,
          ...(attention.length ? { border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border))' } : {}),
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>{attention.length ? `${attention.length} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} you` : 'Nothing needs you right now'}</div>
        {attention.length ? (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {attention.map(({ tab, status: item }) => (
              <li key={tab}>
                <strong style={{ fontWeight: 600 }}>{GUIDES[tab].title}:</strong> <span style={{ color: 'var(--ink-2)' }}>{item.attention}</span>{' '}
                <button type="button" onClick={() => onOpen(tab)} style={{ display: 'inline', padding: 0, border: 0, background: 'none', font: 'inherit', cursor: 'pointer', color: 'var(--accent, var(--ink))', textDecoration: 'underline' }}>
                  Open {GUIDES[tab].title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ ...muted, marginTop: 4, lineHeight: 1.5 }}>Every service that reports a limit is under 70% of it, and nothing has been refused today.</div>
        )}
      </div>

      {GROUPS.filter((group) => group.title).map((group) => (
        <section key={group.title} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{group.title}</h2>
            <span style={muted}>{group.about}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
            {group.tabs.map((tab) => (
              <ServiceCard key={tab} tab={tab} status={status[tab]} onOpen={() => onOpen(tab)} />
            ))}
          </div>
        </section>
      ))}

      <div style={{ ...card, padding: '14px 16px', fontSize: 13, lineHeight: 1.6 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 6px' }}>How to read this page</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)' }}>
          <li>
            <span style={{ color: TONE_COLOR.ok }}>Green</span> is under 70% of a limit, <span style={{ color: TONE_COLOR.warn }}>amber</span> 70–90%, and{' '}
            <span style={{ color: TONE_COLOR.danger }}>red</span> 90% or more, or something that has stopped working. Each tab marks its own meters the same way.
          </li>
          <li>Daily allowances (Cloudflare, Brevo) start again at 00:00 UTC; monthly ones on the plan’s own cycle, which each tab names.</li>
          <li>
            Counts by person come from your Worker’s own tally, kept 90 days. A provider’s own numbers (Tavily, DeepSeek, Cloudflare, Brevo, Google Cloud) cover the
            whole account, including anything used outside Koios with the same key.
          </li>
          <li>Only you see this page: the proxy answers it to its own token, or to a Google sign-in it names as an owner. It refreshes every 30 seconds while open.</li>
          <li>Each tab opens with an “About” panel: what the service is for, its limits, what happens past them, and how to set it up. Close it once you know it.</li>
        </ul>
      </div>
    </>
  );
}

function ServiceCard({ tab, status, onOpen }: { tab: UsageTab; status?: Status; onOpen: () => void }) {
  const guide = GUIDES[tab];
  const tone = status?.tone ?? 'unknown';
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ ...cardButton, ...card, ...(tone === 'danger' ? { border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border))' } : {}) }}
      aria-label={`${guide.title}: ${status?.label ?? TONE_LABEL[tone]} — open its tab`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{guide.title}</span>
        <span style={{ flexGrow: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: tone === 'off' || tone === 'unknown' ? 'var(--muted)' : TONE_COLOR[tone] }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_COLOR[tone] }} />
          {status?.label ?? TONE_LABEL[tone]}
        </span>
      </div>
      <div style={{ ...muted, fontSize: 12, marginTop: 3, lineHeight: 1.45 }}>{guide.purpose}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 10, color: tone === 'danger' ? 'var(--danger)' : undefined }}>{status?.figure ?? '…'}</div>
      <div style={{ ...muted, fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{status?.note ?? ''}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 10, fontSize: 12, color: 'var(--accent, var(--ink-2))' }}>
        Open {guide.title}
        <ChevronRightIcon size={12} />
      </div>
    </button>
  );
}

const cardButton = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  textAlign: 'left',
  padding: '14px 16px',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
  width: '100%',
  minWidth: 0,
} as const;
