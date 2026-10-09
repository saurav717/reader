// Settings → Google account → Proxy sign-in: whether this browser holds the
// proxy's pass, whose, until when, and whether the proxy calls it the owner's
// (which is what puts Usage on the rail). And a way to get a new one without
// signing out: the proxy's check that you are a person, then the pass, the way
// the sign-in screen does it (passForGoogle in lib/api.ts).
//
// A browser can be signed in with Google and still hold no pass: signed in while
// the site had no proxy, or with the pass gone. Nothing asks for one again until
// the next sign-in, since only the sign-in screen shows the check; this does.

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, BUILT_IN_BASE, captchaSiteKey, hasProxy, isPass, mayAskForPass, passEmail, passExpires, passForGoogle } from '../lib/api';
import * as google from '../lib/google';
import { useStore } from '../lib/store';
import { Captcha } from './Welcome';

type Owner = { state: 'checking' } | { state: 'owner' } | { state: 'not-owner'; why: string } | { state: 'unknown' };

/** What the proxy says of this browser's token: the owner's (it answers /usage), or why not. */
async function ownerCheck(token: string): Promise<Owner> {
  try {
    const response = await apiFetch('/usage?days=1', { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) return { state: 'owner' };
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { state: 'not-owner', why: body.error || `The proxy said ${response.status}.` };
  } catch {
    return { state: 'unknown' };
  }
}

export default function ProxyPass() {
  const { user, settings, updateSettings, connectDrive } = useStore();
  const held = settings.proxyToken.trim();
  const pass = isPass(held);
  const email = pass ? passEmail(held) : null;
  const expires = pass ? passExpires(held) : 0;
  const expired = pass && expires <= Date.now();
  const [owner, setOwner] = useState<Owner>({ state: 'checking' });
  const [asking, setAsking] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null | undefined>(undefined);
  const [solved, setSolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!hasProxy() || !held) return setOwner({ state: 'unknown' });
    let live = true;
    setOwner({ state: 'checking' });
    void ownerCheck(held).then((answer) => live && setOwner(answer));
    return () => {
      live = false;
    };
  }, [held, settings.proxyBase]);

  const start = useCallback(async () => {
    setProblem(null);
    setAsking(true);
    setSiteKey(await captchaSiteKey());
  }, []);

  const finish = async () => {
    setBusy(true);
    setProblem(null);
    try {
      // The proxy wants a live Google sign-in to vouch for the pass: renew it quietly if it has run out.
      if (!google.liveAccessToken()) await connectDrive();
      const googleToken = google.liveAccessToken();
      if (!googleToken) throw new Error('Google didn’t hand over a sign-in. Try Sign out, then sign in again.');
      const fresh = await passForGoogle(googleToken, pass && !expired ? held : undefined);
      if (!fresh) throw new Error('The proxy didn’t give a pass. Check that this account is on its READER_EMAILS list, if it has one.');
      updateSettings({ proxyToken: fresh });
      setAsking(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!user || !hasProxy()) return null;
  // A proxy typed into Settings that isn't this site's own is never given the sign-in.
  if (!mayAskForPass()) {
    return (
      <p className="proxy-pass">
        <b>Proxy sign-in.</b> The Proxy URL below names a proxy other than this site’s{BUILT_IN_BASE ? ` (${BUILT_IN_BASE})` : ''}, so your Google sign-in isn’t passed to it, and it can’t know you. Empty that box to use the site’s own.
      </p>
    );
  }
  const date = expires ? new Date(expires).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return (
    <div className="proxy-pass">
      <div>
        <b>Proxy sign-in.</b>{' '}
        {!held
          ? 'This browser holds no pass for the proxy, so the proxy treats you as a visitor: no Usage dashboard, and the per-person limits.'
          : !pass
            ? 'A token pasted by hand (Paper proxy → Proxy token) is in use, not a pass from your sign-in.'
            : expired
              ? `The pass for ${email ?? 'you'} ran out on ${date}.`
              : `A pass for ${email ?? 'you'}, good until ${date}.`}{' '}
        {owner.state === 'checking' ? 'Asking the proxy…' : owner.state === 'owner' ? 'The proxy knows you as its owner: Usage is on the rail.' : owner.state === 'not-owner' && held ? `The proxy doesn’t treat it as the owner’s: “${owner.why}”` : null}
      </div>
      {asking ? (
        <div className="proxy-pass-ask">
          {siteKey === undefined ? <span className="spinner" /> : siteKey ? <Captcha siteKey={siteKey} onSolved={setSolved} /> : null}
          <button type="button" className="btn sm primary" disabled={busy || siteKey === undefined || (Boolean(siteKey) && !solved)} onClick={() => void finish()}>
            {busy ? 'Asking…' : 'Get the pass'}
          </button>
        </div>
      ) : owner.state !== 'owner' && owner.state !== 'checking' ? (
        <button type="button" className="btn sm" onClick={() => void start()}>
          Get a new pass
        </button>
      ) : null}
      {problem ? <p className="banner error">{problem}</p> : null}
    </div>
  );
}
