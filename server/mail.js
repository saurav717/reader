/**
 * Mail from the site: the invitation to a shared project (worker/index.js,
 * the /rooms/<id>/invite route), sent to the address invited whether or not
 * it has ever opened Reader. A Worker sends no mail itself, so it goes
 * through a transactional provider's API — Resend, SendGrid or Postmark,
 * whichever the key is for — from an address on a domain the provider has
 * verified. Three settings, the key a secret:
 *
 *     npx wrangler secret put MAIL_API_KEY       # the provider's API key
 *     MAIL_FROM = "Reader <noreply@example.org>"  # a var: the sender, on a verified domain
 *     MAIL_PROVIDER = "resend"                    # optional: resend, sendgrid or postmark; guessed from the key otherwise
 *
 * With none of them set, nothing is sent and the share dialog says to send
 * the link by hand. Nothing here reads a request: it is given who to write
 * to and what about, and answers whether the provider took it.
 */

const PROVIDERS = {
  resend: {
    url: 'https://api.resend.com/emails',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ from, to, subject, text, html, replyTo }) => ({ from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  },
  sendgrid: {
    url: 'https://api.sendgrid.com/v3/mail/send',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ from, to, subject, text, html, replyTo }) => ({
      personalizations: [{ to: [{ email: to }] }],
      from: address(from),
      subject,
      content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])],
      ...(replyTo ? { reply_to: address(replyTo) } : {}),
    }),
  },
  postmark: {
    url: 'https://api.postmarkapp.com/email',
    headers: (key) => ({ 'X-Postmark-Server-Token': key }),
    body: ({ from, to, subject, text, html, replyTo }) => ({ From: from, To: to, Subject: subject, TextBody: text, ...(html ? { HtmlBody: html } : {}), ...(replyTo ? { ReplyTo: replyTo } : {}), MessageStream: 'outbound' }),
  },
};

/** "Reader <noreply@x.org>" as SendGrid wants it: { email, name }. */
function address(value) {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(value);
  return match ? { email: match[2].trim(), ...(match[1]?.trim() ? { name: match[1].trim() } : {}) } : { email: String(value).trim() };
}

/** Which provider the key is for: named, or told by the key's own shape. */
export function mailProvider(env) {
  const named = String(env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (PROVIDERS[named]) return named;
  const key = String(env.MAIL_API_KEY || '').trim();
  if (key.startsWith('re_')) return 'resend';
  if (key.startsWith('SG.')) return 'sendgrid';
  if (/^[0-9a-f-]{36}$/i.test(key)) return 'postmark';
  return null;
}

/** Whether the site can send mail at all: a key, a sender, and a provider to give them to. */
export function mailConfigured(env) {
  return Boolean(String(env.MAIL_API_KEY || '').trim() && String(env.MAIL_FROM || '').trim() && mailProvider(env));
}

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The invitation: who asked, to what, and the link that joins it. The link
 * works only signed in with Google as the address invited, and signing in is
 * all an account is — so someone who has never opened Reader is told just that.
 */
export function invitationMail({ to, inviter, inviterEmail, project, question, role, link }) {
  const name = inviter || inviterEmail || 'Someone';
  const what = project || 'a project';
  const may = role === 'viewer' ? 'see the project, and where everyone in it is' : 'edit the project, and see where everyone in it is';
  const subject = `${name} invited you to ${what} on Reader`;
  const text = [
    `${name} invited you to work on “${what}” in Reader${question ? `: ${question}` : '.'}`,
    '',
    'Open the project:',
    link,
    '',
    `Sign in with Google as ${to} — the invitation is for that address. If you haven’t used Reader before, signing in is all it takes: your library is kept in your own Google Drive, and the project appears in it.`,
    '',
    `You can ${may}.${inviterEmail ? ` Replies go to ${name}.` : ''}`,
  ].join('\n');
  const html = [
    `<p>${escape(name)} invited you to work on <b>${escape(what)}</b> in Reader${question ? `: <i>${escape(question)}</i>` : '.'}</p>`,
    `<p><a href="${escape(link)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1f5e52;color:#f6f4ec;text-decoration:none;font-weight:600">Open the project</a></p>`,
    `<p style="color:#55524a">Sign in with Google as <b>${escape(to)}</b> — the invitation is for that address. If you haven’t used Reader before, signing in is all it takes: your library is kept in your own Google Drive, and the project appears in it.</p>`,
    `<p style="color:#55524a">You can ${may}.${inviterEmail ? ` Replies go to ${escape(name)}.` : ''}</p>`,
    `<p style="color:#6f6c63;font-size:12px">If the button does nothing, open this address: ${escape(link)}</p>`,
  ].join('\n');
  return { subject, text, html };
}

/**
 * One message, through the provider the key is for. Answers { ok } or
 * { ok: false, error } — a provider refusing is reported, never thrown, so
 * an invitation stands even when its mail does not go.
 */
export async function sendMail(env, { to, subject, text, html, replyTo }, { fetchImpl = (...args) => fetch(...args) } = {}) {
  if (!mailConfigured(env)) return { ok: false, error: 'mail is not set up here: MAIL_API_KEY and MAIL_FROM (wrangler.toml)' };
  const provider = PROVIDERS[mailProvider(env)];
  const key = String(env.MAIL_API_KEY).trim();
  const from = String(env.MAIL_FROM).trim();
  let response;
  try {
    response = await fetchImpl(provider.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...provider.headers(key) }, body: JSON.stringify(provider.body({ from, to, subject, text, html, replyTo })) });
  } catch (error) {
    return { ok: false, error: `the mail provider could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.ok) return { ok: true };
  const said = await response.text().catch(() => '');
  return { ok: false, error: `the mail provider answered ${response.status}${said ? `: ${said.slice(0, 200)}` : ''}` };
}
