import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { arxivIdFromQuery, defaultSources, lookupArxiv, openAlexWorks, search, sourceError, sourceList, type SourceError } from '../lib/sources';
import { authorLine } from '../lib/libraryLook';
import { statusOf } from '../lib/status';
import type { Collection, Paper, PaperRef, SourceId } from '../types';
import { progressLabel } from './LibraryBits';
import { PdfPeek, ReflowPeek, clip, hasPage, sinceLeft, useSpot, whereIn } from './HomeParts';
import { CheckIcon, ChevronDownIcon, ExternalIcon, PlusIcon, SearchIcon } from './icons';
import { Locations } from './Discover';

/** A search result dragged onto a collection carries itself. */
const REF_MIME = 'application/x-reader-ref';
const LIMIT = 20;

const norm = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

interface Props {
  hero: Paper | null;
  /** A question to start with, asked as the view opens. */
  ask?: string;
  /**
   * Put the cursor in the box as the view opens: at the start of a visit, yes;
   * back from a paper, no — there G has to reach the paper again, not the box.
   */
  focusBox?: boolean;
  saveTo?: string;
  onSaveTo: (collectionId: string) => void;
  onOpenPaper: (id: string) => void;
  /** Take the question to Discover, which also finds people and handles Scholar's captcha. */
  onDiscover: (query: string) => void;
}

interface Added {
  paperId: string;
  title: string;
  collection: string;
  /** How it stood before, to put it back: absent when it was not in the library at all. */
  before?: string[];
}

interface Suggestion {
  ref: PaperRef;
  why: string;
}

/**
 * Find papers: the search box first, and one step from a result to a
 * collection — the + button saves to the collection chosen beside the box,
 * its ▾ to any other, and a result can be dragged onto one on the right.
 */
export function FindPapers({ hero, ask, focusBox = true, saveTo, onSaveTo, onOpenPaper, onDiscover }: Props) {
  const { papers, collections, addPaper, createCollection, setPaperCollections, removePaper } = useStore();
  const [query, setQuery] = useState(ask ?? '');
  const [asked, setAsked] = useState('');
  const [sources, setSources] = useState<SourceId[]>(defaultSources);
  const [results, setResults] = useState<PaperRef[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  /** The result opened to show everywhere it can be read, as Discover's are. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const target = collections.find((item) => item.id === saveTo) ?? collections[0];

  // The box has the cursor as a visit opens on it, and / puts it there from anywhere on Home.
  useEffect(() => {
    if (focusBox || ask) input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = event.target as HTMLElement | null;
      if (typing && (typing.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName))) return;
      if (document.querySelector('.scrim, .sheet, .palette')) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Once, as the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A paper is in the library by its id, or by its title under another source's id.
  const inLibrary = useMemo(() => {
    const byId = new Map(papers.map((paper) => [paper.id, paper]));
    const byTitle = new Map(papers.map((paper) => [norm(paper.title), paper]));
    return (ref: PaperRef) => byId.get(ref.id) ?? byTitle.get(norm(ref.title));
  }, [papers]);

  const run = useCallback(
    async (text = query) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setAsked('');
        setResults([]);
        setErrors([]);
        return;
      }
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setErrors([]);
      setAsked(trimmed);
      setSelected(0);
      setPicking(null);
      try {
        const id = arxivIdFromQuery(trimmed);
        if (id) {
          setResults(await lookupArxiv(id, controller.signal));
        } else {
          const outcome = await search(trimmed, sources, { limit: LIMIT, signal: controller.signal });
          setResults(outcome.results);
          setErrors(outcome.errors);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const reported = sourceError(sources[0] ?? 'openalex', error);
        setErrors(reported ? [reported] : []);
        setResults([]);
      } finally {
        if (abort.current === controller) setBusy(false);
      }
    },
    [query, sources],
  );

  // A question brought from elsewhere is asked straight away.
  const asking = useRef(ask);
  useEffect(() => {
    if (asking.current) void run(asking.current);
    // Once, as the view opens with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Before anything is asked: papers near the one being read, from OpenAlex,
  // which a browser can ask directly. Kept for the visit, per paper.
  useEffect(() => {
    if (!hero) {
      setSuggestions([]);
      return;
    }
    const key = `reader.suggest.${hero.id}`;
    try {
      const kept = sessionStorage.getItem(key);
      if (kept) {
        setSuggestions(JSON.parse(kept) as Suggestion[]);
        return;
      }
    } catch {
      // asked afresh
    }
    const controller = new AbortController();
    const near = openAlexWorks(new URLSearchParams({ search: hero.title, per_page: '8' }), controller.signal).then((refs) =>
      refs.map((ref) => ({ ref, why: `Related to ${clip(hero.title, 60)}, which you are reading` })),
    );
    const first = hero.authors[0];
    const by = first
      ? openAlexWorks(
          new URLSearchParams({ filter: `raw_author_name.search:${first.replace(/[,:|]+/g, ' ')}`, sort: 'cited_by_count:desc', per_page: '6' }),
          controller.signal,
        ).then((refs) => refs.map((ref) => ({ ref, why: `More by ${first}` })))
      : Promise.resolve([]);
    void Promise.allSettled([near, by]).then((settled) => {
      if (controller.signal.aborted) return;
      const seen = new Set<string>();
      const out: Suggestion[] = [];
      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue;
        for (const item of outcome.value) {
          const title = norm(item.ref.title);
          if (!title || seen.has(title) || title === norm(hero.title)) continue;
          seen.add(title);
          out.push(item);
        }
      }
      // Interleaved, so both reasons show; the ones already in the library are left for the list to mark.
      const near = out.filter((item) => item.why.startsWith('Related'));
      const byAuthor = out.filter((item) => !item.why.startsWith('Related'));
      const mixed: Suggestion[] = [];
      while ((near.length || byAuthor.length) && mixed.length < 6) {
        if (near.length) mixed.push(near.shift()!);
        if (byAuthor.length && mixed.length < 6) mixed.push(byAuthor.shift()!);
      }
      setSuggestions(mixed);
      try {
        sessionStorage.setItem(key, JSON.stringify(mixed));
      } catch {
        // asked again next time
      }
    });
    return () => controller.abort();
  }, [hero]);

  const save = useCallback(
    async (ref: PaperRef, collection: Collection | undefined) => {
      if (!collection) return;
      const existing = inLibrary(ref);
      const paper = await addPaper(existing ? { ...ref, id: existing.id } : ref, collection.id);
      setAdded({ paperId: paper.id, title: ref.title, collection: collection.name, before: existing ? existing.collectionIds : undefined });
      setPicking(null);
    },
    [addPaper, inLibrary],
  );

  const read = useCallback(
    async (ref: PaperRef) => {
      const existing = inLibrary(ref);
      if (existing) return onOpenPaper(existing.id);
      const paper = await addPaper(ref, target?.id);
      onOpenPaper(paper.id);
    },
    [addPaper, inLibrary, onOpenPaper, target],
  );

  const undo = async () => {
    if (!added) return;
    if (added.before) await setPaperCollections(added.paperId, added.before);
    else await removePaper(added.paperId);
    setAdded(null);
  };

  const newCollection = async (ref?: PaperRef) => {
    const name = window.prompt('Name the new collection');
    if (!name?.trim()) return;
    const made = await createCollection(name.trim());
    onSaveTo(made.id);
    if (ref) await save(ref, made);
  };

  // The toast goes by itself, unless the pointer is on it.
  const [holdToast, setHoldToast] = useState(false);
  useEffect(() => {
    if (!added || holdToast) return;
    const timer = window.setTimeout(() => setAdded(null), 7000);
    return () => window.clearTimeout(timer);
  }, [added, holdToast]);

  const shown = asked ? results : (suggestions ?? []).map((item) => item.ref);
  const why = new Map((suggestions ?? []).map((item) => [item.ref.id, item.why]));

  // In the list: ↑↓ move, ↵ read, A saves to the chosen collection; with the
  // picker open, 1–9 choose from it. Typing in the box, ↓ steps into the list.
  const onListKey = (event: React.KeyboardEvent) => {
    const ref = shown[selected];
    if (picking && /^[1-9]$/.test(event.key)) {
      const collection = collections[Number(event.key) - 1];
      const pickRef = shown.find((item) => item.id === picking);
      if (collection && pickRef) {
        event.preventDefault();
        event.stopPropagation();
        void save(pickRef, collection);
      }
      return;
    }
    if (event.key === 'Escape' && picking) {
      event.stopPropagation();
      setPicking(null);
      return;
    }
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'ArrowDown' && shown.length) {
        event.preventDefault();
        setSelected(0);
        (document.querySelector('.find-row') as HTMLElement | null)?.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, Math.min(shown.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
      if (event.key === 'ArrowUp' && selected === 0) {
        input.current?.focus();
        return;
      }
      setSelected(next);
      (document.querySelectorAll('.find-row')[next] as HTMLElement | undefined)?.focus();
    } else if (ref && event.key.toLowerCase() === 'a' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      void save(ref, target);
    } else if (ref && event.key === 'Enter' && (event.target as HTMLElement).classList.contains('find-row')) {
      event.preventDefault();
      event.stopPropagation();
      setOpenId((current) => (current === ref.id ? null : ref.id));
    }
  };

  const toggleSource = (id: SourceId) =>
    setSources((current) => (current.includes(id) ? (current.length > 1 ? current.filter((item) => item !== id) : current) : [...current, id]));

  return (
    <div className="home-view find" onKeyDown={onListKey}>
      <section className="find-hero">
        {!asked ? (
          <>
            <h2>Find your next paper</h2>
            <p>Search the indexes at once — or paste an arXiv id. Whatever you save goes straight into a collection.</p>
          </>
        ) : null}
        <form
          className="find-box"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <SearchIcon size={19} />
          <input
            ref={input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value.trim()) void run('');
            }}
            placeholder="Papers or topics — “scaling laws for mixture of experts”, or 2401.02954"
            aria-label="Search for papers"
          />
          {busy ? <span className="spinner" /> : asked ? <span className="find-count">{results.length} results</span> : <kbd>/</kbd>}
          <button type="submit" className="btn primary">
            Search
          </button>
        </form>
        <div className="find-options">
          <span className="find-label">Search in</span>
          {sourceList().map((source) => (
            <button key={source.id} type="button" className={`chip${sources.includes(source.id) ? ' is-on' : ''}`} aria-pressed={sources.includes(source.id)} onClick={() => toggleSource(source.id)}>
              {source.label}
            </button>
          ))}
          <span className="find-gap" />
          <span className="find-label">Save to</span>
          <label className="find-dest">
            <span className="home-dot" style={{ background: target?.color ?? 'var(--accent)' }} />
            <select
              value={target?.id ?? ''}
              onChange={(event) => (event.target.value === '+new' ? void newCollection() : onSaveTo(event.target.value))}
              aria-label="Save to collection"
            >
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
              <option value="+new">+ New collection…</option>
            </select>
          </label>
        </div>
      </section>

      <div className="find-cols">
        <section className="home-card find-list" aria-label={asked ? 'Search results' : 'Suggestions'}>
          <div className="find-list-head">
            <span className="home-eyebrow">{asked ? `Results for “${clip(asked, 60)}”` : 'Suggested from what you are reading'}</span>
            {asked ? (
              <button type="button" className="link-btn" onClick={() => onDiscover(asked)}>
                People, more pages and Scholar in Discover →
              </button>
            ) : null}
          </div>
          {errors.length ? (
            <p className="find-note">
              {errors.map((error) => error.message).join(' ')}{' '}
              <button type="button" className="link-btn" onClick={() => onDiscover(asked)}>
                Try it in Discover
              </button>
            </p>
          ) : null}
          {asked && !busy && !results.length && !errors.length ? <p className="find-note">Nothing found. Try other words, or more sources.</p> : null}
          {!asked && suggestions === null ? <p className="find-note">Looking for papers near what you are reading…</p> : null}
          {!asked && suggestions?.length === 0 ? <p className="find-note">Search above, and what you save shows up in your collections on the right.</p> : null}
          {shown.map((ref, index) => {
            const have = inLibrary(ref);
            const year = /^\d{4}/.exec(ref.published || '')?.[0];
            const open = openId === ref.id;
            return (
              <div key={`${ref.id}-${index}`} className={`find-item${open ? ' is-open' : ''}`}>
              <div
                className={`find-row${index === selected ? ' is-selected' : ''}`}
                tabIndex={0}
                draggable
                aria-expanded={open}
                title="Click to see everywhere it can be read"
                onFocus={() => setSelected(index)}
                onClick={(event) => {
                  // The buttons on the row do their own thing; anywhere else opens it.
                  if ((event.target as HTMLElement).closest('button, a, select, .find-pick')) return;
                  setOpenId(open ? null : ref.id);
                }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(REF_MIME, JSON.stringify(ref));
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <div className="find-row-text">
                  {!asked && why.get(ref.id) ? <span className="find-why">{why.get(ref.id)}</span> : null}
                  <span className="find-title">{ref.title}</span>
                  <span className="home-row-sub">
                    {authorLine(ref.authors, 3)}
                    {ref.venue ? ` · ${clip(ref.venue, 50)}` : ''}
                    {year ? ` · ${year}` : ''}
                    {typeof ref.citedBy === 'number' ? ` · ${ref.citedBy.toLocaleString()} citations` : ''}
                    {ref.scholarVersions ? ` · ${ref.scholarVersions} versions` : ''}
                    {ref.pdfUrl ? ' · PDF' : ''}
                  </span>
                </div>
                {have ? (
                  <span className="find-have">
                    <CheckIcon size={13} /> In {collections.find((c) => have.collectionIds.includes(c.id))?.name ?? 'your library'} · {statusOf(have) === 'unread' ? 'not started' : progressLabel(have.progress)}
                  </span>
                ) : null}
                <button type="button" className="btn sm" onClick={() => void read(ref)}>
                  {have ? 'Open' : 'Read'}
                </button>
                {have && target && have.collectionIds.includes(target.id) ? null : (
                  <span className="find-split">
                    <button type="button" className="btn primary sm" onClick={() => void save(ref, target)} disabled={!target} title={target ? `Save to ${target.name} (A)` : 'Make a collection first'}>
                      <PlusIcon size={13} /> {target ? clip(target.name, 22) : 'Collection'}
                    </button>
                    <button type="button" className="btn primary sm" aria-label="Save to another collection" aria-expanded={picking === ref.id} onClick={() => setPicking(picking === ref.id ? null : ref.id)}>
                      <ChevronDownIcon size={13} />
                    </button>
                    {picking === ref.id ? (
                      <div className="find-pick" role="menu">
                        <span className="home-eyebrow">Save to</span>
                        {collections.map((collection, at) => (
                          <button key={collection.id} type="button" role="menuitem" onClick={() => void save(ref, collection)}>
                            <span className="home-dot" style={{ background: collection.color }} />
                            {collection.name}
                            {have?.collectionIds.includes(collection.id) ? <CheckIcon size={12} /> : null}
                            {at < 9 ? <kbd>{at + 1}</kbd> : null}
                          </button>
                        ))}
                        <button type="button" role="menuitem" className="find-pick-new" onClick={() => void newCollection(ref)}>
                          <PlusIcon size={12} /> New collection…
                        </button>
                      </div>
                    ) : null}
                  </span>
                )}
              </div>
              {open ? (
                <div className="find-detail">
                  {ref.abstract ? (
                    <p className="find-abstract">
                      {ref.abstract.slice(0, 420)}
                      {ref.abstract.length > 420 ? '…' : ''}
                    </p>
                  ) : null}
                  <Locations paper={ref} />
                  <div className="find-detail-actions">
                    {have && target && have.collectionIds.includes(target.id) ? (
                      <span className="find-have">
                        <CheckIcon size={13} /> In {target.name}
                      </span>
                    ) : (
                      <button type="button" className="btn primary sm" onClick={() => void save(ref, target)} disabled={!target}>
                        <PlusIcon size={13} /> Save to {target ? clip(target.name, 24) : 'a collection'}
                      </button>
                    )}
                    <button type="button" className="btn sm" onClick={() => void read(ref)}>
                      {have ? 'Open' : 'Read'}
                    </button>
                    {ref.landingUrl ? (
                      <a className="btn sm" href={ref.landingUrl} target="_blank" rel="noreferrer noopener">
                        Source <ExternalIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}
              </div>
            );
          })}
          {shown.length ? (
            <p className="find-keys">
              Click a paper to see everywhere it can be read · <kbd>↑</kbd>
              <kbd>↓</kbd> move · <kbd>↵</kbd> open it · <kbd>A</kbd> save to {target?.name ?? 'a collection'} · <kbd>▾</kbd> then <kbd>1</kbd>–<kbd>9</kbd> another · drag onto a collection
            </p>
          ) : null}
        </section>

        <aside className="home-card find-colls" aria-label="Your collections">
          <span className="home-eyebrow">Your collections</span>
          {collections.map((collection) => {
            const count = papers.filter((paper) => paper.collectionIds.includes(collection.id)).length;
            return (
              <button
                key={collection.id}
                type="button"
                className={`find-coll${dropOn === collection.id ? ' is-drop' : ''}${target?.id === collection.id ? ' is-target' : ''}`}
                title={`Save to ${collection.name} by default`}
                onClick={() => onSaveTo(collection.id)}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(REF_MIME)) return;
                  event.preventDefault();
                  setDropOn(collection.id);
                }}
                onDragLeave={() => setDropOn((current) => (current === collection.id ? null : current))}
                onDrop={(event) => {
                  setDropOn(null);
                  const raw = event.dataTransfer.getData(REF_MIME);
                  if (!raw) return;
                  event.preventDefault();
                  void save(JSON.parse(raw) as PaperRef, collection);
                }}
              >
                <span className="home-dot" style={{ background: collection.color }} />
                <span className="find-coll-name">{collection.name}</span>
                <span className="find-coll-count">{count}</span>
              </button>
            );
          })}
          <button type="button" className="find-coll find-coll-new" onClick={() => void newCollection()}>
            <PlusIcon size={13} /> New collection
          </button>
          <p className="find-hint">Click one to save there by default; drop a result on one to save it there.</p>
        </aside>
      </div>

      {hero && statusOf(hero) === 'reading' ? <CarryOn hero={hero} papers={papers} onOpenPaper={onOpenPaper} /> : null}

      {added ? (
        <div className="find-toast" role="status" onPointerEnter={() => setHoldToast(true)} onPointerLeave={() => setHoldToast(false)}>
          <CheckIcon size={14} /> Added <b>{clip(added.title, 48)}</b> to <b>{added.collection}</b>
          <button type="button" className="link-btn" onClick={() => void undo()}>
            Undo
          </button>
          <button type="button" className="btn primary sm" onClick={() => onOpenPaper(added.paperId)}>
            Read now
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Continue reading, made small: the papers in progress, each a sliver of where you stopped. */
function CarryOn({ hero, papers, onOpenPaper }: { hero: Paper; papers: Paper[]; onOpenPaper: (id: string) => void }) {
  const others = papers
    .filter((paper) => statusOf(paper) === 'reading' && paper.id !== hero.id)
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
    .slice(0, 2);
  return (
    <section className="find-carry" aria-label="Continue reading">
      <div className="find-list-head">
        <span className="home-eyebrow">Continue reading</span>
        <span className="home-row-sub">R while reading lays these out large</span>
      </div>
      <div className="find-carry-row">
        {[hero, ...others].map((paper) => (
          <CarryCard key={paper.id} paper={paper} onOpen={() => onOpenPaper(paper.id)} />
        ))}
      </div>
    </section>
  );
}

function CarryCard({ paper, onOpen }: { paper: Paper; onOpen: () => void }) {
  const spot = useSpot(paper.id);
  return (
    <button type="button" className="home-card find-carry-card" onClick={onOpen}>
      <span className="find-carry-thumb" aria-hidden="true">
        {hasPage(spot) ? spot.mode === 'pdf' ? <PdfPeek spot={spot} /> : <ReflowPeek spot={spot} /> : null}
      </span>
      <span className="home-row-text">
        <span className="home-row-title">{paper.title}</span>
        <span className="home-row-sub">{[progressLabel(paper.progress), whereIn(spot), paper.lastOpenedAt ? sinceLeft(paper.lastOpenedAt) : ''].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  );
}
