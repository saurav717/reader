/**
 * What the right-click box on a selection looks up.
 *
 * Everything here is fetched straight from the browser: the three services
 * below all send CORS headers, so none of it needs the arXiv proxy and it all
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

/** dictionaryapi.dev, which is free, keyless and CORS-open. */
export async function lookupWord(word: string, signal?: AbortSignal): Promise<WordEntry | null> {
  const term = word.trim();
  if (!term) return null;
  const response = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`,
    { signal },
  );
  // 404 is the ordinary answer for a word it does not carry, not a failure.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the dictionary answered ${response.status}`);
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
  };
}

// ------------------------------------------------------------ background ----

export interface Background {
  title: string;
  description?: string;
  extract: string;
  url: string;
}

const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

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
