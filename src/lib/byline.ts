/**
 * Google Scholar's one line of metadata — authors, venue, year, host — read
 * the way `parseByline` in server/scholar.js reads it, for the records that
 * were saved before the proxy learned Scholar's newer layout.
 *
 * That layout prints `EL Meier, S Kiran` in an element of its own with the
 * venue straight after it and a bullet before the host, so a record read by
 * the older parser came out with the venue glued to the last name and the
 * year and host as one more author: `S KiranBrain imaging and behavior`,
 * `2019•Springer`. `tidyByline` puts such a record right.
 */
import type { PaperRef } from '../types';

const YEAR = /\b(1[89]\d\d|20\d\d)\b/;
const YEAR_ONLY = /^(1[89]\d\d|20\d\d)$/;
/** The small words a surname can carry — `van`, `de la` — that are not the start of a venue's name. */
const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'y', 'e', 'ten', 'ter', 'op']);

/**
 * Where a name runs into the venue after it, split into the two, or null
 * where the piece is plainly a name. The seam is the last lower-case letter
 * followed by a capital that starts a phrase; a single word is taken only
 * where the piece is known to hold a venue (`force`).
 */
export function unglue(piece: string, { force = false } = {}): { name: string; venue: string } | null {
  const words = piece.split(' ');
  const lowerWord = words.slice(1).some((word) => /^[a-z]/.test(word) && !PARTICLES.has(word));
  if (!force && !lowerWord && words.length <= 4) return null;
  const phrase = /^(.*[a-zß-ÿ.)])([A-Z][^\s]*\s.*)$/.exec(piece);
  const word = /^(.*[a-zß-ÿ.)])([A-Z][^\s]*)$/.exec(piece);
  const seam = phrase || (force ? word : null);
  if (!seam) return null;
  const name = seam[1].trim();
  if (!/\s/.test(name) || name.split(/\s+/).length > 5) return null;
  return { name, venue: seam[2].trim() };
}

function authorsAndVenue(first: string): { names: string[]; venue: string } {
  const pieces = first
    .split(/,\s*/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  for (let index = 0; index < pieces.length; index += 1) {
    const next = pieces[index + 1];
    const split = unglue(pieces[index].replace(/…|\.\.\./g, '').trim(), { force: next !== undefined && YEAR_ONLY.test(next) });
    if (split) return { names: [...pieces.slice(0, index), split.name], venue: [split.venue, ...pieces.slice(index + 1)].join(', ') };
    if (YEAR_ONLY.test(pieces[index]) && index > 0) return { names: pieces.slice(0, index), venue: pieces.slice(index).join(', ') };
  }
  return { names: pieces, venue: '' };
}

export interface Byline {
  authors: string[];
  venue?: string;
  year?: number;
  /** Where Scholar found it — often the publisher: `Springer`, `nature.com`. */
  host?: string;
}

export function parseByline(line: string): Byline {
  const normal = String(line || '')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*•\s*/g, ' - ')
    .replace(/\s+[–—]\s+/g, ' - ')
    .trim();
  let parts = normal.split(/\s+-\s+/);
  const lead = authorsAndVenue(parts[0] || '');
  if (lead.venue) parts = [parts[0], lead.venue, ...parts.slice(1)];
  const authors = lead.names.map((name) => name.replace(/…|\.\.\./g, '').trim()).filter(Boolean);
  const middle = parts.length > 2 ? parts.slice(1, -1).join(' - ') : parts.length === 2 ? parts[1] : '';
  const year = (middle.match(YEAR) || [])[1];
  const venue = middle
    .replace(/,?\s*\b(1[89]\d\d|20\d\d)\b\s*$/, '')
    .replace(/…/g, '')
    .trim();
  const host = parts.length > 1 ? parts[parts.length - 1].trim() : '';
  return { authors, venue: venue || undefined, year: year ? Number(year) : undefined, host: host || undefined };
}

/** A name that is really a venue, a year or a host run into one: what the older parser left behind. */
const garbled = (name: string) => /•|\s[-–—]\s/.test(name) || YEAR_ONLY.test(name.trim()) || unglue(name) !== null;

/**
 * The record with its byline read again, where its authors show the older
 * parser's mistake; the same record, untouched, where they do not.
 */
export function tidyByline<T extends PaperRef>(paper: T): T {
  if (paper.source !== 'scholar' || !paper.authors.some(garbled)) return paper;
  const read = parseByline(paper.authors.join(', '));
  if (!read.authors.length) return paper;
  return {
    ...paper,
    authors: read.authors,
    venue: paper.venue || read.venue,
    published: paper.published || (read.year ? `${read.year}-01-01` : ''),
  };
}
