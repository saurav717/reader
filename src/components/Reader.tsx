import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { arxivIdFromUrl, judgePdf, loadPaperContent, loadPaperContentFromPdf, type PaperContent, type ReflowProgress } from '../lib/paperContent';
import { hasProxy } from '../lib/api';
import {
  fetchPaperPdf,
  fetchPdfFromDrive,
  fetchPdfFromLocations,
  PdfError,
  pdfAvailability,
  pdfSourceUrl,
  resolvePdfUrl,
  saveBlob,
  type PdfOrigin,
  type CheckOffer,
  type SignInOffer,
  type CopyAttempt,
} from '../lib/pdf';
import SignInPrompt from './SignInPrompt';
import CopyPicker, { type CopyNote } from './CopyPicker';
import PdfDropIn from './PdfDropIn';
import MiniBrowser from './MiniBrowser';
import BookView from './BookView';
import PdfBookView from './PdfBookView';
import { findLocations, mergeLocations, paperLocations, scholarPaperUrl } from '../lib/locations';
import type { PaperLocation } from '../types';
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
import HoverCard, { type CitedEntry, type HoverTarget } from './HoverCard';
import { showPdf } from '../lib/screen';
import { fullerAuthors } from '../lib/byline';
import { CITE_CLASS, REF_CLASS, citationHead, citationText, entryText, parseReference } from '../lib/citations';
import {
  ArrowLeftIcon,
  BookIcon,
  ChevronDownIcon,
  CloudCheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalIcon,
  MoonIcon,
  NoteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SunIcon,
  OpenBookIcon,
  ScrollPageIcon,
  SparkleIcon,
  ZenIcon,
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
  /** Zen mode: the side panes are hidden and come out from the edges on hover. */
  zen: boolean;
  onToggleZen: () => void;
  onSelectHighlight: (id: string | null) => void;
  onOrphans: (ids: string[]) => void;
}

const SIZES = [16.5, 18.5, 21];

/** Scrolling down one long column, or turning the pages of a book. Remembered on this device. */
type Layout = 'scroll' | 'book';
const LAYOUT_KEY = 'reader.layout';

function savedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'book' ? 'book' : 'scroll';
  } catch {
    return 'scroll';
  }
}

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
  zen,
  onToggleZen,
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
    setPaperPdfChoice,
    setPaperDriveFile,
    setPaperAuthors,
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
  /** How far the PDF has been read, while the reflowed text is being made from it. */
  const [reflowProgress, setReflowProgress] = useState<ReflowProgress | null>(null);
  const [mode, setMode] = useState<ReadingMode>(preferredMode);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const chooseLayout = useCallback((next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // A private window: the choice lasts as long as the page.
    }
  }, []);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [lookup, setLookup] = useState<LookupTarget | null>(null);

  // Where this paper's PDF lives, and the copy we have fetched of it.
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  /** Whether the by-DOI lookup for a single link has come back, found or not. */
  const [pdfResolved, setPdfResolved] = useState(false);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfFrom, setPdfFrom] = useState<PdfOrigin | null>(null);
  /** Which of the paper's copies the file on screen actually came from. */
  const [pdfLocation, setPdfLocation] = useState<PaperLocation | null>(null);
  /** Everywhere this paper is published, resolved once when it is opened. */
  const [locations, setLocations] = useState<PaperLocation[] | null>(null);
  const [pdfObjectUrl, setPdfObjectUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  /** Set beside the error when a publisher's copy wanted a sign-in. */
  const [pdfSignIn, setPdfSignIn] = useState<SignInOffer | null>(null);
  /** A copy behind a site's check for a person, and whose proxy met it — from the Worker, one that never passes. */
  const [pdfCheck, setPdfCheck] = useState<CheckOffer | null>(null);
  /** Bumped to ask for the file again after a sign-in. */
  const [pdfAttempt, setPdfAttempt] = useState(0);
  /**
   * What Drive said when it was asked for this paper, before any copy was:
   * asked the moment the paper opens, so a paper already in Drive is on
   * screen before the indexes have said where else it is, and the copies
   * are fetched only once Drive has said it has nothing.
   */
  const [driveProbe, setDriveProbe] = useState<'idle' | 'checking' | 'found' | 'missing'>('idle');
  /** Which paper the probe above is for, so it is made once per paper and not once per render. */
  const probedFor = useRef<string | null>(null);
  /** The browser inside the reader, open in the PDF pane in place of the failure. */
  const [browsing, setBrowsing] = useState(false);
  /**
   * Why the file on screen may not be the paper — "looks like a poster" —
   * when every copy that answered looked doubtful, or the copy in Drive does.
   */
  const [pdfDoubt, setPdfDoubt] = useState<string | null>(null);
  /** What each copy said when it was asked, by URL, for the list of copies. */
  const [copyNotes, setCopyNotes] = useState<Record<string, CopyNote>>({});
  /** The list of copies, open to read a different one. */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** A copy picked by hand, being fetched. The file on screen stays until it arrives. */
  const [switching, setSwitching] = useState<PaperLocation | null>(null);
  /** A copy picked by hand that would not hand over the file, and what to do about it. */
  const [switchError, setSwitchError] = useState<{
    location: PaperLocation;
    message: string;
    signIn: SignInOffer | null;
    check: CheckOffer | null;
  } | null>(null);
  const switchAbort = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  // Once the reading mode has been chosen by hand, stop choosing it for them.
  const modeChosen = useRef(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The cards over an author's name and over a citation. One is open at a
  // time; it opens a moment after the pointer arrives, so that moving across
  // the text does not flash one up at every citation on the way, and stays
  // while the pointer crosses the gap to it.
  const [hover, setHover] = useState<(HoverTarget & { element: Element | null }) | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverElement = useRef<Element | null>(null);
  const holdHover = useCallback(() => window.clearTimeout(hoverTimer.current), []);
  const closeHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    hoverElement.current = null;
    setHover(null);
  }, []);
  const leaveHover = useCallback((delay = 220) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverElement.current = null;
      setHover(null);
    }, delay);
  }, []);
  const openHover = useCallback((element: Element, make: () => HoverTarget | null, delay = 380) => {
    window.clearTimeout(hoverTimer.current);
    if (hoverElement.current === element) return;
    hoverTimer.current = window.setTimeout(() => {
      // Not while text is being selected: the selection has a toolbar of its own.
      if (!window.getSelection()?.isCollapsed) return;
      const target = make();
      if (!target) return;
      hoverElement.current = element;
      setHover({ ...target, element });
    }, delay);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  // It points at a place on the screen, so it goes when the page moves.
  useEffect(() => {
    if (!hover) return;
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && document.querySelector('.hover-card')?.contains(event.target))) closeHover();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeHover);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeHover);
    };
  }, [hover, closeHover]);
  useEffect(closeHover, [paperId, closeHover]);

  /**
   * Bibliography entries by id, as the card shows them. `cited` is the
   * citation's own text, the label for an entry that has no number.
   */
  const entriesFor = useCallback((ids: string[], cited = ''): CitedEntry[] => {
    const root = bodyRef.current;
    if (!root) return [];
    return ids.flatMap((id) => {
      const element = root.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!element) return [];
      const text = entryText(element);
      const tag = element.querySelector('.ltx_tag_bibitem')?.textContent?.replace(/[[\]]/g, '').trim();
      const parsed = parseReference(element.textContent || '');
      const label =
        tag ||
        (parsed.number !== undefined ? String(parsed.number) : '') ||
        (ids.length === 1 ? cited.replace(/[()[\]]/g, '').trim() : '') ||
        `${text.split(/[\s,]+/)[0]}${parsed.year ? ` ${parsed.year}` : ''}`;
      return [{ id, label, text }];
    });
  }, []);

  /** Bring an entry of the bibliography into view, and mark it for a moment. */
  const revealEntry = useCallback(
    (id: string) => {
      const element = bodyRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!element) return;
      closeHover();
      const handled = !window.dispatchEvent(new CustomEvent('reader:reveal', { detail: { element }, cancelable: true }));
      if (!handled) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      element.classList.remove('ref-flash');
      void (element as HTMLElement).offsetWidth;
      element.classList.add('ref-flash');
      window.setTimeout(() => element.classList.remove('ref-flash'), 1800);
    },
    [closeHover],
  );

  const onBodyOver = useCallback(
    (event: React.MouseEvent | React.FocusEvent, delay?: number) => {
      const target = event.target as Element;
      const piece = target.closest(`.${CITE_CLASS}`);
      if (piece) {
        const cite = citationHead(piece);
        openHover(cite, () => {
          const ids = (cite.getAttribute('data-refs') || '').split(/\s+/).filter(Boolean);
          const entries = entriesFor(ids, citationText(cite));
          return entries.length ? { kind: 'cite', entries, anchor: cite.getBoundingClientRect() } : null;
        }, delay);
        return;
      }
      // An entry of the bibliography says what it is too, a little more slowly
      // — it is also text being read — and the card opens by the pointer.
      const entry = target.closest(`.${REF_CLASS}`);
      if (entry?.id && 'clientX' in event) {
        const { clientX, clientY } = event;
        openHover(
          entry,
          () => {
            const entries = entriesFor([entry.id]);
            return entries.length ? { kind: 'cite', entries, anchor: new DOMRect(clientX, clientY - 10, 0, 20) } : null;
          },
          650,
        );
        return;
      }
      if (hoverElement.current || hoverTimer.current) leaveHover();
    },
    [entriesFor, leaveHover, openHover],
  );

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
    setReflowProgress(null);
  }, [paperId, paper?.arxivId]);

  // The images a reflowed PDF refers to are handed back once its text is
  // off the screen: when other content replaces it, and when the reader
  // closes. (Not in an effect's cleanup keyed on the content: StrictMode
  // runs that once at mount, with the content still on screen.)
  const shown = useRef<PaperContent | null>(null);
  useEffect(() => {
    if (shown.current && shown.current !== content) shown.current.release?.();
    shown.current = content;
  }, [content]);
  useEffect(
    () => () => {
      shown.current?.release?.();
      shown.current = null;
    },
    [],
  );

  /** The paper's copies, as they stand, for effects that must not re-run when the list arrives. */
  const locationsRef = useRef<PaperLocation[] | null>(null);
  locationsRef.current = locations;

  // Which file the text on screen was made from. A different file arriving
  // — dropped in, or brought back by the browser in the pane, after every
  // copy had refused — is read out afresh; the same file is not.
  const contentFor = useRef<Blob | null>(null);
  useEffect(() => {
    if (content && pdfBlob && contentFor.current !== pdfBlob) setContent(null);
  }, [content, pdfBlob]);

  // A PDF can be shown if there is a proxy to fetch it through — or if Drive
  // already holds a copy, which comes back to the browser directly and so
  // opens even on a deployment that has no server at all.
  const driveCopy = Boolean(paper?.drive?.pdfFileId && driveConnected && settings.googleClientId) || driveProbe === 'found';
  const canFetchPdf = hasProxy() || driveCopy;

  // Whether there is a PDF to open at all: the copy in Drive, a single link,
  // or any of the places the paper is published. Only when every one of those
  // has come back empty is there nothing to show.
  const pdfLookup = pdfAvailability({ pdfUrl, resolved: pdfResolved, driveCopy, locations });

  // The reflowed text is only made once it is being looked at: for a paper
  // read as a PDF, reading the file out is work nobody asked for.
  //
  // The PDF is the text, wherever there is one: the whole paper — figures,
  // tables, equations and all — read out of the file and set as a document
  // to highlight. So a reader in Reflow mode waits for the file the PDF
  // effects below are fetching, and only a paper with no PDF to be had, or
  // one whose copies would not hand it over, falls back to the HTML
  // rendering arXiv keeps, and after that to the abstract.
  useEffect(() => {
    if (!paper || mode !== 'reflow' || content) return;
    const expectPdf = canFetchPdf && pdfLookup !== 'none' && !pdfError;
    if (expectPdf && !pdfBlob) {
      setLoading(true);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setReflowProgress(null);
    contentFor.current = pdfBlob;
    // The arXiv id, for the HTML rendering: the paper's own, or the one in
    // its copies — a paper found through Scholar carries none itself. Read
    // from a ref: the list arriving must not start the reading over.
    const arxivId = paper.arxivId || locationsRef.current?.map((location) => arxivIdFromUrl(location.url)).find(Boolean);
    const fallback = (reason: string) =>
      loadPaperContent(paper, controller.signal, { arxivId }).then((loaded) => ({
        ...loaded,
        notice: `${reason} ${loaded.notice ?? `Showing ${loaded.mode === 'html' ? 'the HTML rendering' : 'the abstract'} instead.`}`,
      }));
    const load = pdfBlob
      ? loadPaperContentFromPdf(paper, pdfBlob, { signal: controller.signal, onProgress: setReflowProgress }).then(
          (reflowed) => reflowed ?? fallback('This PDF has no text that can be read — it may be a scan.'),
        )
      : pdfError
        ? fallback(`${pdfError.replace(/\.$/, '')}.`)
        : loadPaperContent(paper, controller.signal, { arxivId });
    load
      .then((loaded) => {
        if (!controller.signal.aborted) {
          setContent(loaded);
          // A search result may have cut the byline short; the PDF has it whole.
          const fuller = fullerAuthors(paper.authors, loaded.authors);
          if (fuller) void setPaperAuthors(paper.id, fuller);
        } else loaded.release?.();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Worth a line in the console, and the reason is shown too: this is
        // a PDF pdf.js choked on, and "could not be read" alone is nothing
        // to go on.
        console.warn('Could not reflow the PDF', error);
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200);
        fallback(`The PDF could not be read${reason ? ` (${reason.replace(/\.$/, '')})` : ''}.`)
          .then((loaded) => {
            if (!controller.signal.aborted) setContent(loaded);
          })
          .catch(() => undefined);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setReflowProgress(null);
        }
      });
    return () => controller.abort();
    // Only the identity of the paper, and the file, matter for what we make.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paper?.arxivId, mode, content, pdfBlob, pdfError, canFetchPdf, pdfLookup]);

  // Find a single link to the PDF. arXiv and most open-access results already
  // say where theirs is; for the rest we go back to OpenAlex and Semantic
  // Scholar and ask, since a search result and the per-work record do not
  // always agree about what is free to read. Worth doing even with no proxy —
  // it still gives a link out. It is one of the ways a PDF can be found, not
  // the gate on all of them: the copy in Drive and the list of places the
  // paper is published, below, each count on their own.
  useEffect(() => {
    if (!paper) return;
    const controller = new AbortController();
    const known = pdfSourceUrl(paper);
    setPdfError(null);
    setPdfUrl(known ?? null);
    setPdfResolved(Boolean(known));
    if (known) return () => controller.abort();

    resolvePdfUrl(paper, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setPdfUrl(found ?? null);
        setPdfResolved(true);
        if (found) void setPaperPdfUrl(paper.id, found);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPdfResolved(true);
      });
    return () => controller.abort();
    // Only the identity of the paper decides which PDF we are after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paper?.arxivId, paper?.pdfUrl]);

  // Everywhere the paper is published, not only the first link that resolved.
  // The viewer needs the list to fall through a copy that will not answer, and
  // the line under the title uses it to say which one did. An empty list is an
  // answer too — it is what says there is nothing to fetch — so a lookup that
  // fails outright is recorded as one rather than left looking forever.
  useEffect(() => {
    if (!paper) return;
    const controller = new AbortController();
    findLocations(paper, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setLocations(found);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLocations([]);
      });
    return () => controller.abort();
    // Only the identity of the paper decides where its copies are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paper?.arxivId, paper?.doi]);

  // A new paper opens the way they read the last one, with no PDF held over.
  useEffect(() => {
    modeChosen.current = false;
    setMode(preferredMode);
    setPdfBlob(null);
    setPdfFrom(null);
    setPdfLocation(null);
    setLocations(null);
    setSaving(false);
    setBrowsing(false);
    setDriveProbe('idle');
    setPdfDoubt(null);
    setCopyNotes({});
    setPickerOpen(false);
    setSwitching(null);
    setSwitchError(null);
    switchAbort.current?.abort();
    switchAbort.current = null;
    probedFor.current = null;
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
    if (content.mode === 'abstract' && pdfLookup === 'ready' && canFetchPdf && !pdfError) setMode('pdf');
  }, [content, pdfLookup, canFetchPdf, pdfError]);

  // What the PDF routes need, and nothing that changes while reading: the paper
  // object itself is replaced on every progress tick, which would otherwise
  // abort the download and start it again. A paper without a single link is
  // still a target — its copies, or the one in Drive, are what get fetched.
  const pdfTarget = useMemo(
    () => (paper ? { ...paper, pdfUrl: pdfUrl ?? paper.pdfUrl } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paper?.id, paper?.title, paper?.arxivId, paper?.pdfUrl, pdfUrl],
  );

  // The places to try, with a link resolved after the list came back folded
  // in: the list is cached per paper, so it would not pick the link up itself.
  //
  // A copy picked by hand goes first, whatever its rank: it is the one they
  // chose to read, and asking the rest first would bring the poster back.
  const pdfChoice = paper?.pdfChoice;
  const knownLocations = useMemo(() => {
    const merged = locations && pdfTarget ? mergeLocations([paperLocations(pdfTarget), locations]) : locations;
    if (!merged || !pdfChoice) return merged;
    const chosen = merged.find((location) => location.url === pdfChoice);
    return chosen ? [chosen, ...merged.filter((location) => location !== chosen)] : merged;
  }, [locations, pdfTarget, pdfChoice]);

  // A second look at each file a copy hands over, so a poster or a deck of
  // slides is passed over for a copy that is the paper. Never at the copy
  // they picked themselves: they have seen it.
  const judge = useCallback(
    (blob: Blob, location: PaperLocation) => (location.url === pdfChoice ? Promise.resolve(null) : judgePdf(blob)),
    [pdfChoice],
  );

  /** What each copy said, kept for the list of copies. */
  const noteAttempts = useCallback((tried: CopyAttempt[] | undefined) => {
    if (!tried?.length) return;
    setCopyNotes((notes) => {
      const next = { ...notes };
      for (const attempt of tried) {
        next[attempt.location.url] = {
          text: attempt.doubtful ? attempt.error : attempt.error.replace(/^Could not fetch the PDF — /, 'refused: ').replace(/\.$/, ''),
          doubtful: attempt.doubtful,
        };
      }
      return next;
    });
  }, []);

  // Reading the copy in Drive rather than fetching the paper again is worth it
  // whenever there is one: it is the same file, and it comes back without the
  // proxy — so a synced paper opens even where there is no server at all.
  // Drive is asked by the id the library recorded, or by name when it has
  // none: the file can be there without this browser knowing, and going back
  // to the publisher for it would mean going back through its sign-in.
  const driveOptions = useMemo(
    () => ({
      driveFileId: paper?.drive?.pdfFileId,
      driveFolderId: paper?.drive?.folderId,
      rootFolderName: settings.driveFolderName,
      clientId: settings.googleClientId,
      driveConnected,
      locations: knownLocations ?? undefined,
    }),
    [
      paper?.drive?.pdfFileId,
      paper?.drive?.folderId,
      settings.driveFolderName,
      settings.googleClientId,
      driveConnected,
      knownLocations,
    ],
  );

  // Drive first, and at once. It needs no list of copies — the id on record,
  // or the paper's name — so it is asked the moment the PDF pane opens,
  // while the indexes are still being asked where else the paper is, and a
  // paper already in Drive is on screen before that list is back. What it
  // needs is kept apart from the list, so the list arriving does not start
  // the look over.
  const driveLookup = useMemo(
    () => ({
      driveFileId: paper?.drive?.pdfFileId,
      driveFolderId: paper?.drive?.folderId,
      rootFolderName: settings.driveFolderName,
      clientId: settings.googleClientId,
      driveConnected,
    }),
    [paper?.drive?.pdfFileId, paper?.drive?.folderId, settings.driveFolderName, settings.googleClientId, driveConnected],
  );
  // Whichever way the paper is being read: the PDF is what Reflow mode
  // reads out too.
  useEffect(() => {
    if (!pdfTarget || pdfBlob) return;
    if (!driveConnected || !settings.googleClientId) return;
    if (probedFor.current === pdfTarget.id) return;
    probedFor.current = pdfTarget.id;
    const controller = new AbortController();
    let settled = false;
    setDriveProbe('checking');
    fetchPdfFromDrive(pdfTarget, driveLookup, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        settled = true;
        if (!found) {
          setDriveProbe('missing');
          return;
        }
        setPdfBlob(found.blob);
        setPdfFrom('drive');
        setPdfLocation(null);
        setPdfError(null);
        setDriveProbe('found');
        // The copy saved to Drive may be the poster the paper was first
        // fetched as; said, so the list of copies is one click away. Not
        // for a copy they picked, which is what Drive holds since.
        if (!pdfChoice) {
          void judgePdf(found.blob).then((doubt) => {
            if (!controller.signal.aborted) setPdfDoubt(doubt);
          });
        }
        // Found in Drive by name: remembered, so the next open asks by id.
        if (found.drive) void setPaperDriveFile(pdfTarget.id, found.drive);
      })
      .catch(() => {
        // A copy that could not be read, or a grant that lapsed: the
        // publisher is still there, and that is what is asked next.
        if (controller.signal.aborted) return;
        settled = true;
        setDriveProbe('missing');
      });
    return () => {
      controller.abort();
      // A look cut short — the pane left before Drive answered — is made
      // again when the pane is next opened, rather than counted as an answer.
      if (!settled) {
        probedFor.current = null;
        setDriveProbe('idle');
      }
    };
    // The choice is read when Drive answers, not a reason to ask it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pdfBlob, pdfTarget, driveConnected, settings.googleClientId, driveLookup, setPaperDriveFile]);

  // Then the copies, through the proxy, once Drive has said it has nothing —
  // never both at once, since the file is one download whichever answers.
  // The proxy waits for the list this component is already resolving, rather
  // than resolving it twice.
  useEffect(() => {
    if (!pdfTarget || pdfBlob) return;
    if (pdfLookup !== 'ready' || !driveOptions.locations) return;
    if (driveConnected && settings.googleClientId && driveProbe !== 'missing') return;
    // The browser in the pane, opened while the copies were still being
    // asked: they stand aside — a copy behind a site's check is fetched
    // from the one browser at Browserless the pane now needs — and are
    // asked again if the pane closes without a file. A failure already on
    // screen is not asked again by the pane closing; a sign-in made there
    // clears it and asks (`retryCopies`).
    if (browsing || pdfError) return;
    const controller = new AbortController();
    setPdfError(null);
    setPdfSignIn(null);
    setPdfCheck(null);
    // Drive has been asked already, above; the copies are what is left.
    fetchPaperPdf(pdfTarget, { ...driveOptions, driveConnected: false, judge, preferred: pdfChoice }, controller.signal)
      .then(({ blob, from, location, tried, doubt }) => {
        if (controller.signal.aborted) return;
        setPdfBlob(blob);
        setPdfFrom(from);
        setPdfLocation(location ?? null);
        setPdfDoubt(doubt ?? null);
        noteAttempts(tried);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPdfError(error instanceof Error ? error.message : String(error));
        setPdfSignIn(error instanceof PdfError ? error.signIn ?? null : null);
        setPdfCheck(error instanceof PdfError ? error.check ?? null : null);
        if (error instanceof PdfError) noteAttempts(error.tried);
      });
    return () => controller.abort();
    // The judge changes with the choice, which is only ever made with a file
    // on screen — when this has nothing left to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pdfBlob, pdfTarget, driveOptions, driveConnected, settings.googleClientId, driveProbe, pdfLookup, pdfAttempt, browsing, pdfError, noteAttempts]);

  // Putting a paper in Drive as it is read.
  //
  // Adding a paper already queues a sync, but that is not where most papers
  // get their PDF: one added before Drive was connected, one whose publisher
  // was down that minute, one found before a proxy was configured — all of
  // them sit in Drive as metadata and nothing else. Opening a paper is the
  // moment the file is actually at hand, so that is when it goes up, and the
  // copy that goes up is the one on screen rather than a second download.
  //
  // The file is not always at hand on the first try. A paper behind a login
  // fails first, and the sync that failure queues saves the metadata only;
  // the file arrives on a later attempt — after a sign-in in the window on
  // the proxy or in the browser in this pane, when the copies are tried
  // again — and that copy has to go up too, whatever was queued before it.
  // So what has been asked for is kept in two parts: whether a sync has been
  // queued at all, and whether one was queued with the file.
  const askedToSave = useRef<Set<string>>(new Set());
  const sentPdf = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!paper || !settings.syncOnOpen || !settings.savePdf || !driveConnected) return;
    if (paper.drive?.pdfFileId) return; // Drive has it already.
    if (pdfFrom === 'drive') return; // It came from Drive: Drive has it, whatever the library recorded.
    if (pdfLookup !== 'ready') return;
    // The file is already being fetched — for the viewer, or for the text
    // to reflow — so wait for it. This effect runs again when the blob arrives.
    if (canFetchPdf && !pdfBlob && !pdfError) return;
    if (pdfBlob) {
      if (sentPdf.current.has(paper.id)) return;
      sentPdf.current.add(paper.id);
      askedToSave.current.add(paper.id);
      syncPaper(paper.id, { pdf: pdfBlob });
      return;
    }
    if (!hasProxy()) return; // Nothing we can fetch.
    if (askedToSave.current.has(paper.id)) return;
    askedToSave.current.add(paper.id);
    syncPaper(paper.id);
  }, [
    canFetchPdf,
    driveConnected,
    paper,
    pdfBlob,
    pdfError,
    pdfFrom,
    pdfLookup,
    settings.savePdf,
    settings.syncOnOpen,
    syncPaper,
  ]);

  /**
   * A file that arrived some other way after every copy failed — handed
   * over by the person, or brought back by the browser inside the reader.
   * It is shown at once, and goes up to Drive on its own — the save-on-open
   * effect above has already had its turn for this paper, with nothing to
   * send.
   */
  //
  // It is also how a different copy, picked by hand, takes the place of the
  // one on screen — the poster the paper opened on, say. Whatever Drive
  // held before is replaced with it, so the next open, here or in another
  // browser, is on the copy that was picked and not the one first saved.
  const takePdf = useCallback(
    (blob: Blob, from: PdfOrigin, location: PaperLocation | null = null) => {
      setBrowsing(false);
      setPdfBlob(blob);
      setPdfFrom(from);
      setPdfLocation(location);
      setPdfError(null);
      setPdfSignIn(null);
      setPdfCheck(null);
      setPdfDoubt(null);
      setSwitchError(null);
      setPickerOpen(false);
      if (paper && location) void setPaperPdfChoice(paper.id, location.url);
      if (paper && driveConnected && settings.savePdf) {
        askedToSave.current.add(paper.id);
        sentPdf.current.add(paper.id);
        syncPaper(paper.id, { pdf: blob, replacePdf: true });
      }
    },
    [driveConnected, paper, settings.savePdf, setPaperPdfChoice, syncPaper],
  );
  const takeFile = useCallback((blob: Blob) => takePdf(blob, 'file'), [takePdf]);

  /**
   * One copy, picked by hand from the list: fetched on its own, and shown in
   * place of the file on screen once it arrives. Until then — and if it will
   * not hand the file over — the file on screen stays where it is.
   */
  const pickCopy = useCallback(
    (location: PaperLocation) => {
      if (!pdfTarget) return;
      switchAbort.current?.abort();
      const controller = new AbortController();
      switchAbort.current = controller;
      setPickerOpen(false);
      setSwitchError(null);
      setSwitching(location);
      fetchPdfFromLocations(pdfTarget, [location], controller.signal)
        .then(({ blob }) => {
          if (controller.signal.aborted) return;
          setCopyNotes(({ [location.url]: _gone, ...rest }) => rest);
          takePdf(blob, 'proxy', location);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const failure = error instanceof PdfError ? error : null;
          // The summary names the one copy; what it said is the useful part.
          const said = failure?.tried?.[0]?.error ?? (error instanceof Error ? error.message : String(error));
          noteAttempts(failure?.tried);
          setSwitchError({
            location,
            message: said.replace(/^Could not fetch the PDF — /, '').replace(/\.$/, ''),
            signIn: failure?.signIn ?? null,
            check: failure?.check ?? null,
          });
        })
        .finally(() => {
          if (switchAbort.current === controller) {
            switchAbort.current = null;
            setSwitching(null);
          }
        });
    },
    [noteAttempts, pdfTarget, takePdf],
  );

  /** Back to letting the reader choose, the next time the paper opens. */
  const forgetChoice = useCallback(() => {
    if (paper) void setPaperPdfChoice(paper.id, undefined);
    setPickerOpen(false);
  }, [paper, setPaperPdfChoice]);

  /**
   * Every copy again, after a sign-in made in the browser inside the reader —
   * or, when the browser was opened for a copy picked by hand with another
   * one on screen, that copy.
   */
  const retryCopies = useCallback(() => {
    setBrowsing(false);
    if (pdfBlob && switchError) {
      pickCopy(switchError.location);
      return;
    }
    setPdfError(null);
    setPdfSignIn(null);
    setPdfAttempt((attempt) => attempt + 1);
  }, [pdfBlob, pickCopy, switchError]);

  // The line that says which copy is on screen, and opens the list of the
  // others. Wherever the PDF is what is being read — in the viewer, or read
  // out into Reflow — and there is a proxy to fetch another copy through.
  const readingPdf = mode === 'pdf' || content?.mode === 'pdf';
  const showCopies = Boolean(readingPdf && hasProxy() && knownLocations?.length && (pdfBlob || switching));
  const browseAvailable = hasProxy();
  const closePicker = useCallback(() => setPickerOpen(false), []);
  /** The browser in the pane lives in the PDF view, so that is where it opens — for this paper only. */
  const browseHere = useCallback(() => {
    modeChosen.current = true;
    setMode('pdf');
    setBrowsing(true);
  }, []);

  // Where to send a person when the file will not come here: the single link
  // where there is one, else the first copy that is a file.
  const pdfLink = pdfUrl ?? knownLocations?.find((location) => location.isPdf)?.url ?? null;

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

  // What Ask Claude reads in PDF mode, where the paper is a picture rather than text on the page.
  const showingPdf = mode === 'pdf' && !browsing && !pdfError ? pdfBlob : null;
  useEffect(() => {
    showPdf(showingPdf);
    return () => showPdf(null);
  }, [showingPdf]);

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
    // A new layout is a new copy of the text, unpainted.
  }, [content, mine, onOrphans, layout]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    root.querySelectorAll('mark.hl').forEach((mark) => {
      mark.classList.toggle('is-selected', (mark as HTMLElement).dataset.highlightId === selectedHighlightId);
    });
  }, [selectedHighlightId, content, mine, layout]);

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
      left: Math.max(12, Math.min(window.innerWidth - 400, rect.left)),
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
    const column = root.getBoundingClientRect();
    // The reading pane, not the window: the rail and the side panels are not margin.
    const pane = (root.closest('.main') ?? root).getBoundingClientRect();
    return {
      top: rect.bottom + 8,
      left: rect.left,
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      column: { left: column.left, right: column.right },
      pane: { left: pane.left, right: pane.right },
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
  // Scholar's venues often lead with the year — "2023 IEEE/CVF …" — which the year beside it already says.
  const venueShown = paper.venue && year ? paper.venue.replace(new RegExp(`^${year}\\s+(?=\\S)`), '') : paper.venue;
  const showVenue = (element: HTMLElement, delay?: number) =>
    paper.venue ? openHover(element, () => ({ kind: 'venue', venue: paper.venue!, anchor: element.getBoundingClientRect() }), delay) : undefined;

  // The paper itself, the same whether it scrolls or is turned like a book.
  const article = (
    <>
      <div className="meta" style={{ marginBottom: 10 }}>
        {paper.categories.slice(0, 3).map((category) => (
          <span key={category} className="mono" style={{ border: '1px solid var(--border)', borderRadius: 5, padding: '2px 6px' }}>
            {category}
          </span>
        ))}
        {year ? <span>{year}</span> : null}
        {paper.venue ? (
          <span
            className="author-name venue-name"
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            onMouseEnter={(event) => showVenue(event.currentTarget)}
            onMouseLeave={() => leaveHover()}
            onFocus={(event) => showVenue(event.currentTarget, 0)}
            onBlur={() => leaveHover()}
            onClick={(event) => showVenue(event.currentTarget, 0)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showVenue(event.currentTarget, 0);
              }
            }}
          >
            {venueShown}
          </span>
        ) : null}
      </div>
      <h1 className="paper-title">{paper.title}</h1>
      <p className="paper-authors">
        {paper.authors.map((name, position) => {
          const show = (element: HTMLElement, delay?: number) =>
            openHover(element, () => ({ kind: 'author', name, position, anchor: element.getBoundingClientRect() }), delay);
          return (
            <Fragment key={`${position}-${name}`}>
              {position ? ' · ' : null}
              <span
                className="author-name"
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                onMouseEnter={(event) => show(event.currentTarget)}
                onMouseLeave={() => leaveHover()}
                onFocus={(event) => show(event.currentTarget, 0)}
                onBlur={() => leaveHover()}
                onClick={(event) => show(event.currentTarget, 0)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    show(event.currentTarget, 0);
                  }
                }}
              >
                {name}
              </span>
            </Fragment>
          );
        })}
      </p>

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
          <span className="spinner" />
          {reflowProgress
            ? reflowProgress.stage === 'reading'
              ? ` Reading the PDF — page ${reflowProgress.done} of ${reflowProgress.total}…`
              : ' Painting the figures and tables…'
            : pdfBlob
              ? ' Reading the PDF…'
              : canFetchPdf && pdfLookup !== 'none' && !pdfError
                ? driveProbe === 'checking'
                  ? ' Looking in your Drive…'
                  : pdfLookup === 'checking'
                    ? ' Looking for the PDF…'
                    : ' Fetching the PDF to reflow it…'
                : ' Fetching the full text…'}
        </p>
      ) : null}

      <div
        ref={bodyRef}
        className="paper-body"
        onMouseUp={(event) => {
          // A right-click opens the lookup card; its mouseup can land after
          // the context menu has, and must not bring the toolbar back over it.
          if (event.button !== 2) captureSelection();
        }}
        onKeyUp={captureSelection}
        onContextMenu={(event) => {
          // Only take the menu over when there is something to look up.
          if (openLookup()) event.preventDefault();
        }}
        onMouseOver={onBodyOver}
        onMouseLeave={() => leaveHover()}
        onFocus={onBodyOver}
        onBlur={() => leaveHover()}
        onClick={(event) => {
          // A citation goes to its entry once its card is up; before that —
          // a tap, where there is no hovering — it puts the card up.
          const piece = (event.target as HTMLElement).closest(`.${CITE_CLASS}`);
          const cite = piece ? citationHead(piece) : null;
          if (cite && window.getSelection()?.isCollapsed !== false) {
            event.preventDefault();
            const first = (cite.getAttribute('data-refs') || '').split(/\s+/)[0];
            if (hover?.element === cite && first) revealEntry(first);
            else onBodyOver(event, 0);
            return;
          }
          const mark = (event.target as HTMLElement).closest('mark.hl') as HTMLElement | null;
          if (mark?.dataset.highlightId) {
            onSelectHighlight(mark.dataset.highlightId);
            onNotes(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: content?.html ?? '' }}
      />
    </>
  );

  // Opaque ids (e.g. "scholar:<the whole title>") only repeat the title, so the
  // subtitle names a paper only by an identifier a reader can actually use.
  const paperIdentifier = paper.arxivId
    ? `arXiv:${paper.arxivId}`
    : paper.doi
      ? `doi:${paper.doi}`
      : null;
  const sourceNote =
    mode === 'pdf'
      ? pdfFrom === 'drive'
        ? 'PDF from your Drive'
        : pdfFrom === 'file'
          ? 'PDF from your file'
          : pdfFrom === 'browser'
            ? 'PDF from the browser here'
            : pdfLocation
              ? `PDF from ${pdfLocation.label}`
              : 'PDF'
      : content
        ? `${content.sourceLabel}${
            content.mode === 'pdf'
              ? pdfFrom === 'drive'
                ? ' in your Drive'
                : pdfFrom === 'file'
                  ? ' from your file'
                  : pdfLocation
                    ? ` from ${pdfLocation.label}`
                    : ''
              : ''
          }`
        : null;
  const topbarSub = [
    paperIdentifier,
    sourceNote,
    `${Math.round(paper.progress * 100)}%`,
    driveConnected && driveBusy ? 'saving to Drive…' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="main">
      <div className="topbar">
        <button type="button" className="icon-btn sm" onClick={onToggleSidebar} aria-label="Toggle the side panel">
          <PanelLeftIcon size={18} />
        </button>
        <button type="button" className="icon-btn sm" onClick={onBack} aria-label="Back to the collection">
          <ArrowLeftIcon size={18} />
        </button>
        <div className="topbar-heading">
          <div className="title" title={paper.title}>{paper.title}</div>
          <div className="sub" title={topbarSub}>{topbarSub}</div>
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
        ) : pdfLookup === 'ready' && pdfLink ? (
          // No proxy to fetch it through, but we know where it is.
          <a className="btn sm" href={pdfLink} target="_blank" rel="noreferrer noopener">
            PDF <ExternalIcon size={12} />
          </a>
        ) : null}

        {mode === 'reflow' || (mode === 'pdf' && pdfBlob) ? (
          <button
            type="button"
            className="icon-btn sm"
            aria-pressed={layout === 'book'}
            aria-label={layout === 'book' ? 'Read as one scrolling page' : 'Read as a book, two pages side by side'}
            title={layout === 'book' ? 'Scroll view' : 'Book view — two pages side by side'}
            onClick={() => chooseLayout(layout === 'book' ? 'scroll' : 'book')}
          >
            {layout === 'book' ? <ScrollPageIcon size={17} /> : <OpenBookIcon size={18} />}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn sm"
          aria-pressed={zen}
          aria-label={zen ? 'Leave zen mode' : 'Zen mode — hide the side panes'}
          title={zen ? 'Leave zen mode (Z)' : 'Zen mode — the panes wait at the edges of the screen (Z)'}
          onClick={onToggleZen}
        >
          <ZenIcon size={17} />
        </button>
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

      {showCopies && knownLocations ? (
        <div className="copy-bar">
          <div className="copy-line">
            <span className="copy-lead">Reading the copy</span>
            <button
              type="button"
              className="copy-current"
              aria-expanded={pickerOpen}
              aria-haspopup="dialog"
              onClick={() => setPickerOpen((open) => !open)}
              title="Read a different copy of this paper"
            >
              {pdfFrom === 'drive'
                ? 'in your Drive'
                : pdfFrom === 'file'
                  ? 'from your file'
                  : pdfFrom === 'browser'
                    ? 'from the browser here'
                    : pdfLocation
                      ? `at ${pdfLocation.label}`
                      : 'found first'}
              <ChevronDownIcon size={13} />
            </button>
            {switching ? (
              <span className="copy-status">
                <span className="spinner" /> Fetching the copy at {switching.label}…
              </span>
            ) : pdfDoubt ? (
              <span className="copy-status doubtful">
                It {pdfDoubt}.{' '}
                <button type="button" className="link-btn" onClick={() => setPickerOpen(true)}>
                  Pick another copy
                </button>
              </span>
            ) : (
              <span className="copy-status">
                {(() => {
                  const others = knownLocations.length - (pdfFrom === 'proxy' && pdfLocation ? 1 : 0);
                  return others <= 0 ? '· the only copy known' : `· ${others === 1 ? 'one other' : `${others} others`} to pick from`;
                })()}
              </span>
            )}
          </div>
          {pickerOpen ? (
            <CopyPicker
              locations={knownLocations}
              current={pdfFrom === 'proxy' ? pdfLocation?.url ?? null : null}
              choice={pdfChoice}
              notes={copyNotes}
              switching={switching?.url ?? null}
              onPick={pickCopy}
              onBrowse={
                browseAvailable
                  ? () => {
                      setPickerOpen(false);
                      browseHere();
                    }
                  : undefined
              }
              onFile={takeFile}
              onForget={pdfChoice ? forgetChoice : undefined}
              onClose={closePicker}
            />
          ) : null}
          {switchError ? (
            <p className="banner warn copy-error">
              The copy {/^from /i.test(switchError.location.label) ? switchError.location.label : `at ${switchError.location.label}`} would not hand over the PDF — {switchError.message}. You are still
              reading the copy you had.
              {switchError.check?.where === 'cloudflare' ? (
                <>
                  {' '}
                  That is Cloudflare checking for a person, which the proxy's requests never pass — but your own browser
                  does.
                </>
              ) : null}{' '}
              {switchError.check?.where !== 'cloudflare' && browseAvailable ? (
                <>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={browseHere}
                  >
                    {switchError.signIn ? `Browse to ${switchError.signIn.host} and sign in here` : `Browse to ${switchError.location.host} here`}
                  </button>
                  .
                </>
              ) : null}
              <PdfDropIn host={switchError.location.host} url={switchError.location.url} onFile={takeFile} />{' '}
              <button type="button" className="link-btn" onClick={() => setSwitchError(null)}>
                Dismiss
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === 'pdf' ? (
        <div className="pdf-pane">
          {browsing ? (
            <MiniBrowser
              paper={paper}
              locations={knownLocations}
              signIn={switchError?.signIn ?? pdfSignIn}
              onPdf={(blob) => takePdf(blob, 'browser')}
              onRetry={retryCopies}
              onClose={() => setBrowsing(false)}
              onFile={takeFile}
            />
          ) : pdfError || pdfLookup === 'none' ? (
            <p className="banner warn" style={{ margin: 16 }}>
              {pdfError || 'No PDF of this paper is free to read anywhere we can see.'}
              {pdfCheck?.where === 'cloudflare' ? (
                <span className="sign-in-note">
                  {' '}
                  That check is Cloudflare's, and the Worker's requests never pass it — Cloudflare tells every site it
                  protects that requests from its Workers and its rendering browsers are bots, so the browser in this
                  pane meets the same box, however many times it is ticked. Your own browser passes it without
                  noticing: open the file in a tab of your own and drop it here, or run the proxy on your own machine
                  (Settings → Paper proxy).
                </span>
              ) : pdfCheck?.where === 'browserless' ? (
                <span className="sign-in-note">
                  {' '}
                  That check is Cloudflare's, which the Worker's own requests never pass; the browser at Browserless
                  met a box to tick, which needs a person. Open a browser here and tick it — it opens at Browserless,
                  on an address of its own — or open the file in a tab of your own and drop it here.
                </span>
              ) : null}
              {hasProxy() ? (
                <span className="sign-in-note">
                  {' '}
                  <button type="button" className="link-btn" onClick={() => setBrowsing(true)}>
                    {pdfSignIn ? `Browse to ${pdfSignIn.host} and sign in here` : 'Browse to a copy and sign in here'}
                  </button>
                  {' — a browser opens in this pane, at the site you pick.'}
                </span>
              ) : null}
              {pdfSignIn ? (
                <SignInPrompt
                  offer={pdfSignIn}
                  onSignedIn={() => {
                    setPdfError(null);
                    setPdfSignIn(null);
                    setPdfAttempt((attempt) => attempt + 1);
                  }}
                />
              ) : null}
              {pdfLink ? (
                <>
                  {' '}
                  <a href={pdfLink} target="_blank" rel="noreferrer noopener">
                    Open it at the publisher
                  </a>
                  .
                </>
              ) : null}
              {pdfError ? (
                <PdfDropIn
                  host={pdfSignIn?.host || pdfCheck?.host}
                  url={pdfSignIn?.url || pdfCheck?.url || pdfLink || undefined}
                  onFile={takeFile}
                />
              ) : null}{' '}
              <button type="button" className="link-btn" onClick={() => chooseMode('reflow')}>
                Read the text instead
              </button>
              , or look for a copy{' '}
              <a href={scholarPaperUrl(paper)} target="_blank" rel="noreferrer noopener">
                on Google Scholar
              </a>
              .
            </p>
          ) : pdfBlob && layout === 'book' ? (
            <PdfBookView
              blob={pdfBlob}
              title={paper.title}
              initialProgress={paper.progress}
              onProgress={(fraction) => setProgress(paper.id, fraction)}
            />
          ) : pdfObjectUrl ? (
            <iframe
              title={`${paper.title} (PDF)`}
              src={pdfObjectUrl}
              style={{ flexGrow: 1, border: 0, width: '100%', background: 'var(--rail)' }}
            />
          ) : (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
              <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <span className="spinner" />
                {driveProbe === 'checking'
                  ? ' Looking in your Drive…'
                  : pdfLookup === 'checking'
                    ? ' Looking for the PDF…'
                    : knownLocations?.length
                      ? ` Fetching the PDF — ${knownLocations.length === 1 ? 'one copy' : `${knownLocations.length} copies`} to try…`
                      : ' Fetching the PDF…'}
              </p>
              {/* The way in through a sign-in, offered while the copies are
                  still being asked rather than only once every one of them
                  has refused: a paper behind a login is a paper whose copies
                  all refuse, and waiting for each to say so is the slow part. */}
              {hasProxy() && knownLocations?.length ? (
                <p style={{ margin: '10px 0 0' }}>
                  Behind a login?{' '}
                  <button type="button" className="link-btn" onClick={() => setBrowsing(true)}>
                    Browse to a copy and sign in here
                  </button>
                  {' — a browser opens in this pane, at the site you pick, without waiting for the copies to answer.'}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : layout === 'book' ? (
          <BookView
            contentKey={content}
            initialProgress={paper.progress}
            onProgress={(fraction) => setProgress(paper.id, fraction)}
            style={{ ['--reading-size' as string]: `${SIZES[sizeIndex] - 1.5}px` }}
          >
            {article}
          </BookView>
        ) : (
        <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="reader-column" style={{ ['--reading-size' as string]: `${SIZES[sizeIndex]}px` }}>
            {article}
          </div>
        </div>
      )}

      {mode === 'pdf' && !pdfError && pdfLookup !== 'none' ? (
        <p style={{ margin: 0, padding: '8px 16px', fontSize: 11.5, color: 'var(--muted)', borderTop: '1px solid var(--border-soft)' }}>
          {layout === 'book' && pdfBlob
            ? 'Highlighting works in Reflow mode — here the text can be selected and copied, and the pages turned with the arrow keys.'
            : "Highlighting works in Reflow mode — the PDF is rendered by your browser's own viewer."}
        </p>
      ) : null}

      {pending && !lookup ? (
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
            className="wide"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('reader:ask-claude', { detail: { text: pending.selector.exact } }));
              setPending(null);
            }}
            title="Ask Claude about this passage — ⌘\\ opens the window any time"
          >
            <SparkleIcon size={15} /> Ask
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

      {hover ? (
        <HoverCard
          target={hover}
          paper={{ id: paper.id, title: paper.title, doi: paper.doi, arxivId: paper.arxivId, year: Number(paper.published?.slice(0, 4)) || undefined }}
          onEnter={holdHover}
          onLeave={() => leaveHover()}
          onClose={closeHover}
          onJump={revealEntry}
        />
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
