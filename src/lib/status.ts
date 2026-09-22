/**
 * Where a paper is in the reading of it. The reader stores progress as a
 * fraction of the scroll, so "finished" is a threshold rather than a flag —
 * the last screenful is references and nobody scrolls to the very bottom.
 */
import type { Paper } from '../types';

export const FINISHED_AT = 0.98;

export type ReadingStatus = 'unread' | 'reading' | 'finished';

export function statusOf(paper: Paper): ReadingStatus {
  if (paper.progress >= FINISHED_AT) return 'finished';
  return paper.progress > 0 ? 'reading' : 'unread';
}

export const STATUS_LABEL: Record<ReadingStatus, string> = {
  reading: 'Reading now',
  unread: 'Not started',
  finished: 'Finished',
};

/** The order the left panel shows the groups in: in flight, then to come. */
export const STATUS_ORDER: ReadingStatus[] = ['reading', 'unread', 'finished'];
