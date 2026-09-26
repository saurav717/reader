/**
 * Which paid service asks Scholar, when the proxy has a key for more than
 * one — and what happens when one of them says no.
 *
 * Serply (server/serply.js) is the cheaper, and answers every ask; SerpApi
 * (server/serpapi.js) reads a profile page exactly, h-index and all, where
 * Serply rebuilds it from searches. So a profile, a person and an entry
 * opened are asked of SerpApi first, and everything else of Serply first —
 * and whichever is asked first, the other is asked when it refuses. With
 * one key, that one; with neither, nobody here, and the proxy asks Scholar
 * itself.
 *
 * A service that says its allowance is spent, or that the key is wrong,
 * will say so again on the next ask. It is rested for ten minutes — asked
 * only after the other — so an account out of credits does not stand in
 * front of every ask with a refusal. A rested service is still asked when
 * the other refuses too: resting is an order, never a ban.
 *
 * Written against web APIs only, so the Worker can import it as the Node
 * proxy does.
 */
import { askSerp, plainFetchJson } from './serpapi.js';
import { askSerplyScholar, SERPAPI_BETTER } from './serply.js';

const REST_MS = 10 * 60 * 1000;
/** Refusals that will be the same on the next ask: a spent allowance, a bad key. */
const LASTING = new Set(['rate-limited', 'key']);

const resting = new Map();

/** For the tests, and for a proxy whose keys have just been changed. */
export function forgetResting() {
  resting.clear();
}

const isResting = (service) => (resting.get(service) || 0) > Date.now();

/**
 * Each service, with every request it makes to its paid API counted into
 * `spent` — which is what the account is charged for; an answer from the
 * cache costs nothing and is not counted.
 */
const services = {
  serply: (kind, params, key, spent) =>
    askSerplyScholar(kind, params, key, {
      fetchImpl: (...args) => {
        spent.serply += 1;
        return fetch(...args);
      },
    }),
  serpapi: (kind, params, key, spent) =>
    askSerp(kind, params, key, {
      fetchJson: (...args) => {
        spent.serpapi += 1;
        return plainFetchJson(...args);
      },
    }),
};

/** The services to ask, in the order to ask them: the better one first, a rested one last. */
export function serviceOrder(kind, keys) {
  const preferred = SERPAPI_BETTER.has(kind) ? ['serpapi', 'serply'] : ['serply', 'serpapi'];
  const have = preferred.filter((service) => keys[service]);
  return [...have.filter((service) => !isResting(service)), ...have.filter(isResting)];
}

/**
 * One ask of Scholar through whichever paid service answers: `{ results,
 * via, spent }`, or null when there is no key for either — `spent` being
 * the requests each service was charged for, refusals included. A refusal
 * from one is the other's turn; when both refuse, the refusal of the last
 * asked is thrown, with `spent` on it too.
 */
export async function askServices(kind, params, keys) {
  const order = serviceOrder(kind, keys);
  if (!order.length) return null;
  const spent = { serply: 0, serpapi: 0 };
  let failure;
  for (const service of order) {
    try {
      const results = await services[service](kind, params, keys[service], spent);
      resting.delete(service);
      return { results, via: service, spent };
    } catch (error) {
      failure = error;
      if (error && (error.serply || error.serpapi) && LASTING.has(error.reason)) resting.set(service, Date.now() + REST_MS);
    }
  }
  if (failure && typeof failure === 'object') failure.spent = spent;
  throw failure;
}
