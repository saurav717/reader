/**
 * What the right-click box on a selection looks up.
 *
 * Everything here is fetched straight from the browser: the services below
 * all send CORS headers, so none of it needs the arXiv proxy and it all
 * works on a static host. Every call is best-effort — a lookup that fails
 * leaves its pane with a message and a link out, never an error in the reader.
 */

// Words too common to be worth a definition when the selection is a phrase.
const STOPWORDS = new Set([
  'a', 'an', 'about', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'for', 'from',
  'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'when', 'which',
  'while', 'with', 'would', 'you', 'your',
]);

/**
 * The words in a selection worth offering a definition for, longest first —
 * a dictionary has nothing to say about "the" or "of".
 */
export function candidateWords(selection: string, limit = 6): string[] {
  const words = selection
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ''))
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  const unique = Array.from(new Set(words));
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, limit);
}

/** Text out of the small pieces of HTML Wikipedia and Wiktionary answer with. */
const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ----------------------------------------------------------- dictionary ----

export interface WordSense {
  partOfSpeech: string;
  definitions: { definition: string; example?: string }[];
  synonyms: string[];
}

export interface WordEntry {
  word: string;
  phonetic?: string;
  senses: WordSense[];
  sourceUrls: string[];
  /** Where the entry is the dictionary form of what was selected: "plural of model". */
  formOf?: string;
  /** Which dictionary answered, for the credit under the definitions. */
  source: 'Wiktionary' | 'Free Dictionary';
}

interface RawEntry {
  word: string;
  phonetic?: string;
  phonetics?: { text?: string }[];
  meanings?: {
    partOfSpeech?: string;
    definitions?: { definition?: string; example?: string }[];
    synonyms?: string[];
  }[];
  sourceUrls?: string[];
}

/** A dictionary that could not be asked, as against one that had no entry. */
class Unreachable extends Error {}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * The shape a selected word is in on the page is often not the one a
 * dictionary files it under — "models", "trained", "encoding". These are the
 * plausible dictionary forms, most likely first. Wiktionary does this itself
 * ("plural of model"); the Free Dictionary does not.
 */
export function dictionaryForms(word: string): string[] {
  const w = word.toLowerCase();
  const forms: string[] = [];
  const add = (form: string) => {
    if (form.length > 2 && form !== w && !forms.includes(form)) forms.push(form);
  };
  if (w.endsWith("'s")) add(w.slice(0, -2));
  if (w.endsWith('ies')) add(`${w.slice(0, -3)}y`);
  if (/(?:ches|shes|sses|xes|zes)$/.test(w)) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('ed')) {
    add(w.slice(0, -1));
    add(w.slice(0, -2));
    if (/([b-df-hj-np-tv-z])\1ed$/.test(w)) add(w.slice(0, -3));
  }
  if (w.endsWith('ing')) {
    add(`${w.slice(0, -3)}e`);
    add(w.slice(0, -3));
    if (/([b-df-hj-np-tv-z])\1ing$/.test(w)) add(w.slice(0, -4));
  }
  return forms;
}

/** dictionaryapi.dev: free, keyless and CORS-open, and down often enough to need a second. */
async function freeDictionary(term: string, signal?: AbortSignal): Promise<WordEntry | null> {
  let response: Response;
  try {
    response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`, { signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Unreachable('the Free Dictionary could not be reached');
  }
  // 404 is the ordinary answer for a word it does not carry, not a failure.
  if (response.status === 404) return null;
  if (!response.ok) throw new Unreachable(`the Free Dictionary answered ${response.status}`);
  const payload = (await response.json()) as RawEntry[];
  if (!Array.isArray(payload) || !payload.length) return null;

  const senses: WordSense[] = [];
  const sourceUrls = new Set<string>();
  for (const entry of payload) {
    for (const meaning of entry.meanings || []) {
      const definitions = (meaning.definitions || [])
        .map((item) => ({ definition: (item.definition || '').trim(), example: item.example?.trim() }))
        .filter((item) => item.definition);
      if (!definitions.length) continue;
      senses.push({
        partOfSpeech: meaning.partOfSpeech || 'sense',
        definitions: definitions.slice(0, 3),
        synonyms: (meaning.synonyms || []).slice(0, 6),
      });
    }
    for (const url of entry.sourceUrls || []) sourceUrls.add(url);
  }
  if (!senses.length) return null;

  const first = payload[0];
  return {
    word: first.word || term,
    phonetic: first.phonetic || first.phonetics?.find((item) => item.text)?.text,
    senses: senses.slice(0, 4),
    sourceUrls: Array.from(sourceUrls).slice(0, 2),
    source: 'Free Dictionary',
  };
}

interface WiktionaryUsage {
  partOfSpeech?: string;
  language?: string;
  definitions?: { definition?: string; parsedExamples?: { example?: string }[]; examples?: string[] }[];
}

/**
 * A definition that only says which word this is a form of — "plural of
 * model", "present participle of encode". The word it points to is where the
 * meaning is, so it is followed rather than shown.
 */
const FORM_OF =
  /^(?:\([^)]*\)\s*)?((?:[\w-]+ )*?(?:plural|participle|past tense|simple past|third-person singular(?: simple present indicative)?|comparative|superlative|(?:alternative|archaic|obsolete|british|american|us|uk|nonstandard) (?:form|spelling)|misspelling|inflection|gerund)(?: form)?) of ([^\s.,;:()]+)/i;

/** Wiktionary's own REST API, which Wikimedia serves CORS-open like Wikipedia's. */
async function wiktionary(term: string, signal?: AbortSignal, depth = 0): Promise<WordEntry | null> {
  let response: Response;
  try {
    response = await fetch(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term.replace(/ /g, '_'))}`,
      { signal, headers: { Accept: 'application/json' } },
    );
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Unreachable('Wiktionary could not be reached');
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Unreachable(`Wiktionary answered ${response.status}`);
  const payload = (await response.json()) as Record<string, WiktionaryUsage[]>;
  const english = payload.en || [];

  const senses: WordSense[] = [];
  let formOf: { note: string; lemma: string } | undefined;
  for (const usage of english) {
    const definitions: WordSense['definitions'] = [];
    for (const item of usage.definitions || []) {
      const text = stripTags(item.definition || '');
      if (!text) continue;
      const form = FORM_OF.exec(text);
      if (form && text.length < 90) {
        formOf ??= { note: `${form[1].toLowerCase()} of ${form[2]}`, lemma: form[2] };
        continue;
      }
      const example = stripTags(item.parsedExamples?.[0]?.example || item.examples?.[0] || '');
      definitions.push({ definition: text, example: example || undefined });
    }
    if (definitions.length) {
      senses.push({ partOfSpeech: (usage.partOfSpeech || 'sense').toLowerCase(), definitions: definitions.slice(0, 3), synonyms: [] });
    }
  }

  const url = `https://en.wiktionary.org/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
  if (!senses.length) {
    // Only forms of another word: that word's entry, saying so.
    if (formOf && depth === 0 && formOf.lemma.toLowerCase() !== term.toLowerCase()) {
      const lemma = await wiktionary(formOf.lemma, signal, 1);
      if (lemma) return { ...lemma, formOf: `${term}: ${formOf.note}` };
    }
    return null;
  }
  return { word: term, senses: senses.slice(0, 4), sourceUrls: [url], source: 'Wiktionary' };
}

const found = new Map<string, WordEntry | null>();

/**
 * The meaning of a word or a short phrase. Wiktionary first — it has the terms
 * of art a paper uses, and knows "models" is the plural of "model" — and the
 * Free Dictionary when Wiktionary has nothing or cannot be reached, trying the
 * dictionary forms of the word there. A pronunciation is borrowed from the
 * Free Dictionary when it has one. Answers are kept for the session.
 *
 * Resolves null when neither has an entry; rejects only when neither could be
 * asked at all, so "no entry" and "no network" read differently.
 */
export async function lookupWord(word: string, signal?: AbortSignal): Promise<WordEntry | null> {
  const term = word
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!term) return null;
  const key = term.toLowerCase();
  if (found.has(key)) return found.get(key) ?? null;

  const failures: string[] = [];
  const attempt = async (ask: () => Promise<WordEntry | null>) => {
    try {
      return await ask();
    } catch (error) {
      if (isAbort(error)) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const lower = term.toLowerCase();
  const spellings = lower === term ? [term] : [lower, term];
  const [fromWiktionary, fromFree] = await Promise.all([
    attempt(async () => {
      for (const spelling of spellings) {
        const entry = await wiktionary(spelling, signal);
        if (entry) return entry;
      }
      return null;
    }),
    attempt(() => freeDictionary(lower, signal)),
  ]);

  let entry = fromWiktionary;
  if (entry && !entry.phonetic && fromFree?.phonetic) entry = { ...entry, phonetic: fromFree.phonetic };
  entry ??= fromFree;
  // The Free Dictionary files words under one form only; try the others,
  // unless it has already shown it cannot be reached.
  if (!entry && !failures.some((message) => message.includes('Free Dictionary'))) {
    for (const form of dictionaryForms(lower)) {
      const lemma = await attempt(() => freeDictionary(form, signal));
      if (lemma) {
        entry = { ...lemma, formOf: `${term}: a form of ${lemma.word}` };
        break;
      }
      if (failures.length) break;
    }
  }

  if (!entry && failures.length >= 2) throw new Error(`No dictionary could be reached (${failures.join('; ')}).`);
  found.set(key, entry);
  return entry;
}

// ------------------------------------------------------------ background ----

export interface Background {
  title: string;
  description?: string;
  extract: string;
  url: string;
}


/**
 * Wikipedia's account of where the idea came from: search for the phrase, then
 * pull the lede of the best hit. Two hops, both CORS-open.
 */
export async function lookupBackground(phrase: string, signal?: AbortSignal): Promise<Background | null> {
  const query = phrase.trim().slice(0, 120);
  if (!query) return null;
  const found = await fetch(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=1`,
    { signal },
  );
  if (!found.ok) throw new Error(`Wikipedia answered ${found.status}`);
  const hits = (await found.json()) as {
    pages?: { key: string; title: string; description?: string; excerpt?: string }[];
  };
  const page = hits.pages?.[0];
  if (!page) return null;

  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`;
  try {
    const summary = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`,
      { signal },
    );
    if (summary.ok) {
      const body = (await summary.json()) as { extract?: string; content_urls?: { desktop?: { page?: string } } };
      if (body.extract) {
        return {
          title: page.title,
          description: page.description,
          extract: body.extract,
          url: body.content_urls?.desktop?.page || url,
        };
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // fall back to the search excerpt below
  }
  return {
    title: page.title,
    description: page.description,
    extract: stripTags(page.excerpt || ''),
    url,
  };
}

// ------------------------------------------------------ reference links ----

export interface ReferenceLink {
  label: string;
  url: string;
}

/** Somewhere to keep reading when the panes above are not enough. */
export function referenceLinks(phrase: string): ReferenceLink[] {
  const query = encodeURIComponent(phrase.trim().slice(0, 200));
  return [
    { label: 'Google Scholar', url: `https://scholar.google.com/scholar?q=${query}` },
    { label: 'arXiv search', url: `https://arxiv.org/abs/?searchtype=all&query=${query}` },
    { label: 'Semantic Scholar', url: `https://www.semanticscholar.org/search?q=${query}` },
    { label: 'Wiktionary', url: `https://en.wiktionary.org/wiki/${query}` },
  ];
}
