import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StoreProvider } from './lib/store';
import './styles.css';

// A deep link on a static host: the host's 404 page sent /reader/paper/<id>
// here as /reader/?route=/reader/paper/<id>; the address is put back before
// the app reads it, so the page it names opens and the bar shows it.
const route = new URLSearchParams(window.location.search).get('route');
if (route && route.startsWith(import.meta.env.BASE_URL)) window.history.replaceState(null, '', route);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
