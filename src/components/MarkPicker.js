import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { HIGHLIGHT_COLORS } from '../types';
/** A plain underline. The colour is only kept because every mark has one; the line is black. */
export const UNDERLINE = { color: HIGHLIGHT_COLORS[0].id, style: 'underline' };
/** A highlight in a colour. */
export function highlightIn(color) {
    return { color, style: 'highlight' };
}
/**
 * The keys a live selection answers to: 1–4 highlight it in a colour, U draws
 * a black line under it, N highlights it and opens a note.
 * Returns whether the key was taken.
 */
export function markKey(event, onPick) {
    if (event.metaKey || event.ctrlKey || event.altKey)
        return false;
    const position = Number(event.key);
    if (position >= 1 && position <= HIGHLIGHT_COLORS.length) {
        onPick(highlightIn(HIGHLIGHT_COLORS[position - 1].id), false);
        return true;
    }
    const key = event.key.toLowerCase();
    if (key === 'u') {
        onPick(UNDERLINE, false);
        return true;
    }
    if (key === 'n') {
        onPick(highlightIn(HIGHLIGHT_COLORS[0].id), true);
        return true;
    }
    return false;
}
/** The four highlight colours, and the underline — one black line, no colour to pick. */
export default function MarkPicker({ onPick }) {
    return (_jsxs(_Fragment, { children: [HIGHLIGHT_COLORS.map((colour, position) => (_jsx("button", { type: "button", onMouseDown: (event) => event.preventDefault(), onClick: () => onPick(highlightIn(colour.id)), "aria-label": `Highlight: ${colour.label} (key ${position + 1})`, title: `Highlight — ${colour.label} — ${position + 1}`, children: _jsx("span", { className: "swatch", style: { background: colour.swatch } }) }, colour.id))), _jsx("button", { type: "button", className: "mark-style", onMouseDown: (event) => event.preventDefault(), onClick: () => onPick(UNDERLINE), "aria-label": "Underline (U)", title: "Underline \u2014 U", children: "U" })] }));
}
