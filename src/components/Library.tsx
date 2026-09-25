import { useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { STATUS_LABEL, STATUS_ORDER, statusOf, type ReadingStatus } from '../lib/status';
import { coverFor } from '../lib/libraryLook';
import type { View } from '../types.view';
import type { Paper } from '../types';
import { useNoteCounts } from '../lib/notes';
import { CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, InboxIcon, NoteIcon, PlusIcon, StackIcon, TrashIcon } from './icons';
import RemovePaperDialog from './RemovePaperDialog';
import { PAPERS_MIME, ProgressRing, carriesPapers, draggedPapers } from './LibraryBits';

interface Props {
  view: View;
  activePaperId: string | null;
  onSelect: (view: View) => void;
  onOpenPaper: (id: string) => void;
  onClose: () => void;
}

/** Which papers the status groups below the nav are about. */
function scopeOf(papers: Paper[], view: View, collectionId: string | null): Paper[] {
  if (collectionId) return papers.filter((paper) => paper.collectionIds.includes(collectionId));
  if (view.kind === 'unsorted') return papers.filter((paper) => paper.collectionIds.length === 0);
  return papers;
}

const yearOf = (paper: Paper) => /^\d{4}/.exec(paper.published || '')?.[0];

export default function Library({ view, activePaperId, onSelect, onOpenPaper, onClose }: Props) {
  const { papers, collections, createCollection, junk, setPaperCollections, setReadingStatus } = useStore();
  const noteCounts = useNoteCounts();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [collapsed, setCollapsed] = useState<ReadingStatus[]>([]);
  /** The nav item papers are being dragged over, to light it up. */
  const [over, setOver] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Paper[] | null>(null);

  // Opening a paper leaves the view on the paper, so the panel remembers the
  // collection you came from rather than falling back to everything.
  const [lastCollectionId, setLastCollectionId] = useState<string | null>(view.kind === 'collection' ? view.id : null);
  const collectionId = view.kind === 'collection' ? view.id : view.kind === 'paper' ? lastCollectionId : null;
  const collection = collections.find((item) => item.id === collectionId);

  const counts = useMemo(() => {
    const tally: Record<ReadingStatus, number> = { reading: 0, unread: 0, finished: 0 };
    for (const paper of papers) tally[statusOf(paper)] += 1;
    return tally;
  }, [papers]);

  const unsorted = papers.filter((paper) => paper.collectionIds.length === 0).length;

  const groups = useMemo(() => {
    const scope = scopeOf(papers, view, collectionId);
    const sorted = scope.slice().sort((a, b) => (b.lastOpenedAt || b.addedAt).localeCompare(a.lastOpenedAt || a.addedAt));
    return STATUS_ORDER.map((status) => ({ status, items: sorted.filter((paper) => statusOf(paper) === status) }));
  }, [papers, view, collectionId]);

  const scopeName = collection ? collection.name : view.kind === 'unsorted' ? 'Unsorted' : 'Everything';
  const scopeTotal = groups.reduce((total, group) => total + group.items.length, 0);

  const select = (next: View) => {
    if (next.kind === 'collection') setLastCollectionId(next.id);
    else if (next.kind !== 'paper') setLastCollectionId(null);
    onSelect(next);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed) {
      const created = await createCollection(trimmed);
      select({ kind: 'collection', id: created.id });
    }
    setName('');
    setAdding(false);
  };

  /** What dropping papers on a nav item does: file them, mark them, or send them to Junk. */
  const drop = async (target: string, ids: string[]) => {
    const dropped = ids.map((id) => papers.find((paper) => paper.id === id)).filter((paper): paper is Paper => Boolean(paper));
    if (!dropped.length) return;
    if (target === 'junk') return setRemoving(dropped);
    if (target === 'reading' || target === 'unread' || target === 'finished') return setReadingStatus(ids, target);
    for (const paper of dropped) {
      if (target === 'unsorted') {
        if (paper.collectionIds.length) await setPaperCollections(paper.id, []);
      } else if (target.startsWith('collection:')) {
        const id = target.slice('collection:'.length);
        if (!paper.collectionIds.includes(id)) await setPaperCollections(paper.id, [...paper.collectionIds, id]);
      }
    }
  };

  const dropProps = (target: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!carriesPapers(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = target === 'junk' ? 'move' : 'copy';
      if (over !== target) setOver(target);
    },
    onDragLeave: () => setOver((current) => (current === target ? null : current)),
    onDrop: (event: React.DragEvent) => {
      const ids = draggedPapers(event);
      setOver(null);
      if (!ids) return;
      event.preventDefault();
      void drop(target, ids);
    },
  });

  const navItem = (key: string, next: View, icon: ReactNode, label: string, count: number, hint?: string) => (
    <button
      type="button"
      className={`nav-item${(next.kind === 'collection' ? collectionId === next.id : view.kind === next.kind) ? ' is-active' : ''}${over === key ? ' is-drop' : ''}`}
      onClick={() => select(next)}
      title={hint}
      {...(key === 'all' ? {} : dropProps(key))}
    >
      {icon} <span className="nav-label">{label}</span> <span className="count">{count}</span>
    </button>
  );

  return (
    <aside className="panel narrow library-panel" aria-label="Library">
      <div className="panel-head">
        <h2>Library</h2>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the library panel">
          <CloseIcon size={17} />
        </button>
      </div>

      <nav className="library-nav" aria-label="Views">
        {navItem('all', { kind: 'all' }, <StackIcon size={16} />, 'All papers', papers.length)}
        {navItem('reading', { kind: 'reading' }, <ClockIcon size={16} />, 'Reading now', counts.reading, 'Drop papers here to mark them as being read')}
        {navItem('unread', { kind: 'unread' }, <InboxIcon size={16} />, 'Not started', counts.unread, 'Drop papers here to mark them as not started')}
        {navItem('finished', { kind: 'finished' }, <CheckIcon size={16} />, 'Finished', counts.finished, 'Drop papers here to mark them as finished')}
        {navItem('unsorted', { kind: 'unsorted' }, <StackIcon size={16} />, 'Unsorted', unsorted, 'Drop papers here to take them out of every collection')}
      </nav>

      <div className="library-section-head">
        <span className="eyebrow">Collections</span>
        <button type="button" className="icon-btn sm" onClick={() => setAdding(true)} aria-label="New collection" title="New collection">
          <PlusIcon size={15} />
        </button>
      </div>

      <div className="library-nav">
        {adding ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            style={{ padding: '2px 0 6px' }}
          >
            <label className="vh" htmlFor="new-collection">
              Collection name
            </label>
            <input
              id="new-collection"
              className="collection-name-input"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void submit()}
              placeholder="Collection name"
            />
          </form>
        ) : null}

        {collections.map((item) =>
          navItem(
            `collection:${item.id}`,
            { kind: 'collection', id: item.id },
            <span className="swatch-dot" style={{ background: item.color }} />,
            item.name,
            papers.filter((paper) => paper.collectionIds.includes(item.id)).length,
            `Drop papers here to add them to ${item.name}`,
          ),
        )}
        {navItem('junk', { kind: 'junk' }, <TrashIcon size={16} />, 'Junk', junk.length, 'Removed papers, to restore or delete for good. Drop papers here to remove them.')}
      </div>

      <div className="library-scope">
        <span className="eyebrow">{scopeName}</span>
        <span className="mono">
          {scopeTotal} paper{scopeTotal === 1 ? '' : 's'}
        </span>
      </div>

      <div className="scroll library-list">
        {!scopeTotal ? <p className="library-empty">Nothing here yet. Open Discover on the right to add a paper.</p> : null}

        {groups.map((group) => {
          if (!group.items.length) return null;
          const isCollapsed = collapsed.includes(group.status);
          return (
            <section key={group.status} className="status-group">
              <button
                type="button"
                className="status-head"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => (current.includes(group.status) ? current.filter((item) => item !== group.status) : [...current, group.status]))
                }
              >
                <ChevronDownIcon size={14} style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' }} />
                <span className={`status-dot is-${group.status}`} />
                {STATUS_LABEL[group.status]}
                <span className="count">{group.items.length}</span>
              </button>

              {isCollapsed
                ? null
                : group.items.map((paper) => (
                    <button
                      key={paper.id}
                      type="button"
                      className={`paper-row ${activePaperId === paper.id ? 'is-active' : ''}`}
                      onClick={() => onOpenPaper(paper.id)}
                      title={paper.title}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(PAPERS_MIME, JSON.stringify([paper.id]));
                        event.dataTransfer.setData('text/plain', paper.title);
                      }}
                      style={{ ['--h' as string]: String(coverFor(paper).hue) }}
                    >
                      <span className="paper-row-spine" aria-hidden="true" />
                      <span className="paper-row-text">
                        <span className="paper-row-title">{paper.title}</span>
                        <span className="paper-row-meta">
                          {paper.authors[0] || 'Unknown author'}
                          {paper.authors.length > 1 ? ' et al.' : ''}
                          {yearOf(paper) ? ` · ${yearOf(paper)}` : ''}
                          {noteCounts.get(paper.id) ? (
                            <span className="paper-row-notes" title="Pieces in this paper's notes">
                              {' · '}
                              <NoteIcon size={10} /> {noteCounts.get(paper.id)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {group.status === 'reading' ? (
                        <span className="paper-row-ring" title={`${Math.round(paper.progress * 100)}% read`}>
                          <ProgressRing progress={paper.progress} size={22} />
                          <span className="mono">{Math.max(1, Math.round(paper.progress * 100))}%</span>
                        </span>
                      ) : null}
                    </button>
                  ))}
            </section>
          );
        })}
      </div>

      {removing ? <RemovePaperDialog papers={removing} onClose={() => setRemoving(null)} /> : null}
    </aside>
  );
}
