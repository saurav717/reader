export const CONTEXT = 32;
export function buildIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent)
                return NodeFilter.FILTER_REJECT;
            if (parent.closest('script, style, noscript'))
                return NodeFilter.FILTER_REJECT;
            return node.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    const nodes = [];
    let text = '';
    let current = walker.nextNode();
    while (current) {
        const start = text.length;
        text += current.data;
        nodes.push({ node: current, start, end: text.length });
        current = walker.nextNode();
    }
    return { text, nodes };
}
export function offsetOf(index, node, offset) {
    for (const entry of index.nodes) {
        if (entry.node === node)
            return entry.start + offset;
    }
    // The boundary can land on an element rather than a text node when the
    // selection ends just after the last character of a block.
    if (node.nodeType === Node.ELEMENT_NODE) {
        const child = node.childNodes[Math.max(0, offset - 1)];
        if (child) {
            for (const entry of index.nodes) {
                if (entry.node === child || child.contains(entry.node))
                    return entry.end;
            }
        }
    }
    return null;
}
export function offsetsFromRange(index, range) {
    const start = offsetOf(index, range.startContainer, range.startOffset);
    const end = offsetOf(index, range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start)
        return null;
    return { start, end };
}
export function selectorFromOffsets(index, start, end) {
    return {
        exact: index.text.slice(start, end),
        prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
        suffix: index.text.slice(end, Math.min(index.text.length, end + CONTEXT)),
        hint: start,
    };
}
function commonSuffixLength(a, b) {
    let count = 0;
    while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count])
        count += 1;
    return count;
}
function commonPrefixLength(a, b) {
    let count = 0;
    while (count < a.length && count < b.length && a[count] === b[count])
        count += 1;
    return count;
}
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const KEEP = /[\p{L}\p{N}]/u;
/** Letters and digits only, lower-cased, with where each came from. */
export function squash(text) {
    let out = '';
    const at = [];
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const expanded = LIGATURES[char] ?? char;
        for (const piece of expanded.normalize('NFKD')) {
            if (!KEEP.test(piece))
                continue;
            out += piece.toLowerCase();
            at.push(i);
        }
    }
    return { text: out, at };
}
/** The text last squashed, kept: every highlight of a paper is looked for in the same text. */
let squashed = null;
function squashOnce(text) {
    if (squashed?.source !== text)
        squashed = { source: text, flat: squash(text) };
    return squashed.flat;
}
/**
 * The quote found as letters and digits only — in the other mode's text, or
 * a new rendering of the same one — with its neighbours compared the same
 * way to choose between repeats.
 */
function resolveLoosely(text, selector) {
    const exact = squash(selector.exact).text;
    if (!exact)
        return null;
    const flat = squashOnce(text);
    const candidates = [];
    let at = flat.text.indexOf(exact);
    while (at !== -1 && candidates.length < 5000) {
        candidates.push(at);
        at = flat.text.indexOf(exact, at + 1);
    }
    if (!candidates.length)
        return null;
    const prefix = squash(selector.prefix).text;
    const suffix = squash(selector.suffix).text;
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
        const before = flat.text.slice(Math.max(0, candidate - prefix.length), candidate);
        const after = flat.text.slice(candidate + exact.length, candidate + exact.length + suffix.length);
        const start = flat.at[candidate];
        const score = (commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix)) * 1000 - Math.min(1000, Math.abs(start - selector.hint)) / 1000;
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return { start: flat.at[best], end: flat.at[best + exact.length - 1] + 1 };
}
/** Best match for a selector, or null when the quote is gone from the text. */
export function resolveSelector(index, selector) {
    const { text } = index;
    if (!selector.exact)
        return null;
    const candidates = [];
    let at = text.indexOf(selector.exact);
    while (at !== -1 && candidates.length < 500) {
        candidates.push(at);
        at = text.indexOf(selector.exact, at + 1);
    }
    if (!candidates.length)
        return resolveLoosely(text, selector);
    if (candidates.length === 1) {
        return { start: candidates[0], end: candidates[0] + selector.exact.length };
    }
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
        const before = text.slice(Math.max(0, candidate - CONTEXT), candidate);
        const after = text.slice(candidate + selector.exact.length, candidate + selector.exact.length + CONTEXT);
        const context = commonSuffixLength(before, selector.prefix) + commonPrefixLength(after, selector.suffix);
        // Context dominates; distance from the remembered offset only separates
        // otherwise identical candidates.
        const score = context * 1000 - Math.min(1000, Math.abs(candidate - selector.hint)) / 1000;
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return { start: best, end: best + selector.exact.length };
}
export function rangeFromOffsets(index, start, end) {
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    for (const entry of index.nodes) {
        if (!startNode && start >= entry.start && start < entry.end) {
            startNode = entry.node;
            startOffset = start - entry.start;
        }
        if (end > entry.start && end <= entry.end) {
            endNode = entry.node;
            endOffset = end - entry.start;
        }
    }
    if (!startNode || !endNode)
        return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
}
/**
 * Wrap every text node slice between two offsets in a <mark>. Splitting text
 * nodes invalidates the index, so callers rebuild it between highlights.
 */
export function paint(index, start, end, highlight) {
    const slices = [];
    for (const entry of index.nodes) {
        if (entry.end <= start || entry.start >= end)
            continue;
        slices.push({
            node: entry.node,
            from: Math.max(0, start - entry.start),
            to: Math.min(entry.node.data.length, end - entry.start),
        });
    }
    if (!slices.length)
        return false;
    for (const slice of slices) {
        let target = slice.node;
        if (slice.to < target.data.length)
            target.splitText(slice.to);
        if (slice.from > 0)
            target = target.splitText(slice.from);
        if (!target.data)
            continue;
        const mark = document.createElement('mark');
        mark.className = `hl hl-${highlight.color}${highlight.style === 'underline' ? ' hl-underline' : ''}`;
        mark.dataset.highlightId = highlight.id;
        if (highlight.note)
            mark.dataset.hasNote = 'true';
        target.parentNode?.replaceChild(mark, target);
        mark.appendChild(target);
    }
    return true;
}
export function unpaint(root, id) {
    const selector = id ? `mark.hl[data-highlight-id="${CSS.escape(id)}"]` : 'mark.hl';
    root.querySelectorAll(selector).forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent)
            return;
        while (mark.firstChild)
            parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
    });
}
/** Nearest preceding heading, used to group the notes rail by section. */
export function sectionFor(range, root) {
    let node = range.startContainer;
    const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4'));
    if (!headings.length)
        return undefined;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element)
        return undefined;
    let best;
    for (const heading of headings) {
        if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
            best = heading;
    }
    const text = best?.textContent?.trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 90) : undefined;
}
