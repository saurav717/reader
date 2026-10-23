// The site's DeepSeek switch: off unless the owner has turned it on.
//
// DeepSeek's terms let it use what is sent to it to improve its models, and
// Google's API Services User Data Policy forbids passing data obtained
// through Google's APIs to a service that may train on it. So on this site
// nothing goes to DeepSeek — not the relay on the site's key (/ai/deepseek),
// not a job written on the Worker, not the profile reader behind the Scholar
// routes — and the app hides DeepSeek's models and key, unless the owner
// turns the switch on from Usage → The site (/site/deepseek). The choice is
// kept in the SESSIONS namespace; a Worker without one keeps it off.
//
// And turning it on is locked until there is a way to run DeepSeek that keeps
// Google's data away from DeepSeek the company: DeepSeek's open models served
// by Google itself on Vertex AI, under Google Cloud's terms, which rule out
// training on what is sent. Until that relay is written, `deepseekAvailable`
// is false, POST {enabled: true} answers 409, and the owner's switch on the
// Usage page is locked off.

const KEY = 'site:deepseek';

/**
 * Whether a backend exists that keeps Google user data away from DeepSeek Inc.
 * None yet: it will be DeepSeek on Vertex AI (Google-hosted), and until that
 * relay exists the switch cannot be turned on — whatever is in SESSIONS.
 */
// eslint-disable-next-line no-unused-vars
export const deepseekAvailable = (env) => unlockedForTests;

/** The lock, lifted only from a test (scripts/usage.test.mjs relays to a stand-in DeepSeek): nothing in an env or a request reaches it. */
let unlockedForTests = false;
export const unlockDeepseekForTests = (on) => void (unlockedForTests = Boolean(on));

/** Whether the site sends anything to DeepSeek: the owner's switch, off by default and locked off until a Google-hosted backend exists. */
export async function deepseekEnabled(env) {
  if (!deepseekAvailable(env) || !env.SESSIONS) return false;
  const kept = await env.SESSIONS.get(KEY).catch(() => null);
  return kept === 'on';
}

/** GET for anyone, POST/PUT for the owner: the route's handler. */
export async function handleDeepseekSwitch(request, env, { json, headers, ownerAuthorized }) {
  if (request.method === 'GET') {
    return json({ enabled: await deepseekEnabled(env), available: deepseekAvailable(env), stored: Boolean(env.SESSIONS) }, 200, { ...headers, 'Cache-Control': 'public, max-age=30' });
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    const who = await ownerAuthorized(request, env);
    if (!who?.owner) return json({ error: 'this is the owner’s to set: READER_TOKEN, or a Google sign-in named in READER_OWNERS' }, 401, headers);
    if (!env.SESSIONS) return json({ error: 'no SESSIONS namespace is bound here, so the choice cannot be kept — see wrangler.toml' }, 501, headers);
    const asked = await request.json().catch(() => ({}));
    if (typeof asked?.enabled !== 'boolean') return json({ error: 'enabled must be true or false' }, 400, headers);
    if (asked.enabled && !deepseekAvailable(env)) {
      return json({ error: 'DeepSeek can be turned on only once it runs on Google Cloud (Vertex AI), where Google’s terms rule out training on what is sent; that backend is not built yet, so the switch stays off', locked: true, enabled: false, available: false, stored: true }, 409, headers);
    }
    await env.SESSIONS.put(KEY, asked.enabled ? 'on' : 'off');
    return json({ enabled: asked.enabled, available: deepseekAvailable(env), stored: true }, 200, { ...headers, 'Cache-Control': 'no-store' });
  }
  return json({ error: 'GET or POST' }, 405, headers);
}

/** What a refusal says, wherever DeepSeek is asked for while the switch is off. */
export const DEEPSEEK_OFF = { error: 'DeepSeek is turned off on this site: its owner can turn it on from Usage → The site', off: true };
