// A page of the web, inside the reader: the proxy's Chromium at a URL, its
// picture here, and what is done to the picture — clicks, keys, scrolling,
// paste — sent back. The pane the paper's copies use to sign in
// (MiniBrowser.tsx) is this with the PDF hunting on top; this is the plain
// one, for a page that is the point in itself: Colab's notebook on the
// reader's own runtime (ColabPage.tsx). The proxy holds one browser session
// at a time, and leaving the pane closes it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, MouseEvent, ReactNode, WheelEvent } from 'react';
import { closeBrowser, InputQueue, keyName, nextFrame, openBrowser, openStream, toPagePoint } from '../lib/browse';
import type { BrowseStatus } from '../lib/browse';
import { ArrowLeftIcon } from './icons';

export type PaneStage = 'opening' | 'open' | 'closed';

/** The reader's look onto the page: a colour scheme for it to follow, and a stylesheet placed into it. */
export interface Look {
  scheme: 'dark' | 'light' | null;
  css: string;
}

interface Props {
  /** The page to open; a new URL opens a new page. */
  url: string;
  /** The reader's look, sent as the page opens, again after each navigation, and whenever it changes; null for the page's own. */
  look?: Look | null;
  /** Between the navigation buttons and the address: the pane's own buttons. */
  actions?: ReactNode;
  /** Told where the browser is, as it moves. */
  onStatus?: (status: BrowseStatus) => void;
  /** Told the pane's state, for a caption outside it. */
  onStage?: (stage: PaneStage, problem: string | null) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function BrowserPane({ url, look, actions, onStatus, onStage }: Props) {
  const [stage, setStage] = useState<PaneStage>('opening');
  const [status, setStatus] = useState<BrowseStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const screen = useRef<HTMLImageElement>(null);
  const polling = useRef<AbortController | null>(null);
  const queue = useMemo(() => new InputQueue((error) => setProblem(error.message)), []);
  const page = { width: status?.width || 1280, height: status?.height || 800 };
  const told = useRef(onStage);
  told.current = onStage;
  const heard = useRef(onStatus);
  heard.current = onStatus;
  const wanted = useRef<Look | null | undefined>(look);
  wanted.current = look;
  /** Where the page last was, and whether it was loading — a navigation, or a load ending, is a page to dress again. */
  const seen = useRef<{ url?: string; loading?: boolean }>({});
  const dress = () => {
    const current = wanted.current;
    queue.push({ type: 'look', scheme: current?.scheme ?? null, css: current?.css ?? '' });
  };

  useEffect(() => {
    told.current?.(stage, problem);
  }, [stage, problem]);

  // Open the URL given, and again whenever it changes; the browser is one page at a time.
  useEffect(() => {
    let live = true;
    setStage('opening');
    setProblem(null);
    setFrame(null);
    void (async () => {
      try {
        const opened = await openBrowser(url);
        if (!live) return;
        setStatus(opened);
        heard.current?.(opened);
        if (opened.frame) setFrame(opened.frame);
        seen.current = { url: opened.url, loading: opened.loading };
        setStage('open');
        if (wanted.current) dress();
      } catch (error) {
        if (!live) return;
        setProblem(message(error));
        setStage('closed');
      }
    })();
    return () => {
      live = false;
    };
  }, [url]);

  // The frames: over a stream where the proxy has one, else one held request after another.
  useEffect(() => {
    if (stage !== 'open') return;
    const controller = new AbortController();
    polling.current = controller;
    let after = -1;
    let misses = 0;
    let done = false;
    const take = (next: BrowseStatus): boolean => {
      if (controller.signal.aborted || done) return true;
      after = Math.max(after, next.seq);
      setStatus(next);
      heard.current?.(next);
      if (next.frame) setFrame(next.frame);
      // A new page, or the page done loading: the look goes on again, since a navigation takes the old sheet with it.
      const moved = next.url !== seen.current.url || (seen.current.loading && !next.loading);
      seen.current = { url: next.url, loading: next.loading };
      if (moved && next.open && wanted.current) dress();
      if (!next.open) {
        done = true;
        setProblem(next.ended || 'The browser closed on the proxy.');
        setStage('closed');
        return true;
      }
      return false;
    };
    const poll = async () => {
      while (!controller.signal.aborted && !done) {
        let next: BrowseStatus;
        try {
          next = await nextFrame(after, controller.signal);
          misses = 0;
        } catch (error) {
          if (controller.signal.aborted) return;
          misses += 1;
          if (misses > 5) {
            setProblem(message(error));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * misses));
          continue;
        }
        if (take(next)) return;
      }
    };
    const stream = openStream({
      onStatus: (next) => void take(next),
      onEnd: () => {
        queue.via = null;
        if (!controller.signal.aborted && !done) void poll();
      },
    });
    if (stream) queue.via = (events) => stream.send(events);
    else void poll();
    return () => {
      controller.abort();
      queue.via = null;
      stream?.close();
      polling.current = null;
    };
    // Only opening and closing the page starts and stops the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage === 'open']);

  // The look changing — the switch, the theme — goes onto the page that is open.
  useEffect(() => {
    if (stage === 'open') dress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look?.css, look?.scheme]);

  // Leaving the pane closes the page on the proxy too.
  useEffect(
    () => () => {
      polling.current?.abort();
      void closeBrowser();
    },
    [],
  );

  // ------------------------------------------------------------ input ----

  const point = useCallback(
    (event: MouseEvent | WheelEvent) => {
      const box = screen.current?.getBoundingClientRect();
      if (!box) return { x: 0, y: 0 };
      return toPagePoint({ x: event.clientX, y: event.clientY }, box, page);
    },
    [page.width, page.height], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const button = (event: MouseEvent): 'left' | 'middle' | 'right' => (event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left');
  const onMouseDown = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    event.currentTarget.parentElement?.parentElement?.focus();
    queue.push({ type: 'down', ...point(event), button: button(event), clickCount: Math.min(3, event.detail || 1) });
  };
  const onMouseUp = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    queue.push({ type: 'up', ...point(event), button: button(event), clickCount: Math.min(3, event.detail || 1) });
  };
  const onMouseMove = (event: MouseEvent<HTMLImageElement>) => queue.push({ type: 'move', ...point(event) });
  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.height : 1;
    queue.push({ type: 'wheel', ...point(event), dx: Math.round(event.deltaX * unit), dy: Math.round(event.deltaY * unit) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (stage !== 'open') return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    const key = keyName(event.key);
    if (!key) return;
    event.preventDefault();
    queue.push({ type: 'keydown', key });
  };
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (stage !== 'open') return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    const key = keyName(event.key);
    if (!key) return;
    event.preventDefault();
    queue.push({ type: 'keyup', key });
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (stage !== 'open') return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    queue.push({ type: 'insert', text });
  };

  return (
    <div className={`mini-browser browser-pane${focused ? ' is-focused' : ''}`} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPaste={onPaste} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <div className="mini-browser-head">
        <button type="button" className="icon-btn sm" onClick={() => queue.push({ type: 'back' })} aria-label="Back" title="Back" disabled={stage !== 'open'}>
          <ArrowLeftIcon size={16} />
        </button>
        <button type="button" className="icon-btn sm" onClick={() => queue.push({ type: 'forward' })} aria-label="Forward" title="Forward" style={{ transform: 'scaleX(-1)' }} disabled={stage !== 'open'}>
          <ArrowLeftIcon size={16} />
        </button>
        <button type="button" className="icon-btn sm" onClick={() => queue.push({ type: 'reload' })} aria-label="Reload" title="Reload" style={{ fontSize: 15 }} disabled={stage !== 'open'}>
          ↻
        </button>
        <span className="field mini-browser-address browser-pane-address" title={status?.url || url}>
          {status?.loading || stage === 'opening' ? <span className="spinner" /> : null}
          <span className="browser-pane-url">{status?.url || url}</span>
        </span>
        {actions}
      </div>
      <div className="mini-browser-screen" onClick={(event) => event.currentTarget.parentElement?.focus()}>
        {frame ? (
          <img
            ref={screen}
            src={`data:image/jpeg;base64,${frame}`}
            alt={status?.title ? `${status.title} — the page in the proxy's browser` : "The page in the proxy's browser"}
            draggable={false}
            width={page.width}
            height={page.height}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onMouseMove={onMouseMove}
            onWheel={onWheel}
            onContextMenu={(event) => event.preventDefault()}
          />
        ) : stage === 'closed' ? (
          <p className="mini-browser-note">{problem || 'The browser is closed.'}</p>
        ) : (
          <p className="mini-browser-note">
            <span className="spinner" /> {stage === 'opening' ? 'Opening the page in the proxy’s browser…' : 'Waiting for the first picture of the page…'}
          </p>
        )}
      </div>
    </div>
  );
}
