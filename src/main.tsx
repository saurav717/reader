import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StoreProvider } from './lib/store';
import { keepCompanionCompany } from './lib/appWindow';
import { installInviteClaim } from './lib/invites';
import { heldUser, restoredUser } from './lib/google';
import './styles.css';

// A deep link on a static host: the host's 404 page sent /reader/paper/<id>
// here as /reader/?route=/reader/paper/<id>; the address is put back before
// the app reads it, so the page it names opens and the bar shows it.
const route = new URLSearchParams(window.location.search).get('route');
if (route && route.startsWith(import.meta.env.BASE_URL)) window.history.replaceState(null, '', route);

// Opened by the Reader app: this window keeps the Companion running, and it shuts down with it.
keepCompanionCompany();

// Opened from someone's invite link (`?invite=`): kept for the welcome page, and taken up by the sign-in.
installInviteClaim(() => (heldUser() ?? restoredUser())?.name);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
