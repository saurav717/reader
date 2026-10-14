/**
 * The draft's .bib fitted to the venue it is written for.
 *
 * A bibliography style wants its entries a certain way, and the template
 * says which style: ICLR's and ACL's are natbib author–year, and need an
 * author and a year on every entry; IEEE's and NeurIPS's are numeric; all
 * of them print a conference paper from `booktitle`, not `journal`, and
 * none has a use for an arXiv eprint on a paper that was published. The
 * lint here reads the style off the files, checks each entry against it,
 * and offers each fix as the .bib rewritten — and, for two entries that
 * are one paper, the .tex files with the \cite keys made one.
 *
 * Pinned by scripts/bib-fit.test.mjs.
 */
import type { Paper } from '../types';
import { FIELD_ORDER, formatBibtex, parseBibtex, venueKindOf, type BibRecord } from './citeRecord';

export interface DraftFileText {
  path: string;
  text: string;
}

export interface StyleInfo {
  /** `ICLR`, `ACL`, `IEEE`, `NeurIPS`, `CVPR`, `ACM`, `Springer`, or the .bst's name. */
  name: string;
  /** The .bst named, or the file found. */
  bst?: string;
  /** Citations as (Author, year), which need an author and a year on every entry. */
  authorYear: boolean;
  /** biblatex rather than BibTeX. */
  biblatex: boolean;
  /** What the style wants, each a line for the panel: [what, whether every entry has it]. */
  wants: { rule: string; ok: boolean; failing: number }[];
}

export type Severity = 'bad' | 'warn' | 'info';

export interface FitIssue {
  id: string;
  severity: Severity;
  key: string;
  /** The .bib the entry is in. */
  path: string;
  message: string;
  detail?: string;
  fix?: FitFix;
}

export interface FitFix {
  label: string;
  /** The .bib files as they would be. */
  bib: { path: string; text: string }[];
  /** The .tex files as they would be, where a key was merged into another. */
  tex?: { path: string; text: string }[];
}

export interface FitReport {
  style: StyleInfo;
  issues: FitIssue[];
  entries: number;
}

const stripComments = (text: string) => text.replace(/(^|[^\\])%[^\n]*/g, '$1');

/** The style the template uses, read off the .tex and the .bst files. */
export function styleOf(files: DraftFileText[]): Omit<StyleInfo, 'wants'> {
  const tex = files.filter((file) => /\.tex$/i.test(file.path)).map((file) => stripComments(file.text)).join('\n');
  const bsts = files.filter((file) => /\.bst$/i.test(file.path)).map((file) => file.path.replace(/^.*\//, '').replace(/\.bst$/i, ''));
  const named = /\\bibliographystyle\{([^}]+)\}/.exec(tex)?.[1]?.trim();
  const biblatex = /\\usepackage(\[[^\]]*\])?\{biblatex\}/.test(tex);
  const biblatexStyle = /\\usepackage\[([^\]]*)\]\{biblatex\}/.exec(tex)?.[1] ?? '';
  const bst = named ?? bsts[0];
  // The style named in the .tex is the one that runs; a .bst left in the folder from another template is not.
  const all = `${bst ?? ''} ${named ? '' : bsts.join(' ')} ${tex.match(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/)?.[0] ?? ''} ${tex.match(/\\usepackage(\[[^\]]*\])?\{[^}]+\}/g)?.join(' ') ?? ''}`.toLowerCase();
  const natbib = /natbib/.test(all) || /\\citep|\\citet/.test(tex);
  let name = bst ?? (biblatex ? 'biblatex' : 'plain');
  let authorYear = /plainnat|abbrvnat|unsrtnat|apalike|chicago|harvard|authordate|natbib/.test(all) && !/unsrtnat|plainnat.*numbers/.test(all) && !/\\usepackage\[[^\]]*numbers[^\]]*\]\{natbib\}/.test(tex);
  if (/iclr/.test(all)) {
    name = 'ICLR';
    authorYear = true;
  } else if (/acl_natbib|acl\b/.test(all)) {
    name = 'ACL';
    authorYear = true;
  } else if (/ieeetran|ieeenat|cvpr|iccv|eccv|wacv/.test(all)) {
    name = /cvpr/.test(all) ? 'CVPR' : /iccv/.test(all) ? 'ICCV' : /eccv/.test(all) ? 'ECCV' : 'IEEE';
    authorYear = /ieeenat_fullname/.test(all) ? false : authorYear && !/ieeetran/.test(all);
  } else if (/neurips|nips/.test(all)) {
    name = 'NeurIPS';
    authorYear = natbib && !/unsrtnat/.test(all) && !/numbers/.test(all);
  } else if (/acmart|acm/.test(all)) {
    name = 'ACM';
    authorYear = /authoryear/.test(all);
  } else if (/splncs|svjour|llncs|sn-jnl/.test(all)) {
    name = 'Springer';
    authorYear = false;
  } else if (biblatex) {
    name = 'biblatex';
    authorYear = /authoryear|apa|chicago/.test(biblatexStyle);
  } else if (/apalike|apa/.test(all)) {
    name = 'APA';
    authorYear = true;
  }
  return { name, bst, authorYear, biblatex };
}

/** Where an entry sits in a .bib text: from its @ to the brace that closes it. */
export function entrySpan(text: string, key: string): { start: number; end: number } | null {
  const head = new RegExp(`@[a-zA-Z]+\\s*[{(]\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`);
  const match = head.exec(text);
  if (!match) return null;
  const close = match[0].includes('(') ? ')' : '}';
  let depth = 0;
  for (let i = match.index + match[0].length; i < text.length; i += 1) {
    const character = text[i];
    if (character === '{') depth += 1;
    else if (character === '}' || character === close) {
      if (depth === 0) return { start: match.index, end: i + 1 };
      if (character === '}') depth -= 1;
    }
  }
  return { start: match.index, end: text.length };
}

/** The .bib with one entry written over by another, or taken out when `next` is null. */
export function replaceEntry(text: string, key: string, next: BibRecord | null): string {
  const span = entrySpan(text, key);
  if (!span) return text;
  const replacement = next ? formatBibtex(next, FIELD_ORDER) : '';
  const before = text.slice(0, span.start);
  const after = text.slice(span.end);
  if (!next) return `${before.replace(/\n+$/, '\n')}${after.replace(/^\n+/, '\n')}`.replace(/^\n/, '');
  return `${before}${replacement}${after}`;
}

const foldTitle = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const bareArxiv = (id: string) => id.replace(/^arxiv:/i, '').replace(/v\d+$/, '');
const CITE = /(\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{)([^}]*)(\})/g;

/** A key written over another in every \cite of the .tex files. */
export function mergeKeys(files: DraftFileText[], from: string, into: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const file of files) {
    if (!/\.tex$/i.test(file.path)) continue;
    const text = file.text.replace(CITE, (whole, open: string, keys: string, close: string) => {
      const list = keys.split(',').map((key) => key.trim());
      if (!list.includes(from)) return whole;
      const next = [...new Set(list.map((key) => (key === from ? into : key)))];
      return `${open}${next.join(', ')}${close}`;
    });
    if (text !== file.text) out.push({ path: file.path, text });
  }
  return out;
}

/** What a venue is to an entry: its booktitle, its journal, or nothing. */
const venueOf = (record: BibRecord) => record.fields.booktitle ?? record.fields.journal ?? '';
const isPreprintVenue = (venue: string) => !venue || /^(corr|arxiv|arxiv preprint|arxiv\.org|biorxiv|medrxiv|ssrn|preprint)/i.test(venue.replace(/[{}]/g, '').trim());

/** The project's paper an entry is, by DOI, arXiv id or title. */
export function paperOf(record: BibRecord, papers: Paper[]): Paper | undefined {
  const doi = record.fields.doi?.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  const eprint = record.fields.eprint ? bareArxiv(record.fields.eprint) : undefined;
  const title = foldTitle(record.fields.title ?? '');
  return (
    (doi && papers.find((paper) => paper.doi?.toLowerCase() === doi)) ||
    (eprint && papers.find((paper) => paper.arxivId && bareArxiv(paper.arxivId) === eprint)) ||
    (title.length > 12 && papers.find((paper) => foldTitle(paper.title) === title)) ||
    undefined
  );
}

/**
 * Every entry checked against the style, and the fixes. `publishedOf`
 * gives the published version's entry for a project paper that has one
 * (the variant fetched by its published DOI), already under the key the
 * draft uses, for the switch.
 */
export function bibFit(files: DraftFileText[], papers: Paper[], publishedOf: (paper: Paper, key: string) => string | null = () => null): FitReport {
  const style = styleOf(files);
  const bibs = files.filter((file) => /\.bib$/i.test(file.path));
  const issues: FitIssue[] = [];
  const all: { path: string; record: BibRecord }[] = [];
  for (const bib of bibs) for (const record of parseBibtex(bib.text)) all.push({ path: bib.path, record });

  const bibWith = (path: string, text: string) => bibs.map((bib) => ({ path: bib.path, text: bib.path === path ? text : bib.text }));
  const counts = { conference: 0, authorYear: 0, eprint: 0, preprint: 0, year: 0 };

  for (const { path, record } of all) {
    const bib = bibs.find((file) => file.path === path)!;
    const venue = venueOf(record);
    const kind = venueKindOf(venue.replace(/[{}]/g, ''));
    const paper = paperOf(record, papers);

    // 1. A conference paper as @article: the style prints "journal" where it wants "In booktitle".
    if (record.type === 'article' && kind === 'conference') {
      counts.conference += 1;
      const fields = { ...record.fields };
      fields.booktitle = fields.journal;
      delete fields.journal;
      const next: BibRecord = { type: 'inproceedings', key: record.key, fields };
      issues.push({
        id: `conf:${record.key}`,
        severity: 'bad',
        key: record.key,
        path,
        message: `${record.key} is @article with the proceedings as its journal`,
        detail: `Conference papers are @inproceedings with a booktitle: "${venue.replace(/[{}]/g, '')}".`,
        fix: { label: 'Make it @inproceedings', bib: bibWith(path, replaceEntry(bib.text, record.key, next)) },
      });
    }

    // 2. A preprint whose published version the library knows.
    if (paper && isPreprintVenue(venue) && paper.citation?.publishedDoi) {
      const published = publishedOf(paper, record.key);
      counts.preprint += 1;
      issues.push({
        id: `published:${record.key}`,
        severity: 'warn',
        key: record.key,
        path,
        message: `${record.key} cites the preprint; published in ${paper.citation.publishedIn ?? 'a venue the index knows'}`,
        detail: published ? 'The published version’s entry goes in under the same key.' : 'Fetch official citations to bring its entry in, then switch.',
        fix: published ? { label: 'Switch to the published version', bib: bibWith(path, bib.text.slice(0, entrySpan(bib.text, record.key)!.start) + published + bib.text.slice(entrySpan(bib.text, record.key)!.end)) } : undefined,
      });
    }

    // 3. An eprint on a published paper: the style prints it as if the paper were still a preprint, or ignores it.
    if (!isPreprintVenue(venue) && (record.fields.eprint || record.fields.archiveprefix) && !style.biblatex) {
      counts.eprint += 1;
      const fields = { ...record.fields };
      delete fields.eprint;
      delete fields.archiveprefix;
      delete fields.primaryclass;
      issues.push({
        id: `eprint:${record.key}`,
        severity: 'info',
        key: record.key,
        path,
        message: `${record.key} was published, and still carries its arXiv eprint`,
        detail: `${style.name}'s style prints the venue; the eprint is noise beside it.`,
        fix: { label: 'Drop the eprint', bib: bibWith(path, replaceEntry(bib.text, record.key, { ...record, fields })) },
      });
    }

    // 4. Author–year styles need both on every entry.
    if (style.authorYear && (!record.fields.author || !record.fields.year)) {
      counts.authorYear += 1;
      const missing = [!record.fields.author ? 'author' : '', !record.fields.year ? 'year' : ''].filter(Boolean).join(' and ');
      const fields = { ...record.fields };
      if (paper) {
        if (!fields.author && paper.authors.length) fields.author = paper.authors.join(' and ');
        if (!fields.year && paper.published) fields.year = paper.published.slice(0, 4);
      }
      const fixable = (fields.author && fields.year) !== undefined && Boolean(fields.author && fields.year);
      issues.push({
        id: `authoryear:${record.key}`,
        severity: 'bad',
        key: record.key,
        path,
        message: `${record.key} has no ${missing}; ${style.name} cites as (Author, year)`,
        detail: fixable ? 'Filled in from the paper’s record.' : paper ? 'The paper’s record has neither; add them by hand.' : 'Not one of the project’s papers; add them by hand.',
        fix: fixable ? { label: `Add the ${missing}`, bib: bibWith(path, replaceEntry(bib.text, record.key, { ...record, fields })) } : undefined,
      });
    } else if (!record.fields.year && record.type !== 'misc') {
      counts.year += 1;
      issues.push({ id: `year:${record.key}`, severity: 'warn', key: record.key, path, message: `${record.key} has no year`, detail: paper?.published ? 'The paper’s record has one.' : undefined, fix: paper?.published ? { label: 'Add the year', bib: bibWith(path, replaceEntry(bib.text, record.key, { ...record, fields: { ...record.fields, year: paper.published.slice(0, 4) } })) } : undefined });
    }
  }

  // 5. Two entries that are one paper.
  const seen = new Map<string, { path: string; record: BibRecord }>();
  for (const item of all) {
    const ids = [
      item.record.fields.doi ? `doi:${item.record.fields.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}` : '',
      item.record.fields.eprint ? `arxiv:${bareArxiv(item.record.fields.eprint)}` : '',
      item.record.fields.title && foldTitle(item.record.fields.title).length > 12 ? `title:${foldTitle(item.record.fields.title)}` : '',
    ].filter(Boolean);
    const twin = ids.map((id) => seen.get(id)).find(Boolean);
    if (twin && twin.record.key !== item.record.key) {
      // The one with more fields stays; the other's cites are moved to it.
      const keep = Object.keys(twin.record.fields).length >= Object.keys(item.record.fields).length ? twin : item;
      const drop = keep === twin ? item : twin;
      const dropBib = bibs.find((file) => file.path === drop.path)!;
      issues.push({
        id: `dup:${drop.record.key}`,
        severity: 'info',
        key: drop.record.key,
        path: drop.path,
        message: `${drop.record.key} and ${keep.record.key} look like the same paper`,
        detail: `Merging keeps ${keep.record.key} and rewrites \\cite{${drop.record.key}} in the .tex files.`,
        fix: { label: `Merge into ${keep.record.key}`, bib: bibWith(drop.path, replaceEntry(dropBib.text, drop.record.key, null)), tex: mergeKeys(files, drop.record.key, keep.record.key) },
      });
      continue;
    }
    for (const id of ids) if (!seen.has(id)) seen.set(id, item);
  }

  const wants: StyleInfo['wants'] = [
    { rule: 'conference papers as @inproceedings with a booktitle', ok: counts.conference === 0, failing: counts.conference },
    ...(style.authorYear ? [{ rule: `an author and a year on every entry (${style.name} cites as Author, year)`, ok: counts.authorYear === 0, failing: counts.authorYear }] : [{ rule: 'a year on every published entry', ok: counts.year === 0, failing: counts.year }]),
    { rule: 'no arXiv eprint on a paper that was published', ok: counts.eprint === 0, failing: counts.eprint },
    { rule: 'the published version over the preprint, where there is one', ok: counts.preprint === 0, failing: counts.preprint },
    { rule: 'each paper once', ok: !issues.some((issue) => issue.id.startsWith('dup:')), failing: issues.filter((issue) => issue.id.startsWith('dup:')).length },
  ];
  const order: Record<Severity, number> = { bad: 0, warn: 1, info: 2 };
  return { style: { ...style, wants }, issues: issues.sort((a, b) => order[a.severity] - order[b.severity]), entries: all.length };
}

/** Every fix applied at once, later ones on top of earlier: the files as they would be. */
export function applyAll(files: DraftFileText[], issues: FitIssue[], papers: Paper[] = [], publishedOf: (paper: Paper, key: string) => string | null = () => null): { path: string; text: string }[] {
  let current = files.map((file) => ({ ...file }));
  const changed = new Set<string>();
  for (const issue of issues) {
    if (!issue.fix) continue;
    // Each fix was made against the files as they were: made again against them as they are now, and skipped once it no longer applies.
    const same = bibFit(current, papers, publishedOf).issues.find((item) => item.id === issue.id);
    if (!same?.fix) continue;
    for (const file of [...same.fix.bib, ...(same.fix.tex ?? [])]) {
      const index = current.findIndex((item) => item.path === file.path);
      if (index >= 0 && current[index].text !== file.text) {
        current = current.map((item, at) => (at === index ? { ...item, text: file.text } : item));
        changed.add(file.path);
      }
    }
  }
  return current.filter((file) => changed.has(file.path));
}
