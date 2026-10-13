import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// A block of code or commands to be copied — a server to start, a variable to
// set — with a Copy button on its corner that takes the whole of it at once,
// so nothing is lost to a selection that stopped a line short.
import { useEffect, useRef, useState } from 'react';
/** Copies text, with the clipboard API where the page may use it and the old way where it may not (an http page). */
export async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    }
    catch {
        // fall through to the old way
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let done = false;
    try {
        done = document.execCommand('copy');
    }
    catch {
        done = false;
    }
    area.remove();
    return done;
}
export default function CopyBlock({ code, className, label = 'Copy' }) {
    const [state, setState] = useState('idle');
    const timer = useRef(null);
    useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
    const copy = async () => {
        const ok = await copyText(code);
        setState(ok ? 'copied' : 'failed');
        if (timer.current !== null)
            window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState('idle'), 1600);
    };
    return (_jsxs("div", { className: "copy-block", children: [_jsx("pre", { className: className, children: code }), _jsx("button", { type: "button", className: `copy-block-btn${state === 'copied' ? ' is-done' : ''}`, onClick: () => void copy(), "aria-label": `${label} — the whole block`, title: "Copy the whole block", children: state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Select and copy' : label })] }));
}
