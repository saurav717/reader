/**
 * The browser's full screen, with Safari's prefixed names beside the standard
 * ones. The whole document goes full screen rather than the reading pane, so
 * the notes, Ask AI and every popover the reader opens come along.
 */
type Prefixed = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function canFullscreen(): boolean {
  const doc = document as Prefixed;
  return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function fullscreenElement(): Element | null {
  const doc = document as Prefixed;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export async function enterFullscreen(): Promise<void> {
  const root = document.documentElement as PrefixedElement;
  if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
  else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
  else throw new Error('Full screen is not available in this browser.');
}

export async function leaveFullscreen(): Promise<void> {
  const doc = document as Prefixed;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    // Already out of it.
  }
}
