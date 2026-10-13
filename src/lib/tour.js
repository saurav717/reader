/**
 * The guided tour: a walk round the app's pages and keys that starts on a
 * first sign-in, can be left at any step, and can be taken again from
 * Settings or the command palette (`startTour`). Whether it has been seen is
 * kept in this browser, in localStorage: a reload does not start it again.
 */
const TOUR_KEY = 'reader.tour';
/** The event that opens the tour from anywhere: Settings, the palette, a link. */
export const START_TOUR = 'reader:tour';
/** Whether the tour has been taken — or left — in this browser. */
export function tourSeen() {
    try {
        return localStorage.getItem(TOUR_KEY) === 'seen';
    }
    catch {
        // private mode: nothing to remember it by, so never offer it unasked
        return true;
    }
}
export function markTourSeen() {
    try {
        localStorage.setItem(TOUR_KEY, 'seen');
    }
    catch {
        // only a convenience
    }
}
/** Forgets that the tour was seen, so the next visit starts it again. */
export function forgetTour() {
    try {
        localStorage.removeItem(TOUR_KEY);
    }
    catch {
        // only a convenience
    }
}
export function startTour() {
    window.dispatchEvent(new CustomEvent(START_TOUR));
}
