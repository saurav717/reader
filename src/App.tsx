import { useCallback, useEffect, useState } from 'react';
import { useStore } from './lib/store';
import type { View } from './types.view';
import CollectionView from './components/CollectionView';
import CommandPalette from './components/CommandPalette';
import Discover from './components/Discover';
import Library from './components/Library';
import NotesRail from './components/NotesRail';
import Reader from './components/Reader';
import Settings from './components/Settings';
import Welcome from './components/Welcome';
import { GoogleMark, HighlighterIcon, LibraryIcon, SearchIcon, SettingsIcon } from './components/icons';

const WELCOME_KEY = 'reader.welcomed';
const VIEW_KEY = 'reader.view';
const LAYOUT_KEY = 'reader.layout';

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
  const { ready, papers, collections, user, driveConnected, settings } = useStore();
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
  // token cannot outlive the tab — there is no backend to hold a refresh token
  // — so every visit starts disconnected, and every visit offers to reconnect
  // before anything is collected that Drive would then have missed.
  const [skippedConnect, setSkippedConnect] = useState(false);

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  return (
    <div className="app">
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
          onSelectHighlight={setSelectedHighlightId}
          onOrphans={onOrphans}
        />
      ) : (
        <CollectionView view={view} onOpenPaper={openPaper} onDiscover={() => setDock('discover')} />
      )}

      {dockPane && !showWelcome ? (
        <div className="dock">
          {reading ? (
            <div className="dock-tabs" role="tablist" aria-label="Side panel">
              <button
                type="button"
                role="tab"
                aria-selected={dockPane === 'discover'}
                onClick={() => setDock('discover')}
              >
                Discover
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dockPane === 'notes'}
                onClick={() => setDock('notes')}
              >
                Highlights
              </button>
            </div>
          ) : null}

          {dockPane === 'discover' ? (
            <Discover onClose={() => setDock(null)} onOpen={openPaper} />
          ) : (
            <NotesRail
              paperId={view.kind === 'paper' ? view.id : ''}
              selectedId={selectedHighlightId}
              orphanIds={orphanIds}
              onSelect={setSelectedHighlightId}
              onClose={() => setDock(null)}
            />
          )}
        </div>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenPaper={openPaper}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : null}

      {settingsOpen ? <Settings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
