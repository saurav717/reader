/**
 * Highlights on the PDF's own pages.
 *
 * A highlight is a quote with its neighbours (see anchor.ts), made in either
 * mode, so the one store serves both: here each quote is looked for in the
 * whole PDF's text — every page's text-layer words run together, page after
 * page — and what is found is cut at the page breaks, so that a passage
 * running over onto the next page is marked on both.
 */
import { CONTEXT, resolveSelector } from './anchor';
/** Pages joined by a line break, which is no letter and so never part of a quote. */
export function pdfText(pages) {
    const starts = [];
    let text = '';
    pages.forEach((page, index) => {
        if (index)
            text += '\n';
        starts.push(text.length);
        text += page;
    });
    return { pages, starts, text };
}
/** Every highlight found in the PDF, by page number (1-based); the ones not found are left out. */
export function placeMarks(pdf, highlights) {
    const byPage = new Map();
    for (const highlight of highlights) {
        const at = resolveSelector(pdf, highlight);
        if (!at)
            continue;
        pdf.pages.forEach((page, index) => {
            const from = pdf.starts[index];
            const to = from + page.length;
            if (at.start >= to || at.end <= from)
                return;
            const mark = { highlight, start: Math.max(at.start, from) - from, end: Math.min(at.end, to) - from };
            if (mark.end <= mark.start)
                return;
            const list = byPage.get(index + 1) ?? [];
            list.push(mark);
            byPage.set(index + 1, list);
        });
    }
    return byPage;
}
/**
 * Selected text as a person would quote it: a word broken over a line
 * joined again, and every run of spaces and line breaks one space.
 */
export function readable(text) {
    return text
        .replace(/(\p{Ll})[-­]\s*\n\s*(\p{Ll})/gu, '$1$2')
        .replace(/\s+/g, ' ')
        .trim();
}
/** A selection on the pages, from `start` to `end` in the PDF's text, as the selector a highlight keeps. */
export function selectorIn(pdf, start, end, shown) {
    return {
        exact: readable(shown) || readable(pdf.text.slice(start, end)),
        prefix: readable(pdf.text.slice(Math.max(0, start - CONTEXT), start)),
        suffix: readable(pdf.text.slice(end, end + CONTEXT)),
        hint: start,
    };
}
/**
 * The boxes a range's words take up, made one box a line: pdf.js lays each
 * run of text in a span of its own, often with no span for the space between
 * words, and overlapping boxes would multiply into darker patches.
 */
export function mergeBoxes(boxes) {
    const sorted = boxes.filter((box) => box.width > 0.5 && box.height > 0.5).sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const box of sorted) {
        const line = lines.find((other) => {
            const overlap = Math.min(other.top + other.height, box.top + box.height) - Math.max(other.top, box.top);
            if (overlap < Math.min(other.height, box.height) * 0.5)
                return false;
            const gap = Math.max(box.left - (other.left + other.width), other.left - (box.left + box.width));
            return gap <= Math.min(other.height, box.height) * 0.8;
        });
        if (!line) {
            lines.push({ ...box });
            continue;
        }
        const right = Math.max(line.left + line.width, box.left + box.width);
        const bottom = Math.max(line.top + line.height, box.top + box.height);
        line.left = Math.min(line.left, box.left);
        line.top = Math.min(line.top, box.top);
        line.width = right - line.left;
        line.height = bottom - line.top;
    }
    return lines;
}
