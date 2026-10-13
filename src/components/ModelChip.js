import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ===========================================================================
//  Which model answers: a pill with the maker's mark and the model's name,
//  in the ask bars and under the Ask AI box. It opens a menu of every model
//  as cards — the one in use marked, the one that wrote the page noted,
//  those without a key greyed — the same cards the Rewrite menu shows, so
//  a model looks the same wherever it is chosen.
// ===========================================================================
import { useEffect, useRef, useState } from 'react';
import { MODELS, modelSpec, PROVIDERS } from '../lib/assistant';
/** A model's name without its maker: the mark on the pill already says who made it. */
export const shortModelName = (label) => label.replace(/^(Claude|Gemini|DeepSeek) /, '');
export default function ModelChip({ value, writer, keys, disabled, onChange, what = 'Answers with', up = false, align = 'right', view = 'grid', }) {
    const [open, setOpen] = useState(false);
    const box = useRef(null);
    const chosen = modelSpec(value);
    const ready = Boolean(keys[chosen.provider]);
    const writerSpec = writer ? modelSpec(writer) : undefined;
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!box.current?.contains(event.target))
                setOpen(false);
        };
        // Esc closes this, not the page behind it.
        const key = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener('mousedown', away);
        window.addEventListener('keydown', key, true);
        return () => {
            window.removeEventListener('mousedown', away);
            window.removeEventListener('keydown', key, true);
        };
    }, [open]);
    useEffect(() => {
        if (disabled)
            setOpen(false);
    }, [disabled]);
    const choose = (id) => {
        setOpen(false);
        onChange(id);
    };
    const tagsOf = (note) => note.split(' · ').map((tag) => (_jsx("span", { className: "rw-tag", children: tag }, tag)));
    const cardTitle = (m, can) => (can ? `Answer with ${m.label}` : `Add a ${PROVIDERS[m.provider].company} key in Settings to use ${m.label}`);
    return (_jsxs("div", { className: "menu-wrap model-chip-wrap", ref: box, children: [_jsxs("button", { type: "button", className: `model-chip p-${chosen.provider}${ready ? '' : ' is-keyless'}`, "aria-haspopup": "menu", "aria-expanded": open, disabled: disabled, onClick: () => setOpen((now) => !now), title: `${chosen.label} answers here${writerSpec && writerSpec.id !== chosen.id ? ` — ${writerSpec.label} wrote the page` : ''}${ready ? '' : ` · needs a ${PROVIDERS[chosen.provider].company} key in Settings`} · click to choose another`, children: [_jsx("span", { className: "rw-mark", "aria-hidden": "true", children: PROVIDERS[chosen.provider].name.slice(0, 1) }), _jsx("span", { className: "model-chip-name", children: shortModelName(chosen.label) }), _jsx("span", { className: "caret", "aria-hidden": "true", children: "\u25BE" })] }), open ? (_jsxs("div", { className: `menu rewrite-menu model-menu is-${view}${up ? ' up' : ''}${align === 'right' ? ' right' : ''}`, role: "menu", "aria-label": what, children: [_jsx("div", { className: "rw-head", children: _jsxs("span", { className: "rw-head-text", children: [_jsx("b", { children: what }), _jsx("span", { children: writerSpec ? `${writerSpec.label} wrote this page · any model with a key can answer for it` : 'Any model with a key · the conversation so far goes to it' })] }) }), view === 'grid' ? (_jsx("div", { className: "rw-grid", children: MODELS.map((m) => {
                            const isCurrent = m.id === chosen.id;
                            const can = Boolean(keys[m.provider]);
                            return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": isCurrent, className: `rw-card p-${m.provider}${isCurrent ? ' is-current' : ''}`, disabled: !can, onClick: () => choose(m.id), title: cardTitle(m, can), children: [_jsxs("span", { className: "rw-card-top", children: [_jsx("span", { className: "rw-mark", "aria-hidden": "true", children: PROVIDERS[m.provider].name.slice(0, 1) }), _jsx("span", { className: "rw-maker", children: PROVIDERS[m.provider].company }), isCurrent ? (_jsx("span", { className: "rw-current", title: "Answering now", "aria-label": "Answering now", children: "\u2713" })) : m.id === writerSpec?.id ? (_jsx("span", { className: "rw-wrote", title: "Wrote this page", children: "\u270E" })) : null] }), _jsx("b", { className: "rw-name", children: shortModelName(m.label) }), _jsx("span", { className: "rw-tags", children: can ? tagsOf(m.note) : _jsx("span", { className: "rw-tag rw-need", children: "Needs a key" }) })] }, m.id));
                        }) })) : (Object.keys(PROVIDERS).map((provider) => {
                        const models = MODELS.filter((m) => m.provider === provider);
                        if (!models.length)
                            return null;
                        const can = Boolean(keys[provider]);
                        return (_jsxs("div", { className: `rw-group p-${provider}`, role: "group", "aria-label": PROVIDERS[provider].company, children: [_jsxs("div", { className: "rw-provider", children: [_jsx("span", { className: "rw-mark", "aria-hidden": "true", children: PROVIDERS[provider].name.slice(0, 1) }), PROVIDERS[provider].company, can ? null : _jsx("span", { className: "rw-need", children: "Needs a key" })] }), models.map((m) => {
                                    const isCurrent = m.id === chosen.id;
                                    return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": isCurrent, className: `rw-model${isCurrent ? ' is-current' : ''}`, disabled: !can, onClick: () => choose(m.id), title: cardTitle(m, can), children: [_jsx("b", { className: "rw-name", children: shortModelName(m.label) }), _jsx("span", { className: "rw-tags", children: tagsOf(m.note) }), isCurrent ? (_jsx("span", { className: "rw-current", title: "Answering now", children: "\u2713" })) : m.id === writerSpec?.id ? (_jsx("span", { className: "rw-wrote", title: "Wrote this page", children: "\u270E" })) : null] }, m.id));
                                })] }, provider));
                    }))] })) : null] }));
}
