import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { arxivIdFromQuery, DEFAULT_SOURCES, lookupArxiv, search } from '../lib/sources';
import { hasProxy } from '../lib/api';
import type { PaperRef } from '../types';
import { FileIcon, PlusIcon, SearchIcon, SettingsIcon, StackIcon } from './icons';

interface Props {
  onClose: () => void;
  onOpenPaper: (id: string) => void;
  onOpenSettings: () => void;
}

type Row =
  | { kind: 'library'; id: string; title: string; sub: string }
  | { kind: 'remote'; ref: PaperRef }
  | { kind: 'action'; id: string; title: string; run: () => void };

export default function CommandPalette({ onClose, onOpenPaper, onOpenSettings }: Props) {
  const { papers, collections, addPaper, createCollection } = useStore();
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<PaperRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setRemote([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      try {
        const directId = arxivIdFromQuery(trimmed);
        const found =
          directId && hasProxy
            ? await lookupArxiv(directId, controller.signal)
            : (await search(trimmed, DEFAULT_SOURCES, { signal: controller.signal, limit: 6 })).results;
        setRemote(found);
      } catch {
        setRemote([]);
      } finally {
        if (abort.current === controller) setBusy(false);
      }
    }, 320);
    return () => window.clearTimeout(timer);
  }, [query]);

  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    const library: Row[] = papers
      .filter(
        (paper) =>
          !needle ||
          paper.title.toLowerCase().includes(needle) ||
          paper.authors.join(' ').toLowerCase().includes(needle),
      )
      .slice(0, 6)
      .map((paper) => ({
        kind: 'library' as const,
        id: paper.id,
        title: paper.title,
        sub:
          paper.collectionIds
            .map((id) => collections.find((collection) => collection.id === id)?.name)
            .filter(Boolean)
            .join(', ') || 'Unsorted',
      }));

    const found: Row[] = remote
      .filter((ref) => !papers.some((paper) => paper.id === ref.id))
      .map((ref) => ({ kind: 'remote' as const, ref }));

    const actions: Row[] = [];
    if (query.trim()) {
      actions.push({
        kind: 'action',
        id: 'create',
        title: `Create collection “${query.trim()}”`,
        run: () => {
          void createCollection(query.trim());
          onClose();
        },
      });
    }
    actions.push({
      kind: 'action',
      id: 'settings',
      title: 'Open settings and Google Drive',
      run: () => {
        onOpenSettings();
        onClose();
      },
    });

    return [...library, ...found, ...actions];
  }, [papers, collections, remote, query, createCollection, onClose, onOpenSettings]);

  useEffect(() => setCursor(0), [rows.length]);

  const activate = useCallback(
    async (row: Row, alsoOpen: boolean) => {
      if (row.kind === 'library') {
        onOpenPaper(row.id);
        onClose();
        return;
      }
      if (row.kind === 'action') {
        row.run();
        return;
      }
      const target = collections[0] ?? (await createCollection('Reading list'));
      await addPaper(row.ref, target.id);
      if (alsoOpen) onOpenPaper(row.ref.id);
      onClose();
    },
    [addPaper, collections, createCollection, onClose, onOpenPaper],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((current) => Math.min(rows.length - 1, current + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((current) => Math.max(0, current - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const row = rows[cursor];
        if (row) void activate(row, event.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activate, cursor, onClose, rows]);

  const libraryCount = rows.filter((row) => row.kind === 'library').length;
  const remoteCount = rows.filter((row) => row.kind === 'remote').length;

  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search papers and commands">
        <div className="palette-head">
          <SearchIcon size={20} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <label className="vh" htmlFor="palette-input">
            Search your library and arXiv
          </label>
          <input
            id="palette-input"
            autoFocus
            type="search"
            value={query}
            placeholder="Search your library and arXiv…"
            onChange={(event) => setQuery(event.target.value)}
          />
          {busy ? <span className="spinner" aria-label="Searching arXiv" /> : null}
          <kbd>esc</kbd>
        </div>

        <div className="palette-body">
          {libraryCount ? <div className="eyebrow" style={{ padding: '6px 12px 8px' }}>In your library</div> : null}
          {rows.map((row, position) => {
            const active = position === cursor;
            const heading =
              row.kind === 'remote' && position === libraryCount
                ? hasProxy
                  ? 'New on arXiv'
                  : 'Found online'
                : null;
            const actionHeading =
              row.kind === 'action' && position === libraryCount + remoteCount ? 'Actions' : null;
            return (
              <div key={`${row.kind}-${position}`}>
                {heading ? <div className="eyebrow" style={{ padding: '12px 12px 8px' }}>{heading}</div> : null}
                {actionHeading ? <div className="eyebrow" style={{ padding: '12px 12px 8px' }}>{actionHeading}</div> : null}
                <button
                  type="button"
                  className={`palette-row ${active ? 'is-active' : ''}`}
                  onMouseEnter={() => setCursor(position)}
                  onClick={(event) => void activate(row, event.shiftKey)}
                >
                  {row.kind === 'library' ? <StackIcon size={17} /> : null}
                  {row.kind === 'remote' ? <FileIcon size={17} /> : null}
                  {row.kind === 'action' ? (
                    row.id === 'settings' ? <SettingsIcon size={17} /> : <PlusIcon size={17} />
                  ) : null}
                  <span style={{ flexGrow: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {row.kind === 'remote' ? row.ref.title : row.title}
                    </span>
                    <span className="palette-sub">
                      {row.kind === 'remote'
                        ? `${row.ref.arxivId ? `arXiv:${row.ref.arxivId} · ` : ''}${row.ref.authors.slice(0, 2).join(', ')}`
                        : row.kind === 'library'
                          ? row.sub
                          : ''}
                    </span>
                  </span>
                  {active && row.kind === 'remote' ? (
                    <span style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>↵ add</span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> add to collection
          </span>
          <span>
            <kbd>⇧↵</kbd> add and open
          </span>
          <span style={{ flexGrow: 1 }} />
          <span style={{ color: 'var(--muted)' }}>{hasProxy ? 'arXiv' : 'OpenAlex'} · your library</span>
        </div>
      </div>
    </>
  );
}
