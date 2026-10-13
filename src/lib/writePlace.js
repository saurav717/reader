// Where the paper was last written, on this device: the LaTeX project, the
// file and the line — what the Write tab opens on again and what the paper
// card on the overview offers to continue. Kept in localStorage: only a
// convenience, and lost with it no harm is done.
const PLACE_KEY = (project) => `reader.write.${project}.place`;
const LINE_KEY = (project, file) => `reader.write.${project}.line:${file}`;
const HOME_KEY = (project) => `reader.write.${project}.home`;
export function lastPlace(project) {
    try {
        const place = JSON.parse(localStorage.getItem(PLACE_KEY(project)) || 'null');
        return place && typeof place.file === 'string' && typeof place.line === 'number' ? place : null;
    }
    catch {
        return null;
    }
}
/** The caret in a file, kept for the file and as the project's last place. */
export function rememberPlace(project, place) {
    try {
        localStorage.setItem(LINE_KEY(project, `${place.dir}|${place.file}`), String(place.line));
        localStorage.setItem(PLACE_KEY(project), JSON.stringify({ ...place, at: Date.now() }));
    }
    catch {
        // only a convenience
    }
}
/** The line a file was last left at, from 1; 0 for none. */
export function lineIn(project, dir, file) {
    try {
        return Number(localStorage.getItem(LINE_KEY(project, `${dir}|${file}`))) || 0;
    }
    catch {
        return 0;
    }
}
export function openWriteHome(project, ask = 'home') {
    try {
        sessionStorage.setItem(HOME_KEY(project), ask);
    }
    catch {
        // only a convenience
    }
}
export function takeWriteHome(project) {
    try {
        const asked = sessionStorage.getItem(HOME_KEY(project));
        sessionStorage.removeItem(HOME_KEY(project));
        return asked === 'home' || asked === 'overleaf' ? asked : null;
    }
    catch {
        return null;
    }
}
/**
 * "Not now" to connecting an Overleaf account, said for a project (or, with
 * `card`, to the paper card's suggestion): no nudge about it again on this
 * device, Sync and the card's buttons still there for when it is wanted.
 */
const NOT_NOW_KEY = (project, where) => `reader.write.${project}.notNow:${where}`;
export function notNow(project, where = 'desk') {
    try {
        localStorage.setItem(NOT_NOW_KEY(project, where), '1');
    }
    catch {
        // only a convenience
    }
}
export function saidNotNow(project, where = 'desk') {
    try {
        return localStorage.getItem(NOT_NOW_KEY(project, where)) === '1';
    }
    catch {
        return false;
    }
}
/** “3 min ago”, “2 h ago”, “4 Oct”. */
export function agoShort(at, now = Date.now()) {
    const minutes = Math.round((now - at) / 60000);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 7)
        return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
