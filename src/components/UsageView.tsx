import { Fragment, useEffect, useState } from 'react';
import { apiFetch, hasProxy } from '../lib/api';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon } from './icons';

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
 * opened — each day on its own. The owner's alone; the rail shows its
 * button only to them.
 */
export default function UsageView({ onClose }: { onClose: () => void }) {
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

  const cell = { padding: '6px 10px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const rule = '1px solid var(--line, rgba(127,127,127,.3))';

  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Usage" style={{ maxWidth: 980, width: 'min(980px, calc(100vw - 32px))' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flexGrow: 1 }}>
            <h2>Usage</h2>
            <p className="lede">
              Everyone who has signed in, and what they used on your accounts. Serply credits and SerpApi searches
              are what each service charged; answers from the cache cost nothing. Only you see this.
            </p>
          </div>
          <select className="chat-model" value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period" style={{ marginTop: 6 }}>
            <option value={1}>Today</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close usage">
            <CloseIcon size={18} />
          </button>
        </div>

        {report === undefined ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>Asking the proxy…</p>
        ) : report === null ? (
          <p className="banner error">The proxy did not answer with the tally. Sign in again, or check that your email is in READER_OWNERS.</p>
        ) : !report.people.length ? (
          <p style={{ fontSize: 13 }}>Nobody has used the paid features from {report.since} to {report.until}.</p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
              {report.since} to {report.until} (UTC) · {report.people.length} {report.people.length === 1 ? 'person' : 'people'} · click a
              row for each day
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
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
                                style={{ color: 'var(--muted)', fontSize: 12, borderBottom: index === all.length - 1 ? rule : undefined }}
                              >
                                <td style={{ ...cell, textAlign: 'left', paddingLeft: 30 }}>{day.day}</td>
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
            </div>
          </>
        )}
      </div>
    </>
  );
}
