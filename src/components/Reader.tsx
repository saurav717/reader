import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { loadPaperContent, type PaperContent } from '../lib/paperContent';
import { api, hasProxy } from '../lib/api';
import {
  buildIndex,
  offsetsFromRange,
  paint,
  resolveSelector,
  sectionFor,
  selectorFromOffsets,
  unpaint,
  type Selector,
} from '../lib/anchor';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../types';
import {
  ArrowLeftIcon,
  CopyIcon,
  ExternalIcon,
  MoonIcon,
  NoteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SunIcon,
} from './icons';

interface Props {
  paperId: string;
  notesOpen: boolean;
  selectedHighlightId: string | null;
  onBack: () => void;
  onToggleNotes: () => void;
  onToggleSidebar: () => void;
  onSelectHighlight: (id: string | null) => void;
  onOrphans: (ids: string[]) => void;
}

const SIZES = [16.5, 18.5, 21];

interface PendingSelection {
  top: number;
  left: number;
  selector: Selector;
  section?: string;
}

export default function Reader({
  paperId,
  notesOpen,
  selectedHighlightId,
  onBack,
  onToggleNotes,
  onToggleSidebar,
  onSelectHighlight,
  onOrphans,
}: Props) {
  const { papers, highlights, addHighlight, setProgress, markOpened, settings, updateSettings } = useStore();
  const paper = papers.find((item) => item.id === paperId);

  const [content, setContent] = useState<PaperContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'reflow' | 'pdf'>('reflow');
  const [sizeIndex, setSizeIndex] = useState(1);
  const [pending, setPending] = useState<PendingSelection | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const mine = useMemo(
    () => highlights.filter((highlight) => highlight.paperId === paperId),
    [highlights, paperId],
  );

  useEffect(() => {
    if (paper) markOpened(paper.id);
    // markOpened is stable; re-running on every paper object change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  useEffect(() => {
    if (!paper) return;
    const controller = new AbortController();
    setLoading(true);
    setContent(null);
    loadPaperContent(paper, controller.signal)
      .then((loaded) => setContent(loaded))
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => controller.abort();
    // Only the identity of the paper matters for what we fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paper?.arxivId]);

  // Repaint whenever the document or the highlight set changes.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root || !content) return;
    unpaint(root);
    if (!mine.length) {
      onOrphans([]);
      return;
    }
    const initial = buildIndex(root);
    const resolved = mine
      .map((highlight) => ({ highlight, at: resolveSelector(initial, highlight) }))
      .filter((entry): entry is { highlight: (typeof mine)[number]; at: { start: number; end: number } } =>
        Boolean(entry.at),
      );
    const orphans = mine
      .filter((highlight) => !resolved.some((entry) => entry.highlight.id === highlight.id))
      .map((highlight) => highlight.id);
    onOrphans(orphans);

    // Painting splits text nodes, so work from the end of the document back.
    resolved.sort((a, b) => b.at.start - a.at.start);
    for (const entry of resolved) {
      paint(buildIndex(root), entry.at.start, entry.at.end, entry.highlight);
    }
  }, [content, mine, onOrphans]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    root.querySelectorAll('mark.hl').forEach((mark) => {
      mark.classList.toggle('is-selected', (mark as HTMLElement).dataset.highlightId === selectedHighlightId);
    });
  }, [selectedHighlightId, content, mine]);

  const captureSelection = useCallback(() => {
    const root = bodyRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) {
      setPending(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setPending(null);
      return;
    }
    const index = buildIndex(root);
    const offsets = offsetsFromRange(index, range);
    if (!offsets || !index.text.slice(offsets.start, offsets.end).trim()) {
      setPending(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setPending({
      top: rect.bottom + 8,
      left: Math.max(12, Math.min(window.innerWidth - 340, rect.left)),
      selector: selectorFromOffsets(index, offsets.start, offsets.end),
      section: sectionFor(range, root),
    });
  }, []);

  const applyHighlight = useCallback(
    async (color: HighlightColor, withNote: boolean) => {
      if (!pending || !paper) return;
      const created = await addHighlight({
        paperId: paper.id,
        color,
        exact: pending.selector.exact,
        prefix: pending.selector.prefix,
        suffix: pending.selector.suffix,
        hint: pending.selector.hint,
        section: pending.section,
        tags: [],
        note: withNote ? '' : undefined,
      });
      window.getSelection()?.removeAllRanges();
      setPending(null);
      if (withNote) {
        onSelectHighlight(created.id);
        if (!notesOpen) onToggleNotes();
      }
    },
    [addHighlight, notesOpen, onSelectHighlight, onToggleNotes, paper, pending],
  );

  // Number keys apply a colour to the live selection without the mouse.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const position = Number(event.key);
      if (position >= 1 && position <= HIGHLIGHT_COLORS.length) {
        event.preventDefault();
        void applyHighlight(HIGHLIGHT_COLORS[position - 1].id, false);
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void applyHighlight(HIGHLIGHT_COLORS[0].id, true);
      } else if (event.key === 'Escape') {
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyHighlight, pending]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element || !paper) return;
    const span = element.scrollHeight - element.clientHeight;
    if (span <= 0) return;
    setProgress(paper.id, Math.min(1, Math.max(0, element.scrollTop / span)));
  };

  if (!paper) {
    return (
      <div className="main">
        <div className="empty">
          <h3>That paper is not in your library</h3>
          <p>It may have been removed. Pick another one from the library panel.</p>
        </div>
      </div>
    );
  }

  const year = paper.published ? new Date(paper.published).getFullYear() : null;

  return (
    <div className="main">
      <div className="topbar">
        <button type="button" className="icon-btn sm" onClick={onToggleSidebar} aria-label="Toggle the side panel">
          <PanelLeftIcon size={18} />
        </button>
        <button type="button" className="icon-btn sm" onClick={onBack} aria-label="Back to the collection">
          <ArrowLeftIcon size={18} />
        </button>
        <div style={{ minWidth: 0, flexGrow: 1 }}>
          <div className="title">{paper.title}</div>
          <div className="sub">
            {paper.arxivId ? `arXiv:${paper.arxivId}` : paper.doi ? `doi:${paper.doi}` : paper.id}
            {content ? ` · ${content.sourceLabel}` : ''}
            {` · ${Math.round(paper.progress * 100)}%`}
          </div>
        </div>

        {paper.arxivId && hasProxy ? (
          <div className="segmented" role="group" aria-label="Reading mode">
            <button type="button" aria-pressed={mode === 'reflow'} onClick={() => setMode('reflow')}>
              Reflow
            </button>
            <button type="button" aria-pressed={mode === 'pdf'} onClick={() => setMode('pdf')}>
              PDF
            </button>
          </div>
        ) : paper.arxivId ? (
          <a
            className="btn sm"
            href={`https://arxiv.org/pdf/${paper.arxivId}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            PDF <ExternalIcon size={12} />
          </a>
        ) : null}

        <button
          type="button"
          className="icon-btn sm"
          aria-label="Change the text size"
          onClick={() => setSizeIndex((current) => (current + 1) % SIZES.length)}
          style={{ fontFamily: 'var(--serif)', alignItems: 'baseline', gap: 1 }}
        >
          <span style={{ fontSize: 16 }}>A</span>
          <span style={{ fontSize: 11 }}>a</span>
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={settings.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          onClick={() => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
        >
          {settings.theme === 'dark' ? <SunIcon size={17} /> : <MoonIcon size={17} />}
        </button>
        {paper.landingUrl ? (
          <a
            className="icon-btn sm"
            href={paper.landingUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open the paper at its source"
          >
            <ExternalIcon size={16} />
          </a>
        ) : null}
        <button
          type="button"
          className="icon-btn sm"
          aria-pressed={notesOpen}
          onClick={onToggleNotes}
          aria-label="Toggle highlights and notes"
        >
          <PanelRightIcon size={18} />
        </button>
      </div>

      <div className="progress">
        <span style={{ width: `${Math.round(paper.progress * 100)}%` }} />
      </div>

      {mode === 'pdf' && paper.arxivId ? (
        <iframe
          title={`${paper.title} (PDF)`}
          src={api(`/arxiv/pdf?id=${encodeURIComponent(paper.arxivId)}`)}
          style={{ flexGrow: 1, border: 0, width: '100%', background: 'var(--rail)' }}
        />
      ) : (
        <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="reader-column" style={{ ['--reading-size' as string]: `${SIZES[sizeIndex]}px` }}>
            <div className="meta" style={{ marginBottom: 10 }}>
              {paper.categories.slice(0, 3).map((category) => (
                <span key={category} className="mono" style={{ border: '1px solid var(--border)', borderRadius: 5, padding: '2px 6px' }}>
                  {category}
                </span>
              ))}
              {year ? <span>{year}</span> : null}
              {paper.venue ? <span>{paper.venue}</span> : null}
            </div>
            <h1 className="paper-title">{paper.title}</h1>
            <p className="paper-authors">{paper.authors.join(' · ')}</p>

            {content?.notice ? (
              <p className="banner warn" style={{ marginBottom: 20 }}>
                {content.notice}
                {paper.landingUrl ? (
                  <>
                    {' '}
                    <a href={paper.landingUrl} target="_blank" rel="noreferrer noopener">
                      Open the source
                    </a>
                    .
                  </>
                ) : null}
              </p>
            ) : null}

            {loading ? (
              <p style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13 }}>
                <span className="spinner" /> Fetching the full text…
              </p>
            ) : null}

            <div
              ref={bodyRef}
              className="paper-body"
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              onClick={(event) => {
                const mark = (event.target as HTMLElement).closest('mark.hl') as HTMLElement | null;
                if (mark?.dataset.highlightId) {
                  onSelectHighlight(mark.dataset.highlightId);
                  if (!notesOpen) onToggleNotes();
                }
              }}
              dangerouslySetInnerHTML={{ __html: content?.html ?? '' }}
            />
          </div>
        </div>
      )}

      {mode === 'pdf' ? (
        <p style={{ margin: 0, padding: '8px 16px', fontSize: 11.5, color: 'var(--muted)', borderTop: '1px solid var(--border-soft)' }}>
          Highlighting works in Reflow mode — the PDF is rendered by your browser's own viewer.
        </p>
      ) : null}

      {pending ? (
        <div className="selection-toolbar" style={{ top: pending.top, left: pending.left }} role="toolbar" aria-label="Highlight the selection">
          {HIGHLIGHT_COLORS.map((colour, position) => (
            <button
              key={colour.id}
              type="button"
              onClick={() => void applyHighlight(colour.id, false)}
              aria-label={`${colour.label} (key ${position + 1})`}
              title={`${colour.label} — ${position + 1}`}
            >
              <span className="swatch" style={{ background: colour.swatch }} />
            </button>
          ))}
          <span className="divider" />
          <button type="button" className="wide" onClick={() => void applyHighlight('yellow', true)} title="Highlight and write a note — N">
            <NoteIcon size={15} /> Note
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(pending.selector.exact);
              setPending(null);
            }}
            aria-label="Copy the selected text"
          >
            <CopyIcon size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
