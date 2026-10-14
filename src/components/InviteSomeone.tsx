// "Invite someone": a mail from you to a colleague, a student, a coauthor —
// anyone who may never have opened Reader — what it is, a note of your own, and the site's address — sent by
// the Worker (server/mail.js, the /invite route) from the site's sender with
// you as the reply-to. From Settings, under your Google account, and from
// the share dialog of a project.

import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { apiFetch, currentPass, proxyHealth } from '../lib/api';
import { basePath } from '../lib/route';

type Sent = { email: string; ok: boolean; note: string };

export default function InviteSomeone({ onClose }: { onClose: () => void }) {
  const { user } = useStore();
  const [mails, setMails] = useState<boolean | null>(null);
  const [emails, setEmails] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent[]>([]);
  useEffect(() => {
    void proxyHealth().then((health) => setMails(Boolean(health?.mail)));
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  const link = `${window.location.origin}${basePath()}`;
  const addresses = [...new Set(emails.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))].slice(0, 10);
  const send = async () => {
    if (!addresses.length) return;
    setBusy(true);
    const results: Sent[] = [];
    for (const email of addresses) {
      try {
        const response = await apiFetch('/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, note, link, name: user?.name }) });
        const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        results.push({ email, ok: Boolean(answer.ok), note: answer.ok ? 'sent' : answer.error || `Reader’s server answered ${response.status}.` });
      } catch (error) {
        results.push({ email, ok: false, note: error instanceof Error ? error.message : String(error) });
      }
    }
    setSent((was) => [...was, ...results]);
    setEmails(results.filter((item) => !item.ok).map((item) => item.email).join(', '));
    setBusy(false);
  };

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} role="presentation" />
      <div className="sheet narrow invite-someone" role="dialog" aria-modal="true" aria-labelledby="invite-someone-title">
        <span className="eyebrow">Invite someone</span>
        <h2 id="invite-someone-title">Show someone Reader</h2>
        <p className="lede">
          They get an email from the site, with you as the reply-to: what Reader is in a few lines, your note, and the site’s address. Signing in with Google is all an account is — nothing for them to create.
        </p>
        {!user && !currentPass() ? (
          <p className="invite-someone-note">Sign in with Google first: the email says who it is from.</p>
        ) : mails === false ? (
          <p className="invite-someone-note">
            This site can’t send mail yet (its Worker has no mail key). Send them the address instead: <code>{link}</code>
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="pj-label">
              Their email <span className="pj-hint">— one, or a few, separated by commas</span>
              <input autoFocus value={emails} placeholder="colleague@university.edu" onChange={(event) => setEmails(event.target.value)} disabled={busy} />
            </label>
            <label className="pj-label">
              A note of your own <span className="pj-hint">— optional; quoted in the email</span>
              <textarea value={note} rows={3} placeholder="I've been keeping the papers for our project in this — have a look before Thursday's meeting?" onChange={(event) => setNote(event.target.value.slice(0, 1000))} disabled={busy} />
            </label>
            {sent.length ? (
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
                {sent.some((item) => item.ok) ? 'Done' : 'Cancel'}
              </button>
              <button type="submit" className="btn primary" disabled={busy || !addresses.length || mails === null}>
                {busy ? 'Sending…' : addresses.length > 1 ? `Send ${addresses.length} invitations` : 'Send the invitation'}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
