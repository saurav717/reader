import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { STATUS_LABEL, STATUS_ORDER, statusOf, type ReadingStatus } from '../lib/status';
import type { View } from '../types.view';
import type { Paper } from '../types';
import { CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, InboxIcon, PlusIcon, StackIcon } from './icons';

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

export default function Library({ view, activePaperId, onSelect, onOpenPaper, onClose }: Props) {
  const { papers, collections, createCollection } = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [collapsed, setCollapsed] = useState<ReadingStatus[]>([]);

  // Opening a paper leaves the view on the paper, so the panel remembers the
  // collection you came from rather than falling back to everything.
  const [lastCollectionId, setLastCollectionId] = useState<string | null>(
    view.kind === 'collection' ? view.id : null,
  );
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
    const sorted = scope
      .slice()
      .sort((a, b) => (b.lastOpenedAt || b.addedAt).localeCompare(a.lastOpenedAt || a.addedAt));
    return STATUS_ORDER.map((status) => ({
      status,
      items: sorted.filter((paper) => statusOf(paper) === status),
    }));
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

  return (
    <aside className="panel narrow library-panel" aria-label="Library">
      <div className="panel-head">
        <h2>Library</h2>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the library panel">
          <CloseIcon size={17} />
        </button>
      </div>

      <div style={{ padding: '0 10px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <button
          type="button"
          className={`nav-item ${view.kind === 'all' ? 'is-active' : ''}`}
          onClick={() => select({ kind: 'all' })}
        >
          <StackIcon size={16} /> All papers <span className="count">{papers.length}</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view.kind === 'reading' ? 'is-active' : ''}`}
          onClick={() => select({ kind: 'reading' })}
        >
          <ClockIcon size={16} /> Reading now <span className="count">{counts.reading}</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view.kind === 'unread' ? 'is-active' : ''}`}
          onClick={() => select({ kind: 'unread' })}
        >
          <InboxIcon size={16} /> Not started <span className="count">{counts.unread}</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view.kind === 'finished' ? 'is-active' : ''}`}
          onClick={() => select({ kind: 'finished' })}
        >
          <CheckIcon size={16} /> Finished <span className="count">{counts.finished}</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view.kind === 'unsorted' ? 'is-active' : ''}`}
          onClick={() => select({ kind: 'unsorted' })}
        >
          <StackIcon size={16} /> Unsorted <span className="count">{unsorted}</span>
        </button>
      </div>

      <div style={{ padding: '16px 16px 6px', display: 'flex', alignItems: 'center' }}>
        <span className="eyebrow" style={{ flexGrow: 1 }}>
          Collections
        </span>
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => setAdding(true)}
          aria-label="New collection"
          style={{ width: 24, height: 24 }}
        >
          <PlusIcon size={15} />
        </button>
      </div>

      <div style={{ padding: '0 10px' }}>
        {adding ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            style={{ padding: '4px 0 8px' }}
          >
            <label className="vh" htmlFor="new-collection">
              Collection name
            </label>
            <input
              id="new-collection"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void submit()}
              placeholder="Collection name"
              style={{
                width: '100%',
                height: 32,
                padding: '0 10px',
                border: '1px solid var(--border)',
                borderRadius: 9,
                background: 'var(--surface)',
                outline: 0,
                fontSize: 13,
              }}
            />
          </form>
        ) : null}

        {collections.map((item) => {
          const count = papers.filter((paper) => paper.collectionIds.includes(item.id)).length;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${collectionId === item.id ? 'is-active' : ''}`}
              onClick={() => select({ kind: 'collection', id: item.id })}
            >
              <span className="swatch-square" style={{ background: item.color }} />
              {item.name}
              <span className="count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="library-scope">
        <span className="eyebrow">{scopeName}</span>
        <span className="mono">
          {scopeTotal} paper{scopeTotal === 1 ? '' : 's'}
        </span>
      </div>

      <div className="scroll" style={{ padding: '0 10px 18px' }}>
        {!scopeTotal ? (
          <p style={{ padding: '8px 6px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            Nothing here yet. Open Discover on the right to add a paper.
          </p>
        ) : null}

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
                  setCollapsed((current) =>
                    current.includes(group.status)
                      ? current.filter((item) => item !== group.status)
                      : [...current, group.status],
                  )
                }
              >
                <ChevronDownIcon
                  size={14}
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' }}
                />
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
                    >
                      <span className="paper-row-title">{paper.title}</span>
                      <span className="paper-row-meta">
                        {paper.authors[0] || 'Unknown author'}
                        {paper.authors.length > 1 ? ' et al.' : ''}
                        {paper.published ? ` · ${new Date(paper.published).getFullYear() || ''}` : ''}
                      </span>
                      {group.status === 'reading' ? (
                        <span className="paper-row-progress">
                          <span className="bar" style={{ width: '100%' }}>
                            <span style={{ width: `${Math.round(paper.progress * 100)}%` }} />
                          </span>
                          <span className="mono">{Math.round(paper.progress * 100)}%</span>
                        </span>
                      ) : null}
                    </button>
                  ))}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
