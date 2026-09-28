// Home's views, and which of them it opens on. Kept in this browser: which
// view Home starts on is a preference of the desk you read at, like the
// library's layout.

export type HomeTab = 'continue' | 'today' | 'projects' | 'inbox';

export const HOME_TABS: HomeTab[] = ['continue', 'today', 'projects', 'inbox'];

export const TAB_LABEL: Record<HomeTab, string> = {
  continue: 'Continue reading',
  today: 'Today',
  projects: 'Projects',
  inbox: 'Inbox',
};

export const TAB_ABOUT: Record<HomeTab, string> = {
  continue: 'The page you stopped on, and what is in progress',
  today: 'A short plan from your library for this sitting',
  projects: 'Each collection, its papers by how far you are',
  inbox: 'Papers added since your last visit, not started yet',
};

export interface HomePrefs {
  /** The view Home opens on; `last` is whichever was showing last. */
  opensOn: HomeTab | 'last';
  /** The views shown as tabs. Continue reading always is. */
  tabs: HomeTab[];
  /** The view showing when Home was last left. */
  last: HomeTab;
}

const KEY = 'reader.home';
export const DEFAULT_HOME: HomePrefs = { opensOn: 'continue', tabs: [...HOME_TABS], last: 'continue' };

export function readHomePrefs(): HomePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<HomePrefs> | null;
    if (!raw) return DEFAULT_HOME;
    const tabs = Array.isArray(raw.tabs) ? HOME_TABS.filter((tab) => tab === 'continue' || raw.tabs!.includes(tab)) : DEFAULT_HOME.tabs;
    const opensOn = raw.opensOn === 'last' || HOME_TABS.includes(raw.opensOn as HomeTab) ? (raw.opensOn as HomePrefs['opensOn']) : 'continue';
    const last = HOME_TABS.includes(raw.last as HomeTab) ? (raw.last as HomeTab) : 'continue';
    return { opensOn, tabs, last };
  } catch {
    return DEFAULT_HOME;
  }
}

export function writeHomePrefs(prefs: HomePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not kept: Home opens on Continue reading next time.
  }
}

/** The view Home opens on, given what is shown as a tab. */
export function openingTab(prefs: HomePrefs): HomeTab {
  const wanted = prefs.opensOn === 'last' ? prefs.last : prefs.opensOn;
  return prefs.tabs.includes(wanted) ? wanted : 'continue';
}

const VISIT_AT = 'reader.visit.at';
const VISIT_BEFORE = 'reader.visit.before';

/** A visit begins: the one before it is what the Inbox counts from. */
export function startVisit(): void {
  try {
    const previous = localStorage.getItem(VISIT_AT);
    if (previous) localStorage.setItem(VISIT_BEFORE, previous);
    localStorage.setItem(VISIT_AT, new Date().toISOString());
  } catch {
    // Without it, the Inbox counts the last week.
  }
}

/** When the visit before this one began, if there was one. */
export function lastVisit(): string | null {
  try {
    return localStorage.getItem(VISIT_BEFORE);
  } catch {
    return null;
  }
}
