import { useState } from 'react';
import { useStore } from '../lib/store';
import type { View } from '../types.view';
import { ClockIcon, CloseIcon, InboxIcon, PlusIcon, StackIcon } from './icons';

interface Props {
  view: View;
  onSelect: (view: View) => void;
  onClose: () => void;
}

export default function Library({ view, onSelect, onClose }: Props) {
  const { papers, collections, createCollection } = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const readingNow = papers.filter((paper) => paper.progress > 0 && paper.progress < 0.98).length;
  const unsorted = papers.filter((paper) => paper.collectionIds.length === 0).length;
  const tags = Array.from(new Set(papers.flatMap((paper) => paper.tags))).slice(0, 12);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed) {
      const collection = await createCollection(trimmed);
      onSelect({ kind: 'collection', id: collection.id });
    }
    setName('');
    setAdding(false);
  };

  return (
    <aside className="panel narrow" aria-label="Library">
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
          onClick={() => onSelect({ kind: 'all' })}
        >
          <StackIcon size={16} /> All papers <span className="count">{papers.length}</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view.kind === 'reading' ? 'is-active' : ''}`}
          onClick={() => onSelect({ kind: 'reading' })}
        >
          <ClockIcon size={16} /> Reading now <span className="count">{readingNow}</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view.kind === 'unsorted' ? 'is-active' : ''}`}
          onClick={() => onSelect({ kind: 'unsorted' })}
        >
          <InboxIcon size={16} /> Unsorted <span className="count">{unsorted}</span>
        </button>
      </div>

      <div style={{ padding: '18px 16px 8px', display: 'flex', alignItems: 'center' }}>
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

      <div className="scroll" style={{ padding: '0 10px 16px' }}>
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

        {collections.map((collection) => {
          const count = papers.filter((paper) => paper.collectionIds.includes(collection.id)).length;
          const active = view.kind === 'collection' && view.id === collection.id;
          return (
            <button
              key={collection.id}
              type="button"
              className={`nav-item ${active ? 'is-active' : ''}`}
              onClick={() => onSelect({ kind: 'collection', id: collection.id })}
            >
              <span className="swatch-square" style={{ background: collection.color }} />
              {collection.name}
              <span className="count">{count}</span>
            </button>
          );
        })}

        {tags.length ? (
          <>
            <div className="eyebrow" style={{ padding: '18px 6px 8px' }}>
              Tags
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', padding: '0 4px' }}>
              {tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
