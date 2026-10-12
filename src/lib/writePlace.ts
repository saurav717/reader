// Where the paper was last written, on this device: the LaTeX project, the
// file and the line — what the Write tab opens on again and what the paper
// card on the overview offers to continue. Kept in localStorage: only a
// convenience, and lost with it no harm is done.

export interface WritePlace {
  /** The LaTeX project's folder in the paper's folder ('' the top). */
  dir: string;
  /** The file, relative to the folder the desk is rooted at. */
  file: string;
  /** The caret's line, from 1. */
  line: number;
  /** When it was last written there (ms). */
  at: number;
}

const PLACE_KEY = (project: string) => `reader.write.${project}.place`;
const LINE_KEY = (project: string, file: string) => `reader.write.${project}.line:${file}`;
const HOME_KEY = (project: string) => `reader.write.${project}.home`;

export function lastPlace(project: string): WritePlace | null {
  try {
    const place = JSON.parse(localStorage.getItem(PLACE_KEY(project)) || 'null') as WritePlace | null;
    return place && typeof place.file === 'string' && typeof place.line === 'number' ? place : null;
  } catch {
    return null;
  }
}

/** The caret in a file, kept for the file and as the project's last place. */
export function rememberPlace(project: string, place: Omit<WritePlace, 'at'>) {
  try {
    localStorage.setItem(LINE_KEY(project, `${place.dir}|${place.file}`), String(place.line));
    localStorage.setItem(PLACE_KEY(project), JSON.stringify({ ...place, at: Date.now() }));
  } catch {
    // only a convenience
  }
}

/** The line a file was last left at, from 1; 0 for none. */
export function lineIn(project: string, dir: string, file: string): number {
  try {
    return Number(localStorage.getItem(LINE_KEY(project, `${dir}|${file}`))) || 0;
  } catch {
    return 0;
  }
}

/**
 * The next time the Write tab opens, it opens on its home — the LaTeX
 * projects, starting one — not where it was left; with `overleaf`, on
 * linking the paper to Overleaf: what the paper card's Overleaf links ask
 * for. Taken once.
 */
export type WriteHomeAsk = 'home' | 'overleaf';

export function openWriteHome(project: string, ask: WriteHomeAsk = 'home') {
  try {
    sessionStorage.setItem(HOME_KEY(project), ask);
  } catch {
    // only a convenience
  }
}

export function takeWriteHome(project: string): WriteHomeAsk | null {
  try {
    const asked = sessionStorage.getItem(HOME_KEY(project));
    sessionStorage.removeItem(HOME_KEY(project));
    return asked === 'home' || asked === 'overleaf' ? asked : null;
  } catch {
    return null;
  }
}

/** “3 min ago”, “2 h ago”, “4 Oct”. */
export function agoShort(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
