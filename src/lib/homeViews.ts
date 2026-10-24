// Home's views, and which of them it opens on. Kept in this browser: which
// view Home starts on is a preference of the desk you read at, like the
// library's layout.

export type HomeTab = 'search' | 'continue' | 'today' | 'projects' | 'inbox' | 'board';

export const HOME_TABS: HomeTab[] = ['search', 'continue', 'today', 'projects', 'inbox', 'board'];

export const TAB_LABEL: Record<HomeTab, string> = {
  search: 'Find papers',
  continue: 'Continue reading',
  today: 'Today',
  projects: 'Projects',
  inbox: 'Inbox',
  board: 'Collections',
};

export const TAB_ABOUT: Record<HomeTab, string> = {
  search: 'Search every source and save to a collection in one step',
  continue: 'The page you stopped on, and what is in progress',
  today: 'A short plan from your library for this sitting',
  projects: 'Each collection, its papers by how far you are',
  inbox: 'Papers added since your last visit, not started yet',
  board: 'Each collection as a column you add papers straight into',
};

export interface HomePrefs {
  /** The view Home opens on; `last` is whichever was showing last. */
  opensOn: HomeTab | 'last';
  /** The views shown as tabs. The one Home opens on always is. */
  tabs: HomeTab[];
  /** The view showing when Home was last left. */
  last: HomeTab;
  /** Put the library panel and the dock away on Home, and back on leaving it. */
  clearPanels: boolean;
  /** The collection Find papers saves to, when one has been picked. */
  saveTo?: string;
  /** Which shape of these this is: 2 brought Find papers and Collections. */
  v?: number;
}

const KEY = 'reader.home';
const VERSION = 2;
/** Projects is a tab to switch on: Collections shows the same papers, and can be added to. */
export const DEFAULT_HOME: HomePrefs = { opensOn: 'search', tabs: ['search', 'continue', 'today', 'inbox', 'board'], last: 'search', clearPanels: true, v: VERSION };

export function readHomePrefs(): HomePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<HomePrefs> | null;
    if (!raw) return DEFAULT_HOME;
    let tabs = Array.isArray(raw.tabs) ? HOME_TABS.filter((tab) => raw.tabs!.includes(tab)) : DEFAULT_HOME.tabs;
    let opensOn = raw.opensOn === 'last' || HOME_TABS.includes(raw.opensOn as HomeTab) ? (raw.opensOn as HomePrefs['opensOn']) : DEFAULT_HOME.opensOn;
    // Choices made before Find papers and Collections existed: both join the
    // tabs, and Home, left on the old default, opens on Find papers now.
    if ((raw.v ?? 1) < VERSION) {
      tabs = HOME_TABS.filter((tab) => tab === 'search' || tab === 'board' || tabs.includes(tab));
      if (opensOn === 'continue') opensOn = 'search';
    }
    if (opensOn !== 'last' && !tabs.includes(opensOn)) tabs = HOME_TABS.filter((tab) => tab === opensOn || tabs.includes(tab));
    if (!tabs.length) tabs = DEFAULT_HOME.tabs;
    const last = HOME_TABS.includes(raw.last as HomeTab) ? (raw.last as HomeTab) : tabs[0];
    return { opensOn, tabs, last, clearPanels: raw.clearPanels ?? true, saveTo: typeof raw.saveTo === 'string' ? raw.saveTo : undefined, v: VERSION };
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
  return prefs.tabs.includes(wanted) ? wanted : prefs.tabs[0] ?? 'search';
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
