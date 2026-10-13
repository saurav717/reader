import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ownerFetch } from '../lib/owner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart, SearchBox, card, cardHead, cardTitle, daysBetween, muted } from './AiUsage';
import LatexUsage from './LatexUsage';
import { ExternalIcon } from './icons';
const whole = (value) => Math.round(value).toLocaleString('en-US');
const hours = (seconds) => (seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`);
const money = (value, currency = 'USD') => value.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TONE = {
    running: 'var(--viz-1)',
    starting: 'var(--viz-2)',
    stopping: 'var(--viz-2)',
    stopped: 'var(--muted)',
    error: 'var(--danger)',
};
function StatusPill({ status }) {
    return (_jsxs("span", { style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            padding: '2px 9px',
            borderRadius: 999,
            border: '1px solid var(--border)',
            color: status === 'stopped' ? 'var(--muted)' : TONE[status],
            whiteSpace: 'nowrap',
        }, children: [_jsx("span", { style: { width: 7, height: 7, borderRadius: '50%', background: TONE[status] } }), status[0].toUpperCase() + status.slice(1)] }));
}
const linkButton = { display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' };
/** The overview, asked again when the page refreshes; null until the first answer. */
function useOverview(refreshedAt) {
    const [overview, setOverview] = useState(undefined);
    const load = useCallback(async () => {
        try {
            const response = await ownerFetch('/usage/gcloud');
            const answer = response.ok ? (await response.json()) : null;
            setOverview((before) => answer ?? before ?? null);
        }
        catch {
            setOverview((before) => before ?? null);
        }
    }, []);
    useEffect(() => {
        void load();
    }, [refreshedAt, load]);
    return [overview, load, setOverview];
}
export default function CloudUsage({ report, refreshedAt }) {
    const [overview, reload, setOverview] = useOverview(refreshedAt);
    const [busy, setBusy] = useState(null);
    const [failed, setFailed] = useState(null);
    const [query, setQuery] = useState('');
    const timers = useRef([]);
    useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
    /** Start or stop one service, then look again while Google brings it there. */
    const toggle = async (service) => {
        const action = service.status === 'running' || service.status === 'starting' ? 'stop' : 'start';
        if (action === 'stop') {
            const what = service.kind === 'cloudrun'
                ? `Stop ${service.name}? It is closed to the internet: everything that calls it (the LaTeX compiler, if it is this one) fails until you start it again.`
                : `Stop the VM ${service.name}? Whatever runs on it stops; its disk is kept.`;
            if (!window.confirm(what))
                return;
        }
        setBusy(service.id);
        setFailed(null);
        try {
            const response = await ownerFetch('/usage/gcloud/service', undefined, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: service.kind, id: service.id, action }),
            });
            const answer = (await response.json().catch(() => ({})));
            if (!response.ok || !answer.status)
                throw new Error(answer.error || `the proxy answered ${response.status}`);
            setOverview((before) => before ? { ...before, services: before.services?.map((one) => (one.id === service.id ? { ...one, status: answer.status } : one)) } : before);
            for (const wait of [4000, 12_000, 30_000])
                timers.current.push(window.setTimeout(() => void reload(), wait));
        }
        catch (error) {
            setFailed(`${service.name}: ${error.message}`);
        }
        finally {
            setBusy(null);
        }
    };
    const costs = overview?.costs;
    const currency = costs?.currency || overview?.billing?.currency || 'USD';
    const charges = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const all = costs?.charges ?? [];
        return needle ? all.filter((charge) => `${charge.day} ${charge.service} ${charge.sku} ${charge.type}`.toLowerCase().includes(needle)) : all;
    }, [costs, query]);
    if (overview === undefined)
        return _jsx("p", { style: { fontSize: 13, color: 'var(--muted)' }, children: "Asking Google Cloud\u2026" });
    if (overview === null)
        return (_jsxs(_Fragment, { children: [_jsx("p", { className: "banner error", children: "The proxy did not answer for Google Cloud. Try Refresh, or check the Worker is deployed with worker/gcloud.js." }), report ? _jsx(LatexUsage, { report: report, refreshedAt: refreshedAt }) : null] }));
    if (!overview.configured)
        return _jsx(NotConfigured, { report: report, refreshedAt: refreshedAt });
    const services = overview.services ?? [];
    const running = services.filter((service) => service.status === 'running').length;
    const requests = services.reduce((sum, service) => sum + (service.requests || 0), 0);
    const billing = overview.billing ?? {};
    const cell = { padding: '9px 12px', textAlign: 'right', whiteSpace: 'nowrap' };
    const head = { ...cell, fontWeight: 500, fontSize: 12.5, color: 'var(--muted)' };
    const rule = '1px solid var(--border-soft)';
    const tile = (label, value, note) => (_jsxs("div", { style: { ...card, padding: '14px 16px', flex: '1 1 200px', minWidth: 0 }, children: [_jsx("div", { style: { ...muted, fontSize: 12 }, children: label }), _jsx("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: value }), note ? _jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 4 }, children: note }) : null] }));
    const span = costs?.days?.length ? daysBetween(costs.days[0].day, costs.days[costs.days.length - 1].day).slice(-30) : [];
    const netByDay = new Map((costs?.days ?? []).map((day) => [day.day, day.net]));
    return (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: 'flex', gap: 12, flexWrap: 'wrap' }, children: [tile('Billing account', billing.error ? '—' : billing.name || 'None linked', billing.error ? (_jsx("span", { style: { color: 'var(--danger)' }, children: billing.error })) : (_jsxs(_Fragment, { children: [billing.id ? `${billing.id} · ` : '', _jsx("span", { style: { color: billing.enabled && billing.open !== false ? 'var(--viz-1)' : 'var(--danger)' }, children: billing.enabled ? (billing.open === false ? 'closed' : 'active') : 'billing off' })] }))), tile(`Cost this month${costs?.month ? ` · ${costs.month}` : ''}`, costs && !costs.error && costs.net !== undefined ? money(costs.net, currency) : '—', costs?.error ? (_jsx("span", { style: { color: 'var(--danger)' }, children: costs.error })) : costs ? (`${money(costs.cost || 0, currency)} charged, ${money(Math.abs(costs.credits || 0), currency)} in credits`) : ('set GCP_BILLING_EXPORT_TABLE to see cost')), tile('Services running', `${running} of ${services.length}`, `in ${overview.project}`), tile('Requests, 30 days', whole(requests), 'Cloud Run, as Cloud Monitoring counts them')] }), _jsxs("div", { style: { ...card, marginTop: 16, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }, children: [_jsxs("div", { style: { flex: '1 1 320px', fontSize: 13, lineHeight: 1.5 }, children: [_jsx("strong", { style: { fontWeight: 600 }, children: "Recharge your billing account." }), ' ', _jsxs("span", { style: { color: 'var(--muted)' }, children: ["Google takes payments only on its own page: Recharge opens the payment page for ", billing.name || 'your billing account', " in the Cloud console, where you can make a payment or add funds."] })] }), _jsxs("a", { className: "btn primary", href: billing.paymentUrl, target: "_blank", rel: "noreferrer", style: linkButton, "aria-disabled": !billing.paymentUrl, children: ["Recharge", _jsx(ExternalIcon, { size: 13 })] }), _jsxs("a", { className: "btn", href: billing.reportsUrl, target: "_blank", rel: "noreferrer", style: linkButton, children: ["Billing reports", _jsx(ExternalIcon, { size: 13 })] })] }), failed ? (_jsxs("p", { className: "banner error", style: { marginTop: 16 }, children: ["Could not change ", failed] })) : null, _jsxs("div", { style: { ...card, marginTop: 16 }, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "Services" }), _jsxs("span", { style: { ...muted }, children: ["Cloud Run services and Compute Engine VMs in ", overview.project] })] }), Object.entries(overview.errors ?? {}).map(([part, message]) => (_jsxs("p", { style: { ...muted, color: 'var(--danger)', margin: 0, padding: '8px 16px', borderBottom: rule }, children: [part === 'cloudrun' ? 'Cloud Run' : part === 'compute' ? 'Compute Engine' : 'Cloud Monitoring', ": ", message] }, part))), _jsx("div", { style: { overflowX: 'auto' }, children: _jsxs("table", { style: { borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { ...head, textAlign: 'left' }, children: "Service" }), _jsx("th", { style: { ...head, textAlign: 'left' }, children: "Status" }), _jsx("th", { style: { ...head, textAlign: 'left' }, children: "Where" }), _jsx("th", { style: head, children: "Requests (30 d)" }), _jsx("th", { style: head, children: "Instance time (30 d)" }), _jsx("th", { style: head })] }) }), _jsxs("tbody", { children: [services.map((service) => {
                                            const up = service.status === 'running' || service.status === 'starting';
                                            const moving = service.status === 'starting' || service.status === 'stopping';
                                            return (_jsxs("tr", { style: { borderTop: rule }, children: [_jsxs("td", { style: { ...cell, textAlign: 'left', whiteSpace: 'normal' }, children: [_jsx("div", { style: { fontWeight: 500 }, children: service.name }), _jsxs("div", { style: { ...muted, fontSize: 11.5 }, children: [service.type, service.detail ? ` · ${service.detail}` : ''] }), service.billing ? (_jsx("div", { style: { ...muted, fontSize: 11.5, color: service.billedIdle ? 'var(--danger)' : 'var(--viz-1)' }, children: service.billing })) : null] }), _jsx("td", { style: { ...cell, textAlign: 'left' }, children: _jsx(StatusPill, { status: service.status }) }), _jsx("td", { style: { ...cell, textAlign: 'left' }, children: service.location }), _jsx("td", { style: cell, children: service.kind === 'cloudrun' ? (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 8 }, children: [_jsx(Spark, { points: service.daily ?? [] }), whole(service.requests || 0)] })) : ('—') }), _jsx("td", { style: cell, children: service.kind === 'cloudrun' ? hours(service.instanceSeconds || 0) : '—' }), _jsxs("td", { style: { ...cell, display: 'flex', gap: 6, justifyContent: 'flex-end' }, children: [_jsx("button", { type: "button", className: up ? 'btn sm danger' : 'btn sm primary', onClick: () => void toggle(service), disabled: busy === service.id || moving || service.status === 'error', style: { minWidth: 62 }, children: busy === service.id ? '…' : moving ? (service.status === 'starting' ? 'Starting' : 'Stopping') : up ? 'Stop' : 'Start' }), _jsx("a", { className: "btn sm", href: service.consoleUrl, target: "_blank", rel: "noreferrer", style: linkButton, title: "Open in the Cloud console", children: _jsx(ExternalIcon, { size: 12 }) })] })] }, service.id));
                                        }), !services.length ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, style: { ...cell, textAlign: 'left', color: 'var(--muted)' }, children: "No Cloud Run services or VMs in this project." }) })) : null] })] }) }), _jsx("p", { style: { ...muted, fontSize: 11.5, margin: 0, padding: '10px 16px', borderTop: rule, lineHeight: 1.5 }, children: "A Cloud Run service that scales to zero needs no stopping: it is billed only while it serves a request. Stop closes one to the internet, so nothing can reach it (or run up its bill), and Start opens it again. A VM is billed while it runs: Stop it when it is idle; a stopped VM still pays for its disk." })] }), costs && !costs.error ? (_jsxs("div", { style: { ...card, marginTop: 16 }, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "Cost by service" }), _jsxs("span", { style: muted, children: [costs.month, ", after credits"] })] }), _jsxs("div", { className: "ai-usage-split", children: [_jsx("div", { className: "ai-usage-models", style: { padding: '6px 0' }, children: _jsx("table", { style: { borderCollapse: 'collapse', fontSize: 13, width: '100%' }, children: _jsxs("tbody", { children: [(costs.byService ?? []).map((row) => (_jsxs("tr", { children: [_jsx("td", { style: { ...cell, textAlign: 'left', padding: '7px 16px' }, children: row.service }), _jsxs("td", { style: { ...cell, padding: '7px 16px' }, children: [money(row.net, currency), row.credits ? _jsxs("div", { style: { ...muted, fontSize: 11 }, children: [money(row.cost, currency), " \u2212 credits"] }) : null] })] }, row.service))), !costs.byService?.length ? (_jsx("tr", { children: _jsx("td", { style: { ...cell, textAlign: 'left', color: 'var(--muted)', padding: '7px 16px' }, children: "Nothing charged this month." }) })) : null] }) }) }), _jsx("div", { style: { flex: 1, minWidth: 0, padding: '14px 16px' }, children: span.length ? (_jsx(BarChart, { title: `Cost per day, last ${span.length} days`, days: span, series: [{ label: 'Cost', color: 'var(--viz-1)', values: span.map((day) => Math.max(0, netByDay.get(day) || 0)) }], format: (value) => money(value, currency), axis: (value) => money(value, currency).replace(/\.00$/, ''), height: 150 })) : null })] })] })) : null, costs && !costs.error ? (_jsxs("div", { style: { ...card, marginTop: 16 }, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "Transactions" }), _jsxs("span", { style: muted, children: [charges.length === (costs.charges ?? []).length ? charges.length : `${charges.length} of ${(costs.charges ?? []).length}`, " charges and credits, newest first"] }), _jsx("span", { style: { flexGrow: 1 } }), _jsx(SearchBox, { value: query, onChange: setQuery, label: "Search service, item or date" })] }), _jsx("div", { style: { maxHeight: 420, overflow: 'auto' }, children: _jsxs("table", { style: { borderCollapse: 'collapse', fontSize: 13, width: '100%' }, children: [_jsx("thead", { children: _jsx("tr", { children: ['Date', 'Service', 'Item', 'Usage', 'Charge', 'Credits', 'Net'].map((title, index) => (_jsx("th", { style: { ...head, textAlign: index < 3 ? 'left' : 'right', position: 'sticky', top: 0, background: 'var(--surface)', borderBottom: rule }, children: title }, title))) }) }), _jsxs("tbody", { children: [charges.map((charge, index) => (_jsxs("tr", { style: { borderTop: index ? rule : undefined }, children: [_jsx("td", { style: { ...cell, textAlign: 'left' }, children: charge.day }), _jsx("td", { style: { ...cell, textAlign: 'left' }, children: charge.service }), _jsxs("td", { style: { ...cell, textAlign: 'left', whiteSpace: 'normal' }, children: [charge.sku, charge.type !== 'regular' ? _jsxs("span", { style: { ...muted, fontSize: 11 }, children: [" \u00B7 ", charge.type] }) : null] }), _jsx("td", { style: { ...cell, color: 'var(--muted)' }, children: charge.amount !== null ? `${+charge.amount.toPrecision(4)} ${charge.unit}` : '' }), _jsx("td", { style: cell, children: money(charge.cost, charge.currency) }), _jsx("td", { style: { ...cell, color: charge.credits ? 'var(--viz-1)' : 'var(--muted)' }, children: charge.credits ? money(charge.credits, charge.currency) : '—' }), _jsx("td", { style: { ...cell, fontWeight: 500 }, children: money(charge.cost + charge.credits, charge.currency) })] }, `${charge.day}-${charge.service}-${charge.sku}-${charge.type}-${index}`))), !charges.length ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, style: { ...cell, textAlign: 'left', color: 'var(--muted)' }, children: query ? `Nothing matches “${query}”.` : 'No charges in the last 90 days.' }) })) : null] })] }) }), _jsxs("p", { style: { ...muted, fontSize: 11.5, margin: 0, padding: '10px 16px', borderTop: rule, lineHeight: 1.5 }, children: ["From the billing export in BigQuery, a few hours behind Google\u2019s own count. Payments you made are on the", ' ', _jsx("a", { href: billing.paymentUrl, target: "_blank", rel: "noreferrer", children: "payment page" }), "."] })] })) : null, report ? _jsx(LatexUsage, { report: report, refreshedAt: refreshedAt }) : null] }));
}
/** A day-by-day line of a service's requests, small enough for a table cell. */
function Spark({ points }) {
    if (points.length < 2)
        return null;
    const width = 72;
    const height = 20;
    const top = Math.max(1, ...points.map((point) => point.n));
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${((index / (points.length - 1)) * width).toFixed(1)},${(height - 2 - (point.n / top) * (height - 4)).toFixed(1)}`).join(' ');
    return (_jsx("svg", { width: width, height: height, "aria-hidden": "true", style: { display: 'block' }, children: _jsx("path", { d: path, fill: "none", stroke: "var(--viz-1)", strokeWidth: 1.5, strokeLinejoin: "round" }) }));
}
function NotConfigured({ report, refreshedAt }) {
    return (_jsxs(_Fragment, { children: [_jsxs("div", { style: { ...card, padding: '16px 18px', fontSize: 13.5, lineHeight: 1.6 }, children: [_jsx("h3", { style: { ...cardTitle, marginBottom: 6 }, children: "Connect your Google Cloud project" }), _jsxs("p", { style: { margin: 0, color: 'var(--muted)' }, children: ["This tab reads your project as a service account. Give the Worker its key as the secret ", _jsx("code", { children: "GCP_SERVICE_ACCOUNT_KEY" }), ", and for cost and transactions name your billing export in ", _jsx("code", { children: "GCP_BILLING_EXPORT_TABLE" }), " \u2014 the steps are in docs/deploy.md, \u201CGoogle Cloud on the Usage page\u201D."] })] }), report ? _jsx(LatexUsage, { report: report, refreshedAt: refreshedAt }) : null] }));
}
