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
import type { BylineAuthor, PaperByline } from './pdfLayout';

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

const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Letters with a stroke have no accent to strip: "Łukasz" is "Lukasz".
    .replace(/[Łł]/g, 'l')
    .replace(/[Øø]/g, 'o')
    .replace(/[Đđ]/g, 'd')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, '')
    .trim();

/** Whether "S Chennuri" and "Saurav Chennuri" are the same person: the same surname, and first names that agree as far as both go. */
export function sameAuthor(short: string, full: string): boolean {
  const a = fold(short).split(/\s+/).filter(Boolean);
  const b = fold(full).split(/\s+/).filter(Boolean);
  if (!a.length || !b.length || a[a.length - 1] !== b[b.length - 1]) return false;
  const first = a[0];
  const other = b[0];
  // Scholar runs initials together, "EJ Braun"; the byline spells them "Emily J. Braun".
  return a.length === 1 || b.length === 1 || other.startsWith(first) || first.startsWith(other) || (first.length <= 3 && first[0] === other[0]);
}

/**
 * The byline read off the PDF, when it is the same list as the one on
 * record only fuller — more names, or names in full — and null otherwise.
 * Every name on record has to be found in it, in the same order: a byline
 * read wrongly, or the PDF of some other paper, is not allowed to rewrite
 * who wrote this one.
 */
export function fullerAuthors(known: string[], found: string[] | undefined): string[] | null {
  if (!found?.length) return null;
  if (!known.length) return found;
  let at = 0;
  for (const name of known) {
    const match = found.findIndex((candidate, index) => index >= at && sameAuthor(name, candidate));
    if (match < 0) return null;
    at = match + 1;
  }
  const longer = found.length > known.length;
  const fuller = found.join(' ').length > known.join(' ').length;
  return longer || fuller ? found : null;
}

/** What the paper's own byline says of one of its authors, found by name. */
export function onPaper(byline: PaperByline | undefined, name: string): BylineAuthor | undefined {
  return byline?.authors.find((author) => sameAuthor(name, author.name) || sameAuthor(author.name, name));
}

/**
 * What the byline says of an author, in words: "First author", "Equal
 * contribution", "Corresponding author" — the marks' own words, as the
 * page gives them, after whether they come first.
 */
export function rolesOnPaper(author: BylineAuthor | undefined, position: number): string[] {
  // A note that says the order means nothing — "Listing order is random" — leaves no first author.
  const unordered = (author?.notes ?? []).some((note) => ORDER_MEANS_NOTHING.test(note));
  const roles = position === 0 && !unordered ? ['First author'] : [];
  // The note speaks of them all — "Corresponding authors" — the card of one,
  // a chip a sentence: "Equal contribution", "Listing order is random".
  const sentences = (author?.notes ?? []).flatMap((note) => note.split(/(?<=[\p{Ll}\p{N})]{2}[.!?])\s+(?=\p{Lu})/u)).map((sentence) => sentence.replace(/\.$/, ''));
  for (const note of sentences) {
    // Where they had moved to is where they are, not a role: the card says it there.
    if (MOVED.test(note)) continue;
    // The address in it has a row of its own on the card: "Corresponding author".
    const own = note
      .replace(/[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi, '')
      .replace(/[\s:;,(]+\)?$/, '')
      .trim()
      .replace(/\bauthors\b/i, (word) => word.slice(0, -1));
    if (!own) continue;
    if (!roles.includes(own)) roles.push(own);
  }
  return roles;
}

/** A note of where an author had moved to by the time the paper came out: "Present address: …". */
const MOVED = /^(?:present|current|permanent|new) address\b\s*:?\s*/i;

/**
 * An institution as a card shows it: the street, the room and the postcode
 * a Springer footnote prints with it left out — "Aphasia Research
 * Laboratory, …, Boston University, 635 Commonwealth Avenue, room 326,
 * Boston, MA 02215, USA" is "…, Boston University, USA".
 */
export function placeOnly(text: string): string {
  const pieces = text.split(/\s*,\s*/).filter((piece) => piece && !/\d/.test(piece));
  return pieces.join(', ') || text;
}

/** A note saying the authors' order carries nothing: random, alphabetical, by a coin's toss. */
export const ORDER_MEANS_NOTHING = /\b(?:listing|author|name)s?\s+order\b[^.]*\b(?:random|alphabetical|arbitrary|coin)|\b(?:random(?:ly)?|alphabetical(?:ly)?|arbitrar(?:y|ily))\s+(?:order|ordered|listed)\b|\border(?:ed)?\s+(?:at\s+random|randomly|alphabetically|by\s+(?:a\s+)?coin)/i;

/** A note cut into its words and its addresses — "Corresponding author: a@b.org" — the addresses to be links. */
export function addressPieces(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  let at = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:)]|[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) {
    if (match.index! > at) out.push({ text: text.slice(at, match.index) });
    out.push({ text: match[0], href: match[0].includes('@') && !/^https?:/i.test(match[0]) ? `mailto:${match[0]}` : match[0] });
    at = match.index! + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/**
 * Where someone is, from each source that says, and which one said it.
 * Google Scholar's profile is the one they keep themselves, so it is now:
 * their position and department, and the domain of the address Scholar
 * verified — never the address, which Scholar does not show. The paper is
 * then: the institution it names, and the address it prints in full,
 * the one thing a profile cannot give. OpenAlex fills either side where
 * the others are silent.
 */
export interface Whereabouts {
  now?: { place: string; from: 'Google Scholar' | 'OpenAlex'; verified?: string };
  then?: { place?: string; from: 'the paper' | 'OpenAlex'; same: boolean; emails: string[]; moved?: string };
}

/** The distinctive words of an institution's name: "Nanjing University" is "nanjing". */
const placeWords = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/)
    .filter((word) => word.length > 2 && !/^(the|and|for|university|universit|institute|college|school|department|dept|faculty|lab|laboratory|center|centre|research|student|phd|professor|assistant|associate|postdoc|candidate|engineering|science|sciences|computer|technology|national|state|key)$/.test(word));

export function whereTheyAre({
  onPaper,
  details,
  profile,
}: {
  onPaper?: BylineAuthor;
  /** What OpenAlex has: the institution it files this paper under, and their last known one. */
  details?: { affiliationHere?: string; affiliation?: string };
  /** Their Google Scholar profile, where one is plainly theirs. */
  profile?: { affiliation?: string; verifiedEmail?: string } | null;
}): Whereabouts {
  const out: Whereabouts = {};
  if (profile?.affiliation || profile?.verifiedEmail) {
    out.now = { place: profile.affiliation || '', from: 'Google Scholar', verified: profile.verifiedEmail };
  } else if (details?.affiliation) {
    out.now = { place: details.affiliation, from: 'OpenAlex' };
  }
  const paperPlace = onPaper?.affiliations.length ? onPaper.affiliations.map(placeOnly).join('; ') : undefined;
  // "Present address: …" — where the paper says they had gone by the time it came out.
  const movedNote = onPaper?.notes.find((note) => MOVED.test(note));
  const moved = movedNote ? placeOnly(movedNote.replace(MOVED, '')) : undefined;
  const place = paperPlace ?? details?.affiliationHere;
  const emails = onPaper?.emails ?? [];
  if (place || emails.length || moved) {
    const nowWords = new Set(placeWords(`${out.now?.place ?? ''} ${out.now?.verified ?? ''}`));
    const domains = emails.map((email) => email.split('@')[1]);
    const verified = out.now?.verified?.toLowerCase();
    // The same place: its name's words in the profile's, or the addresses at one domain.
    const same = Boolean(
      out.now &&
        ((place && placeWords(place).some((word) => nowWords.has(word))) ||
          (verified && domains.some((domain) => domain === verified || domain.endsWith(`.${verified}`) || verified.endsWith(`.${domain}`)))),
    );
    out.then = { place, from: paperPlace || !place ? 'the paper' : 'OpenAlex', same, emails, ...(moved ? { moved } : {}) };
  }
  return out;
}
