/**
 * What the hover card over a paper's venue says: which journal or
 * conference it is, who publishes it, how it is cited, and — for a
 * conference — where and when the meeting the paper was presented at was
 * held, with a link to every page about it worth opening.
 *
 * OpenAlex knows the journal or proceedings a paper is in and that source's
 * counts, publisher, ISSN and homepage. It knows nothing of a meeting's
 * place and dates, which come from dblp — whose record of a proceedings
 * volume is titled `…, NeurIPS 2019, December 8-14, 2019, Vancouver, BC,
 * Canada` — and failing that from Wikidata's item for that year's meeting.
 * All three send CORS headers and need no key. Every answer is kept for the
 * session.
 */
import { politely } from './contact';
import { titleFits } from './citations';
import { wikipedia } from './hoverInfo';
const OPENALEX = 'https://api.openalex.org';
const DBLP = 'https://dblp.org';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
function remembered(cache, key, make) {
    const known = cache.get(key);
    if (known)
        return known;
    const made = make();
    cache.set(key, made);
    made.catch(() => cache.delete(key));
    return made;
}
async function json(url) {
    const response = await fetch(url);
    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new Error(`${new URL(url).host} answered ${response.status}`);
    return (await response.json());
}
const openAlex = (path, params = new URLSearchParams()) => {
    const query = politely(params).toString();
    return json(`${OPENALEX}/${path}${query ? `?${query}` : ''}`);
};
const filterValue = (value) => value.replace(/[,:|]+/g, ' ').replace(/\s+/g, ' ').trim();
const WORK_FIELDS = 'id,title,display_name,publication_date,primary_location,locations,biblio';
/** The paper at OpenAlex, by its DOI, else by its title. */
async function workOf(paper) {
    const select = new URLSearchParams({ select: WORK_FIELDS });
    const doi = paper.doi ?? (paper.arxivId ? `10.48550/arxiv.${paper.arxivId.replace(/v\d+$/, '')}` : undefined);
    if (doi) {
        const work = await openAlex(`works/doi:${encodeURIComponent(doi)}`, select).catch(() => null);
        // An arXiv DOI names the preprint, whose only source is arXiv: the journal is on the published record.
        if (work && sourceOf(work))
            return work;
    }
    if (!paper.title)
        return null;
    const params = new URLSearchParams({ per_page: '5', select: WORK_FIELDS });
    params.set('filter', `title.search:${filterValue(paper.title)}`);
    const found = await openAlex('works', params).catch(() => null);
    const fitting = (found?.results ?? []).filter((work) => titleFits(work.title || work.display_name || '', paper.title));
    return fitting.find((work) => sourceOf(work)) ?? fitting[0] ?? null;
}
/** Where the paper was published, rather than a repository holding a copy of it. */
function sourceOf(work) {
    const all = [work.primary_location?.source, ...(work.locations ?? []).map((location) => location.source)].filter((source) => Boolean(source?.id));
    return all.find((source) => source.type !== 'repository') ?? undefined;
}
const words = (value) => value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9À-ɏ]+/g, ' ')
    .replace(/\b(the|of|and|on|in|for|proceedings|journal|international|annual|ieee|acm|cvf)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Scholar lower-cases and cuts a venue's name short; this says whether an index's name is that one. */
export function venueFits(indexed, printed) {
    const a = words(indexed);
    const b = words(printed);
    if (!a || !b)
        return false;
    if (a === b)
        return true;
    // Cut short: `Advances in neural information …`. A short name is only ever the whole of one — `Nature` is not `Nature Neuroscience`.
    if (Math.min(a.length, b.length) >= 18 && (a.startsWith(b) || b.startsWith(a)))
        return true;
    const have = new Set(a.split(' '));
    const want = b.split(' ');
    return want.filter((word) => have.has(word)).length >= Math.max(2, Math.ceil(want.length * 0.8));
}
async function sourceByName(name) {
    const params = new URLSearchParams({ search: name, per_page: '5' });
    const found = await openAlex('sources', params).catch(() => null);
    return (found?.results ?? []).find((source) => venueFits(source.display_name || '', name)) ?? null;
}
const shortId = (id) => id.replace(/^https?:\/\/openalex\.org\//i, '');
// ------------------------------------------------------------ conferences ---
const CONFERENCE = /\b(proceedings|conference|symposium|workshop|congress|meeting|colloquium|summit|convention)\b/i;
/** The acronyms of the meetings papers are most often read from, which Scholar spells out or leaves bare. */
const KNOWN_ACRONYM = /\b(NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|WACV|BMVC|ACL|EMNLP|NAACL|EACL|COLING|AAAI|IJCAI|KDD|SIGIR|WWW|WSDM|CIKM|RecSys|CHI|UIST|CSCW|SIGGRAPH|ICRA|IROS|RSS|CoRL|AISTATS|UAI|COLT|STOC|FOCS|SODA|ICALP|PLDI|POPL|OOPSLA|ICSE|FSE|ASE|OSDI|SOSP|NSDI|SIGCOMM|MobiCom|INFOCOM|ISCA|MICRO|ASPLOS|HPCA|DAC|ICCAD|USENIX|CCS|NDSS|MICCAI|ISBI|ICASSP|INTERSPEECH|MM|ICDE|SIGMOD|VLDB|ICDM|SDM|ECML|PKDD)\b/;
/** An acronym and a year the printed venue carries: `NeurIPS 2019`, `CVPR`. */
function acronymIn(venue) {
    const known = KNOWN_ACRONYM.exec(venue)?.[1];
    if (known)
        return known;
    // `… (ICMI '19)` or `… (SIGCSE)`: an acronym the venue gives in brackets.
    return /\(([A-Z][A-Za-z-]*[A-Z][A-Za-z-]*)(?:\s*['’]?\d{2,4})?\)/.exec(venue)?.[1];
}
const dblp = (kind, q, hits = 10) => json(`${DBLP}/search/${kind}/api?${new URLSearchParams({ q, format: 'json', h: String(hits) })}`).then((answer) => (answer?.result?.hits?.hit ?? []).map((hit) => hit.info));
/** The name dblp would know a conference by: without the `Proceedings of the …` and the year around it. */
const bareName = (venue) => venue
    .replace(/…/g, ' ')
    .replace(/^\s*(?:in\s+)?(?:the\s+)?proceedings\s+of\s+(?:the\s+)?/i, '')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/\b(?:(?:twenty|thirty|forty|fifty|sixty)-)?(?:first|second|third|(?:four|fif|six|seven|eigh|nin|ten|eleven|twelf|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twentie|thirtie|fortie|fiftie|sixtie)th)\b/gi, ' ')
    .replace(/^\s*the\s+/i, '')
    .replace(/\b(?:1[89]|20)\d\d\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?';
const DATES = new RegExp(`${MONTH}\\s+\\d{1,2}(?:\\s*(?:-|–|to)\\s*(?:${MONTH}\\s+)?\\d{1,2})?,?\\s*(?:1[89]|20)\\d\\d`, 'i');
/**
 * The place and dates in a dblp proceedings title. dblp writes them either
 * way round — `…, NeurIPS 2019, December 8-14, 2019, Vancouver, BC, Canada`
 * or `…, CVPR 2019, Long Beach, CA, USA, June 16-20, 2019` — so the place is
 * what follows the dates, else the short pieces that lead up to them.
 */
export function readProceedingsTitle(title) {
    const clean = title.replace(/\.\s*$/, '').trim();
    const match = DATES.exec(clean);
    const name = /\b([A-Z][A-Za-z]*[A-Z][A-Za-z]*(?:\/[A-Z][A-Za-z]*)?)\s+((?:1[89]|20)\d\d)\b/.exec(clean);
    const event = name ? `${name[1]} ${name[2]}` : undefined;
    if (!match)
        return { name: event };
    const dates = match[0].replace(/\s*-\s*/g, '–').replace(/\s+/g, ' ');
    const after = clean
        .slice(match.index + match[0].length)
        .replace(/^[\s,]+/, '')
        .trim();
    let location = /^(?:Part|Volume|Vol\.)\b/i.test(after) ? '' : after;
    if (!location || /\b(?:1[89]|20)\d\d\b/.test(location) || location.length > 70) {
        const before = clean.slice(0, match.index).replace(/[\s,]+$/, '').split(/,\s*/);
        const place = [];
        for (let index = before.length - 1; index >= 0; index -= 1) {
            const piece = before[index].trim();
            if (!piece || /\d/.test(piece) || piece.length > 32 || CONFERENCE.test(piece) || /^(?:Part|Volume)\b/i.test(piece))
                break;
            place.unshift(piece);
        }
        location = place.join(', ');
    }
    return { dates, location: location || undefined, name: event };
}
const first = (value) => (Array.isArray(value) ? value[0] : value);
/** The dblp series page and that year's proceedings, found by the venue's name or acronym. */
async function fromDblp(venue, year) {
    const own = acronymIn(venue);
    const series = await dblp('venue', own ?? bareName(venue), 5).catch(() => []);
    const conference = series.find((hit) => (own && hit.acronym?.toLowerCase() === own.toLowerCase()) || venueFits(hit.venue, bareName(venue))) ??
        (own ? series[0] : undefined);
    const acronym = own ?? conference?.acronym;
    if (!acronym || !year)
        return { seriesUrl: conference?.url, acronym };
    const volumes = await dblp('publ', `${acronym} ${year} type:Editorship:`, 12).catch(() => []);
    const volume = volumes.find((hit) => hit.type === 'Editorship' && String(hit.year) === String(year) && new RegExp(`\\b${acronym}\\b`, 'i').test(hit.title) && DATES.test(hit.title));
    if (!volume)
        return { seriesUrl: conference?.url, acronym };
    const read = readProceedingsTitle(volume.title);
    return {
        seriesUrl: conference?.url,
        acronym,
        event: {
            name: read.name ?? `${acronym} ${year}`,
            dates: read.dates,
            location: read.location,
            dblpUrl: volume.url,
            proceedingsUrl: first(volume.ee),
        },
    };
}
const claim = (entity, property) => entity.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
const claimId = (entity, property) => claim(entity, property)?.id;
const claimDay = (entity, property) => {
    const time = claim(entity, property)?.time;
    const day = time && /^\+?(\d{4})-(\d\d)-(\d\d)/.exec(time);
    if (!day || day[2] === '00')
        return undefined;
    return new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Math.max(1, Number(day[3]))));
};
/** Wikidata's item for that year's meeting — `NeurIPS 2019` — with its place, days and site. */
async function fromWikidata(acronym, year) {
    const search = new URLSearchParams({ action: 'wbsearchentities', search: `${acronym} ${year}`, language: 'en', type: 'item', limit: '5', format: 'json', origin: '*' });
    const found = await json(`${WIKIDATA}?${search}`);
    const hit = (found?.search ?? []).find((item) => item.label?.includes(String(year)) && item.label.toLowerCase().includes(acronym.toLowerCase()));
    if (!hit)
        return null;
    const get = new URLSearchParams({ action: 'wbgetentities', ids: hit.id, props: 'claims|labels', languages: 'en', format: 'json', origin: '*' });
    const entity = (await json(`${WIKIDATA}?${get}`))?.entities?.[hit.id];
    if (!entity)
        return null;
    const places = [claimId(entity, 'P276'), claimId(entity, 'P131'), claimId(entity, 'P17')].filter((id) => Boolean(id));
    let location;
    if (places.length) {
        const labels = new URLSearchParams({ action: 'wbgetentities', ids: [...new Set(places)].join('|'), props: 'labels', languages: 'en', format: 'json', origin: '*' });
        const named = (await json(`${WIKIDATA}?${labels}`).catch(() => null))?.entities ?? {};
        location = [...new Set(places)].map((id) => named[id]?.labels?.en?.value).filter(Boolean).join(', ') || undefined;
    }
    const start = claimDay(entity, 'P580');
    const end = claimDay(entity, 'P582');
    const format = (day, withYear) => day.toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
    const dates = start ? (end && end.getTime() !== start.getTime() ? `${format(start, false)} – ${format(end, true)}` : format(start, true)) : undefined;
    const website = claim(entity, 'P856');
    return {
        name: entity.labels?.en?.value ?? hit.label,
        location,
        dates,
        website: typeof website === 'string' ? website : undefined,
        wikidata: hit.id,
    };
}
// ------------------------------------------------------------------ venue ---
const countryName = (code) => {
    if (!code)
        return undefined;
    try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    }
    catch {
        return code.toUpperCase();
    }
};
function placementOf(biblio) {
    if (!biblio)
        return undefined;
    const pages = biblio.first_page ? (biblio.last_page && biblio.last_page !== biblio.first_page ? `pp. ${biblio.first_page}–${biblio.last_page}` : `p. ${biblio.first_page}`) : '';
    return [biblio.volume ? `Vol. ${biblio.volume}` : '', biblio.issue ? `issue ${biblio.issue}` : '', pages].filter(Boolean).join(', ') || undefined;
}
const KINDS = { journal: 'journal', conference: 'conference', repository: 'repository', 'book series': 'book series' };
const venues = new Map();
/** Everything the card says about the venue of the open paper. */
export function venueDetails(paper) {
    return remembered(venues, `${paper.id}|${paper.venue}`, () => findVenue(paper));
}
async function findVenue(paper) {
    const printed = paper.venue.replace(/…/g, '').trim();
    const work = await workOf(paper).catch(() => null);
    let stub = work ? sourceOf(work) : undefined;
    // The paper's record is in another venue — a preprint's, a later edition's — or there is none.
    if (stub && printed && !venueFits(stub.display_name || '', printed) && !acronymIn(printed))
        stub = undefined;
    if (!stub && printed)
        stub = (await sourceByName(printed).catch(() => null)) ?? undefined;
    const source = stub ? await openAlex(`sources/${shortId(stub.id)}`).catch(() => null) : null;
    const record = source ?? stub;
    const name = record?.display_name || printed;
    let kind = (record?.type && KINDS[record.type]) || 'venue';
    if (kind === 'venue' && (CONFERENCE.test(printed) || acronymIn(printed)))
        kind = 'conference';
    if (kind === 'venue' && (/\b(journal|transactions|letters|review|annals|bulletin)\b/i.test(printed) || record?.issn_l))
        kind = 'journal';
    const year = paper.year ?? (work?.publication_date ? Number(work.publication_date.slice(0, 4)) : undefined);
    const wikidata = source?.ids?.wikidata?.replace(/^https?:\/\/www\.wikidata\.org\/entity\//, '');
    const [wiki, conference] = await Promise.all([
        wikidata ? wikipedia(wikidata).catch(() => null) : Promise.resolve(null),
        kind === 'conference' || acronymIn(printed) || acronymIn(name) ? fromDblp(acronymIn(printed) ? printed : name, year).catch(() => null) : Promise.resolve(null),
    ]);
    let event = conference?.event;
    const acronym = conference?.acronym;
    if (acronym && year && (!event?.location || !event.dates)) {
        const wiki = await fromWikidata(acronym, year).catch(() => null);
        if (wiki)
            event = { ...wiki, ...Object.fromEntries(Object.entries(event ?? {}).filter(([, value]) => value)) };
    }
    if (event)
        kind = 'conference';
    return {
        name,
        kind,
        abbreviation: source?.abbreviated_title || acronym || undefined,
        publisher: record?.host_organization_name || undefined,
        country: countryName(source?.country_code),
        issn: record?.issn_l || record?.issn?.[0] || undefined,
        homepage: source?.homepage_url || undefined,
        openAlexId: record ? shortId(record.id) : undefined,
        worksCount: source?.works_count,
        citedBy: source?.cited_by_count,
        hIndex: source?.summary_stats?.h_index,
        meanCitedness: source?.summary_stats?.['2yr_mean_citedness'],
        openAccess: source?.is_oa || undefined,
        inDoaj: source?.is_in_doaj || undefined,
        placement: stub && work && sourceOf(work)?.id === stub.id ? placementOf(work.biblio) : undefined,
        publishedOn: work?.publication_date || undefined,
        wikipedia: wiki ?? undefined,
        dblpUrl: conference?.seriesUrl,
        event,
    };
}
