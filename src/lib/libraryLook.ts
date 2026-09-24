/**
 * How a paper looks in the library's lists: the tile that stands in for its
 * cover, the line of authors, and the heading of the stretch of days it was
 * added in. Nothing here touches the DOM, so it is tested on its own.
 */
import type { PaperRef } from '../types';

export interface Cover {
  /** A hue, 0–360, the same for every paper in the same journal or from the same place. */
  hue: number;
  /** What kind of thing it is, in a word: `arXiv`, `Journal`, `Book`. */
  kind: string;
  /** The year, where there is one. */
  year?: string;
}

/** A stable hash of a string, for picking a colour it will always get. */
function hash(value: string): number {
  let total = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    total ^= value.charCodeAt(index);
    total = Math.imul(total, 16777619);
  }
  return total >>> 0;
}

const CONFERENCE = /\b(proceedings|conference|symposium|workshop|NeurIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|AAAI|IJCAI|KDD|CHI)\b/i;

export function coverFor(paper: Pick<PaperRef, 'source' | 'venue' | 'arxivId' | 'published' | 'pdfUrl' | 'landingUrl'>): Cover {
  const venue = paper.venue?.trim();
  const kind =
    paper.source === 'books'
      ? paper.pdfUrl && !paper.landingUrl
        ? 'PDF'
        : 'Book'
      : venue
        ? CONFERENCE.test(venue)
          ? 'Proc.'
          : 'Journal'
        : paper.arxivId
          ? 'arXiv'
          : 'Paper';
  const key = venue ? venue.toLowerCase() : kind;
  const year = /^\d{4}/.exec(paper.published || '')?.[0];
  return { hue: hash(key) % 360, kind, year };
}

/** `EL Meier, JP Johnson, Y Pan +2`: as many names as fit the line, and how many more. */
export function authorLine(authors: string[], shown = 3): string {
  const names = authors.filter(Boolean);
  if (!names.length) return 'Unknown author';
  const head = names.slice(0, shown).join(', ');
  return names.length > shown ? `${head} +${names.length - shown}` : head;
}

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * The heading a date is listed under: `Today`, `Yesterday`, `This week`,
 * `Earlier this month`, then the month and, for another year, the year.
 */
export function dayGroup(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'Earlier this month';
  return date.toLocaleDateString('en-US', { month: 'long', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** `today`, `yesterday`, `3 days ago`, `12 Mar`, `12 Mar 2024`. */
export function relativeDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
