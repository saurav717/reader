import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { Paper } from '../types';
import { JUNK_FOLDER, ROOT_FOLDER, describeRemovalInDrive, isInDrive } from '../lib/driveSync';

/**
 * The notice that stands between the bin button and the papers going. It
 * says what will happen in Drive before it happens — moved to Junk, not
 * deleted; or left where it is, and why — and only then asks. Whatever is
 * removed goes to the library's own Junk, where it can be put back.
 *
 * Drive refusing the move keeps that paper in the library: the entry is the
 * only record of where the files are. The reader can try again, connect Drive
 * if that was the problem, or take the entry out and leave Drive as it is.
 */
export default function RemovePaperDialog({ papers, onClose, onRemoved }: { papers: Paper[]; onClose: () => void; onRemoved?: (ids: string[]) => void }) {
  const { removePaper, driveConnected, connectDrive, authError, settings } = useStore();
  const [busy, setBusy] = useState<'removing' | 'connecting' | null>(null);
  const [error, setError] = useState<{ paper: Paper; message: string } | null>(null);
  const [done, setDone] = useState(0);
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
  const many = papers.length > 1;
  const single = papers[0];
  const inDrive = papers.filter(isInDrive);
  const drive = many
    ? inDrive.length
      ? driveConnected
        ? {
            moves: true,
            text: `${inDrive.length === papers.length ? 'Their folders' : `The folders of the ${inDrive.length} saved to Drive`} will be moved to ${rootName}/${JUNK_FOLDER} rather than deleted.`,
          }
        : { moves: false, text: `Their copies in Drive stay where they are, because Drive is not connected. Connect Drive first to have them moved to ${rootName}/${JUNK_FOLDER}.` }
      : { moves: false, text: 'None of them was saved to Drive, so there is nothing there to move.' }
    : describeRemovalInDrive(single, { driveConnected, rootName });

  const remove = async (junkInDrive: boolean, from = 0) => {
    setBusy('removing');
    setError(null);
    const removed: string[] = [];
    for (let index = from; index < papers.length; index += 1) {
      const paper = papers[index];
      try {
        await removePaper(paper.id, { junkInDrive });
        removed.push(paper.id);
        setDone(index + 1);
      } catch (failure) {
        setError({ paper, message: failure instanceof Error ? failure.message : String(failure) });
        setBusy(null);
        onRemoved?.(removed);
        return;
      }
    }
    onRemoved?.(removed);
    onClose();
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
        <h2 id="remove-paper-title">{many ? `Move ${papers.length} papers to Junk?` : 'Move this paper to Junk?'}</h2>
        <p className="lede">
          {many ? (
            <>These papers will be taken out of every collection they are in, highlights and all.</>
          ) : (
            <>
              <em>{single.title}</em> will be taken out of every collection it is in, and its highlights go with it.
            </>
          )}{' '}
          {many ? 'They wait' : 'It waits'} in <strong>Junk</strong>, at the bottom of the library, until you restore {many ? 'them' : 'it'} or empty it.
        </p>

        <p className={`banner${drive.moves ? '' : ' warn'}`}>
          {drive.text}
          {inDrive.length && !driveConnected ? (
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
            Could not move <em>{error.paper.title}</em> to {rootName}/{JUNK_FOLDER}:{' '}
            {/[.!?]$/.test(error.message) ? error.message : `${error.message}.`} It is still in your library
            {many && done < papers.length ? `, with ${papers.length - done - 1} more after it` : ''}.{' '}
            <button type="button" className="link-btn" onClick={() => void remove(false, done)} disabled={busy !== null}>
              Remove {many ? 'them' : 'it'} from the library anyway
            </button>{' '}
            and leave the copies in Drive where they are.
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="btn ghost" ref={cancelRef} onClick={onClose} disabled={busy === 'removing'}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={() => void remove(true, done)} disabled={busy !== null}>
            {busy === 'removing' ? (
              <>
                <span className="spinner" /> {many ? `Moving ${Math.min(done + 1, papers.length)} of ${papers.length}…` : 'Moving to Junk…'}
              </>
            ) : many ? (
              `Move ${papers.length} to Junk`
            ) : (
              'Move to Junk'
            )}
          </button>
        </div>
      </div>
    </>
  );
}
