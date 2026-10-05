import { useEffect, useState } from 'react';
import { MODELS, modelSpec, PROVIDERS } from '../lib/assistant';
import { explanationsAtWork, subscribeExplain } from '../lib/explain';
import type { Explanation } from '../lib/explain';
import { implementationsAtWork, subscribeImplement } from '../lib/implement';
import { useStore } from '../lib/store';
import { lastThought, openExplainOn } from './Explain';
import type { WrittenPage as ExplainPage } from './Explain';
import { ExplainIcon, PlanIcon } from './icons';

/** The explanation is "At a glance", four to eight sections and "Since then"; the plan is ten, in order. */
const EXPECTED: Record<ExplainPage, number> = { explain: 8, implement: 10 };

interface Job {
  page: ExplainPage;
  entry: Explanation;
}

/**
 * How far along a page is, 0–1, or null when there is no telling (a request
 * from the bar edits whichever sections it needs). A first page is measured by
 * its sections: they are asked for in a known number, so the heading being
 * written says roughly where it is.
 */
export function progressOf(page: ExplainPage, entry: Explanation): number | null {
  if (!entry.streaming) return null;
  const heads = (entry.content.match(/^## /gm) ?? []).length;
  if (!heads) return entry.content ? 0.05 : 0.02;
  if (page === 'explain' && /^## Since then/im.test(entry.content)) return 0.93;
  return Math.min(0.95, Math.max(0.05, (heads - 0.5) / EXPECTED[page]));
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Every page being written or revised, less the one whose Explain is open; re-rendered each second while there are any. */
function useJobs(showing: string | null): Job[] {
  const [, setTick] = useState(0);
  const jobs: Job[] = [
    ...explanationsAtWork().map((entry) => ({ page: 'explain' as const, entry })),
    ...implementationsAtWork().map((entry) => ({ page: 'implement' as const, entry })),
  ].filter((job) => job.entry.paperId !== showing);
  const working = jobs.length > 0;
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const offExplain = subscribeExplain(bump);
    const offImplement = subscribeImplement(bump);
    return () => {
      offExplain();
      offImplement();
    };
  }, []);
  // The clock ticks only while something is being written.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [working]);
  return jobs;
}

/** What a job says about itself: the paper, how far, how long, what it is on. */
function describeJob({ page, entry }: Job, titleOf: (id: string) => string | undefined) {
  const progress = progressOf(page, entry);
  const writer = PROVIDERS[modelSpec(entry.model).provider].name;
  const heads = entry.content.match(/^## +(.+)$/gm) ?? [];
  const now = heads.length ? heads[heads.length - 1].replace(/^## +/, '') : '';
  const thought = lastThought(entry.thinking);
  return {
    label: page === 'implement' ? 'Implementation' : 'Explanation',
    title: titleOf(entry.paperId) ?? 'A paper',
    model: MODELS.find((m) => m.id === entry.model)?.label ?? writer,
    percent: progress === null ? null : Math.round(progress * 100),
    elapsed: clock(Date.now() - (entry.pending?.started ?? entry.created)),
    doing: entry.pending
      ? `Revising — ${entry.pending.request}`
      : thought
        ? `Thinking — ${thought}`
        : entry.content
          ? `Writing — ${now || 'the opening'}`
          : 'Reading the paper',
  };
}

/** A ring round the page's icon: filled as far as it has got, or turning when there is no telling. */
function Ring({ page, percent, size = 36 }: { page: ExplainPage; percent: number | null; size?: number }) {
  const R = 15;
  const C = 2 * Math.PI * R;
  return (
    <span className={`ep-ring${percent === null ? ' is-open' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 36 36" width={size} height={size}>
        <circle className="ep-track" cx="18" cy="18" r={R} />
        <circle className="ep-fill" cx="18" cy="18" r={R} strokeDasharray={C} strokeDashoffset={percent === null ? C * 0.72 : C * (1 - percent / 100)} />
      </svg>
      <span className="ep-icon">{page === 'implement' ? <PlanIcon size={size > 30 ? 13 : 12} /> : <ExplainIcon size={size > 30 ? 13 : 12} />}</span>
    </span>
  );
}

function Bar({ percent }: { percent: number | null }) {
  return (
    <span className={`ep-bar${percent === null ? ' is-open' : ''}`} aria-hidden="true">
      <i style={percent === null ? undefined : { width: `${percent}%` }} />
    </span>
  );
}

/** The whole story of one job: the card in the rail's popover. */
function Card({ job, titleOf }: { job: Job; titleOf: (id: string) => string | undefined }) {
  const d = describeJob(job, titleOf);
  return (
    <>
      <span className="ep-top">
        <b>{d.label}</b>
        <span className="ep-meta">
          {d.percent === null ? '' : `${d.percent}% · `}
          <span className="ep-clock">{d.elapsed}</span>
        </span>
      </span>
      <span className="ep-paper">{d.title}</span>
      <span className="ep-doing">{d.doing}</span>
      <Bar percent={d.percent} />
      <span className="ep-foot">
        {d.model} · <u>Open</u>
      </span>
    </>
  );
}

type Props = {
  /** The paper whose Explain is open: its own page shows how it is going. */
  showing: string | null;
  onOpen: (paperId: string) => void;
};

/**
 * In the left rail, under Ask AI, while Explain is closed and a page is still
 * being written or revised: a ring for each, filled as far as it has got, with
 * the percentage under it. Pointing at it shows the paper, a clock and what it
 * is on; clicking opens it. It takes no room from what is being read.
 */
export function RailProgress({ showing, onOpen }: Props) {
  const { papers } = useStore();
  const jobs = useJobs(showing);
  if (!jobs.length) return null;
  const titleOf = (id: string) => papers.find((p) => p.id === id)?.title;
  const open = (job: Job) => {
    openExplainOn(job.entry.paperId, job.page);
    onOpen(job.entry.paperId);
  };
  return (
    <div className="rail-progress" aria-live="polite">
      {jobs.map((job) => {
        const d = describeJob(job, titleOf);
        return (
          <div key={`${job.page}:${job.entry.paperId}`} className="rail-progress-item">
            <button
              type="button"
              className="rail-progress-btn"
              onClick={() => open(job)}
              aria-label={`${d.label} of “${d.title}”: ${d.percent === null ? 'revising' : `${d.percent}%`}, ${d.elapsed} — open it`}
            >
              <Ring page={job.page} percent={d.percent} size={34} />
              <span className="rail-progress-pct">{d.percent === null ? d.elapsed : `${d.percent}%`}</span>
            </button>
            <div className="rail-progress-pop" role="tooltip">
              <Card job={job} titleOf={titleOf} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
