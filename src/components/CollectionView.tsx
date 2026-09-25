import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { View } from '../types.view';
import type { Paper } from '../types';
import { STATUS_LABEL, statusOf, type ReadingStatus } from '../lib/status';
import { driveFolderUrl } from '../lib/driveSync';
import { authorLine, relativeDay } from '../lib/libraryLook';
import {
  DEFAULT_PREFS,
  DETAIL_LABEL,
  GROUP_LABEL,
  LAYOUT_LABEL,
  SORT_LABEL,
  groupPapers,
  readPrefs,
  sortPapers,
  writePrefs,
  type Detail,
  type GroupBy,
  type Layout,
  type SortBy,
  type ViewPrefs,
} from '../lib/libraryView';
import { useNoteCounts } from '../lib/notes';
import { CheckIcon, CloseIcon, CloudCheckIcon, CloudIcon, DriveMark, FlagIcon, FolderMoveIcon, GridIcon, ListIcon, NoteIcon, PlusIcon, SearchIcon, SlidersIcon, TableIcon, TrashIcon } from './icons';
import RemovePaperDialog from './RemovePaperDialog';
import { CoverTile, Menu, PAPERS_MIME, ProgressRing, progressLabel } from './LibraryBits';

interface Props {
  view: View;
  onOpenPaper: (id: string) => void;
  onDiscover: () => void;
}

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

const yearOf = (paper: Paper) => /^\d{4}/.exec(paper.published || '')?.[0] ?? '';

export default function CollectionView({ view, onOpenPaper, onDiscover }: Props) {
  const { papers, collections, highlights, driveConnected, syncPaper, syncStateFor, setPaperCollections, setReadingStatus, createCollection } = useStore();
  const [filter, setFilter] = useState('');
  const [prefs, setPrefs] = useState<ViewPrefs>(() => readPrefs());
  const { layout, sort, group: groupBy } = prefs;
  const shows = (detail: Detail) => prefs.show.includes(detail);
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

  const choose = (patch: Partial<ViewPrefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writePrefs(next);
      return next;
    });
  const chooseLayout = (layout: Layout) => choose({ layout });
  const toggleDetail = (detail: Detail) =>
    choose({ show: prefs.show.includes(detail) ? prefs.show.filter((item) => item !== detail) : [...prefs.show, detail] });

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
    return sortPapers(list, sort);
  }, [scoped, filter, sort]);

  // Inside a collection, grouping by collection would put everything under its own name.
  const grouping: GroupBy = groupBy === 'collection' && collection ? 'none' : groupBy;
  const groups = useMemo(() => groupPapers(rows, grouping, collections), [rows, grouping, collections]);
  /** The papers in the order they are shown, once each: what a shift-click's range runs along. */
  const shown = useMemo(() => [...new Set(groups.flatMap((group) => group.items.map((paper) => paper.id)))], [groups]);

  const highlightCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const highlight of highlights) counts.set(highlight.paperId, (counts.get(highlight.paperId) ?? 0) + 1);
    return counts;
  }, [highlights]);
  const noteCounts = useNoteCounts();
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
          const ids = shown;
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
    [shown],
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
    const noted = noteCounts.get(paper.id) ?? 0;
    const elsewhere = paper.collectionIds
      .filter((id) => id !== collection?.id)
      .map((id) => collections.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return (
      <span className="lib-meta">
        {!shows('venue') ? null : paper.venue ? <span className="lib-venue">{paper.venue}</span> : paper.arxivId ? <span className="mono">arXiv:{paper.arxivId}</span> : null}
        {!shows('collections') ? null : elsewhere.slice(0, 2).map((item) => (
          <span key={item.id} className="lib-chip">
            <span className="dot" style={{ background: item.color }} />
            {item.name}
          </span>
        ))}
        {count && shows('highlights') ? <span className="lib-chip hl">{count} highlight{count === 1 ? '' : 's'}</span> : null}
        {noted && shows('highlights') ? (
          <span className="lib-chip note" title="Pieces in this paper's notes">
            <NoteIcon size={11} /> {noted} note{noted === 1 ? '' : 's'}
          </span>
        ) : null}
        {!shows('collections') ? null : paper.tags.slice(0, 2).map((tag) => (
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
          {shows('authors') ? <span className="lib-authors">{authorLine(paper.authors)}</span> : null}
          {meta(paper)}
        </button>
        <div className="lib-status" title={`Added ${relativeDay(paper.addedAt)}${paper.lastOpenedAt ? `, last opened ${relativeDay(paper.lastOpenedAt)}` : ''}`}>
          {shows('progress') ? (
            <>
              <ProgressRing progress={paper.progress} />
              <span>{progressLabel(paper.progress)}</span>
            </>
          ) : null}
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
          {shows('progress') ? (
            <span className="lib-card-ring">
              <ProgressRing progress={paper.progress} size={26} />
            </span>
          ) : null}
          {paper.venue && shows('venue') ? <span className="lib-card-venue">{paper.venue}</span> : null}
        </div>
        <button type="button" className="lib-card-body" onClick={(event) => open(paper, event)} title={selecting ? 'Click to select or unselect' : undefined}>
          <span className="paper-name">{paper.title}</span>
          {shows('authors') ? <span className="lib-authors">{authorLine(paper.authors, 2)}</span> : null}
          {shows('collections') || shows('highlights') ? meta({ ...paper, venue: undefined, arxivId: undefined }) : null}
        </button>
        <div className="lib-card-foot">
          <span className="lib-card-state">{shows('progress') ? progressLabel(paper.progress) : ''}</span>
          {actions(paper)}
        </div>
      </div>
    );
  };

  /** One line to a paper: the columns the View menu leaves on, and nothing that wraps. */
  const line = (paper: Paper) => {
    const isSelected = selected.has(paper.id);
    const count = highlightCounts.get(paper.id) ?? 0;
    const noted = noteCounts.get(paper.id) ?? 0;
    return (
      <div
        key={paper.id}
        className={`lib-line${isSelected ? ' is-selected' : ''}`}
        draggable
        onDragStart={(event) => onDragStart(paper, event)}
        style={{ gridTemplateColumns: columns }}
      >
        <CoverTile paper={paper} size="mini" selected={isSelected} selecting={selecting} onToggle={(event) => toggle(paper.id, event)} label={`Select ${paper.title}`} />
        <button type="button" className="lib-line-title" onClick={(event) => open(paper, event)} title={paper.title}>
          <span className="lib-line-text">{paper.title}</span>
          {count && shows('highlights') ? <span className="lib-line-count" title={`${count} highlight${count === 1 ? '' : 's'}`}>{count}</span> : null}
          {noted && shows('highlights') ? (
            <span className="lib-line-count is-notes" title={`${noted} piece${noted === 1 ? '' : 's'} in its notes`}>
              <NoteIcon size={10} />
              {noted}
            </span>
          ) : null}
        </button>
        {shows('authors') ? <span className="lib-line-cell">{authorLine(paper.authors, 2)}</span> : null}
        {shows('venue') ? <span className="lib-line-cell lib-venue">{paper.venue || (paper.arxivId ? `arXiv:${paper.arxivId}` : '')}</span> : null}
        <span className="lib-line-cell mono">{yearOf(paper)}</span>
        <span className="lib-line-cell">{relativeDay(paper.addedAt)}</span>
        {shows('progress') ? (
          <span className="lib-line-cell lib-line-progress">
            <ProgressRing progress={paper.progress} size={18} />
            {progressLabel(paper.progress).replace(' read', '')}
          </span>
        ) : null}
        {actions(paper)}
      </div>
    );
  };
  const columns = [
    '22px',
    'minmax(180px, 3fr)',
    shows('authors') ? 'minmax(100px, 1.4fr)' : '',
    shows('venue') ? 'minmax(100px, 1.4fr)' : '',
    '46px',
    '84px',
    shows('progress') ? '104px' : '',
    '100px',
  ]
    .filter(Boolean)
    .join(' ');
  const tableHead = (
    <div className="lib-line lib-line-head" style={{ gridTemplateColumns: columns }} aria-hidden="true">
      <span />
      <span>Title</span>
      {shows('authors') ? <span>Authors</span> : null}
      {shows('venue') ? <span>Journal</span> : null}
      <span>Year</span>
      <span>Added</span>
      {shows('progress') ? <span>Progress</span> : null}
      <span />
    </div>
  );

  const option = (checked: boolean, label: string, onPick: () => void, role: 'menuitemradio' | 'menuitemcheckbox' = 'menuitemradio') => (
    <button key={label} type="button" role={role} aria-checked={checked} className={checked ? 'is-checked' : ''} onClick={onPick}>
      <span className="menu-tick">{checked ? <CheckIcon size={13} strokeWidth={2.4} /> : null}</span>
      {label}
    </button>
  );

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
          <span style={{ flexGrow: 1 }} />
          <div className="segmented" role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === 'list'} onClick={() => chooseLayout('list')} title="List" aria-label="Show as a list">
              <ListIcon size={15} />
            </button>
            <button type="button" aria-pressed={layout === 'grid'} onClick={() => chooseLayout('grid')} title="Cards" aria-label="Show as cards">
              <GridIcon size={15} />
            </button>
            <button type="button" aria-pressed={layout === 'compact'} onClick={() => chooseLayout('compact')} title="Compact table" aria-label="Show as a compact table">
              <TableIcon size={15} />
            </button>
          </div>
          <Menu label="View" icon={<SlidersIcon size={15} />} className="btn view-btn" title="Choose how the papers are shown" align="right">
            {() => (
              <div className="view-menu">
                <div>
                  <p className="menu-label">Layout</p>
                  {(Object.keys(LAYOUT_LABEL) as Layout[]).map((each) => option(layout === each, LAYOUT_LABEL[each], () => chooseLayout(each)))}
                  <p className="menu-label">Group by</p>
                  {(Object.keys(GROUP_LABEL) as GroupBy[])
                    .filter((each) => !(each === 'collection' && collection))
                    .map((each) => option(groupBy === each, GROUP_LABEL[each], () => choose({ group: each })))}
                </div>
                <div>
                  <p className="menu-label">Sort by</p>
                  {(Object.keys(SORT_LABEL) as SortBy[]).map((each) => option(sort === each, SORT_LABEL[each], () => choose({ sort: each })))}
                  <p className="menu-label">Show</p>
                  {(Object.keys(DETAIL_LABEL) as Detail[]).map((each) => option(shows(each), DETAIL_LABEL[each], () => toggleDetail(each), 'menuitemcheckbox'))}
                  <hr />
                  <button type="button" role="menuitem" onClick={() => choose(DEFAULT_PREFS)}>
                    <span className="menu-tick" />
                    Reset to default
                  </button>
                </div>
              </div>
            )}
          </Menu>
        </div>
        <p className="view-summary">
          {LAYOUT_LABEL[layout]}
          {grouping !== 'none' ? ` · grouped by ${GROUP_LABEL[grouping].replace(/ \(.*\)$/, '').toLowerCase()}` : ''} · sorted by {SORT_LABEL[sort].toLowerCase()}
        </p>
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

        {layout === 'compact' && rows.length ? tableHead : null}
        {groups.map((group) => (
          <Fragment key={group.key}>
            {group.name ? (
              <h2 className="lib-group">
                {group.color ? <span className="dot" style={{ background: group.color }} /> : null}
                {group.name}
                <span>{group.items.length}</span>
              </h2>
            ) : null}
            {layout === 'grid' ? (
              <div className="lib-grid">{group.items.map(card)}</div>
            ) : layout === 'compact' ? (
              <div className="lib-table">{group.items.map(line)}</div>
            ) : (
              <div className="lib-list">{group.items.map(row)}</div>
            )}
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
