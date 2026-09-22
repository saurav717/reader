import { useStore } from '../lib/store';
import { CheckIcon, CloudCheckIcon, GoogleMark, HighlighterIcon, SearchIcon } from './icons';

export default function Welcome({ onDismiss, onOpenSettings }: { onDismiss: () => void; onOpenSettings: () => void }) {
  const { user, driveConnected, signIn, connectDrive, settings, authError } = useStore();
  const configured = Boolean(settings.googleClientId);

  return (
    <div className="main" style={{ alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <div className="brand" style={{ width: 44, height: 44, fontSize: 25, marginBottom: 18 }}>
          R
        </div>
        <h1 style={{ margin: '0 0 8px', fontFamily: 'var(--serif)', fontSize: 34, fontWeight: 600, letterSpacing: '-0.014em' }}>
          Read papers, keep what matters
        </h1>
        <p style={{ margin: '0 0 26px', fontSize: 14, lineHeight: 1.6, color: 'var(--ink-2)' }}>
          Search arXiv, OpenAlex and Semantic Scholar, collect what you want to read, and highlight it. Connect
          Google Drive and every paper you add is saved to your own Drive with its highlights alongside.
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
          {!user ? (
            <button
              type="button"
              className="btn"
              disabled={!configured}
              onClick={() => void signIn()}
              style={{ height: 42, padding: '0 16px', fontSize: 14 }}
            >
              <GoogleMark size={18} /> Sign in with Google
            </button>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <CheckIcon size={16} style={{ color: 'var(--accent)' }} /> Signed in as {user.email}
            </span>
          )}

          {user && !driveConnected ? (
            <button type="button" className="btn primary" onClick={() => void connectDrive()} style={{ height: 42, padding: '0 16px', fontSize: 14 }}>
              <CloudCheckIcon size={18} /> Connect Google Drive
            </button>
          ) : null}

          {driveConnected ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--accent)' }}>
              <CheckIcon size={16} /> Drive connected
            </span>
          ) : null}

          <button type="button" className="btn ghost" onClick={onDismiss} style={{ height: 42, fontSize: 14 }}>
            {driveConnected ? 'Start reading' : 'Skip — keep everything local'}
          </button>
        </div>

        <p style={{ margin: '20px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          Signing in is optional. Without it the app still works — your library and highlights stay in this
          browser's storage and are never sent anywhere.
        </p>
      </div>
    </div>
  );
}
