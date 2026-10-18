/**
 * An account deleted (Settings → Account → Delete my account): everything
 * this site keeps about one person, gone from every place it is kept.
 *
 *  - Shared projects (worker/projectRoom.js): a room they own is closed, as
 *    its owner closing it would; in anyone else's they are let go, their
 *    invitation dropped, and their address taken off what they wrote, which
 *    stays with that project.
 *  - The invitations ledger (worker/invites.js): what they sent and were sent,
 *    their links, their rooms, and the site's mail to or from them.
 *  - The tally (worker/usage.js): their counts, out of every day kept.
 *  - Their computers (worker/devices.js), and their GitHub and Overleaf
 *    connections (worker/github.js, worker/latex.js), each given back first.
 *  - This browser's session in the browser pane (worker/browserSession.js) and
 *    the sign-ins it kept (worker/browse.js), which are kept by browser, not
 *    by account.
 *
 * The pass itself is kept nowhere (server/passes.js): the page drops it. What
 * the page keeps — the browser's copy of the library, and the Drive files when
 * asked — the page deletes itself (src/lib/account.ts).
 */
import { forgetCookies, forClient } from './browse.js';
import { forgetGithub } from './github.js';
import { forgetOverleaf } from './latex.js';
import { secretsKey, secretsReady } from './secrets.js';

/** A call on one Durable Object; null when it is not bound or does not answer. */
async function call(binding, name, route, body) {
  if (!binding) return null;
  try {
    const answer = await binding.get(binding.idFromName(name)).fetch(`https://object${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    return answer.ok ? await answer.json() : null;
  } catch {
    return null;
  }
}

const q = (email) => `email=${encodeURIComponent(email)}`;

/** The shared projects one person is in, as the ledger knows them, and those they were invited to and have not joined. */
async function roomsOf(env, who) {
  const [mine, inbox] = await Promise.all([call(env.INVITES, 'invites', `/rooms?${q(who)}`), call(env.INVITES, 'invites', `/inbox?${q(who)}`)]);
  const rooms = (mine?.rooms ?? []).filter((item) => /^[0-9a-f]{32}$/.test(item.room || ''));
  const invited = (inbox?.invitations ?? []).filter((item) => /^[0-9a-f]{32}$/.test(item.room || '') && !rooms.some((one) => one.room === item.room));
  return { rooms, invited };
}

/** What is kept about one person, shown before they delete it. */
export async function accountSummary(env, email) {
  const who = String(email).toLowerCase();
  const kept = async (kind) => (env.SESSIONS && secretsReady(env) ? Boolean(await env.SESSIONS.get(await secretsKey(env, kind, who))) : false);
  const [{ rooms, invited }, devices, usage, sent, github, overleaf] = await Promise.all([
    roomsOf(env, who),
    call(env.DEVICES, `devices:${who}`, '/list'),
    call(env.USAGE, 'usage', `/mine?${q(who)}`),
    call(env.INVITES, 'invites', `/mine?${q(who)}`),
    kept('github'),
    kept('overleaf'),
  ]);
  const sentCount = sent ? Object.values(sent.sent ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0) : 0;
  return {
    email: who,
    owned: rooms.filter((item) => item.role === 'owner').map((item) => ({ room: item.room, project: item.project || 'A project' })),
    joined: rooms.filter((item) => item.role !== 'owner').map((item) => ({ room: item.room, project: item.project || 'A project' })),
    invited: invited.length,
    devices: devices?.devices?.length ?? 0,
    usageDays: usage?.days ?? 0,
    invitationsSent: sentCount,
    github,
    overleaf,
  };
}

/**
 * Everything kept about one person deleted. `client` is the browser's id
 * (X-Reader-Client), for what is kept by browser, and `browserSession` that
 * browser's object (sessionStub in worker/index.js). `rooms` are the shared
 * projects the page's own library says it is in: seen to beside the
 * ledger's, so a room either side lost is still left or closed (a room the
 * person is not in is untouched by the call). Answers what was done; a store
 * that is not bound here, or does not answer, is skipped and said so.
 */
export async function eraseAccount(env, email, { client, browserSession, rooms: known = [] } = {}) {
  const who = String(email).toLowerCase();
  const done = { closed: 0, left: 0, skipped: [] };

  const { rooms, invited } = await roomsOf(env, who);
  const ids = new Set([...rooms, ...invited].map((item) => item.room));
  for (const id of known) if (/^[0-9a-f]{32}$/.test(String(id))) ids.add(id);
  for (const id of ids) {
    const answer = await call(env.ROOMS, `room:${id}`, `/erase?${q(who)}`, {});
    if (!answer) continue;
    if (Array.isArray(answer.members)) {
      done.closed += 1;
      // Everyone who was in a closed room is out of it on the ledger too.
      await call(env.INVITES, 'invites', '/room-closed', { room: id, emails: answer.members });
    } else if (answer.left) {
      done.left += 1;
    }
  }

  const ledger = await call(env.INVITES, 'invites', '/forget', { email: who });
  if (ledger) Object.assign(done, { invitations: ledger.events, mail: ledger.mail });
  else if (env.INVITES) done.skipped.push('invitations');

  const usage = await call(env.USAGE, 'usage', '/forget', { email: who });
  if (usage) done.usageDays = usage.days;
  else if (env.USAGE) done.skipped.push('usage');

  const devices = await call(env.DEVICES, `devices:${who}`, '/erase', {});
  if (devices) done.devices = devices.devices;
  else if (env.DEVICES) done.skipped.push('devices');

  try {
    done.github = await forgetGithub(env, who);
  } catch {
    done.skipped.push('github');
  }
  try {
    done.overleaf = await forgetOverleaf(env, who);
  } catch {
    done.skipped.push('overleaf');
  }

  if (client) {
    if (browserSession) await browserSession.fetch(`https://session/erase?client=${encodeURIComponent(client)}`, { method: 'POST' }).catch(() => undefined);
    done.browser = await forgetCookies(forClient(env, client)).catch(() => false);
  }
  return done;
}
