import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { allNotesMarkdown, notesFor, useAllNotes } from '../lib/notes';
import { coverFor, relativeDay } from '../lib/libraryLook';
import { DownloadIcon, SearchIcon } from './icons';

interface Props {
  /** The paper open now, if any: marked in the list. */
  current?: string;
  /** Opens a paper, its notes following it. */
  onOpenPaper?: (id: string) => void;
}

/** A file of Markdown handed to the browser to save. */
export function saveMarkdown(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.slice(0, 60).replace(/[^\w\s-]/g, '').trim() || 'notes'}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Every paper you have notes on, a card to each: how much is in them, when
 * they were last touched, and their first words. Each paper's notes are its
 * own; picking one opens the paper, and its notes come with it.
 */
export default function NotesIndex({ current, onOpenPaper }: Props) {
  const { papers } = useStore();
  const all = useAllNotes();
  const [query, setQuery] = useState('');

  // Notes on a paper no longer in the library — in Junk, say — wait there for it.
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase();
    return all
      .map((summary) => ({ summary, paper: papers.find((paper) => paper.id === summary.paperId) }))
      .filter((row): row is { summary: (typeof all)[number]; paper: NonNullable<(typeof row)['paper']> } => Boolean(row.paper))
      .filter(({ summary, paper }) => !words || `${paper.title} ${paper.authors.join(' ')} ${summary.preview}`.toLowerCase().includes(words));
  }, [all, papers, query]);

  const exportAll = () =>
    saveMarkdown(
      'Notes',
      allNotesMarkdown(rows.map(({ paper }) => ({ title: paper.title, blocks: notesFor(paper.id) }))),
    );

  return (
    <div className="scroll notes-index">
      <div className="notes-index-bar">
        <label className="notes-index-search">
          <SearchIcon size={14} />
          <input type="search" value={query} placeholder="Find in your notes" aria-label="Find a paper's notes" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="icon-btn sm" onClick={exportAll} disabled={!rows.length} aria-label="Export every paper's notes as Markdown" title="Export all as Markdown">
          <DownloadIcon size={15} />
        </button>
      </div>

      {!all.length ? (
        <p className="notes-empty">
          No notes yet. Each paper keeps its own: open one, press <b>H</b>, and write or keep things from it. They will be listed here, a paper to a card.
        </p>
      ) : !rows.length ? (
        <p className="notes-empty">No paper's notes match “{query}”.</p>
      ) : null}

      {rows.map(({ summary, paper }) => (
        <button
          key={paper.id}
          type="button"
          className={`notes-index-row${paper.id === current ? ' is-current' : ''}`}
          onClick={() => onOpenPaper?.(paper.id)}
          style={{ ['--h' as string]: String(coverFor(paper).hue) }}
          aria-current={paper.id === current ? 'true' : undefined}
          title={paper.id === current ? 'The paper open now' : `Open “${paper.title}” with its notes`}
        >
          <span className="notes-index-spine" aria-hidden="true" />
          <span className="notes-index-text">
            <span className="notes-index-title">{paper.title}</span>
            <span className="notes-index-meta">
              {summary.count} piece{summary.count === 1 ? '' : 's'}
              {summary.written ? ` · ${summary.written} written` : ''}
              {summary.kept ? ` · ${summary.kept} kept` : ''}
              {summary.pictures ? ` · ${summary.pictures} picture${summary.pictures === 1 ? '' : 's'}` : ''}
              {summary.updated ? ` · ${relativeDay(summary.updated)}` : ''}
            </span>
            {summary.preview ? <span className="notes-index-preview">{summary.preview}</span> : null}
          </span>
          {paper.id === current ? <span className="notes-index-here">Open</span> : null}
        </button>
      ))}
    </div>
  );
}
