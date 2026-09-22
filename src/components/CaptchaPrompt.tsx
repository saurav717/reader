import { useEffect, useRef, useState } from 'react';
import { captchaStatus, finishCaptcha, showCaptcha, waitForCaptcha, type CaptchaStatus } from '../lib/scholar';

interface Props {
  /** The Scholar page that was refused, which is the page the captcha is on. */
  url: string;
  /** Called once the window has closed: the caller asks Scholar again. */
  onSolved: () => void;
}

type Stage = 'idle' | 'opening' | 'open' | 'failed';

/**
 * The offer to be shown the captcha, where Google Scholar answered with one.
 *
 * One button opens a real browser window — on the proxy's machine, which is
 * this one when the proxy is `npm start` — at the very page Scholar refused,
 * captcha and all. The person solves it there. Scholar sends the window on to
 * the results the moment it accepts the answer, the proxy notices and closes
 * the window, and the caller asks the same question again — this time
 * through the browser that solved it, which is what Scholar now trusts.
 *
 * Where the proxy cannot open a window — a Cloudflare Worker has no screen —
 * this says so instead, with what to run to get one.
 */
export default function CaptchaPrompt({ url, onSolved }: Props) {
  const [status, setStatus] = useState<CaptchaStatus | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    captchaStatus().then((answer) => {
      if (live) setStatus(answer);
    });
    return () => {
      live = false;
      waiting.current?.abort();
    };
  }, []);

  const show = async () => {
    setStage('opening');
    setProblem(null);
    try {
      await showCaptcha(url);
    } catch (error) {
      setStage('failed');
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    setStage('open');
    const controller = new AbortController();
    waiting.current = controller;
    try {
      await waitForCaptcha(controller.signal);
    } catch {
      return; // unmounted
    }
    waiting.current = null;
    setStage('idle');
    onSolved();
  };

  const done = async () => {
    await finishCaptcha();
    // The poll notices the window is closed on its next turn; this only
    // shortens the wait.
  };

  if (!status) return null;

  if (!status.available) {
    return (
      <span className="sign-in-note">
        {' '}
        The proxy could show you the captcha to solve, but this one cannot open a browser window. {status.reason}
      </span>
    );
  }

  if (stage === 'open') {
    return (
      <span className="sign-in-note">
        {' '}
        A browser window has opened at Google Scholar. Solve the captcha there; the window closes on its own the
        moment Scholar accepts it, and the search runs again.{' '}
        <button type="button" className="link-btn" onClick={() => void done()}>
          I have solved it
        </button>
      </span>
    );
  }

  return (
    <span className="sign-in-note">
      {' '}
      <button type="button" className="link-btn" disabled={stage === 'opening'} onClick={() => void show()}>
        {stage === 'opening' ? 'Opening a window…' : 'Show me the captcha'}
      </button>
      {problem ? ` Could not open the window: ${problem}` : ''}
    </span>
  );
}
