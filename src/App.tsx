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

function readLayout(): { panel: 'discover' | 'library' | null; notesOpen: boolean } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw) as { panel: 'discover' | 'library' | null; notesOpen: boolean };
  } catch {
    // fall through to the default
  }
  // On a phone the panels are overlays, so opening one by default would hide
  // the page behind it.
  return isNarrow() ? { panel: null, notesOpen: false } : { panel: 'library', notesOpen: true };
}

export default function App() {
  const { ready, papers, collections, user, driveConnected } = useStore();
  const [layout] = useState(readLayout);
  const [panel, setPanel] = useState<'discover' | 'library' | null>(layout.panel);
  const [view, setView] = useState<View>(readView);
  const [notesOpen, setNotesOpen] = useState(layout.notesOpen);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomed, setWelcomed] = useState(() => localStorage.getItem(WELCOME_KEY) === 'true');

  // Reopening the tab should put you back on the paper you were reading.
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  }, [view]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ panel, notesOpen }));
  }, [panel, notesOpen]);

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
    if (isNarrow()) setPanel(null);
  }, []);

  const dismissWelcome = useCallback(() => {
    localStorage.setItem(WELCOME_KEY, 'true');
    setWelcomed(true);
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

  const showWelcome = !welcomed && !papers.length;

  return (
    <div className="app">
      <nav className="rail" aria-label="Primary">
        <div className="brand" aria-hidden="true">
          R
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={panel === 'discover'}
          aria-label="Discover papers"
          title="Discover"
          onClick={() => setPanel(panel === 'discover' ? null : 'discover')}
        >
          <SearchIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={panel === 'library'}
          aria-label="Library"
          title="Library"
          onClick={() => setPanel(panel === 'library' ? null : 'library')}
        >
          <LibraryIcon size={19} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={notesOpen}
          aria-label="Highlights and notes"
          title="Highlights"
          onClick={() => setNotesOpen(!notesOpen)}
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

      {panel === 'discover' && !showWelcome ? <Discover onClose={() => setPanel(null)} onOpen={openPaper} /> : null}
      {panel === 'library' && !showWelcome ? (
        <Library
          view={view}
          onSelect={(next) => {
            setView(next);
            if (isNarrow()) setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {showWelcome ? (
        <Welcome onDismiss={dismissWelcome} onOpenSettings={() => setSettingsOpen(true)} />
      ) : view.kind === 'paper' ? (
        <Reader
          paperId={view.id}
          notesOpen={notesOpen}
          selectedHighlightId={selectedHighlightId}
          onBack={() => setView(collections[0] ? { kind: 'collection', id: collections[0].id } : { kind: 'all' })}
          onToggleNotes={() => setNotesOpen((current) => !current)}
          onToggleSidebar={() => setPanel(panel ? null : 'library')}
          onSelectHighlight={setSelectedHighlightId}
          onOrphans={onOrphans}
        />
      ) : (
        <CollectionView view={view} onOpenPaper={openPaper} onDiscover={() => setPanel('discover')} />
      )}

      {view.kind === 'paper' && notesOpen && !showWelcome ? (
        <NotesRail
          paperId={view.id}
          selectedId={selectedHighlightId}
          orphanIds={orphanIds}
          onSelect={setSelectedHighlightId}
          onClose={() => setNotesOpen(false)}
        />
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
