// The one prompt to carry a Google sign-in on, where background work needs a
// new token (src/lib/google.ts, renewQuietly): a browser opens Google's window
// only inside a click, so the explorer reading Drive, a run polled through
// Colab and the agents wait, together, for this one — instead of each opening
// a window of its own. A few minutes before the hour is up it offers to renew
// ahead, so a long run on a GPU isn't stopped by it.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { DRIVE_SCOPE, COLAB_SCOPE, onRenewal, renewalWaiting, renewNow, tokenExpiresAt, tokenScopes } from '../lib/google';
import { GoogleMark } from './icons';

const AHEAD_MS = 5 * 60_000;

export default function GoogleRenewal({ clientId }: { clientId: string }) {
  const waiting = useSyncExternalStore(onRenewal, renewalWaiting);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [later, setLater] = useState<number | null>(null);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(tick);
  }, []);
  const expires = tokenExpiresAt();
  const scopes = tokenScopes();
  // Ahead of time only for a token that background work leans on (Drive, Colab), and not after "Later" for this token.
  const soon = !waiting && expires !== null && expires > now && expires - now < AHEAD_MS && (scopes.includes(DRIVE_SCOPE) || scopes.includes(COLAB_SCOPE)) && later !== expires;
  if (!clientId || (!waiting && !soon)) return null;
  const minutes = expires ? Math.max(1, Math.round((expires - now) / 60_000)) : 0;
  const renew = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await renewNow(clientId);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  };
  return (
    <div className={`google-renewal${waiting ? ' is-waiting' : ''}`} role="alert">
      <GoogleMark size={16} />
      <span>
        {waiting ? (
          <>
            <b>Your Google sign-in ran out.</b> Drive and Colab are waiting — nothing is lost; one click carries on.
          </>
        ) : (
          <>
            <b>Your Google sign-in ends in {minutes} min.</b> Renew it now, so a run in progress isn’t interrupted.
          </>
        )}
        {problem ? <em> {problem}</em> : null}
      </span>
      <button type="button" className="btn sm primary" disabled={busy} onClick={() => void renew()}>
        {busy ? 'Waiting for Google…' : waiting ? 'Continue' : 'Renew now'}
      </button>
      {!waiting ? (
        <button type="button" className="btn sm ghost" onClick={() => setLater(expires)}>
          Later
        </button>
      ) : null}
    </div>
  );
}
