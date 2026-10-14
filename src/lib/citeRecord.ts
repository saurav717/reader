/**
 * How a paper is cited: the BibTeX entries kept for it, by source, the key
 * it goes by, and the forms a citation is copied in.
 *
 * A paper's record (title, authors, year, venue) makes a passable entry,
 * and that is all the library had: `@article` when it named a venue,
 * `@misc` otherwise. Venues want more than that — NeurIPS as
 * `@inproceedings` with its proceedings named in full, a journal with its
 * volume and pages — and each keeps its own form: the publisher's record by
 * DOI, dblp's, OpenReview's, arXiv's. So a paper keeps every entry found for
 * it as a variant (types.ts, CitationRecord), and which one a draft takes is
 * a choice — Settings → Citations for every paper, or per paper in the
 * bibliography — made once, not a fetch at the moment of citing.
 *
 * The key is separate from the entry: a variant is always written out under
 * the paper's own key, so switching variants never changes a \cite in a
 * draft. The key is the one kept on the paper, else the style in Settings.
 *
 * Everything here but the fetchers is pure, and pinned by
 * scripts/cite-record.test.mjs.
 */
import type { CitationOptions, CitationRecord, CitationSource, CitationVariant, Paper, PaperRef } from '../types';
import { CITATION_DEFAULTS } from '../types';
import { titleFits } from './citations';
import { politely } from './contact';
import { apiFetch, hasProxy } from './api';

// ----------------------------------------------------------- the options ---

let options: CitationOptions = CITATION_DEFAULTS;

/** Settings → Citations, as the store keeps it: what every call here takes unless told otherwise. */
export function setCitationOptions(next: Partial<CitationOptions> | undefined): void {
  options = { ...CITATION_DEFAULTS, ...(next ?? {}) };
}

export const citationOptions = (): CitationOptions => options;

// ------------------------------------------------------------- BibTeX ----

/** One BibTeX entry, read apart: its type, key and fields, braces stripped from the values. */
export interface BibRecord {
  type: string;
  key: string;
  fields: Record<string, string>;
}

/** Every entry in a .bib text, in order; @comment, @string and @preamble left out. */
export function parseBibtex(text: string): BibRecord[] {
  const out: BibRecord[] = [];
  const head = /@([a-zA-Z]+)\s*([{(])\s*([^,\s{}()]+)\s*,/g;
  for (const match of text.matchAll(head)) {
    const type = match[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const body = bodyFrom(text, match.index! + match[0].length, match[2] === '(' ? ')' : '}');
    out.push({ type, key: match[3], fields: readFields(body) });
  }
  return out;
}

/** The text from `at` up to the brace that closes the entry, braces inside balanced. */
function bodyFrom(text: string, at: number, close: '}' | ')'): string {
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    const character = text[i];
    if (character === '{') depth += 1;
    else if (character === '}') {
      if (depth === 0) return text.slice(at, i);
      depth -= 1;
    } else if (character === close && depth === 0) return text.slice(at, i);
  }
  return text.slice(at);
}

/** `name = {value}`, `name = "value"`, `name = 2017`, each value with its outer braces off. */
function readFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const name = /^\s*,?\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*/.exec(body.slice(i));
    if (!name) break;
    i += name[0].length;
    let value = '';
    if (body[i] === '{') {
      let depth = 0;
      const start = i + 1;
      for (; i < body.length; i += 1) {
        if (body[i] === '{') depth += 1;
        else if (body[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      value = body.slice(start, i);
      i += 1;
    } else if (body[i] === '"') {
      const start = i + 1;
      i = body.indexOf('"', start);
      if (i < 0) i = body.length;
      value = body.slice(start, i);
      i += 1;
    } else {
      const start = i;
      while (i < body.length && body[i] !== ',' && body[i] !== '\n') i += 1;
      value = body.slice(start, i);
    }
    fields[name[1].toLowerCase()] = value.replace(/\s+/g, ' ').trim();
  }
  return fields;
}

/** A value as BibTeX wants it between braces. */
export function escapeBib(value: string): string {
  return value.replace(/[{}\\]/g, '').replace(/[&%$#_]/g, (character) => `\\${character}`);
}

/** The entry written out, fields in the order given, the values as they are. */
export function formatBibtex(record: BibRecord, order?: string[]): string {
  const names = order ? [...order.filter((name) => record.fields[name] !== undefined), ...Object.keys(record.fields).filter((name) => !order.includes(name))] : Object.keys(record.fields);
  const width = Math.max(0, ...names.map((name) => name.length));
  const lines = names.filter((name) => record.fields[name]).map((name) => `  ${name.padEnd(width)} = {${record.fields[name]}}`);
  return `@${record.type}{${record.key},\n${lines.join(',\n')}\n}`;
}

/** The entry under another key, nothing else touched. */
export function rekey(bibtex: string, key: string): string {
  return bibtex.replace(/^(\s*@[a-zA-Z]+\s*[{(]\s*)[^,\s{}()]+(\s*,)/, `$1${key}$2`);
}

/** Braces and TeX accents off a field, for showing: `{GShard}` → `GShard`, `Schr\"{o}der` → `Schröder`. */
export function plain(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/\\(?:"|'|`|\^|~|=|\.)\{?([a-zA-Z])\}?/g, (_, letter: string) => {
      const marks: Record<string, string> = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇' };
      const mark = marks[_[1]];
      return mark ? (letter + mark).normalize('NFC') : letter;
    })
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------- authors ---

export interface Name {
  first: string;
  last: string;
}

/** `Vaswani, Ashish and Noam Shazeer` → the names, as a person reads them. */
export function splitAuthors(field: string | undefined): Name[] {
  if (!field) return [];
  return field
    .split(/\s+and\s+/i)
    .map((author) => plain(author))
    .filter(Boolean)
    .map(nameParts);
}

export function nameParts(author: string): Name {
  const comma = author.indexOf(',');
  if (comma >= 0) return { last: author.slice(0, comma).trim(), first: author.slice(comma + 1).trim() };
  const parts = author.trim().split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  // A particle stays with the family name: `van der Maaten`.
  let cut = parts.length - 1;
  while (cut > 1 && /^(van|von|de|der|den|da|di|du|le|la|del|della|al)$/i.test(parts[cut - 1])) cut -= 1;
  return { first: parts.slice(0, cut).join(' '), last: parts.slice(cut).join(' ') };
}

/** `Ashish` → `A.`, `Noam M` → `N. M.` */
const initials = (first: string) =>
  first
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ');

// ------------------------------------------------------- the entry made ---

const CONFERENCES =
  /\b(neurips|nips|icml|iclr|cvpr|iccv|eccv|wacv|acl|emnlp|naacl|eacl|coling|aaai|ijcai|kdd|www|sigir|siggraph|interspeech|icassp|colt|uai|aistats|miccai|icra|iros|rss|corl|cikm|wsdm|icde|vldb|sigmod|pods|sosp|osdi|nsdi|usenix|ccs|s&p|ndss|chi|uist|iclr|icdm|ecml|pkdd|ijcnn|icdar|interspeech|eurosys|asplos|isca|micro|hpca|pldi|popl|oopsla|icse|fse|ase|lics|focs|stoc|soda|icalp|esa|iccv|bmvc|accv|3dv|cogsci|collas|automl|mlsys)\b/i;

/** What kind of venue a name is: a conference, a journal, or a preprint server. */
export function venueKindOf(venue: string | undefined): 'conference' | 'journal' | 'preprint' | undefined {
  if (!venue) return undefined;
  if (/^(arxiv|biorxiv|medrxiv|corr|ssrn|preprint|openreview)\b/i.test(venue.trim())) return 'preprint';
  if (/\b(conference|proceedings|workshop|symposium|meeting|congress)\b/i.test(venue) || /advances in neural information processing/i.test(venue) || CONFERENCES.test(venue)) return 'conference';
  return 'journal';
}

function familyName(author: string): string {
  return nameParts(author).last;
}

const firstWord = (title: string) => (title.toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').match(/[a-z]{4,}/g) || []).find((word) => !/^(with|from|that|this|their|these|those|into|over|under|about|using|towards|toward|through)$/.test(word)) || 'paper';

/** A cite key in the style asked: lecun2015deep, lecun:2015:deep, Lecun2015, or dblp's own where the paper has one. */
export function keyIn(paper: Pick<Paper, 'title' | 'authors' | 'published'> & { citation?: CitationRecord }, style: CitationOptions['keyStyle']): string {
  const surname = familyName(paper.authors[0] || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '') || 'anon';
  const year = (paper.published || '').slice(0, 4) || 'nd';
  const word = firstWord(paper.title);
  if (style === 'dblp') {
    const dblp = paper.citation?.variants.find((variant) => variant.source === 'dblp');
    const key = dblp ? parseBibtex(dblp.bibtex)[0]?.key : undefined;
    if (key) return key;
  }
  if (style === 'colon') return `${surname}:${year}:${word}`;
  if (style === 'authorYear') return `${surname[0].toUpperCase()}${surname.slice(1)}${year}`;
  return `${surname}${year}${word}`;
}

/** The key the paper goes by: the one kept on it, else the style in Settings. */
export function keyOf(paper: Pick<Paper, 'title' | 'authors' | 'published'> & { citation?: CitationRecord }, opts: CitationOptions = options): string {
  return paper.citation?.key || keyIn(paper, opts.keyStyle);
}

/** What the venue card found, to make the entry fuller than the record alone. */
export interface VenueExtra {
  /** `Vol. 13, issue 6, pp. 1759–1772`, as the card prints it. */
  placement?: string;
  publisher?: string;
  /** The meeting's city, for a proceedings' address. */
  location?: string;
}

/** `Vol. 13, issue 6, pp. 1759–1772` → the volume, number and pages. */
export function readPlacement(placement: string | undefined): { volume?: string; number?: string; pages?: string } {
  if (!placement) return {};
  return {
    volume: /vol\.?\s*([A-Za-z0-9-]+)/i.exec(placement)?.[1],
    number: /(?:issue|no\.?)\s*([A-Za-z0-9-]+)/i.exec(placement)?.[1],
    pages: /pp?\.?\s*([A-Za-z0-9]+\s*[-–—]+\s*[A-Za-z0-9]+|[A-Za-z0-9]+)/i.exec(placement)?.[1]?.replace(/\s*[-–—]+\s*/, '--'),
  };
}

const ARXIV_DOI = /^10\.48550\//i;

/**
 * The entry made from the paper's record: `@inproceedings` with a
 * booktitle for a conference, `@article` for a journal, `@misc` with the
 * eprint for a preprint, each with what the record and the venue card know.
 */
export function generatedRecord(paper: PaperRef & { tags?: string[]; citation?: CitationRecord }, extra: VenueExtra = {}, opts: CitationOptions = options): BibRecord {
  const kind = venueKindOf(paper.venue);
  const year = (paper.published || '').slice(0, 4) || undefined;
  const month = (paper.published || '').slice(5, 7);
  const doi = paper.doi && !ARXIV_DOI.test(paper.doi) ? paper.doi : undefined;
  const placement = readPlacement(extra.placement);
  const common: Record<string, string | undefined> = {
    title: escapeBib(paper.title),
    author: paper.authors.map(escapeBib).join(' and ') || undefined,
    year,
    month: month && /^(0[1-9]|1[0-2])$/.test(month) ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][Number(month) - 1] : undefined,
  };
  let type = 'misc';
  const own: Record<string, string | undefined> = {};
  if (kind === 'conference') {
    type = 'inproceedings';
    own.booktitle = escapeBib(paper.venue!);
    own.pages = placement.pages;
    own.address = extra.location ? escapeBib(extra.location) : undefined;
    own.publisher = extra.publisher ? escapeBib(extra.publisher) : undefined;
  } else if (kind === 'journal') {
    type = 'article';
    own.journal = escapeBib(paper.venue!);
    own.volume = placement.volume;
    own.number = placement.number;
    own.pages = placement.pages;
    own.publisher = extra.publisher ? escapeBib(extra.publisher) : undefined;
  }
  const fields: Record<string, string | undefined> = {
    ...common,
    ...own,
    doi,
    eprint: paper.arxivId ? paper.arxivId.replace(/^arxiv:/i, '') : undefined,
    archiveprefix: paper.arxivId ? 'arXiv' : undefined,
    primaryclass: paper.arxivId && paper.categories?.[0] ? paper.categories[0] : undefined,
    url: paper.landingUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId.replace(/^arxiv:/i, '')}` : undefined),
    keywords: paper.tags?.length ? paper.tags.join(', ') : undefined,
  };
  // What a style can't use is noise on a published paper: the preprint's ids stay on the preprint.
  if (type !== 'misc' && doi) {
    delete fields.eprint;
    delete fields.archiveprefix;
    delete fields.primaryclass;
    if (paper.landingUrl && /arxiv\.org/.test(paper.landingUrl)) delete fields.url;
  }
  return {
    type,
    key: keyOf(paper as Paper, opts),
    fields: Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => Boolean(entry[1]))),
  };
}

export const FIELD_ORDER = ['title', 'author', 'booktitle', 'journal', 'editor', 'volume', 'number', 'pages', 'year', 'month', 'publisher', 'address', 'doi', 'eprint', 'archiveprefix', 'primaryclass', 'url', 'keywords', 'note'];

/** The generated entry, as text. */
export function generatedBibtex(paper: PaperRef & { tags?: string[]; citation?: CitationRecord }, extra: VenueExtra = {}, opts: CitationOptions = options): string {
  return formatBibtex(generatedRecord(paper, extra, opts), FIELD_ORDER);
}

// ---------------------------------------------------------- the choice ---

export const SOURCE_LABELS: Record<CitationSource, string> = {
  crossref: 'Crossref',
  acl: 'ACL Anthology',
  openreview: 'OpenReview',
  dblp: 'dblp',
  arxiv: 'arXiv',
  datacite: 'DataCite',
  semanticscholar: 'Semantic Scholar',
  pasted: 'pasted',
  generated: 'made here',
};

/** The sources, the one closest to the paper's publisher first: a draft takes the first that answered. */
const OFFICIAL: CitationSource[] = ['crossref', 'acl', 'openreview', 'dblp', 'arxiv', 'datacite', 'semanticscholar', 'pasted', 'generated'];
const DBLP_FIRST: CitationSource[] = ['dblp', 'crossref', 'acl', 'openreview', 'arxiv', 'datacite', 'semanticscholar', 'pasted', 'generated'];

export function preferenceOrder(opts: CitationOptions = options): CitationSource[] {
  return opts.prefer === 'dblp' ? DBLP_FIRST : opts.prefer === 'generated' ? ['pasted', 'generated'] : OFFICIAL;
}

/** A variant of the published version of a preprint: fetched by a DOI the paper's own record lacks. */
export const isPublishedVersion = (paper: Paper, variant: CitationVariant) =>
  Boolean(paper.citation?.publishedDoi && variant.of && variant.of.toLowerCase() === paper.citation.publishedDoi.toLowerCase() && (!paper.doi || paper.doi.toLowerCase() !== paper.citation.publishedDoi.toLowerCase()));

/**
 * The variant the paper's citation is made from: the one chosen on the
 * paper, else the first the preference in Settings finds. The published
 * version of a preprint is taken only when Settings switch to it, or it
 * was chosen by hand.
 */
export function variantOf(paper: Paper, opts: CitationOptions = options): CitationVariant {
  const variants = paper.citation?.variants ?? [];
  const chosen = paper.citation?.chosen ? variants.find((variant) => variant.source === paper.citation!.chosen) : undefined;
  if (chosen) return chosen;
  const allowed = variants.filter((variant) => opts.published === 'switch' || !isPublishedVersion(paper, variant));
  for (const source of preferenceOrder(opts)) {
    const found = allowed.find((variant) => variant.source === source);
    if (found) return found;
  }
  return { source: 'generated', bibtex: generatedBibtex(paper, {}, opts), fetchedAt: '' };
}

/** The paper's BibTeX as a draft takes it: the chosen variant, under the paper's key. */
export function bibtexOf(paper: Paper, opts: CitationOptions = options): string {
  return rekey(variantOf(paper, opts).bibtex, keyOf(paper, opts));
}

/** What the drawer and the bibliography say of a paper's citation. */
export interface CitationState {
  key: string;
  source: CitationSource;
  /** `official · Crossref`, `dblp`, `made here`. */
  label: string;
  /** An entry fetched from an index, not made here. */
  official: boolean;
  /** A preprint whose published version is known and not yet taken: where it is, to offer the switch. */
  published?: { doi: string; in: string };
  /** The entry's type and venue as the variant has them: `@inproceedings · NeurIPS 2022`. */
  summary: string;
}

export function citationState(paper: Paper, opts: CitationOptions = options): CitationState {
  const variant = variantOf(paper, opts);
  const record = parseBibtex(variant.bibtex)[0];
  const official = variant.source !== 'generated' && variant.source !== 'pasted';
  const pending =
    opts.published !== 'keep' && paper.citation?.publishedDoi && !isPublishedVersion(paper, variant) && (!paper.doi || paper.doi.toLowerCase() !== paper.citation.publishedDoi.toLowerCase())
      ? { doi: paper.citation.publishedDoi, in: paper.citation.publishedIn ?? 'a journal or proceedings' }
      : undefined;
  const venue = plain(record?.fields.booktitle ?? record?.fields.journal ?? '');
  return {
    key: keyOf(paper, opts),
    source: variant.source,
    label: variant.source === 'generated' ? (paper.citation?.lookedAt ? 'made here · no source had it' : 'made here · not looked up yet') : variant.source === 'pasted' ? 'pasted' : `official · ${SOURCE_LABELS[variant.source]}`,
    official,
    published: pending,
    summary: [record ? `@${record.type}` : '', venue ? `${venue}${record?.fields.year && !venue.includes(plain(record.fields.year)) ? ` ${plain(record.fields.year)}` : ''}` : ''].filter(Boolean).join(' · '),
  };
}

/** The record with these variants put in, each source once, the newest kept. */
export function withVariants(record: CitationRecord | undefined, found: CitationVariant[], more: Partial<CitationRecord> = {}): CitationRecord {
  const variants = [...(record?.variants ?? [])];
  for (const variant of found) {
    const index = variants.findIndex((item) => item.source === variant.source);
    if (index >= 0) variants[index] = variant;
    else variants.push(variant);
  }
  return { ...(record ?? {}), ...more, variants };
}

// ------------------------------------------------------- the text forms ---

export type CiteFormat = CitationOptions['copy'];

export const CITE_FORMATS: { id: CiteFormat; label: string; note: string }[] = [
  { id: 'bibtex', label: 'BibTeX', note: 'the entry a draft takes' },
  { id: 'biblatex', label: 'BibLaTeX', note: 'as biblatex writes it' },
  { id: 'ris', label: 'RIS', note: 'Zotero, Mendeley, EndNote' },
  { id: 'apa', label: 'APA 7', note: 'text' },
  { id: 'ieee', label: 'IEEE', note: 'text' },
  { id: 'chicago', label: 'Chicago', note: 'author–date' },
  { id: 'markdown', label: 'Markdown link', note: 'for notes' },
];

/** What every text form reads from: the chosen entry's fields, the record filling in what it lacks. */
export interface CiteFields {
  type: string;
  key: string;
  title: string;
  authors: Name[];
  year?: string;
  /** The journal, or the proceedings. */
  venue?: string;
  inProceedings: boolean;
  volume?: string;
  number?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  eprint?: string;
}

export function citeFields(paper: Paper, opts: CitationOptions = options): CiteFields {
  const record = parseBibtex(bibtexOf(paper, opts))[0] ?? generatedRecord(paper, {}, opts);
  const f = record.fields;
  const authors = splitAuthors(f.author);
  return {
    type: record.type,
    key: record.key,
    title: plain(f.title) || paper.title,
    authors: authors.length ? authors : paper.authors.map(nameParts),
    year: plain(f.year) || (paper.published || '').slice(0, 4) || undefined,
    venue: plain(f.booktitle ?? f.journal) || paper.venue,
    inProceedings: record.type === 'inproceedings' || Boolean(f.booktitle),
    volume: plain(f.volume) || undefined,
    number: plain(f.number) || undefined,
    pages: plain(f.pages).replace(/--/g, '–') || undefined,
    publisher: plain(f.publisher) || undefined,
    doi: plain(f.doi) || paper.doi,
    url: plain(f.url) || paper.landingUrl,
    eprint: plain(f.eprint) || paper.arxivId?.replace(/^arxiv:/i, ''),
  };
}

const join = (names: string[], last = 'and', oxford = true) =>
  names.length <= 1 ? names.join('') : names.length === 2 ? `${names[0]} ${last} ${names[1]}` : `${names.slice(0, -1).join(', ')}${oxford ? ',' : ''} ${last} ${names[names.length - 1]}`;

/** The citation in the form asked, from the paper's chosen entry. */
export function citationAs(paper: Paper, format: CiteFormat, opts: CitationOptions = options): string {
  if (format === 'bibtex') return bibtexOf(paper, opts);
  const f = citeFields(paper, opts);
  const doiUrl = f.doi ? `https://doi.org/${f.doi}` : undefined;
  switch (format) {
    case 'biblatex':
      return biblatexOf(paper, f, opts);
    case 'ris':
      return risOf(f);
    case 'apa': {
      const names = f.authors.map((name) => (name.first ? `${name.last}, ${initials(name.first)}` : name.last));
      const who = names.length > 20 ? `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}` : join(names, '&');
      const where = f.inProceedings
        ? `In *${f.venue}*${f.pages ? ` (pp. ${f.pages})` : ''}.`
        : f.venue
          ? `*${f.venue}*${f.volume ? `, *${f.volume}*` : ''}${f.number ? `(${f.number})` : ''}${f.pages ? `, ${f.pages}` : ''}.`
          : f.eprint
            ? `arXiv. ${`https://arxiv.org/abs/${f.eprint}`}`
            : '';
      return `${who} (${f.year ?? 'n.d.'}). ${f.title}. ${where}${doiUrl ? ` ${doiUrl}` : ''}`.replace(/\s+/g, ' ').trim();
    }
    case 'ieee': {
      const names = f.authors.map((name) => (name.first ? `${initials(name.first)} ${name.last}` : name.last));
      const who = names.length > 6 ? `${names[0]} et al.` : join(names, 'and', names.length > 2);
      const where = f.inProceedings
        ? `in *${f.venue}*, ${f.year ?? 'n.d.'}${f.pages ? `, pp. ${f.pages}` : ''}.`
        : f.venue
          ? `*${f.venue}*${f.volume ? `, vol. ${f.volume}` : ''}${f.number ? `, no. ${f.number}` : ''}${f.pages ? `, pp. ${f.pages}` : ''}, ${f.year ?? 'n.d.'}.`
          : f.eprint
            ? `arXiv preprint arXiv:${f.eprint}, ${f.year ?? 'n.d.'}.`
            : `${f.year ?? 'n.d.'}.`;
      return `${who}, “${f.title},” ${where}${doiUrl ? ` doi: ${f.doi}.` : ''}`.replace(/\s+/g, ' ').trim();
    }
    case 'chicago': {
      const names = f.authors.map((name, index) => (index === 0 ? (name.first ? `${name.last}, ${name.first}` : name.last) : name.first ? `${name.first} ${name.last}` : name.last));
      const who = names.length > 10 ? `${names.slice(0, 7).join(', ')}, et al.` : join(names, 'and');
      const where = f.inProceedings
        ? `In *${f.venue}*${f.pages ? `, ${f.pages}` : ''}.${f.publisher ? ` ${f.publisher}.` : ''}`
        : f.venue
          ? `*${f.venue}*${f.volume ? ` ${f.volume}` : ''}${f.number ? ` (${f.number})` : ''}${f.pages ? `: ${f.pages}` : ''}.`
          : f.eprint
            ? `arXiv:${f.eprint}.`
            : '';
      return `${who}. ${f.year ?? 'n.d.'}. “${f.title}.” ${where}${doiUrl ? ` ${doiUrl}.` : ''}`.replace(/\s+/g, ' ').trim();
    }
    case 'markdown': {
      const link = f.url ?? doiUrl ?? (f.eprint ? `https://arxiv.org/abs/${f.eprint}` : undefined);
      const who = f.authors.length > 3 ? `${f.authors[0].last} et al.` : join(f.authors.map((name) => name.last), 'and', false);
      const tail = [who, f.venue, f.year].filter(Boolean).join(', ');
      return `${link ? `[${f.title}](${link})` : f.title}${tail ? ` — ${tail}` : ''}`;
    }
    default:
      return bibtexOf(paper, opts);
  }
}

function biblatexOf(paper: Paper, f: CiteFields, opts: CitationOptions): string {
  const record = parseBibtex(bibtexOf(paper, opts))[0];
  const fields = { ...(record?.fields ?? {}) };
  let type = record?.type ?? 'misc';
  if (type === 'misc' && fields.eprint) {
    type = 'online';
    fields.eprinttype = 'arxiv';
    delete fields.archiveprefix;
    if (fields.primaryclass) {
      fields.eprintclass = fields.primaryclass;
      delete fields.primaryclass;
    }
  }
  if (fields.year && !fields.date) {
    fields.date = fields.month ? `${fields.year}-${String(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(fields.month.toLowerCase()) + 1).padStart(2, '0')}` : fields.year;
    delete fields.year;
    delete fields.month;
  }
  if (fields.journal) {
    fields.journaltitle = fields.journal;
    delete fields.journal;
  }
  return formatBibtex({ type, key: f.key, fields }, ['title', 'author', 'booktitle', 'journaltitle', 'volume', 'number', 'pages', 'date', 'publisher', 'doi', 'eprint', 'eprinttype', 'eprintclass', 'url']);
}

function risOf(f: CiteFields): string {
  const lines: string[] = [];
  const put = (tag: string, value: string | undefined) => value && lines.push(`${tag}  - ${value}`);
  put('TY', f.inProceedings ? 'CONF' : f.venue ? 'JOUR' : 'UNPB');
  put('TI', f.title);
  for (const name of f.authors) put('AU', name.first ? `${name.last}, ${name.first}` : name.last);
  put('PY', f.year);
  put(f.inProceedings ? 'T2' : 'JO', f.venue);
  put('VL', f.volume);
  put('IS', f.number);
  const [start, end] = (f.pages ?? '').split(/\s*[–-]+\s*/);
  put('SP', start || undefined);
  put('EP', end || undefined);
  put('PB', f.publisher);
  put('DO', f.doi);
  put('UR', f.url);
  lines.push('ER  - ');
  return lines.join('\n');
}

// ----------------------------------------------------------- fetching ---

const CROSSREF = 'https://api.crossref.org';
const S2 = 'https://api.semanticscholar.org/graph/v1';
const DBLP = 'https://dblp.org';
const OPENREVIEW = 'https://api2.openreview.net';
const DATACITE = 'https://api.datacite.org';

/** The hosts whose APIs answer the page directly (CORS); the rest answer only the proxy's /cite route. */
const DIRECT = /^https:\/\/(api\.semanticscholar\.org|api2?\.openreview\.net|api\.crossref\.org|api\.datacite\.org|dblp\.org\/search)/;

/**
 * A source's answer as text: 404 is null (the source has no record), any
 * other refusal is thrown. A host that answers the page is asked directly
 * first, then through the proxy; the others the other way round. Without a
 * proxy only the direct ask is made.
 */
export async function fetchSource(url: string, init?: RequestInit): Promise<string | null> {
  const direct = () => fetch(url, init);
  const proxied = () => apiFetch(`/cite?url=${encodeURIComponent(url)}`);
  const order = !hasProxy() ? [direct] : DIRECT.test(url) ? [direct, proxied] : [proxied, direct];
  let refused: Error | null = null;
  for (const ask of order) {
    try {
      const response = await ask();
      // The source has no record — or a proxy from before this route has no route: the direct ask still settles it.
      if (response.status === 404) {
        if (ask === direct) return null;
        continue;
      }
      if (!response.ok) {
        refused = new Error(`${new URL(url).host} answered ${response.status}`);
        continue;
      }
      return await response.text();
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (refused) throw refused;
  return null;
}

async function jsonSource<T>(url: string): Promise<T | null> {
  const text = await fetchSource(url);
  return text === null ? null : (JSON.parse(text) as T);
}

const isBibtex = (text: string | null): text is string => Boolean(text && /^\s*@[a-zA-Z]+\s*[{(]/.test(text));
const now = () => new Date().toISOString();

/** The publisher's entry by DOI, as Crossref transforms its record. */
export async function fetchCrossref(doi: string): Promise<CitationVariant | null> {
  const query = politely(new URLSearchParams()).toString();
  const url = `${CROSSREF}/works/${encodeURIComponent(doi)}/transform/application/x-bibtex${query ? `?${query}` : ''}`;
  const got = await fetchSource(url, { headers: { Accept: 'application/x-bibtex' } });
  if (!isBibtex(got)) return null;
  return { source: 'crossref', bibtex: tidy(got), fetchedAt: now(), of: doi, url };
}

/** arXiv's own export of a preprint — what its Export BibTeX Citation link gives. */
export async function fetchArxivExport(arxivId: string): Promise<CitationVariant | null> {
  const id = arxivId.replace(/^arxiv:/i, '');
  const url = `https://arxiv.org/bibtex/${id}`;
  const got = await fetchSource(url);
  if (!isBibtex(got)) return null;
  return { source: 'arxiv', bibtex: tidy(got), fetchedAt: now(), of: id, url };
}

/** DataCite's record of a DOI it registered: every arXiv paper has one (10.48550/arXiv.<id>). */
export async function fetchDataCite(doi: string): Promise<CitationVariant | null> {
  const url = `${DATACITE}/dois/application/x-bibtex/${doi}`;
  const got = await fetchSource(url, { headers: { Accept: 'application/x-bibtex' } });
  if (!isBibtex(got)) return null;
  return { source: 'datacite', bibtex: tidy(got), fetchedAt: now(), of: doi, url };
}

/** The Anthology id of an ACL paper, from its DOI (10.18653/v1/<id>) or its page's address. */
export function aclIdOf(paper: Pick<PaperRef, 'doi' | 'landingUrl'>): string | null {
  const fromDoi = /^10\.18653\/v1\/([\w.-]+)$/i.exec(paper.doi ?? '')?.[1];
  if (fromDoi) return fromDoi;
  const fromUrl = /^https?:\/\/(?:www\.)?aclanthology\.org\/([\w.-]+?)(?:\.pdf|\.bib)?\/?$/i.exec(paper.landingUrl ?? '')?.[1];
  return fromUrl ?? null;
}

/** The ACL Anthology's entry, the form ACL and EMNLP ask to be cited in. */
export async function fetchAcl(paper: Pick<PaperRef, 'doi' | 'landingUrl'>): Promise<CitationVariant | null> {
  const id = aclIdOf(paper);
  if (!id) return null;
  const url = `https://aclanthology.org/${id}.bib`;
  const got = await fetchSource(url);
  if (!isBibtex(got)) return null;
  return { source: 'acl', bibtex: tidy(got), fetchedAt: now(), of: id, url };
}

interface S2Paper {
  externalIds?: { DOI?: string; ArXiv?: string };
  citationStyles?: { bibtex?: string };
  venue?: string;
  journal?: { name?: string; volume?: string; pages?: string } | null;
  year?: number;
  publicationVenue?: { name?: string; type?: string } | null;
}

/** Semantic Scholar's entry, and what it knows of where the paper was published. */
export async function fetchSemanticScholar(paper: Pick<PaperRef, 'doi' | 'arxivId'>): Promise<{ variant: CitationVariant | null; doi?: string; venue?: string } | null> {
  const id = paper.doi && !ARXIV_DOI.test(paper.doi) ? `DOI:${paper.doi}` : paper.arxivId ? `arXiv:${paper.arxivId.replace(/^arxiv:/i, '').replace(/v\d+$/, '')}` : null;
  if (!id) return null;
  const url = `${S2}/paper/${encodeURIComponent(id)}?fields=citationStyles,externalIds,venue,journal,year,publicationVenue`;
  const got = await jsonSource<S2Paper>(url);
  if (!got) return null;
  const bibtex = got.citationStyles?.bibtex;
  const doi = got.externalIds?.DOI && !ARXIV_DOI.test(got.externalIds.DOI) ? got.externalIds.DOI : undefined;
  const venue = got.publicationVenue?.name || got.journal?.name || got.venue || undefined;
  return {
    variant: isBibtex(bibtex ?? null) ? { source: 'semanticscholar', bibtex: tidy(bibtex!), fetchedAt: now(), of: id, url } : null,
    doi,
    venue: venue && !/^arxiv/i.test(venue) ? `${venue}${got.year ? ` ${got.year}` : ''}` : undefined,
  };
}

interface DblpHit {
  info?: { key?: string; title?: string; venue?: string | string[]; year?: string; doi?: string; url?: string; type?: string; volume?: string; pages?: string; number?: string; authors?: { author?: { text?: string } | { text?: string }[] } };
}

/** dblp's entry: the record whose title is the paper's, its .bib fetched; made from the record's own fields only when the file won't come. */
export async function fetchDblp(paper: Pick<PaperRef, 'title' | 'doi' | 'arxivId'>): Promise<{ variant: CitationVariant | null; doi?: string; venue?: string } | null> {
  const q = paper.title.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 8) return null;
  const got = await jsonSource<{ result?: { hits?: { hit?: DblpHit[] } } }>(`${DBLP}/search/publ/api?${new URLSearchParams({ q, format: 'json', h: '8' })}`);
  const hits = (got?.result?.hits?.hit ?? []).filter((hit) => hit.info?.title && titleFits(hit.info.title.replace(/\.$/, ''), paper.title) && hit.info.key);
  if (!hits.length) return null;
  // The published record over the CoRR (arXiv) one, when dblp has both.
  const hit = hits.find((item) => !/^journals\/corr\//.test(item.info!.key!)) ?? hits[0];
  const info = hit.info!;
  const key = info.key!;
  const doi = info.doi && !ARXIV_DOI.test(info.doi) ? info.doi : undefined;
  const venueName = Array.isArray(info.venue) ? info.venue[0] : info.venue;
  const venue = venueName && venueName !== 'CoRR' ? `${venueName}${info.year ? ` ${info.year}` : ''}` : undefined;
  const url = `${DBLP}/rec/${key}.bib?param=1`;
  let bibtex: string | null = null;
  try {
    bibtex = await fetchSource(url);
  } catch {
    bibtex = null;
  }
  if (!isBibtex(bibtex)) {
    const authors = info.authors?.author;
    const names = (Array.isArray(authors) ? authors : authors ? [authors] : []).map((author) => (author.text ?? '').replace(/\s\d{4}$/, '')).filter(Boolean);
    const conference = info.type === 'Conference and Workshop Papers' || /^conf\//.test(key);
    bibtex = formatBibtex(
      {
        type: conference ? 'inproceedings' : info.type === 'Journal Articles' ? 'article' : 'misc',
        key: `DBLP:${key}`,
        fields: Object.fromEntries(
          Object.entries({
            title: escapeBib((info.title ?? paper.title).replace(/\.$/, '')),
            author: names.map(escapeBib).join(' and '),
            [conference ? 'booktitle' : 'journal']: venueName && venueName !== 'CoRR' ? escapeBib(venueName) : '',
            volume: info.volume ?? '',
            number: info.number ?? '',
            pages: info.pages ?? '',
            year: info.year ?? '',
            doi: doi ?? '',
            url: info.url ?? '',
            bibsource: 'dblp computer science bibliography, https://dblp.org',
          }).filter(([, value]) => value),
        ),
      },
      FIELD_ORDER,
    );
  }
  return { variant: { source: 'dblp', bibtex: tidy(bibtex), fetchedAt: now(), of: key, url: `${DBLP}/rec/${key}` }, doi, venue };
}

interface OpenReviewNote {
  id?: string;
  content?: { title?: { value?: string } | string; _bibtex?: { value?: string } | string; venue?: { value?: string } | string };
}

const value = (field: { value?: string } | string | undefined) => (typeof field === 'string' ? field : field?.value);

/** OpenReview's own entry, for a paper reviewed there (ICLR, NeurIPS since 2023, and more). */
export async function fetchOpenReview(paper: Pick<PaperRef, 'title'>): Promise<{ variant: CitationVariant | null; venue?: string } | null> {
  const got = await jsonSource<{ notes?: OpenReviewNote[] }>(`${OPENREVIEW}/notes?${new URLSearchParams({ 'content.title': paper.title, limit: '5' })}`);
  const note = (got?.notes ?? []).find((item) => value(item.content?._bibtex) && titleFits(value(item.content?.title) ?? '', paper.title));
  if (!note) return null;
  const venue = value(note.content?.venue);
  return {
    variant: { source: 'openreview', bibtex: tidy(value(note.content!._bibtex)!), fetchedAt: now(), of: venue, url: note.id ? `https://openreview.net/forum?id=${note.id}` : undefined },
    venue: venue && !/submitted|rejected|withdrawn/i.test(venue) ? venue : undefined,
  };
}

/** An entry as fetched, with its line endings and stray blank lines straightened. */
export function tidy(bibtex: string): string {
  return bibtex.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every source asked for the paper's entry, at once, and what they said
 * put together: the variants found, each with the address that answered,
 * and the published version where the paper is a preprint and an index
 * knows where it came out. Nothing here throws: a source that would not
 * answer is simply not among the variants. Nothing is made up: an entry
 * made from the record is never kept as a variant, and a draft falls back
 * to it only while no source has answered.
 */
export async function lookupCitations(paper: Paper): Promise<CitationRecord> {
  const found: CitationVariant[] = [];
  let publishedDoi: string | undefined;
  let publishedIn: string | undefined;
  const arxivId = paper.arxivId?.replace(/^arxiv:/i, '').replace(/v\d+$/, '');

  const [s2, dblp, openreview, arxiv, datacite, acl] = await Promise.all([
    fetchSemanticScholar(paper).catch(() => null),
    fetchDblp(paper).catch(() => null),
    fetchOpenReview(paper).catch(() => null),
    arxivId ? fetchArxivExport(arxivId).catch(() => null) : null,
    arxivId ? fetchDataCite(`10.48550/arXiv.${arxivId}`).catch(() => null) : null,
    fetchAcl(paper).catch(() => null),
  ]);
  for (const answer of [s2, dblp]) {
    if (!answer) continue;
    if (answer.variant) found.push(answer.variant);
    if (answer.doi && (!paper.doi || ARXIV_DOI.test(paper.doi)) && !publishedDoi) {
      publishedDoi = answer.doi;
      publishedIn = answer.venue;
    }
  }
  for (const variant of [openreview?.variant, arxiv, datacite, acl]) if (variant) found.push(variant);
  if (!publishedIn && (s2?.venue || dblp?.venue)) publishedIn = s2?.venue ?? dblp?.venue;

  const doi = paper.doi && !ARXIV_DOI.test(paper.doi) ? paper.doi : publishedDoi;
  if (doi) {
    const crossref = await fetchCrossref(doi).catch(() => null);
    if (crossref) found.push(crossref);
  }
  const record = withVariants(paper.citation, found, { lookedAt: now(), error: undefined });
  if (publishedDoi) {
    record.publishedDoi = publishedDoi;
    if (publishedIn) record.publishedIn = publishedIn;
  }
  if (!record.variants.some((variant) => variant.source !== 'generated' && variant.source !== 'pasted')) record.error = 'No source had an entry for it.';
  return record;
}
