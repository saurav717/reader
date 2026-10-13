import { apiFetch, hasProxy } from './api';
/** The address as given when it is an https one, else nothing — sources.ts has the same, which imports this file. */
const webUrl = (url) => {
    if (!url)
        return undefined;
    try {
        return new URL(url).protocol === 'https:' ? url : undefined;
    }
    catch {
        return undefined;
    }
};
import { titleFits } from './citations';
import { tidyByline } from './byline';
export class ScholarError extends Error {
    blocked;
    reason;
    /** The Scholar page that answered with a captcha — where it can be shown and solved. */
    captchaUrl;
    constructor(message, blocked = false, reason, captchaUrl) {
        super(message);
        this.blocked = blocked;
        this.reason = reason;
        this.captchaUrl = captchaUrl;
    }
}
const NO_PROXY = 'Google Scholar needs the proxy: it sends no CORS headers, and a request from a browser tab would never reach it. Settings → Paper proxy.';
const SCHOLAR = 'https://scholar.google.com';
/**
 * The Scholar page a proxy request stands for — the same URL `server/scholar.js`
 * builds. The proxy names the page it was refused on, but a proxy older than
 * this page does not, and the offer to show the captcha should not depend on
 * which one is answering: the page knows what it asked for.
 */
const scholarPage = (path, params) => `${SCHOLAR}/${path}?${new URLSearchParams(params)}`;
/**
 * One proxy request. `page` is the Scholar page it asks for, kept on the
 * error when Scholar answers it with a captcha, so the captcha can be shown.
 */
async function ask(path, page, signal) {
    if (!hasProxy())
        throw new ScholarError(NO_PROXY);
    let response;
    try {
        response = await apiFetch(path, { signal });
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
            throw error;
        throw new ScholarError('Could not reach the proxy to ask Google Scholar.');
    }
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok) {
        throw new ScholarError(payload.error || `Google Scholar search failed (${response.status})`, Boolean(payload.blocked), payload.reason, 
        // A captcha, or a bare refusal that a real browser gets past: both are
        // answered by opening the page in the proxy's window.
        payload.blocked && (payload.reason === 'captcha' || payload.reason === 'refused') ? payload.url || page : undefined);
    }
    return payload.results || [];
}
/**
 * A Scholar id is not a DOI and not an arXiv id, so a Scholar record folds in
 * with the other sources on its title — which is what `identity()` in
 * sources.ts falls back to. The cluster id rides along so that "all N
 * versions" can be asked for later.
 */
export function fromScholar(result) {
    const arxiv = (result.pdfUrl || result.url || '').match(/arxiv\.org\/(?:pdf|abs)\/([^?#]+?)(?:\.pdf)?$/i)?.[1];
    const doi = (result.url || '').match(/doi\.org\/(10\.[^?#\s]+)/i)?.[1];
    // A proxy still on the older parser reads Scholar's newer byline wrongly; read it again here.
    return tidyByline({
        id: arxiv ? `arxiv:${arxiv}` : doi ? `doi:${doi.toLowerCase()}` : `scholar:${result.clusterId || result.id || result.title}`,
        source: 'scholar',
        title: result.title,
        authors: result.authors || [],
        // Scholar gives a two-line snippet rather than an abstract; it is marked as
        // what it is so the reader does not present it as one.
        abstract: result.snippet || '',
        published: result.published || (result.year ? `${result.year}-01-01` : ''),
        categories: [],
        arxivId: arxiv,
        doi: doi?.toLowerCase(),
        // Scholar's page is parsed HTML, and a link in it is whatever it said:
        // only a web address is kept, never something a click would run.
        pdfUrl: webUrl(result.pdfUrl),
        landingUrl: webUrl(result.url),
        venue: result.venue,
        citedBy: result.citedBy,
        scholarCluster: result.clusterId,
        scholarVersions: result.versionCount,
        scholarCitation: result.citationId,
    });
}
export async function searchScholar(query, page = 0, signal) {
    const trimmed = query.trim();
    if (!trimmed)
        return [];
    // Scholar pages in tens, whatever we ask for.
    const start = page * 10;
    const results = await ask(`/scholar/search?q=${encodeURIComponent(trimmed)}&start=${start}`, scholarPage('scholar', { hl: 'en', as_sdt: '0,5', q: trimmed, ...(start ? { start: String(start) } : {}) }), signal);
    return results.map(fromScholar);
}
export async function scholarAuthors(name, signal) {
    const trimmed = name.trim();
    if (!trimmed)
        return [];
    const results = await ask(`/scholar/authors?name=${encodeURIComponent(trimmed)}`, scholarPage('citations', { hl: 'en', view_op: 'search_authors', mauthors: trimmed }), signal);
    return results
        .filter((author) => author.name)
        .map((author) => ({
        id: `scholar:${author.userId || author.name}`,
        source: 'scholar',
        name: author.name,
        affiliation: author.affiliation,
        citedBy: author.citedBy,
        scholarUserId: author.userId,
        scholarProfileUrl: author.profileUrl,
        interests: author.interests,
        verifiedEmail: author.verifiedEmail,
    }));
}
/**
 * The person's name beside their profile id, where it is known. A proxy
 * that reads the profile page has no use for it; one that asks Serply finds
 * a person's works by searching for their name, and is spared finding out
 * whose the id is first.
 */
const nameParam = (name) => (name?.trim() ? `&name=${encodeURIComponent(name.trim())}` : '');
/**
 * Everything on one person's Scholar profile, which is their own list —
 * newest first, or most cited first, which is the order Scholar gives when
 * not told otherwise and so the one the page is asked for without `sortby`.
 */
export async function scholarProfileWorks(userId, options = {}) {
    const start = (options.page ?? 0) * 20;
    const sort = options.order === 'cited' ? 'citations' : 'pubdate';
    const results = await ask(`/scholar/profile?user=${encodeURIComponent(userId)}&start=${start}&sort=${sort}${nameParam(options.name)}`, scholarPage('citations', {
        hl: 'en',
        user: userId,
        cstart: String(start),
        pagesize: '20',
        view_op: 'list_works',
        ...(sort === 'pubdate' ? { sortby: 'pubdate' } : {}),
    }), options.signal);
    return results.map(fromScholar);
}
/**
 * One entry on a profile, opened. The list a profile gives carries a title,
 * a byline and a count, and no more; the entry's own page is where Scholar
 * shows the file it found for it — "[PDF] from bu.edu", the copy on the
 * person's own university's site that no index has a record of — and the
 * cluster it belongs to, from which every other copy follows. Asked for when
 * one of a profile's papers is opened, not for the whole list at once: it is
 * one Scholar request per paper.
 */
export async function scholarWork(citationId, signal) {
    const match = /^([\w-]{6,32}):([\w-]{6,32})$/.exec(citationId);
    if (!match)
        return undefined;
    const user = match[1];
    const results = await ask(`/scholar/work?user=${encodeURIComponent(user)}&citation=${encodeURIComponent(citationId)}`, scholarPage('citations', { hl: 'en', user, view_op: 'view_citation', citation_for_view: citationId }), signal);
    return results[0];
}
/** A profile, read from its page — the counts in its corner and its most cited works. */
export async function scholarPerson(userId, signal, name) {
    if (!/^[\w-]{6,32}$/.test(userId))
        return undefined;
    const results = await ask(`/scholar/person?user=${encodeURIComponent(userId)}${nameParam(name)}`, scholarPage('citations', { hl: 'en', user: userId }), signal);
    const person = results[0];
    return person ? { ...person, interests: person.interests ?? [], works: person.works ?? [] } : undefined;
}
/** Enough to say two titles are the same paper: case, punctuation and accents aside. */
export const sameTitle = (a, b) => {
    const fold = (value) => value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    return fold(a) !== '' && fold(a) === fold(b);
};
/**
 * The paper as Scholar's search finds it: the same record the Papers tab
 * shows, with the file Scholar found and the cluster. It is the way to reach
 * those for a paper that arrived without them — one from a profile, when the
 * entry's own page was refused — because a search is the one page Scholar
 * answers most readily. Only an exact match on the title is taken: a search
 * finds neighbours too, and a neighbour's copies are not this paper's.
 */
export async function scholarLookup(title, signal) {
    const trimmed = title.trim();
    if (!trimmed)
        return undefined;
    const query = `"${trimmed}"`;
    const results = await ask(`/scholar/search?q=${encodeURIComponent(query)}`, scholarPage('scholar', { hl: 'en', as_sdt: '0,5', q: query }), signal);
    return results.find((result) => sameTitle(result.title, trimmed));
}
/**
 * A paper's authors as Scholar's record of it links them to their profiles.
 * Scholar links a name in a byline only where that person has put the paper
 * on their own profile, so this is who wrote it, by their own word — no
 * guessing between people of a name. Undefined when the paper is not found;
 * an empty list when it is found and none of its authors has a profile.
 */
export async function scholarPaperAuthors(title, signal) {
    const trimmed = title.trim();
    if (!trimmed)
        return undefined;
    const query = `"${trimmed}"`;
    const results = await ask(`/scholar/search?q=${encodeURIComponent(query)}`, scholarPage('scholar', { hl: 'en', as_sdt: '0,5', q: query }), signal);
    // Scholar shortens a long title with an ellipsis, and writes its case its own way.
    const found = results.find((result) => sameTitle(result.title, trimmed)) ??
        results.find((result) => titleFits(result.title.replace(/…$/, ''), trimmed) && titleFits(trimmed, result.title.replace(/…$/, '')));
    return found ? { authors: found.authors ?? [], linked: found.authorIds ?? [] } : undefined;
}
/**
 * Scholar's "All 84 versions" — every copy of one paper it knows of, which is
 * the longest such list anywhere and the reason this source is worth the
 * trouble. Each version is a result in its own right, carrying the host it
 * sits on and, where Scholar found one, a direct link to the file.
 */
export async function scholarVersions(clusterId, signal, title) {
    if (!/^\d{1,25}$/.test(clusterId))
        return [];
    // The paper's title beside its cluster: a proxy that asks Serply cannot
    // open a cluster by its id alone, and finds it by the title within it.
    const titled = title?.trim() ? `&title=${encodeURIComponent(title.trim().slice(0, 300))}` : '';
    return ask(`/scholar/versions?cluster=${encodeURIComponent(clusterId)}${titled}`, scholarPage('scholar', { hl: 'en', as_sdt: '0,5', cluster: clusterId }), signal);
}
const CAPTCHA_UNAVAILABLE = {
    available: false,
    window: 'closed',
    solved: false,
    browser: false,
    reason: 'There is no proxy configured, so there is nothing to show the captcha in.',
};
async function askCaptcha(path, init) {
    const response = await apiFetch(path, { ...init, headers: { Accept: 'application/json' } });
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(payload.error || `The proxy answered ${response.status}.`);
    return { ...CAPTCHA_UNAVAILABLE, ...payload };
}
/** The proxy's answer, fresh. */
export async function captchaStatus() {
    if (!hasProxy())
        return CAPTCHA_UNAVAILABLE;
    try {
        return await askCaptcha('/scholar/captcha/status');
    }
    catch {
        // A proxy older than this page has no such route, and one that is down
        // has none either: no window, and what to do about it.
        return {
            ...CAPTCHA_UNAVAILABLE,
            reason: 'This proxy is older than this page and does not know how to show a captcha. Update it: `npm run deploy:worker` for the Worker, or pull the repository and restart `npm start` on your machine, which is also the proxy that can open the window.',
        };
    }
}
/** Open the window at the Scholar page that was refused. */
export async function showCaptcha(url) {
    await askCaptcha(`/scholar/captcha?url=${encodeURIComponent(url)}`, { method: 'POST' });
}
/** "I have solved it": close the window, so the fetches can use the profile. */
export async function finishCaptcha() {
    await askCaptcha('/scholar/captcha/close', { method: 'POST' }).catch(() => undefined);
}
/**
 * Resolves once the captcha window has closed — on its own, the moment
 * Scholar accepts the answer; by the person; or by `finishCaptcha`. Polls,
 * because the proxy has no way to call back, and gives up quietly on abort.
 */
export async function waitForCaptcha(signal, intervalMs = 1500) {
    for (;;) {
        if (signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        const status = await captchaStatus();
        if (status.window !== 'open')
            return status;
        await new Promise((resolve, reject) => {
            const timer = window.setTimeout(resolve, intervalMs);
            signal?.addEventListener('abort', () => {
                window.clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    }
}
