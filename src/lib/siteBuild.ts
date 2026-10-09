// The website's own version. Nothing of the site is installed: the Reader app
// is a window onto it, so a new build reaches everyone on the next load. A
// window left open keeps the build it loaded, though, so Settings → Updates
// compares it with build.json, which every build writes beside the page
// (vite.config.ts), and offers to reload when a newer one is published.

export interface SiteBuild {
  commit: string;
  time: string;
}

/** The build this page was loaded from. */
export const SITE_BUILD: SiteBuild = typeof __READER_BUILD__ === 'undefined' ? { commit: 'dev', time: '' } : __READER_BUILD__;

/** The build the site serves now, or null when it can't be read (offline, or a dev server). */
export async function publishedBuild(base = import.meta.env.BASE_URL): Promise<SiteBuild | null> {
  try {
    const response = await fetch(`${base}build.json`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<SiteBuild>;
    return typeof body.commit === 'string' && typeof body.time === 'string' ? { commit: body.commit, time: body.time } : null;
  } catch {
    return null;
  }
}

/** Whether `published` is a different, later build than `loaded`. */
export const isNewerBuild = (published: SiteBuild, loaded: SiteBuild = SITE_BUILD) => published.commit !== loaded.commit && published.time > loaded.time;
