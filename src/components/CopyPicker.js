import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { versionLabel } from '../lib/locations';
import PdfDropIn from './PdfDropIn';
/**
 * Every copy of the paper, to read a different one.
 *
 * The reader shows the first copy that hands over a PDF, and a PDF is not
 * always the paper: a conference page links the poster, a repository has
 * the slides, the preprint is an older version than the one that was
 * published. So the copy on screen is a choice the person can overrule —
 * any other copy, fetched on its own; a browser in the pane for one behind
 * a sign-in or a check for a person; or a file of their own. Each copy
 * says what it answered when it was asked, so a copy that refused is not
 * picked blind.
 */
export default function CopyPicker({ locations, current, choice, notes, switching, onPick, onBrowse, onFile, onForget, onClose, }) {
    const panel = useRef(null);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        const onDown = (event) => {
            const target = event.target;
            if (panel.current?.contains(target) || target.closest('.copy-current'))
                return;
            onClose();
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', onDown);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', onDown);
        };
    }, [onClose]);
    useEffect(() => {
        panel.current?.querySelector('button.copy-option:not([disabled])')?.focus();
    }, []);
    return (_jsxs("div", { className: "copy-picker", ref: panel, role: "dialog", "aria-label": "Read a different copy of this paper", children: [_jsxs("p", { className: "eyebrow", children: [locations.length === 1 ? 'One copy' : `${locations.length} copies`, " of this paper \u2014 pick the one to read"] }), _jsx("ul", { children: locations.map((location) => {
                    const showing = location.url === current;
                    const note = notes[location.url];
                    const busy = switching === location.url;
                    return (_jsx("li", { children: _jsxs("button", { type: "button", className: `copy-option${showing ? ' showing' : ''}`, disabled: showing || Boolean(switching), onClick: () => onPick(location), title: location.url, children: [_jsxs("span", { className: "copy-name", children: [location.label, location.label !== location.host ? _jsx("span", { className: "copy-host", children: location.host }) : null] }), _jsxs("span", { className: "copy-tags", children: [_jsx("span", { className: location.isPdf ? 'loc-pdf' : 'loc-page', children: location.isPdf ? 'PDF' : 'page' }), location.version ? _jsx("span", { className: "loc-version", children: versionLabel(location.version) }) : null, showing ? _jsx("span", { className: "copy-state", children: "showing" }) : null, !showing && location.url === choice ? _jsx("span", { className: "copy-state", children: "your pick" }) : null, busy ? _jsx("span", { className: "spinner" }) : null] }), note && !showing ? _jsx("span", { className: `copy-note${note.doubtful ? ' doubtful' : ''}`, children: note.text }) : null] }) }, location.url));
                }) }), _jsxs("div", { className: "copy-more", children: [onBrowse ? (_jsxs("p", { children: [_jsx("button", { type: "button", className: "link-btn", onClick: onBrowse, children: "Browse to a copy here" }), ' ', "\u2014 for one behind a sign-in: a browser opens in this pane, at the site you pick."] })) : null, _jsx("p", { children: _jsx(PdfDropIn, { onFile: onFile }) }), onForget ? (_jsxs("p", { children: [_jsx("button", { type: "button", className: "link-btn", onClick: onForget, children: "Forget my pick" }), ' ', "\u2014 the next open tries every copy again, best first."] })) : null] })] }));
}
