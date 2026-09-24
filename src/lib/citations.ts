/**
 * The citations in a paper's text, tied to the entries of its bibliography,
 * so that hovering over "[12]" or "(Vaswani et al., 2017)" can say what was
 * cited.
 *
 * arXiv's HTML rendering already links every citation to its entry; a
 * reflowed PDF has only the text, so the citations are found in it here and
 * wrapped, and the bibliography's paragraphs are numbered. The wrapping adds
 * elements and no text, so a highlight made before it — which is anchored on
 * the text alone — still lands where it was.
 */

/** The class a citation carries, and the attribute naming the entries it cites. */
export const CITE_CLASS = 'cite';
export const REF_CLASS = 'ref-entry';

/** A bibliography entry, as the text reads it. */
export interface ReferenceEntry {
  id: string;
  text: string;
}

/** A citation found in a run of text: where it is, and the entries it names. */
export interface CitationMatch {
  start: number;
  end: number;
  refs: string[];
}

// ------------------------------------------------------------- the text ---

/** Accents, case and punctuation aside — what two spellings of a name share. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** "3, 5–7" -> [3, 5, 6, 7]. A range longer than 50 is not a citation. */
export function citationNumbers(inner: string): number[] | null {
  const out: number[] = [];
  for (const part of inner.split(/[,;]/)) {
    const piece = part.trim();
    if (!piece) return null;
    const range = /^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from > 50) return null;
      for (let n = from; n <= to; n += 1) out.push(n);
      continue;
    }
    if (!/^\d{1,3}$/.test(piece)) return null;
    out.push(Number(piece));
  }
  return out.length ? out : null;
}

/** The number an entry is listed under — "[12]" or "12." at its head — if it has one. */
export function entryNumber(text: string): number | null {
  const match = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.\s)/.exec(text);
  return match ? Number(match[1] || match[2]) : null;
}

/** The first year an entry names, with its letter — "2019b" — where it has one. */
export function entryYear(text: string): string | null {
  return /\b((?:19|20)\d{2}[a-z]?)\b/.exec(text)?.[1] ?? null;
}

/**
 * How a paper's citations find their entries: by number, or by first
 * author's surname and year. Built once for the bibliography.
 */
export interface ReferenceIndex {
  byNumber(n: number): string | null;
  byAuthorYear(surname: string, year: string): string | null;
  /** The highest number an entry is listed under. */
  largest: number;
}

export function referenceIndex(entries: ReferenceEntry[]): ReferenceIndex {
  const numbered = new Map<number, string>();
  let labelled = 0;
  for (const entry of entries) {
    const n = entryNumber(entry.text);
    if (n !== null && !numbered.has(n)) {
      numbered.set(n, entry.id);
      labelled += 1;
    }
  }
  // A list whose entries carry no numbers of their own is numbered in order,
  // which is what the citations count by when the numbers were set apart
  // from the entries and lost on the way here.
  if (labelled < entries.length / 2) {
    numbered.clear();
    entries.forEach((entry, index) => numbered.set(index + 1, entry.id));
  }

  // The head of an entry, up to its year, is where its authors are.
  const heads = entries.map((entry) => {
    const year = entryYear(entry.text);
    const cut = year ? entry.text.indexOf(year) : 160;
    return { id: entry.id, year, head: ` ${fold(entry.text.slice(0, Math.max(cut, 0) || 160))} ` };
  });

  return {
    largest: Math.max(0, ...numbered.keys()),
    byNumber: (n) => numbered.get(n) ?? null,
    byAuthorYear(surname, year) {
      const name = fold(surname);
      if (name.length < 2) return null;
      const exact = heads.find((entry) => entry.year === year && entry.head.includes(` ${name} `));
      if (exact) return exact.id;
      // "2019" in the text and "2019a" in the list, or the other way round.
      const loose = heads.find((entry) => entry.year?.slice(0, 4) === year.slice(0, 4) && entry.head.includes(` ${name} `));
      return loose?.id ?? null;
    },
  };
}

const NAME = String.raw`[\p{Lu}][\p{L}'’\-]+(?:\s+(?:van|von|de|der|den|da|di|du|le|la)\s+[\p{Lu}][\p{L}'’\-]+)?`;
const SECOND = String.raw`(?:\s+et\s+al\.?|\s+(?:and|&)\s+${NAME})?`;
const YEAR = String.raw`(?:19|20)\d{2}[a-z]?`;

/** "[12]", "[3, 5–7]". */
const NUMERIC = /\[(\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*)\]/g;
/** "Vaswani et al. (2017)", "Smith and Jones (2019a)". */
const NARRATIVE = new RegExp(String.raw`(${NAME})${SECOND}\s+\((${YEAR})(?:,\s*${YEAR})*\)`, 'gu');
/** A parenthesis with a year in it — "(Vaswani et al., 2017; Lee 2020)", or "[Lee 2020]" — whose parts are found one by one. */
const PARENTHETICAL = new RegExp(String.raw`[([]([^()[\]]{4,400}?${YEAR})[)\]]`, 'gu');
const PART = new RegExp(String.raw`(${NAME})${SECOND},?\s+(${YEAR})`, 'gu');
/** The authors a numbered citation is written after: "Dorrington et al [1]", "Marr and Poggio [4]". */
const NAMED_BEFORE = new RegExp(String.raw`(${NAME})(?:\s+et\s+al\.?|\s+(?:and|&)\s+${NAME})(?:’s|'s)?\s*$`, 'u');

/**
 * Every citation in a run of text that names an entry of the bibliography.
 * A bracketed number no entry could have — nought, or past the end of the
 * list — is left alone: it is an interval, or an equation's number.
 */
export function findCitations(text: string, index: ReferenceIndex): CitationMatch[] {
  const found: CitationMatch[] = [];
  const add = (match: CitationMatch) => {
    if (!match.refs.length) return;
    if (found.some((other) => match.start < other.end && other.start < match.end)) return;
    found.push(match);
  };

  for (const match of text.matchAll(NUMERIC)) {
    const numbers = citationNumbers(match[1]);
    if (!numbers || numbers.some((n) => n < 1 || n > index.largest)) continue;
    // An entry the list lost on the way here does not undo the rest.
    const refs = numbers.map((n) => index.byNumber(n)).filter((ref): ref is string => ref !== null);
    let start = match.index!;
    // The authors named in front of it are part of the citation.
    const before = NAMED_BEFORE.exec(text.slice(Math.max(0, start - 120), start));
    if (before) start -= before[0].length;
    add({ start, end: match.index! + match[0].length, refs: Array.from(new Set(refs)) });
  }

  for (const match of text.matchAll(NARRATIVE)) {
    const ref = index.byAuthorYear(match[1], match[2]);
    if (ref) add({ start: match.index!, end: match.index! + match[0].length, refs: [ref] });
  }

  for (const match of text.matchAll(PARENTHETICAL)) {
    const inner = match[1];
    const offset = match.index! + 1;
    const parts: CitationMatch[] = [];
    for (const part of inner.matchAll(PART)) {
      const ref = index.byAuthorYear(part[1], part[2]);
      if (ref) parts.push({ start: offset + part.index!, end: offset + part.index! + part[0].length, refs: [ref] });
    }
    // A parenthesis that is one citation and nothing else is marked whole.
    if (parts.length === 1 && inner.trim() === text.slice(parts[0].start, parts[0].end).trim()) {
      add({ start: match.index!, end: match.index! + match[0].length, refs: parts[0].refs });
    } else {
      parts.forEach(add);
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------ the entry itself ---

export interface ParsedReference {
  text: string;
  number?: number;
  year?: string;
  doi?: string;
  arxivId?: string;
  title?: string;
}

/**
 * What can be read off a bibliography entry without asking anyone: its DOI
 * or arXiv id where it prints one, its year, and a guess at its title — the
 * sentence after the authors, in every style this reader has met:
 *
 *   A. Vaswani, N. Shazeer. Attention is all you need. In NeurIPS, 2017.
 *   Vaswani, A., Shazeer, N. (2017). Attention is all you need. NeurIPS.
 *   Vaswani A, Shazeer N (2017) Attention is all you need. NeurIPS
 *   A. Vaswani et al., “Attention is all you need,” in NeurIPS, 2017.
 */
export function parseReference(raw: string): ParsedReference {
  const text = raw.replace(/\s+/g, ' ').trim();
  const out: ParsedReference = { text };
  const number = entryNumber(text);
  if (number !== null) out.number = number;
  const body = text.replace(/^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s*/, '');
  const year = entryYear(body);
  if (year) out.year = year;
  const doi = /\b(10\.\d{4,9}\/[^\s"<>]+)/i.exec(body)?.[1]?.replace(/[.,;)\]]+$/, '');
  if (doi) out.doi = doi;
  const arxiv =
    /arxiv[:\s./]*(?:abs\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(body)?.[1] ||
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(body)?.[1];
  if (arxiv) out.arxivId = arxiv;
  const title = guessTitle(body);
  if (title) out.title = title;
  return out;
}

function guessTitle(body: string): string | undefined {
  const quoted = /[“"]([^”"]{8,300}?)[,.]?[”"]/.exec(body)?.[1];
  if (quoted) return quoted.replace(/[,.]\s*$/, '').trim();

  // Sentences, split at a full stop after a word or a closing bracket — not
  // after an initial, which is what the authors are full of.
  const sentences = body
    .split(/(?<=(?:\p{L}\p{Ll}|\d{2}|\)|\p{Lu}{2}))[.?!]\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!sentences.length) return undefined;

  // "Vaswani A, Shazeer N (2017) Attention is all you need" — the year in
  // brackets and the title straight after it.
  const afterYear = /\((?:19|20)\d{2}[a-z]?\)[.,:]?\s+(.{8,})$/.exec(sentences[0])?.[1];
  if (afterYear) return trimTitle(afterYear);

  const candidates = sentences.slice(1).filter((sentence) => {
    if (/^(in|proc|proceedings|arxiv|preprint|journal|trans|advances|url|doi|available|accessed|http)\b/i.test(sentence)) return false;
    if (/^\(?(?:19|20)\d{2}[a-z]?\)?$/.test(sentence)) return false;
    return sentence.split(/\s+/).length >= 2;
  });
  const title = candidates[0];
  return title ? trimTitle(title) : undefined;
}

function trimTitle(value: string): string {
  return value.replace(/^\((?:19|20)\d{2}[a-z]?\)[.,:]?\s*/, '').replace(/[.,;:]\s*$/, '').trim();
}

/**
 * Whether a record found by searching is the entry's paper: its title has
 * to be in the entry, near enough word for word. A search on a reference
 * always finds something, and a neighbour is worse than nothing.
 */
export function titleFits(candidate: string, entry: string): boolean {
  const title = fold(candidate);
  const text = fold(entry);
  if (title.length < 8) return false;
  if (text.includes(title)) return true;
  const words = title.split(' ').filter((word) => word.length > 2);
  if (words.length < 3) return false;
  const have = new Set(text.split(' '));
  const hits = words.filter((word) => have.has(word)).length;
  return hits / words.length >= 0.85;
}

// -------------------------------------------------------------- the DOM ---

const REFERENCES_HEADING = /^(?:[\dIVX]+(?:\.\d+)*\.?\s+)?(?:references|bibliography|literature cited|works cited)\s*$/i;

/** The bibliography's entries in a reflowed PDF: the paragraphs under its heading, up to the next section. */
function pdfEntries(root: Element): Element[] {
  const headings = Array.from(root.querySelectorAll('h2, h3, h4'));
  const heading = headings.reverse().find((element) => REFERENCES_HEADING.test((element.textContent || '').trim()));
  if (!heading) return [];
  const level = Number(heading.tagName.slice(1));
  const entries: Element[] = [];
  for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
    if (/^H[1-6]$/.test(node.tagName) && Number(node.tagName.slice(1)) <= level) break;
    if (node.tagName === 'P' || node.tagName === 'LI') entries.push(node);
    else if (node.tagName === 'OL' || node.tagName === 'UL') entries.push(...Array.from(node.children));
  }
  return entries.filter((entry) => (entry.textContent || '').trim().length > 12);
}

/**
 * Mark the citations in a paper's HTML — in place — and say how many there
 * were. arXiv's own links are given the class; a reflowed PDF's citations
 * are found in the text and wrapped, each naming the entries it cites.
 */
export function annotateCitations(root: Element): number {
  const doc = root.ownerDocument;
  const linked = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href^="#bib"]'));
  if (linked.length) {
    for (const anchor of linked) {
      anchor.classList.add(CITE_CLASS);
      anchor.setAttribute('data-refs', anchor.getAttribute('href')!.slice(1));
    }
    root.querySelectorAll('.ltx_bibitem').forEach((item) => item.classList.add(REF_CLASS));
    return linked.length;
  }

  const entries = pdfEntries(root);
  if (!entries.length) return 0;
  const listed: ReferenceEntry[] = entries.map((element, position) => {
    const id = `ref-${position + 1}`;
    element.id = id;
    element.classList.add(REF_CLASS);
    return { id, text: (element.textContent || '').trim() };
  });
  const index = referenceIndex(listed);
  const inEntries = new Set(entries);

  // The text is read a block at a time — a paragraph, a caption, a list
  // item — not a text node at a time: "Smith <em>et al</em>, 2019" is one
  // citation set in two faces.
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const blocks = new Map<Element, Text[]>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let parent = node.parentElement;
    let block: Element | null = null;
    let skip = false;
    while (parent && parent !== root) {
      if (inEntries.has(parent) || /^(CODE|PRE|A|H[1-6])$/.test(parent.tagName)) {
        skip = true;
        break;
      }
      if (!block && !INLINE.test(parent.tagName)) block = parent;
      parent = parent.parentElement;
    }
    if (skip) continue;
    block ??= root;
    const texts = blocks.get(block) ?? [];
    texts.push(node as Text);
    blocks.set(block, texts);
  }

  let count = 0;
  for (const texts of blocks.values()) {
    const value = texts.map((node) => node.nodeValue || '').join('');
    if (!/[[(]/.test(value)) continue;
    const matches = findCitations(value, index);
    if (!matches.length) continue;
    let offset = 0;
    for (const node of texts) {
      const text = node.nodeValue || '';
      const from = offset;
      const to = offset + text.length;
      offset = to;
      const here = matches.filter((match) => match.start < to && match.end > from);
      if (!here.length) continue;
      const fragment = doc.createDocumentFragment();
      let at = 0;
      for (const match of here) {
        const start = Math.max(match.start, from) - from;
        const end = Math.min(match.end, to) - from;
        if (start > at) fragment.append(text.slice(at, start));
        const span = doc.createElement('span');
        span.className = CITE_CLASS;
        span.setAttribute('data-refs', match.refs.join(' '));
        // One citation cut by a change of face is one citation — its pieces
        // share a number — and one stop for the keyboard.
        span.setAttribute('data-cite', String(count + matches.indexOf(match)));
        if (match.start >= from) span.setAttribute('tabindex', '0');
        span.textContent = text.slice(start, end);
        fragment.append(span);
        at = end;
      }
      if (at < text.length) fragment.append(text.slice(at));
      node.replaceWith(fragment);
    }
    count += matches.length;
  }

  // Citations set as superscript numbers — "as shown before²³" — where the
  // paper has no numbers in brackets. A lone raised figure may be a
  // footnote's mark, so only a paper with several of them is read this way.
  if (count < 3) {
    const raised = Array.from(root.querySelectorAll('sup')).flatMap((sup) => {
      if (sup.closest('h1, h2, h3, h4, h5, h6, a, code, pre, .cite') || entries.some((entry) => entry.contains(sup))) return [];
      const numbers = /^\s*\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\s*$/.test(sup.textContent || '') ? citationNumbers(sup.textContent!.trim()) : null;
      if (!numbers || numbers.some((n) => n < 1 || n > index.largest)) return [];
      const refs = numbers.map((n) => index.byNumber(n)).filter((ref): ref is string => ref !== null);
      return refs.length ? [{ sup, refs: Array.from(new Set(refs)) }] : [];
    });
    if (raised.length >= 3) {
      for (const { sup, refs } of raised) {
        sup.classList.add(CITE_CLASS);
        sup.setAttribute('data-refs', refs.join(' '));
        sup.setAttribute('tabindex', '0');
      }
      count += raised.length;
    }
  }
  return count;
}

/** Elements that sit inside a line of text, rather than being a block of their own. */
const INLINE = /^(EM|I|STRONG|B|SUP|SUB|SPAN|MARK|SMALL|U|S|CITE|Q|ABBR|DFN|VAR|KBD|SAMP|TIME|FONT)$/;

/** The HTML with its citations marked; unchanged where there is no DOM to do it with. */
export function withCitations(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    return annotateCitations(doc.body) ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

/** A citation's first piece — where it is set in more than one face — which stands for the whole of it. */
export function citationHead(cite: Element): Element {
  const group = cite.getAttribute('data-cite');
  const root = cite.closest('.paper-body') ?? cite.ownerDocument.body;
  return (group !== null && root.querySelector(`.${CITE_CLASS}[data-cite="${group}"]`)) || cite;
}

/** A citation's text, all of its pieces together. */
export function citationText(cite: Element): string {
  const group = cite.getAttribute('data-cite');
  const root = cite.closest('.paper-body') ?? cite.ownerDocument.body;
  if (group === null) return cite.textContent || '';
  return Array.from(root.querySelectorAll(`.${CITE_CLASS}[data-cite="${group}"]`))
    .map((piece) => piece.textContent || '')
    .join('');
}

/** An entry's text as printed, without the number it is listed under. */
export function entryText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('.ltx_tag_bibitem').forEach((tag) => tag.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}
