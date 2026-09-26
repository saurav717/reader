import { Fragment, useEffect, useState } from 'react';
import { apiFetch, hasProxy } from '../lib/api';
import { ChartIcon, ChevronDownIcon, ChevronRightIcon } from './icons';

/** One person's counts, as the Worker's `/usage` reports them (worker/usage.js). */
interface Counts {
  signin?: number;
  scholar?: number;
  serply?: number;
  serpapi?: number;
  browser?: number;
  pdf?: number;
}
interface Person {
  email: string;
  total: Counts;
  today: Counts;
  daily?: (Counts & { day: string })[];
  days: number;
  last: number;
}
export interface UsageReport {
  since: string;
  until: string;
  people: Person[];
  totals: Counts;
}

/** The report for the last `days` days, or null — which is what anyone but the owner gets. */
async function fetchUsage(days: number): Promise<UsageReport | null> {
  if (!hasProxy()) return null;
  const response = await apiFetch(`/usage?days=${days}`);
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
export function useIsOwner(token: string): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    if (!token.trim()) {
      setOwner(false);
      return;
    }
    let cancelled = false;
    fetchUsage(1)
      .then((report) => !cancelled && setOwner(Boolean(report)))
      .catch(() => !cancelled && setOwner(false));
    return () => {
      cancelled = true;
    };
  }, [token]);
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
] as const;

/**
 * Who has used the proxy's paid accounts, and how much: everyone who has
 * signed in, their totals for the period, when they were last seen, and —
 * opened — each day on its own. A page of its own in the main area; the
 * owner's alone, since the rail shows its button only to them.
 */
export default function UsageView() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReport(undefined);
    fetchUsage(days)
      .then((answer) => !cancelled && setReport(answer))
      .catch(() => !cancelled && setReport(null));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const cell = { padding: '9px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const rule = '1px solid var(--border-soft)';

  return (
    <div className="main library-main" aria-label="Usage">
      <div className="collection-head">
        <div className="collection-titlebar">
          <span className="junk-mark">
            <ChartIcon size={18} />
          </span>
          <h1 className="collection-title">Usage</h1>
          <span style={{ flexGrow: 1 }} />
          <select className="chat-model" value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period">
            <option value={1}>Today</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        <p className="collection-sub">
          {report ? (
            <span>
              {report.people.length} {report.people.length === 1 ? 'person' : 'people'} · {report.since} to {report.until} (UTC)
            </span>
          ) : null}
          <span>what everyone signed in used on your accounts — only you see this</span>
        </p>
      </div>

      <div className="scroll" style={{ padding: '18px 32px 32px' }}>
        {report === undefined ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>Asking the proxy…</p>
        ) : report === null ? (
          <p className="banner error">The proxy did not answer with the tally. Sign in again, or check that your email is in READER_OWNERS.</p>
        ) : !report.people.length ? (
          <p style={{ fontSize: 14 }}>Nobody has used the paid features in this period.</p>
        ) : (
          <>
            <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }}>
              <thead>
                <tr style={{ color: 'var(--muted)', borderBottom: rule }}>
                  <th style={{ ...cell, textAlign: 'left', fontWeight: 500 }}>Who</th>
                  <th style={{ ...cell, fontWeight: 500 }}>Last seen</th>
                  <th style={{ ...cell, fontWeight: 500 }}>Days</th>
                  {COUNTED.map(([key, title]) => (
                    <th key={key} style={{ ...cell, fontWeight: 500 }}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.people.map((person) => {
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
                  <td style={{ ...cell, textAlign: 'left' }}>All</td>
                  <td style={cell} />
                  <td style={cell} />
                  {COUNTED.map(([key]) => (
                    <td key={key} style={cell}>
                      {report.totals[key] || 0}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6 }}>
              Click a person for each day. Serply credits and SerpApi searches are what each service charged; answers
              from the proxy’s five-minute cache cost nothing. Counted by your Worker, kept ninety days.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
