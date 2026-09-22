/**
 * The proxy's screen, when it is not the one in front of the person.
 *
 * A sign-in or a captcha opens a real browser window on the machine the
 * proxy runs on. On a laptop that machine is this one and the window simply
 * appears; in a GitHub Codespace, or on any other remote machine with a
 * virtual desktop, the proxy names where that desktop can be watched — a
 * noVNC page — and this opens it as a pop-up beside the app, so the person
 * signs in through it from wherever they are.
 *
 * The pop-up has to be opened from the click itself: browsers block one
 * opened after an `await`, since by then nothing ties it to the person.
 */

/** The name shared by every pop-up, so a second sign-in reuses the first window. */
const NAME = 'reader-proxy-screen';

/** Open the proxy's screen as a pop-up. Null when the browser blocked it. */
export function openViewer(url: string): Window | null {
  const width = Math.min(1200, Math.max(720, Math.round(window.screen.availWidth * 0.7)));
  const height = Math.min(860, Math.max(560, Math.round(window.screen.availHeight * 0.8)));
  const left = Math.max(0, Math.round((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.round((window.screen.availHeight - height) / 2));
  try {
    const popup = window.open(url, NAME, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
    return popup && !popup.closed ? popup : null;
  } catch {
    return null;
  }
}

/** Close a pop-up this page opened, once the window on the proxy has gone. */
export function closeViewer(popup: Window | null): void {
  try {
    if (popup && !popup.closed) popup.close();
  } catch {
    // A window the person navigated elsewhere is no longer ours to close.
  }
}
