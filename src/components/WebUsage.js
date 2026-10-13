import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ownerFetch } from '../lib/owner';
import { useEffect, useRef, useState } from 'react';
import { BarChart, card, cardHead, cardTitle, daysBetween, muted } from './AiUsage';
/**
 * What Tavily charges a credit bought past the plan's, in dollars: pay as
 * you go is $0.008 a credit (tavily.com/pricing, October 2026). A basic
 * search, which is what the Web button asks for, is one credit. The rate is
 * not in Tavily's usage answer, so it is here; a price change is a change
 * here.
 */
export const TAVILY_PAYGO_USD = 0.008;
/** How long an answer is good for before the page asks the Worker again. */
const ACCOUNT_MS = 60_000;
function useTavilyAccount(days, refreshedAt) {
    const [account, setAccount] = useState(null);
    const asked = useRef({ at: 0, days: 0 });
    useEffect(() => {
        if (asked.current.days === days && Date.now() - asked.current.at < ACCOUNT_MS)
            return;
        asked.current = { at: Date.now(), days };
        let cancelled = false;
        ownerFetch(`/usage/tavily?days=${days}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((answer) => !cancelled && answer && setAccount(answer))
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [days, refreshedAt]);
    return account;
}
const whole = (value) => value.toLocaleString('en-US');
/** Credits bought, as money at Tavily's pay-as-you-go rate: to the cent. */
const paygoCost = (credits) => `$${(credits * TAVILY_PAYGO_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** The rate itself, as Tavily prints it: $0.008, not rounded to a cent. */
const RATE = `$${TAVILY_PAYGO_USD}`;
const ago = (at) => {
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
};
export default function WebUsage({ report, days, refreshedAt }) {
    const tavily = useTavilyAccount(days, refreshedAt);
    const account = tavily?.configured ? tavily.account : null;
    // The tally's searches, per day over the period, and who made them.
    const span = daysBetween(report.since, report.until);
    const byDay = new Map();
    let searched = 0;
    for (const person of report.people) {
        let own = 0;
        for (const row of person.daily || []) {
            const n = Number(row.web) || 0;
            if (!n)
                continue;
            own += n;
            byDay.set(row.day, (byDay.get(row.day) || 0) + n);
        }
        if (own)
            searched += 1;
    }
    const total = Number(report.totals.web) || 0;
    const perDay = span.map((day) => byDay.get(day) || 0);
    // The plan's allowance, as a share: the number that says whether the month is running out.
    const limit = account?.planLimit ?? null;
    const share = account && limit ? Math.min(1, account.planUsage / limit) : null;
    const left = account && limit ? Math.max(0, limit - account.planUsage) : null;
    const tone = share === null ? 'var(--viz-1)' : share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)';
    // The free tier's thousand, or a paid plan's allowance: the label says which.
    const freeTier = !!account && (/free|researcher/i.test(account.plan) || (!!limit && limit <= 1000));
    // Pay as you go: on at Tavily or not, what it has bought this cycle, and what that cost at the rate above.
    const paygoOn = !!account && account.paygoUsage !== null;
    const paygo = account?.paygoUsage ?? 0;
    const paygoCap = account?.paygoLimit ?? null;
    const paygoShare = paygoOn && paygoCap ? Math.min(1, paygo / paygoCap) : null;
    // Tavily's own count of the key's credits each day, and the paid ones among them, over the period: the chart under the tally's, and the period's cost.
    const tavilyDays = new Map((tavily?.days || []).map((row) => [row.day, row]));
    const paidPerDay = span.map((day) => tavilyDays.get(day)?.paid || 0);
    const freePerDay = span.map((day, index) => Math.max(0, (tavilyDays.get(day)?.used || 0) - paidPerDay[index]));
    const paidInPeriod = paidPerDay.reduce((sum, n) => sum + n, 0);
    const tavilyInPeriod = paidInPeriod + freePerDay.reduce((sum, n) => sum + n, 0);
    const stat = (label, value, note) => (_jsxs("div", { children: [_jsx("div", { style: { ...muted, fontSize: 12 }, children: label }), _jsx("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: value }), note ? _jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 2 }, children: note }) : null] }));
    return (_jsxs("div", { style: { ...card, marginTop: 24 }, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "Web searches" }), _jsx("span", { style: { ...muted, fontSize: 12.5 }, children: "Ask AI\u2019s Web button, through this proxy" }), _jsx("span", { style: { flexGrow: 1 } }), account ? (_jsxs("span", { style: { ...muted, fontSize: 12 }, title: "Tavily is asked when this page is, at most every couple of minutes, and once an hour on its own", children: ["Tavily checked ", ago(account.at)] })) : null] }), _jsxs("div", { className: "ai-usage-split", children: [_jsxs("div", { className: "ai-usage-models", style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px' }, children: [stat('Searches this period', whole(total), searched ? `by ${searched} ${searched === 1 ? 'person' : 'people'}` : 'nobody has searched yet'), account ? (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsxs("div", { style: { ...muted, fontSize: 12 }, children: [freeTier ? 'Free credits used this cycle' : 'Plan credits used this cycle', account.plan ? ` · ${account.plan} plan` : ''] }), _jsxs("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: [whole(account.planUsage), limit ? _jsxs("span", { style: { ...muted, fontSize: 13, marginLeft: 4 }, children: ["of ", whole(limit), " credits"] }) : _jsx("span", { style: { ...muted, fontSize: 13, marginLeft: 4 }, children: "credits" })] }), share !== null ? (_jsx("div", { role: "meter", "aria-label": "Tavily credits used this cycle", "aria-valuemin": 0, "aria-valuemax": limit ?? undefined, "aria-valuenow": account.planUsage, title: `${Math.round(share * 100)}% of the plan’s credits used this cycle`, style: { height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }, children: _jsx("div", { style: { width: `${share * 100}%`, height: '100%', background: tone, borderRadius: 3 } }) })) : null, left !== null ? (_jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 6, ...(share !== null && share >= 0.9 ? { color: 'var(--danger)' } : {}) }, children: left
                                                    ? `${whole(left)} ${freeTier ? 'free ' : ''}left this month`
                                                    : paygoOn
                                                        ? `none left this month — every search is paid now, at ${RATE} a credit`
                                                        : 'none left this month — searches fail until the cycle turns, or pay as you go is turned on at Tavily' })) : null] }), _jsxs("div", { children: [_jsx("div", { style: { ...muted, fontSize: 12 }, children: "Pay as you go this cycle" }), paygoOn ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: [paygoCost(paygo), _jsxs("span", { style: { ...muted, fontSize: 13, marginLeft: 4 }, children: ["for ", whole(paygo), " ", paygo === 1 ? 'credit' : 'credits', paygoCap ? ` of a ${whole(paygoCap)} cap` : ''] })] }), paygoShare !== null ? (_jsx("div", { role: "meter", "aria-label": "Pay-as-you-go credits used this cycle, against the cap", "aria-valuemin": 0, "aria-valuemax": paygoCap ?? undefined, "aria-valuenow": paygo, title: `${Math.round(paygoShare * 100)}% of the pay-as-you-go cap used this cycle`, style: { height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }, children: _jsx("div", { style: { width: `${paygoShare * 100}%`, height: '100%', background: paygoShare >= 0.9 ? 'var(--danger)' : 'var(--viz-2)', borderRadius: 3 } }) })) : null, _jsxs("div", { style: { ...muted, fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }, children: [paygo
                                                                ? `Bought past the ${freeTier ? 'free' : 'plan’s'} credits, at ${RATE} each. `
                                                                : `Nothing bought yet: searches cost nothing until the ${freeTier ? 'free' : 'plan’s'} credits are gone, then ${RATE} each. `, paidInPeriod && days ? `Over the last ${days} days: ${whole(paidInPeriod)} paid ${paidInPeriod === 1 ? 'credit' : 'credits'}, ${paygoCost(paidInPeriod)}.` : ''] })] })) : (_jsxs("div", { style: { ...muted, fontSize: 11.5, marginTop: 4, lineHeight: 1.5 }, children: ["Off at Tavily, so nothing has been paid: past the ", freeTier ? 'free' : 'plan’s', " credits a search fails until the cycle turns. Turned on at app.tavily.com, the overflow costs ", RATE, " a credit and shows here."] }))] }), account.keyUsage !== account.planUsage + paygo ? (
                                    // More than one key on the account: this one's share, with the rest spent elsewhere. (The plan's count and the paid one together are the account's.)
                                    stat('This key', whole(account.keyUsage), `${whole(account.searches)} ${account.searches === 1 ? 'search' : 'searches'}${account.extracts ? `, ${whole(account.extracts)} page reads` : ''} by Tavily’s count`)) : (_jsxs("div", { style: { ...muted, fontSize: 11.5, marginTop: -8 }, children: [whole(account.searches), " ", account.searches === 1 ? 'search' : 'searches', account.extracts ? `, ${whole(account.extracts)} page reads` : '', " by Tavily\u2019s count"] }))] })) : null, tavily && !tavily.configured ? (_jsxs("div", { style: { ...muted, fontSize: 11.5, lineHeight: 1.5 }, children: ["Tavily\u2019s own numbers \u2014 the credits left this month \u2014 show here with ", _jsx("code", { children: "TAVILY_KEY" }), " set on the Worker."] })) : null, tavily?.error ? _jsxs("div", { style: { fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.5 }, children: ["Tavily did not answer: ", tavily.error] }) : null] }), _jsxs("div", { style: { padding: '14px 16px', minWidth: 0 }, children: [_jsx(BarChart, { title: `Searches ${whole(total)}`, days: span, series: [{ label: 'Searches', color: 'var(--viz-1)', values: perDay }], format: whole, axis: whole, height: paygoOn || tavilyInPeriod ? 150 : 200 }), account && (paygoOn || tavilyInPeriod) ? (
                            // Tavily's own count of the key, day by day, free and paid apart — so the free credits can be seen running out and the paid ones starting.
                            _jsx("div", { style: { marginTop: 14 }, children: _jsx(BarChart, { title: `Tavily credits ${whole(tavilyInPeriod)}${paidInPeriod ? ` · ${whole(paidInPeriod)} paid, ${paygoCost(paidInPeriod)}` : ''}`, days: span, series: [
                                        { label: freeTier ? 'Free' : 'Plan', color: 'var(--viz-1)', values: freePerDay },
                                        { label: 'Paid', color: 'var(--viz-2)', values: paidPerDay },
                                    ], format: whole, axis: whole, height: 130 }) })) : null, _jsxs("p", { style: { ...muted, fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 }, children: ["Each search the Web button made through this proxy, whoever made it; the services table says who. A page the model read is fetched by the proxy itself and costs nothing.", account ? ' Tavily’s count can run ahead of this one when a search was asked elsewhere on the same key, and its days begin when the proxy began asking it: earlier cycles are not reported.' : ''] })] })] })] }));
}
