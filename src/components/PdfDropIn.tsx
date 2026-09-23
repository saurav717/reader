import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { pdfFromFile } from '../lib/pdf';
import { canWatchDownloads, pickDownloads, watchForPdf } from '../lib/downloads';

interface Props {
  /** The publisher to open in a tab of your own, where you may already be signed in. */
  host?: string;
  /** The page to open there. */
  url?: string;
  /** What to do with the file once it is known to be a PDF. */
  onFile: (blob: Blob, file: File) => void | Promise<void>;
}

/**
 * The way through a login wall that needs no proxy at all: you.
 *
 * A browser will not let the page fetch a publisher's PDF, signed in or not —
 * but it will let the page read a file you hand it. So where the proxy cannot
 * get the paper, this says: open it at the publisher in a tab of your own,
 * where your institution's sign-in already holds, download the PDF, and drop
 * it here. The bytes then go to Drive and open like any other copy.
 */
export default function PdfDropIn({ host, url, onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The watch on the Downloads folder, while there is one. */
  const [watching, setWatching] = useState(false);
  const watch = useRef<AbortController | null>(null);

  useEffect(() => () => watch.current?.abort(), []);

  const take = async (file: File | undefined) => {
    if (!file || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const blob = await pdfFromFile(file);
      await onFile(blob, file);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  /**
   * Point the reader at the Downloads folder, and take the first PDF that
   * lands there: the person opens the paper in a tab of their own — where
   * their browser passes whatever check or sign-in is in the way — and saves
   * the file as they would anyway. The folder is asked for here, from the
   * click, since a browser hands a folder over only on one.
   */
  const startWatching = async () => {
    setProblem(null);
    let dir;
    try {
      dir = await pickDownloads();
    } catch {
      return; // the dialog was closed
    }
    const controller = new AbortController();
    watch.current?.abort();
    watch.current = controller;
    setWatching(true);
    try {
      const file = await watchForPdf(dir, { signal: controller.signal });
      if (controller.signal.aborted) return;
      await take(file);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (watch.current === controller) {
        watch.current = null;
        setWatching(false);
      }
    }
  };

  const stopWatching = () => {
    watch.current?.abort();
    watch.current = null;
    setWatching(false);
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(false);
    void take(event.dataTransfer.files?.[0]);
  };

  return (
    <span
      className={`drop-in${over ? ' over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {' '}
      Or hand it over yourself:{' '}
      {url && host ? (
        <>
          <a href={url} target="_blank" rel="noreferrer noopener">
            open it at {host}
          </a>{' '}
          in a tab of your own — where your institution’s sign-in already holds — download the PDF, and
        </>
      ) : (
        <>download the PDF from wherever you can read it, and</>
      )}{' '}
      drop it here or{' '}
      <label htmlFor={inputId} className="link-btn" style={{ cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'reading the file…' : 'choose the file'}
      </label>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        className="vh"
        disabled={busy}
        onChange={(event) => void take(event.target.files?.[0])}
      />
      .
      {canWatchDownloads() ? (
        watching ? (
          <>
            {' '}
            <span className="spinner" /> Watching your Downloads folder: the first PDF saved there is taken as this paper.{' '}
            {url && host ? (
              <>
                <a href={url} target="_blank" rel="noreferrer noopener">
                  Open it at {host}
                </a>{' '}
                and save the PDF.{' '}
              </>
            ) : null}
            <button type="button" className="link-btn" onClick={stopWatching}>
              Stop watching
            </button>
          </>
        ) : (
          <>
            {' '}
            Or skip the drop:{' '}
            <button type="button" className="link-btn" disabled={busy} onClick={() => void startWatching()}>
              watch my Downloads folder
            </button>{' '}
            and the PDF is taken the moment you save it there.
          </>
        )
      ) : null}
      {problem ? ` ${problem}` : ''}
    </span>
  );
}
