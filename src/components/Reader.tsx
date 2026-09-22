import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { loadPaperContent, type PaperContent } from '../lib/paperContent';
import { hasProxy } from '../lib/api';
import { fetchPaperPdf, pdfSourceUrl, resolvePdfUrl, saveBlob, type PdfOrigin } from '../lib/pdf';
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
import { HIGHLIGHT_COLORS, type HighlightColor, type ReadingMode } from '../types';
import LookupPopover, { type LookupTarget } from './LookupPopover';
import {
  ArrowLeftIcon,
  BookIcon,
  CloudCheckIcon,
  CopyIcon,
  DownloadIcon,
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
  /** Bring the highlights pane forward; `force` opens the dock if it is shut. */
  onNotes: (force: boolean) => void;
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
  onNotes,
  onToggleSidebar,
  onSelectHighlight,
  onOrphans,
}: Props) {
  const {
    papers,
    highlights,
    addHighlight,
    setProgress,
    markOpened,
    setPaperPdfUrl,
    settings,
    updateSettings,
    driveConnected,
    syncPaper,
    syncStateFor,
  } = useStore();
  const paper = papers.find((item) => item.id === paperId);

  // What a paper opens on, remembered between papers and between sessions.
  const preferredMode = settings.readingMode;

  const [content, setContent] = useState<PaperContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ReadingMode>(preferredMode);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [lookup, setLookup] = useState<LookupTarget | null>(null);

  // Where this paper's PDF lives, and the copy we have fetched of it.
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLookup, setPdfLookup] = useState<'checking' | 'ready' | 'none'>('checking');
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfFrom, setPdfFrom] = useState<PdfOrigin | null>(null);
  const [pdfObjectUrl, setPdfObjectUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Once the reading mode has been chosen by hand, stop choosing it for them.
  const modeChosen = useRef(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const mine = useMemo(
    () => highlights.filter((highlight) => highlight.paperId === paperId),
    [highlights, paperId],
  );

  // A different paper means a stale box over text that is no longer there.
  useEffect(() => {
    setLookup(null);
    setPending(null);
  }, [paperId]);

  useEffect(() => {
    if (paper) markOpened(paper.id);
    // markOpened is stable; re-running on every paper object change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  // A different paper is a different document, whichever way it is being read.
  // The fetch below turns the spinner back on if it is the one being read.
  useEffect(() => {
    setContent(null);
    setLoading(false);
  }, [paperId, paper?.arxivId]);

  // The reflowed text is only fetched once it is being looked at: for a paper
  // read as a PDF, the HTML rendering is a round trip nobody asked for.
  useEffect(() => {
    if (!paper || mode !== 'reflow' || content) return;
    const controller = new AbortController();
    setLoading(true);
    loadPaperContent(paper, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setContent(loaded);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Only the identity of the paper matters for what we fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paper?.arxivId, mode, content]);

  // Find the PDF. arXiv and most open-access results already say where theirs
  // is; for the rest we go back to OpenAlex and Semantic Scholar and ask, since
  // a search result and the per-work record do not always agree about what is
  // free to read. Worth doing even with no proxy — it still gives a link out.
  useEffect(() => {
    if (!paper) return;
    const controller = new AbortController();
    const known = pdfSourceUrl(paper);
    setPdfError(null);
    setPdfUrl(known ?? null);
    setPdfLookup(known ? 'ready' : 'checking');
    if (known) return () => controller.abort();

    resolvePdfUrl(paper, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setPdfUrl(found ?? null);
        setPdfLookup(found ? 'ready' : 'none');
        if (found) void setPaperPdfUrl(paper.id, found);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPdfLookup('none');
      });
    return () => controller.abort();
    // Only the identity of the paper decides which PDF we are after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paper?.arxivId, paper?.pdfUrl]);

  // A PDF can be shown if there is a proxy to fetch it through — or if Drive
  // already holds a copy, which comes back to the browser directly and so
  // opens even on a deployment that has no server at all.
  const driveCopy = Boolean(paper?.drive?.pdfFileId && driveConnected && settings.googleClientId);
  const canFetchPdf = hasProxy() || driveCopy;

  // A new paper opens the way they read the last one, with no PDF held over.
  useEffect(() => {
    modeChosen.current = false;
    setMode(preferredMode);
    setPdfBlob(null);
    setPdfFrom(null);
    setSaving(false);
    // Changing the preference mid-paper is already handled by chooseMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  // The PDF is what a paper opens on unless there is none to open: no proxy to
  // fetch it through, or nothing free to read anywhere we can see. Only until
  // they pick a mode themselves.
  useEffect(() => {
    if (modeChosen.current) return;
    if (preferredMode === 'pdf' && (!canFetchPdf || pdfLookup === 'none')) setMode('reflow');
    else setMode(preferredMode);
  }, [preferredMode, pdfLookup, canFetchPdf]);

  // Reading it reflowed but there is nothing to reflow: the PDF beats an
  // abstract they did not ask for.
  useEffect(() => {
    if (modeChosen.current || !content) return;
    if (content.mode === 'abstract' && pdfLookup === 'ready' && canFetchPdf) setMode('pdf');
  }, [content, pdfLookup, canFetchPdf]);

  // What the PDF routes need, and nothing that changes while reading: the paper
  // object itself is replaced on every progress tick, which would otherwise
  // abort the download and start it again.
  const pdfTarget = useMemo(
    () => (paper && pdfUrl ? { ...paper, pdfUrl } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paper?.id, paper?.title, paper?.arxivId, pdfUrl],
  );

  // Reading the copy in Drive rather than fetching the paper again is worth it
  // whenever there is one: it is the same file, and it comes back without the
  // proxy — so a synced paper opens even where there is no server at all.
  const driveOptions = useMemo(
    () => ({
      driveFileId: paper?.drive?.pdfFileId,
      clientId: settings.googleClientId,
      driveConnected,
    }),
    [paper?.drive?.pdfFileId, settings.googleClientId, driveConnected],
  );

  // Fetch the file itself, once, when the PDF pane is first opened.
  useEffect(() => {
    if (mode !== 'pdf' || !pdfTarget || pdfBlob) return;
    const controller = new AbortController();
    setPdfError(null);
    fetchPaperPdf(pdfTarget, driveOptions, controller.signal)
      .then(({ blob, from }) => {
        if (controller.signal.aborted) return;
        setPdfBlob(blob);
        setPdfFrom(from);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPdfError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [mode, pdfBlob, pdfTarget, driveOptions]);

  // Putting a paper in Drive as it is read.
  //
  // Adding a paper already queues a sync, but that is not where most papers
  // get their PDF: one added before Drive was connected, one whose publisher
  // was down that minute, one found before a proxy was configured — all of
  // them sit in Drive as metadata and nothing else. Opening a paper is the
  // moment the file is actually at hand, so that is when it goes up, and the
  // copy that goes up is the one on screen rather than a second download.
  const askedToSave = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!paper || !settings.syncOnOpen || !settings.savePdf || !driveConnected) return;
    if (paper.drive?.pdfFileId) return; // Drive has it already.
    if (pdfLookup !== 'ready' || !hasProxy()) return; // Nothing we can fetch.
    if (askedToSave.current.has(paper.id)) return;
    // Reading it as a PDF: the viewer is already fetching the file, so wait for
    // it. This effect runs again when the blob arrives.
    if (mode === 'pdf' && !pdfBlob && !pdfError) return;
    askedToSave.current.add(paper.id);
    syncPaper(paper.id, pdfBlob && pdfFrom === 'proxy' ? { pdf: pdfBlob } : undefined);
  }, [
    driveConnected,
    mode,
    paper,
    pdfBlob,
    pdfError,
    pdfFrom,
    pdfLookup,
    settings.savePdf,
    settings.syncOnOpen,
    syncPaper,
  ]);

  // What to say about Drive in the line under the title.
  const driveState = paper ? syncStateFor(paper.id) : 'idle';
  const driveBusy = driveState === 'queued' || driveState === 'running';
  const driveFileLink = paper?.drive?.pdfFileId
    ? paper.drive.pdfLink || `https://drive.google.com/file/d/${paper.drive.pdfFileId}/view`
    : null;

  // The viewer needs a URL, and every one of them has to be handed back.
  useEffect(() => {
    if (!pdfBlob) {
      setPdfObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(pdfBlob);
    setPdfObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pdfBlob]);

  const downloadPdf = useCallback(async () => {
    if (!pdfTarget || saving) return;
    setSaving(true);
    setPdfError(null);
    try {
      const fetched = pdfBlob ?? (await fetchPaperPdf(pdfTarget, driveOptions)).blob;
      if (!pdfBlob) setPdfBlob(fetched);
      saveBlob(fetched, pdfTarget);
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [driveOptions, pdfBlob, pdfTarget, saving]);

  // A mode picked by hand is the one the next paper opens in too.
  const chooseMode = useCallback(
    (next: ReadingMode) => {
      modeChosen.current = true;
      setMode(next);
      if (next !== preferredMode) updateSettings({ readingMode: next });
    },
    [preferredMode, updateSettings],
  );

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

  /** The same capture the toolbar does, but returned rather than shown. */
  const selectionTarget = useCallback((): LookupTarget | null => {
    const root = bodyRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const index = buildIndex(root);
    const offsets = offsetsFromRange(index, range);
    if (!offsets || !index.text.slice(offsets.start, offsets.end).trim()) return null;
    const rect = range.getBoundingClientRect();
    return {
      top: rect.bottom + 8,
      left: rect.left,
      selector: selectorFromOffsets(index, offsets.start, offsets.end),
      section: sectionFor(range, root),
    };
  }, []);

  const openLookup = useCallback(() => {
    const target = selectionTarget();
    if (!target) return false;
    setPending(null);
    setLookup(target);
    return true;
  }, [selectionTarget]);

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
        onNotes(true);
      } else {
        // Follow along if the dock is open, but do not reopen one you shut.
        onNotes(false);
      }
    },
    [addHighlight, onNotes, onSelectHighlight, paper, pending],
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
            {mode === 'pdf'
              ? pdfFrom === 'drive'
                ? ' · PDF from your Drive'
                : ' · PDF'
              : content
                ? ` · ${content.sourceLabel}`
                : ''}
            {` · ${Math.round(paper.progress * 100)}%`}
            {driveConnected && driveBusy ? ' · saving to Drive…' : ''}
          </div>
        </div>

        {driveConnected && driveFileLink && !driveBusy ? (
          <a
            className="icon-btn sm"
            href={driveFileLink}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open this paper in your Google Drive"
            title="This paper is in your Google Drive"
            style={{ color: 'var(--accent)' }}
          >
            <CloudCheckIcon size={17} />
          </a>
        ) : null}

        {pdfLookup === 'ready' && canFetchPdf ? (
          <>
            <div className="segmented" role="group" aria-label="Reading mode">
              <button type="button" aria-pressed={mode === 'reflow'} onClick={() => chooseMode('reflow')}>
                Reflow
              </button>
              <button type="button" aria-pressed={mode === 'pdf'} onClick={() => chooseMode('pdf')}>
                PDF
              </button>
            </div>
            <button
              type="button"
              className="icon-btn sm"
              onClick={() => void downloadPdf()}
              disabled={saving}
              aria-label="Download the PDF"
              title="Download the PDF"
            >
              {saving ? <span className="spinner" /> : <DownloadIcon size={17} />}
            </button>
          </>
        ) : pdfLookup === 'ready' && pdfUrl ? (
          // No proxy to fetch it through, but we know where it is.
          <a className="btn sm" href={pdfUrl} target="_blank" rel="noreferrer noopener">
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

      {mode === 'pdf' ? (
        <div className="pdf-pane">
          {pdfError || pdfLookup === 'none' ? (
            <p className="banner warn" style={{ margin: 16 }}>
              {pdfError || 'No PDF of this paper is free to read anywhere we can see.'}
              {pdfUrl ? (
                <>
                  {' '}
                  <a href={pdfUrl} target="_blank" rel="noreferrer noopener">
                    Open it at the publisher
                  </a>
                  .
                </>
              ) : null}{' '}
              <button type="button" className="link-btn" onClick={() => chooseMode('reflow')}>
                Read the text instead
              </button>
              .
            </p>
          ) : pdfObjectUrl ? (
            <iframe
              title={`${paper.title} (PDF)`}
              src={pdfObjectUrl}
              style={{ flexGrow: 1, border: 0, width: '100%', background: 'var(--rail)' }}
            />
          ) : (
            <p style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13, padding: 16 }}>
              <span className="spinner" />
              {pdfLookup === 'checking' ? ' Looking for the PDF…' : ' Fetching the PDF…'}
            </p>
          )}
        </div>
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
                {pdfLookup === 'ready' && canFetchPdf ? (
                  <>
                    {' '}
                    <button type="button" className="link-btn" onClick={() => chooseMode('pdf')}>
                      Read the PDF instead
                    </button>
                    .
                  </>
                ) : null}
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
              onContextMenu={(event) => {
                // Only take the menu over when there is something to look up.
                if (openLookup()) event.preventDefault();
              }}
              onClick={(event) => {
                const mark = (event.target as HTMLElement).closest('mark.hl') as HTMLElement | null;
                if (mark?.dataset.highlightId) {
                  onSelectHighlight(mark.dataset.highlightId);
                  onNotes(true);
                }
              }}
              dangerouslySetInnerHTML={{ __html: content?.html ?? '' }}
            />
          </div>
        </div>
      )}

      {mode === 'pdf' && !pdfError && pdfLookup !== 'none' ? (
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
          <button
            type="button"
            className="wide"
            onClick={() => openLookup()}
            title="Meaning, where it comes from, and a comment — or right-click the selection"
          >
            <BookIcon size={15} /> Look up
          </button>
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

      {lookup ? (
        <LookupPopover
          paperId={paper.id}
          target={lookup}
          onClose={() => setLookup(null)}
          onSelectHighlight={(id) => {
            onSelectHighlight(id);
            if (id) onNotes(true);
          }}
        />
      ) : null}
    </div>
  );
}
