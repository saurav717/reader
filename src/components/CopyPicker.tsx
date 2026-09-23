import { useEffect, useRef } from 'react';
import { versionLabel } from '../lib/locations';
import type { PaperLocation } from '../types';
import PdfDropIn from './PdfDropIn';

/** What happened when a copy was asked for the file, for the note beside it. */
export interface CopyNote {
  text: string;
  /** It handed over a PDF, but one that did not look like the paper. */
  doubtful?: boolean;
}

interface Props {
  /** Every copy of the paper, best first — the order they were tried in. */
  locations: PaperLocation[];
  /** The copy on screen, when the file came from one. */
  current: string | null;
  /** The copy picked by hand before, which the paper now opens on. */
  choice?: string;
  /** What each copy said when it was asked, by URL. */
  notes: Record<string, CopyNote>;
  /** A copy being fetched right now. */
  switching: string | null;
  onPick: (location: PaperLocation) => void;
  /** Open the browser in the pane, at a site picked there. Absent without a proxy that has one. */
  onBrowse?: () => void;
  onFile: (blob: Blob) => void;
  /** Go back to letting the reader choose. */
  onForget?: () => void;
  onClose: () => void;
}

/**
 * Every copy of the paper, to read a different one.
 *
 * The reader shows the first copy that hands over a PDF, and a PDF is not
 * always the paper: a conference page links the poster, a repository has
 * the slides, the preprint is an older version than the one that was
 * published. So the copy on screen is a choice the person can overrule —
 * any other copy, fetched on its own; a browser in the pane for one behind
 * a sign-in or a check for a person; or a file of their own. Each copy
 * says what it answered when it was asked, so a copy that refused is not
 * picked blind.
 */
export default function CopyPicker({
  locations,
  current,
  choice,
  notes,
  switching,
  onPick,
  onBrowse,
  onFile,
  onForget,
  onClose,
}: Props) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (panel.current?.contains(target) || target.closest('.copy-current')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button.copy-option:not([disabled])')?.focus();
  }, []);

  return (
    <div className="copy-picker" ref={panel} role="dialog" aria-label="Read a different copy of this paper">
      <p className="eyebrow">
        {locations.length === 1 ? 'One copy' : `${locations.length} copies`} of this paper — pick the one to read
      </p>
      <ul>
        {locations.map((location) => {
          const showing = location.url === current;
          const note = notes[location.url];
          const busy = switching === location.url;
          return (
            <li key={location.url}>
              <button
                type="button"
                className={`copy-option${showing ? ' showing' : ''}`}
                disabled={showing || Boolean(switching)}
                onClick={() => onPick(location)}
                title={location.url}
              >
                <span className="copy-name">
                  {location.label}
                  {location.label !== location.host ? <span className="copy-host">{location.host}</span> : null}
                </span>
                <span className="copy-tags">
                  <span className={location.isPdf ? 'loc-pdf' : 'loc-page'}>{location.isPdf ? 'PDF' : 'page'}</span>
                  {location.version ? <span className="loc-version">{versionLabel(location.version)}</span> : null}
                  {showing ? <span className="copy-state">showing</span> : null}
                  {!showing && location.url === choice ? <span className="copy-state">your pick</span> : null}
                  {busy ? <span className="spinner" /> : null}
                </span>
                {note && !showing ? <span className={`copy-note${note.doubtful ? ' doubtful' : ''}`}>{note.text}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="copy-more">
        {onBrowse ? (
          <p>
            <button type="button" className="link-btn" onClick={onBrowse}>
              Browse to a copy here
            </button>{' '}
            — for one behind a sign-in: a browser opens in this pane, at the site you pick.
          </p>
        ) : null}
        <p>
          <PdfDropIn onFile={onFile} />
        </p>
        {onForget ? (
          <p>
            <button type="button" className="link-btn" onClick={onForget}>
              Forget my pick
            </button>{' '}
            — the next open tries every copy again, best first.
          </p>
        ) : null}
      </div>
    </div>
  );
}
