import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import type { JunkEntry } from '../types';
import { JUNK_FOLDER, ROOT_FOLDER } from '../lib/driveSync';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { CloseIcon, RestoreIcon, SearchIcon, TrashIcon } from './icons';
import { CoverTile } from './LibraryBits';

const DRIVE_NOTE: Record<JunkEntry['drive'], string> = {
  junked: 'Its Drive folder is in Junk too, and comes back with it',
  kept: 'Its Drive folder was left where it was',
  'not-connected': 'Its Drive folder was left where it was — Drive was not connected',
  'not-in-drive': 'Never saved to Drive',
};

/**
 * Everything that has been taken out of the library, most recently first,
 * to be put back — collections, highlights and Drive folder with it — or
 * forgotten for good.
 */
export default function JunkView() {
  const { junk, restorePaper, purgeJunk, settings, driveConnected } = useStore();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? junk.filter((entry) => entry.paper.title.toLowerCase().includes(needle) || entry.paper.authors.join(' ').toLowerCase().includes(needle))
      : junk;
    return list.slice().sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  }, [junk, filter]);

  useEffect(() => {
    const here = new Set(rows.map((entry) => entry.paper.id));
    setSelected((current) => {
      const kept = [...current].filter((id) => here.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [rows]);

  const rootName = settings.driveFolderName || ROOT_FOLDER;
  const chosen = rows.filter((entry) => selected.has(entry.paper.id));
  const allChosen = rows.length > 0 && chosen.length === rows.length;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const restore = async (ids: string[]) => {
    setError(null);
    for (const id of ids) {
      setBusy(id);
      try {
        await restorePaper(id);
      } catch (failure) {
        const title = junk.find((entry) => entry.paper.id === id)?.paper.title ?? 'A paper';
        setError(`${title} could not be put back: its Drive folder would not come out of ${rootName}/${JUNK_FOLDER} (${failure instanceof Error ? failure.message : String(failure)}).`);
        break;
      }
    }
    setBusy(null);
  };

  const purge = async (ids: string[]) => {
    await purgeJunk(ids);
    setConfirm(null);
  };

  const junkedInDrive = junk.some((entry) => entry.drive === 'junked');

  return (
    <div className="main library-main">
      <div className="collection-head">
        <div className="collection-titlebar">
          <span className="junk-mark">
            <TrashIcon size={18} />
          </span>
          <h1 className="collection-title">Junk</h1>
          <span style={{ flexGrow: 1 }} />
          {junk.length ? (
            <button type="button" className="btn danger-ghost" onClick={() => setConfirm(junk.map((entry) => entry.paper.id))}>
              Empty Junk
            </button>
          ) : null}
        </div>
        <p className="collection-sub">
          <span>
            {junk.length} removed paper{junk.length === 1 ? '' : 's'}
          </span>
          <span>kept until you empty it</span>
          {junkedInDrive ? (
            <span>
              Drive copies in {rootName}/{JUNK_FOLDER}
            </span>
          ) : null}
        </p>

        <div className="collection-toolbar">
          <span
            className={`select-all${allChosen ? ' is-all' : chosen.length ? ' is-some' : ''}`}
            role="checkbox"
            aria-checked={allChosen ? true : chosen.length ? 'mixed' : false}
            aria-label={allChosen ? 'Select none' : 'Select everything in Junk'}
            tabIndex={rows.length ? 0 : -1}
            onClick={() => rows.length && setSelected(allChosen ? new Set() : new Set(rows.map((entry) => entry.paper.id)))}
            onKeyDown={(event) => {
              if ((event.key === ' ' || event.key === 'Enter') && rows.length) {
                event.preventDefault();
                setSelected(allChosen ? new Set() : new Set(rows.map((entry) => entry.paper.id)));
              }
            }}
          >
            <span className="box" />
          </span>
          <div className="field collection-filter">
            <SearchIcon size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter Junk" aria-label="Filter Junk" />
          </div>
        </div>
        {error ? <p className="banner error" style={{ margin: '0 0 12px' }}>{error}</p> : null}
        {junkedInDrive && !driveConnected ? (
          <p className="banner warn" style={{ margin: '0 0 12px' }}>
            Drive is not connected, so a paper put back now leaves its folder in {rootName}/{JUNK_FOLDER}. Connect Drive in Settings first to have it moved back too.
          </p>
        ) : null}
      </div>

      <div className={`scroll library-scroll${chosen.length ? ' has-selection' : ''}`}>
        {!rows.length ? (
          <div className="empty">
            <h3>{filter ? 'Nothing matches that' : 'Junk is empty'}</h3>
            <p>Papers you remove from the library wait here, highlights and all, until you put them back or empty Junk.</p>
          </div>
        ) : null}
        <div className="lib-list">
          {rows.map((entry) => {
            const { paper } = entry;
            const isSelected = selected.has(paper.id);
            return (
              <div key={paper.id} className={`lib-row is-junk${isSelected ? ' is-selected' : ''}`}>
                <CoverTile paper={paper} selected={isSelected} selecting={chosen.length > 0} onToggle={() => toggle(paper.id)} label={`Select ${paper.title}`} />
                <div className="lib-main">
                  <span className="paper-name">{paper.title}</span>
                  <span className="lib-authors">{authorLine(paper.authors)}</span>
                  <span className="lib-meta">
                    <span>Removed {relativeDay(entry.removedAt)}</span>
                    {entry.highlights.length ? (
                      <span className="lib-chip hl">
                        {entry.highlights.length} highlight{entry.highlights.length === 1 ? '' : 's'}
                      </span>
                    ) : null}
                    <span className="lib-chip">{DRIVE_NOTE[entry.drive]}</span>
                  </span>
                </div>
                <div className="junk-actions">
                  <button type="button" className="btn sm" onClick={() => void restore([paper.id])} disabled={busy !== null}>
                    {busy === paper.id ? <span className="spinner" /> : <RestoreIcon size={14} />} Restore
                  </button>
                  <button type="button" className="icon-btn sm" onClick={() => setConfirm([paper.id])} title="Delete forever" aria-label={`Delete ${paper.title} forever`}>
                    <CloseIcon size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {chosen.length ? (
        <div className="selection-bar" role="toolbar" aria-label="What to do with the selected papers">
          <span className="selection-count">
            <strong>{chosen.length}</strong> selected
          </span>
          <span className="selection-sep" />
          <button type="button" className="btn sm ghost" onClick={() => void restore(chosen.map((entry) => entry.paper.id))} disabled={busy !== null}>
            <RestoreIcon size={15} /> Restore
          </button>
          <button type="button" className="btn sm danger-ghost" onClick={() => setConfirm(chosen.map((entry) => entry.paper.id))}>
            <TrashIcon size={15} /> Delete forever
          </button>
          <button type="button" className="icon-btn sm" onClick={() => setSelected(new Set())} aria-label="Clear the selection">
            <CloseIcon size={15} />
          </button>
        </div>
      ) : null}

      {confirm ? (
        <>
          <div className="scrim" onClick={() => setConfirm(null)} role="presentation" />
          <div className="sheet narrow" role="dialog" aria-modal="true" aria-labelledby="purge-title">
            <h2 id="purge-title">{confirm.length === junk.length && confirm.length > 1 ? 'Empty Junk?' : `Delete ${confirm.length === 1 ? 'this paper' : `${confirm.length} papers`} forever?`}</h2>
            <p className="lede">
              {confirm.length === 1 ? 'It' : 'They'} and {confirm.length === 1 ? 'its' : 'their'} highlights are forgotten for good and cannot be restored here.
              {junkedInDrive ? ` Anything in ${rootName}/${JUNK_FOLDER} in Drive stays there — delete it in Drive if you want the files gone too.` : ''}
            </p>
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirm(null)} autoFocus>
                Cancel
              </button>
              <button type="button" className="btn danger" onClick={() => void purge(confirm)}>
                Delete forever
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
