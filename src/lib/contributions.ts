/**
 * Each author's part in a paper, as DeepSeek reads the paper's own
 * statement of who did what — the byline's footnote, an "Author
 * Contributions" section — on the proxy (server/contributionReader.js).
 *
 * The layout already puts to an author the sentences that name them in
 * full or by a name no one else on the byline has; this is for the rest:
 * initials ("A.V. and N.S. designed…"), roles ("the first two authors"),
 * a sentence naming several people for different things. The proxy keeps
 * only words that are in the statement, so what the card shows from here
 * is still the paper's own words. One request a paper, remembered for as
 * long as the page is open; null where the proxy has no DeepSeek key, or
 * there is no statement to read.
 */
import { apiFetch, hasProxy } from './api';
import type { PaperByline } from './pdfLayout';

export interface ContributionReading {
  /** The statement's words about them, verbatim. */
  did: string[];
  /** Roles it gives them, verbatim: "Project lead". */
  roles: string[];
}

/** The longest statement sent, to keep the request's address a sane length. */
const LONGEST = 4000;
const asked = new Map<string, Promise<ContributionReading[] | null>>();

/** Each author's part, in the byline's order, or null. Never rejects. */
export function readContributions(byline: PaperByline | undefined): Promise<ContributionReading[] | null> {
  const statement = byline?.statement?.slice(0, LONGEST);
  if (!byline || !statement || !byline.authors.length || !hasProxy()) return Promise.resolve(null);
  const names = byline.authors.map((author) => author.name);
  const key = `${names.join('|')}\n${statement}`;
  let answer = asked.get(key);
  if (!answer) {
    answer = apiFetch(`/contributions?authors=${encodeURIComponent(JSON.stringify(names))}&statement=${encodeURIComponent(statement)}`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the proxy answered ${response.status}`);
        const body = (await response.json()) as { people?: unknown };
        if (!Array.isArray(body.people) || body.people.length !== names.length) return null;
        return body.people.map((person) => ({
          did: Array.isArray(person?.did) ? person.did.filter((line: unknown): line is string => typeof line === 'string') : [],
          roles: Array.isArray(person?.roles) ? person.roles.filter((line: unknown): line is string => typeof line === 'string') : [],
        }));
      })
      .catch(() => {
        // A failure is not remembered: the next card asks again. A proxy
        // without DeepSeek, or with nothing to say, is — it will not change.
        asked.delete(key);
        return null;
      });
    asked.set(key, answer);
  }
  return answer;
}
