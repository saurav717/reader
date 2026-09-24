import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import {
  arxivIdFromQuery,
  authorSources,
  defaultSources,
  lookupArxiv,
  nameInQuery,
  PAGE_SIZE,
  papersByAuthor,
  search,
  searchAuthors,
  searchByAuthorName,
  sourceError,
  sourceList,
  type SourceError,
} from '../lib/sources';
import { hasProxy, NO_PROXY_FIX, NO_PROXY_REASON } from '../lib/api';
import {
  findLocations,
  versionLabel,
  scholarAuthorPapersUrl,
  scholarAuthorUrl,
  scholarPaperUrl,
} from '../lib/locations';
import { fetchPdfFromLocations, PdfError, type SignInOffer } from '../lib/pdf';
import { judgePdf } from '../lib/paperContent';
import SignInPrompt from './SignInPrompt';
import CaptchaPrompt from './CaptchaPrompt';
import PdfDropIn from './PdfDropIn';
import { whySaveToDriveUnavailable } from '../lib/driveSync';
import { googleBook, googleBooksIdFromLink, linkFromQuery, paperFromLink } from '../lib/books';
import type { AuthorRef, PaperLocation, PaperOrder, PaperRef, SourceId } from '../types';
import { CheckIcon, CloseIcon, ExternalIcon, PlusIcon, SearchIcon } from './icons';

interface Props {
  onClose: () => void;
  onOpen: (paperId: string) => void;
  /** A search asked for from elsewhere — a card in the paper — run when it changes. */
  ask?: { query: string; at: number } | null;
  /** The collection on screen, which is where "Add to" points while it is. */
  here?: string;
  /** "Add papers" was pressed: put the cursor in the search box. `at` tells one press from the next. */
  focus?: number;
}

const labelFor = (id: SourceId) => sourceList().find((source) => source.id === id)?.label ?? id;

/**
 * Only one result is ever expanded, so the line explaining why adding a paper
 * will not put its file in Drive exists at most once and can be named once.
 */
const SAVE_BLOCKED_ID = 'discover-save-blocked';

const compact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

/** Further than this between press and release, and the gesture was a drag. */
const DRAG_SLOP = 4;

/**
 * The clickable top of a result card. It is not a `<button>` on purpose:
 * browsers do not let text inside a button be selected by dragging over it,
 * and the title, authors and venue are exactly the lines people want to copy.
 * A div with the button role keeps the keyboard behaviour (Tab to it, Enter or
 * Space to open) while leaving the text as selectable as any other.
 *
 * A drag across the text also ends in a click, so the card would open under
 * the selection just made. The press position tells the two apart: a click
 * that let go where it started opens the card, and one that moved does not.
 */
function ResultHead({
  onActivate,
  expanded,
  children,
}: {
  onActivate: () => void;
  expanded?: boolean;
  children: React.ReactNode;
}) {
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      role="button"
      tabIndex={0}
      className="result-head"
      aria-expanded={expanded}
      onPointerDown={(event) => {
        pressedAt.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        const start = pressedAt.current;
        pressedAt.current = null;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP) return;
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </div>
  );
}

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

/** The same complaint from both halves of a search is said once. */
const dedupe = (errors: SourceError[]) =>
  errors.filter(
    (error, position) =>
      errors.findIndex((other) => other.source === error.source && other.message === error.message) === position,
  );

/**
 * A person, at the top of their page. Not a result to open: it is the heading
 * everything under it belongs to, the way Google Scholar lays out a profile.
 */
function Profile({ author }: { author: AuthorRef }) {
  return (
    <article className="result person" aria-label={`${author.name}, profile`}>
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
      {author.interests?.length ? (
        <p className="authors" style={{ margin: '6px 0 4px' }}>
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
  );
}

export default function Discover({ onClose, onOpen, ask, here, focus }: Props) {
  const { papers, collections, addPaper, createCollection, driveConnected, settings, syncPaperNow } = useStore();
  const [query, setQuery] = useState('');
  /** The query as it was searched, which is what the panel is about until the next one. */
  const [asked, setAsked] = useState('');
  const [sources, setSources] = useState<SourceId[]>(defaultSources);
  const [results, setResults] = useState<PaperRef[]>([]);
  /** Everyone the query could have meant, likeliest first; `viewing` is the one on screen. */
  const [people, setPeople] = useState<AuthorRef[]>([]);
  const [viewing, setViewing] = useState<AuthorRef | null>(null);
  /** How a person's papers are listed. Kept across searches: it is a preference, not a query. */
  const [order, setOrder] = useState<PaperOrder>('newest');
  /** The results are every paper with the name on it, asked for by the link that says so. */
  const [byName, setByName] = useState(false);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(0);
  const [target, setTarget] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  /** The paper currently being fetched and put in Drive, and how far it is. */
  const [saving, setSaving] = useState<{ id: string; step: string } | null>(null);
  /** How the last add ended, when it did not end with the file in Drive. */
  const [saveError, setSaveError] = useState<{ id: string; message: string; signIn?: SignInOffer } | null>(null);
  /** The paper is in Drive, but not whole — the sidecar without the PDF, say. */
  const [saveNotice, setSaveNotice] = useState<{ id: string; message: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  /**
   * The search on screen, so that it can be run again — after a Scholar
   * captcha has been solved, say, when the same question gets an answer.
   */
  const lastRun = useRef<(() => void) | null>(null);
  /** The next page of whatever is on screen, which depends on how it was asked for. */
  const nextPage = useRef<((page: number, signal: AbortSignal) => Promise<PaperRef[]>) | null>(null);

  useEffect(() => {
    if (!target && collections.length) setTarget(collections[0].id);
  }, [collections, target]);

  // Browsing a collection and adding from here should add to that one, not to
  // whichever was first in the list.
  useEffect(() => {
    if (here && collections.some((collection) => collection.id === here)) setTarget(here);
  }, [here, collections]);

  const queryInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Only a press just now: the panel mounting again later — a switch of
    // tabs in the dock — is not a request to take the cursor.
    if (!focus || Date.now() - focus > 1500) return;
    queryInput.current?.focus();
    queryInput.current?.select();
  }, [focus]);

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
    const reported = sourceError(sources[0] ?? 'openalex', error);
    setErrors(reported ? [reported] : []);
  };

  /** A fresh list, whichever question it answers. */
  const clear = () => {
    setViewing(null);
    setPeople([]);
    setByName(false);
    setResults([]);
    setPage(0);
    setMore(false);
    nextPage.current = null;
  };

  /**
   * Everything one person has written, under their profile, in the order
   * asked for. Runs on the search's own controller when it follows straight
   * on from finding them, so that a new query cancels both halves at once.
   */
  const loadWorks = async (author: AuthorRef, by: PaperOrder, controller: AbortController) => {
    setViewing(author);
    setOrder(by);
    setByName(false);
    setResults([]);
    setPage(0);
    setMore(false);
    nextPage.current = (next, signal) => papersByAuthor(author, { page: next, order: by, signal });
    const found = await papersByAuthor(author, { page: 0, order: by, signal: controller.signal });
    setResults(found);
    setMore(found.length >= PAGE_SIZE);
  };

  /** Another of the people found, or the same one in the other order. */
  const openAuthor = async (author: AuthorRef, by: PaperOrder = order) => {
    lastRun.current = () => void openAuthor(author, by);
    const controller = begin();
    try {
      await loadWorks(author, by, controller);
    } catch (error) {
      fail(error);
    } finally {
      finish(controller);
    }
  };

  /**
   * One query, both questions. Papers matching it are always asked for; a
   * query that could be a person's name asks who that is as well, and when
   * someone comes back the panel becomes their page — profile on top, papers
   * under it, newest first — the way Google Scholar lays a person out. A
   * topic that merely looks like a name finds nobody, and the papers stand
   * on their own; `author:` in front asks for the person only, and lists
   * every paper with the name on it when no index has a record of them.
   */
  const run = async (text: string, options: { people?: boolean } = {}) => {
    lastRun.current = () => void run(text, options);
    const controller = begin();
    const trimmed = text.trim();
    setAsked(trimmed);
    clear();
    const name = options.people === false ? null : nameInQuery(trimmed);
    const forced = name !== null && /^author:/i.test(trimmed);
    const askPeople = name !== null && sources.some((id) => authorSources().some((source) => source.id === id));
    try {
      // A link is a paper already: arXiv's and Google Books' own are looked up
      // by their id, which brings the title and authors — and, for a book
      // Google lets anyone download, its PDF; any other is taken as it is — a PDF
      // when it looks like one, a page to open when it does not.
      const link = linkFromQuery(trimmed);
      if (link) {
        const arxiv = link.hostname.replace(/^www\./, '') === 'arxiv.org'
          ? arxivIdFromQuery(link.pathname.replace(/^\/(abs|pdf|html)\//, '').replace(/\.pdf$/i, ''))
          : null;
        const volume = googleBooksIdFromLink(link);
        const direct = arxiv && hasProxy()
          ? await lookupArxiv(arxiv, controller.signal)
          : volume
            ? await googleBook(volume, controller.signal).then((book) => (book.title ? [book] : []), () => [])
            : [];
        const found = direct.length ? direct : [paperFromLink(link)];
        setResults(found);
        setOpenId(found[0].id);
        return;
      }
      const directId = arxivIdFromQuery(trimmed);
      if (directId && hasProxy() && sources.includes('arxiv')) {
        const direct = await lookupArxiv(directId, controller.signal);
        if (direct.length) {
          setResults(direct);
          return;
        }
      }
      const findPapers = (next: number, signal: AbortSignal) =>
        forced
          ? searchByAuthorName(name, sources, { signal, page: next })
          : search(trimmed, sources, { signal, page: next });
      // Both questions go out at once, and the papers are shown as soon as
      // they are in rather than held for the people: Scholar's profile search
      // is the slower of the two by some way, and a topic that merely looks
      // like a name should not wait on it for nothing.
      const whoAsked = askPeople ? searchAuthors(name, sources, { signal: controller.signal }) : null;
      const found = await findPapers(0, controller.signal);
      setErrors(found.errors);
      setByName(forced);
      nextPage.current = (next, signal) => findPapers(next, signal).then((outcome) => outcome.results);
      setResults(found.results);
      setMore(!found.exhausted);
      if (!whoAsked) return;
      const who = await whoAsked;
      if (controller.signal.aborted) return;
      setErrors(dedupe([...found.errors, ...who.errors]));
      setPeople(who.authors);
      if (who.authors.length) await loadWorks(who.authors[0], order, controller);
    } catch (error) {
      fail(error);
    } finally {
      finish(controller);
    }
  };

  /**
   * The fallback when none of the people found is the right one, or nobody
   * was: match on the name across every source's author field instead of on
   * an identifier. Broader and noisier than a profile, but it works for
   * anyone who is not a prolific author.
   */
  const runByName = async (text: string) => {
    lastRun.current = () => void runByName(text);
    const controller = begin();
    clear();
    setByName(true);
    nextPage.current = (next, signal) =>
      searchByAuthorName(text, sources, { signal, page: next }).then((outcome) => outcome.results);
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
  };

  const loadMore = async () => {
    const fetchPage = nextPage.current;
    if (!fetchPage) return;
    const controller = begin();
    const next = page + 1;
    try {
      const found = await fetchPage(next, controller.signal);
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
  };

  // Run once per ask — `at` tells a repeat of the same query from the first.
  const handledAsk = useRef<number | null>(null);
  useEffect(() => {
    if (!ask || handledAsk.current === ask.at) return;
    handledAsk.current = ask.at;
    setQuery(ask.query);
    void run(ask.query);
    // `run` is this render's; the ask is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    void run(query);
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

  // Adding a paper does not put its file in Drive on its own: that takes the
  // Drive consent and a proxy to fetch the bytes through. Both are checked here
  // rather than in the store because the answer changes what this panel says
  // — the line under the result names which half is missing and where it is
  // set — while the add itself goes ahead either way.
  const saveBlocked = whySaveToDriveUnavailable({ driveConnected, proxyReady });

  /**
   * Adding a paper is the whole chain, in one press: put it in the collection,
   * find every copy of it, download from whichever one answers, put that file
   * in Drive, and open the paper on the copy that was just saved — in that
   * order, so what the viewer shows is the copy in Drive rather than a second
   * download of the same paper. Each copy the indexes know about is tried
   * until one answers, which is what makes this work for papers that are not
   * on arXiv.
   *
   * Every step after the first is best effort. Without Drive or a proxy the
   * file has nowhere to go, or no way to get here; a paper none of the indexes
   * has a free copy of has no file at all. In each case the paper is still
   * added and still opened, and the result says what did not happen — the
   * reader is looking at this panel, so this is where the answer belongs, not
   * only in the sync log behind Settings.
   */
  const addToCollection = async (ref: PaperRef) => {
    setSaveError(null);
    setSaveNotice(null);
    setSaving({ id: ref.id, step: 'Adding…' });
    let inLibrary = false;
    try {
      // Added without its automatic sync: that would start fetching the same
      // PDF in parallel with the fetch below, and the paper would come down
      // the wire twice. The sync is asked for below instead, once there is a
      // file to hand it.
      const added = await add(ref, { sync: false });
      inLibrary = true;

      if (driveConnected) {
        let pdf: Blob | undefined;
        let from = '';
        // A paper Drive already holds the file of is only being added to a
        // second collection; the sidecar is rewritten, the PDF stays put. And
        // with "Include the PDF" off there is no point fetching one.
        if (proxyReady && settings.savePdf && !added.drive?.pdfFileId) {
          setSaving({ id: ref.id, step: 'Finding a copy…' });
          const locations = await findLocations(ref);
          setSaving({ id: ref.id, step: 'Downloading…' });
          // A copy that hands over a poster or slides is passed over for
          // one that looks like the paper, where any of them does.
          const fetched = await fetchPdfFromLocations(ref, locations, undefined, { judge: judgePdf });
          pdf = fetched.blob;
          from = ` from ${fetched.location.label}`;
        }
        setSaving({ id: ref.id, step: `Saving to Drive${from}…` });
        const outcome = await syncPaperNow(ref.id, pdf ? { pdf } : undefined);
        if (outcome.state === 'error') {
          setSaveError({ id: ref.id, message: `Added, but Drive would not take it: ${outcome.message}` });
        } else if (outcome.message) {
          setSaveNotice({ id: ref.id, message: outcome.message });
        }
      }
    } catch (error) {
      // The paper is in the library whatever happened after that. The reader
      // opens on what it can show — the abstract, or the copies to try by
      // hand — and this says why the file is not in Drive.
      setSaveError({
        id: ref.id,
        message: `Added, but the file is not in Drive: ${error instanceof Error ? error.message : String(error)}`,
        // A login wall is the one failure a person can do something about.
        signIn: error instanceof PdfError ? error.signIn : undefined,
      });
    } finally {
      setSaving(null);
    }
    // Whatever happened to the file, the paper is in the library, and this is
    // what "add" was pressed for. Only an add that itself failed has nothing
    // to open.
    if (inLibrary) onOpen(ref.id);
  };

  /**
   * The file, handed over by the person rather than fetched: the paper is
   * already in the library by the time this is offered, so it only has to go
   * up to Drive and open.
   */
  const handOver = async (ref: PaperRef, pdf: Blob) => {
    setSaveError(null);
    setSaveNotice(null);
    setSaving({ id: ref.id, step: 'Saving your file to Drive…' });
    try {
      // Their file, picked by hand: it takes the place of any copy Drive
      // already holds rather than being skipped because there is one.
      const outcome = await syncPaperNow(ref.id, { pdf, replacePdf: true });
      if (outcome.state === 'error') {
        setSaveError({ id: ref.id, message: `Drive would not take it: ${outcome.message}` });
        return;
      }
      if (outcome.message) setSaveNotice({ id: ref.id, message: outcome.message });
    } finally {
      setSaving(null);
    }
    onOpen(ref.id);
  };

  const visibleSources = sourceList();
  const noSources = !sources.some((id) => visibleSources.some((source) => source.id === id));
  /** The name the last search could have been asking for, which the advice under it is about. */
  const askedName = nameInQuery(asked);
  const others = viewing ? people.filter((person) => person.id !== viewing.id) : [];

  /** The two ways round the profiles: every paper with the name on it, or Scholar's own search. */
  const byNameLinks = (name: string) => (
    <>
      <button type="button" className="linklike" onClick={() => void runByName(name)}>
        Search every paper with that name on it
      </button>
      , or look them up{' '}
      <a className="loc-scholar" href={scholarAuthorPapersUrl(name)} target="_blank" rel="noreferrer noopener">
        on Google Scholar <ExternalIcon size={10} />
      </a>
      .
    </>
  );

  return (
    <aside className="panel discover-panel" aria-label="Discover">
      <div className="panel-head">
        <h2>Discover</h2>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the discover panel">
          <CloseIcon size={17} />
        </button>
      </div>

      <form style={{ padding: '0 16px 12px' }} onSubmit={submit}>
        <label className="vh" htmlFor="discover-query">
          Search papers and people
        </label>
        <div className="field">
          <SearchIcon size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input
            id="discover-query"
            ref={queryInput}
            type="search"
            value={query}
            placeholder={'Title, topic, a person, an arXiv id or a PDF link'}
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
          what has happened, the other sources carry on, and — when the proxy runs on your own machine — you can
          be shown the captcha to solve.
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
              key={`${error.source}:${error.message}`}
              className={`banner ${error.source === 'scholar' ? 'warn' : 'error'}`}
              style={{ marginTop: 0, marginBottom: 6 }}
            >
              {labelFor(error.source)}: {error.message}
              {error.source === 'scholar' && results.length ? ' The results below are from the other sources.' : ''}
              {error.captchaUrl ? (
                <CaptchaPrompt url={error.captchaUrl} onSolved={() => lastRun.current?.()} />
              ) : null}
            </p>
          ))}
        </div>
      ) : null}

      <div className="scroll" style={{ padding: '0 8px 16px' }}>
        {!results.length && !viewing && !busy && !noSources ? (
          <p style={{ padding: '10px 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {asked
              ? 'Nothing found. Try fewer words, or turn another source on above.'
              : hasProxy()
                ? "Search arXiv, OpenAlex, Semantic Scholar, Crossref and Google Scholar at once, merged into one ranked list. A person's name opens their profile with everything they wrote beneath it, newest first. Quote a phrase to match it exactly, or paste an arXiv id to jump straight to a paper. Turn on Books & PDFs for books and scans from Open Library and the Internet Archive, or paste the link to any PDF to add it as it is."
                : "Search OpenAlex, Semantic Scholar and Crossref, all of which index arXiv. A person's name opens their profile with everything they wrote beneath it, newest first. Turn on Books & PDFs for books and scans from Open Library and the Internet Archive, or paste the link to any PDF to add it as it is."}
          </p>
        ) : null}

        {viewing ? (
          <>
            <Profile author={viewing} />
            {others.length ? (
              <div className="person-others">
                <span className="eyebrow">Could also be</span>
                {others.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className="chip"
                    title={[person.affiliation, labelFor(person.source)].filter(Boolean).join(' · ')}
                    onClick={() => void openAuthor(person)}
                  >
                    {person.name} · {labelFor(person.source)}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="author-advice">
              Not who you meant? {byNameLinks(askedName || viewing.name)}
            </p>
            <div className="person-works">
              <p className="eyebrow" style={{ margin: 0 }}>
                Papers by {viewing.name}
              </p>
              <div className="segmented sm" role="group" aria-label="Order of the papers">
                <button
                  type="button"
                  aria-pressed={order === 'newest'}
                  onClick={() => order !== 'newest' && void openAuthor(viewing, 'newest')}
                >
                  Newest
                </button>
                <button
                  type="button"
                  aria-pressed={order === 'cited'}
                  onClick={() => order !== 'cited' && void openAuthor(viewing, 'cited')}
                >
                  Most cited
                </button>
              </div>
            </div>
          </>
        ) : null}

        {!viewing && byName && asked ? (
          <p className="eyebrow" style={{ padding: '6px 10px 4px' }}>
            Every paper with {askedName || asked} on it
          </p>
        ) : null}

        {!viewing && !byName && askedName && !busy ? (
          <p className="author-advice">
            Looking for a person? No index keeps a profile under that name. {byNameLinks(askedName)}
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
              <ResultHead onActivate={() => setOpenId(isOpen ? null : result.id)} expanded={isOpen}>
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
              </ResultHead>

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
                    <button
                      type="button"
                      className="btn primary sm"
                      disabled={Boolean(saving)}
                      aria-describedby={saveBlocked ? SAVE_BLOCKED_ID : undefined}
                      title={
                        saveBlocked ??
                        'Add it to the collection, save the PDF to your Drive, and open it here on that copy'
                      }
                      onClick={() => void addToCollection(result)}
                    >
                      {saving?.id === result.id ? (
                        <>
                          <span className="spinner" /> {saving.step}
                        </>
                      ) : (
                        <>
                          <PlusIcon size={14} />
                          {saved ? 'Add to this collection' : 'Add to collection'}
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      title="Open it straight away; Drive catches up in the background"
                      onClick={async () => {
                        await add(result);
                        onOpen(result.id);
                      }}
                    >
                      Read
                    </button>
                    {result.landingUrl ? (
                      <a className="btn sm" href={result.landingUrl} target="_blank" rel="noreferrer noopener">
                        Source <ExternalIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                  {saveBlocked ? (
                    <p className="save-blocked" id={SAVE_BLOCKED_ID}>
                      Adding still opens the paper here, but its PDF will not reach Drive. {saveBlocked}
                    </p>
                  ) : null}
                  {saveError?.id === result.id && saving?.id !== result.id ? (
                    <p className="banner error" style={{ marginBottom: 0 }}>
                      {saveError.message}
                      {saveError.signIn ? (
                        <SignInPrompt offer={saveError.signIn} onSignedIn={() => void addToCollection(result)} />
                      ) : null}
                      {driveConnected ? (
                        <PdfDropIn
                          host={saveError.signIn?.host}
                          url={saveError.signIn?.url || result.landingUrl}
                          onFile={(pdf) => handOver(result, pdf)}
                        />
                      ) : null}
                    </p>
                  ) : null}
                  {saveNotice?.id === result.id && saving?.id !== result.id ? (
                    <p className="banner warn" style={{ marginBottom: 0 }}>
                      {saveNotice.message}
                    </p>
                  ) : null}
                </>
              ) : null}
            </article>
          );
        })}

        {viewing && !results.length && !busy ? (
          <p style={{ padding: '4px 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {labelFor(viewing.source)} lists nothing under this record.
          </p>
        ) : null}

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
