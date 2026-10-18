import InvitesReportView from './InvitesReport';
import { ownerFetch } from '../lib/owner';
import LookSwitch from './LookSwitch';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasProxy } from '../lib/api';
import AiUsage, { ROW_HEIGHT, ROWS_IN_VIEW, SearchBox, SortControl, SortHeading, card, cardHead, cardTitle, useSort } from './AiUsage';
import WebUsage from './WebUsage';
import CloudUsage from './CloudUsage';
import CloudflareUsage from './CloudflareUsage';
import MailUsage from './MailUsage';
import UsageOverview from './UsageOverview';
import UsageGuide from './UsageGuide';
import { GROUPS, GUIDES, TABS } from '../lib/usageGuide';
import type { UsageTab } from '../lib/usageGuide';
import type { SortOption } from './AiUsage';
import { ChartIcon, ChevronDownIcon, ChevronRightIcon, RestoreIcon } from './icons';
import { KEEP_DAYS, addDays, dayOf, daysSpanned, resolvePeriod, sliceReport } from '../lib/usagePeriod';
import type { AiPeriod } from '../lib/usagePeriod';

/** One person's counts, as the Worker's `/usage` reports them (worker/usage.js). */
interface Counts {
  signin?: number;
  scholar?: number;
  serply?: number;
  serpapi?: number;
  browser?: number;
  pdf?: number;
  /** Web searches for Ask AI. */
  web?: number;
  /** Papers compiled on the LaTeX compiler, and the runner's seconds on them. */
  latex?: number;
  latex_s?: number;
  /** Ask AI and Explain: answers, tokens in and out, and cost in millionths of a dollar. */
  claude?: number;
  claude_in?: number;
  claude_out?: number;
  claude_cost?: number;
  deepseek?: number;
  deepseek_in?: number;
  deepseek_out?: number;
  deepseek_cost?: number;
  gemini?: number;
  gemini_in?: number;
  gemini_out?: number;
  gemini_cost?: number;
}
/** One model's answers: how many, the tokens in and out, and the cost in millionths of a dollar. */
export interface ModelCounts {
  n: number;
  in: number;
  out: number;
  cost: number;
}
export type ByModel = Record<string, ModelCounts>;
interface Person {
  email: string;
  total: Counts;
  today: Counts;
  daily?: (Counts & { day: string; models?: ByModel })[];
  days: number;
  last: number;
  models?: ByModel;
}
export interface UsageReport {
  since: string;
  until: string;
  people: Person[];
  totals: Counts;
  models?: ByModel;
}

/** The report for the last `days` days, or null — which is what anyone but the owner gets. */
async function fetchUsage(days: number, token?: string): Promise<UsageReport | null> {
  if (!hasProxy()) return null;
  const response = await ownerFetch(`/usage?days=${days}`, token);
  if (!response.ok) return null;
  const answer = (await response.json()) as UsageReport;
  return Array.isArray(answer?.people) ? answer : null;
}

/**
 * Whether whoever is using the reader owns its proxy: the Worker answers
 * `/usage` to READER_TOKEN, or to the Google sign-in of someone named in
 * READER_OWNERS, and to nobody else. Asked again whenever the token (or the
 * pass a sign-in fills in) changes.
 */
export function useIsOwner(token: string, signedInAs?: string | null): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    // A pass or token to show, or a Google sign-in: the owner is known by either.
    if (!token.trim() && !signedInAs) {
      setOwner(false);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const ask = (triesLeft: number) =>
      fetchUsage(1, token)
        .then((report) => !cancelled && setOwner(Boolean(report)))
        .catch(() => {
          // Not an answer (offline, the Worker waking): ask again in a while rather than hide Usage for good.
          if (cancelled) return;
          setOwner(false);
          if (triesLeft > 0) timer = window.setTimeout(() => void ask(triesLeft - 1), 5000);
        });
    void ask(3);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [token, signedInAs]);
  return owner;
}

const ago = (at: number) => {
  if (!at) return '—';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

const COUNTED = [
  ['signin', 'Sign-ins'],
  ['scholar', 'Scholar'],
  ['serply', 'Serply credits'],
  ['serpapi', 'SerpApi searches'],
  ['browser', 'Browser'],
  ['pdf', 'PDFs'],
  ['web', 'Web searches'],
] as const;

/** What the services list can be sorted on: every column. */
const SERVICE_SORTS: SortOption<Person>[] = [
  ...COUNTED.map(([key, title]) => ({ id: key as string, label: title as string, value: (person: Person) => person.total[key] || 0 })),
  { id: 'last', label: 'Last seen', value: (person) => person.last || 0 },
  { id: 'days', label: 'Days active', value: (person) => person.days || 0 },
  { id: 'email', label: 'Email', value: (person) => person.email },
];

/**
 * Who has used the proxy's paid accounts, and how much: everyone who has
 * signed in, their totals for the period, when they were last seen, and —
 * opened — each day on its own. A page of its own in the main area; the
 * owner's alone, since the rail shows its button only to them.
 */
/** How often the page asks again while it is open and in view. */
export const REFRESH_MS = 30_000;

/** The page's tabs, grouped (src/lib/usageGuide.ts): the Overview, then the people, the services Reader pays for, and what it runs on. */
const TAB_KEY = 'reader.usageTab';
/** The tabs that read the people's tally, and so follow the period picker. */
const PERIOD_TABS: UsageTab[] = ['overview', 'people', 'ai', 'search'];

function rememberedTab(): UsageTab {
  try {
    const kept = window.localStorage.getItem(TAB_KEY) as UsageTab | null;
    return kept && (TABS as string[]).includes(kept) ? kept : 'overview';
  } catch {
    return 'overview';
  }
}

/** The Search tab's head: Scholar through the paid services over the period, from the tally. */
function ScholarSummary({ report }: { report: UsageReport }) {
  const totals = report.totals;
  const askers = report.people.filter((person) => (person.total.scholar || 0) > 0).length;
  const stat = (label: string, value: number, note: string) => (
    <div style={{ minWidth: 150 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value.toLocaleString('en-US')}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{note}</div>
    </div>
  );
  return (
    <div style={card}>
      <div style={cardHead}>
        <h3 style={cardTitle}>Google Scholar</h3>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>through Serply and SerpApi, {report.since} to {report.until}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, padding: '14px 16px' }}>
        {stat('Scholar asks', totals.scholar || 0, `by ${askers} ${askers === 1 ? 'person' : 'people'}`)}
        {stat('Serply credits', totals.serply || 0, 'of 2,500 free a month')}
        {stat('SerpApi searches', totals.serpapi || 0, 'against your SerpApi plan')}
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, padding: '0 16px 14px', lineHeight: 1.6 }}>
        From your Worker’s tally; each service’s own dashboard has the month’s exact balance. The People tab says who asked.
      </p>
    </div>
  );
}

export default function UsageView() {
  const [tab, setTab] = useState<UsageTab>(rememberedTab);
  const pickTab = (next: UsageTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      // Not kept: the page opens on the Overview next time.
    }
  };
  const [days, setDays] = useState(30);
  // The AI credits' own period; the page's until another is picked there.
  const [aiPeriod, setAiPeriod] = useState<AiPeriod>({ preset: 'page', from: '', to: null });
  const today = dayOf(Date.now());
  const aiRange = resolvePeriod(aiPeriod, days, today);
  // One ask covers both: back far enough for the page's period and the AI credits'.
  const asked = Math.min(KEEP_DAYS, Math.max(days, daysSpanned(aiRange.since, today)));
  const [full, setReport] = useState<UsageReport | null | undefined>(undefined);
  const report = useMemo(() => (full ? sliceReport(full, addDays(full.until, -(days - 1)), full.until) : full), [full, days]);
  const aiReport = useMemo(() => (full ? sliceReport(full, aiRange.since, aiRange.until) : full), [full, aiRange.since, aiRange.until]);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Most Scholar asks first, as the Worker orders it, until another order is picked.
  const sorting = useSort(SERVICE_SORTS, { by: 'scholar', dir: 'desc' });
  const [updatedAt, setUpdatedAt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // The period of the answer being waited for, so an answer for a period
  // since changed is dropped rather than shown under the new one.
  const asking = useRef(asked);

  /**
   * Ask the proxy again. A refresh keeps the table on screen while it waits;
   * only the first ask starts from "Asking…" — a new period is cut from the
   * last answer until the next one is in. A refresh that fails keeps the
   * last numbers rather than blanking them.
   */
  const load = useCallback(async (period: number, fresh: boolean) => {
    asking.current = period;
    if (fresh) setReport(undefined);
    setRefreshing(true);
    try {
      const answer = await fetchUsage(period);
      if (asking.current !== period) return;
      if (answer || fresh) setReport(answer);
      if (answer) setUpdatedAt(Date.now());
    } catch {
      if (asking.current === period && fresh) setReport(null);
    } finally {
      if (asking.current === period) setRefreshing(false);
    }
  }, []);

  const first = useRef(true);
  useEffect(() => {
    void load(asked, first.current);
    first.current = false;
  }, [asked, load]);

  // Every thirty seconds while the page is open and the tab is in view — a
  // hidden tab asks nothing — and at once on coming back to it, if the
  // numbers are older than that. Each ask is one request to the Worker and
  // one read of the tally; nothing paid.
  const lastAsked = useRef(0);
  lastAsked.current = updatedAt;
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const timer = setInterval(() => {
      if (visible()) void load(asked, false);
    }, REFRESH_MS);
    const onVisibility = () => {
      if (visible() && Date.now() - lastAsked.current >= REFRESH_MS) void load(asked, false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [asked, load]);

  const cell = { padding: '0 12px', height: ROW_HEIGHT, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const rule = '1px solid var(--border-soft)';
  // The header stays in view as the box scrolls, and the totals row at its foot.
  const head = { ...cell, fontWeight: 500, fontSize: 12.5, position: 'sticky' as const, top: 0, background: 'var(--panel)', zIndex: 1, borderBottom: rule };
  const foot = { ...cell, position: 'sticky' as const, bottom: 0, background: 'var(--panel)', borderTop: rule };
  const needle = query.trim().toLowerCase();
  const shown = report ? sorting.sort(needle ? report.people.filter((person) => person.email.toLowerCase().includes(needle)) : report.people) : [];

  return (
    <div className="main library-main" aria-label="Usage">
      <div className="collection-head">
        <div className="collection-titlebar">
          <span className="junk-mark">
            <ChartIcon size={18} />
          </span>
          <h1 className="collection-title">Usage</h1>
          <span style={{ flexGrow: 1 }} />
          {updatedAt ? (
            <span style={{ fontSize: 12, color: 'var(--muted)' }} title="Refreshes every 30 seconds while this page is open and in view">
              Updated {new Date(updatedAt).toLocaleTimeString()}
            </span>
          ) : null}
          <button
            type="button"
            className="btn sm"
            onClick={() => void load(asked, false)}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh now"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <RestoreIcon size={14} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {PERIOD_TABS.includes(tab) ? (
          <select className="chat-model" value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period">
            <option value={1}>Today</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          ) : null}
        </div>
        <nav className="usage-tabs" role="tablist" aria-label="Usage">
          {GROUPS.map((group) => (
            <div key={group.title || 'top'} className="usage-tab-group">
              {group.title ? <span className="usage-tab-group-label">{group.title}</span> : null}
              <div className="segmented">
                {group.tabs.map((id) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => pickTab(id)}>
                    {GUIDES[id].tab}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <p className="collection-sub">
          {report && PERIOD_TABS.includes(tab) ? (
            <span>
              {report.people.length} {report.people.length === 1 ? 'person' : 'people'} · {report.since} to {report.until} (UTC)
            </span>
          ) : null}
          <span>{GUIDES[tab].subtitle} — only you see this</span>
        </p>
      </div>

      <div className="scroll" style={{ padding: '18px 32px 32px' }}>
        {tab !== 'overview' ? <UsageGuide key={tab} guide={GUIDES[tab]} /> : null}
        {tab === 'overview' ? (
          <UsageOverview report={report} days={days} refreshedAt={updatedAt} onOpen={pickTab} />
        ) : tab === 'invites' ? (
          <InvitesReportView />
        ) : tab === 'cloud' ? (
          <CloudUsage report={report} refreshedAt={updatedAt} />
        ) : tab === 'cloudflare' ? (
          <CloudflareUsage refreshedAt={updatedAt} />
        ) : tab === 'mail' ? (
          <MailUsage refreshedAt={updatedAt} />
        ) : tab === 'look' ? (
          <LookSwitch />
        ) : report === undefined ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>Asking the proxy…</p>
        ) : report === null ? (
          <p className="banner error">The proxy did not answer with the tally. Sign in again, or check that your email is in READER_OWNERS.</p>
        ) : tab === 'ai' ? (
          aiReport ? <AiUsage report={aiReport} period={aiPeriod} range={aiRange} onPeriod={setAiPeriod} /> : null
        ) : tab === 'search' ? (
          <>
            <ScholarSummary report={report} />
            <WebUsage report={report} days={days} refreshedAt={updatedAt} />
          </>
        ) : (
          <>
            {!report.people.length ? (
              <p style={{ fontSize: 14 }}>Nobody has used the paid features in this period.</p>
            ) : (
              <>
                <div style={card}>
                  <div style={cardHead}>
                    <h3 style={cardTitle}>Services</h3>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                      {shown.length === report.people.length ? report.people.length : `${shown.length} of ${report.people.length}`}
                    </span>
                    <span style={{ flexGrow: 1 }} />
                    <SortControl options={SERVICE_SORTS} by={sorting.by} dir={sorting.dir} onPick={sorting.pick} onDir={sorting.setDir} />
                    <SearchBox value={query} onChange={setQuery} />
                  </div>
                  <div style={{ maxHeight: ROW_HEIGHT * (ROWS_IN_VIEW + 2) + 2, overflow: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }}>
                      <thead>
                        <tr style={{ color: 'var(--muted)' }}>
                          <SortHeading id="email" label="Who" by={sorting.by} dir={sorting.dir} onPick={sorting.pick} style={{ ...head, textAlign: 'left' }} />
                          <SortHeading id="last" label="Last seen" by={sorting.by} dir={sorting.dir} onPick={sorting.pick} style={head} />
                          <SortHeading id="days" label="Days" by={sorting.by} dir={sorting.dir} onPick={sorting.pick} style={head} />
                          {COUNTED.map(([key, title]) => (
                            <SortHeading key={key} id={key} label={title} by={sorting.by} dir={sorting.dir} onPick={sorting.pick} style={head} />
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {!shown.length ? (
                          <tr>
                            <td colSpan={3 + COUNTED.length} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                              No email matches “{query}”.
                            </td>
                          </tr>
                        ) : null}
                        {shown.map((person) => {
                          const expanded = open === person.email;
                          return (
                            <Fragment key={person.email}>
                              <tr
                                onClick={() => setOpen(expanded ? null : person.email)}
                                style={{ cursor: 'pointer', borderBottom: expanded ? undefined : rule }}
                                aria-expanded={expanded}
                                title={expanded ? 'Hide their days' : 'Show each day'}
                              >
                                <td style={{ ...cell, textAlign: 'left' }}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                    {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                                    {person.email}
                                  </span>
                                </td>
                                <td style={cell}>{ago(person.last)}</td>
                                <td style={cell}>{person.days}</td>
                                {COUNTED.map(([key]) => (
                                  <td key={key} style={cell}>
                                    {person.total[key] || 0}
                                  </td>
                                ))}
                              </tr>
                              {expanded
                                ? (person.daily || []).map((day, index, all) => (
                                    <tr
                                      key={day.day}
                                      style={{ color: 'var(--muted)', fontSize: 12.5, borderBottom: index === all.length - 1 ? rule : undefined }}
                                    >
                                      <td style={{ ...cell, textAlign: 'left', paddingLeft: 32 }}>{day.day}</td>
                                      <td style={cell} />
                                      <td style={cell} />
                                      {COUNTED.map(([key]) => (
                                        <td key={key} style={cell}>
                                          {day[key] || 0}
                                        </td>
                                      ))}
                                    </tr>
                                  ))
                                : null}
                            </Fragment>
                          );
                        })}
                        <tr style={{ fontWeight: 600 }}>
                          <td style={{ ...foot, textAlign: 'left' }}>{needle ? `All ${report.people.length} people` : 'All'}</td>
                          <td style={foot} />
                          <td style={foot} />
                          {COUNTED.map(([key]) => (
                            <td key={key} style={foot}>
                              {report.totals[key] || 0}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6 }}>
                  Click a person for each day. Serply credits and SerpApi searches are what each service charged; answers
                  from the proxy’s five-minute cache cost nothing. Counted by your Worker, kept ninety days; this page asks
                  again every thirty seconds while it is open.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
