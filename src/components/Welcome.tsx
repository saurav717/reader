import { useEffect, useRef, useState } from 'react';
import { KoiosMark, pickScene, ScenePlate } from './NightScene';
import { basePath, currentAddress, placeFor } from '../lib/route';
import { useStore } from '../lib/store';
import { captchaSiteKey, hasProxy, setCaptchaAnswer } from '../lib/api';
import { prepare as prepareGoogle, SIGN_IN_REQUIRED } from '../lib/google';
import { CheckIcon, GoogleMark } from './icons';
import { linkGreeting, pendingInvite, type Greeting } from '../lib/invites';
import { initials } from '../lib/presence';
import { openSettings } from '../lib/openSettings';

export default function Welcome({ onDismiss }: { onDismiss: () => void }) {
  const { user, driveConnected, driveRemembered, signingInSilently, connectDrive, settings, authError } = useStore();
  const configured = Boolean(settings.googleClientId);
  // A visit that has connected before is reconnecting, not being introduced.
  const returning = driveRemembered && !driveConnected;
  // On the site, signing in with Google is the one way in: no "Not now"
  // until there is someone signed in. See SIGN_IN_REQUIRED.
  const mustSignIn = SIGN_IN_REQUIRED && configured && !user;

  // The proxy's captcha, when it wants one (see TURNSTILE_SITE_KEY in
  // wrangler.toml): the sign-in button waits until it is solved.
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [solved, setSolved] = useState(false);
  const signingIn = configured && !user;
  useEffect(() => {
    if (!signingIn) return;
    let live = true;
    void captchaSiteKey().then((key) => {
      if (live) setSiteKey(key);
    });
    return () => {
      live = false;
    };
  }, [signingIn]);
  const waitingOnCaptcha = signingIn && Boolean(siteKey) && !solved;

  // Opened from a project's invitation (`?room=…&for=…`): for one account, which the link does not name.
  const [invited] = useState(() => (typeof window === 'undefined' ? false : Boolean(placeFor(currentAddress())?.join)));
  // Opened from someone's invite link (`?invite=`): who asked, and their note, over the page everyone sees.
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  useEffect(() => {
    const token = pendingInvite();
    if (!token) return;
    let live = true;
    void linkGreeting(token)
      .then((said) => live && !said.expired && setGreeting(said))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The script Google's popup needs, fetched while this page is being read
  // rather than inside the click — a popup opened after an awaited download
  // has lost the user gesture that allows it, and the browser blocks it.
  useEffect(() => {
    if (configured) prepareGoogle();
  }, [configured]);

  // The opening screen keeps the scene the loading screen stood on — the same
  // picture, as a plate in the middle, the same words under it — and under
  // them the way in. The rail stays away until someone is in (App.tsx).
  const scene = pickScene();

  return (
    <div className="main night night-scene is-welcome is-centred">
      <div className="night-mark is-centred">
        <KoiosMark />
        <span>koios</span>
      </div>
      <ScenePlate scene={scene} />
      <div className="night-copy is-centred">
        <h1>
          {scene.headline[0]}
          <br />
          {scene.headline[1]}
        </h1>
        <p className="night-intro">{scene.intro}</p>
      <div className="night-signin">
        {invited && !user ? (
          <div className="welcome-greeting">
            <span className="pj-av is-lg" style={{ background: '#8a3a6e' }}>
              ✉
            </span>
            <div>
              <b>You’re invited to a project</b>
              <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
                Sign in with Google as the account the invitation was emailed to, and the project opens. Signed in as anyone else, the link says so and opens nothing.
              </p>
            </div>
          </div>
        ) : null}
        {greeting ? (
          <div className="welcome-greeting">
            <span className="pj-av is-lg" style={{ background: '#1f5e52' }}>
              {initials(greeting.byName)}
            </span>
            <div>
              <b>{greeting.byName} invited you to Reader</b>
              {greeting.note ? <blockquote>{greeting.note}</blockquote> : null}
            </div>
          </div>
        ) : null}
        <p className="night-why">
          {returning
            ? 'Your sign-in has run out, as Google’s do after about an hour. One click reconnects your Drive, and Google will not ask again what you have already agreed to.'
            : 'Sign in with Google and your library lives in your own Drive: every paper, its highlights and your collections, the same from any browser.'}
        </p>

        {authError ? (
          <p className="banner error" style={{ marginBottom: 14 }}>
            {authError}
          </p>
        ) : null}

        {!configured ? (
          <p className="banner warn" style={{ marginBottom: 14 }}>
            Google sign-in needs an OAuth client ID first — it takes a minute in the Google Cloud Console.{' '}
            <button type="button" className="btn ghost sm" onClick={() => openSettings('account', 'settings-client-id')} style={{ padding: 0, height: 'auto' }}>
              Add it in Settings
            </button>
            .
          </p>
        ) : null}

        {signingIn && siteKey ? <Captcha siteKey={siteKey} onSolved={setSolved} /> : null}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {signingInSilently ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-2)' }}>
              <span className="spinner" aria-hidden="true" /> Signing you in…
            </span>
          ) : !driveConnected ? (
            // Identity and Drive are asked for together: signing in on its own
            // saves nothing, and the point of this screen is the saving.
            <button
              type="button"
              className="btn primary"
              disabled={!configured || waitingOnCaptcha}
              title={waitingOnCaptcha ? 'Tick the box above first' : undefined}
              onClick={() => void connectDrive()}
              style={{ height: 42, padding: '0 16px', fontSize: 14 }}
            >
              <GoogleMark size={18} />
              {returning ? 'Reconnect Google Drive' : user ? 'Connect Google Drive' : 'Sign in with Google'}
            </button>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--accent)' }}>
              <CheckIcon size={16} /> Drive connected{user ? ` as ${user.email}` : ''}
            </span>
          )}

          {mustSignIn ? null : (
            <button type="button" className="btn ghost" onClick={onDismiss} style={{ height: 42, fontSize: 14 }}>
              {driveConnected ? 'Start reading' : 'Not now — keep everything in this browser'}
            </button>
          )}
        </div>

        {configured && !driveConnected && !hasProxy() ? (
          <p className="banner warn" style={{ marginTop: 14 }}>
            No paper proxy is set, so a PDF cannot be fetched and Drive would receive each paper's details
            without its file.{' '}
            <button type="button" className="btn ghost sm" onClick={() => openSettings('proxy')} style={{ padding: 0, height: 'auto' }}>
              Set one in Settings
            </button>
            .
          </p>
        ) : null}

        <p style={{ margin: '20px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          One consent covers both: your name and address, and the <code>drive.file</code> scope — which reaches
          only the files this app creates, never the rest of your Drive.{' '}
          {mustSignIn
            ? 'Signing in with Google is the way in.'
            : "Without signing in the app works the same, with a library in this browser that belongs to no account; signing in opens your own, from your Drive."}{' '}
          What the app does with your data, and what it never sees, is on its{' '}
          <a href={`${basePath()}privacy/`} style={{ color: 'inherit' }}>
            privacy policy
          </a>
          ; the <a href={`${basePath()}terms/`} style={{ color: 'inherit' }}>terms</a> are beside it.
        </p>
      </div>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoading: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  turnstileLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileLoading = null;
      reject(new Error('The captcha could not load.'));
    };
    document.head.appendChild(script);
  });
  return turnstileLoading;
}

/**
 * Cloudflare Turnstile's box — the check that whoever signs in is a person.
 * Its answer goes to the proxy with the sign-in (setCaptchaAnswer) and is
 * checked there; this only draws it and says when it has an answer.
 */
export function Captcha({ siteKey, onSolved }: { siteKey: string; onSolved: (solved: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let widget: string | null = null;
    let live = true;
    const answered = (answer: string | null) => {
      setCaptchaAnswer(answer);
      onSolved(Boolean(answer));
    };
    // A fresh box is an unticked one, whatever an earlier box said.
    onSolved(false);
    loadTurnstile()
      .then(() => {
        if (!live || !box.current || !window.turnstile) return;
        widget = window.turnstile.render(box.current, {
          sitekey: siteKey,
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
          callback: (answer: string) => answered(answer),
          'expired-callback': () => answered(null),
          'error-callback': () => answered(null),
        });
      })
      .catch((error: Error) => {
        if (live) setProblem(error.message);
      });
    // The answer outlives the box: the box goes the moment the sign-in lands,
    // and the answer is what that sign-in then hands the proxy.
    return () => {
      live = false;
      if (widget && window.turnstile) window.turnstile.remove(widget);
    };
  }, [siteKey, onSolved]);

  return (
    <div style={{ marginBottom: 14 }}>
      <div ref={box} />
      {problem ? <p className="banner error">{problem} Reload the page to try again.</p> : null}
    </div>
  );
}
