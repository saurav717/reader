import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { hasProxy } from '../lib/api';
import { prepare as prepareGoogle } from '../lib/google';
import { CheckIcon, CloudCheckIcon, GoogleMark, HighlighterIcon, SearchIcon } from './icons';

export default function Welcome({ onDismiss, onOpenSettings }: { onDismiss: () => void; onOpenSettings: () => void }) {
  const { user, driveConnected, driveRemembered, connectDrive, settings, authError } = useStore();
  const configured = Boolean(settings.googleClientId);
  // A visit that has connected before is reconnecting, not being introduced.
  const returning = driveRemembered && !driveConnected;

  // The script Google's popup needs, fetched while this page is being read
  // rather than inside the click — a popup opened after an awaited download
  // has lost the user gesture that allows it, and the browser blocks it.
  useEffect(() => {
    if (configured) prepareGoogle();
  }, [configured]);

  return (
    <div className="main" style={{ alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <div className="brand" style={{ width: 44, height: 44, fontSize: 25, marginBottom: 18 }}>
          R
        </div>
        <h1 style={{ margin: '0 0 8px', fontFamily: 'var(--serif)', fontSize: 34, fontWeight: 600, letterSpacing: '-0.014em' }}>
          {returning ? 'Reconnect your Drive' : 'Read papers, keep what matters'}
        </h1>
        <p style={{ margin: '0 0 26px', fontSize: 14, lineHeight: 1.6, color: 'var(--ink-2)' }}>
          {returning
            ? 'A sign-in lasts as long as the token Google gives it, about an hour, and this one has run out. One click reconnects, and Google will not ask again what you have already agreed to. Papers you add then go to your Drive as you collect them.'
            : 'Search arXiv, OpenAlex and Semantic Scholar, collect what you want to read, and highlight it. Sign in with Google and every paper you add is saved to your own Drive with its highlights alongside.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <SearchIcon size={18} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
              One search across three sources, or paste an arXiv id.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <HighlighterIcon size={18} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
              Four highlight colours with meanings, notes, and a Markdown export.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <CloudCheckIcon size={18} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
              A folder per collection in your Drive, holding the PDF and a JSON sidecar of your annotations.
            </p>
          </div>
        </div>

        {authError ? (
          <p className="banner error" style={{ marginBottom: 14 }}>
            {authError}
          </p>
        ) : null}

        {!configured ? (
          <p className="banner warn" style={{ marginBottom: 14 }}>
            Google sign-in needs an OAuth client ID first — it takes a minute in the Google Cloud Console.{' '}
            <button type="button" className="btn ghost sm" onClick={onOpenSettings} style={{ padding: 0, height: 'auto' }}>
              Add it in Settings
            </button>
            .
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {!driveConnected ? (
            // Identity and Drive are asked for together: signing in on its own
            // saves nothing, and the point of this screen is the saving.
            <button
              type="button"
              className="btn primary"
              disabled={!configured}
              onClick={() => void connectDrive()}
              style={{ height: 42, padding: '0 16px', fontSize: 14 }}
            >
              <GoogleMark size={18} />
              {returning ? 'Reconnect Google Drive' : user ? 'Connect Google Drive' : 'Sign in and connect Google Drive'}
            </button>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--accent)' }}>
              <CheckIcon size={16} /> Drive connected{user ? ` as ${user.email}` : ''}
            </span>
          )}

          <button type="button" className="btn ghost" onClick={onDismiss} style={{ height: 42, fontSize: 14 }}>
            {driveConnected ? 'Start reading' : 'Not now — keep everything in this browser'}
          </button>
        </div>

        {configured && !driveConnected && !hasProxy() ? (
          <p className="banner warn" style={{ marginTop: 14 }}>
            No paper proxy is set, so a PDF cannot be fetched and Drive would receive each paper's details
            without its file.{' '}
            <button type="button" className="btn ghost sm" onClick={onOpenSettings} style={{ padding: 0, height: 'auto' }}>
              Set one in Settings
            </button>
            .
          </p>
        ) : null}

        <p style={{ margin: '20px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          One consent covers both: your name and address, and the <code>drive.file</code> scope — which reaches
          only the files this app creates, never the rest of your Drive. It is still optional; without it the app
          works the same, with your library and highlights in this browser's storage alone, and this screen will
          ask again next time. Nothing is ever sent anywhere else.
        </p>
      </div>
    </div>
  );
}
