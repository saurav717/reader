import { ownerFetch } from '../lib/owner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart, SearchBox, card, cardHead, cardTitle, daysBetween, muted } from './AiUsage';
import LatexUsage from './LatexUsage';
import type { UsageReport } from './UsageView';
import { ExternalIcon } from './icons';

/**
 * The Usage page's Google Cloud tab: the owner's project as Google reports it
 * (worker/gcloud.js) — the billing account and a way to recharge it, every
 * Cloud Run service and VM with whether it is up and what it served, each
 * one's Start or Stop, what the month cost by service, and the charges and
 * credits behind it — and the LaTeX compiler's free tier, from the tally.
 */

export interface CloudService {
  kind: 'cloudrun' | 'vm';
  id: string;
  name: string;
  location: string;
  type: string;
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
  detail: string;
  url: string | null;
  updated: string | null;
  consoleUrl: string;
  minInstances?: number;
  requests?: number;
  instanceSeconds?: number;
  daily?: { day: string; n: number }[];
}

interface Charge {
  day: string;
  service: string;
  sku: string;
  type: string;
  currency: string;
  cost: number;
  credits: number;
  amount: number | null;
  unit: string;
}

interface Costs {
  error?: string;
  month?: string;
  currency?: string;
  cost?: number;
  credits?: number;
  net?: number;
  byService?: { service: string; cost: number; credits: number; net: number }[];
  days?: { day: string; net: number }[];
  charges?: Charge[];
}

export interface CloudOverview {
  configured: boolean;
  project?: string;
  at?: number;
  billing?: {
    error?: string;
    id?: string;
    name?: string;
    open?: boolean | null;
    enabled?: boolean;
    currency?: string | null;
    overviewUrl?: string;
    paymentUrl?: string;
    reportsUrl?: string;
  };
  services?: CloudService[];
  errors?: Record<string, string>;
  costs?: Costs | null;
}

const whole = (value: number) => Math.round(value).toLocaleString('en-US');
const hours = (seconds: number) => (seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`);
const money = (value: number, currency = 'USD') => value.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TONE: Record<CloudService['status'], string> = {
  running: 'var(--viz-1)',
  starting: 'var(--viz-2)',
  stopping: 'var(--viz-2)',
  stopped: 'var(--muted)',
  error: 'var(--danger)',
};

function StatusPill({ status }: { status: CloudService['status'] }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        padding: '2px 9px',
        borderRadius: 999,
        border: '1px solid var(--border)',
        color: status === 'stopped' ? 'var(--muted)' : TONE[status],
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: TONE[status] }} />
      {status[0].toUpperCase() + status.slice(1)}
    </span>
  );
}

const linkButton = { display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' } as const;

/** The overview, asked again when the page refreshes; null until the first answer. */
function useOverview(refreshedAt: number) {
  const [overview, setOverview] = useState<CloudOverview | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      const response = await ownerFetch('/usage/gcloud');
      const answer = response.ok ? ((await response.json()) as CloudOverview) : null;
      setOverview((before) => answer ?? before ?? null);
    } catch {
      setOverview((before) => before ?? null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [refreshedAt, load]);
  return [overview, load, setOverview] as const;
}

export default function CloudUsage({ report, refreshedAt }: { report: UsageReport | null | undefined; refreshedAt: number }) {
  const [overview, reload, setOverview] = useOverview(refreshedAt);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  /** Start or stop one service, then look again while Google brings it there. */
  const toggle = async (service: CloudService) => {
    const action = service.status === 'running' || service.status === 'starting' ? 'stop' : 'start';
    if (action === 'stop') {
      const what =
        service.kind === 'cloudrun'
          ? `Stop ${service.name}? It is closed to the internet: everything that calls it (the LaTeX compiler, if it is this one) fails until you start it again.`
          : `Stop the VM ${service.name}? Whatever runs on it stops; its disk is kept.`;
      if (!window.confirm(what)) return;
    }
    setBusy(service.id);
    setFailed(null);
    try {
      const response = await ownerFetch('/usage/gcloud/service', undefined, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: service.kind, id: service.id, action }),
      });
      const answer = (await response.json().catch(() => ({}))) as { status?: CloudService['status']; error?: string };
      if (!response.ok || !answer.status) throw new Error(answer.error || `the proxy answered ${response.status}`);
      setOverview((before) =>
        before ? { ...before, services: before.services?.map((one) => (one.id === service.id ? { ...one, status: answer.status! } : one)) } : before,
      );
      for (const wait of [4000, 12_000, 30_000]) timers.current.push(window.setTimeout(() => void reload(), wait));
    } catch (error) {
      setFailed(`${service.name}: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const costs = overview?.costs;
  const currency = costs?.currency || overview?.billing?.currency || 'USD';
  const charges = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = costs?.charges ?? [];
    return needle ? all.filter((charge) => `${charge.day} ${charge.service} ${charge.sku} ${charge.type}`.toLowerCase().includes(needle)) : all;
  }, [costs, query]);

  if (overview === undefined) return <p style={{ fontSize: 13, color: 'var(--muted)' }}>Asking Google Cloud…</p>;
  if (overview === null)
    return (
      <>
        <p className="banner error">The proxy did not answer for Google Cloud. Try Refresh, or check the Worker is deployed with worker/gcloud.js.</p>
        {report ? <LatexUsage report={report} refreshedAt={refreshedAt} /> : null}
      </>
    );
  if (!overview.configured) return <NotConfigured report={report} refreshedAt={refreshedAt} />;

  const services = overview.services ?? [];
  const running = services.filter((service) => service.status === 'running').length;
  const requests = services.reduce((sum, service) => sum + (service.requests || 0), 0);
  const billing = overview.billing ?? {};
  const cell = { padding: '9px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const head = { ...cell, fontWeight: 500, fontSize: 12.5, color: 'var(--muted)' };
  const rule = '1px solid var(--border-soft)';
  const tile = (label: string, value: ReactNode, note?: ReactNode) => (
    <div style={{ ...card, padding: '14px 16px', flex: '1 1 200px', minWidth: 0 }}>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {note ? <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>{note}</div> : null}
    </div>
  );
  const span = costs?.days?.length ? daysBetween(costs.days[0].day, costs.days[costs.days.length - 1].day).slice(-30) : [];
  const netByDay = new Map((costs?.days ?? []).map((day) => [day.day, day.net]));

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {tile(
          'Billing account',
          billing.error ? '—' : billing.name || 'None linked',
          billing.error ? (
            <span style={{ color: 'var(--danger)' }}>{billing.error}</span>
          ) : (
            <>
              {billing.id ? `${billing.id} · ` : ''}
              <span style={{ color: billing.enabled && billing.open !== false ? 'var(--viz-1)' : 'var(--danger)' }}>
                {billing.enabled ? (billing.open === false ? 'closed' : 'active') : 'billing off'}
              </span>
            </>
          ),
        )}
        {tile(
          `Cost this month${costs?.month ? ` · ${costs.month}` : ''}`,
          costs && !costs.error && costs.net !== undefined ? money(costs.net, currency) : '—',
          costs?.error ? (
            <span style={{ color: 'var(--danger)' }}>{costs.error}</span>
          ) : costs ? (
            `${money(costs.cost || 0, currency)} charged, ${money(Math.abs(costs.credits || 0), currency)} in credits`
          ) : (
            'set GCP_BILLING_EXPORT_TABLE to see cost'
          ),
        )}
        {tile('Services running', `${running} of ${services.length}`, `in ${overview.project}`)}
        {tile('Requests, 30 days', whole(requests), 'Cloud Run, as Cloud Monitoring counts them')}
      </div>

      <div style={{ ...card, marginTop: 16, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', fontSize: 13, lineHeight: 1.5 }}>
          <strong style={{ fontWeight: 600 }}>Recharge your billing account.</strong>{' '}
          <span style={{ color: 'var(--muted)' }}>
            Google takes payments only on its own page: Recharge opens the payment page for {billing.name || 'your billing account'} in the Cloud console, where you
            can make a payment or add funds.
          </span>
        </div>
        <a className="btn primary" href={billing.paymentUrl} target="_blank" rel="noreferrer" style={linkButton} aria-disabled={!billing.paymentUrl}>
          Recharge
          <ExternalIcon size={13} />
        </a>
        <a className="btn" href={billing.reportsUrl} target="_blank" rel="noreferrer" style={linkButton}>
          Billing reports
          <ExternalIcon size={13} />
        </a>
      </div>

      {failed ? (
        <p className="banner error" style={{ marginTop: 16 }}>
          Could not change {failed}
        </p>
      ) : null}

      <div style={{ ...card, marginTop: 16 }}>
        <div style={cardHead}>
          <h3 style={cardTitle}>Services</h3>
          <span style={{ ...muted }}>Cloud Run services and Compute Engine VMs in {overview.project}</span>
        </div>
        {Object.entries(overview.errors ?? {}).map(([part, message]) => (
          <p key={part} style={{ ...muted, color: 'var(--danger)', margin: 0, padding: '8px 16px', borderBottom: rule }}>
            {part === 'cloudrun' ? 'Cloud Run' : part === 'compute' ? 'Compute Engine' : 'Cloud Monitoring'}: {message}
          </p>
        ))}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: 'left' }}>Service</th>
                <th style={{ ...head, textAlign: 'left' }}>Status</th>
                <th style={{ ...head, textAlign: 'left' }}>Where</th>
                <th style={head}>Requests (30 d)</th>
                <th style={head}>Instance time (30 d)</th>
                <th style={head} />
              </tr>
            </thead>
            <tbody>
              {services.map((service) => {
                const up = service.status === 'running' || service.status === 'starting';
                const moving = service.status === 'starting' || service.status === 'stopping';
                return (
                  <tr key={service.id} style={{ borderTop: rule }}>
                    <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal' }}>
                      <div style={{ fontWeight: 500 }}>{service.name}</div>
                      <div style={{ ...muted, fontSize: 11.5 }}>
                        {service.type}
                        {service.detail ? ` · ${service.detail}` : ''}
                      </div>
                    </td>
                    <td style={{ ...cell, textAlign: 'left' }}>
                      <StatusPill status={service.status} />
                    </td>
                    <td style={{ ...cell, textAlign: 'left' }}>{service.location}</td>
                    <td style={cell}>
                      {service.kind === 'cloudrun' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Spark points={service.daily ?? []} />
                          {whole(service.requests || 0)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={cell}>{service.kind === 'cloudrun' ? hours(service.instanceSeconds || 0) : '—'}</td>
                    <td style={{ ...cell, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className={up ? 'btn sm danger' : 'btn sm primary'}
                        onClick={() => void toggle(service)}
                        disabled={busy === service.id || moving || service.status === 'error'}
                        style={{ minWidth: 62 }}
                      >
                        {busy === service.id ? '…' : moving ? (service.status === 'starting' ? 'Starting' : 'Stopping') : up ? 'Stop' : 'Start'}
                      </button>
                      <a className="btn sm" href={service.consoleUrl} target="_blank" rel="noreferrer" style={linkButton} title="Open in the Cloud console">
                        <ExternalIcon size={12} />
                      </a>
                    </td>
                  </tr>
                );
              })}
              {!services.length ? (
                <tr>
                  <td colSpan={6} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                    No Cloud Run services or VMs in this project.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p style={{ ...muted, fontSize: 11.5, margin: 0, padding: '10px 16px', borderTop: rule, lineHeight: 1.5 }}>
          Stop closes a Cloud Run service to the internet — with no minimum instances it then costs nothing — and Start opens it again. A VM is stopped and
          started as Compute Engine does it; a stopped VM still pays for its disk.
        </p>
      </div>

      {costs && !costs.error ? (
        <div style={{ ...card, marginTop: 16 }}>
          <div style={cardHead}>
            <h3 style={cardTitle}>Cost by service</h3>
            <span style={muted}>{costs.month}, after credits</span>
          </div>
          <div className="ai-usage-split">
            <div className="ai-usage-models" style={{ padding: '6px 0' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
                <tbody>
                  {(costs.byService ?? []).map((row) => (
                    <tr key={row.service}>
                      <td style={{ ...cell, textAlign: 'left', padding: '7px 16px' }}>{row.service}</td>
                      <td style={{ ...cell, padding: '7px 16px' }}>
                        {money(row.net, currency)}
                        {row.credits ? <div style={{ ...muted, fontSize: 11 }}>{money(row.cost, currency)} − credits</div> : null}
                      </td>
                    </tr>
                  ))}
                  {!costs.byService?.length ? (
                    <tr>
                      <td style={{ ...cell, textAlign: 'left', color: 'var(--muted)', padding: '7px 16px' }}>Nothing charged this month.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div style={{ flex: 1, minWidth: 0, padding: '14px 16px' }}>
              {span.length ? (
                <BarChart
                  title={`Cost per day, last ${span.length} days`}
                  days={span}
                  series={[{ label: 'Cost', color: 'var(--viz-1)', values: span.map((day) => Math.max(0, netByDay.get(day) || 0)) }]}
                  format={(value) => money(value, currency)}
                  axis={(value) => money(value, currency).replace(/\.00$/, '')}
                  height={150}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {costs && !costs.error ? (
        <div style={{ ...card, marginTop: 16 }}>
          <div style={cardHead}>
            <h3 style={cardTitle}>Transactions</h3>
            <span style={muted}>
              {charges.length === (costs.charges ?? []).length ? charges.length : `${charges.length} of ${(costs.charges ?? []).length}`} charges and credits, newest first
            </span>
            <span style={{ flexGrow: 1 }} />
            <SearchBox value={query} onChange={setQuery} label="Search service, item or date" />
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
              <thead>
                <tr>
                  {['Date', 'Service', 'Item', 'Usage', 'Charge', 'Credits', 'Net'].map((title, index) => (
                    <th key={title} style={{ ...head, textAlign: index < 3 ? 'left' : 'right', position: 'sticky', top: 0, background: 'var(--surface)', borderBottom: rule }}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {charges.map((charge, index) => (
                  <tr key={`${charge.day}-${charge.service}-${charge.sku}-${charge.type}-${index}`} style={{ borderTop: index ? rule : undefined }}>
                    <td style={{ ...cell, textAlign: 'left' }}>{charge.day}</td>
                    <td style={{ ...cell, textAlign: 'left' }}>{charge.service}</td>
                    <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal' }}>
                      {charge.sku}
                      {charge.type !== 'regular' ? <span style={{ ...muted, fontSize: 11 }}> · {charge.type}</span> : null}
                    </td>
                    <td style={{ ...cell, color: 'var(--muted)' }}>{charge.amount !== null ? `${+charge.amount.toPrecision(4)} ${charge.unit}` : ''}</td>
                    <td style={cell}>{money(charge.cost, charge.currency)}</td>
                    <td style={{ ...cell, color: charge.credits ? 'var(--viz-1)' : 'var(--muted)' }}>{charge.credits ? money(charge.credits, charge.currency) : '—'}</td>
                    <td style={{ ...cell, fontWeight: 500 }}>{money(charge.cost + charge.credits, charge.currency)}</td>
                  </tr>
                ))}
                {!charges.length ? (
                  <tr>
                    <td colSpan={7} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                      {query ? `Nothing matches “${query}”.` : 'No charges in the last 90 days.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p style={{ ...muted, fontSize: 11.5, margin: 0, padding: '10px 16px', borderTop: rule, lineHeight: 1.5 }}>
            From the billing export in BigQuery, a few hours behind Google’s own count. Payments you made are on the{' '}
            <a href={billing.paymentUrl} target="_blank" rel="noreferrer">
              payment page
            </a>
            .
          </p>
        </div>
      ) : null}

      {report ? <LatexUsage report={report} refreshedAt={refreshedAt} /> : null}
    </>
  );
}

/** A day-by-day line of a service's requests, small enough for a table cell. */
function Spark({ points }: { points: { day: string; n: number }[] }) {
  if (points.length < 2) return null;
  const width = 72;
  const height = 20;
  const top = Math.max(1, ...points.map((point) => point.n));
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${((index / (points.length - 1)) * width).toFixed(1)},${(height - 2 - (point.n / top) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="var(--viz-1)" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

function NotConfigured({ report, refreshedAt }: { report: UsageReport | null | undefined; refreshedAt: number }) {
  return (
    <>
      <div style={{ ...card, padding: '16px 18px', fontSize: 13.5, lineHeight: 1.6 }}>
        <h3 style={{ ...cardTitle, marginBottom: 6 }}>Connect your Google Cloud project</h3>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          This tab reads your project as a service account. Give the Worker its key as the secret <code>GCP_SERVICE_ACCOUNT_KEY</code>, and for cost and
          transactions name your billing export in <code>GCP_BILLING_EXPORT_TABLE</code> — the steps are in docs/deploy.md, “Google Cloud on the Usage
          page”.
        </p>
      </div>
      {report ? <LatexUsage report={report} refreshedAt={refreshedAt} /> : null}
    </>
  );
}
