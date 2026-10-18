// "Delete my account" (Settings → Account): what the site keeps about the
// account, said plainly before anything goes; the app's files in Drive put in
// the trash only when ticked; and the address typed out to be sure. The
// deleting itself is lib/account.ts.

import { useEffect, useState } from 'react';
import { deleteAccount, readAccount, type AccountSummary } from '../lib/account';

interface Props {
  email: string;
  googleClientId: string;
  onClose: () => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function DeleteAccount({ email, googleClientId, onClose }: Props) {
  const [summary, setSummary] = useState<AccountSummary | null | undefined>(undefined);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [trashDriveFiles, setTrashDriveFiles] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    readAccount()
      .then(setSummary)
      .catch((reason: unknown) => {
        setSummary(null);
        setSummaryError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const confirmed = typed.trim().toLowerCase() === email.toLowerCase();

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount({ email, googleClientId, trashDriveFiles });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const server: string[] = [];
  if (summary) {
    if (summary.owned.length) server.push(`${plural(summary.owned.length, 'shared project')} you own closed for everyone in ${summary.owned.length === 1 ? 'it' : 'them'}: ${summary.owned.map((item) => `“${item.project}”`).join(', ')}`);
    if (summary.joined.length) server.push(`You leave ${plural(summary.joined.length, 'shared project')} of other people’s: ${summary.joined.map((item) => `“${item.project}”`).join(', ')}. What you wrote in their logbooks stays with those projects, without your address.`);
    if (summary.invited) server.push(`${plural(summary.invited, 'invitation')} to a project you haven’t joined`);
    if (summary.invitationsSent) server.push(`The record of ${plural(summary.invitationsSent, 'invitation')} you sent, and the site’s mail to or from you`);
    if (summary.devices) server.push(`${plural(summary.devices, 'connected computer')} taken off your account`);
    if (summary.github) server.push('Your GitHub connection, given back to GitHub');
    if (summary.overleaf) server.push('Your Overleaf accounts and their tokens');
    if (summary.usageDays) server.push(`Your usage counts (${plural(summary.usageDays, 'day')} of them)`);
  }

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} role="presentation" />
      <div className="sheet delete-account" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
        <span className="eyebrow">Delete my account</span>
        <h2 id="delete-account-title">Delete everything Koios keeps about {email}</h2>
        <p className="lede">This can’t be undone. You can sign in again later, but you would start with an empty library.</p>

        <h3 className="delete-account-head">On Koios’s server</h3>
        {summary === undefined ? (
          <p className="muted">Looking up what is kept…</p>
        ) : summaryError ? (
          <p className="pj-share-error">Couldn’t read what is kept ({summaryError}). Deleting still removes all of it.</p>
        ) : summary === null ? (
          <p className="muted">This site has no server signed in for you, so nothing of yours is kept there.</p>
        ) : (
          <ul className="delete-account-list">
            {server.length ? server.map((line) => <li key={line}>{line}</li>) : <li>Nothing beyond your sign-in, which ends with this.</li>}
          </ul>
        )}

        <h3 className="delete-account-head">In this browser</h3>
        <ul className="delete-account-list">
          <li>Its copy of your library, your settings, and the keys and tokens you saved here. You are signed out, and Google’s access for Koios is revoked.</li>
        </ul>

        <h3 className="delete-account-head">In your Google Drive</h3>
        <label className="delete-account-check">
          <input type="checkbox" checked={trashDriveFiles} onChange={(event) => setTrashDriveFiles(event.target.checked)} disabled={busy} />
          <span>
            Also move my Koios files in Drive to the trash — the <code>Papers_collection</code> folder with your papers, highlights and notes. Drive keeps the trash for 30 days, so you can still restore them. Left unticked, your files stay in your Drive.
          </span>
        </label>

        <label className="pj-label">
          Type <b>{email}</b> to confirm
          <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={email} autoComplete="off" spellCheck={false} disabled={busy} />
        </label>
        {error ? <p className="pj-share-error">Nothing more was deleted: {error}</p> : null}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary danger-fill" onClick={() => void go()} disabled={!confirmed || busy}>
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
      </div>
    </>
  );
}
