import { useEffect, useRef, useState } from 'react';
import { accessAvailable, finishSignIn, requestSignIn, waitForSignIn, type AccessStatus } from '../lib/access';
import type { SignInOffer } from '../lib/pdf';
import { closeViewer, openViewer } from '../lib/viewer';

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
 * When the proxy's screen is somewhere else — a Codespace's virtual desktop —
 * the status names where it can be watched, and the click that asks for the
 * window also opens that as a pop-up, so the sign-in happens in front of the
 * person all the same.
 *
 * Where the proxy cannot open a window — a Cloudflare Worker has no screen —
 * this says so instead, with what to run to get one.
 */
export default function SignInPrompt({ offer, onSignedIn }: Props) {
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const popup = useRef<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  useEffect(() => {
    let live = true;
    accessAvailable().then((status) => {
      if (live) setAccess(status);
    });
    return () => {
      live = false;
      waiting.current?.abort();
      closeViewer(popup.current);
    };
  }, []);

  const signIn = async () => {
    setStage('opening');
    setProblem(null);
    // The pop-up first, from the click, before anything is awaited: a window
    // opened later is one the browser blocks.
    if (access?.viewer) {
      popup.current = openViewer(access.viewer);
      setPopupBlocked(!popup.current);
    }
    try {
      await requestSignIn(offer.url);
    } catch (error) {
      setStage('failed');
      setProblem(error instanceof Error ? error.message : String(error));
      closeViewer(popup.current);
      popup.current = null;
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
    closeViewer(popup.current);
    popup.current = null;
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

  if (stage === 'open' && access.viewer) {
    return (
      <span className="sign-in-note">
        {' '}
        The proxy has opened {offer.host} in its own browser, on its screen
        {popupBlocked ? (
          <>
            {' '}
            — this page tried to show you that screen in a pop-up and the browser blocked it, so{' '}
            <a href={access.viewer} target="reader-proxy-screen">
              open the proxy&rsquo;s screen
            </a>{' '}
            yourself.
          </>
        ) : (
          <>
            , which is the pop-up beside this page (
            <a href={access.viewer} target="reader-proxy-screen">
              bring it back
            </a>
            ).
          </>
        )}{' '}
        Sign in there through your institution — the page, the password, the two-factor prompt, all of it
        happen in that window — and when the paper opens there, press this: the paper is fetched again through
        that signed-in browser.{' '}
        <button type="button" className="link-btn" onClick={() => void done()}>
          I have signed in
        </button>
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
