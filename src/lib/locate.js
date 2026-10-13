/**
 * Finding a passage Claude quoted, in the page on screen.
 *
 * Claude copies the paper's words from the text the app extracted, but the
 * page it has to be found in differs in everything but the words: pdf.js
 * splits a line into spans with no space between them, a line break can
 * hyphenate a word, ligatures stand for two letters, quotes and dashes come
 * curly or straight. So both sides are compared as letters and digits only,
 * lower-cased, and every kept character remembers where it was in the page.
 *
 * A quote that is not there whole — Claude tidied a word, or it runs across
 * a figure — is found by its longest run of words that is.
 */
import { buildIndex, rangeFromOffsets, squash } from './anchor';
import { SHOW_CELL } from './notebookNav';
export { squash };
const words = (quote) => quote.split(/\s+/).map((word) => squash(word).text).filter(Boolean);
/**
 * Where the quote is in `haystack` (already squashed): the whole of it, or else
 * its longest run of at least four words. `[start, end)` in squashed offsets,
 * with how many of the quote's words it covers.
 */
export function findSquashed(haystack, quote) {
    const parts = words(quote).slice(0, 50);
    if (!parts.length)
        return null;
    const whole = parts.join('');
    const direct = haystack.indexOf(whole);
    if (direct >= 0)
        return { start: direct, end: direct + whole.length, words: parts.length, of: parts.length };
    const least = Math.min(4, parts.length);
    for (let size = parts.length - 1; size >= least; size--) {
        for (let from = 0; from + size <= parts.length; from++) {
            const run = parts.slice(from, from + size).join('');
            // A short run of short words is found everywhere; it has to say something.
            if (run.length < 16)
                continue;
            const at = haystack.indexOf(run);
            if (at >= 0)
                return { start: at, end: at + run.length, words: size, of: parts.length };
        }
    }
    return null;
}
/** The quote as a Range in `root`'s text, or null when it is not there. */
export function findPassage(root, quote) {
    const index = buildIndex(root);
    const flat = squash(index.text);
    const hit = findSquashed(flat.text, quote);
    if (!hit)
        return null;
    return rangeFromOffsets(index, flat.at[hit.start], flat.at[hit.end - 1] + 1);
}
/** Which page (1-based) of a PDF's page texts holds the quote, preferring the page Claude named. */
export function pageOf(pages, quote, hint) {
    let best = null;
    const order = hint && hint <= pages.length ? [hint - 1, ...pages.keys()] : [...pages.keys()];
    for (const index of order) {
        const hit = findSquashed(squash(pages[index]).text, quote);
        if (!hit)
            continue;
        if (hit.words === hit.of)
            return index + 1;
        if (!best || hit.words > best.words)
            best = { page: index + 1, words: hit.words };
    }
    return best?.page ?? null;
}
/** Sent by the reader when a passage is marked (its quote) and when the mark goes (null). */
export const FLASH_EVENT = 'reader:passage-flash';
export const LOCATE_EVENT = 'reader:locate';
let explainLocator = null;
/** Set by the Explain page while it is open; returns the function that takes it away again. */
export function setExplainLocator(locate) {
    explainLocator = locate;
    return () => {
        if (explainLocator === locate)
            explainLocator = null;
    };
}
let notebookLocator = null;
let heldPassage = null;
/** Set by the notebook page while it is open; returns the function that takes it away again. */
export function setNotebookLocator(locate) {
    notebookLocator = locate;
    return () => {
        if (notebookLocator === locate)
            notebookLocator = null;
    };
}
/** A passage asked for while the Colab tab was not open, taken by the notebook page as it mounts. */
export function takeHeldPassage() {
    const held = heldPassage;
    heldPassage = null;
    return held;
}
async function showInNotebook(request) {
    if (notebookLocator)
        return notebookLocator(request);
    if (!document.querySelector('.explain'))
        return { found: false, reason: 'Open the paper’s Explain page, and its Colab tab, to see the notebook.' };
    return new Promise((resolve) => {
        heldPassage = { request, reply: resolve };
        window.dispatchEvent(new CustomEvent(SHOW_CELL, { detail: { cell: request.cell ?? 1 } }));
        // The tab did not open — the paper has no notebook, or the page did not listen.
        window.setTimeout(() => {
            if (heldPassage?.request !== request)
                return;
            heldPassage = null;
            resolve({ found: false, reason: 'The Colab tab did not open. Open it to see the notebook.' });
        }, 5000);
    });
}
/** Asks the open paper — or its Explain page, or the notebook on its Colab tab — to scroll to the passage and mark it. Answers once it has, or could not. */
export async function showPassage(request) {
    if (request.source === 'notebook')
        return showInNotebook(request);
    if (explainLocator) {
        const shown = await explainLocator(request);
        if (shown)
            return shown;
    }
    return new Promise((resolve) => {
        const event = new CustomEvent(LOCATE_EVENT, { detail: { ...request, reply: resolve }, cancelable: true });
        // Nobody took it: no paper is open.
        if (window.dispatchEvent(event))
            resolve({ found: false, reason: 'Open the paper to see it.' });
    });
}
