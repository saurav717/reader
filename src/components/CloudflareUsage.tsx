import { ownerFetch } from '../lib/owner';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { card, cardHead, cardTitle, muted } from './AiUsage';

/**
 * The Usage page's Cloudflare tab: what the account has used today of each
 * Workers Free allowance — Workers, Durable Objects, KV and the browser —
 * and how close it is to the limit, with the week before (worker/cloudflare.js).
 */

interface Meter {
  id: string;
  group: string;
  label: string;
  unit: 'count' | 'bytes' | 'seconds' | 'gbs';
  limit: number;
  period: 'day' | 'stored';
  used: number | null;
  daily: { day: string; n: number }[];
  detail?: string;
  error?: string;
}

interface Overview {
  configured: boolean;
  plan: string;
  at: number;
  day: string;
  resetsInMs: number;
  meters: Meter[];
  browser: { open: number; max: number | null; allowed: number | null; nextInMs: number } | null;
}

const GROUPS = ['Workers', 'Durable Objects', 'KV', 'Browser Rendering'];

function amount(value: number, unit: Meter['unit']) {
  if (unit === 'bytes') {
    const steps = ['B', 'KB', 'MB', 'GB'];
    let at = value;
    let step = 0;
    while (at >= 1024 && step < steps.length - 1) {
      at /= 1024;
      step += 1;
    }
    return `${+at.toFixed(at < 10 && step ? 2 : 0)} ${steps[step]}`;
  }
  if (unit === 'seconds') return value >= 60 ? `${+(value / 60).toFixed(1)} min` : `${Math.round(value)} s`;
  if (unit === 'gbs') return `${Math.round(value).toLocaleString('en-US')} GB-s`;
  return Math.round(value).toLocaleString('en-US');
}

const shareOf = (meter: Meter) => (meter.used === null || !meter.limit ? null : Math.min(1, meter.used / meter.limit));
const toneOf = (share: number) => (share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)');
const percent = (share: number) => (share > 0 && share < 0.001 ? '<0.1%' : `${Math.round(share * 1000) / 10}%`);

function until(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** The overview, asked again when the page refreshes; null until the first answer. */
function useOverview(refreshedAt: number) {
  const [overview, setOverview] = useState<Overview | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      const response = await ownerFetch('/usage/cloudflare');
      const answer = response.ok ? ((await response.json()) as Overview) : null;
      setOverview((before) => answer ?? before ?? null);
    } catch {
      setOverview((before) => before ?? null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [refreshedAt, load]);
  return overview;
}

export default function CloudflareUsage({ refreshedAt }: { refreshedAt: number }) {
  const overview = useOverview(refreshedAt);
  if (overview === undefined) return <p style={{ fontSize: 13, color: 'var(--muted)' }}>Asking Cloudflare…</p>;
  if (overview === null)
    return <p className="banner error">The proxy did not answer for Cloudflare. Try Refresh, or check the Worker is deployed with worker/cloudflare.js.</p>;

  const measured = overview.meters.filter((meter) => shareOf(meter) !== null);
  const closest = measured.reduce<Meter | null>((best, meter) => (!best || shareOf(meter)! > shareOf(best)! ? meter : best), null);
  const near = measured.filter((meter) => shareOf(meter)! >= 0.7);
  const browser = overview.browser;
  const tile = (label: string, value: ReactNode, note?: ReactNode) => (
    <div style={{ ...card, padding: '14px 16px', flex: '1 1 200px', minWidth: 0 }}>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {note ? <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>{note}</div> : null}
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {tile(
          'Closest to its limit',
          closest ? <span style={{ color: toneOf(shareOf(closest)!) }}>{percent(shareOf(closest)!)}</span> : '—',
          closest ? `${closest.group} · ${closest.label.toLowerCase()}` : 'nothing measured yet',
        )}
        {tile(
          'Near a limit',
          near.length ? <span style={{ color: 'var(--danger)' }}>{near.length}</span> : 'None',
          near.length ? near.map((meter) => `${meter.group} ${meter.label.toLowerCase()}`).join(', ') : 'everything is under 70% of its allowance',
        )}
        {tile('Daily allowances reset in', until(overview.resetsInMs), `at 00:00 UTC · today is ${overview.day}`)}
        {tile(
          'Browsers open now',
          browser ? `${browser.open}${browser.max !== null ? ` of ${browser.max}` : ''}` : '—',
          browser
            ? browser.nextInMs
              ? `a new one may start in ${Math.ceil(browser.nextInMs / 1000)} s`
              : `${browser.allowed ?? '—'} more may start this minute`
            : 'Browser Rendering did not say',
        )}
      </div>

      {!overview.configured ? (
        <div style={{ ...card, padding: '16px 18px', fontSize: 13.5, lineHeight: 1.6, marginTop: 16 }}>
          <h3 style={{ ...cardTitle, marginBottom: 6 }}>Connect your Cloudflare account</h3>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            The browser’s time is below without anything more. For Workers, Durable Objects and KV the Worker reads Cloudflare’s analytics: give it an API
            token with <em>Account Analytics: Read</em> as the secret <code>CLOUDFLARE_API_TOKEN</code>, and your account ID in <code>CLOUDFLARE_ACCOUNT_ID</code> —
            the steps are in docs/deploy.md, “Cloudflare on the Usage page”.
          </p>
        </div>
      ) : null}

      {GROUPS.map((group) => {
        const meters = overview.meters.filter((meter) => meter.group === group);
        if (!meters.length) return null;
        return (
          <div key={group} style={{ ...card, marginTop: 16 }}>
            <div style={cardHead}>
              <h3 style={cardTitle}>{group}</h3>
              <span style={muted}>Workers Free plan · today against the daily allowance, and the last {meters[0].daily.length || 7} days</span>
            </div>
            {meters.map((meter, index) => (
              <MeterRow key={meter.id} meter={meter} first={!index} />
            ))}
          </div>
        );
      })}

      <p style={{ ...muted, fontSize: 11.5, marginTop: 16, lineHeight: 1.5 }}>
        Counts are for the whole Cloudflare account, every Worker on it, as Cloudflare’s analytics have them — a few minutes behind. Past a daily allowance on the
        Free plan, Cloudflare refuses the rest of the day: a Worker answers with an error page, KV and Durable Objects fail the operation, and the browser
        will not start (429) until 00:00 UTC. Storage is a total, not a daily allowance.
      </p>
    </>
  );
}

function MeterRow({ meter, first }: { meter: Meter; first: boolean }) {
  const share = shareOf(meter);
  const tone = share === null ? 'var(--muted)' : toneOf(share);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '12px 16px', borderTop: first ? undefined : '1px solid var(--border-soft)' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 500, fontSize: 13.5 }}>{meter.label}</span>
          <span style={{ ...muted, fontSize: 12 }}>{meter.period === 'stored' ? 'held now' : 'today'}</span>
          <span style={{ flexGrow: 1 }} />
          {meter.used !== null ? (
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
              {amount(meter.used, meter.unit)}
              <span style={{ ...muted, marginLeft: 4 }}>
                of {amount(meter.limit, meter.unit)}
                {meter.period === 'day' ? ' a day' : ''}
              </span>
              {share !== null ? <span style={{ marginLeft: 8, color: tone, fontWeight: 500 }}>{percent(share)}</span> : null}
            </span>
          ) : null}
        </div>
        {meter.error ? (
          <div style={{ ...muted, fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{meter.error}</div>
        ) : (
          <>
            <div
              role="meter"
              aria-label={`${meter.group} ${meter.label.toLowerCase()} against the Free plan`}
              aria-valuemin={0}
              aria-valuemax={meter.limit}
              aria-valuenow={meter.used ?? 0}
              style={{ height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }}
            >
              <div style={{ width: `${(share ?? 0) * 100}%`, minWidth: share ? 2 : 0, height: '100%', background: tone, borderRadius: 3 }} />
            </div>
            <div style={{ ...muted, fontSize: 11.5, marginTop: 5 }}>
              {meter.used !== null ? `${amount(Math.max(0, meter.limit - meter.used), meter.unit)} left${meter.period === 'day' ? ' today' : ''}` : ''}
              {meter.detail ? ` · ${meter.detail}` : ''}
            </div>
          </>
        )}
      </div>
      {meter.period === 'day' && meter.daily.length > 1 ? <Week meter={meter} /> : null}
    </div>
  );
}

/** The last days as small bars, the allowance as the top of the box; a day over 70% in its warning color. */
function Week({ meter }: { meter: Meter }) {
  const width = 112;
  const height = 30;
  const slot = width / meter.daily.length;
  return (
    <svg width={width} height={height} role="img" aria-label={`${meter.label}, last ${meter.daily.length} days`} style={{ display: 'block', flex: 'none' }}>
      <line x1={0} x2={width} y1={0.5} y2={0.5} stroke="var(--border)" strokeDasharray="3 3" />
      {meter.daily.map((point, index) => {
        const share = Math.min(1, point.n / meter.limit);
        const tall = point.n > 0 ? Math.max(1.5, share * (height - 2)) : 0;
        return (
          <rect key={point.day} x={index * slot + slot * 0.2} y={height - tall} width={slot * 0.6} height={tall} rx={1} fill={toneOf(share)}>
            <title>
              {point.day}: {amount(point.n, meter.unit)} ({percent(share)})
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
