import { useEffect, useRef, useState } from 'react';
import { accessAvailable, finishSignIn, requestSignIn, waitForSignIn, type AccessStatus } from '../lib/access';
import type { SignInOffer } from '../lib/pdf';

interface Props {
  /** The publisher that wanted a sign-in, and its page to sign in at. */
  offer: SignInOffer;
  /** Called once the window has been closed: the caller asks for the paper again. */
  onSignedIn: () => void;
}

type Stage = 'idle' | 'opening' | 'open' | 'failed';

/**
 * The offer to sign in, where a publisher's copy came back as a login wall.
 *
 * One button opens a real browser window — on the proxy's machine, which is
 * this one when the proxy is `npm start` — at the publisher's page, where the
 * institutional sign-in link is. When that window closes, or the person says
 * they are done, the caller asks for the paper again, and this time the
 * proxy asks through the signed-in browser.
 *
 * Where the proxy cannot open a window — a Cloudflare Worker has no screen —
 * this says so instead, with what to run to get one.
 */
export default function SignInPrompt({ offer, onSignedIn }: Props) {
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    accessAvailable().then((status) => {
      if (live) setAccess(status);
    });
    return () => {
      live = false;
      waiting.current?.abort();
    };
  }, []);

  const signIn = async () => {
    setStage('opening');
    setProblem(null);
    try {
      await requestSignIn(offer.url);
    } catch (error) {
      setStage('failed');
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    setStage('open');
    const controller = new AbortController();
    waiting.current = controller;
    try {
      await waitForSignIn(controller.signal);
    } catch {
      return; // unmounted
    }
    waiting.current = null;
    setStage('idle');
    onSignedIn();
  };

  const done = async () => {
    await finishSignIn();
    // The poll notices the window is closed on its next turn; this only
    // shortens the wait.
  };

  if (!access) return null;

  if (!access.available) {
    return (
      <span className="sign-in-note">
        {' '}
        To read it here, sign in at {offer.host} through your institution — which this proxy cannot open a
        window for. {access.reason}
      </span>
    );
  }

  if (stage === 'open') {
    return (
      <span className="sign-in-note">
        {' '}
        A browser window has opened at {offer.host}. Sign in there through your institution, then close it
        — the paper is fetched again the moment it closes.{' '}
        <button type="button" className="link-btn" onClick={() => void done()}>
          I have signed in
        </button>
      </span>
    );
  }

  return (
    <span className="sign-in-note">
      {' '}
      <button type="button" className="link-btn" disabled={stage === 'opening'} onClick={() => void signIn()}>
        {stage === 'opening' ? 'Opening a window…' : `Sign in at ${offer.host} with your institution`}
      </button>
      {problem ? ` Could not open the window: ${problem}` : ''}
    </span>
  );
}
