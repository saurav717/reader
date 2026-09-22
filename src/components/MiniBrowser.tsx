import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from 'react';
import { accessAvailable, type AccessStatus } from '../lib/access';
import {
  browseSites,
  closeBrowser,
  collectPdf,
  grabPdf,
  InputQueue,
  keyName,
  nextFrame,
  openBrowser,
  siteFromInput,
  toPagePoint,
  type BrowseSite,
  type BrowseStatus,
} from '../lib/browse';
import { pdfFileName, type SignInOffer } from '../lib/pdf';
import type { PaperLocation, PaperRef } from '../types';
import { ArrowLeftIcon, CloseIcon } from './icons';

interface Props {
  paper: PaperRef;
  /** Everywhere the paper is published, for the list of sites to offer. */
  locations: PaperLocation[] | null;
  /** The publisher that wanted a sign-in, if one did. */
  signIn: SignInOffer | null;
  /** The PDF the browser found, as a blob: the caller opens it. */
  onPdf: (blob: Blob, from: string) => void;
  /** Done browsing without a file — but the sign-in holds, so the copies are worth another try. */
  onRetry: () => void;
  onClose: () => void;
}

type Stage = 'choose' | 'opening' | 'open' | 'collecting';

/**
 * A browser in the place the paper would be.
 *
 * When every copy of a paper wants a sign-in, this offers the sites the
 * paper is published on — the one that asked for the sign-in first — and
 * opens the chosen one in the proxy's own browser, headless, showing what
 * it shows here as pictures and sending back what is done to them. Sign in
 * there the way you would anywhere. The moment that browser meets a PDF,
 * the file comes here and the paper opens on it; on a page that only links
 * the file, "Fetch the PDF from this page" follows the link with the
 * browser's cookies. The sign-in stays on the proxy for the next paper.
 *
 * It needs the Node proxy with a Chromium, and nothing else: no screen, no
 * window, no pop-up. The Cloudflare Worker has no browser, and this says so.
 */
export default function MiniBrowser({ paper, locations, signIn, onPdf, onRetry, onClose }: Props) {
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [stage, setStage] = useState<Stage>('choose');
  const [status, setStatus] = useState<BrowseStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [custom, setCustom] = useState('');
  const [focused, setFocused] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  const screen = useRef<HTMLImageElement>(null);
  const polling = useRef<AbortController | null>(null);
  const collected = useRef(false);
  const queue = useMemo(() => new InputQueue((error) => setProblem(error.message)), []);

  const sites = useMemo(() => browseSites(paper, locations, signIn), [paper, locations, signIn]);
  const page = { width: status?.width || 1280, height: status?.height || 800 };

  useEffect(() => {
    let live = true;
    accessAvailable().then((answer) => {
      if (live) setAccess(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  // The frames: one request held by the proxy until something changes, then
  // the next. Stops with the component, and closes the browser with it.
  useEffect(() => {
    if (stage !== 'open') return;
    const controller = new AbortController();
    polling.current = controller;
    let after = -1;
    let misses = 0;
    void (async () => {
      while (!controller.signal.aborted) {
        let next: BrowseStatus;
        try {
          next = await nextFrame(after, controller.signal);
          misses = 0;
        } catch (error) {
          if (controller.signal.aborted) return;
          misses += 1;
          if (misses > 5) {
            setProblem(error instanceof Error ? error.message : String(error));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * misses));
          continue;
        }
        if (controller.signal.aborted) return;
        after = Math.max(after, next.seq);
        setStatus(next);
        if (next.frame) setFrame(next.frame);
        if (!next.open && !next.pdf) {
          setProblem('The browser closed on the proxy.');
          setStage('choose');
          return;
        }
        if (next.pdf && !collected.current) {
          collected.current = true;
          setStage('collecting');
          try {
            const blob = await collectPdf(pdfFileName(paper));
            await closeBrowser();
            onPdf(blob, next.pdf.from);
          } catch (error) {
            collected.current = false;
            setProblem(error instanceof Error ? error.message : String(error));
            setStage('open');
          }
          return;
        }
      }
    })();
    return () => {
      controller.abort();
      polling.current = null;
    };
    // Only opening and closing the page starts and stops the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage === 'open']);

  // Leaving the reader mid-browse closes the page on the proxy too.
  useEffect(
    () => () => {
      polling.current?.abort();
      void closeBrowser();
    },
    [],
  );

  const open = async (url: string) => {
    setProblem(null);
    setStage('opening');
    setFrame(null);
    collected.current = false;
    try {
      const opened = await openBrowser(url);
      setStatus(opened);
      setAddress(opened.url || url);
      if (opened.frame) setFrame(opened.frame);
      setStage('open');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setStage('choose');
    }
  };

  const grab = async () => {
    if (grabbing) return;
    setGrabbing(true);
    setProblem(null);
    try {
      await grabPdf();
      // The poll sees the PDF on its next turn and collects it.
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setGrabbing(false);
    }
  };

  const close = async (retry: boolean) => {
    polling.current?.abort();
    await closeBrowser();
    if (retry) onRetry();
    else onClose();
  };

  // ------------------------------------------------------------ input ----

  const point = useCallback(
    (event: MouseEvent | WheelEvent) => {
      const box = screen.current?.getBoundingClientRect();
      if (!box) return { x: 0, y: 0 };
      return toPagePoint({ x: event.clientX, y: event.clientY }, box, page);
    },
    [page.width, page.height], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const button = (event: MouseEvent): 'left' | 'middle' | 'right' =>
    event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left';

  const onMouseDown = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    event.currentTarget.parentElement?.focus();
    queue.push({ type: 'down', ...point(event), button: button(event), clickCount: Math.min(3, event.detail || 1) });
  };
  const onMouseUp = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    queue.push({ type: 'up', ...point(event), button: button(event), clickCount: Math.min(3, event.detail || 1) });
  };
  const onMouseMove = (event: MouseEvent<HTMLImageElement>) => {
    queue.push({ type: 'move', ...point(event) });
  };
  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    // Lines and pages are the browser's own units; pixels are what the
    // page scrolls by.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.height : 1;
    queue.push({ type: 'wheel', ...point(event), dx: Math.round(event.deltaX * unit), dy: Math.round(event.deltaY * unit) });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (stage !== 'open') return;
    // Paste is handled as text, below; the browser's shortcut must fire.
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

  const navigate = (value: string) => {
    const url = siteFromInput(value);
    if (!url) {
      setProblem('That is not an https address.');
      return;
    }
    setProblem(null);
    queue.push({ type: 'navigate', url });
  };

  // ------------------------------------------------------------ views ----

  if (!access) return null;

  const browse = access.browse ?? { available: false, reason: access.reason };
  if (!browse.available) {
    return (
      <div className="mini-browser">
        <div className="mini-browser-head">
          <span className="mini-browser-title">Browse to the paper</span>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the browser">
            <CloseIcon size={16} />
          </button>
        </div>
        <p className="banner warn" style={{ margin: 16 }}>
          A browser inside the reader — to go to {signIn?.host || 'the publisher'}, sign in through your institution, and
          bring the PDF back here — needs the proxy to have a Chromium of its own, and this one has none.{' '}
          {browse.reason} No screen is needed: <span className="mono">npm start</span> in the reader repository on any
          machine with Playwright's Chromium installed, then that address under Settings → Paper proxy.
        </p>
      </div>
    );
  }

  if (stage === 'choose' || stage === 'opening') {
    return (
      <div className="mini-browser">
        <div className="mini-browser-head">
          <span className="mini-browser-title">Browse to the paper</span>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the browser">
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="mini-browser-choose">
          <p className="lede">
            Pick where to go. It opens in the proxy&rsquo;s own browser, shown here; sign in there through your
            institution the way you would in any browser. The moment it meets the PDF the paper opens on it, and the
            sign-in is kept on the proxy for the next paper.
          </p>
          <ul className="site-list">
            {sites.map((site: BrowseSite) => (
              <li key={site.host}>
                <button type="button" className="site" disabled={stage === 'opening'} onClick={() => void open(site.url)}>
                  <span className="site-name">
                    {site.label}
                    {site.walled ? <span className="tag">sign-in</span> : null}
                  </span>
                  <span className="site-note">{site.note}</span>
                  <span className="site-url mono">{site.url.replace(/^https:\/\//, '')}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="field site-custom"
            onSubmit={(event) => {
              event.preventDefault();
              const url = siteFromInput(custom);
              if (url) void open(url);
              else setProblem('That is not an https address.');
            }}
          >
            <input
              type="text"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="or another site — your library's portal, a mirror, anything https"
              aria-label="Another site to open"
              disabled={stage === 'opening'}
            />
            <button type="submit" className="btn sm" disabled={stage === 'opening' || !custom.trim()}>
              Open
            </button>
          </form>
          {stage === 'opening' ? (
            <p className="mini-browser-note">
              <span className="spinner" /> Opening the proxy&rsquo;s browser…
            </p>
          ) : null}
          {problem ? <p className="banner error">{problem}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mini-browser${focused ? ' is-focused' : ''}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className="mini-browser-head">
        <button type="button" className="icon-btn sm" onClick={() => queue.push({ type: 'back' })} aria-label="Back" title="Back">
          <ArrowLeftIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => queue.push({ type: 'forward' })}
          aria-label="Forward"
          title="Forward"
          style={{ transform: 'scaleX(-1)' }}
        >
          <ArrowLeftIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => queue.push({ type: 'reload' })}
          aria-label="Reload"
          title="Reload"
          style={{ fontSize: 15 }}
        >
          ↻
        </button>
        <form
          className="field mini-browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          {status?.loading ? <span className="spinner" /> : null}
          <input
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
            onPaste={(event) => event.stopPropagation()}
            aria-label="Address"
            spellCheck={false}
          />
        </form>
        <button
          type="button"
          className="btn sm primary"
          disabled={grabbing || stage === 'collecting'}
          onClick={() => void grab()}
          title="Find the PDF from the page the browser is on, with its sign-in"
        >
          {grabbing ? <span className="spinner" /> : null} Fetch the PDF from this page
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => void close(true)}
          title="Close the browser and try every copy of the paper again, through the sign-in just made"
        >
          Signed in — try the copies again
        </button>
        <button type="button" className="icon-btn sm" onClick={() => void close(false)} aria-label="Close the browser">
          <CloseIcon size={16} />
        </button>
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
        ) : (
          <p className="mini-browser-note">
            <span className="spinner" /> Waiting for the first picture of the page…
          </p>
        )}
      </div>

      <p className="mini-browser-status">
        {stage === 'collecting' ? (
          <>
            <span className="spinner" /> The PDF arrived — opening it here.
          </>
        ) : problem ? (
          problem
        ) : focused ? (
          <>
            Keys go to the page. {status?.title ? <em>{status.title}</em> : null}
            {status?.url && !/^https:/.test(status.url) ? ' · the page could not be loaded' : ''}
          </>
        ) : (
          'Click the page to type into it. Sign in as you would anywhere; when the PDF opens it comes here on its own.'
        )}
      </p>
      {sites.length > 1 && stage !== 'collecting' ? (
        <div className="mini-browser-sites">
          {sites.map((site) => (
            <button
              key={site.host}
              type="button"
              className="chip"
              aria-pressed={Boolean(status?.url && new URL(status.url).hostname.replace(/^www\./, '') === site.host)}
              onClick={() => navigate(site.url)}
              title={site.note}
            >
              {site.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
