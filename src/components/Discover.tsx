import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { arxivIdFromQuery, DEFAULT_SOURCES, lookupArxiv, search, SOURCES } from '../lib/sources';
import { hasProxy, NO_PROXY_REASON } from '../lib/api';
import type { PaperRef, SourceId } from '../types';
import { CheckIcon, CloseIcon, ExternalIcon, PlusIcon, SearchIcon } from './icons';

interface Props {
  onClose: () => void;
  onOpen: (paperId: string) => void;
}

export default function Discover({ onClose, onOpen }: Props) {
  const { papers, collections, addPaper, createCollection } = useStore();
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<SourceId[]>(DEFAULT_SOURCES);
  const [results, setResults] = useState<PaperRef[]>([]);
  const [errors, setErrors] = useState<{ source: SourceId; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!target && collections.length) setTarget(collections[0].id);
  }, [collections, target]);

  const run = useCallback(
    async (text: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setErrors([]);
      try {
        const directId = arxivIdFromQuery(text);
        if (directId && hasProxy && sources.includes('arxiv')) {
          const direct = await lookupArxiv(directId, controller.signal);
          if (direct.length) {
            setResults(direct);
            return;
          }
        }
        const outcome = await search(text, sources, { signal: controller.signal, limit: 20 });
        setResults(outcome.results);
        setErrors(outcome.errors);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setErrors([{ source: sources[0], message: error instanceof Error ? error.message : String(error) }]);
        }
      } finally {
        if (abort.current === controller) setBusy(false);
      }
    },
    [sources],
  );

  const toggleSource = (id: SourceId) => {
    setSources((current) =>
      current.includes(id) ? current.filter((item) => item !== id) || [] : [...current, id],
    );
  };

  const add = async (ref: PaperRef) => {
    let collectionId = target;
    if (!collectionId) collectionId = (await createCollection('Reading list')).id;
    await addPaper(ref, collectionId);
  };

  return (
    <aside className="panel" aria-label="Discover">
      <div className="panel-head">
        <h2>Discover</h2>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the discover panel">
          <CloseIcon size={17} />
        </button>
      </div>

      <form
        style={{ padding: '0 16px 12px' }}
        onSubmit={(event) => {
          event.preventDefault();
          void run(query);
        }}
      >
        <label className="vh" htmlFor="discover-query">
          Search papers
        </label>
        <div className="field">
          <SearchIcon size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input
            id="discover-query"
            type="search"
            value={query}
            placeholder="Title, author, topic or arXiv id"
            onChange={(event) => setQuery(event.target.value)}
          />
          {busy ? <span className="spinner" aria-label="Searching" /> : null}
        </div>
      </form>

      <div style={{ padding: '0 16px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SOURCES.map((source) => (
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

      {!hasProxy ? (
        <p className="banner warn" style={{ margin: '0 16px 12px' }}>
          {NO_PROXY_REASON} OpenAlex and Semantic Scholar both index arXiv, so most papers are still here — you
          just get the abstract rather than the full text.
        </p>
      ) : null}

      {errors.length ? (
        <div style={{ padding: '0 16px 12px' }}>
          {errors.map((error) => (
            <p key={error.source} className="banner error" style={{ marginTop: 0, marginBottom: 6 }}>
              {SOURCES.find((source) => source.id === error.source)?.label}: {error.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="scroll" style={{ padding: '0 8px 16px' }}>
        {!results.length && !busy ? (
          <p style={{ padding: '10px 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {hasProxy
              ? 'Search arXiv, OpenAlex and Semantic Scholar at once. Paste an arXiv id to jump straight to a paper.'
              : 'Search OpenAlex and Semantic Scholar, both of which index arXiv.'}
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
                    {result.landingUrl ? (
                      <a className="btn sm" href={result.landingUrl} target="_blank" rel="noreferrer noopener">
                        Source <ExternalIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                </>
              ) : null}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
