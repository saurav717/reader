import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary, { FailureNote } from './components/ErrorBoundary';
import { StoreProvider } from './lib/store';
import { keepCompanionCompany } from './lib/appWindow';
import { installInviteClaim } from './lib/invites';
import { heldUser, restoredUser } from './lib/google';
import './styles.css';
import { reloadOnStaleBuild } from './lib/staleBuild';

reloadOnStaleBuild();

// A deep link on a static host: the site's 404 page (public/404.html) sent
// /paper/<id> here as /?route=/paper/<id>; the address is put back before
// the app reads it, so the page it names opens and the bar shows it.
const route = new URLSearchParams(window.location.search).get('route');
if (route && route.startsWith(import.meta.env.BASE_URL)) window.history.replaceState(null, '', route);

// Opened by the Reader app: this window keeps the Companion running, and it shuts down with it.
keepCompanionCompany();

// Opened from someone's invite link (`?invite=`): kept for the welcome page, and taken up by the sign-in.
installInviteClaim(() => (heldUser() ?? restoredUser())?.name);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error, retry) => (
        <div className="failure-page">
          <FailureNote error={error} title="Something on this page failed">
            <div className="failure-actions">
              <button type="button" className="btn primary" onClick={retry}>
                Try again
              </button>
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </FailureNote>
        </div>
      )}
    >
      <StoreProvider>
        <App />
      </StoreProvider>
    </ErrorBoundary>
  </StrictMode>,
);
