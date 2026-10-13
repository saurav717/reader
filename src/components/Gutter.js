import { jsx as _jsx } from "react/jsx-runtime";
// A handle between two panes, dragged to share the room between them: the
// file tree and the editor, the editor and the side pane, the editor and the
// terminal below. A double click puts it back where it started.
import { useRef } from 'react';
export default function Gutter({ axis, label, className, onStart, onMove, onEnd, onReset }) {
    const from = useRef(null);
    return (_jsx("div", { className: `pg-gutter is-${axis}${className ? ` ${className}` : ''}`, role: "separator", "aria-orientation": axis === 'x' ? 'vertical' : 'horizontal', "aria-label": label, title: `${label} — drag; double-click to reset`, onPointerDown: (event) => {
            if (event.button !== 0)
                return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            from.current = axis === 'x' ? event.clientX : event.clientY;
            document.body.classList.add(axis === 'x' ? 'is-dragging-x' : 'is-dragging-y');
            onStart();
        }, onPointerMove: (event) => {
            if (from.current === null)
                return;
            onMove((axis === 'x' ? event.clientX : event.clientY) - from.current);
        }, onPointerUp: (event) => {
            if (from.current === null)
                return;
            from.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            document.body.classList.remove('is-dragging-x', 'is-dragging-y');
            onEnd?.();
        }, onDoubleClick: onReset }));
}
export const DEFAULT_LAYOUT = { tree: 252, side: 380, agent: 560, console: 32, sideLeft: false, big: null };
const LAYOUT_KEY = 'reader.pgLayout';
const clamp = (value, low, high, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback);
/** A layout read back: anything odd or out of range made sensible. */
export function readLayout(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return {
        tree: clamp(value.tree, 0, 600, DEFAULT_LAYOUT.tree),
        side: clamp(value.side, 260, 1400, DEFAULT_LAYOUT.side),
        agent: clamp(value.agent, 300, 1400, DEFAULT_LAYOUT.agent),
        console: clamp(value.console, 12, 88, DEFAULT_LAYOUT.console),
        sideLeft: value.sideLeft === true,
        big: value.big === 'console' || value.big === 'side' ? value.big : null,
    };
}
export function loadLayout() {
    try {
        return readLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'));
    }
    catch {
        return DEFAULT_LAYOUT;
    }
}
export function saveLayout(layout) {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    }
    catch {
        // private mode: the default next time
    }
}
/** The tree dragged narrower than this folds away. */
export const TREE_FOLD = 96;
