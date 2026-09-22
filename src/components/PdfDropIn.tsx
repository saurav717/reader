import { useId, useRef, useState, type DragEvent } from 'react';
import { pdfFromFile } from '../lib/pdf';

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
      .{problem ? ` ${problem}` : ''}
    </span>
  );
}
