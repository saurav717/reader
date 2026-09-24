import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { View } from '../types.view';
import type { Paper } from '../types';
import { STATUS_LABEL, statusOf, type ReadingStatus } from '../lib/status';
import { driveFolderUrl } from '../lib/driveSync';
import { authorLine, dayGroup, relativeDay } from '../lib/libraryLook';
import { CloseIcon, CloudCheckIcon, CloudIcon, DriveMark, FlagIcon, FolderMoveIcon, GridIcon, ListIcon, PlusIcon, SearchIcon, TrashIcon } from './icons';
import RemovePaperDialog from './RemovePaperDialog';
import { CoverTile, Menu, PAPERS_MIME, ProgressRing, progressLabel } from './LibraryBits';

interface Props {
  view: View;
  onOpenPaper: (id: string) => void;
  onDiscover: () => void;
}

type Sort = 'added' | 'opened' | 'title' | 'year' | 'progress';
type Layout = 'list' | 'grid';

const LAYOUT_KEY = 'reader.libraryLayout';
const readLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
};

function headingFor(view: View, name?: string): string {
  switch (view.kind) {
    case 'all':
      return 'All papers';
    case 'reading':
      return 'Reading now';
    case 'unread':
      return 'Not started';
    case 'finished':
      return 'Finished';
    case 'unsorted':
      return 'Unsorted';
    default:
      return name || 'Collection';
  }
}

/**
 * Where a paper sits in Drive. The folder id is recorded on the first sync;
 * papers saved before per-paper folders existed only have the PDF's own link,
 * which is still somewhere to go.
 */
function driveFolderLink(paper: Paper): string | null {
  if (paper.drive?.folderId) return paper.drive.folderLink || driveFolderUrl(paper.drive.folderId);
  return paper.drive?.pdfLink ?? null;
}

const yearOf = (paper: Paper) => Number(/^\d{4}/.exec(paper.published || '')?.[0]) || 0;

export default function CollectionView({ view, onOpenPaper, onDiscover }: Props) {
  const { papers, collections, highlights, driveConnected, syncPaper, syncStateFor, setPaperCollections, setReadingStatus, createCollection } = useStore();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('added');
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  /** The papers the bin was pressed on, while the notice asks whether to go ahead. */
  const [removing, setRemoving] = useState<Paper[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const collection = view.kind === 'collection' ? collections.find((item) => item.id === view.id) : undefined;
  const heading = headingFor(view, collection?.name);
  const viewKey = view.kind === 'collection' ? `collection:${view.id}` : view.kind;

  // A selection belongs to the list it was made in.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [viewKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // remembered for this visit only
    }
  };

  const scoped = useMemo(() => {
    let list: Paper[] = papers;
    if (view.kind === 'collection') list = list.filter((paper) => paper.collectionIds.includes(view.id));
    if (view.kind === 'unsorted') list = list.filter((paper) => paper.collectionIds.length === 0);
    if (view.kind === 'reading') list = list.filter((paper) => statusOf(paper) === 'reading');
    if (view.kind === 'unread') list = list.filter((paper) => statusOf(paper) === 'unread');
    if (view.kind === 'finished') list = list.filter((paper) => statusOf(paper) === 'finished');
    return list;
  }, [papers, view]);

  const rows = useMemo(() => {
    let list = scoped;
    const needle = filter.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (paper) =>
          paper.title.toLowerCase().includes(needle) ||
          paper.authors.join(' ').toLowerCase().includes(needle) ||
          (paper.venue || '').toLowerCase().includes(needle) ||
          paper.tags.join(' ').toLowerCase().includes(needle),
      );
    }
    const sorted = list.slice();
    sorted.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'progress') return b.progress - a.progress;
      if (sort === 'year') return yearOf(b) - yearOf(a);
      if (sort === 'opened') return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
      return b.addedAt.localeCompare(a.addedAt);
    });
    return sorted;
  }, [scoped, filter, sort]);

  // Sorted by when they came in, the list reads as a diary: today, this week, and so on.
  const groups = useMemo(() => {
    // Cards read as a shelf; headings between them would leave it full of gaps.
    if (sort !== 'added' || layout === 'grid') return [{ name: '', items: rows }];
    const out: { name: string; items: Paper[] }[] = [];
    for (const paper of rows) {
      const name = dayGroup(paper.addedAt);
      const last = out[out.length - 1];
      if (last?.name === name) last.items.push(paper);
      else out.push({ name, items: [paper] });
    }
    return out;
  }, [rows, sort, layout]);

  const highlightCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const highlight of highlights) counts.set(highlight.paperId, (counts.get(highlight.paperId) ?? 0) + 1);
    return counts;
  }, [highlights]);
  const highlightTotal = rows.reduce((total, paper) => total + (highlightCounts.get(paper.id) ?? 0), 0);
  const readingCount = rows.filter((paper) => statusOf(paper) === 'reading').length;

  // Papers that leave the list — removed, moved elsewhere — leave the selection with it.
  useEffect(() => {
    const here = new Set(rows.map((paper) => paper.id));
    setSelected((current) => {
      const kept = [...current].filter((id) => here.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [rows]);

  const chosen = rows.filter((paper) => selected.has(paper.id));
  const selecting = selected.size > 0;
  const allChosen = rows.length > 0 && chosen.length === rows.length;

  const toggle = useCallback(
    (id: string, event?: { shiftKey?: boolean }) => {
      setSelected((current) => {
        const next = new Set(current);
        if (event?.shiftKey && anchor.current && anchor.current !== id) {
          // A range, from the last one ticked to this one, all set the way the anchor is.
          const ids = rows.map((paper) => paper.id);
          const from = ids.indexOf(anchor.current);
          const to = ids.indexOf(id);
          if (from !== -1 && to !== -1) {
            const on = current.has(anchor.current);
            for (const each of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
              if (on) next.add(each);
              else next.delete(each);
            }
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        anchor.current = id;
        return next;
      });
    },
    [rows],
  );

  const selectAll = () => setSelected(allChosen ? new Set() : new Set(rows.map((paper) => paper.id)));
  const clear = () => setSelected(new Set());

  // Escape lets go of the selection; ⌘A / Ctrl+A takes the whole list, outside a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
      if (event.key === 'Escape' && selected.size && !document.querySelector('.sheet')) clear();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !typing && rows.length && !document.querySelector('.sheet')) {
        event.preventDefault();
        setSelected(new Set(rows.map((paper) => paper.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selected.size]);

  const open = (paper: Paper, event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || selecting) {
      event.preventDefault();
      toggle(paper.id, event);
      return;
    }
    onOpenPaper(paper.id);
  };

  const onDragStart = (paper: Paper, event: React.DragEvent) => {
    const ids = selected.has(paper.id) ? chosen.map((item) => item.id) : [paper.id];
    event.dataTransfer.setData(PAPERS_MIME, JSON.stringify(ids));
    event.dataTransfer.setData('text/plain', ids.length === 1 ? paper.title : `${ids.length} papers`);
    event.dataTransfer.effectAllowed = 'copyMove';
    // The picture that follows the pointer says how many are going.
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = ids.length === 1 ? paper.title : `${ids.length} papers`;
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 14, 14);
    window.setTimeout(() => ghost.remove(), 0);
  };

  const plural = (count: number) => `${count} paper${count === 1 ? '' : 's'}`;

  const moveTo = async (targetId: string | null) => {
    const target = targetId ? collections.find((item) => item.id === targetId) : undefined;
    for (const paper of chosen) {
      let ids = paper.collectionIds;
      // Moved out of the collection being looked at; elsewhere, added to the one chosen.
      if (collection) ids = ids.filter((id) => id !== collection.id);
      if (targetId === null) ids = collection ? ids : [];
      else if (!ids.includes(targetId)) ids = [...ids, targetId];
      if (ids.join() !== paper.collectionIds.join()) await setPaperCollections(paper.id, ids);
    }
    setToast(
      targetId === null
        ? collection
          ? `Took ${plural(chosen.length)} out of ${collection.name}`
          : `Took ${plural(chosen.length)} out of every collection`
        : `${collection ? 'Moved' : 'Added'} ${plural(chosen.length)} to ${target?.name ?? 'the collection'}`,
    );
    clear();
  };

  const moveToNew = async () => {
    const name = window.prompt('Name the new collection');
    if (!name?.trim()) return;
    const created = await createCollection(name.trim());
    await moveTo(created.id);
  };

  const mark = async (status: ReadingStatus) => {
    await setReadingStatus(chosen.map((paper) => paper.id), status);
    setToast(`Marked ${plural(chosen.length)} ${STATUS_LABEL[status].toLowerCase()}`);
    clear();
  };

  const saveAll = () => {
    for (const paper of chosen) syncPaper(paper.id);
    setToast(`Saving ${plural(chosen.length)} to Drive`);
  };

  const actions = (paper: Paper) => {
    const state = syncStateFor(paper.id);
    const folderLink = driveFolderLink(paper);
    return (
      <div className="lib-actions">
        {folderLink ? (
          <a
            className="icon-btn sm"
            href={folderLink}
            target="_blank"
            rel="noreferrer"
            title={`Open ${paper.drive?.folderName || paper.title} in Google Drive`}
            aria-label={`Find ${paper.title} on Google Drive`}
          >
            <DriveMark size={15} />
          </a>
        ) : null}
        {driveConnected ? (
          <button
            type="button"
            className="icon-btn sm"
            title={
              state === 'error'
                ? `Drive sync failed: ${paper.drive?.error ?? 'unknown error'}`
                : paper.drive?.syncedAt
                  ? `Saved to Drive ${new Date(paper.drive.syncedAt).toLocaleString()}`
                  : 'Save to Drive'
            }
            aria-label="Save this paper to Drive"
            onClick={() => syncPaper(paper.id)}
          >
            {state === 'running' || state === 'queued' ? (
              <span className="spinner" />
            ) : paper.drive?.syncedAt ? (
              <CloudCheckIcon size={16} style={{ color: 'var(--accent)' }} />
            ) : (
              <CloudIcon size={16} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn sm"
          title="Move to Junk"
          aria-label={`Remove ${paper.title} from the library`}
          onClick={() => setRemoving([paper])}
        >
          <TrashIcon size={16} />
        </button>
      </div>
    );
  };

  const meta = (paper: Paper) => {
    const count = highlightCounts.get(paper.id) ?? 0;
    const elsewhere = paper.collectionIds
      .filter((id) => id !== collection?.id)
      .map((id) => collections.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return (
      <span className="lib-meta">
        {paper.venue ? <span className="lib-venue">{paper.venue}</span> : paper.arxivId ? <span className="mono">arXiv:{paper.arxivId}</span> : null}
        {elsewhere.slice(0, 2).map((item) => (
          <span key={item.id} className="lib-chip">
            <span className="dot" style={{ background: item.color }} />
            {item.name}
          </span>
        ))}
        {count ? <span className="lib-chip hl">{count} highlight{count === 1 ? '' : 's'}</span> : null}
        {paper.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="lib-chip">
            #{tag}
          </span>
        ))}
      </span>
    );
  };

  const row = (paper: Paper) => {
    const isSelected = selected.has(paper.id);
    return (
      <div
        key={paper.id}
        className={`lib-row${isSelected ? ' is-selected' : ''}`}
        draggable
        onDragStart={(event) => onDragStart(paper, event)}
      >
        <CoverTile
          paper={paper}
          selected={isSelected}
          selecting={selecting}
          onToggle={(event) => toggle(paper.id, event)}
          label={`Select ${paper.title}`}
        />
        <button type="button" className="lib-main" onClick={(event) => open(paper, event)} title={selecting ? 'Click to select or unselect' : undefined}>
          <span className="paper-name">{paper.title}</span>
          <span className="lib-authors">{authorLine(paper.authors)}</span>
          {meta(paper)}
        </button>
        <div className="lib-status" title={`Added ${relativeDay(paper.addedAt)}${paper.lastOpenedAt ? `, last opened ${relativeDay(paper.lastOpenedAt)}` : ''}`}>
          <ProgressRing progress={paper.progress} />
          <span>{progressLabel(paper.progress)}</span>
        </div>
        {actions(paper)}
      </div>
    );
  };

  const card = (paper: Paper) => {
    const isSelected = selected.has(paper.id);
    return (
      <div
        key={paper.id}
        className={`lib-card${isSelected ? ' is-selected' : ''}`}
        draggable
        onDragStart={(event) => onDragStart(paper, event)}
      >
        <div className="lib-card-band">
          <CoverTile
            paper={paper}
            size="card"
            selected={isSelected}
            selecting={selecting}
            onToggle={(event) => toggle(paper.id, event)}
            label={`Select ${paper.title}`}
          />
          <span className="lib-card-ring">
            <ProgressRing progress={paper.progress} size={26} />
          </span>
          {paper.venue ? <span className="lib-card-venue">{paper.venue}</span> : null}
        </div>
        <button type="button" className="lib-card-body" onClick={(event) => open(paper, event)} title={selecting ? 'Click to select or unselect' : undefined}>
          <span className="paper-name">{paper.title}</span>
          <span className="lib-authors">{authorLine(paper.authors, 2)}</span>
        </button>
        <div className="lib-card-foot">
          <span className="lib-card-state">{progressLabel(paper.progress)}</span>
          {actions(paper)}
        </div>
      </div>
    );
  };

  return (
    <div className="main library-main">
      <div className="collection-head">
        <div className="collection-titlebar">
          {collection ? <span className="collection-swatch" style={{ background: collection.color }} /> : null}
          <h1 className="collection-title">{heading}</h1>
          <span style={{ flexGrow: 1 }} />
          <button
            type="button"
            className="btn primary"
            onClick={onDiscover}
            title={
              collection
                ? `Search for papers, books or a PDF link in the Discover panel, and add them to ${collection.name}`
                : 'Search for papers, books or a PDF link in the Discover panel, and add them to your library'
            }
          >
            <PlusIcon size={15} /> Add papers
          </button>
        </div>
        <p className="collection-sub">
          <span>{plural(rows.length)}</span>
          {readingCount ? <span>{readingCount} in progress</span> : null}
          <span>
            {highlightTotal} highlight{highlightTotal === 1 ? '' : 's'}
          </span>
          {driveConnected ? <span>mirrored to Drive</span> : null}
        </p>

        <div className="collection-toolbar">
          <span
            className={`select-all${allChosen ? ' is-all' : selecting ? ' is-some' : ''}`}
            role="checkbox"
            aria-checked={allChosen ? true : selecting ? 'mixed' : false}
            aria-label={allChosen ? 'Select none' : 'Select every paper in the list'}
            title={allChosen ? 'Select none' : 'Select all (⌘A)'}
            tabIndex={rows.length ? 0 : -1}
            onClick={() => rows.length && selectAll()}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                if (rows.length) selectAll();
              }
            }}
          >
            <span className="box" />
          </span>
          <label className="vh" htmlFor="collection-filter">
            Filter papers
          </label>
          <div className="field collection-filter">
            <SearchIcon size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <input
              id="collection-filter"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={collection ? `Filter ${collection.name}` : 'Filter by title, author, journal or tag'}
            />
          </div>
          <label className="vh" htmlFor="collection-sort">
            Sort by
          </label>
          <select id="collection-sort" className="collection-sort" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            <option value="added">Recently added</option>
            <option value="opened">Recently opened</option>
            <option value="title">Title</option>
            <option value="year">Year published</option>
            <option value="progress">Progress</option>
          </select>
          <span style={{ flexGrow: 1 }} />
          <div className="segmented" role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === 'list'} onClick={() => chooseLayout('list')} title="List" aria-label="Show as a list">
              <ListIcon size={15} />
            </button>
            <button type="button" aria-pressed={layout === 'grid'} onClick={() => chooseLayout('grid')} title="Cards" aria-label="Show as cards">
              <GridIcon size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className={`scroll library-scroll${selecting ? ' has-selection' : ''}`}>
        {!rows.length ? (
          <div className="empty">
            <h3>{filter ? 'Nothing matches that' : 'Nothing here yet'}</h3>
            <p>
              {filter
                ? 'Try part of a title, an author’s surname, a journal or a tag.'
                : 'Search for a paper or a book in the Discover panel — or paste the link to any PDF there — and add it to this collection.'}
            </p>
            {filter ? null : (
              <button type="button" className="btn primary" onClick={onDiscover} style={{ marginTop: 10 }}>
                <PlusIcon size={15} /> Find papers
              </button>
            )}
          </div>
        ) : null}

        {groups.map((group) => (
          <Fragment key={group.name || 'all'}>
            {group.name ? (
              <h2 className="lib-group">
                {group.name}
                <span>{group.items.length}</span>
              </h2>
            ) : null}
            {layout === 'grid' ? <div className="lib-grid">{group.items.map(card)}</div> : <div className="lib-list">{group.items.map(row)}</div>}
          </Fragment>
        ))}
      </div>

      {selecting ? (
        <div className="selection-bar" role="toolbar" aria-label="What to do with the selected papers">
          <span className="selection-count">
            <strong>{chosen.length}</strong> selected
            {!allChosen ? (
              <button type="button" className="link-btn" onClick={selectAll}>
                Select all {rows.length}
              </button>
            ) : null}
          </span>
          <span className="selection-sep" />
          <Menu up label={collection ? 'Move to' : 'Add to'} icon={<FolderMoveIcon size={15} />} className="btn sm ghost">
            {(close) => (
              <>
                <p className="menu-label">{collection ? `Move out of ${collection.name} into` : 'Add to the collection'}</p>
                {collections
                  .filter((item) => item.id !== collection?.id)
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close();
                        void moveTo(item.id);
                      }}
                    >
                      <span className="dot" style={{ background: item.color }} /> {item.name}
                    </button>
                  ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    void moveToNew();
                  }}
                >
                  <PlusIcon size={13} /> New collection…
                </button>
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    void moveTo(null);
                  }}
                >
                  {collection ? `Take out of ${collection.name}` : 'Take out of every collection'}
                </button>
              </>
            )}
          </Menu>
          <Menu up label="Mark as" icon={<FlagIcon size={15} />} className="btn sm ghost">
            {(close) =>
              (['unread', 'reading', 'finished'] as ReadingStatus[]).map((status) => (
                <button
                  key={status}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    void mark(status);
                  }}
                >
                  <span className={`status-dot is-${status}`} /> {STATUS_LABEL[status]}
                </button>
              ))
            }
          </Menu>
          {driveConnected ? (
            <button type="button" className="btn sm ghost" onClick={saveAll}>
              <CloudIcon size={15} /> Save to Drive
            </button>
          ) : null}
          <button type="button" className="btn sm danger-ghost" onClick={() => setRemoving(chosen)}>
            <TrashIcon size={15} /> Move to Junk
          </button>
          <button type="button" className="icon-btn sm" onClick={clear} aria-label="Clear the selection" title="Clear the selection (Esc)">
            <CloseIcon size={15} />
          </button>
        </div>
      ) : null}

      {toast ? (
        <div className={`lib-toast${selecting ? ' raised' : ''}`} role="status">
          {toast}
        </div>
      ) : null}

      {removing ? (
        <RemovePaperDialog
          papers={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(ids) => ids.length && setToast(`Moved ${plural(ids.length)} to Junk`)}
        />
      ) : null}
    </div>
  );
}
