import { ownerFetch } from '../lib/owner';
import { useEffect, useRef, useState } from 'react';
import { BarChart, card, cardHead, cardTitle, daysBetween, muted } from './AiUsage';
import type { UsageReport } from './UsageView';

/**
 * The LaTeX compiler on the Usage page, compiling for everyone signed in
 * (worker/latex.js). On Google Cloud Run: the compiler's seconds this month,
 * from the Worker's tally, as vCPU- and GiB-seconds against Cloud Run's free
 * tier. On GitHub Actions in the reader's own repository, two views:
 * what GitHub says of this month's runs — the minutes, against the Free
 * plan's 2,000 when the repository is private (a public one isn't metered),
 * and what is running now against the 20 jobs it runs at once — and who
 * compiled how much, from the Worker's tally.
 */

interface LatexMonth {
  configured: boolean;
  on?: 'cloudrun' | 'github';
  error?: string;
  /** Cloud Run: what the service is given, and the free tier a month. */
  service?: string;
  cpu?: number;
  memoryGib?: number;
  free?: { vcpuSeconds: number; gibSeconds: number; requests: number };
  repo?: string;
  month?: string;
  private?: boolean;
  limit?: number | null;
  concurrent?: number;
  runs?: number;
  done?: number;
  failed?: number;
  running?: number;
  queued?: number;
  minutes?: number;
  seconds?: number;
  average?: number;
  longest?: number;
  days?: { day: string; runs: number; minutes: number }[];
}

const MONTH_MS = 60_000;

function useLatexMonth(refreshedAt: number): LatexMonth | null {
  const [month, setMonth] = useState<LatexMonth | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    if (Date.now() - asked.current < MONTH_MS) return;
    asked.current = Date.now();
    // Not dropped on a re-render: the guard above would not ask again for a minute.
    ownerFetch('/usage/latex')
      .then((response) => (response.ok ? response.json() : null))
      .then((answer) => answer && setMonth(answer as LatexMonth))
      .catch(() => undefined);
  }, [refreshedAt]);
  return month;
}

const whole = (value: number) => value.toLocaleString('en-US');
const duration = (seconds: number) => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${Math.round(seconds)} s`);

export default function LatexUsage({ report, refreshedAt }: { report: UsageReport; refreshedAt: number }) {
  const month = useLatexMonth(refreshedAt);
  const people = report.people
    .map((person) => ({ email: person.email, compiles: Number(person.total.latex) || 0, seconds: Number(person.total.latex_s) || 0, last: person.last }))
    .filter((person) => person.compiles > 0)
    .sort((a, b) => b.seconds - a.seconds);
  if (month && !month.configured && !people.length) return null;
  if (month?.on === 'cloudrun') return <CloudRunUsage month={month} report={report} people={people} />;

  const minutes = month?.minutes ?? 0;
  const limit = month?.limit ?? null;
  const share = limit ? Math.min(1, minutes / limit) : null;
  const tone = share === null ? 'var(--viz-1)' : share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)';
  const span = month?.month ? daysBetween(`${month.month}-01`, new Date().toISOString().slice(0, 10)) : [];
  const byDay = new Map((month?.days || []).map((row) => [row.day, row]));
  const stat = (label: string, value: string, note?: string) => (
    <div>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
      {note ? <div style={{ ...muted, fontSize: 11.5, marginTop: 2 }}>{note}</div> : null}
    </div>
  );
  const cell = { padding: '6px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };

  return (
    <div style={{ ...card, marginTop: 24 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>LaTeX compiler</h3>
        <span style={{ ...muted, fontSize: 12.5 }}>GitHub Actions{month?.repo ? ` in ${month.repo}` : ''}, for everyone signed in</span>
        <span style={{ flexGrow: 1 }} />
        {month?.repo ? (
          <a href={`https://github.com/${month.repo}/actions/workflows/latex-compile.yml`} target="_blank" rel="noreferrer noopener" style={{ ...muted, fontSize: 12 }}>
            The runs on GitHub
          </a>
        ) : null}
      </div>
      {month && !month.configured ? (
        <p style={{ ...muted, padding: '12px 16px', margin: 0 }}>Not set up on the Worker yet (LATEX_GITHUB_TOKEN, LATEX_RUNNER_TOKEN — docs/deploy.md). These are the compiles it counted before.</p>
      ) : null}
      {month?.error ? <p className="banner error" style={{ margin: '12px 16px' }}>GitHub didn’t answer: {month.error}</p> : null}
      <div className="ai-usage-split">
        <div className="ai-usage-models" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px' }}>
          {month?.configured && !month.error ? (
            <>
              <div>
                <div style={{ ...muted, fontSize: 12 }}>Runner minutes this month{month.month ? ` · ${month.month}` : ''}</div>
                <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                  {whole(minutes)}
                  <span style={{ ...muted, fontSize: 13, marginLeft: 4 }}>{limit ? `of ${whole(limit)} minutes` : 'minutes · unlimited'}</span>
                </div>
                {share !== null ? (
                  <div
                    role="meter"
                    aria-label="GitHub Actions minutes used this month"
                    aria-valuemin={0}
                    aria-valuemax={limit ?? undefined}
                    aria-valuenow={minutes}
                    title={`${Math.round(share * 100)}% of the month’s free minutes`}
                    style={{ height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }}
                  >
                    <div style={{ width: `${share * 100}%`, height: '100%', background: tone, borderRadius: 3 }} />
                  </div>
                ) : null}
                <div style={{ ...muted, fontSize: 11.5, marginTop: 6, ...(share !== null && share >= 0.9 ? { color: 'var(--danger)' } : {}) }}>
                  {limit
                    ? `${whole(Math.max(0, limit - minutes))} left this month — the repository is private, and GitHub’s Free plan gives ${whole(limit)} minutes a month across your private repositories`
                    : 'The repository is public: GitHub doesn’t meter its Actions minutes. Each run’s minutes are rounded up, as GitHub counts a job.'}
                </div>
              </div>
              {stat('Compiles this month', whole(month.runs ?? 0), `${whole(month.done ?? 0)} done · ${whole(month.failed ?? 0)} failed or cancelled`)}
              {stat('Running now', `${whole((month.running ?? 0) + (month.queued ?? 0))}`, `${whole(month.running ?? 0)} compiling, ${whole(month.queued ?? 0)} waiting · GitHub runs ${month.concurrent ?? 20} at once`)}
              {stat('A compile takes', month.average ? duration(month.average) : '—', month.longest ? `the longest ${duration(month.longest)}` : undefined)}
            </>
          ) : !month ? (
            <p style={{ ...muted, margin: 0 }}>Asking GitHub…</p>
          ) : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, padding: '14px 16px' }}>
          {span.length ? (
            <BarChart
              title={`Minutes this month ${whole(minutes)}`}
              days={span}
              series={[{ label: 'Minutes', color: 'var(--viz-1)', values: span.map((day) => byDay.get(day)?.minutes || 0) }]}
              format={whole}
              axis={whole}
              height={150}
            />
          ) : null}
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', marginTop: span.length ? 14 : 0 }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th style={{ ...cell, textAlign: 'left', fontWeight: 500 }}>Who compiled ({report.since} to {report.until})</th>
                <th style={{ ...cell, fontWeight: 500 }}>Compiles</th>
                <th style={{ ...cell, fontWeight: 500 }}>Runner time</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.email} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ ...cell, textAlign: 'left' }}>{person.email}</td>
                  <td style={cell}>{whole(person.compiles)}</td>
                  <td style={cell}>{duration(person.seconds)}</td>
                </tr>
              ))}
              {!people.length ? (
                <tr>
                  <td colSpan={3} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                    Nobody has compiled in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** On Cloud Run: the compiles the Worker counted, and their seconds as Cloud Run bills them against its free tier. */
function CloudRunUsage({ month, report, people }: { month: LatexMonth; report: UsageReport; people: { email: string; compiles: number; seconds: number }[] }) {
  const cpu = month.cpu ?? 2;
  const memory = month.memoryGib ?? 4;
  const free = month.free ?? { vcpuSeconds: 180_000, gibSeconds: 360_000, requests: 2_000_000 };
  const thisMonth = new Date().toISOString().slice(0, 7);
  const byDay = new Map<string, { compiles: number; seconds: number }>();
  for (const person of report.people) {
    for (const row of person.daily ?? []) {
      if (!row.latex) continue;
      const day = byDay.get(row.day) ?? { compiles: 0, seconds: 0 };
      day.compiles += Number(row.latex) || 0;
      day.seconds += Number(row.latex_s) || 0;
      byDay.set(row.day, day);
    }
  }
  let seconds = 0;
  let compiles = 0;
  for (const [day, row] of byDay) if (day.startsWith(thisMonth)) (seconds += row.seconds, compiles += row.compiles);
  const vcpu = seconds * cpu;
  const gib = seconds * memory;
  const share = Math.min(1, Math.max(vcpu / free.vcpuSeconds, gib / free.gibSeconds));
  const tone = share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)';
  const span = daysBetween(report.since, report.until);
  const total = people.reduce((sum, person) => sum + person.compiles, 0);
  const totalSeconds = people.reduce((sum, person) => sum + person.seconds, 0);
  const cell = { padding: '6px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const stat = (label: string, value: string, note?: string) => (
    <div>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
      {note ? <div style={{ ...muted, fontSize: 11.5, marginTop: 2 }}>{note}</div> : null}
    </div>
  );
  return (
    <div style={{ ...card, marginTop: 24 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>LaTeX compiler</h3>
        <span style={{ ...muted, fontSize: 12.5 }}>Google Cloud Run, {cpu} vCPU and {memory} GiB, for everyone signed in</span>
      </div>
      <div className="ai-usage-split">
        <div className="ai-usage-models" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px' }}>
          <div>
            <div style={{ ...muted, fontSize: 12 }}>Free tier used this month · {report.since > `${thisMonth}-01` ? `since ${report.since}, the period shown` : thisMonth}</div>
            <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {Math.round(share * 1000) / 10}%
              <span style={{ ...muted, fontSize: 13, marginLeft: 4 }}>
                {whole(Math.round(vcpu))} of {whole(free.vcpuSeconds)} vCPU-s · {whole(Math.round(gib))} of {whole(free.gibSeconds)} GiB-s
              </span>
            </div>
            <div
              role="meter"
              aria-label="Cloud Run free tier used this month"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              style={{ height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }}
            >
              <div style={{ width: `${share * 100}%`, height: '100%', background: tone, borderRadius: 3 }} />
            </div>
            <div style={{ ...muted, fontSize: 11.5, marginTop: 6, ...(share >= 0.9 ? { color: 'var(--danger)' } : {}) }}>
              From the compiles the Worker timed; Cloud Run also bills each instance’s start, so its own count runs a little higher. Past the free tier it is billed to the project.
            </div>
          </div>
          {stat('Compiles this month', whole(compiles), `${duration(seconds)} compiling`)}
          {stat('A compile takes', total ? duration(totalSeconds / total) : '—', 'from the files sent to the PDF back, including any cold start')}
        </div>
        <div style={{ flex: 1, minWidth: 0, padding: '14px 16px' }}>
          {span.length ? (
            <BarChart
              title={`Compiles ${whole(total)}`}
              days={span}
              series={[{ label: 'Compiles', color: 'var(--viz-1)', values: span.map((day) => byDay.get(day)?.compiles || 0) }]}
              format={whole}
              axis={whole}
              height={150}
            />
          ) : null}
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', marginTop: span.length ? 14 : 0 }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th style={{ ...cell, textAlign: 'left', fontWeight: 500 }}>Who compiled ({report.since} to {report.until})</th>
                <th style={{ ...cell, fontWeight: 500 }}>Compiles</th>
                <th style={{ ...cell, fontWeight: 500 }}>Compiler time</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.email} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ ...cell, textAlign: 'left' }}>{person.email}</td>
                  <td style={cell}>{whole(person.compiles)}</td>
                  <td style={cell}>{duration(person.seconds)}</td>
                </tr>
              ))}
              {!people.length ? (
                <tr>
                  <td colSpan={3} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                    Nobody has compiled in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
