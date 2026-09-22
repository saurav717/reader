import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { HIGHLIGHT_COLORS, type Highlight, type HighlightColor } from '../types';
import { CloseIcon, FileIcon, TrashIcon } from './icons';

interface Props {
  paperId: string;
  selectedId: string | null;
  orphanIds: string[];
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

function toMarkdown(title: string, highlights: Highlight[]): string {
  const lines = [`# ${title}`, ''];
  let section = '';
  for (const highlight of highlights) {
    if (highlight.section && highlight.section !== section) {
      section = highlight.section;
      lines.push(`## ${section}`, '');
    }
    lines.push(`> ${highlight.exact}`, '');
    if (highlight.note) lines.push(highlight.note, '');
    if (highlight.tags.length) lines.push(highlight.tags.join(' '), '');
  }
  return lines.join('\n');
}

export default function NotesRail({ paperId, selectedId, orphanIds, onSelect, onClose }: Props) {
  const { papers, highlights, updateHighlight, deleteHighlight } = useStore();
  const paper = papers.find((item) => item.id === paperId);
  const [filter, setFilter] = useState<HighlightColor | 'all'>('all');
  const [notesOnly, setNotesOnly] = useState(false);

  const mine = useMemo(() => {
    let list = highlights.filter((highlight) => highlight.paperId === paperId);
    if (filter !== 'all') list = list.filter((highlight) => highlight.color === filter);
    if (notesOnly) list = list.filter((highlight) => typeof highlight.note === 'string' && highlight.note.length > 0);
    return list.slice().sort((a, b) => a.hint - b.hint);
  }, [highlights, paperId, filter, notesOnly]);

  const total = highlights.filter((highlight) => highlight.paperId === paperId).length;

  const grouped = useMemo(() => {
    const groups: { section: string; items: Highlight[] }[] = [];
    for (const highlight of mine) {
      const section = highlight.section || 'Elsewhere in the paper';
      const last = groups[groups.length - 1];
      if (last && last.section === section) last.items.push(highlight);
      else groups.push({ section, items: [highlight] });
    }
    return groups;
  }, [mine]);

  const exportMarkdown = () => {
    if (!paper) return;
    const blob = new Blob([toMarkdown(paper.title, mine)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${paper.title.slice(0, 60).replace(/[^\w\s-]/g, '').trim() || 'highlights'}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="panel notes-rail" aria-label="Highlights and notes">
      <div className="panel-head">
        <h2>Highlights</h2>
        <button type="button" className="icon-btn sm" onClick={exportMarkdown} aria-label="Export highlights as Markdown">
          <FileIcon size={16} />
        </button>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the highlights panel">
          <CloseIcon size={17} />
        </button>
      </div>

      <div style={{ padding: '0 16px 12px', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All {total}
        </button>
        {HIGHLIGHT_COLORS.map((colour) => (
          <button
            key={colour.id}
            type="button"
            className="chip"
            aria-pressed={filter === colour.id}
            title={colour.label}
            aria-label={colour.label}
            onClick={() => setFilter(filter === colour.id ? 'all' : colour.id)}
            style={{ padding: 5, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <span className="dot" style={{ background: colour.swatch, width: 12, height: 12 }} />
          </button>
        ))}
        <button type="button" className="chip" aria-pressed={notesOnly} onClick={() => setNotesOnly(!notesOnly)}>
          With notes
        </button>
      </div>

      {orphanIds.length ? (
        <p className="banner warn" style={{ margin: '0 16px 12px' }}>
          {orphanIds.length} highlight{orphanIds.length === 1 ? '' : 's'} could not be found in this version of the
          text. The note is kept; the quote no longer matches.
        </p>
      ) : null}

      <div className="scroll" style={{ padding: '0 12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!mine.length ? (
          <p style={{ padding: '8px 4px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            Select text in the paper to highlight it. Keys <span className="mono">1</span>–
            <span className="mono">4</span> pick a colour, <span className="mono">N</span> adds a note.
          </p>
        ) : null}

        {grouped.map((group) => (
          <div key={group.section}>
            <div className="eyebrow" style={{ padding: '6px 4px 8px' }}>
              {group.section}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.items.map((highlight) => {
                const colour = HIGHLIGHT_COLORS.find((item) => item.id === highlight.color);
                const orphaned = orphanIds.includes(highlight.id);
                const isSelected = selectedId === highlight.id;
                return (
                  <article
                    key={highlight.id}
                    className="note-card"
                    style={isSelected ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' } : undefined}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                      <span className="dot" style={{ background: colour?.swatch }} />
                      <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {new Date(highlight.createdAt).toLocaleDateString()}
                        {orphaned ? ' · not found in text' : ''}
                      </span>
                      <span style={{ flexGrow: 1 }} />
                      <button
                        type="button"
                        className="icon-btn sm"
                        style={{ width: 24, height: 24 }}
                        aria-label="Delete this highlight"
                        onClick={() => {
                          void deleteHighlight(highlight.id);
                          if (isSelected) onSelect(null);
                        }}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => onSelect(isSelected ? null : highlight.id)}
                      style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
                    >
                      <p className="quote">{highlight.exact}</p>
                    </button>

                    {typeof highlight.note === 'string' || isSelected ? (
                      <div style={{ marginTop: 9 }}>
                        <label className="vh" htmlFor={`note-${highlight.id}`}>
                          Note on this highlight
                        </label>
                        <textarea
                          id={`note-${highlight.id}`}
                          value={highlight.note ?? ''}
                          placeholder="Write a note…"
                          onChange={(event) => void updateHighlight(highlight.id, { note: event.target.value })}
                        />
                      </div>
                    ) : null}

                    <div style={{ display: 'flex', gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
                      {highlight.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => {
                          const tag = window.prompt('Tag (without the #)');
                          if (!tag) return;
                          const clean = `#${tag.replace(/^#/, '').trim()}`;
                          if (!highlight.tags.includes(clean)) {
                            void updateHighlight(highlight.id, { tags: [...highlight.tags, clean] });
                          }
                        }}
                      >
                        + tag
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
