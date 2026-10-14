// Mail from the site (server/mail.js): which provider a key is for, that
// nothing is sent with no key or sender, the invitation's words, and the
// request each provider gets — a refusal reported, never thrown.
//
//   node --test scripts/mail.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { invitationMail, mailConfigured, mailProvider, sendMail } = await import('../server/mail.js');

describe('which provider', () => {
  it('is told by the key, or named', () => {
    assert.equal(mailProvider({ MAIL_API_KEY: 'xkeysib-abc' }), 'brevo');
    assert.equal(mailProvider({ MAIL_API_KEY: 're_abc' }), 'resend');
    assert.equal(mailProvider({ MAIL_API_KEY: 'SG.abc' }), 'sendgrid');
    assert.equal(mailProvider({ MAIL_API_KEY: '12345678-1234-1234-1234-123456789abc' }), 'postmark');
    assert.equal(mailProvider({ MAIL_API_KEY: 'xyz', MAIL_PROVIDER: 'SendGrid' }), 'sendgrid');
    assert.equal(mailProvider({ MAIL_API_KEY: 'xyz' }), null);
  });
  it('needs a key, a sender and a provider', () => {
    assert.equal(mailConfigured({ MAIL_API_KEY: 're_abc', MAIL_FROM: 'Reader <noreply@x.org>' }), true);
    assert.equal(mailConfigured({ MAIL_API_KEY: 're_abc' }), false);
    assert.equal(mailConfigured({ MAIL_FROM: 'noreply@x.org' }), false);
    assert.equal(mailConfigured({ MAIL_API_KEY: 'xyz', MAIL_FROM: 'noreply@x.org' }), false);
  });
});

describe('the invitation', () => {
  it('names who asked, the project, the link, the steps, and that signing in is the account', () => {
    const mail = invitationMail({ to: 'dana@ethz.ch', inviter: 'Saurav C', inviterEmail: 's@x.org', project: 'Sparse-gated MoE', question: 'Why?', role: 'viewer', link: 'https://site/reader/project/?id=p&room=r' });
    assert.equal(mail.subject, 'Saurav C invited you to “Sparse-gated MoE” on Reader');
    assert.match(mail.text, /Saurav C has invited you to work together on “Sparse-gated MoE” in Reader/);
    assert.match(mail.text, /The project's question: Why\?/);
    assert.match(mail.text, /1\. Open the project: https:\/\/site\/reader\/project\/\?id=p&room=r/);
    assert.match(mail.text, /2\. Sign in with Google as dana@ethz\.ch/);
    assert.match(mail.text, /there is nothing to create/);
    assert.match(mail.text, /As a viewer you can see the project, and where everyone in it is/);
    assert.match(mail.text, /Just reply — it goes to Saurav C \(s@x\.org\)/);
    assert.match(mail.text, /Not expecting this\?/);
    assert.match(mail.html, /<a href="https:\/\/site\/reader\/project\/\?id=p&amp;room=r"/);
    assert.match(mail.html, /<b>Sparse-gated MoE<\/b>/);
    assert.match(mail.html, /<ol/);
  });
  it('escapes what people typed, does without a name or a question, and tells an editor what they may do', () => {
    const mail = invitationMail({ to: 'a@b', inviterEmail: 'x@y', project: '<b>x</b>', role: 'editor', link: 'https://site/' });
    assert.equal(mail.subject, 'x@y invited you to “<b>x</b>” on Reader');
    assert.match(mail.html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(mail.text, /The project's question/);
    assert.match(mail.text, /As an editor you can change the project/);
    assert.match(mail.text, /it goes to x@y \(x@y\)/);
  });
});

describe('sending', () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(url.includes('postmark') ? '{"ErrorCode":10}' : '{}', { status: url.includes('postmark') ? 422 : 200 });
  };
  const message = { to: 'dana@ethz.ch', subject: 'S', text: 'T', html: '<p>T</p>', replyTo: 's@x.org' };

  it('answers that nothing is set up, and sends nothing', async () => {
    const before = calls.length;
    const sent = await sendMail({}, message, { fetchImpl });
    assert.equal(sent.ok, false);
    assert.match(sent.error, /MAIL_API_KEY/);
    assert.equal(calls.length, before);
  });
  it('writes each provider its own request', async () => {
    calls.length = 0;
    assert.deepEqual(await sendMail({ MAIL_API_KEY: 're_k', MAIL_FROM: 'Reader <noreply@x.org>' }, message, { fetchImpl }), { ok: true });
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_k');
    assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Reader <noreply@x.org>', to: ['dana@ethz.ch'], subject: 'S', text: 'T', html: '<p>T</p>', reply_to: 's@x.org' });

    assert.deepEqual(await sendMail({ MAIL_API_KEY: 'SG.k', MAIL_FROM: 'Reader <noreply@x.org>' }, message, { fetchImpl }), { ok: true });
    const sendgrid = JSON.parse(calls[1].init.body);
    assert.deepEqual(sendgrid.from, { email: 'noreply@x.org', name: 'Reader' });
    assert.deepEqual(sendgrid.personalizations, [{ to: [{ email: 'dana@ethz.ch' }] }]);
    assert.deepEqual(sendgrid.reply_to, { email: 's@x.org' });
    assert.equal(sendgrid.content.length, 2);

    assert.deepEqual(await sendMail({ MAIL_API_KEY: 'xkeysib-k', MAIL_FROM: 'Reader <me@gmail.com>' }, message, { fetchImpl }), { ok: true });
    const brevo = JSON.parse(calls[2].init.body);
    assert.equal(calls[2].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[2].init.headers['api-key'], 'xkeysib-k');
    assert.deepEqual(brevo.sender, { email: 'me@gmail.com', name: 'Reader' });
    assert.deepEqual(brevo.to, [{ email: 'dana@ethz.ch' }]);
    assert.deepEqual(brevo.replyTo, { email: 's@x.org' });
    assert.equal(brevo.textContent, 'T');
    calls.splice(2, 1);

    const postmark = await sendMail({ MAIL_API_KEY: 'k', MAIL_PROVIDER: 'postmark', MAIL_FROM: 'noreply@x.org' }, message, { fetchImpl });
    assert.equal(postmark.ok, false);
    assert.match(postmark.error, /answered 422/);
    assert.equal(calls[2].init.headers['X-Postmark-Server-Token'], 'k');
    assert.equal(JSON.parse(calls[2].init.body).ReplyTo, 's@x.org');
  });
  it('reports a provider that cannot be reached', async () => {
    const sent = await sendMail({ MAIL_API_KEY: 're_k', MAIL_FROM: 'noreply@x.org' }, message, { fetchImpl: async () => { throw new Error('down'); } });
    assert.equal(sent.ok, false);
    assert.match(sent.error, /could not be reached: down/);
  });
});
