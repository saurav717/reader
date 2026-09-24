import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import type { View } from '../types.view';
import type { Paper } from '../types';
import { FINISHED_AT, statusOf } from '../lib/status';
import { driveFolderUrl } from '../lib/driveSync';
import { CloudCheckIcon, CloudIcon, DriveMark, PlusIcon, SearchIcon, TrashIcon } from './icons';
import RemovePaperDialog from './RemovePaperDialog';

interface Props {
  view: View;
  onOpenPaper: (id: string) => void;
  onDiscover: () => void;
}

function headingFor(view: View, name?: string): { title: string; colour?: string } {
  switch (view.kind) {
    case 'all':
      return { title: 'All papers' };
    case 'reading':
      return { title: 'Reading now' };
    case 'unread':
      return { title: 'Not started' };
    case 'finished':
      return { title: 'Finished' };
    case 'unsorted':
      return { title: 'Unsorted' };
    default:
      return { title: name || 'Collection' };
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

export default function CollectionView({ view, onOpenPaper, onDiscover }: Props) {
  const { papers, collections, highlights, driveConnected, syncPaper, syncStateFor } = useStore();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'added' | 'title' | 'progress'>('added');
  /** The paper the bin was pressed on, while the notice asks whether to go ahead. */
  const [removing, setRemoving] = useState<Paper | null>(null);

  const collection = view.kind === 'collection' ? collections.find((item) => item.id === view.id) : undefined;
  const heading = headingFor(view, collection?.name);

  const rows = useMemo(() => {
    let list: Paper[] = papers;
    if (view.kind === 'collection') list = list.filter((paper) => paper.collectionIds.includes(view.id));
    if (view.kind === 'unsorted') list = list.filter((paper) => paper.collectionIds.length === 0);
    if (view.kind === 'reading') list = list.filter((paper) => statusOf(paper) === 'reading');
    if (view.kind === 'unread') list = list.filter((paper) => statusOf(paper) === 'unread');
    if (view.kind === 'finished') list = list.filter((paper) => statusOf(paper) === 'finished');

    const needle = filter.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (paper) =>
          paper.title.toLowerCase().includes(needle) ||
          paper.authors.join(' ').toLowerCase().includes(needle) ||
          paper.tags.join(' ').toLowerCase().includes(needle),
      );
    }

    const sorted = list.slice();
    sorted.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'progress') return b.progress - a.progress;
      return b.addedAt.localeCompare(a.addedAt);
    });
    return sorted;
  }, [papers, view, filter, sort]);

  const highlightCount = rows.reduce(
    (total, paper) => total + highlights.filter((highlight) => highlight.paperId === paper.id).length,
    0,
  );

  return (
    <div className="main">
      <div className="collection-head">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 4, flexWrap: 'wrap' }}>
          {collection ? (
            <span
              className="swatch-square"
              style={{ background: collection.color, width: 12, height: 12, borderRadius: 3, marginBottom: 9 }}
            />
          ) : null}
          <h1 className="collection-title">{heading.title}</h1>
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
        <p style={{ margin: '0 0 18px', fontSize: 12.5, color: 'var(--ink-2)' }}>
          {rows.length} paper{rows.length === 1 ? '' : 's'} · {highlightCount} highlight
          {highlightCount === 1 ? '' : 's'}
          {driveConnected ? ' · mirrored to Drive' : ''}
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            paddingBottom: 14,
            borderBottom: '1px solid var(--border-soft)',
            flexWrap: 'wrap',
          }}
        >
          <label className="vh" htmlFor="collection-filter">
            Filter papers
          </label>
          <div className="field" style={{ width: 240, height: 34 }}>
            <SearchIcon size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <input
              id="collection-filter"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter in this collection"
            />
          </div>
          <label className="vh" htmlFor="collection-sort">
            Sort by
          </label>
          <select
            id="collection-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
            style={{
              height: 34,
              borderRadius: 9,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              fontSize: 12.5,
              padding: '0 8px',
            }}
          >
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="progress">Progress</option>
          </select>
        </div>
      </div>

      <div className="scroll" style={{ padding: '4px 32px 40px' }}>
        {!rows.length ? (
          <div className="empty">
            <h3>Nothing here yet</h3>
            <p>
              Search for a paper or a book in the Discover panel — or paste the link to any PDF there — and
              add it to this collection.
            </p>
            <button type="button" className="btn primary" onClick={onDiscover} style={{ marginTop: 10 }}>
              <PlusIcon size={15} /> Find papers
            </button>
          </div>
        ) : null}

        {rows.map((paper) => {
          const state = syncStateFor(paper.id);
          const count = highlights.filter((highlight) => highlight.paperId === paper.id).length;
          const folderLink = driveFolderLink(paper);
          return (
            <div key={paper.id} style={{ position: 'relative' }}>
              <button type="button" className="row-grid" onClick={() => onOpenPaper(paper.id)}>
                <div style={{ minWidth: 0 }}>
                  <div className="paper-name">{paper.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
                    {paper.authors.slice(0, 3).join(', ')}
                    {paper.authors.length > 3 ? ', and more' : ''}
                    {paper.arxivId ? (
                      <>
                        {' · '}
                        <span className="mono">arXiv:{paper.arxivId}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                  {new Date(paper.addedAt).toLocaleDateString()}
                </span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {paper.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                  {count ? (
                    <span className="tag">
                      {count} highlight{count === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="bar">
                    <span style={{ width: `${Math.round(paper.progress * 44)}px` }} />
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {paper.progress >= FINISHED_AT
                      ? 'done'
                      : paper.progress > 0
                        ? `${Math.round(paper.progress * 100)}%`
                        : 'new'}
                  </span>
                </div>
              </button>

              <div
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
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
                  title="Remove from the library"
                  aria-label={`Remove ${paper.title} from the library`}
                  onClick={() => setRemoving(paper)}
                >
                  <TrashIcon size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {removing ? <RemovePaperDialog paper={removing} onClose={() => setRemoving(null)} /> : null}
    </div>
  );
}
