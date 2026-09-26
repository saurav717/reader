import { useEffect, useState } from 'react';
import { apiFetch, hasProxy } from '../lib/api';

/** One person's tally, as the Worker's `/usage` reports it (worker/usage.js). */
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
  days: number;
  last: number;
}
interface Report {
  since: string;
  until: string;
  people: Person[];
  totals: Counts;
}

const ago = (at: number) => {
  if (!at) return '—';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

const COLUMNS: [string, (person: Person) => string | number][] = [
  ['Who', (person) => person.email],
  ['Last seen', (person) => ago(person.last)],
  ['Sign-ins', (person) => person.total.signin || 0],
  ['Scholar', (person) => person.total.scholar || 0],
  ['Serply credits', (person) => person.total.serply || 0],
  ['SerpApi searches', (person) => person.total.serpapi || 0],
  ['Browser', (person) => person.total.browser || 0],
  ['PDFs', (person) => person.total.pdf || 0],
  ['Scholar today', (person) => person.today.scholar || 0],
];

/**
 * Who has used the proxy's paid accounts, and how much — for the owner
 * only. The Worker answers `/usage` to READER_TOKEN, or to the Google
 * sign-in of someone named in READER_OWNERS; to anyone else it says no,
 * and then this shows nothing at all.
 */
export default function UsagePanel({ token }: { token: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (!hasProxy() || !token.trim()) {
      setReport(null);
      return;
    }
    let cancelled = false;
    apiFetch(`/usage?days=${days}`)
      .then((response) => (response.ok ? (response.json() as Promise<Report>) : null))
      .then((answer) => {
        if (!cancelled) setReport(answer && Array.isArray(answer.people) ? answer : null);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, days]);

  if (!report) return null;

  const cell = { padding: '4px 8px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Usage
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
        Who has used the proxy’s paid accounts, {report.since} to {report.until} (UTC). Only you see this. Serply credits
        and SerpApi searches are what each was charged for; answers from the cache cost nothing.{' '}
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period">
          <option value={1}>Today</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </p>
      {report.people.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line, rgba(127,127,127,.3))' }}>
                {COLUMNS.map(([title], index) => (
                  <th key={title} style={{ ...cell, fontWeight: 500, textAlign: index === 0 ? 'left' : 'right' }}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.people.map((person) => (
                <tr key={person.email}>
                  {COLUMNS.map(([title, value], index) => (
                    <td key={title} style={{ ...cell, textAlign: index === 0 ? 'left' : 'right' }}>
                      {value(person)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--line, rgba(127,127,127,.3))', fontWeight: 600 }}>
                <td style={{ ...cell, textAlign: 'left' }}>All</td>
                <td style={cell} />
                {(['signin', 'scholar', 'serply', 'serpapi', 'browser', 'pdf'] as const).map((name) => (
                  <td key={name} style={cell}>
                    {report.totals[name] || 0}
                  </td>
                ))}
                <td style={cell} />
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5 }}>Nobody has used the paid features in that time.</p>
      )}
    </section>
  );
}
