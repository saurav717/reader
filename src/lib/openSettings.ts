// Asking the app to open Settings from a page that has no handle on it, at a
// tab of its own and, if wanted, a place in that tab (an element's id). The
// app listens for the event (App.tsx) and hands the place to the Settings page.

/** The event the app listens for; its detail is a `SettingsPlace`, or nothing for the tab last open. */
export const OPEN_SETTINGS = 'reader:open-settings';

/** Every tab of the Settings page (components/Settings.tsx). */
export type SettingsTab =
  | 'account'
  | 'library'
  | 'git'
  | 'proxy'
  | 'ai'
  | 'reading'
  | 'appearance'
  | 'navigation'
  | 'projects'
  | 'writing'
  | 'citations'
  | 'compute'
  | 'updates'
  | 'help';

export type SettingsPlace = { tab?: SettingsTab; anchor?: string };

/** Settings, at `tab` and, inside it, the element whose id is `anchor`. */
export function openSettings(tab?: SettingsTab, anchor?: string) {
  window.dispatchEvent(new CustomEvent<SettingsPlace>(OPEN_SETTINGS, { detail: { tab, anchor } }));
}
