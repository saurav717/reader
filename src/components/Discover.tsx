import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import {
  arxivIdFromQuery,
  authorSources,
  defaultSources,
  lookupArxiv,
  PAGE_SIZE,
  papersByAuthor,
  search,
  searchAuthors,
  searchByAuthorName,
  sourceList,
} from '../lib/sources';
import { hasProxy, NO_PROXY_FIX, NO_PROXY_REASON } from '../lib/api';
import {
  findLocations,
  scholarAuthorPapersUrl,
  scholarAuthorUrl,
  scholarPaperUrl,
} from '../lib/locations';
import { fetchPdfFromLocations } from '../lib/pdf';
import { whySaveToDriveUnavailable } from '../lib/driveSync';
import type { AuthorRef, PaperLocation, PaperRef, SearchMode, SourceId } from '../types';
import { CheckIcon, CloseIcon, ExternalIcon, PlusIcon, SearchIcon } from './icons';

interface Props {
  onClose: () => void;
  onOpen: (paperId: string) => void;
}

type SourceError = { source: SourceId; message: string };

const labelFor = (id: SourceId) => sourceList().find((source) => source.id === id)?.label ?? id;

/**
 * Only one result is ever expanded, so the line explaining a greyed-out
 * **Save to Drive** exists at most once and can be named once.
 */
const SAVE_BLOCKED_ID = 'discover-save-blocked';

const compact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

/** `acceptedVersion` -> `accepted`, which is all a reader needs from it. */
const versionLabel = (version?: string) =>
  version ? version.replace(/Version$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : '';

/**
 * Everywhere this paper can be read, which is the question a search result
 * cannot answer on its own: a result carries at most one link, and whether that
 * link is a file or a login wall is not knowable until it is asked. Google
 * Scholar answers it with "All 14 versions"; this is the same list, built from
 * the indexes that publish one, with a link to Scholar's own for comparison.
 */
function Locations({ paper }: { paper: PaperRef }) {
  const [locations, setLocations] = useState<PaperLocation[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLocations(null);
    setFailed(false);
    findLocations(paper, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setLocations(found);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFailed(true);
      });
    return () => controller.abort();
    // The identity of the paper is what decides where its copies are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.id]);

  const files = (locations || []).filter((location) => location.isPdf);
  const scholar = (
    <a className="loc-scholar" href={scholarPaperUrl(paper)} target="_blank" rel="noreferrer noopener">
      Google Scholar <ExternalIcon size={10} />
    </a>
  );

  return (
    <div className="locations">
      <p className="eyebrow">
        {locations === null && !failed
          ? 'Looking for every copy…'
          : failed
            ? 'Could not check where else this is published'
            : (locations?.length ?? 0)
              ? `Readable in ${locations?.length} ${locations?.length === 1 ? 'place' : 'places'}` +
                (files.length ? ` · ${files.length} as a file` : ' · none of them a file')
              : 'No copy of this found anywhere we can see'}
      </p>
      <ul>
        {(locations || []).slice(0, 6).map((location) => (
          <li key={location.url}>
            <a href={location.url} target="_blank" rel="noreferrer noopener" title={location.url}>
              {location.label}
            </a>
            <span className={location.isPdf ? 'loc-pdf' : 'loc-page'}>{location.isPdf ? 'PDF' : 'page'}</span>
            {location.version ? <span className="loc-version">{versionLabel(location.version)}</span> : null}
          </li>
        ))}
      </ul>
      {locations && locations.length > 6 ? (
        <p className="eyebrow">and {locations.length - 6} more</p>
      ) : null}
      <p className="eyebrow">Also on {scholar}</p>
    </div>
  );
}

export default function Discover({ onClose, onOpen }: Props) {
  const { papers, collections, addPaper, createCollection, driveConnected, syncPaperNow } = useStore();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('papers');
  const [sources, setSources] = useState<SourceId[]>(defaultSources);
  const [results, setResults] = useState<PaperRef[]>([]);
  const [authors, setAuthors] = useState<AuthorRef[]>([]);
  const [viewing, setViewing] = useState<AuthorRef | null>(null);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(0);
  const [target, setTarget] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  /** The paper currently being fetched and put in Drive, and how far it is. */
  const [saving, setSaving] = useState<{ id: string; step: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!target && collections.length) setTarget(collections[0].id);
  }, [collections, target]);

  // Configuring a proxy in Settings puts arXiv within reach without a reload,
  // so the selection follows it rather than staying on the static-host set.
  const proxyReady = hasProxy();
  const firstSources = useRef(true);
  useEffect(() => {
    if (firstSources.current) {
      firstSources.current = false;
      return;
    }
    setSources(defaultSources());
  }, [proxyReady]);

  const begin = () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setErrors([]);
    return controller;
  };

  const finish = (controller: AbortController) => {
    if (abort.current === controller) setBusy(false);
  };

  const fail = (error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    setErrors([{ source: sources[0] ?? 'openalex', message: error instanceof Error ? error.message : String(error) }]);
  };

  /** Papers matching a topic, a title, or an arXiv id. */
  const runPapers = useCallback(
    async (text: string) => {
      const controller = begin();
      setViewing(null);
      setAuthors([]);
      setPage(0);
      try {
        const directId = arxivIdFromQuery(text);
        if (directId && hasProxy() && sources.includes('arxiv')) {
          const direct = await lookupArxiv(directId, controller.signal);
          if (direct.length) {
            setResults(direct);
            setMore(false);
            return;
          }
        }
        const outcome = await search(text, sources, { signal: controller.signal, page: 0 });
        setResults(outcome.results);
        setErrors(outcome.errors);
        setMore(!outcome.exhausted);
      } catch (error) {
        fail(error);
      } finally {
        finish(controller);
      }
    },
    [sources],
  );

  /** People matching a name. */
  const runAuthors = useCallback(
    async (text: string) => {
      const controller = begin();
      setViewing(null);
      setResults([]);
      setPage(0);
      setMore(false);
      try {
        const outcome = await searchAuthors(text, sources, { signal: controller.signal });
        setAuthors(outcome.authors);
        setErrors(outcome.errors);
        // Nobody by that name has a record in either index — which is the
        // normal case for anyone who is not a prolific author. Rather than an
        // empty panel, go straight to the broader search: every paper with the
        // name on it, across every source.
        if (!outcome.authors.length) {
          const byName = await searchByAuthorName(text, sources, { signal: controller.signal, page: 0 });
          setResults(byName.results);
          setMore(!byName.exhausted);
          if (byName.errors.length) setErrors(byName.errors);
        }
      } catch (error) {
        fail(error);
      } finally {
        finish(controller);
      }
    },
    [sources],
  );

  /** Everything one chosen person has written. */
  const openAuthor = useCallback(
    async (author: AuthorRef) => {
      const controller = begin();
      setViewing(author);
      setPage(0);
      try {
        const found = await papersByAuthor(author, { signal: controller.signal, page: 0 });
        setResults(found);
        setMore(found.length >= PAGE_SIZE);
      } catch (error) {
        fail(error);
      } finally {
        finish(controller);
      }
    },
    [],
  );

  /**
   * The fallback when none of the author records is the right person: match on
   * the name across every source's author field instead of on an identifier.
   */
  const runByName = useCallback(
    async (text: string) => {
      const controller = begin();
      setViewing(null);
      setAuthors([]);
      setPage(0);
      try {
        const outcome = await searchByAuthorName(text, sources, { signal: controller.signal, page: 0 });
        setResults(outcome.results);
        setErrors(outcome.errors);
        setMore(!outcome.exhausted);
      } catch (error) {
        fail(error);
      } finally {
        finish(controller);
      }
    },
    [sources],
  );

  const loadMore = useCallback(async () => {
    const controller = begin();
    const next = page + 1;
    try {
      const found = viewing
        ? await papersByAuthor(viewing, { signal: controller.signal, page: next })
        : (await search(query, sources, { signal: controller.signal, page: next })).results;
      // The merge is per-page, so a paper already on screen is dropped rather
      // than shown twice when two pages overlap.
      setResults((current) => {
        const seen = new Set(current.map((paper) => paper.id));
        return [...current, ...found.filter((paper) => !seen.has(paper.id))];
      });
      setMore(found.length >= PAGE_SIZE);
      setPage(next);
    } catch (error) {
      fail(error);
    } finally {
      finish(controller);
    }
  }, [page, query, sources, viewing]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    void (mode === 'authors' ? runAuthors(query) : runPapers(query));
  };

  const toggleSource = (id: SourceId) => {
    setSources((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const add = async (ref: PaperRef, options: { sync?: boolean } = {}) => {
    let collectionId = target;
    if (!collectionId) collectionId = (await createCollection('Reading list')).id;
    return addPaper(ref, collectionId, options);
  };

  /**
   * Find the file, put it in Drive, then open it — in that order, so what the
   * viewer shows is the copy that was saved rather than a second download of
   * the same paper. Each copy the indexes know about is tried until one
   * answers, which is what makes this work for papers that are not on arXiv.
   */
  const saveToDrive = async (ref: PaperRef) => {
    setSaveError(null);
    setSaving({ id: ref.id, step: 'Finding a copy…' });
    try {
      // Added without its automatic sync: that would start fetching the same
      // PDF in parallel with the fetch below, and the paper would come down
      // the wire twice.
      await add(ref, { sync: false });
      const locations = await findLocations(ref);
      setSaving({ id: ref.id, step: 'Downloading…' });
      const fetched = await fetchPdfFromLocations(ref, locations);
      setSaving({ id: ref.id, step: `Saving to Drive from ${fetched.location.label}…` });
      await syncPaperNow(ref.id, { pdf: fetched.blob });
      onOpen(ref.id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  };

  // Kept on the result rather than taken off it when it cannot run: a button
  // that disappears looks like a feature this app never had, and the question
  // it leaves behind — the copies are listed right here, why can none of them
  // be saved? — is the one thing the panel is in a position to answer.
  const saveBlocked = whySaveToDriveUnavailable({ driveConnected, proxyReady });

  const visibleSources = mode === 'authors' ? authorSources() : sourceList();
  const noSources = !sources.some((id) => visibleSources.some((source) => source.id === id));

  return (
    <aside className="panel discover-panel" aria-label="Discover">
      <div className="panel-head">
        <h2>Discover</h2>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the discover panel">
          <CloseIcon size={17} />
        </button>
      </div>

      <div style={{ padding: '0 16px 10px' }}>
        <div className="segmented" role="group" aria-label="What to search for">
          <button type="button" aria-pressed={mode === 'papers'} onClick={() => setMode('papers')}>
            Papers
          </button>
          <button type="button" aria-pressed={mode === 'authors'} onClick={() => setMode('authors')}>
            Authors
          </button>
        </div>
      </div>

      <form style={{ padding: '0 16px 12px' }} onSubmit={submit}>
        <label className="vh" htmlFor="discover-query">
          {mode === 'authors' ? 'Search for a person' : 'Search papers'}
        </label>
        <div className="field">
          <SearchIcon size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input
            id="discover-query"
            type="search"
            value={query}
            placeholder={mode === 'authors' ? 'Author name' : 'Title, topic, "exact phrase" or arXiv id'}
            onChange={(event) => setQuery(event.target.value)}
          />
          {busy ? <span className="spinner" aria-label="Searching" /> : null}
        </div>
      </form>

      <div style={{ padding: '0 16px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {visibleSources.map((source) => (
          <button
            key={source.id}
            type="button"
            className="chip"
            aria-pressed={sources.includes(source.id)}
            onClick={() => toggleSource(source.id)}
          >
            {source.label}
          </button>
        ))}
      </div>

      <div style={{ padding: '0 16px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor="discover-target" style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>
          Add to
        </label>
        <select
          id="discover-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          style={{
            flexGrow: 1,
            minWidth: 0,
            height: 30,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            fontSize: 12.5,
            padding: '0 8px',
          }}
        >
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
      </div>

      {sources.includes('scholar') ? (
        <p style={{ padding: '0 16px 10px', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55 }}>
          Google Scholar publishes no API, so the proxy opens its pages the way you would. It finds what the
          other indexes have no record of — theses, reports, a person's own copy — and lists every version of a
          paper. It also refuses a server far more readily than a person: if it answers with a captcha, that is
          what has happened, and the other sources carry on.
        </p>
      ) : null}

      {noSources ? (
        <p className="banner warn" style={{ margin: '0 16px 12px' }}>
          No sources are selected, so there is nothing to search. Turn at least one on above.
        </p>
      ) : null}

      {!hasProxy() ? (
        <p className="banner warn" style={{ margin: '0 16px 12px' }}>
          {NO_PROXY_REASON} OpenAlex, Semantic Scholar and Crossref all index arXiv, so most papers are still
          here — you just get the abstract rather than the full text. {NO_PROXY_FIX}
        </p>
      ) : null}

      {errors.length ? (
        <div style={{ padding: '0 16px 12px' }}>
          {errors.map((error) => (
            <p
              key={error.source}
              className={`banner ${error.source === 'scholar' ? 'warn' : 'error'}`}
              style={{ marginTop: 0, marginBottom: 6 }}
            >
              {labelFor(error.source)}: {error.message}
              {error.source === 'scholar' && results.length ? ' The results below are from the other sources.' : ''}
            </p>
          ))}
        </div>
      ) : null}

      {viewing ? (
        <div style={{ padding: '0 16px 10px' }}>
          <button type="button" className="btn sm" onClick={() => void runAuthors(query)}>
            ← Back to people
          </button>
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--ink-2)' }}>
            Papers by <strong style={{ fontWeight: 600 }}>{viewing.name}</strong>
            {viewing.affiliation ? ` · ${viewing.affiliation}` : ''}
          </p>
        </div>
      ) : null}

      <div className="scroll" style={{ padding: '0 8px 16px' }}>
        {!results.length && !authors.length && !busy && !noSources ? (
          <p style={{ padding: '10px 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {mode === 'authors'
              ? 'Find a person, then open everything they have written. OpenAlex and Semantic Scholar each keep their own author records, so the same person can appear twice.'
              : hasProxy()
                ? 'Search arXiv, OpenAlex, Semantic Scholar and Crossref at once, merged into one ranked list. Quote a phrase to match it exactly, or paste an arXiv id to jump straight to a paper.'
                : 'Search OpenAlex, Semantic Scholar and Crossref, all of which index arXiv.'}
          </p>
        ) : null}

        {mode === 'authors' && !viewing
          ? authors.map((author) => (
              <article key={author.id} className="result">
                <button
                  type="button"
                  onClick={() => void openAuthor(author)}
                  style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
                >
                  <h3>{author.name}</h3>
                  {author.affiliation ? <p className="authors">{author.affiliation}</p> : null}
                  <div className="meta">
                    <span>{labelFor(author.source)}</span>
                    {author.worksCount ? <span>{compact(author.worksCount)} papers</span> : null}
                    {author.citedBy ? <span>{compact(author.citedBy)} citations</span> : null}
                    {author.hIndex ? <span>h-index {author.hIndex}</span> : null}
                    {author.orcid ? <span className="mono">ORCID {author.orcid}</span> : null}
                    {author.verifiedEmail ? <span>verified at {author.verifiedEmail}</span> : null}
                  </div>
                </button>
                {author.interests?.length ? (
                  <p className="authors" style={{ margin: '2px 0 4px' }}>
                    {author.interests.slice(0, 4).join(' · ')}
                  </p>
                ) : null}
                <a
                  className="loc-scholar"
                  href={author.scholarProfileUrl || scholarAuthorUrl(author.name)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {author.scholarProfileUrl ? 'Their Google Scholar profile' : 'Look them up on Google Scholar'}{' '}
                  <ExternalIcon size={10} />
                </a>
              </article>
            ))
          : null}

        {mode === 'authors' && !viewing && query.trim() && !busy ? (
          <p className="author-advice" style={{ padding: '4px 10px 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            {authors.length ? 'None of these the right person? ' : 'No index keeps a record under that name. '}
            <button
              type="button"
              className="linklike"
              onClick={() => void runByName(query)}
              style={{ all: 'unset', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {authors.length ? 'Search every paper with that name on it' : 'Search every paper with that name again'}
            </button>
            , or look them up{' '}
            <a className="loc-scholar" href={scholarAuthorPapersUrl(query.trim())} target="_blank" rel="noreferrer noopener">
              on Google Scholar <ExternalIcon size={10} />
            </a>
            .
          </p>
        ) : null}

        {results.map((result) => {
          const saved = papers.find((paper) => paper.id === result.id);
          const collectionName = saved?.collectionIds
            .map((id) => collections.find((collection) => collection.id === id)?.name)
            .filter(Boolean)[0];
          const isOpen = openId === result.id;
          return (
            <article key={result.id} className={`result ${isOpen ? 'is-open' : ''}`}>
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : result.id)}
                style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
                aria-expanded={isOpen}
              >
                <h3>{result.title}</h3>
                <p className="authors">
                  {result.authors.slice(0, 4).join(', ')}
                  {result.authors.length > 4 ? `, and ${result.authors.length - 4} more` : ''}
                </p>
                <div className="meta">
                  {result.arxivId ? <span className="mono">arXiv:{result.arxivId}</span> : null}
                  {result.published ? <span>{new Date(result.published).getFullYear() || ''}</span> : null}
                  {result.venue ? <span>{result.venue}</span> : null}
                  {result.citedBy ? <span>{compact(result.citedBy)} citations</span> : null}
                  {result.scholarVersions ? <span>{result.scholarVersions} versions</span> : null}
                  {saved ? (
                    <span className="pill-added">
                      <CheckIcon size={11} />
                      {collectionName ? `In ${collectionName}` : 'In library'}
                    </span>
                  ) : null}
                </div>
              </button>

              {isOpen ? (
                <>
                  {result.abstract ? (
                    <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)' }}>
                      {result.abstract.slice(0, 420)}
                      {result.abstract.length > 420 ? '…' : ''}
                    </p>
                  ) : null}
                  <Locations paper={result} />
                  <div className="result-actions">
                    <button type="button" className="btn primary sm" onClick={() => void add(result)}>
                      <PlusIcon size={14} />
                      {saved ? 'Add to this collection' : 'Add to collection'}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={async () => {
                        await add(result);
                        onOpen(result.id);
                      }}
                    >
                      Read
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={Boolean(saving) || Boolean(saveBlocked)}
                      aria-describedby={saveBlocked ? SAVE_BLOCKED_ID : undefined}
                      title={saveBlocked ?? undefined}
                      onClick={() => void saveToDrive(result)}
                    >
                      {saving?.id === result.id ? saving.step : 'Save to Drive'}
                    </button>
                    {result.landingUrl ? (
                      <a className="btn sm" href={result.landingUrl} target="_blank" rel="noreferrer noopener">
                        Source <ExternalIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                  {saveBlocked ? (
                    <p className="save-blocked" id={SAVE_BLOCKED_ID}>
                      {saveBlocked}
                    </p>
                  ) : null}
                  {saveError && saving?.id !== result.id && openId === result.id ? (
                    <p className="banner error" style={{ marginBottom: 0 }}>
                      {saveError}
                    </p>
                  ) : null}
                </>
              ) : null}
            </article>
          );
        })}

        {more && results.length && !busy ? (
          <div style={{ padding: '8px 10px' }}>
            <button type="button" className="btn sm" style={{ width: '100%' }} onClick={() => void loadMore()}>
              Load more
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
