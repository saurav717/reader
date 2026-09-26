import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from './lib/store';
import type { View } from './types.view';
import { HIGHLIGHT_COLORS } from './types';
import type { Screen } from './lib/assistant';
import { setQuote } from './lib/assistant';
import { followLight } from './lib/glassLight';
import { clearSelection, currentSelection, currentSelectionIn, explanationOnScreen, paperText, pdfPageImages, pdfPagesInView, pdfPageTexts, trackSelection, visiblePassage } from './lib/screen';
import Assistant from './components/Assistant';
import Explain from './components/Explain';
import { explanationFor, setExplainDrive } from './lib/explain';
import { explainDrive } from './lib/explainDrive';
import CollectionView from './components/CollectionView';
import JunkView from './components/JunkView';
import CommandPalette from './components/CommandPalette';
import Discover from './components/Discover';
import Library from './components/Library';
import NotesRail from './components/NotesRail';
import NotesWindow from './components/NotesWindow';
import NotesBoard from './components/NotesBoard';
import { CLOSE_EXPLAIN, OPEN_BOARD, OPEN_EXPLAIN, OPEN_NOTES } from './lib/notes';
import Reader from './components/Reader';
import Settings from './components/Settings';
import UsageView, { useIsOwner } from './components/UsageView';
import Welcome from './components/Welcome';
import { ChartIcon, GoogleMark, HighlighterIcon, LibraryIcon, SearchIcon, SettingsIcon, SparkleIcon } from './components/icons';

const WELCOME_KEY = 'reader.welcomed';
const VIEW_KEY = 'reader.view';
const LAYOUT_KEY = 'reader.layout';
const ASSISTANT_KEY = 'reader.assistant.open';
const ZEN_KEY = 'reader.zen';
const EXPLAIN_KEY = 'reader.explain.open';
const NOTES_FLOAT_KEY = 'reader.notes.float';

/** Which edge's panes are out while in zen mode: the top one is the reader's top bar. */
type Peek = 'left' | 'right' | 'top' | null;

/** Everything zen mode puts away, and the strips along the edges that bring it back. */
const ZEN_PANES = '.rail, .app > .panel, .dock, .reader-head';

/** How long the pointer may be off a pane before it slides back. */
const PEEK_LINGER_MS = 320;

/** How long the page takes to make room for the notes, or to take it back; `--slide-time` in the styles. */
const SLIDE_MS = 340;

/**
 * Below this width the dock is laid over the page rather than beside it
 * (`@media (max-width: 1080px)` in the styles), so there is no page to move.
 */
const BESIDE_MIN_WIDTH = 1080;

/**
 * Whether the paper is shown as its PDF, drawn as a book or in the browser's
 * viewer. A PDF is not made to move for the notes: they float over it instead.
 */
function showingPdf(): boolean {
  return Boolean(document.querySelector('.main :is(.pdf-book, .pdf-frame)'));
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** How far in from the window's edge a pointer is still at that edge. */
const EDGE_GAP = 16;

/** The edge of the window a point is at, if any; the top one stops short of the corners, as its strip does. */
function edgeAt(x: number, y: number): Peek {
  if (x <= EDGE_GAP) return 'left';
  if (x >= window.innerWidth - EDGE_GAP) return 'right';
  return y <= EDGE_GAP ? 'top' : null;
}

/** A key pressed while typing is text, not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)));
}

/** What the right-hand dock is showing, if anything. */
type Dock = 'discover' | 'notes' | null;

interface Layout {
  libraryOpen: boolean;
  dock: Dock;
}

function readView(): View {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) return JSON.parse(raw) as View;
  } catch {
    // fall through to the default
  }
  return { kind: 'all' };
}

const NARROW = 900;

function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < NARROW;
}

function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Layout>;
      if (typeof stored.libraryOpen === 'boolean') {
        return { libraryOpen: stored.libraryOpen, dock: stored.dock ?? null };
      }
    }
  } catch {
    // fall through to the default
  }
  // On a phone the panels are overlays, so opening one by default would hide
  // the page behind it.
  return isNarrow() ? { libraryOpen: false, dock: null } : { libraryOpen: true, dock: 'discover' };
}

export default function App() {
  const { ready, papers, collections, highlights, user, driveConnected, settings } = useStore();
  const [layout] = useState(readLayout);
  const [libraryOpen, setLibraryOpen] = useState(layout.libraryOpen);
  const [dock, setDock] = useState<Dock>(layout.dock);
  const [view, setView] = useState<View>(readView);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The owner of the proxy — READER_TOKEN, or a Google sign-in named in
  // READER_OWNERS — gets a rail button for who uses it; nobody else sees one.
  const [usageOpen, setUsageOpen] = useState(false);
  const isOwner = useIsOwner(settings.proxyToken);
  // Usage is a page of its own: it takes the main area, and the library and
  // the side panel step aside while it is open.
  const onUsage = usageOpen && isOwner;
  const [welcomed, setWelcomed] = useState(() => localStorage.getItem(WELCOME_KEY) === 'true');
  // Dismissing the opening screen is remembered for this page load only. A
  // sign-in is kept in this browser for the hour Google's token lasts, so a
  // reload comes back connected; once it has run out — there is no backend to
  // hold a refresh token — the visit starts disconnected, and offers to
  // reconnect before anything is collected that Drive would then have missed.
  const [skippedConnect, setSkippedConnect] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => localStorage.getItem(ASSISTANT_KEY) === 'true');
  // Zen mode, while a paper is open: the rail, the library, the dock and the
  // reader's top bar step off the screen and wait at its edges. Hovering an edge brings that side's
  // panes out over the page, with a haze cast from them across it.
  const [zen, setZen] = useState(() => localStorage.getItem(ZEN_KEY) === 'true');
  const [peek, setPeek] = useState<Peek>(null);
  // Opening the notes in zen mode keeps them out, beside the page: the page
  // slides left to make room for them, rather than having them laid over it.
  const [notesBeside, setNotesBeside] = useState(false);
  // What the dock held before the notes were brought out beside the page, to
  // go back to when they are put away: closed in zen, closed for good.
  const dockBeforeBeside = useRef<Dock>(null);
  // Outside zen, with the library and the dock both shut, opening the notes
  // slides them in from the right edge and the page gives way to them
  // smoothly, and closing them does the same backwards. `out` holds the dock
  // on screen while it leaves.
  const [dockSlide, setDockSlide] = useState<'in' | 'out' | null>(null);
  const slideTimer = useRef<number>();
  // The notes in a window of their own, floating over the page the way Ask
  // Claude does. They go there over a PDF or the explanation, which are not
  // made to move for them, and anywhere once popped out, which is remembered.
  const [notesWindow, setNotesWindow] = useState(false);
  // The open paper's notes full screen, on a board of their own.
  const [boardOpen, setBoardOpen] = useState(false);
  const notesWindowRef = useRef(notesWindow);
  notesWindowRef.current = notesWindow;
  const [notesFloat, setNotesFloat] = useState(() => localStorage.getItem(NOTES_FLOAT_KEY) === 'true');
  useEffect(() => {
    localStorage.setItem(NOTES_FLOAT_KEY, String(notesFloat));
  }, [notesFloat]);
  useEffect(() => () => window.clearTimeout(slideTimer.current), []);
  // Opening and closing the notes, which depend on what else is open; set
  // each render, and kept in refs so the key handler and the callbacks handed
  // to the reader stay the same.
  const openNotesRef = useRef<() => void>(() => undefined);
  const toggleNotesRef = useRef<() => void>(() => undefined);
  // Explain: the whole paper taught by Claude, over the reader the way zen mode is.
  const [explainOpen, setExplainOpen] = useState(() => localStorage.getItem(EXPLAIN_KEY) === 'true');
  const toggleExplain = useCallback(() => setExplainOpen((current) => !current), []);
  useEffect(() => {
    localStorage.setItem(EXPLAIN_KEY, String(explainOpen));
  }, [explainOpen]);
  // With Drive connected, an explanation is kept in the paper's folder too,
  // and fetched from there before Claude is asked to write it again.
  const papersNow = useRef(papers);
  papersNow.current = papers;
  // Set while rendering, not in an effect: Explain's own effect, which runs
  // first, looks in Drive as soon as it opens.
  useMemo(() => {
    setExplainDrive(
      driveConnected && settings.googleClientId.trim() ? explainDrive((id) => papersNow.current.find((paper) => paper.id === id), settings) : null,
    );
  }, [driveConnected, settings]);
  // The side the haze is drawn from outlives the peek, so it fades out in place.
  const [hazeSide, setHazeSide] = useState<Exclude<Peek, null>>('left');
  const peekTimer = useRef<number>();
  const appRef = useRef<HTMLDivElement>(null);
  const toggleZen = useCallback(() => {
    setZen((current) => !current);
    setPeek(null);
    // Zen mode puts every pane away, the notes too; opening them in it brings them back beside the page.
    setNotesBeside(false);
  }, []);

  useEffect(() => {
    localStorage.setItem(ZEN_KEY, String(zen));
  }, [zen]);

  const peekIn = useCallback((side: Exclude<Peek, null>) => {
    window.clearTimeout(peekTimer.current);
    setPeek(side);
    setHazeSide(side);
  }, []);
  // Where the pointer last was, for asking what is under it now.
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointerAt.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  const peekNow = useRef<Peek>(null);
  peekNow.current = peek;
  // Leaving a pane lets it go after a moment, so a pointer crossing from the
  // rail to the library, or overshooting the edge, does not snap it shut. A
  // pane with the cursor in a text field stays out until the field is left.
  // So does one with the pointer still at its edge of the window: in the glass
  // theme the panes stand a little in from the edge, and a pointer resting in
  // that gap, where it brought the pane out, is not a pointer that has left.
  const peekOut = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => {
      if (isTyping(document.activeElement) && document.activeElement?.closest(ZEN_PANES)) return;
      const at = pointerAt.current;
      if (at && peekNow.current && edgeAt(at.x, at.y) === peekNow.current) return;
      setPeek(null);
    }, PEEK_LINGER_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  useEffect(() => {
    localStorage.setItem(ASSISTANT_KEY, String(assistantOpen));
  }, [assistantOpen]);

  useEffect(trackSelection, []);
  const lightOn = settings.glass && settings.glassLight > 0;
  useEffect(() => (lightOn ? followLight() : undefined), [lightOn]);

  // A selection from one paper is not on screen once another is open.
  const readingId = view.kind === 'paper' ? view.id : null;
  useEffect(clearSelection, [readingId]);

  // "Ask Claude" on a selection in the paper: open the window with the passage attached.
  useEffect(() => {
    const onAsk = (event: Event) => {
      setQuote((event as CustomEvent<{ text: string }>).detail?.text ?? '');
      setAssistantOpen(true);
    };
    window.addEventListener('reader:ask-claude', onAsk);
    return () => window.removeEventListener('reader:ask-claude', onAsk);
  }, []);

  // "Open notes" after keeping something; and, from a piece in the notes, the
  // Explain page it came from, or the paper under it.
  useEffect(() => {
    const onNotes = () => openNotesRef.current();
    // The board covers the page as Explain does, and takes its place.
    const onBoard = () => {
      setExplainOpen(false);
      setBoardOpen(true);
    };
    const onExplain = () => setExplainOpen(true);
    const offExplain = () => setExplainOpen(false);
    window.addEventListener(OPEN_NOTES, onNotes);
    window.addEventListener(OPEN_BOARD, onBoard);
    window.addEventListener(OPEN_EXPLAIN, onExplain);
    window.addEventListener(CLOSE_EXPLAIN, offExplain);
    return () => {
      window.removeEventListener(OPEN_NOTES, onNotes);
      window.removeEventListener(OPEN_BOARD, onBoard);
      window.removeEventListener(OPEN_EXPLAIN, onExplain);
      window.removeEventListener(CLOSE_EXPLAIN, offExplain);
    };
  }, []);

  // "All their papers" or "Add or read" on a card in the paper: the search
  // is Discover's, which is where a paper is added and opened from.
  const [discoverAsk, setDiscoverAsk] = useState<{ query: string; at: number; open?: string } | null>(null);
  // "Add papers" in a collection: Discover is where papers are added from, so
  // the press opens it — or, when it is open already, puts the cursor in its
  // search box, which is the part of it that press is asking for.
  const [discoverFocus, setDiscoverFocus] = useState(0);
  const addPapers = useCallback(() => {
    setDock('discover');
    setDiscoverFocus(Date.now());
  }, []);
  useEffect(() => {
    const onDiscover = (event: Event) => {
      const detail = (event as CustomEvent<{ query: string; open?: string }>).detail;
      const query = detail?.query?.trim();
      if (!query) return;
      setDiscoverAsk({ query, at: Date.now(), open: detail.open });
      setDock('discover');
    };
    window.addEventListener('reader:discover', onDiscover);
    return () => window.removeEventListener('reader:discover', onDiscover);
  }, []);

  // Reopening the tab should put you back on the paper you were reading.
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  }, [view]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ libraryOpen, dock } satisfies Layout));
  }, [libraryOpen, dock]);

  // A paper removed from the library must not leave the reader pointing at it.
  useEffect(() => {
    if (ready && view.kind === 'paper' && !papers.some((paper) => paper.id === view.id)) {
      setView({ kind: 'all' });
    }
  }, [ready, papers, view]);

  const readingNow = view.kind === 'paper';
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // B, on its own and not while typing, opens and shuts the notes board —
      // the paper's notes full screen. While it is open, the keys for what
      // is under it wait.
      if (readingNow && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'b' && !isTyping(event.target)) {
        if (document.querySelector('.scrim, .sheet, .palette')) return;
        event.preventDefault();
        setExplainOpen(false);
        setBoardOpen((current) => !current);
        return;
      }
      if (document.querySelector('.notes-board:not(.layout-beside)') && !event.metaKey && !event.ctrlKey) return;
      // Z, on its own and not while typing, takes a paper in and out of zen mode.
      if (readingNow && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'z' && !isTyping(event.target)) {
        if (document.querySelector('.scrim, .sheet, .palette')) return;
        event.preventDefault();
        toggleZen();
        return;
      }
      // E, the same way, opens and closes the explanation of the paper.
      if (readingNow && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'e' && !isTyping(event.target)) {
        if (document.querySelector('.scrim, .sheet, .palette')) return;
        event.preventDefault();
        toggleExplain();
        return;
      }
      // H, the same way, opens and closes the highlights and notes beside the
      // page — and, with no paper open, the list of every paper's notes.
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'h' && !isTyping(event.target)) {
        if (document.querySelector('.scrim, .sheet, .palette')) return;
        event.preventDefault();
        toggleNotesRef.current();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      // Summon and dismiss the Claude window from anywhere. ⌘\ is the key other
      // apps put a side panel on, and no browser claims it; ⌘J is the second
      // one. Shift is excluded: ⇧\ is `|`, and a shortcut that fires on two
      // characters is one you trigger by accident.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === '\\' || event.key.toLowerCase() === 'j')) {
        event.preventDefault();
        setAssistantOpen((current) => !current);
        return;
      }
      // ⌘⇧\, beside it, opens and closes the notes the same way, typing or not.
      // Matched on the key rather than the character, which Shift makes `|`.
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'Backslash') {
        event.preventDefault();
        toggleNotesRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleZen, toggleExplain, readingNow]);

  /** `fromDiscover`: opened from Discover's pane, which stays — with its results and what it said about the save. */
  const openPaper = useCallback((id: string, fromDiscover = false) => {
    setUsageOpen(false);
    setView({ kind: 'paper', id });
    setSelectedHighlightId(null);
    setOrphanIds([]);
    if (isNarrow()) {
      setLibraryOpen(false);
      setDock(null);
      return;
    }
    // A paper opens with its notes beside it; the notes window, if that is
    // where they are, turns to the paper by itself.
    if (!notesWindowRef.current && !fromDiscover) {
      window.clearTimeout(slideTimer.current);
      setDockSlide(null);
      setDock('notes');
    }
  }, []);

  const openFromDiscover = useCallback((id: string) => openPaper(id, true), [openPaper]);

  // The highlights pane comes forward when you write a note; a plain highlight
  // only moves a dock that is already open.
  const revealNotes = useCallback((force: boolean) => {
    if (force) openNotesRef.current();
    else setDock((current) => (current ? 'notes' : null));
  }, []);

  const dismissWelcome = useCallback(() => {
    localStorage.setItem(WELCOME_KEY, 'true');
    setWelcomed(true);
    setSkippedConnect(true);
  }, []);

  const onOrphans = useCallback((ids: string[]) => {
    setOrphanIds((current) =>
      current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids,
    );
  }, []);

  /** What the Claude window may know about the page, read at the moment of sending. */
  const readScreen = useCallback(async (): Promise<Screen> => {
    if (view.kind === 'paper') {
      const paper = papers.find((p) => p.id === view.id);
      if (paper) {
        let fullText = paperText();
        let visible = visiblePassage();
        let mode = 'Reflow (the app’s own text rendering)';
        let images: Screen['images'];
        // In PDF mode nothing of the paper is in the page's own DOM: read the
        // file itself, and send the pages in view as pictures when we know them.
        const pdf = fullText ? null : pdfPageTexts();
        if (pdf) {
          try {
            const pages = await pdf;
            fullText = pages.map((text, index) => `[Page ${index + 1}]\n${text}`).join('\n\n');
            const inView = pdfPagesInView();
            visible = inView.map((number) => `[Page ${number}]\n${pages[number - 1] ?? ''}`).join('\n\n');
            images = pdfPageImages();
            mode = inView.length
              ? `PDF, ${document.querySelector('.pdf-book.is-scrolled') ? 'scrolled' : 'set as a book'} — ${inView.length > 1 ? `pages ${inView[0]}–${inView[inView.length - 1]}` : `page ${inView[0]}`} of ${pages.length} in view`
              : `PDF, in the browser’s own viewer (${pages.length} pages; which page is in view is not known to the app)`;
          } catch {
            mode = 'PDF (its text could not be read)';
          }
        } else if (!fullText) {
          mode = 'PDF (still loading)';
        }
        const kind = (color: string) => HIGHLIGHT_COLORS.find((c) => c.id === color)?.label ?? color;
        // The Explain page, when it is open over this paper: what it says, and what of it is in view.
        const explainPage = explainOpen ? explanationOnScreen() : null;
        const explained = explainPage ? explanationFor(paper.id)?.content : '';
        const explanation = explainPage && explained ? { text: explained, visible: explainPage.visible, layout: explainPage.layout, covers: explainPage.covers } : undefined;
        return {
          where: explanation ? 'Reading a paper, with its Explain page open' : 'Reading a paper',
          paper: {
            id: paper.id,
            title: paper.title,
            authors: paper.authors,
            published: paper.published,
            venue: paper.venue,
            arxivId: paper.arxivId,
            doi: paper.doi,
            url: paper.landingUrl,
            abstract: paper.abstract,
            mode,
            progress: Math.round((paper.progress || 0) * 100),
          },
          fullText,
          visible,
          images,
          selection: currentSelection(),
          selectionIn: currentSelectionIn(),
          explanation,
          highlights: highlights
            .filter((h) => h.paperId === paper.id && !h.orphaned)
            .map((h) => ({ exact: h.exact, kind: kind(h.color), note: h.note, section: h.section })),
        };
      }
    }
    const name = view.kind === 'collection' ? collections.find((c) => c.id === view.id)?.name : undefined;
    const where =
      view.kind === 'collection'
        ? `Browsing the collection “${name ?? 'Collection'}”`
        : { all: 'Browsing all papers', reading: 'Browsing papers being read', unread: 'Browsing papers not started', finished: 'Browsing finished papers', unsorted: 'Browsing unsorted papers', junk: 'Browsing the papers removed to Junk', paper: 'Browsing the library' }[view.kind];
    const library = Array.from(document.querySelectorAll('.paper-name'), (el) => el.textContent?.trim() ?? '').filter(Boolean);
    return { where, library };
  }, [view, papers, collections, highlights, explainOpen]);

  const closeAssistant = useCallback(() => setAssistantOpen(false), []);

  const zenOn = zen && ready && view.kind === 'paper';

  // A tap anywhere off the panes puts them back — on a touch screen there is
  // no pointer to leave them. (A tap in the PDF viewer's own frame never
  // reaches the page; the pane goes back when the pointer leaves it instead.)
  useEffect(() => {
    if (!zenOn || !peek) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(`${ZEN_PANES}, .zen-edge`)) return;
      window.clearTimeout(peekTimer.current);
      setPeek(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPeek(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [zenOn, peek]);

  // The haze starts where the panes end. Their widths change with the window
  // and with what is open, so they are read off the panes themselves.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (!app || !zenOn) return;
    const measure = () => {
      const left = Array.from(app.querySelectorAll<HTMLElement>(':scope > .rail, :scope > .panel'));
      const edge = left.reduce((most, element) => Math.max(most, element.offsetLeft + element.offsetWidth), 0);
      const dock = app.querySelector<HTMLElement>(':scope > .dock');
      app.style.setProperty('--zen-left', `${edge}px`);
      app.style.setProperty('--zen-right', `${dock ? window.innerWidth - dock.offsetLeft : 0}px`);
      // The top bar is placed in the page, not the window; its offsets ignore
      // the slide that hides it.
      const head = app.querySelector<HTMLElement>('.reader-head');
      const main = head?.parentElement;
      const bottom = head && main ? main.getBoundingClientRect().top + head.offsetTop + head.offsetHeight : 0;
      app.style.setProperty('--zen-top', `${bottom}px`);
    };
    measure();
    // A banner under the top bar makes it taller without the window changing.
    const head = app.querySelector('.reader-head');
    const observer = head ? new ResizeObserver(measure) : null;
    if (head) observer?.observe(head);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [zenOn, peek, libraryOpen, dock, notesBeside]);

  // Another paper, or none: the board was the last one's.
  const boardPaper = view.kind === 'paper' ? view.id : null;
  useEffect(() => setBoardOpen(false), [boardPaper]);

  if (!ready) {
    return (
      <div className="app">
        <div className="main" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <span className="spinner" aria-label="Loading your library" />
        </div>
      </div>
    );
  }

  // The opening screen is the Drive connection: it stands in front of the app
  // whenever Drive is configured but not connected, and steps aside the moment
  // it is. On a first visit, with nothing to connect to yet, it is still the
  // introduction it always was.
  const needsDrive = Boolean(settings.googleClientId.trim()) && !driveConnected;
  const showWelcome = !skippedConnect && (needsDrive || (!welcomed && !papers.length));
  const reading = view.kind === 'paper' ? view.id : null;
  // With no paper open the notes pane lists every paper's notes, a card to each.
  const dockPane: Dock = dock;
  const inZen = zenOn && !showWelcome;
  const explained = reading ? papers.find((paper) => paper.id === reading) : undefined;
  // In zen mode the right edge always has something to bring out: the dock as
  // it was left, or the highlights if it was shut — or Discover, when the
  // highlights are out in their window already.
  const shownDock: Dock = inZen ? dockPane ?? (notesWindow ? 'discover' : 'notes') : dockPane;
  // The notes out beside the page in zen mode: the dock stays out, and the page makes room for it.
  const besideInZen = inZen && notesBeside;
  // Whether the page has room to give: below this width the dock is laid over it.
  const pageCanMove = () => window.innerWidth > BESIDE_MIN_WIDTH && !reducedMotion();
  const notesDocked = inZen ? besideInZen && dockPane === 'notes' : dockPane === 'notes' && dockSlide !== 'out';
  const notesShown = notesWindow || notesDocked;
  // `docked`: into the dock whatever is on the page, as asked for from the window's bar.
  const openNotes = (docked = false) => {
    window.clearTimeout(slideTimer.current);
    const pageWouldMove = inZen || (!libraryOpen && (!dockPane || dockSlide === 'out'));
    if (!docked && (notesFloat || explainOpen || (pageWouldMove && showingPdf()))) {
      setNotesWindow(true);
      return;
    }
    setNotesWindow(false);
    setDock('notes');
    if (inZen) {
      if (!notesBeside) dockBeforeBeside.current = dock;
      setNotesBeside(true);
      setPeek(null);
      setDockSlide(null);
      return;
    }
    // Only a page with nothing either side of it slides; otherwise the dock opens as it always has.
    if (!libraryOpen && (!dockPane || dockSlide === 'out') && pageCanMove()) {
      setDockSlide('in');
      slideTimer.current = window.setTimeout(() => setDockSlide(null), SLIDE_MS);
    } else {
      setDockSlide(null);
    }
  };
  const closeDock = () => {
    window.clearTimeout(slideTimer.current);
    if (inZen) {
      if (notesBeside) {
        setNotesBeside(false);
        setDock(dockBeforeBeside.current);
      } else {
        setPeek(null);
      }
      return;
    }
    if (dockPane && !libraryOpen && pageCanMove()) {
      setDockSlide('out');
      slideTimer.current = window.setTimeout(() => {
        setDock(null);
        setDockSlide(null);
      }, SLIDE_MS);
    } else {
      setDock(null);
      setDockSlide(null);
    }
  };
  const closeNotes = () => (notesWindow ? setNotesWindow(false) : closeDock());
  const toggleNotes = () => (notesShown ? closeNotes() : openNotes());
  const popNotesOut = () => {
    setNotesFloat(true);
    closeDock();
    setNotesWindow(true);
  };
  const dockNotes = () => {
    setNotesFloat(false);
    openNotes(true);
  };
  openNotesRef.current = openNotes;
  toggleNotesRef.current = toggleNotes;
  // Which edge an element belongs to: its panes, or the strip that brings them out.
  // The dock does not count while it is out beside the page: it is not waiting to slide back.
  const sideOf = (target: EventTarget | null): Peek => {
    const element = target instanceof Element ? target.closest(`${ZEN_PANES}, .zen-edge`) : null;
    if (!element) return null;
    if (element.classList.contains('zen-edge')) return (element as HTMLElement).dataset.side as Peek;
    if (element.classList.contains('reader-head')) return 'top';
    if (element.classList.contains('dock')) return besideInZen ? null : 'right';
    return 'left';
  };
  // One pair of handlers for every pane: a hidden pane takes no pointer, so
  // the pointer is only ever over one that is out, or the strip at its edge.
  const zenPointer = inZen
    ? {
        onPointerOver: (event: ReactPointerEvent) => {
          const side = sideOf(event.target);
          if (side) peekIn(side);
        },
        onPointerOut: (event: ReactPointerEvent) => {
          if (!sideOf(event.relatedTarget)) peekOut();
        },
      }
    : {};
  return (
    <div
      ref={appRef}
      className={`app${inZen ? ` is-zen haze-${settings.zenHaze}` : ''}${inZen && peek ? ` peek-${peek}` : ''}${besideInZen ? ' notes-beside' : ''}${!inZen && dockSlide ? ` dock-slide-${dockSlide}` : ''}`}
      {...zenPointer}
    >
      <nav className="rail" aria-label="Primary">
        <div className="brand" aria-hidden="true">
          R
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={libraryOpen}
          aria-label="Library"
          title="Library — your collections and what you are reading"
          onClick={() => {
            setUsageOpen(false);
            setLibraryOpen(usageOpen ? true : !libraryOpen);
          }}
        >
          <LibraryIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={dockPane === 'discover'}
          aria-label="Discover papers"
          title="Discover"
          onClick={() => {
            setUsageOpen(false);
            setDock(dockPane === 'discover' && !usageOpen ? null : 'discover');
          }}
        >
          <SearchIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={notesShown}
          aria-label="Highlights and notes"
          title="Highlights and notes (H, or ⌘⇧\)"
          onClick={() => {
            setUsageOpen(false);
            toggleNotes();
          }}
        >
          <HighlighterIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={assistantOpen}
          aria-label="Ask AI"
          title={assistantOpen ? 'Ask AI is open — click to close it (⌘\\)' : 'Ask AI about this paper (⌘\\)'}
          onClick={() => setAssistantOpen(!assistantOpen)}
        >
          <SparkleIcon size={19} />
        </button>
        {isOwner ? (
          <button
            type="button"
            className="icon-btn"
            aria-pressed={usageOpen}
            aria-label="Usage"
            title="Usage — who has signed in, and what they used on your accounts"
            onClick={() => setUsageOpen(!usageOpen)}
          >
            <ChartIcon size={19} />
          </button>
        ) : null}
        <div style={{ flexGrow: 1 }} />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label={user ? `Settings — signed in as ${user.email}` : 'Sign in and settings'}
          title={user ? user.email : 'Sign in with Google'}
        >
          {user ? (
            user.picture ? (
              <img className="avatar" src={user.picture} alt="" />
            ) : (
              <span className="avatar-fallback" aria-hidden="true">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
            )
          ) : (
            <GoogleMark size={19} />
          )}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title={driveConnected ? 'Settings — Drive connected' : 'Settings'}
        >
          <SettingsIcon size={19} />
        </button>
      </nav>

      {libraryOpen && !showWelcome && !onUsage ? (
        <Library
          view={view}
          activePaperId={reading}
          onSelect={(next) => {
            setView(next);
            if (isNarrow()) setLibraryOpen(false);
          }}
          onOpenPaper={openPaper}
          onClose={() => setLibraryOpen(false)}
        />
      ) : null}

      {onUsage ? (
        <UsageView />
      ) : showWelcome ? (
        <Welcome onDismiss={dismissWelcome} onOpenSettings={() => setSettingsOpen(true)} />
      ) : view.kind === 'paper' ? (
        <Reader
          paperId={view.id}
          notesOpen={notesShown}
          selectedHighlightId={selectedHighlightId}
          onBack={() => setView(collections[0] ? { kind: 'collection', id: collections[0].id } : { kind: 'all' })}
          onToggleNotes={toggleNotes}
          onNotes={revealNotes}
          onToggleSidebar={() => setLibraryOpen(!libraryOpen)}
          zen={inZen}
          onToggleZen={toggleZen}
          explaining={explainOpen}
          onToggleExplain={toggleExplain}
          onSelectHighlight={setSelectedHighlightId}
          onOrphans={onOrphans}
        />
      ) : view.kind === 'junk' ? (
        <JunkView />
      ) : (
        <CollectionView view={view} onOpenPaper={openPaper} onDiscover={addPapers} />
      )}

      {shownDock && !showWelcome && !onUsage ? (
        <div className="dock">
          <div className="dock-tabs" role="tablist" aria-label="Side panel">
            <button
              type="button"
              role="tab"
              aria-selected={shownDock === 'discover'}
              onClick={() => setDock('discover')}
            >
              Discover
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={shownDock === 'notes'}
              onClick={() => setDock('notes')}
            >
              Notes
            </button>
          </div>

          {shownDock === 'discover' ? (
            <Discover
              onClose={closeDock}
              onOpen={openFromDiscover}
              ask={discoverAsk}
              here={view.kind === 'collection' ? view.id : undefined}
              focus={discoverFocus}
            />
          ) : (
            <NotesRail
              key={reading ?? 'every-paper'}
              paperId={reading ?? ''}
              onOpenPaper={openPaper}
              selectedId={selectedHighlightId}
              orphanIds={orphanIds}
              onSelect={setSelectedHighlightId}
              onClose={closeDock}
              onPopOut={popNotesOut}
            />
          )}
        </div>
      ) : null}

      {notesWindow && !showWelcome ? (
        <NotesWindow
          paperId={reading ?? ''}
          onOpenPaper={openPaper}
          selectedId={selectedHighlightId}
          orphanIds={orphanIds}
          onSelect={setSelectedHighlightId}
          onClose={() => setNotesWindow(false)}
          onDock={dockNotes}
        />
      ) : null}

      {inZen ? (
        <>
          <div className="zen-haze" data-side={hazeSide} aria-hidden="true" />
          <div className="zen-edge" data-side="left" aria-hidden="true" onPointerDown={() => peekIn('left')} />
          <div className="zen-edge" data-side="right" aria-hidden="true" onPointerDown={() => peekIn('right')} />
          <div className="zen-edge" data-side="top" aria-hidden="true" onPointerDown={() => peekIn('top')} />
        </>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenPaper={openPaper}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : null}

      {boardOpen && explained && !showWelcome ? (
        <NotesBoard key={explained.id} paperId={explained.id} title={explained.title} onClose={() => setBoardOpen(false)} />
      ) : null}

      {explainOpen && explained && !showWelcome ? (
        <Explain
          paperId={explained.id}
          title={explained.title}
          authors={explained.authors}
          published={explained.published}
          screen={readScreen}
          onClose={() => setExplainOpen(false)}
        />
      ) : null}

      {assistantOpen && !showWelcome ? <Assistant onClose={closeAssistant} screen={readScreen} reading={Boolean(reading)} /> : null}

      {settingsOpen ? <Settings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
