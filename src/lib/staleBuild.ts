/**
 * The site was published again while this page was open: the page's code asks for a piece of the build it came
 * with (a terminal, a reader), and the new build no longer has it — Safari says "Importing a module script
 * failed", Chrome "Failed to fetch dynamically imported module". The page loads the new build once, which is
 * harmless: a project open in it joins its machine again as it opens (colab.ts joinIfRunning), so what runs
 * there carries on and is followed again.
 */

const STALE = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i;
const RELOADED_AT = 'reader.reloadedForBuild';

export const isStaleBuild = (error: unknown) => STALE.test(error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error));

/** The page loaded again for the new build — once a minute at most, so a piece missing for another reason can't loop. True when it is reloading. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Vite's own word for a piece that won't load, and any import that fails so: the new build, loaded. */
export function reloadOnStaleBuild() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (isStaleBuild(event.reason)) reloadForNewBuild();
  });
}
