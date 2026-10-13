import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { authorDetails, profilesElsewhere, resolveReference, scholarProfile, worksUnderName, } from '../lib/hoverInfo';
import { venueDetails } from '../lib/venueInfo';
import { scholarAuthorUrl, scholarPaperUrl } from '../lib/locations';
import { parseReference } from '../lib/citations';
import { hasProxy } from '../lib/api';
import { rolesOnPaper, whereTheyAre } from '../lib/byline';
import { readContributions } from '../lib/contributions';
import { ExternalIcon, SearchIcon } from './icons';
const WIDTH = 380;
const GAP = 8;
/**
 * Ask the Discover panel to search for something — a paper's title, or
 * `author:` a person. `open` is the title of the paper wanted, whose result
 * is opened to show its details once the search is in.
 */
export function discover(query, open) {
    window.dispatchEvent(new CustomEvent('reader:discover', { detail: { query, open } }));
}
const compact = (value) => value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
        ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
        : String(value);
const yearOf = (published) => /^\d{4}/.exec(published || '')?.[0] ?? '';
const byline = (authors) => authors.length > 4 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', ');
/**
 * The card that opens over an author's name or a citation. It is placed
 * under what it points at, or over it when there is no room below, and kept
 * inside the window; it follows no scrolling — a scroll closes it.
 */
export default function HoverCard({ target, paper, onEnter, onLeave, onClose, onJump }) {
    const box = useRef(null);
    const [place, setPlace] = useState({ top: -9999, left: -9999, above: false });
    // Placed once it can be measured, and again as what it says arrives and
    // it grows — a card shown over its anchor grows upwards, away from it.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element)
            return;
        const measure = () => {
            const { anchor } = target;
            const width = Math.min(WIDTH, window.innerWidth - 24);
            const height = element.offsetHeight;
            const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + anchor.width / 2 - width / 2));
            const room = window.innerHeight - anchor.bottom - GAP - 12;
            const above = room < height && anchor.top - GAP - 12 > room;
            const top = above ? Math.max(12, anchor.top - GAP - height) : Math.max(12, Math.min(anchor.bottom + GAP, window.innerHeight - height - 12));
            setPlace((current) => (current.top === top && current.left === left && current.above === above ? current : { top, left, above }));
        };
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(element);
        return () => observer?.disconnect();
    }, [target]);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (_jsx("div", { ref: box, className: `hover-card${place.above ? ' above' : ''}`, role: "dialog", "aria-label": target.kind === 'author' ? `About ${target.name}` : target.kind === 'venue' ? `About ${target.venue}` : 'The cited paper', style: { top: place.top, left: place.left, width: Math.min(WIDTH, window.innerWidth - 24) }, onMouseEnter: onEnter, onMouseLeave: onLeave, children: target.kind === 'author' ? (_jsx(AuthorCard, { name: target.name, position: target.position, paper: paper, onPaper: target.onPaper, byline: target.byline })) : target.kind === 'venue' ? (_jsx(VenueCard, { venue: target.venue, paper: paper })) : (_jsx(CiteCard, { entries: target.entries, onJump: onJump })) }));
}
/** A promise's answer as state: undefined while it is being asked. */
function useAnswer(ask, key) {
    const [answer, setAnswer] = useState(null);
    useEffect(() => {
        let live = true;
        ask()
            .then((value) => live && setAnswer({ key, value }))
            .catch(() => live && setAnswer({ key, value: null }));
        return () => {
            live = false;
        };
        // The key says when the question has changed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return answer?.key === key ? answer.value : undefined;
}
// --------------------------------------------------------------- author ---
function WhereTheyAre({ where, asking }) {
    const { now, then } = where;
    if (!now && !then && !asking)
        return null;
    return (_jsxs("dl", { className: "hc-where", "aria-label": "Where they are", children: [now || asking ? (_jsxs("div", { children: [_jsx("dt", { children: "Now" }), _jsxs("dd", { children: [now?.place ? _jsx("span", { children: now.place }) : asking && !now ? _jsx("span", { className: "muted", children: "Asking Google Scholar\u2026" }) : null, now?.verified ? (_jsxs("span", { className: "hc-verified", title: "Google Scholar verified an address at this domain; it does not show the address itself", children: ["\u2713 Verified email at ", now.verified] })) : null, now ? _jsx("span", { className: "hc-src", children: now.from }) : null] })] })) : null, then ? (_jsxs("div", { children: [_jsx("dt", { children: "On this paper" }), _jsxs("dd", { children: [then.place ? _jsx("span", { children: then.same ? `${then.place} — the same as now` : then.place }) : null, then.moved ? (_jsxs("span", { className: "hc-moved", title: "The paper's note of where they had moved to by the time it came out", children: ["then moved to ", then.moved] })) : null, then.emails.map((email) => (_jsxs("a", { className: "hc-email", href: `mailto:${email}`, title: "The address the paper gives for them", children: ["\u2709 ", email] }, email))), _jsx("span", { className: "hc-src", children: then.from === 'the paper' ? 'as printed on the paper' : 'OpenAlex, for this paper' })] })] })) : null] }));
}
function AuthorCard({ name, position, paper, onPaper, byline }) {
    const answer = useAnswer(() => authorDetails(name, position, paper), `${paper.id}|${position}|${name}`);
    // A lookup that failed outright reads as one that found nobody.
    const details = useMemo(() => (answer === null ? { name, via: 'none', topics: [], topWorks: [] } : answer), [answer, name]);
    // Asked alongside OpenAlex, not after it: it goes by the paper, not by the record.
    const elsewhere = useAnswer(() => profilesElsewhere(name, paper), `${paper.id}|${name}`);
    const [scholar, setScholar] = useState(undefined);
    useEffect(() => {
        if (details === undefined)
            return;
        let live = true;
        setScholar(undefined);
        // Where the paper itself says they were comes first: it is the surest
        // way of telling their profile from a namesake's.
        const places = [...(onPaper?.affiliations ?? []), details?.affiliationHere, details?.affiliation].filter((place) => Boolean(place));
        // A lone profile with the name is theirs only when OpenAlex tied this very person to the paper.
        const tied = details.via === 'paper' && !details.mistaken;
        const fullNames = details.fullName && !details.mistaken ? [details.fullName] : [];
        void scholarProfile(name, { places, fullNames, loneOk: tied, paper, position })
            .catch((error) => ({ profile: null, confirmed: false, error: error instanceof Error ? error.message : String(error) }))
            .then((found) => live && setScholar(found));
        return () => {
            live = false;
        };
        // The paper is named by its id, which is in the details' key already.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [details, name, position]);
    // Only a profile that is plainly theirs is shown as theirs; a likely one is offered as that.
    const profile = scholar?.confirmed ? scholar.profile : scholar ? null : undefined;
    const likely = scholar && !scholar.confirmed ? scholar.profile : null;
    const scholarAsking = hasProxy() && details !== undefined && scholar === undefined;
    // Scholar's counts are the ones people keep and quote: where the profile
    // gave them, they are the ones shown, and OpenAlex's only otherwise.
    const scholarStats = Boolean(profile && (profile.citedBy !== undefined || profile.hIndex !== undefined));
    const stats = scholarStats
        ? { citedBy: profile.citedBy, hIndex: profile.hIndex, i10Index: profile.i10Index, worksCount: undefined, from: 'Google Scholar' }
        : { citedBy: details?.citedBy, hIndex: details?.hIndex, i10Index: details?.i10Index, worksCount: details?.worksCount, from: 'OpenAlex' };
    const topWorks = profile?.works.length
        ? profile.works.slice(0, 3).map((work) => ({ title: work.title, year: Number(yearOf(work.published)) || undefined, citedBy: work.citedBy }))
        : (details?.topWorks ?? []).map((work) => ({ title: work.title, year: Number(yearOf(work.published)) || undefined, citedBy: work.citedBy }));
    // A record of their own at OpenAlex that is plainly them counts as a profile.
    const ownRecord = details?.openAlexId !== undefined && details.via === 'paper';
    const pages = elsewhere?.profiles ?? [];
    const settled = details !== undefined && elsewhere !== undefined && !scholarAsking;
    const nowhere = settled && !profile && !likely && !scholar?.error && !ownRecord && !details?.orcid && !pages.length;
    const namesake = useAnswer(() => (nowhere ? worksUnderName(name, paper) : Promise.resolve([])), `${paper.id}|${name}|${nowhere}`);
    // What the paper's contributions statement says they did: DeepSeek's
    // reading of it where the proxy has one, the layout's own until then.
    const readings = useAnswer(() => readContributions(onPaper ? byline : undefined), `${paper.id}|${byline?.statement ?? ''}`);
    const read = onPaper && readings ? readings[byline.authors.indexOf(onPaper)] : undefined;
    const did = read?.did.length ? read.did : onPaper?.contributions ?? [];
    const roles = rolesOnPaper(onPaper, position);
    for (const role of read?.roles ?? [])
        if (!roles.some((known) => known.toLowerCase() === role.replace(/\.$/, '').toLowerCase()))
            roles.push(role.replace(/\.$/, ''));
    const where = whereTheyAre({ onPaper, details, profile });
    const interests = profile?.interests?.length ? profile.interests : details?.topics ?? [];
    const who = [elsewhere?.fullName, elsewhere?.lived].filter(Boolean).join(', ');
    // Their books from Open Library stand in for OpenAlex's list when OpenAlex has none that are theirs.
    const otherWorks = topWorks.length ? [] : elsewhere?.works ?? [];
    // Every page of theirs, as a row of buttons under the name: the profile
    // that is plainly theirs first, a likely one marked as that, and a search
    // of Scholar for the name where no profile is known.
    const profileLinks = [];
    if (profile?.scholarProfileUrl)
        profileLinks.push({ site: 'Google Scholar', url: profile.scholarProfileUrl, title: 'Their Google Scholar profile' });
    else if (likely?.scholarProfileUrl)
        profileLinks.push({ site: 'Google Scholar?', url: likely.scholarProfileUrl, title: `Possibly theirs — ${likely.name}${likely.affiliation ? `, ${likely.affiliation}` : ''} — but it does not list this paper`, guess: true });
    if (profile?.homepage)
        profileLinks.push({ site: 'Homepage', url: profile.homepage, title: 'The homepage their Scholar profile links to' });
    if (details?.orcid)
        profileLinks.push({ site: 'ORCID', url: `https://orcid.org/${details.orcid}`, title: 'Their ORCID record' });
    if (details?.openAlexId)
        profileLinks.push({
            site: details.via === 'paper' ? 'OpenAlex' : 'OpenAlex?',
            url: `https://openalex.org/authors/${details.openAlexId}`,
            title: details.via === 'paper' ? 'The record OpenAlex files this paper under' : 'Found by the name alone — it may be someone else of the name',
            guess: details.via !== 'paper',
        });
    for (const page of pages)
        profileLinks.push({ site: page.site, url: page.url, title: `Their page on ${page.site}` });
    if (!profile && !likely && !scholarAsking)
        profileLinks.push({ site: 'Search Scholar', url: scholarAuthorUrl(details?.fullName ?? name), title: 'Search Google Scholar for the name', guess: true });
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "hc-head", children: [_jsx("p", { className: "hc-name", children: name }), who ? _jsx("p", { className: "hc-sub", children: who }) : null, elsewhere?.description ? _jsx("p", { className: "hc-sub", children: elsewhere.description }) : null, roles.length ? (_jsx("p", { className: "hc-roles", "aria-label": "On this paper", children: roles.map((role) => (_jsx("span", { className: "hc-role", children: role }, role))) })) : null, did.length ? (
                    // What the paper's contributions statement says they did, in its words.
                    _jsx("p", { className: "hc-contrib", "aria-label": "Their part in this paper", title: read?.did.length ? "The paper's own words, picked out for them by DeepSeek" : "The paper's own words", children: did.join(' ') })) : null, _jsx(WhereTheyAre, { where: where, asking: scholarAsking }), profileLinks.length || scholarAsking || elsewhere === undefined ? (_jsxs("div", { className: "hc-profiles", "aria-label": "Their profiles", children: [profileLinks.map((link) => (_jsxs("a", { className: `hc-profile${link.guess ? ' guess' : ''}`, href: link.url, target: "_blank", rel: "noreferrer noopener", title: link.title, children: [link.site, " ", _jsx(ExternalIcon, { size: 9 })] }, link.site))), scholarAsking || elsewhere === undefined ? (_jsx("span", { className: "hc-profile pending", title: "Looking for their profiles", children: _jsx("span", { className: "spinner" }) })) : null] })) : null] }), details === undefined ? (_jsxs("p", { className: "hc-loading", children: [_jsx("span", { className: "spinner" }), " Looking them up\u2026"] })) : (_jsxs(_Fragment, { children: [(stats.citedBy !== undefined || stats.hIndex !== undefined) && !(scholarAsking && !scholarStats) ? (_jsxs(_Fragment, { children: [_jsxs("dl", { className: "hc-stats", "aria-label": `Counts from ${stats.from}`, children: [stats.citedBy !== undefined ? (_jsxs("div", { children: [_jsx("dt", { children: "Citations" }), _jsx("dd", { children: compact(stats.citedBy) })] })) : null, stats.hIndex !== undefined ? (_jsxs("div", { children: [_jsx("dt", { children: "h-index" }), _jsx("dd", { children: stats.hIndex })] })) : null, stats.i10Index !== undefined ? (_jsxs("div", { children: [_jsx("dt", { children: "i10-index" }), _jsx("dd", { children: stats.i10Index })] })) : null, stats.worksCount !== undefined ? (_jsxs("div", { children: [_jsx("dt", { children: "Papers" }), _jsx("dd", { children: compact(stats.worksCount) })] })) : null] }), _jsxs("p", { className: "hc-from", children: ["Counts from ", stats.from, scholarStats && profile?.counted !== undefined
                                        ? ` — added up from the ${profile.counted} ${profile.counted === 1 ? 'paper' : 'papers'} of theirs Scholar's search found, so their profile's own may be higher`
                                        : '', !scholarStats && profile === null && !scholar?.error && hasProxy() ? ' — it can miss papers filed under another spelling of the name' : ''] })] })) : null, elsewhere?.about ? _jsx("p", { className: "hc-about", children: elsewhere.about }) : null, profile ? (
                    // Its affiliation and verified email are shown with the paper's, above.
                    null) : scholarAsking ? (_jsxs("p", { className: "hc-scholar muted", children: [_jsx("span", { className: "spinner" }), " Asking Google Scholar\u2026"] })) : likely ? (_jsxs("p", { className: "hc-scholar muted", children: ["The Google Scholar profile of the name (", likely.name, likely.affiliation ? `, ${likely.affiliation}` : '', ") does not list this paper, so it may not be theirs and its counts are not shown."] })) : scholar?.error ? (_jsxs("p", { className: "hc-scholar muted", children: ["Google Scholar could not be asked \u2014 ", scholar.error.replace(/\.$/, ''), "."] })) : hasProxy() ? (_jsx("p", { className: "hc-scholar muted", children: "No Google Scholar profile lists this paper as theirs." })) : null, interests.length ? (_jsx("div", { className: "hc-chips", "aria-label": profile?.interests?.length ? 'Interests on Google Scholar' : 'Topics', children: interests.slice(0, 5).map((interest) => (_jsx("span", { className: "hc-chip", children: interest }, interest))) })) : null, topWorks.length ? _jsx(WorkList, { label: "Most cited", works: topWorks }) : null, otherWorks.length ? _jsx(WorkList, { label: "Other works", works: otherWorks }) : null, details.mistaken ? (_jsxs("p", { className: "hc-note", children: ["OpenAlex files this paper under", ' ', _jsx("a", { href: `https://openalex.org/authors/${details.mistaken.openAlexId}`, target: "_blank", rel: "noreferrer noopener", children: "a record" }), details.mistaken.affiliation ? ` at ${details.mistaken.affiliation}` : '', " that is not them \u2014 ", details.mistaken.reason, " \u2014 so none of it is shown here."] })) : null, nowhere ? (_jsxs(_Fragment, { children: [_jsx("p", { className: "hc-note", children: "No registered profile of theirs was found \u2014 not on Google Scholar, OpenAlex, ORCID, Wikipedia or Open Library." }), namesake === undefined ? (_jsxs("p", { className: "hc-loading", children: [_jsx("span", { className: "spinner" }), " Finding their other work\u2026"] })) : namesake?.length ? (_jsxs(_Fragment, { children: [_jsx(WorkList, { label: "Other works under the name", works: namesake }), _jsx("p", { className: "hc-note", children: "Found by the name alone \u2014 some may be a namesake's." })] })) : null] })) : details.via === 'name' && !details.mistaken ? (_jsx("p", { className: "hc-note", children: "Found by the name alone, not through this paper \u2014 it may be someone else of that name." })) : details.via === 'none' && !pages.length && settled && !profile ? (_jsx("p", { className: "hc-note", children: "No index has a record of this person that could be told apart from others of the name." })) : null] })), _jsx("div", { className: "hc-links", children: _jsxs("button", { type: "button", className: "hc-action", onClick: () => discover(`author:${elsewhere?.fullName ?? name}`), children: [_jsx(SearchIcon, { size: 11 }), " All their papers"] }) })] }));
}
/** A short list of someone's works, each one a search for it in Discover. */
function WorkList({ label, works }) {
    return (_jsxs("div", { className: "hc-works", children: [_jsx("p", { className: "hc-label", children: label }), _jsx("ul", { children: works.map((work) => (_jsxs("li", { children: [_jsx("button", { type: "button", className: "hc-work", onClick: () => discover(`"${work.title}"`), title: "Find it in Discover", children: work.title }), _jsx("span", { className: "hc-meta", children: [
                                work.year ? String(work.year) : '',
                                work.citedBy !== undefined ? `${compact(work.citedBy)} citations` : '',
                                work.editions ? `${work.editions} edition${work.editions === 1 ? '' : 's'}` : '',
                            ]
                                .filter(Boolean)
                                .join(' · ') })] }, `${work.title}|${work.year ?? ''}`))) })] }));
}
// ---------------------------------------------------------------- venue ---
const KIND_LABEL = {
    journal: 'Journal',
    conference: 'Conference',
    repository: 'Repository',
    'book series': 'Book series',
    venue: 'Published in',
};
/**
 * The card over the journal or conference the paper appeared in: who
 * publishes it and how it is cited, where in it the paper is, and for a
 * conference, where and when that year's meeting was held.
 */
function VenueCard({ venue, paper }) {
    const answer = useAnswer(() => venueDetails({ ...paper, venue }), `${paper.id}|${venue}`);
    // A lookup that failed outright reads as one that found nothing.
    const details = answer === null ? { name: venue, kind: 'venue' } : answer;
    const name = details?.name || venue;
    const event = details?.event;
    const links = [];
    if (details?.homepage)
        links.push({ site: 'Homepage', url: details.homepage, title: `The ${details.kind === 'conference' ? "conference's" : "journal's"} own site` });
    if (event?.website)
        links.push({ site: `${event.name ?? 'Meeting'} site`, url: event.website, title: "That year's meeting" });
    if (event?.proceedingsUrl)
        links.push({ site: 'Proceedings', url: event.proceedingsUrl, title: 'The proceedings volume at the publisher' });
    if (event?.dblpUrl)
        links.push({ site: `dblp · ${event.name ?? 'volume'}`, url: event.dblpUrl, title: 'The proceedings volume at dblp, with every paper in it' });
    if (details?.dblpUrl)
        links.push({ site: 'dblp', url: details.dblpUrl, title: 'Every year of it at dblp' });
    if (details?.wikipedia)
        links.push({ site: 'Wikipedia', url: details.wikipedia.url, title: 'Its Wikipedia page' });
    if (event?.wikidata)
        links.push({ site: 'Wikidata', url: `https://www.wikidata.org/wiki/${event.wikidata}`, title: "That year's meeting at Wikidata" });
    if (details?.issn)
        links.push({ site: `ISSN ${details.issn}`, url: `https://portal.issn.org/resource/ISSN/${details.issn}`, title: 'Its record at the ISSN Portal' });
    if (details?.issn && details.kind === 'journal')
        links.push({ site: 'SJR', url: `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(details.issn)}`, title: 'Its rank and quartile at SCImago' });
    if (details?.openAlexId)
        links.push({ site: 'OpenAlex', url: `https://openalex.org/sources/${details.openAlexId}`, title: 'Its record at OpenAlex' });
    links.push({
        site: 'Google Scholar',
        url: `https://scholar.google.com/citations?view_op=search_venues&hl=en&vq=${encodeURIComponent(name)}`,
        title: "Its rank among Scholar's venues",
    });
    const stats = [
        details?.hIndex !== undefined ? { label: 'h-index', value: String(details.hIndex) } : null,
        details?.meanCitedness !== undefined ? { label: '2-yr citedness', value: details.meanCitedness.toFixed(details.meanCitedness >= 10 ? 0 : 1), title: "OpenAlex's two-year mean citedness — the impact factor, near enough" } : null,
        details?.worksCount !== undefined ? { label: 'Papers', value: compact(details.worksCount) } : null,
        details?.citedBy !== undefined ? { label: 'Citations', value: compact(details.citedBy) } : null,
    ].filter((stat) => Boolean(stat));
    const sub = [details?.abbreviation && details.abbreviation !== name ? details.abbreviation : '', details?.publisher, details?.country].filter(Boolean).join(' · ');
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "hc-head", children: [_jsx("p", { className: "hc-kicker", children: details ? KIND_LABEL[details.kind] : 'Published in' }), _jsx("p", { className: "hc-name", children: name }), sub ? _jsx("p", { className: "hc-sub", children: sub }) : null, details?.wikipedia?.description ? _jsx("p", { className: "hc-sub", children: details.wikipedia.description }) : null] }), details === undefined ? (_jsxs("p", { className: "hc-loading", children: [_jsx("span", { className: "spinner" }), " Looking it up\u2026"] })) : (_jsxs(_Fragment, { children: [event && (event.location || event.dates) ? (_jsxs("div", { className: "hc-event", "aria-label": "The meeting the paper was presented at", children: [_jsx("p", { className: "hc-label", children: event.name ?? 'The meeting' }), event.location ? (_jsx("p", { className: "hc-sub", children: _jsx("a", { href: `https://www.openstreetmap.org/search?query=${encodeURIComponent(event.location)}`, target: "_blank", rel: "noreferrer noopener", title: "On the map", children: event.location }) })) : null, event.dates ? _jsx("p", { className: "hc-sub", children: event.dates }) : null] })) : null, details.placement || details.publishedOn ? (_jsxs("p", { className: "hc-meta hc-placement", children: ["This paper: ", [details.placement, details.publishedOn ? `published ${details.publishedOn}` : ''].filter(Boolean).join(' · ')] })) : null, stats.length ? (_jsxs(_Fragment, { children: [_jsx("dl", { className: "hc-stats", "aria-label": "Counts from OpenAlex", children: stats.map((stat) => (_jsxs("div", { title: stat.title, children: [_jsx("dt", { children: stat.label }), _jsx("dd", { children: stat.value })] }, stat.label))) }), _jsx("p", { className: "hc-from", children: "Counts from OpenAlex" })] })) : null, details.openAccess || details.inDoaj ? (_jsxs("div", { className: "hc-chips", children: [details.openAccess ? _jsx("span", { className: "hc-chip", children: "Open access" }) : null, details.inDoaj ? _jsx("span", { className: "hc-chip", children: "In DOAJ" }) : null] })) : null, details.wikipedia?.extract ? _jsx("p", { className: "hc-about", children: details.wikipedia.extract }) : null, !details.openAlexId && !event && !details.wikipedia ? (_jsx("p", { className: "hc-note", children: "None of the indexes has a record that is plainly this venue." })) : null] })), _jsx("div", { className: "hc-profiles", "aria-label": "Pages about it", children: links.map((link) => (_jsxs("a", { className: "hc-profile", href: link.url, target: "_blank", rel: "noreferrer noopener", title: link.title, children: [link.site, " ", _jsx(ExternalIcon, { size: 9 })] }, link.site))) })] }));
}
// ------------------------------------------------------------- citation ---
function CiteCard({ entries, onJump }) {
    const [current, setCurrent] = useState(0);
    const entry = entries[Math.min(current, entries.length - 1)];
    const paper = useAnswer(() => resolveReference(entry.text), entry.text);
    const jump = useCallback(() => onJump(entry.id), [entry.id, onJump]);
    // The card is a way into Discover: pressed, it looks the paper up there
    // and opens its result, where it can be read about, added and opened.
    const find = useCallback(() => {
        const found = paper?.title?.trim();
        const title = found || parseReference(entry.text).title;
        discover(found ? `"${found}"` : title ?? entry.text.slice(0, 200), title);
    }, [entry.text, paper]);
    const onKey = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ')
            return;
        event.preventDefault();
        find();
    };
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "hc-head hc-row", children: [_jsx("p", { className: "hc-kicker", children: entries.length > 1 ? `${entries.length} references` : `Reference ${entry.label}` }), _jsx("button", { type: "button", className: "hc-action", onClick: jump, title: "Go to the entry in the bibliography", children: "In the bibliography \u2193" })] }), entries.length > 1 ? (_jsx("div", { className: "hc-tabs", role: "tablist", children: entries.map((item, index) => (_jsx("button", { type: "button", role: "tab", "aria-selected": index === current, onClick: () => setCurrent(index), onMouseEnter: () => setCurrent(index), children: item.label }, item.id))) })) : null, _jsx("p", { className: "hc-printed hc-find", role: "button", tabIndex: 0, onClick: find, onKeyDown: onKey, title: "Find it in Discover", children: entry.text }), paper === undefined ? (_jsxs("p", { className: "hc-loading", children: [_jsx("span", { className: "spinner" }), " Finding the paper\u2026"] })) : paper ? (_jsxs("div", { className: "hc-paper hc-find", role: "button", tabIndex: 0, onClick: find, onKeyDown: onKey, title: "Find it in Discover and show its details", children: [_jsx("p", { className: "hc-title", children: paper.landingUrl ? (_jsx("a", { href: paper.landingUrl, target: "_blank", rel: "noreferrer noopener", onClick: (event) => event.stopPropagation(), children: paper.title })) : (paper.title) }), paper.authors.length ? _jsx("p", { className: "hc-sub", children: byline(paper.authors) }) : null, _jsx("p", { className: "hc-meta", children: [paper.venue, yearOf(paper.published), paper.citedBy !== undefined ? `cited by ${compact(paper.citedBy)}` : '']
                            .filter(Boolean)
                            .join(' · ') }), paper.abstract ? _jsx("p", { className: "hc-abstract", children: paper.abstract }) : null] })) : (_jsx("p", { className: "hc-note", children: "None of the indexes has a record that is plainly this entry." })), _jsxs("div", { className: "hc-links", children: [paper?.pdfUrl ? (_jsxs("a", { href: paper.pdfUrl, target: "_blank", rel: "noreferrer noopener", children: ["PDF ", _jsx(ExternalIcon, { size: 10 })] })) : null, paper?.arxivId ? (_jsxs("a", { href: `https://arxiv.org/abs/${paper.arxivId}`, target: "_blank", rel: "noreferrer noopener", children: ["arXiv ", _jsx(ExternalIcon, { size: 10 })] })) : null, paper?.doi ? (_jsxs("a", { href: `https://doi.org/${paper.doi}`, target: "_blank", rel: "noreferrer noopener", children: ["DOI ", _jsx(ExternalIcon, { size: 10 })] })) : null, _jsxs("a", { href: paper ? scholarPaperUrl(paper) : `https://scholar.google.com/scholar?q=${encodeURIComponent(entry.text.slice(0, 250))}`, target: "_blank", rel: "noreferrer noopener", children: ["Google Scholar ", _jsx(ExternalIcon, { size: 10 })] }), _jsxs("button", { type: "button", className: "hc-action", onClick: find, title: "Search for it in Discover, where it can be added and read", children: [_jsx(SearchIcon, { size: 11 }), " Add or read"] })] })] }));
}
