import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { Paper } from '../types';
import { JUNK_FOLDER, ROOT_FOLDER, describeRemovalInDrive, isInDrive } from '../lib/driveSync';

/**
 * The notice that stands between the bin button and the paper going. It says
 * what will happen in Drive before it happens — moved to Junk, not deleted;
 * or left where it is, and why — and only then asks.
 *
 * Drive refusing the move keeps the paper in the library: the entry is the
 * only record of where the files are. The reader can try again, connect Drive
 * if that was the problem, or take the entry out and leave Drive as it is.
 */
export default function RemovePaperDialog({ paper, onClose }: { paper: Paper; onClose: () => void }) {
  const { removePaper, driveConnected, connectDrive, authError, settings } = useStore();
  const [busy, setBusy] = useState<'removing' | 'connecting' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape closes the notice, except while the removal it agreed to is under
  // way: that would hide the outcome, not stop it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy !== 'removing') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const rootName = settings.driveFolderName || ROOT_FOLDER;
  const inDrive = isInDrive(paper);
  const drive = describeRemovalInDrive(paper, { driveConnected, rootName });

  const remove = async (junkInDrive: boolean) => {
    setBusy('removing');
    setError(null);
    try {
      await removePaper(paper.id, { junkInDrive });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy('connecting');
    await connectDrive();
    setBusy(null);
  };

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} role="presentation" />
      <div className="sheet narrow" role="dialog" aria-modal="true" aria-labelledby="remove-paper-title">
        <h2 id="remove-paper-title">Remove this paper?</h2>
        <p className="lede">
          <em>{paper.title}</em> will be taken out of every collection it is in, and its highlights go with it.
        </p>

        <p className={`banner${drive.moves ? '' : ' warn'}`}>
          {drive.text}
          {inDrive && !driveConnected ? (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={() => void connect()} disabled={busy !== null}>
                {busy === 'connecting' ? 'Connecting…' : 'Connect Drive'}
              </button>
            </>
          ) : null}
        </p>
        {authError && !driveConnected ? (
          <p className="banner error" style={{ marginTop: 10 }}>
            {authError}
          </p>
        ) : null}

        {error ? (
          <p className="banner error" style={{ marginTop: 10 }}>
            Could not move it to {rootName}/{JUNK_FOLDER}: {/[.!?]$/.test(error) ? error : `${error}.`} The paper is
            still in your library.{' '}
            <button type="button" className="link-btn" onClick={() => void remove(false)} disabled={busy !== null}>
              Remove it from the library anyway
            </button>{' '}
            and leave the copy in Drive where it is.
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="btn ghost" ref={cancelRef} onClick={onClose} disabled={busy === 'removing'}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={() => void remove(true)} disabled={busy !== null}>
            {busy === 'removing' ? (
              <>
                <span className="spinner" /> {drive.moves ? 'Moving to Junk…' : 'Removing…'}
              </>
            ) : drive.moves ? (
              'Move to Junk and remove'
            ) : (
              'Remove from the library'
            )}
          </button>
        </div>
      </div>
    </>
  );
}
