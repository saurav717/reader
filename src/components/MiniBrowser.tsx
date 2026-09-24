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
  botCheck,
  BrowseError,
  browseSites,
  closeBrowser,
  collectPdf,
  endlessCheck,
  grabPdf,
  InputQueue,
  keyName,
  nextFrame,
  openStream,
  openBrowser,
  openReviewPdfUrl,
  proxyPdf,
  siteFromInput,
  toPagePoint,
  type BrowseSite,
  type BrowseStatus,
} from '../lib/browse';
import { pdfFileName, type SignInOffer } from '../lib/pdf';
import { googleBooksDownload, googleBooksIdFromLink, googleBooksNoPdf, googleVolume } from '../lib/books';
import type { PaperLocation, PaperRef } from '../types';
import { ArrowLeftIcon, CloseIcon } from './icons';
import PdfDropIn from './PdfDropIn';

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
  /** A PDF handed over by hand, for when no browser of the proxy's will get it. */
  onFile?: (blob: Blob) => void;
}

type Stage = 'choose' | 'opening' | 'open' | 'collecting' | 'stuck';

/**
 * OpenReview's check going round with no way out (`endlessCheck`), after
 * the pane closed the browser: the page it was on, the file that page
 * stands for, and how asking OpenReview's API for that file is going.
 */
interface Stuck {
  page: string;
  file: string | null;
  asking: boolean;
  error?: string;
}

/**
 * The file an OpenReview page stands for, when the page is its check or
 * the file itself — what was asked for is then the paper. A forum page is
 * left to "Fetch the PDF from this page", since it may be another paper's.
 */
/** The Google Books volume a page in the pane is, if it is one. */
function googleBooksVolume(pageUrl: string | null | undefined): string | null {
  try {
    return googleBooksIdFromLink(new URL(pageUrl || ''));
  } catch {
    return null;
  }
}

function openReviewFile(pageUrl: string | null | undefined): string | null {
  try {
    const path = new URL(pageUrl || '').pathname.replace(/\/+$/, '').toLowerCase();
    if (!['/challenge', '/pdf', '/attachment'].includes(path)) return null;
  } catch {
    return null;
  }
  return openReviewPdfUrl(pageUrl);
}

/**
 * What OpenReview's API said, for after "would not hand over the file
 * either —": the proxy's own words already begin that way.
 */
function apiSaid(error: unknown): string {
  const said = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '');
  const inner = said.match(/^OpenReview['’]s API would not hand over the file \((.*)\)(.*)$/s);
  return inner ? `${inner[1]}${inner[2]}` : said;
}

/**
 * A try the pane will make on its own, once Cloudflare will allow another
 * browser: where to, when, and how many such tries came before it — a
 * refusal that names a wait is counted down and tried again, a few times,
 * before it is left to the person.
 */
interface Retry {
  url: string;
  at: number;
  attempt: number;
  /** What the proxy said, for the line under the countdown: which limit, and Cloudflare's own words. */
  why: string;
}

/** How many times the pane tries again on its own before leaving it to the person. */
const AUTOMATIC_RETRIES = 2;
/** The longest wait the pane counts down on its own; a longer one — the day's browser time — is the person's to wait. */
const LONGEST_COUNTDOWN_S = 120;

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
 * It needs a proxy with a browser to drive, and nothing else — no screen,
 * no window, no pop-up: the Node proxy with a Chromium, or the Cloudflare
 * Worker with Browser Rendering bound. A proxy with neither says so here.
 */
export default function MiniBrowser({ paper, locations, signIn, onPdf, onRetry, onClose, onFile }: Props) {
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [stage, setStage] = useState<Stage>('choose');
  const [status, setStatus] = useState<BrowseStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [custom, setCustom] = useState('');
  const [focused, setFocused] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  /** The try the pane will make on its own, when Cloudflare said how long to wait; and the clock it counts down by. */
  const [retry, setRetry] = useState<Retry | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The last site asked for, for "Try again" after a refusal. */
  const lastUrl = useRef<string | null>(null);

  const screen = useRef<HTMLImageElement>(null);
  const polling = useRef<AbortController | null>(null);
  /** Whether the address is being typed, in which case the page's own URL must not overwrite it. */
  const editingAddress = useRef(false);
  const collected = useRef(false);
  /** The OpenReview files asked of its API, by file, so a page shown again is not asked twice. */
  const askedOpenReview = useRef(new Map<string, Promise<Blob>>());
  const [stuck, setStuck] = useState<Stuck | null>(null);
  const queue = useMemo(() => new InputQueue((error) => setProblem(error.message)), []);

  const sites = useMemo(() => browseSites(paper, locations, signIn), [paper, locations, signIn]);
  const page = { width: status?.width || 1280, height: status?.height || 800 };
  /** The site's check for a person, when that is what the page is; the box to tick is theirs. */
  const check = stage === 'open' ? botCheck(status) : null;

  /** OpenReview's API asked for a file, once however many pages stand for it. */
  const askOpenReview = (file: string): Promise<Blob> => {
    let asked = askedOpenReview.current.get(file);
    if (!asked) {
      asked = proxyPdf(file, pdfFileName(paper));
      askedOpenReview.current.set(file, asked);
    }
    return asked;
  };

  // With the browser closed on OpenReview's check, the file is had from
  // OpenReview's API, or the pane says why not and what is left.
  useEffect(() => {
    if (stage !== 'stuck' || !stuck?.file || !stuck.asking) return;
    let live = true;
    const file = stuck.file;
    askOpenReview(file).then(
      (blob) => {
        if (!live || collected.current) return;
        collected.current = true;
        setStage('collecting');
        onPdf(blob, file);
      },
      (error: unknown) => {
        if (!live) return;
        setStuck((now) => (now && now.file === file ? { ...now, asking: false, error: apiSaid(error) } : now));
      },
    );
    return () => {
      live = false;
    };
    // `askOpenReview` and `onPdf` are the same ask whenever they are called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, stuck?.file, stuck?.asking]);

  useEffect(() => {
    let live = true;
    accessAvailable().then((answer) => {
      if (live) setAccess(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  // The frames: over a stream where the proxy has one (the Worker), each
  // pushed the moment it is painted, with input going back over the same
  // socket; else one request held by the proxy until something changes,
  // then the next. Stops with the component, and closes the browser with it.
  useEffect(() => {
    if (stage !== 'open') return;
    const controller = new AbortController();
    polling.current = controller;
    let after = -1;
    let misses = 0;
    let done = false;
    // What a status means, whichever way it came. True once the pane is
    // finished with the browser: closed, or the PDF collected.
    const take = async (next: BrowseStatus): Promise<boolean> => {
      if (controller.signal.aborted || done) return true;
      after = Math.max(after, next.seq);
      setStatus(next);
      if (next.frame) setFrame(next.frame);
      // The address follows the page — a sign-in bounces through several
      // — unless it is being typed into.
      if (next.url && /^https?:/.test(next.url) && !editingAddress.current) setAddress(next.url);
      // OpenReview's check, or its file, which it answers with the check:
      // the proxy asks OpenReview's API for it instead, which has none, so
      // nobody is left ticking a box the proxy's browser may never pass.
      const direct = openReviewFile(next.url);
      // The check going round — the box says it passed, the page sends the
      // browser back to it — is stopped, not watched: the browser is closed,
      // since every turn spends browser time and none gets closer, and the
      // pane says what is being done instead.
      if (endlessCheck(next) && !collected.current && next.url) {
        done = true;
        setStuck({ page: next.url, file: direct, asking: Boolean(direct) });
        setStage('stuck');
        void closeBrowser();
        return true;
      }
      if (direct && !askedOpenReview.current.has(direct) && !collected.current) {
        void (async () => {
          try {
            const blob = await askOpenReview(direct);
            if (collected.current || controller.signal.aborted) return;
            collected.current = true;
            done = true;
            setStage('collecting');
            await closeBrowser();
            onPdf(blob, direct);
          } catch (error) {
            if (!collected.current && !controller.signal.aborted) {
              setProblem(`OpenReview's API would not hand over the file either — ${apiSaid(error)}. Open it in a tab of your own and drop it on the paper instead.`);
            }
          }
        })();
      }
      if (!next.open && !next.pdf) {
        done = true;
        setProblem(next.ended || 'The browser closed on the proxy.');
        setStage('choose');
        return true;
      }
      if (next.pdf && !collected.current) {
        collected.current = true;
        done = true;
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
            setProblem(error instanceof Error ? error.message : String(error));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * misses));
          continue;
        }
        if (await take(next)) return;
      }
    };
    const stream = openStream({
      onStatus: (next) => void take(next),
      // Refused (a proxy without one), or gone mid-page: polling carries on from here.
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

  // Leaving the reader mid-browse closes the page on the proxy too.
  useEffect(
    () => () => {
      polling.current?.abort();
      void closeBrowser();
    },
    [],
  );

  const open = async (url: string, attempt = 0) => {
    setProblem(null);
    setRetry(null);
    setStage('opening');
    setFrame(null);
    setStuck(null);
    collected.current = false;
    lastUrl.current = url;
    try {
      const opened = await openBrowser(url);
      setStatus(opened);
      setAddress(opened.url || url);
      if (opened.frame) setFrame(opened.frame);
      setStage('open');
    } catch (error) {
      setStage('choose');
      // Cloudflare rationing browsers, with a time: counted down here and
      // tried again then, without the person having to — a few times, in
      // case the next try is refused too, and then it is theirs.
      const wait = error instanceof BrowseError && error.rateLimited ? error.retryAfter : null;
      if (wait && wait <= LONGEST_COUNTDOWN_S && attempt < AUTOMATIC_RETRIES) {
        setRetry({ url, at: Date.now() + wait * 1000, attempt: attempt + 1, why: error instanceof Error ? error.message : String(error) });
        setNow(Date.now());
        return;
      }
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  // The countdown to a try the pane makes on its own: a tick a second for
  // the number shown, and the try itself when the time comes.
  useEffect(() => {
    if (!retry) return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= retry.at) void open(retry.url, retry.attempt);
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
    // `open` only sets state; the try is what `retry` describes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  const grab = async () => {
    if (grabbing || collected.current) return;
    setGrabbing(true);
    setProblem(null);
    try {
      const blob = await grabPdf(pdfFileName(paper));
      collected.current = true;
      polling.current?.abort();
      await closeBrowser();
      onPdf(blob, status?.url || '');
    } catch (error) {
      // An OpenReview page the browser could not get the file from — its
      // check stands in front of it — is asked of OpenReview's API instead.
      const direct = openReviewPdfUrl(status?.url);
      if (direct) {
        try {
          const blob = await askOpenReview(direct);
          collected.current = true;
          polling.current?.abort();
          await closeBrowser();
          onPdf(blob, direct);
          return;
        } catch {
          // Say what the page said.
        }
      }
      // A Google Books page is asked about from here, not from the proxy:
      // what Google lets a person see and download depends on the country
      // they are in, and the proxy's browser is somewhere else. A book it
      // lets you download is fetched by its link; one it does not is said so.
      const volumeId = googleBooksVolume(status?.url);
      if (volumeId) {
        try {
          const volume = await googleVolume(volumeId);
          const download = googleBooksDownload(volume);
          if (download) {
            const blob = await proxyPdf(download, pdfFileName(paper));
            collected.current = true;
            polling.current?.abort();
            await closeBrowser();
            onPdf(blob, download);
            return;
          }
          const why = googleBooksNoPdf(volume);
          if (why) {
            setProblem(why);
            return;
          }
        } catch {
          // Say what the proxy said.
        }
      }
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
          bring the PDF back here — needs the proxy to have a browser to drive, and this one has none. {browse.reason}{' '}
          Either way no screen is needed: the Cloudflare Worker with its browser binding, or{' '}
          <span className="mono">npm start</span> in the reader repository on any machine with Playwright's Chromium,
          pointed at from Settings → Paper proxy.
        </p>
      </div>
    );
  }

  if (stuck && (stage === 'stuck' || stage === 'collecting')) {
    let host = 'the site';
    try {
      host = new URL(stuck.page).hostname.replace(/^www\./, '');
    } catch {
      // Said without it.
    }
    const where = status?.where ?? (status?.session ? 'cloudflare' : 'proxy');
    const why =
      where === 'cloudflare'
        ? `Its box says it passed, and then ${host} sends the browser back to it — from this browser, which is Cloudflare's own, it always will: Cloudflare tells the sites it protects that its rendering browsers are bots.`
        : `Its box says it passed, and then ${host} sends the browser back to it — it has come ${status?.check?.times ?? 'several'} times running.`;
    return (
      <div className="mini-browser">
        <div className="mini-browser-head">
          <span className="mini-browser-title">{host} keeps sending the browser back to its check</span>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the browser">
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="mini-browser-choose">
          <p className="lede">
            {host} answered with its check, <em>Verifying your browser</em>, and would not let the page through. {why}{' '}
            So the proxy&rsquo;s browser has been closed rather than left going round, spending browser time.
          </p>
          {stage === 'collecting' ? (
            <p className="mini-browser-note">
              <span className="spinner" /> The PDF arrived from OpenReview&rsquo;s API — opening it here.
            </p>
          ) : stuck.asking ? (
            <p className="mini-browser-note">
              <span className="spinner" /> Asking OpenReview&rsquo;s API for the file instead, which has no box to tick…
            </p>
          ) : stuck.file ? (
            <p className="banner error">
              OpenReview&rsquo;s API would not hand over the file either — {stuck.error}.{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  if (stuck.file) askedOpenReview.current.delete(stuck.file);
                  setStuck({ ...stuck, asking: true, error: undefined });
                }}
              >
                Ask the API again
              </button>
            </p>
          ) : null}
          {stage === 'stuck' && !stuck.asking ? (
            <p className="banner warn">
              Your own browser passes the check.
              {onFile ? (
                <PdfDropIn host={host} url={stuck.file || stuck.page} onFile={(blob) => onFile(blob)} />
              ) : (
                <>
                  {' '}
                  <a href={stuck.file || stuck.page} target="_blank" rel="noreferrer noopener">
                    Open it at {host} in a tab of your own
                  </a>
                  , download the PDF, and drop it on the paper.
                </>
              )}{' '}
              {where === 'cloudflare' ? null : (
                <>
                  <button type="button" className="link-btn" onClick={() => void open(stuck.page)}>
                    Open the page here again
                  </button>
                  {' · '}
                </>
              )}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setStuck(null);
                  setStage('choose');
                }}
              >
                Another site
              </button>
            </p>
          ) : null}
        </div>
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
          {retry ? (
            <p className="mini-browser-note">
              <span className="spinner" />
              <span>
                The proxy could not start another browser just now; the pane will try again in{' '}
                {Math.max(0, Math.ceil((retry.at - now) / 1000))}&nbsp;s.{' '}
                <button type="button" className="link-btn" onClick={() => void open(retry.url, retry.attempt)}>
                  Try now
                </button>
              </span>
            </p>
          ) : null}
          {retry ? <p className="mini-browser-why">{retry.why}</p> : null}
          {problem ? (
            <p className="banner error">
              {problem}
              {lastUrl.current ? (
                <>
                  {' '}
                  <button type="button" className="link-btn" onClick={() => void open(lastUrl.current as string)}>
                    Try again
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
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
            onFocus={(event) => {
              editingAddress.current = true;
              event.target.select();
            }}
            onBlur={() => {
              editingAddress.current = false;
            }}
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
        {status?.persistent !== false ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => void close(true)}
            title="Close the browser and try every copy of the paper again, through the sign-in just made"
          >
            Signed in — try the copies again
          </button>
        ) : null}
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
        ) : check ? (
          <span>
            {check}{' '}
            {status?.url && /^https:/.test(status.url) ? (
              <a href={status.url} target="_blank" rel="noreferrer">
                Open it in a tab of your own
              </a>
            ) : null}
          </span>
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
