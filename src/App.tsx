import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from './lib/store';
import type { View } from './types.view';
import { HIGHLIGHT_COLORS } from './types';
import type { Screen } from './lib/assistant';
import { setQuote } from './lib/assistant';
import { followLight } from './lib/glassLight';
import { clearSelection, currentSelection, paperText, pdfPageImages, pdfPagesInView, pdfPageTexts, trackSelection, visiblePassage } from './lib/screen';
import Assistant from './components/Assistant';
import CollectionView from './components/CollectionView';
import JunkView from './components/JunkView';
import CommandPalette from './components/CommandPalette';
import Discover from './components/Discover';
import Library from './components/Library';
import NotesRail from './components/NotesRail';
import Reader from './components/Reader';
import Settings from './components/Settings';
import Welcome from './components/Welcome';
import { GoogleMark, HighlighterIcon, LibraryIcon, SearchIcon, SettingsIcon, SparkleIcon } from './components/icons';

const WELCOME_KEY = 'reader.welcomed';
const VIEW_KEY = 'reader.view';
const LAYOUT_KEY = 'reader.layout';
const ASSISTANT_KEY = 'reader.assistant.open';
const ZEN_KEY = 'reader.zen';

/** Which edge's panes are out while in zen mode. */
type Peek = 'left' | 'right' | null;

/** How long the pointer may be off a pane before it slides back. */
const PEEK_LINGER_MS = 320;

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
  const [welcomed, setWelcomed] = useState(() => localStorage.getItem(WELCOME_KEY) === 'true');
  // Dismissing the opening screen is remembered for this page load only. A
  // sign-in is kept in this browser for the hour Google's token lasts, so a
  // reload comes back connected; once it has run out — there is no backend to
  // hold a refresh token — the visit starts disconnected, and offers to
  // reconnect before anything is collected that Drive would then have missed.
  const [skippedConnect, setSkippedConnect] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => localStorage.getItem(ASSISTANT_KEY) === 'true');
  // Zen mode, while a paper is open: the rail, the library and the dock step
  // off the screen and wait at its edges. Hovering an edge brings that side's
  // panes out over the page, with a haze cast from them across it.
  const [zen, setZen] = useState(() => localStorage.getItem(ZEN_KEY) === 'true');
  const [peek, setPeek] = useState<Peek>(null);
  // The side the haze is drawn from outlives the peek, so it fades out in place.
  const [hazeSide, setHazeSide] = useState<Exclude<Peek, null>>('left');
  const peekTimer = useRef<number>();
  const appRef = useRef<HTMLDivElement>(null);
  const toggleZen = useCallback(() => {
    setZen((current) => !current);
    setPeek(null);
  }, []);

  useEffect(() => {
    localStorage.setItem(ZEN_KEY, String(zen));
  }, [zen]);

  const peekIn = useCallback((side: Exclude<Peek, null>) => {
    window.clearTimeout(peekTimer.current);
    setPeek(side);
    setHazeSide(side);
  }, []);
  // Leaving a pane lets it go after a moment, so a pointer crossing from the
  // rail to the library, or overshooting the edge, does not snap it shut. A
  // pane with the cursor in a text field stays out until the field is left.
  const peekOut = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => {
      if (isTyping(document.activeElement) && document.activeElement?.closest('.rail, .app > .panel, .dock')) return;
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
      // Z, on its own and not while typing, takes a paper in and out of zen mode.
      if (readingNow && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'z' && !isTyping(event.target)) {
        if (document.querySelector('.scrim, .sheet, .palette')) return;
        event.preventDefault();
        toggleZen();
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleZen, readingNow]);

  const openPaper = useCallback((id: string) => {
    setView({ kind: 'paper', id });
    setSelectedHighlightId(null);
    setOrphanIds([]);
    if (isNarrow()) {
      setLibraryOpen(false);
      setDock(null);
    }
  }, []);

  // The highlights pane comes forward when you write a note; a plain highlight
  // only moves a dock that is already open.
  const revealNotes = useCallback(
    (force: boolean) => setDock((current) => (force || current ? 'notes' : null)),
    [],
  );

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
              ? `PDF, set as a book — ${inView.length > 1 ? `pages ${inView[0]}–${inView[inView.length - 1]}` : `page ${inView[0]}`} of ${pages.length} in view`
              : `PDF, in the browser’s own viewer (${pages.length} pages; which page is in view is not known to the app)`;
          } catch {
            mode = 'PDF (its text could not be read)';
          }
        } else if (!fullText) {
          mode = 'PDF (still loading)';
        }
        const kind = (color: string) => HIGHLIGHT_COLORS.find((c) => c.id === color)?.label ?? color;
        return {
          where: 'Reading a paper',
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
  }, [view, papers, collections, highlights]);

  const closeAssistant = useCallback(() => setAssistantOpen(false), []);

  const zenOn = zen && ready && view.kind === 'paper';

  // A tap anywhere off the panes puts them back — on a touch screen there is
  // no pointer to leave them. (A tap in the PDF viewer's own frame never
  // reaches the page; the pane goes back when the pointer leaves it instead.)
  useEffect(() => {
    if (!zenOn || !peek) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.rail, .app > .panel, .dock, .zen-edge')) return;
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
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [zenOn, peek, libraryOpen, dock]);

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
  // Highlights only mean anything with a paper open, so the dock falls back to
  // Discover rather than showing an empty rail.
  const dockPane: Dock = dock === 'notes' && !reading ? 'discover' : dock;
  const inZen = zenOn && !showWelcome;
  // In zen mode the right edge always has something to bring out: the dock as
  // it was left, or the highlights if it was shut.
  const shownDock: Dock = inZen ? dockPane ?? 'notes' : dockPane;
  // Which edge an element belongs to: its panes, or the strip that brings them out.
  const sideOf = (target: EventTarget | null): Peek => {
    const element = target instanceof Element ? target.closest('.rail, .app > .panel, .dock, .zen-edge') : null;
    if (!element) return null;
    if (element.classList.contains('zen-edge')) return (element as HTMLElement).dataset.side as Peek;
    return element.classList.contains('dock') ? 'right' : 'left';
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
      className={`app${inZen ? ` is-zen haze-${settings.zenHaze}` : ''}${inZen && peek ? ` peek-${peek}` : ''}`}
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
          onClick={() => setLibraryOpen(!libraryOpen)}
        >
          <LibraryIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={dockPane === 'discover'}
          aria-label="Discover papers"
          title="Discover"
          onClick={() => setDock(dockPane === 'discover' ? null : 'discover')}
        >
          <SearchIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={dockPane === 'notes'}
          aria-label="Highlights and notes"
          title="Highlights"
          onClick={() => setDock(dockPane === 'notes' ? null : 'notes')}
        >
          <HighlighterIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={assistantOpen}
          aria-label="Ask Claude"
          title={assistantOpen ? 'Ask Claude is open — click to close it (⌘\\)' : 'Ask Claude about this paper (⌘\\)'}
          onClick={() => setAssistantOpen(!assistantOpen)}
        >
          <SparkleIcon size={19} />
        </button>
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

      {libraryOpen && !showWelcome ? (
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

      {showWelcome ? (
        <Welcome onDismiss={dismissWelcome} onOpenSettings={() => setSettingsOpen(true)} />
      ) : view.kind === 'paper' ? (
        <Reader
          paperId={view.id}
          notesOpen={dockPane === 'notes'}
          selectedHighlightId={selectedHighlightId}
          onBack={() => setView(collections[0] ? { kind: 'collection', id: collections[0].id } : { kind: 'all' })}
          onToggleNotes={() => setDock(dockPane === 'notes' ? null : 'notes')}
          onNotes={revealNotes}
          onToggleSidebar={() => setLibraryOpen(!libraryOpen)}
          zen={inZen}
          onToggleZen={toggleZen}
          onSelectHighlight={setSelectedHighlightId}
          onOrphans={onOrphans}
        />
      ) : view.kind === 'junk' ? (
        <JunkView />
      ) : (
        <CollectionView view={view} onOpenPaper={openPaper} onDiscover={addPapers} />
      )}

      {shownDock && !showWelcome ? (
        <div className="dock">
          {reading ? (
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
                Highlights
              </button>
            </div>
          ) : null}

          {shownDock === 'discover' ? (
            <Discover
              onClose={() => (inZen ? setPeek(null) : setDock(null))}
              onOpen={openPaper}
              ask={discoverAsk}
              here={view.kind === 'collection' ? view.id : undefined}
              focus={discoverFocus}
            />
          ) : (
            <NotesRail
              paperId={view.kind === 'paper' ? view.id : ''}
              selectedId={selectedHighlightId}
              orphanIds={orphanIds}
              onSelect={setSelectedHighlightId}
              onClose={() => (inZen ? setPeek(null) : setDock(null))}
            />
          )}
        </div>
      ) : null}

      {inZen ? (
        <>
          <div className="zen-haze" data-side={hazeSide} aria-hidden="true" />
          <div className="zen-edge" data-side="left" aria-hidden="true" onPointerDown={() => peekIn('left')} />
          <div className="zen-edge" data-side="right" aria-hidden="true" onPointerDown={() => peekIn('right')} />
        </>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenPaper={openPaper}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : null}

      {assistantOpen && !showWelcome ? <Assistant onClose={closeAssistant} screen={readScreen} reading={Boolean(reading)} /> : null}

      {settingsOpen ? <Settings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
