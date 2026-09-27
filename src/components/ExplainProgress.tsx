import { useEffect, useState } from 'react';
import { MODELS, modelSpec, PROVIDERS } from '../lib/assistant';
import { explanationsAtWork, subscribeExplain } from '../lib/explain';
import type { Explanation } from '../lib/explain';
import { implementationsAtWork, subscribeImplement } from '../lib/implement';
import { useStore } from '../lib/store';
import { lastThought, openExplainOn } from './Explain';
import type { ExplainPage } from './Explain';
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

/**
 * A pill in the corner while Explain is closed and a page is still being
 * written or revised: the paper, what it is on, a clock, and how far along it
 * is. The writing goes on without the page open; the pill opens it again.
 */
export default function ExplainProgress({
  hidden,
  showing,
  onOpen,
}: {
  hidden: boolean;
  /** The paper whose Explain is open: its own page shows how it is going. */
  showing: string | null;
  onOpen: (paperId: string) => void;
}) {
  const { papers } = useStore();
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
  if (hidden || !working) return null;

  return (
    <div className="explain-progress-stack" aria-live="polite">
      {jobs.map(({ page, entry }) => {
        const paper = papers.find((p) => p.id === entry.paperId);
        const progress = progressOf(page, entry);
        const started = entry.pending?.started ?? entry.created;
        const writer = PROVIDERS[modelSpec(entry.model).provider].name;
        const model = MODELS.find((m) => m.id === entry.model)?.label ?? writer;
        const heads = entry.content.match(/^## +(.+)$/gm) ?? [];
        const now = heads.length ? heads[heads.length - 1].replace(/^## +/, '') : '';
        const thought = lastThought(entry.thinking);
        const doing = entry.pending
          ? `Revising — ${entry.pending.request}`
          : !entry.content
            ? thought
              ? `Thinking — ${thought}`
              : 'Reading the paper'
            : thought
              ? `Thinking — ${thought}`
              : `Writing — ${now || 'the opening'}`;
        const label = page === 'implement' ? 'Implementation' : 'Explanation';
        const percent = progress === null ? null : Math.round(progress * 100);
        const R = 15;
        const C = 2 * Math.PI * R;
        return (
          <button
            key={`${page}:${entry.paperId}`}
            type="button"
            className="explain-progress"
            onClick={() => {
              openExplainOn(page);
              onOpen(entry.paperId);
            }}
            title={`${label} of “${paper?.title ?? 'this paper'}” by ${model} — click to open it`}
          >
            <span className={`ep-ring${percent === null ? ' is-open' : ''}`} aria-hidden="true">
              <svg viewBox="0 0 36 36" width="36" height="36">
                <circle className="ep-track" cx="18" cy="18" r={R} />
                <circle
                  className="ep-fill"
                  cx="18"
                  cy="18"
                  r={R}
                  strokeDasharray={C}
                  strokeDashoffset={percent === null ? C * 0.72 : C * (1 - percent / 100)}
                />
              </svg>
              <span className="ep-icon">{page === 'implement' ? <PlanIcon size={13} /> : <ExplainIcon size={13} />}</span>
            </span>
            <span className="ep-text">
              <span className="ep-top">
                <b>{label}</b>
                <span className="ep-meta">
                  {percent === null ? '' : `${percent}% · `}
                  <span className="ep-clock">{clock(Date.now() - started)}</span>
                </span>
              </span>
              <span className="ep-paper">{paper?.title ?? 'A paper'}</span>
              <span className="ep-doing">{doing}</span>
              {percent !== null ? (
                <span className="ep-bar" aria-hidden="true">
                  <i style={{ width: `${percent}%` }} />
                </span>
              ) : (
                <span className="ep-bar is-open" aria-hidden="true">
                  <i />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
