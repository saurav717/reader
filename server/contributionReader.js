/**
 * DeepSeek, reading a paper's statement of who did what, for each author's
 * part in it.
 *
 * A byline's footnote — "∗Equal contribution. Listing order is random.
 * Jakob proposed replacing RNNs with self-attention…" — or an "Author
 * Contributions" section names the authors as it pleases: by first name,
 * by initials ("A.V. and N.S. designed…"), by role ("the first two
 * authors"). The reader in the browser puts a sentence to an author only
 * where it names them in full or by a name no one else on the byline has;
 * the rest takes reading, which a model does and a rule does not.
 *
 * DeepSeek is handed the authors, in the byline's order, and the statement
 * as the paper prints it — nothing is looked up — and asked for JSON: for
 * each author, the words of the statement about them. What it answers is
 * kept only where those words are in the statement: a model that says
 * someone did what the paper does not say is worse than saying nothing.
 *
 * Opt-in, as the profile reader is: DEEPSEEK_KEY on the proxy. One request
 * per paper, thinking off, some 800 tokens in and 300 out. Without the key,
 * or when DeepSeek fails, the card keeps the browser's own reading.
 *
 * Written against web APIs only, so the Worker imports it as the Node proxy
 * does.
 */
import { PROFILE_MODEL } from './profileReader.js';

export const DEEPSEEK_CHAT = 'https://api.deepseek.com/chat/completions';
/** Long enough for a slow answer, short enough that the hover card is not kept waiting. */
const TIMEOUT_MS = 12000;
/** The most authors read, and the longest statement: a byline's worth, a section's worth. */
export const MOST_AUTHORS = 60;
export const LONGEST = 6000;

const SYSTEM = [
  "You read the part of a research paper that says what each author did — a footnote on the byline, or an \"Author Contributions\" section — and say, for each author, what it says of them.",
  'You get the authors, numbered in the order of the byline, and the statement exactly as printed.',
  'The statement may name an author by full name, first name, surname, initials ("A.V.", "AV"), or role ("the first two authors", "the senior author"). Work out who is meant from the list.',
  'For each author the statement says something about, copy the words that say it, verbatim: whole sentences, or the clause of a sentence that is about them when a sentence names several people for different things. Also copy verbatim any role it gives them ("Equal contribution", "Project lead", "Corresponding author").',
  'A sentence about all of the authors ("Listing order is random") belongs to no one in particular: leave it out.',
  'Never paraphrase and never guess: if the statement does not say what someone did, give them empty lists.',
  'Answer JSON only: {"authors":[{"index":<number>,"did":[string],"roles":[string]}]}',
].join('\n');

const str = (value) => (typeof value === 'string' ? value.trim() : '');
/** Compared as text: case, quotes, hyphenation at a line's end and spacing aside. */
const plain = (value) =>
  str(value)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑–—]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * What DeepSeek said of one author, kept only where it holds: words that
 * are in the statement, of a sentence's length or less, each once.
 */
export function checkReading(reading, statement) {
  const text = plain(statement);
  const kept = (limit) => (line) => line.length >= 3 && line.length <= limit && text.includes(plain(line).replace(/[.;,]$/, ''));
  const list = (value, limit) =>
    Array.from(new Set((Array.isArray(value) ? value : []).map(str).filter(kept(limit)))).slice(0, 8);
  return { did: list(reading?.did, 600), roles: list(reading?.roles, 80) };
}

/** The request, as sent: one user message holding the authors and the statement as JSON. */
export function readingRequest(authors, statement) {
  return {
    model: PROFILE_MODEL,
    thinking: { type: 'disabled' },
    temperature: 0,
    max_tokens: Math.min(4000, 200 + 120 * authors.length),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          authors: authors.map((name, index) => ({ index, name })),
          statement,
        }),
      },
    ],
  };
}

/** The authors and the statement from a request's query, tidied, or null where there is nothing to read. */
export function contributionsAsked(params) {
  let authors = [];
  try {
    const parsed = JSON.parse(params.get('authors') || '[]');
    if (Array.isArray(parsed)) authors = parsed.map(str).filter((name) => name && name.length <= 120).slice(0, MOST_AUTHORS);
  } catch {
    authors = [];
  }
  const statement = str(params.get('statement')).slice(0, LONGEST);
  if (authors.length < 1 || statement.length < 20) return null;
  return { authors, statement };
}

/**
 * Each author's part, as DeepSeek reads the statement: an array in the
 * byline's order of `{ did, roles }`, checked as above, and the tokens it
 * took. Never throws: a failure is `people: null`, and the card keeps what
 * it had.
 */
export async function readContributions({ authors, statement }, key, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  if (!key || !authors.length || !statement) return { people: null, usage: null };
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(DEEPSEEK_CHAT, {
      method: 'POST',
      signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(readingRequest(authors, statement)),
    });
    if (!response.ok) return { people: null, usage: null };
    const body = await response.json();
    const usage = body?.usage
      ? {
          input: Math.max(0, (body.usage.prompt_tokens || 0) - (body.usage.prompt_cache_hit_tokens || 0)),
          cacheRead: body.usage.prompt_cache_hit_tokens || 0,
          output: body.usage.completion_tokens || 0,
        }
      : null;
    let answer;
    try {
      answer = JSON.parse(str(body?.choices?.[0]?.message?.content).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return { people: null, usage };
    }
    const people = authors.map(() => ({ did: [], roles: [] }));
    for (const reading of Array.isArray(answer?.authors) ? answer.authors : []) {
      const index = Number(reading?.index);
      if (!Number.isInteger(index) || index < 0 || index >= authors.length) continue;
      const checked = checkReading(reading, statement);
      people[index] = {
        did: Array.from(new Set([...people[index].did, ...checked.did])),
        roles: Array.from(new Set([...people[index].roles, ...checked.roles])),
      };
    }
    return { people, usage };
  } catch {
    return { people: null, usage: null };
  }
}
