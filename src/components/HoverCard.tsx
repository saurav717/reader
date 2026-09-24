import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PaperRef } from '../types';
import {
  authorDetails,
  profilesElsewhere,
  resolveReference,
  scholarProfile,
  worksUnderName,
  type AuthorDetails,
  type Elsewhere,
  type OtherWork,
  type ScholarFind,
} from '../lib/hoverInfo';
import { scholarAuthorUrl, scholarPaperUrl } from '../lib/locations';
import { parseReference } from '../lib/citations';
import { hasProxy } from '../lib/api';
import { ExternalIcon, SearchIcon } from './icons';

/** A bibliography entry a citation names: its id in the paper, its number or label, its text. */
export interface CitedEntry {
  id: string;
  label: string;
  text: string;
}

/** Where the card points, and at what. `anchor` is in the window's coordinates. */
export type HoverTarget =
  | { kind: 'author'; name: string; position: number; anchor: DOMRect }
  | { kind: 'cite'; entries: CitedEntry[]; anchor: DOMRect };

export interface PaperKey {
  id: string;
  title: string;
  doi?: string;
  arxivId?: string;
  year?: number;
}

interface Props {
  target: HoverTarget;
  paper: PaperKey;
  /** Held open while the pointer is over the card, and let go when it leaves. */
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  /** Scroll the paper to an entry of its bibliography. */
  onJump: (id: string) => void;
}

const WIDTH = 380;
const GAP = 8;

/**
 * Ask the Discover panel to search for something — a paper's title, or
 * `author:` a person. `open` is the title of the paper wanted, whose result
 * is opened to show its details once the search is in.
 */
export function discover(query: string, open?: string): void {
  window.dispatchEvent(new CustomEvent('reader:discover', { detail: { query, open } }));
}

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
      : String(value);

const yearOf = (published: string) => /^\d{4}/.exec(published || '')?.[0] ?? '';

const byline = (authors: string[]) =>
  authors.length > 4 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', ');

/**
 * The card that opens over an author's name or a citation. It is placed
 * under what it points at, or over it when there is no room below, and kept
 * inside the window; it follows no scrolling — a scroll closes it.
 */
export default function HoverCard({ target, paper, onEnter, onLeave, onClose, onJump }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; above: boolean }>({ top: -9999, left: -9999, above: false });

  // Placed once it can be measured, and again as what it says arrives and
  // it grows — a card shown over its anchor grows upwards, away from it.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={box}
      className={`hover-card${place.above ? ' above' : ''}`}
      role="dialog"
      aria-label={target.kind === 'author' ? `About ${target.name}` : 'The cited paper'}
      style={{ top: place.top, left: place.left, width: Math.min(WIDTH, window.innerWidth - 24) }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {target.kind === 'author' ? (
        <AuthorCard name={target.name} position={target.position} paper={paper} />
      ) : (
        <CiteCard entries={target.entries} onJump={onJump} />
      )}
    </div>
  );
}

/** A promise's answer as state: undefined while it is being asked. */
function useAnswer<T>(ask: () => Promise<T>, key: string): T | undefined | null {
  const [answer, setAnswer] = useState<{ key: string; value: T | null } | null>(null);
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

function AuthorCard({ name, position, paper }: { name: string; position: number; paper: PaperKey }) {
  const answer = useAnswer<AuthorDetails>(() => authorDetails(name, position, paper), `${paper.id}|${position}|${name}`);
  // A lookup that failed outright reads as one that found nobody.
  const details = useMemo<AuthorDetails | undefined>(
    () => (answer === null ? { name, via: 'none', topics: [], topWorks: [] } : answer),
    [answer, name],
  );
  // Asked alongside OpenAlex, not after it: it goes by the paper, not by the record.
  const elsewhere = useAnswer<Elsewhere>(() => profilesElsewhere(name, paper), `${paper.id}|${name}`);
  const [scholar, setScholar] = useState<ScholarFind | undefined>(undefined);
  useEffect(() => {
    if (details === undefined) return;
    let live = true;
    setScholar(undefined);
    const places = [details?.affiliationHere, details?.affiliation].filter((place): place is string => Boolean(place));
    // A lone profile with the name is theirs only when OpenAlex tied this very person to the paper.
    const tied = details.via === 'paper' && !details.mistaken;
    const fullNames = details.fullName && !details.mistaken ? [details.fullName] : [];
    void scholarProfile(name, { places, fullNames, loneOk: tied, paper, position })
      .catch((error): ScholarFind => ({ profile: null, confirmed: false, error: error instanceof Error ? error.message : String(error) }))
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
    ? { citedBy: profile!.citedBy, hIndex: profile!.hIndex, i10Index: profile!.i10Index, worksCount: undefined, from: 'Google Scholar' }
    : { citedBy: details?.citedBy, hIndex: details?.hIndex, i10Index: details?.i10Index, worksCount: details?.worksCount, from: 'OpenAlex' };
  const topWorks: OtherWork[] = profile?.works.length
    ? profile.works.slice(0, 3).map((work) => ({ title: work.title, year: Number(yearOf(work.published)) || undefined, citedBy: work.citedBy }))
    : (details?.topWorks ?? []).map((work) => ({ title: work.title, year: Number(yearOf(work.published)) || undefined, citedBy: work.citedBy }));

  // A record of their own at OpenAlex that is plainly them counts as a profile.
  const ownRecord = details?.openAlexId !== undefined && details.via === 'paper';
  const pages = elsewhere?.profiles ?? [];
  const settled = details !== undefined && elsewhere !== undefined && !scholarAsking;
  const nowhere = settled && !profile && !likely && !scholar?.error && !ownRecord && !details?.orcid && !pages.length;
  const namesake = useAnswer<OtherWork[]>(
    () => (nowhere ? worksUnderName(name, paper) : Promise.resolve([])),
    `${paper.id}|${name}|${nowhere}`,
  );

  const now = details?.affiliation && details.affiliation !== details.affiliationHere ? details.affiliation : undefined;
  const interests = profile?.interests?.length ? profile.interests : details?.topics ?? [];
  const who = [elsewhere?.fullName, elsewhere?.lived].filter(Boolean).join(', ');
  // Their books from Open Library stand in for OpenAlex's list when OpenAlex has none that are theirs.
  const otherWorks = topWorks.length ? [] : elsewhere?.works ?? [];

  // Every page of theirs, as a row of buttons under the name: the profile
  // that is plainly theirs first, a likely one marked as that, and a search
  // of Scholar for the name where no profile is known.
  const profileLinks: { site: string; url: string; title: string; guess?: boolean }[] = [];
  if (profile?.scholarProfileUrl) profileLinks.push({ site: 'Google Scholar', url: profile.scholarProfileUrl, title: 'Their Google Scholar profile' });
  else if (likely?.scholarProfileUrl)
    profileLinks.push({ site: 'Google Scholar?', url: likely.scholarProfileUrl, title: `Possibly theirs — ${likely.name}${likely.affiliation ? `, ${likely.affiliation}` : ''} — but it does not list this paper`, guess: true });
  if (profile?.homepage) profileLinks.push({ site: 'Homepage', url: profile.homepage, title: 'The homepage their Scholar profile links to' });
  if (details?.orcid) profileLinks.push({ site: 'ORCID', url: `https://orcid.org/${details.orcid}`, title: 'Their ORCID record' });
  if (details?.openAlexId)
    profileLinks.push({
      site: details.via === 'paper' ? 'OpenAlex' : 'OpenAlex?',
      url: `https://openalex.org/authors/${details.openAlexId}`,
      title: details.via === 'paper' ? 'The record OpenAlex files this paper under' : 'Found by the name alone — it may be someone else of the name',
      guess: details.via !== 'paper',
    });
  for (const page of pages) profileLinks.push({ site: page.site, url: page.url, title: `Their page on ${page.site}` });
  if (!profile && !likely && !scholarAsking)
    profileLinks.push({ site: 'Search Scholar', url: scholarAuthorUrl(details?.fullName ?? name), title: 'Search Google Scholar for the name', guess: true });

  return (
    <>
      <div className="hc-head">
        <p className="hc-name">{name}</p>
        {who ? <p className="hc-sub">{who}</p> : null}
        {elsewhere?.description ? <p className="hc-sub">{elsewhere.description}</p> : null}
        {details?.affiliationHere ? <p className="hc-sub">{details.affiliationHere}</p> : null}
        {now ? <p className="hc-sub">Now at {now}</p> : null}
        {!details?.affiliationHere && !now && profile?.affiliation ? <p className="hc-sub">{profile.affiliation}</p> : null}
        {profileLinks.length || scholarAsking || elsewhere === undefined ? (
          <div className="hc-profiles" aria-label="Their profiles">
            {profileLinks.map((link) => (
              <a key={link.site} className={`hc-profile${link.guess ? ' guess' : ''}`} href={link.url} target="_blank" rel="noreferrer noopener" title={link.title}>
                {link.site} <ExternalIcon size={9} />
              </a>
            ))}
            {scholarAsking || elsewhere === undefined ? (
              <span className="hc-profile pending" title="Looking for their profiles">
                <span className="spinner" />
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {details === undefined ? (
        <p className="hc-loading">
          <span className="spinner" /> Looking them up…
        </p>
      ) : (
        <>
          {(stats.citedBy !== undefined || stats.hIndex !== undefined) && !(scholarAsking && !scholarStats) ? (
            <>
              <dl className="hc-stats" aria-label={`Counts from ${stats.from}`}>
                {stats.citedBy !== undefined ? (
                  <div>
                    <dt>Citations</dt>
                    <dd>{compact(stats.citedBy)}</dd>
                  </div>
                ) : null}
                {stats.hIndex !== undefined ? (
                  <div>
                    <dt>h-index</dt>
                    <dd>{stats.hIndex}</dd>
                  </div>
                ) : null}
                {stats.i10Index !== undefined ? (
                  <div>
                    <dt>i10-index</dt>
                    <dd>{stats.i10Index}</dd>
                  </div>
                ) : null}
                {stats.worksCount !== undefined ? (
                  <div>
                    <dt>Papers</dt>
                    <dd>{compact(stats.worksCount)}</dd>
                  </div>
                ) : null}
              </dl>
              <p className="hc-from">
                Counts from {stats.from}
                {!scholarStats && profile === null && !scholar?.error && hasProxy() ? ' — it can miss papers filed under another spelling of the name' : ''}
              </p>
            </>
          ) : null}

          {elsewhere?.about ? <p className="hc-about">{elsewhere.about}</p> : null}

          {profile ? (
            profile.verifiedEmail ? <p className="hc-scholar muted">Google Scholar: verified email at {profile.verifiedEmail}</p> : null
          ) : scholarAsking ? (
            <p className="hc-scholar muted">
              <span className="spinner" /> Asking Google Scholar…
            </p>
          ) : likely ? (
            <p className="hc-scholar muted">
              The Google Scholar profile of the name ({likely.name}
              {likely.affiliation ? `, ${likely.affiliation}` : ''}) does not list this paper, so it may not be theirs and its counts are not shown.
            </p>
          ) : scholar?.error ? (
            <p className="hc-scholar muted">Google Scholar could not be asked — {scholar.error.replace(/\.$/, '')}.</p>
          ) : hasProxy() ? (
            <p className="hc-scholar muted">No Google Scholar profile lists this paper as theirs.</p>
          ) : null}

          {interests.length ? (
            <div className="hc-chips" aria-label={profile?.interests?.length ? 'Interests on Google Scholar' : 'Topics'}>
              {interests.slice(0, 5).map((interest) => (
                <span key={interest} className="hc-chip">
                  {interest}
                </span>
              ))}
            </div>
          ) : null}

          {topWorks.length ? <WorkList label="Most cited" works={topWorks} /> : null}
          {otherWorks.length ? <WorkList label="Other works" works={otherWorks} /> : null}

          {details.mistaken ? (
            <p className="hc-note">
              OpenAlex files this paper under{' '}
              <a href={`https://openalex.org/authors/${details.mistaken.openAlexId}`} target="_blank" rel="noreferrer noopener">
                a record
              </a>
              {details.mistaken.affiliation ? ` at ${details.mistaken.affiliation}` : ''} that is not them — {details.mistaken.reason} — so
              none of it is shown here.
            </p>
          ) : null}

          {nowhere ? (
            <>
              <p className="hc-note">
                No registered profile of theirs was found — not on Google Scholar, OpenAlex, ORCID, Wikipedia or Open Library.
              </p>
              {namesake === undefined ? (
                <p className="hc-loading">
                  <span className="spinner" /> Finding their other work…
                </p>
              ) : namesake?.length ? (
                <>
                  <WorkList label="Other works under the name" works={namesake} />
                  <p className="hc-note">Found by the name alone — some may be a namesake's.</p>
                </>
              ) : null}
            </>
          ) : details.via === 'name' && !details.mistaken ? (
            <p className="hc-note">Found by the name alone, not through this paper — it may be someone else of that name.</p>
          ) : details.via === 'none' && !pages.length && settled && !profile ? (
            <p className="hc-note">No index has a record of this person that could be told apart from others of the name.</p>
          ) : null}
        </>
      )}

      <div className="hc-links">
        <button type="button" className="hc-action" onClick={() => discover(`author:${elsewhere?.fullName ?? name}`)}>
          <SearchIcon size={11} /> All their papers
        </button>
      </div>
    </>
  );
}

/** A short list of someone's works, each one a search for it in Discover. */
function WorkList({ label, works }: { label: string; works: OtherWork[] }) {
  return (
    <div className="hc-works">
      <p className="hc-label">{label}</p>
      <ul>
        {works.map((work) => (
          <li key={`${work.title}|${work.year ?? ''}`}>
            <button type="button" className="hc-work" onClick={() => discover(`"${work.title}"`)} title="Find it in Discover">
              {work.title}
            </button>
            <span className="hc-meta">
              {[
                work.year ? String(work.year) : '',
                work.citedBy !== undefined ? `${compact(work.citedBy)} citations` : '',
                work.editions ? `${work.editions} edition${work.editions === 1 ? '' : 's'}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------- citation ---

function CiteCard({ entries, onJump }: { entries: CitedEntry[]; onJump: (id: string) => void }) {
  const [current, setCurrent] = useState(0);
  const entry = entries[Math.min(current, entries.length - 1)];
  const paper = useAnswer<PaperRef | null>(() => resolveReference(entry.text), entry.text);

  const jump = useCallback(() => onJump(entry.id), [entry.id, onJump]);
  // The card is a way into Discover: pressed, it looks the paper up there
  // and opens its result, where it can be read about, added and opened.
  const find = useCallback(() => {
    const found = paper?.title?.trim();
    const title = found || parseReference(entry.text).title;
    discover(found ? `"${found}"` : title ?? entry.text.slice(0, 200), title);
  }, [entry.text, paper]);
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    find();
  };

  return (
    <>
      <div className="hc-head hc-row">
        <p className="hc-kicker">{entries.length > 1 ? `${entries.length} references` : `Reference ${entry.label}`}</p>
        <button type="button" className="hc-action" onClick={jump} title="Go to the entry in the bibliography">
          In the bibliography ↓
        </button>
      </div>
      {entries.length > 1 ? (
        <div className="hc-tabs" role="tablist">
          {entries.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={index === current}
              onClick={() => setCurrent(index)}
              onMouseEnter={() => setCurrent(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <p className="hc-printed hc-find" role="button" tabIndex={0} onClick={find} onKeyDown={onKey} title="Find it in Discover">
        {entry.text}
      </p>

      {paper === undefined ? (
        <p className="hc-loading">
          <span className="spinner" /> Finding the paper…
        </p>
      ) : paper ? (
        <div className="hc-paper hc-find" role="button" tabIndex={0} onClick={find} onKeyDown={onKey} title="Find it in Discover and show its details">
          <p className="hc-title">
            {paper.landingUrl ? (
              <a href={paper.landingUrl} target="_blank" rel="noreferrer noopener" onClick={(event) => event.stopPropagation()}>
                {paper.title}
              </a>
            ) : (
              paper.title
            )}
          </p>
          {paper.authors.length ? <p className="hc-sub">{byline(paper.authors)}</p> : null}
          <p className="hc-meta">
            {[paper.venue, yearOf(paper.published), paper.citedBy !== undefined ? `cited by ${compact(paper.citedBy)}` : '']
              .filter(Boolean)
              .join(' · ')}
          </p>
          {paper.abstract ? <p className="hc-abstract">{paper.abstract}</p> : null}
        </div>
      ) : (
        <p className="hc-note">None of the indexes has a record that is plainly this entry.</p>
      )}

      <div className="hc-links">
        {paper?.pdfUrl ? (
          <a href={paper.pdfUrl} target="_blank" rel="noreferrer noopener">
            PDF <ExternalIcon size={10} />
          </a>
        ) : null}
        {paper?.arxivId ? (
          <a href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noreferrer noopener">
            arXiv <ExternalIcon size={10} />
          </a>
        ) : null}
        {paper?.doi ? (
          <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer noopener">
            DOI <ExternalIcon size={10} />
          </a>
        ) : null}
        <a
          href={paper ? scholarPaperUrl(paper) : `https://scholar.google.com/scholar?q=${encodeURIComponent(entry.text.slice(0, 250))}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Google Scholar <ExternalIcon size={10} />
        </a>
        <button
          type="button"
          className="hc-action"
          onClick={find}
          title="Search for it in Discover, where it can be added and read"
        >
          <SearchIcon size={11} /> Add or read
        </button>
      </div>
    </>
  );
}
