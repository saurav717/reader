/**
 * The Write tab's citation helper: which of the project's papers a
 * sentence is about, and which sentences read like claims with nothing
 * cited for them.
 *
 * The ranking is BM25 over what the library knows of each paper — its
 * title, its abstract, and what you highlighted and noted in it — in the
 * browser, as you type. A highlight is the strongest signal there is: a
 * passage you marked that says what the sentence says is the paper you
 * mean. No model is asked unless you ask it.
 *
 * Pinned by scripts/cite-suggest.test.mjs.
 */
import type { Highlight, Paper } from '../types';

// ------------------------------------------------------------ the text ---

const STOP = new Set(
  'a an the and or but of to in on at by for with from as is are was were be been being this that these those it its we our they their there here which who whom whose what when where how than then so such not no nor do does did done have has had having can could may might must shall should will would into over under about between among through during before after above below up down out off again further once all any both each few more most other some own same very just also only'.split(' '),
);

/** The words a sentence is matched on: lower-cased, stemmed a little, the stop words out. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .map(stem)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

/** `experts` → `expert`, `routing` → `rout`, `balanced` → `balanc`: enough for two spellings of a word to meet. */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/(ities|ively|ings?|ness|ments?|ations?|ers?|ies|ied|ed|ly|es|s)$/, (match) => (match === 'ies' || match === 'ied' ? 'y' : match === 'ations' || match === 'ation' ? 'at' : ''));
}

// --------------------------------------------------------- the sentence ---

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/** The sentence the caret is in, or has just ended; LaTeX commands count as text, comments do not. */
export function sentenceAt(text: string, caret: number): Sentence | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  // The start: after the last sentence end, blank line, or line beginning with a command.
  const starts = [...before.matchAll(/[.!?]["'’”)]*\s+|\n\s*\n|\n(?=\s*\\)|^|\\(?:section|subsection|subsubsection|paragraph|item|caption)\*?\{[^}]*\}\s*/g)];
  let start = starts.length ? starts[starts.length - 1].index! + starts[starts.length - 1][0].length : 0;
  // Comment lines between the last sentence and this one are not part of it.
  for (;;) {
    const comment = /^[ \t]*%[^\n]*\n/.exec(text.slice(start, at));
    if (!comment) break;
    start += comment[0].length;
  }
  let end = at;
  if (!atSentenceEnd(text, at)) {
    const rest = text.slice(at);
    const endMatch = /[.!?]["'’”)]*(?=\s|$)|\n\s*\n/.exec(rest);
    end = endMatch ? at + endMatch.index + (endMatch[0].startsWith('\n') ? 0 : endMatch[0].length) : text.length;
  }
  const raw = text.slice(start, end);
  if (!raw.trim()) return null;
  // The line may be a comment.
  if (/^\s*%/.test(raw)) return null;
  return { text: raw.replace(/\s+/g, ' ').trim(), start, end };
}

/** Whether the caret rests at the end of a sentence: just after its full stop, the citation to go before it. */
export function atSentenceEnd(text: string, caret: number): boolean {
  const before = text.slice(Math.max(0, caret - 3), caret);
  const after = text.slice(caret, caret + 2);
  return /[.!?]["'’”)]*$/.test(before) && (after === '' || /^\s/.test(after) || /^\n/.test(after));
}

/** `\cite{?}` or an empty `\cite{}` at the caret: a citation asked for by hand. */
export function askedAt(text: string, caret: number): { from: number; to: number } | null {
  const before = text.slice(Math.max(0, caret - 40), caret);
  const match = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{(\??)$/.exec(before);
  if (!match) return null;
  const after = text.slice(caret, caret + 2);
  if (after[0] !== '}') return null;
  return { from: caret - match[1].length, to: caret };
}

// ------------------------------------------------------------ ranking ---

export interface Candidate {
  paper: Paper;
  score: number;
  /** The words of the sentence the paper's text shares, as they were typed. */
  matched: string[];
  /** Where the best match was: a highlight (and which), the abstract, or the title. */
  via: 'highlight' | 'abstract' | 'title';
  highlight?: Highlight;
}

interface Doc {
  paper: Paper;
  /** The paper's text as fields, each its own bag of terms. */
  title: string[];
  abstract: string[];
  highlights: { highlight: Highlight; words: string[] }[];
}

const WEIGHT = { title: 2.5, abstract: 1, highlight: 3 };

/** An index of the papers, built once for the sentence after sentence. */
export interface SuggestIndex {
  rank: (sentence: string, limit?: number) => Candidate[];
}

export function suggestIndex(papers: Paper[], highlights: Highlight[]): SuggestIndex {
  const docs: Doc[] = papers.map((paper) => ({
    paper,
    title: terms(paper.title),
    abstract: terms(paper.abstract || ''),
    highlights: highlights
      .filter((highlight) => highlight.paperId === paper.id)
      .map((highlight) => ({ highlight, words: terms(`${highlight.exact} ${highlight.note ?? ''}`) })),
  }));
  // Document frequency over every paper's words, for the IDF.
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set([...doc.title, ...doc.abstract, ...doc.highlights.flatMap((item) => item.words)]);
    for (const word of seen) df.set(word, (df.get(word) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const idf = (word: string) => Math.log(1 + (n - (df.get(word) ?? 0) + 0.5) / ((df.get(word) ?? 0) + 0.5));
  const lengths = docs.map((doc) => doc.title.length + doc.abstract.length);
  const average = Math.max(1, lengths.reduce((sum, length) => sum + length, 0) / n);
  const k1 = 1.2;
  const b = 0.75;
  const bm25 = (words: string[], query: Map<string, number>, length: number) => {
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    let score = 0;
    const matched: string[] = [];
    for (const [word] of query) {
      const tf = counts.get(word);
      if (!tf) continue;
      matched.push(word);
      score += idf(word) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / average)));
    }
    return { score, matched };
  };

  return {
    rank(sentence, limit = 3) {
      const typed = sentence.split(/\s+/);
      const query = new Map<string, number>();
      const original = new Map<string, string>();
      for (const word of typed) {
        const [term] = terms(word);
        if (!term) continue;
        query.set(term, (query.get(term) ?? 0) + 1);
        if (!original.has(term)) original.set(term, word.replace(/[^\p{L}\p{N}-]/gu, ''));
      }
      if (!query.size) return [];
      const found: Candidate[] = [];
      docs.forEach((doc, index) => {
        const title = bm25(doc.title, query, lengths[index]);
        const abstract = bm25(doc.abstract, query, lengths[index]);
        let best: { score: number; matched: string[]; highlight?: Highlight } = { score: 0, matched: [] };
        for (const item of doc.highlights) {
          const got = bm25(item.words, query, item.words.length);
          // A highlight is short: two shared words is a match, one is not.
          if (got.matched.length >= 2 && got.score > best.score) best = { ...got, highlight: item.highlight };
        }
        const score = WEIGHT.title * title.score + WEIGHT.abstract * abstract.score + WEIGHT.highlight * best.score;
        const matched = [...new Set([...best.matched, ...title.matched, ...abstract.matched])];
        if (score <= 0 || matched.length < Math.min(2, query.size)) return;
        const via: Candidate['via'] = best.highlight ? 'highlight' : title.score >= abstract.score ? 'title' : 'abstract';
        found.push({ paper: doc.paper, score, matched: matched.map((term) => original.get(term) ?? term), via, highlight: best.highlight });
      });
      return found.sort((a, b2) => b2.score - a.score).slice(0, limit);
    },
  };
}

// ------------------------------------------------------------- claims ---

/** What a sentence says when it leans on somebody else's work. */
const CLAIM =
  /\b(has|have|had|was|were|is|are)\s+(been\s+)?(\w+ly\s+|later\s+|first\s+|since\s+)?(shown|demonstrated|found|proposed|reported|observed|established|argued|introduced|noted)\b|\b(prior|previous|recent|existing|earlier|related)\s+(work|works|studies|research|approaches|methods)\b|\bstate[- ]of[- ]the[- ]art\b|\b(it is|it's)\s+(well[- ])?known\b|\b(widely|commonly)\s+(used|adopted|believed|accepted)\b|\b(outperforms?|outperformed|improves? (up)?on|achieves?|achieved|reaches|reached|surpass(es|ed)?)\b|\b\d+(\.\d+)?\s?(\\%|percent\b)|\b(studies|researchers|authors)\s+(have|has)\b|\b(first|originally)\s+(proposed|introduced)\b|\b(according to|as (shown|reported|noted) (by|in))\b|\b(et al\.)/i;

const CITED = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{[^}]*\}/;

export interface Claim {
  /** The sentence, as a person reads it. */
  text: string;
  start: number;
  end: number;
  line: number;
  /** The phrase that made it a claim. */
  because: string;
}

/**
 * Sentences that read like claims and cite nothing — not in the sentence,
 * and not in the one after, where a citation for a run of sentences goes.
 * Comments, headings and preamble are not sentences.
 */
export function uncitedClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const body = text.includes('\\begin{document}') ? text.slice(text.indexOf('\\begin{document}')) : text;
  const offset = text.length - body.length;
  const blank = (match: string, lead = '') => lead + ' '.repeat(match.length - lead.length);
  // Comments go, and so do the commands that are not prose — a heading is not a sentence, nor the start of one.
  const noComments = body
    .replace(/(^|[^\\])%[^\n]*/g, (match, lead: string) => blank(match, lead))
    .replace(/\\(?:section|subsection|subsubsection|paragraph|chapter|title|author|label|caption|begin|end|usepackage|documentclass|includegraphics|input|include|bibliography|bibliographystyle|ref|eqref|cref|Cref|url|href)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g, (match) => blank(match));
  const sentences = [...noComments.matchAll(/[^.!?\n][^.!?]*(?:[.!?]["'’”)]*(?=\s|$)|$)/g)];
  sentences.forEach((match, index) => {
    const raw = match[0];
    if (!raw.trim() || raw.trim().length < 30) return;
    if (/^\s*\\(section|subsection|subsubsection|paragraph|begin|end|label|includegraphics|usepackage|documentclass|title|author|maketitle|bibliography)/.test(raw)) return;
    if (/\\begin\{(equation|align|figure|table|algorithm)/.test(raw)) return;
    const because = CLAIM.exec(raw);
    if (!because) return;
    if (CITED.test(raw)) return;
    const next = sentences[index + 1]?.[0] ?? '';
    // The citation after a run — "... as follows. Prior work did X~\cite{a}." — covers the sentence before only when it is right after.
    if (next && CITED.test(next) && /^\s*[A-Z\\]/.test(next) === false) return;
    const start = offset + match.index!;
    const line = text.slice(0, start).split('\n').length + (raw.match(/^\s*\n/) ? 1 : 0);
    out.push({ text: raw.replace(/\s+/g, ' ').trim(), start, end: start + raw.length, line, because: because[0] });
  });
  return out;
}
