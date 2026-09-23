import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AuthorRef, PaperRef } from '../types';
import { authorDetails, resolveReference, scholarProfile, type AuthorDetails } from '../lib/hoverInfo';
import { scholarAuthorUrl, scholarPaperUrl } from '../lib/locations';
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

/** Ask the Discover panel to search for something — a paper's title, or `author:` a person. */
export function discover(query: string): void {
  window.dispatchEvent(new CustomEvent('reader:discover', { detail: { query } }));
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
  const [profile, setProfile] = useState<AuthorRef | null | undefined>(undefined);
  useEffect(() => {
    if (details === undefined) return;
    let live = true;
    setProfile(undefined);
    const places = [details?.affiliationHere, details?.affiliation].filter((place): place is string => Boolean(place));
    void scholarProfile(name, places).then((found) => live && setProfile(found));
    return () => {
      live = false;
    };
  }, [details, name]);
  const scholarAsking = hasProxy() && details !== undefined && profile === undefined;

  const now = details?.affiliation && details.affiliation !== details.affiliationHere ? details.affiliation : undefined;
  const interests = profile?.interests?.length ? profile.interests : details?.topics ?? [];

  return (
    <>
      <div className="hc-head">
        <p className="hc-name">{name}</p>
        {details?.affiliationHere ? <p className="hc-sub">{details.affiliationHere}</p> : null}
        {now ? <p className="hc-sub">Now at {now}</p> : null}
        {!details?.affiliationHere && !now && profile?.affiliation ? <p className="hc-sub">{profile.affiliation}</p> : null}
      </div>

      {details === undefined ? (
        <p className="hc-loading">
          <span className="spinner" /> Looking them up…
        </p>
      ) : (
        <>
          {details.citedBy !== undefined || details.hIndex !== undefined ? (
            <dl className="hc-stats">
              {details.citedBy !== undefined ? (
                <div>
                  <dt>Citations</dt>
                  <dd>{compact(details.citedBy)}</dd>
                </div>
              ) : null}
              {details.hIndex !== undefined ? (
                <div>
                  <dt>h-index</dt>
                  <dd>{details.hIndex}</dd>
                </div>
              ) : null}
              {details.i10Index !== undefined ? (
                <div>
                  <dt>i10-index</dt>
                  <dd>{details.i10Index}</dd>
                </div>
              ) : null}
              {details.worksCount !== undefined ? (
                <div>
                  <dt>Papers</dt>
                  <dd>{compact(details.worksCount)}</dd>
                </div>
              ) : null}
            </dl>
          ) : details.via === 'none' ? (
            <p className="hc-note">No index has a record of this person that could be told apart from others of the name.</p>
          ) : null}

          {profile ? (
            <p className="hc-scholar">
              <a href={profile.scholarProfileUrl} target="_blank" rel="noreferrer noopener">
                Google Scholar profile <ExternalIcon size={10} />
              </a>
              {profile.citedBy !== undefined ? <span> · cited by {compact(profile.citedBy)}</span> : null}
              {profile.verifiedEmail ? <span> · verified email at {profile.verifiedEmail}</span> : null}
            </p>
          ) : scholarAsking ? (
            <p className="hc-scholar muted">
              <span className="spinner" /> Asking Google Scholar…
            </p>
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

          {details.topWorks.length ? (
            <div className="hc-works">
              <p className="hc-label">Most cited</p>
              <ul>
                {details.topWorks.map((work) => (
                  <li key={work.id}>
                    <button type="button" className="hc-work" onClick={() => discover(`"${work.title}"`)} title="Find it in Discover">
                      {work.title}
                    </button>
                    <span className="hc-meta">
                      {[yearOf(work.published), work.citedBy !== undefined ? `${compact(work.citedBy)} citations` : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {details.via === 'name' ? (
            <p className="hc-note">Found by the name alone, not through this paper — it may be someone else of that name.</p>
          ) : null}
        </>
      )}

      <div className="hc-links">
        {!profile ? (
          <a href={scholarAuthorUrl(name)} target="_blank" rel="noreferrer noopener">
            Google Scholar <ExternalIcon size={10} />
          </a>
        ) : null}
        {details?.orcid ? (
          <a href={`https://orcid.org/${details.orcid}`} target="_blank" rel="noreferrer noopener">
            ORCID <ExternalIcon size={10} />
          </a>
        ) : null}
        {details?.openAlexId ? (
          <a href={`https://openalex.org/authors/${details.openAlexId}`} target="_blank" rel="noreferrer noopener">
            OpenAlex <ExternalIcon size={10} />
          </a>
        ) : null}
        <button type="button" className="hc-action" onClick={() => discover(`author:${name}`)}>
          <SearchIcon size={11} /> All their papers
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------- citation ---

function CiteCard({ entries, onJump }: { entries: CitedEntry[]; onJump: (id: string) => void }) {
  const [current, setCurrent] = useState(0);
  const entry = entries[Math.min(current, entries.length - 1)];
  const paper = useAnswer<PaperRef | null>(() => resolveReference(entry.text), entry.text);

  const jump = useCallback(() => onJump(entry.id), [entry.id, onJump]);

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

      <p className="hc-printed">{entry.text}</p>

      {paper === undefined ? (
        <p className="hc-loading">
          <span className="spinner" /> Finding the paper…
        </p>
      ) : paper ? (
        <div className="hc-paper">
          <p className="hc-title">
            {paper.landingUrl ? (
              <a href={paper.landingUrl} target="_blank" rel="noreferrer noopener">
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
          onClick={() => discover(paper ? `"${paper.title}"` : entry.text.slice(0, 200))}
          title="Search for it in Discover, where it can be added and read"
        >
          <SearchIcon size={11} /> Add or read
        </button>
      </div>
    </>
  );
}
