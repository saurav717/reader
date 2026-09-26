/**
 * DeepSeek, reading what Google showed of a Scholar profile, for where the
 * person is now.
 *
 * SerpApi reads a profile's page and gives its affiliation as a field. When
 * its allowance is spent, Serply stands in, and Serply has no profile page to
 * give — only Google's search result for it: a title and a line or two under
 * it. Sometimes that line is the top of the profile ("Boston University -
 * Cited by 6 - Medical Imaging"); as often it is the list of works under it,
 * and a rule that takes its first piece takes a paper's title for where they
 * are. A model tells those apart, which a rule cannot, reliably.
 *
 * DeepSeek does not search or browse anything here — its API has no web
 * access. It is handed the snippets Serply already fetched, and the person's
 * work titles so it knows what is not an affiliation, and asked for JSON.
 * What it answers is kept only where it can be found in the snippet itself:
 * a model that invents a university is worse than no line at all.
 *
 * Opt-in: DEEPSEEK_KEY on the proxy (an environment variable for `npm
 * start`, a secret for the Worker — the same one the usage page reads the
 * balance with). One request per person or list of people, thinking off,
 * about 600 tokens in and 100 out. Without the key, or when DeepSeek fails,
 * Serply's own reading stands, which leaves an unclear affiliation out.
 *
 * Written against web APIs only, so the Worker imports it as the Node proxy
 * does.
 */
import { foldTitle, isWorkTitle } from './serply.js';

export const DEEPSEEK_CHAT = 'https://api.deepseek.com/chat/completions';
export const PROFILE_MODEL = 'deepseek-flash';
/** Long enough for a slow answer, short enough that the hover card is not kept waiting. */
const TIMEOUT_MS = 8000;
/** The most people read in one request: the first few, as SerpApi fills in. */
const MOST = 3;

const SYSTEM = [
  'You read Google search results for Google Scholar profile pages and say where each person is now.',
  'For each profile you get the name, the result snippet Google showed, and titles of their papers.',
  'A profile page starts: name, then affiliation (a university, company, lab or job title), then "Verified email at <domain>", then research interests, then the list of papers.',
  'The snippet may show that top part, or only the list of papers. A paper title, a venue, a year, a list of co-authors ("S Chennuri, S Lai, …") or a research interest is NEVER an affiliation.',
  'Copy the affiliation exactly as it appears in the snippet. If the snippet does not show one, answer null — do not guess from the papers, the email domain, or what you know.',
  'Answer JSON only: {"profiles":[{"id":"<id>","affiliation":string|null,"verifiedEmail":"<domain>"|null,"interests":[string]}]}',
].join('\n');

const str = (value) => (typeof value === 'string' ? value.trim() : '');
/** Compared as text: case, direction marks and spacing aside. */
const plain = (value) =>
  str(value)
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * What DeepSeek said of one person, kept only where it holds: an affiliation
 * or an interest that is in the snippet and is not one of their works, an
 * email domain the snippet names. Anything else is dropped, not corrected.
 */
export function checkReading(reading, { snippet, name, works = [] }) {
  const text = plain(snippet);
  const affiliation = str(reading?.affiliation);
  const email = str(reading?.verifiedEmail).replace(/^@/, '');
  const titles = works.map((work) => (typeof work === 'string' ? work : str(work?.title)));
  const kept = (line) =>
    line.length >= 2 && line.length <= 160 && text.includes(plain(line)) && !isWorkTitle(line, titles) && foldTitle(line) !== foldTitle(name);
  return {
    affiliation: affiliation && kept(affiliation) && !/^unknown affiliation$/i.test(affiliation) ? affiliation : undefined,
    verifiedEmail: email && /^[\w.-]+\.[a-z]{2,}$/i.test(email) && text.includes(`verified email at ${email.toLowerCase()}`) ? email : undefined,
    interests: (Array.isArray(reading?.interests) ? reading.interests : [])
      .map(str)
      .filter((interest) => interest.length <= 60 && kept(interest) && plain(interest) !== plain(affiliation))
      .slice(0, 8),
  };
}

/** The request, as sent: one user message holding the people as JSON. */
export function readingRequest(people) {
  return {
    model: PROFILE_MODEL,
    thinking: { type: 'disabled' },
    temperature: 0,
    max_tokens: 120 + 100 * people.length,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          profiles: people.map((person) => ({
            id: person.userId,
            name: person.name,
            snippet: str(person.snippet).slice(0, 600),
            papers: (person.works || []).slice(0, 5).map((work) => str(work.title || work).slice(0, 160)),
          })),
        }),
      },
    ],
  };
}

/**
 * Where each of `people` is now, as DeepSeek reads their snippets: a Map of
 * profile id to `{ affiliation, verifiedEmail, interests }`, checked as above,
 * and the tokens it took. Never throws: a failure is an empty Map, and the
 * caller keeps what it had.
 */
export async function readProfiles(people, key, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const asked = people.filter((person) => person.userId && str(person.snippet)).slice(0, MOST);
  const readings = new Map();
  if (!key || !asked.length) return { readings, usage: null };
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(DEEPSEEK_CHAT, {
      method: 'POST',
      signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(readingRequest(asked)),
    });
    if (!response.ok) return { readings, usage: null };
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
      return { readings, usage };
    }
    for (const reading of Array.isArray(answer?.profiles) ? answer.profiles : []) {
      const person = asked.find((one) => one.userId === str(reading?.id));
      if (person) readings.set(person.userId, checkReading(reading, person));
    }
    return { readings, usage };
  } catch {
    return { readings, usage: null };
  }
}
