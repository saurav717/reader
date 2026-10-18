// "Invite someone": show a colleague, a student, a coauthor — anyone who may
// never have opened Koios — what it is, three ways with one message
// (docs/live-collaboration.md): a personal link with your name and a note,
// and a QR code of it for a slide; an email from the site's sender with you
// as the reply-to (server/mail.js); or your own mail app, with the message
// filled in. From Settings, under your Google account, and from the share
// dialog of a project. The ledger of what took is worker/invites.js.

import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { apiFetch, currentPass, proxyHealth } from '../lib/api';
import { basePath } from '../lib/route';
import { createInviteLink, mailtoFor, tryItText, type InviteLink } from '../lib/invites';
import QrCode, { qrSvg } from './QrCode';

type Way = 'link' | 'mail' | 'app';
type Sent = { email: string; ok: boolean; note: string };

export default function InviteSomeone({ onClose }: { onClose: () => void }) {
  const { user } = useStore();
  const [mails, setMails] = useState<boolean | null>(null);
  const [way, setWay] = useState<Way>('link');
  const [emails, setEmails] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent[]>([]);
  const [link, setLink] = useState<InviteLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void proxyHealth().then((health) => setMails(Boolean(health?.mail)));
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  const signedIn = Boolean(user) || Boolean(currentPass());
  const site = `${window.location.origin}${basePath()}`;
  const addresses = [...new Set(emails.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))].slice(0, 10);

  // The link is made once per note: a new note, a new link, so what it says is what you wrote.
  const makeLink = async () => {
    setBusy(true);
    setLinkError(null);
    try {
      setLink(await createInviteLink(site, user?.name, note));
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)));
  const downloadQr = () => {
    if (!link) return;
    const blob = new Blob([qrSvg(link.url, 480)], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'reader-invite.svg';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const send = async () => {
    if (!addresses.length) return;
    setBusy(true);
    const results: Sent[] = [];
    for (const email of addresses) {
      try {
        const response = await apiFetch('/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, note, link: site, name: user?.name }) });
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        results.push({ email, ok: Boolean(body.ok), note: body.ok ? 'sent' : body.error || `Koios’s server answered ${response.status}.` });
      } catch (error) {
        results.push({ email, ok: false, note: error instanceof Error ? error.message : String(error) });
      }
    }
    setSent((was) => [...was, ...results]);
    setEmails(results.filter((item) => !item.ok).map((item) => item.email).join(', '));
    setBusy(false);
  };

  const message = tryItText(user?.name ?? '', note, link?.url ?? site);
  const mailto = mailtoFor(addresses.join(','), message.subject, message.body);

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} role="presentation" />
      <div className="sheet invite-someone" role="dialog" aria-modal="true" aria-labelledby="invite-someone-title">
        <span className="eyebrow">Invite someone</span>
        <h2 id="invite-someone-title">Show someone Koios</h2>
        <p className="lede">Three ways, one message: what Koios is in a few lines, your note, and the site’s address. Whoever opens it signs in with Google, and that is their account — nothing for them to create.</p>
        {!signedIn ? (
          <p className="invite-someone-note">Sign in with Google first: the invitation says who it is from.</p>
        ) : (
          <>
            <label className="pj-label">
              A note of your own <span className="pj-hint">— optional; quoted on the welcome page, and in the email</span>
              <textarea value={note} rows={2} placeholder="I've been keeping the papers for our project in this — have a look before Thursday's meeting?" onChange={(event) => (setNote(event.target.value.slice(0, 1000)), setLink(null))} disabled={busy} />
            </label>
            <div className="invite-ways" role="tablist" aria-label="How to invite">
              {(
                [
                  ['link', 'A link to share', 'Paste it in Slack, WhatsApp, a slide. Good for 30 days; one link serves a whole group.'],
                  ['mail', 'An email from the site', mails === false ? 'This site cannot send mail yet (its Worker has no mail key).' : `From the site’s sender, with you as the reply-to.`],
                  ['app', 'From my own mail app', 'Opens Mail, Gmail or Outlook with the message filled in, from your real address.'],
                ] as const
              ).map(([id, title, about]) => (
                <button key={id} type="button" role="tab" aria-selected={way === id} className={`invite-way${way === id ? ' is-on' : ''}`} onClick={() => setWay(id)}>
                  <b>{title}</b>
                  <small>{about}</small>
                </button>
              ))}
            </div>

            {way === 'link' ? (
              <div className="invite-link">
                {link ? (
                  <>
                    <div className="invite-link-row">
                      <code>{link.url.replace(/^https?:\/\//, '')}</code>
                      <button type="button" className="link-btn" onClick={() => copy(link.url)}>
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="invite-link-qr">
                      <QrCode text={link.url} size={128} title="QR code of the invite link" />
                      <div>
                        <p>Scan it, or put it on a slide. Whoever opens the link sees your name{note.trim() ? ' and your note' : ''} on the welcome page.</p>
                        <p className="muted">Good until {new Date(link.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. Each person who signs in from it shows in your tally.</p>
                        <button type="button" className="link-btn" onClick={downloadQr}>
                          Download the QR code
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="invite-link-make">
                    <p>A personal link to the site, with your name{note.trim() ? ' and the note above' : ''} on the welcome page for whoever opens it, and a QR code of it.</p>
                    {linkError ? <p className="pj-share-error">{linkError}</p> : null}
                    <button type="button" className="btn primary" disabled={busy} onClick={() => void makeLink()}>
                      {busy ? 'Making the link…' : 'Make the link'}
                    </button>
                  </div>
                )}
              </div>
            ) : null}

            {way === 'mail' || way === 'app' ? (
              <label className="pj-label">
                Their email <span className="pj-hint">— one, or a few, separated by commas</span>
                <input autoFocus value={emails} placeholder="colleague@university.edu" onChange={(event) => setEmails(event.target.value)} disabled={busy} />
              </label>
            ) : null}
            {way === 'mail' && mails === false ? (
              <p className="invite-someone-note">
                This site can’t send mail yet. Use the link, or your own mail app — or set up mail on the Worker (docs/deploy.md).
              </p>
            ) : null}
            {sent.length && way === 'mail' ? (
              <ul className="invite-someone-sent">
                {sent.map((item, index) => (
                  <li key={`${item.email}:${index}`} className={item.ok ? 'is-ok' : 'is-bad'}>
                    <b>{item.email}</b> · {item.note}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                {sent.some((item) => item.ok) || link ? 'Done' : 'Cancel'}
              </button>
              {way === 'link' ? (
                link ? (
                  <button type="button" className="btn primary" onClick={() => copy(link.url)}>
                    {copied ? 'Copied' : 'Copy the link'}
                  </button>
                ) : null
              ) : way === 'mail' ? (
                <button type="button" className="btn primary" disabled={busy || !addresses.length || !mails} onClick={() => void send()}>
                  {busy ? 'Sending…' : addresses.length > 1 ? `Send ${addresses.length} invitations` : 'Send the invitation'}
                </button>
              ) : (
                <a className="btn primary" href={mailto} onClick={() => window.setTimeout(onClose, 300)}>
                  Open in my mail app ↗
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
