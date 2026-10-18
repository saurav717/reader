/**
 * A paper's BibTeX entry as a language model finds it on the web: the Cite
 * menu's "Ask AI" — for the papers the indexes get wrong or leave as a
 * preprint, where a model that searches dblp, the publisher's page and the
 * proceedings finds the version that was published.
 *
 * DeepSeek is asked first, then Claude, then Gemini: the first that can
 * answer from here, and that still has credit. DeepSeek says how much is
 * left on a key of this browser's own (GET /user/balance), and one with
 * nothing left is passed over before it is asked; the others say so only
 * by refusing, and a refusal — out of credit, rate-limited, anything — moves
 * on to the next. Claude and DeepSeek search the web as they answer; Gemini's
 * relay lets no tool through, so it is last, and answers from what it knows.
 *
 * Nothing it says is taken on trust: the entry has to be BibTeX, and its
 * title the paper's. Pinned by scripts/cite-ai.test.mjs.
 */
import type { CitationVariant, Paper } from '../types';
import { fold, titleFits } from './citations';
import { parseBibtex, plain, tidy } from './citeRecord';

/** The providers in the order they are asked, each with the model that does the looking. */
export const CITE_AI_ORDER = [
  { provider: 'deepseek', model: 'deepseek-flash', name: 'DeepSeek' },
  { provider: 'anthropic', model: 'claude-sonnet-5', name: 'Claude' },
  { provider: 'gemini', model: 'gemini-3.8-flash', name: 'Gemini' },
] as const;

export type CiteAiProvider = (typeof CITE_AI_ORDER)[number]['provider'];

const DEEPSEEK_BALANCE = 'https://api.deepseek.com/user/balance';

export const CITE_AI_SYSTEM = `You find the citation of a research paper: one BibTeX entry, correct and complete, as a
careful author would put it in a bibliography.

- Find the paper itself first. Search dblp, the ACL Anthology, OpenReview, the publisher's page
  (ACM, IEEE, Springer, Elsevier, PMLR, NeurIPS proceedings), Semantic Scholar and Google Scholar.
- When the work was published at a conference or in a journal, cite that version, not the arXiv
  preprint: @inproceedings with booktitle, or @article with journal, volume, number and pages.
  Cite the preprint (@misc with eprint, archivePrefix = {arXiv} and primaryClass) only when it was
  never published.
- Authors in full, in the published order, joined by "and". The title as published, with words
  that must stay capitalised (names, acronyms) in braces. Year, and pages, volume, publisher and
  doi wherever the published record has them.
- Never make a field up. A field you could not confirm is left out.

Answer with the entry in one \`\`\`bibtex block, then one line "Source: <url>" naming the page you
confirmed it on, and nothing else.`;

export const CITE_AI_ONLINE = `Search the web for it before you answer: a few searches, and read the page the entry comes from
where you can. The entry is only as good as the record you confirmed it on.`;

export const CITE_AI_OFFLINE = `You cannot search the web here: answer from what you know of the paper, and leave out
every field you are not sure of.`;

/** What the model is told of the paper: enough to find it, nothing to copy from blindly. */
export function citeAiQuestion(paper: Pick<Paper, 'title' | 'authors' | 'published' | 'venue' | 'doi' | 'arxivId' | 'landingUrl'>): string {
  const lines = [
    `Title: ${paper.title}`,
    paper.authors.length ? `Authors: ${paper.authors.join(', ')}` : '',
    paper.published ? `Date (as the index has it): ${paper.published.slice(0, 10)}` : '',
    paper.venue ? `Venue (as the index has it, may be wrong): ${paper.venue}` : '',
    paper.doi ? `DOI: ${paper.doi}` : '',
    paper.arxivId ? `arXiv: ${paper.arxivId.replace(/^arxiv:/i, '')}` : '',
    paper.landingUrl ? `Page: ${paper.landingUrl}` : '',
  ];
  return `Find the BibTeX entry for this paper.\n\n${lines.filter(Boolean).join('\n')}`;
}

/**
 * The entry in the answer, and the page it names, or why there is none:
 * no BibTeX in it, or BibTeX for some other paper.
 */
export function entryFromAnswer(answer: string, title: string): { bibtex: string; url?: string } | { error: string } {
  const fenced = /```(?:bibtex|bib|latex|tex)?\s*\n([\s\S]*?)```/i.exec(answer);
  const body = fenced ? fenced[1] : answer.slice(Math.max(0, answer.search(/@[a-zA-Z]+\s*\{/)));
  const record = parseBibtex(body)[0];
  if (!record || !record.fields.title) return { error: 'its answer had no BibTeX entry in it' };
  const found = plain(record.fields.title);
  if (!titleFits(title, found) && !titleFits(found, title) && fold(found) !== fold(title)) return { error: `it found a different paper (“${found.slice(0, 80)}”)` };
  const start = body.indexOf('@');
  // The entry as written, from its @ to the brace that closes it.
  let depth = 0;
  let end = -1;
  for (let i = body.indexOf('{', start); i >= 0 && i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const bibtex = tidy(end > 0 ? body.slice(start, end) : body.slice(start));
  const source = /Source:\s*<?(https?:\/\/[^\s>)\]]+)/i.exec(answer);
  return { bibtex, ...(source ? { url: source[1].replace(/[.,;]+$/, '') } : {}) };
}

/**
 * Whether DeepSeek has credit on this browser's key: false only when it says
 * it has none. On the site's key, or when the question fails, it is asked
 * anyway, and a refusal moves on.
 */
export async function deepseekHasCredit(key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!key) return true;
  try {
    const response = await fetchImpl(DEEPSEEK_BALANCE, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!response.ok) return true;
    const body = (await response.json()) as { is_available?: boolean; balance_infos?: { total_balance?: string }[] };
    if (body.is_available === false) return false;
    const infos = body.balance_infos ?? [];
    return !infos.length || infos.some((info) => Number(info.total_balance) > 0);
  } catch {
    return true;
  }
}

/** A refusal as the next try is told of it, in a few words. */
export function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/insufficient|balance|credit|billing|quota|402/i.test(text)) return 'out of credit';
  if (/rate|429|overload|529/i.test(text)) return 'busy';
  return text.replace(/\s+/g, ' ').slice(0, 120) || 'it failed';
}

/**
 * Ask the providers in turn for the paper's entry: the variant the first
 * one found, tagged with who found it — or, when none could, what each said.
 */
export async function askAiForCitation(paper: Paper, { onTrying }: { onTrying?: (name: string) => void } = {}): Promise<CitationVariant> {
  const assistant = await import('./assistant');
  const state = assistant.getState();
  const tried: string[] = [];
  for (const { provider, model, name } of CITE_AI_ORDER) {
    if (!state.keys[provider]) {
      tried.push(`${name}: no key`);
      continue;
    }
    if (provider === 'deepseek' && !(await deepseekHasCredit(assistant.keyFor('deepseek')))) {
      tried.push(`${name}: out of credit`);
      continue;
    }
    const web = assistant.webUsable(model, state.web);
    onTrying?.(name);
    try {
      const stream = await assistant.streamModel({
        model,
        maxTokens: 4000,
        effort: 'low',
        web,
        system: [{ type: 'text', text: `${CITE_AI_SYSTEM}\n\n${web ? CITE_AI_ONLINE : CITE_AI_OFFLINE}` }],
        messages: [{ role: 'user', content: citeAiQuestion(paper) }],
      });
      let answer = '';
      stream.on('text', (delta: string) => {
        answer += delta;
      });
      await stream.finalMessage();
      const entry = entryFromAnswer(answer, paper.title);
      if ('error' in entry) {
        tried.push(`${name}: ${entry.error}`);
        continue;
      }
      return {
        source: 'ai',
        bibtex: entry.bibtex,
        fetchedAt: new Date().toISOString(),
        of: `${assistant.modelSpec(model).label}${web ? ', searching the web' : ', from memory'}`,
        ...(entry.url ? { url: entry.url } : {}),
      };
    } catch (error) {
      tried.push(`${name}: ${shortReason(error)}`);
    }
  }
  throw new Error(`No model could find it — ${tried.join('; ')}.`);
}
