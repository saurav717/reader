/**
 * A browser inside the reader: the proxy's Chromium, driven from the page.
 *
 * The sign-in in server/access.js opens a window on the proxy's own screen,
 * which is the right thing when the proxy is on the machine in front of the
 * person and no use at all when it is not — a server, a container, a laptop
 * in another room. This is the other way round: the same profile, headless,
 * with what it shows streamed into the reader's PDF pane as pictures and
 * what the person does there — clicks, keys, scrolling — sent back. To the
 * person it is a small browser in the place the paper would be, at whichever
 * site they picked; to the publisher it is one more Chromium signing in; to
 * the rest of the proxy it is the profile `fetchWithSession` reads cookies
 * from, so a sign-in made here holds for the next paper too.
 *
 * The frames come from Chromium's own screencast (CDP `Page.startScreencast`),
 * which sends a JPEG only when something on the page has changed, and the
 * app fetches them by long-polling `/browse/frame`: one request that waits
 * until there is a newer frame or something else has changed — the URL, the
 * title, a PDF arriving — so an idle page costs one held connection and no
 * traffic. Input goes the other way as small POSTs, in order.
 *
 * A PDF is taken the moment the browser meets one. Headless Chromium does
 * not show PDFs, it downloads them, so a link to a file, or a publisher
 * that sends the file once signed in, lands as a download and is kept in
 * memory; `/browse/pdf` serves it and the app opens it. For a landing page
 * that only links the file — most of them — `grab()` walks from the page
 * being looked at to the file the way the signed-in retry does, with this
 * browser's cookies.
 *
 * One session at a time, closed by the app or after a few minutes with no
 * one watching; Node only, like the rest of what needs a browser.
 */
import { readFile } from 'node:fs/promises';
import {
  browseAvailability,
  ensureContext,
  fetchFileThrough,
  isPdf,
  pdfCandidates,
  pdfLinksIn,
  signInWindowOpen,
} from './access.js';
import { isPrivateHost, MAX_PDF_BYTES, rejectUrl } from './fetchPdf.js';
import { acceptKey, BUTTONS, challengedHost, checkAfter, clamp, clicks, closedError, fetchFileInPage, isMainDocument, VIEWPORT } from './browseShared.js';

export { acceptKey, VIEWPORT };
/** How long a frame poll waits before answering with nothing new. */
const POLL_MS = 8_000;
/** Close a session nobody has polled for this long: the tab was shut without saying. */
const IDLE_MS = 5 * 60_000;

/** The one session, or null. */
let session = null;
let frameSeq = 0;

/** Whoever is waiting on `waitForChange`, resolved on any change. */
const waiters = new Set();
function wake() {
  for (const resolve of waiters) resolve();
  waiters.clear();
}


/** Whether the page is still there to be driven. */
const live = () => Boolean(session && !session.page.isClosed());

/**
 * What the app is told: whether anything is open, where it is, how many
 * frames there have been, and whether a PDF has been caught. The frame
 * itself rides along only when it is newer than the one the app has.
 */
export async function status(after = -1) {
  const ready = await browseAvailability();
  if (!live()) {
    return { ...ready, open: false, seq: frameSeq, persistent: true, pdf: session?.pdf ? { from: session.pdf.from, size: session.pdf.bytes.length } : null };
  }
  const { frame } = session;
  return {
    ...ready,
    open: true,
    /** A sign-in made here is kept in the profile, for the next paper. */
    persistent: true,
    url: session.url,
    title: session.title,
    seq: frameSeq,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    loading: session.loading,
    frame: frame && frame.seq > after ? frame.data : undefined,
    pdf: session.pdf ? { from: session.pdf.from, size: session.pdf.bytes.length } : null,
    /** The site's check for a person, when that is what the page is, and whether it came back after being answered. */
    check: session.check,
  };
}

/**
 * `status()`, once something has changed since the frame the app has — or
 * after `POLL_MS`, whichever comes first. This is what `/browse/frame` waits
 * on, so a page nobody is doing anything to costs nothing.
 */
export async function waitForChange(after, ms = POLL_MS) {
  touch();
  const changedSince = () => !live() || frameSeq > after || session.changed > after;
  if (!changedSince()) {
    await new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
    });
  }
  return status(after);
}

/** Someone is watching: push the idle close back. */
function touch() {
  if (!session) return;
  session.lastSeen = Date.now();
  clearTimeout(session.idle);
  session.idle = setTimeout(() => {
    if (session && Date.now() - session.lastSeen >= IDLE_MS) void close();
  }, IDLE_MS + 500);
  session.idle.unref?.();
}

/** Note a change the frame counter does not cover — the URL, the title, a PDF. */
function changed() {
  if (session) session.changed = ++frameSeq;
  wake();
}

/**
 * Open the browser at a site. Only https, and never at a private address:
 * the app hands over the site the person chose, and a page on another site
 * could hand in anything — which is also why the route only answers POSTs
 * from this app. A session already open is replaced.
 */
export async function open(url) {
  const reason = rejectUrl(url);
  if (reason) throw new Error(reason);
  const ready = await browseAvailability();
  if (!ready.available) throw new Error(ready.reason);

  await close();
  // The profile can be open once; the sign-in window, if it is up, keeps its
  // mode and this page opens beside it — headless otherwise.
  const ctx = await ensureContext(signInWindowOpen() ? 'headed' : 'headless');
  const page = await ctx.newPage();
  session = {
    page,
    root: page,
    cdp: null,
    frame: null,
    url,
    title: '',
    loading: true,
    changed: 0,
    pdf: null,
    check: null,
    /** Whether the person has done something to the page since it last arrived — the box ticked, say. */
    acted: false,
    lastSeen: Date.now(),
    idle: null,
  };
  touch();
  await attach(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {
    // A slow or refused page is still a page the person can see and act on.
  });
  if (session?.page === page) {
    session.loading = false;
    changed();
  }
  return status();
}

/**
 * Point the screencast and the listeners at a page: the one opened, or a
 * pop-up it spawned — some sign-ins open their institution's page in one,
 * and headless Chromium would otherwise show the person nothing while the
 * pop-up waits for them. When a pop-up closes, the page that opened it
 * comes back.
 */
async function attach(page) {
  const mine = session;
  if (!mine) return;
  if (mine.cdp) {
    await mine.cdp.send('Page.stopScreencast').catch(() => undefined);
    await mine.cdp.detach().catch(() => undefined);
    mine.cdp = null;
  }
  mine.page = page;
  await page.setViewportSize(VIEWPORT).catch(() => undefined);

  if (!page.__readerAttached) {
    page.__readerAttached = true;
    // Never inside the proxy's own network, whatever a page links to.
    await page.route('**/*', (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        // not a URL the browser will fetch anyway
      }
      return isPrivateHost(host) ? route.abort('blockedbyclient') : route.continue();
    });
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => undefined));
    page.on('framenavigated', (frame) => {
      if (session?.page !== page || frame !== page.mainFrame()) return;
      session.url = frame.url();
      page
        .title()
        .then((title) => {
          if (session?.page === page) {
            session.title = title;
            changed();
          }
        })
        .catch(() => undefined);
      changed();
    });
    page.on('load', () => {
      if (session?.page === page) {
        session.loading = false;
        changed();
      }
    });
    // The page itself arriving — as the site's check for a person, or as
    // the site — says whether the check is on, and whether it came back
    // after the person answered it (see `checkAfter`). Only the page: the
    // check's own widget is a frame from Cloudflare's domain.
    page.on('response', (response) => {
      if (session?.page !== page || !isMainDocument(response, page)) return;
      const host = challengedHost(response);
      const next = host ? checkAfter(session.check, host, session.acted) : null;
      session.acted = false;
      if (JSON.stringify(next) === JSON.stringify(session.check)) return;
      session.check = next;
      changed();
    });
    // A file, arriving as a download: headless Chromium has no PDF viewer.
    page.on('download', (download) => {
      void (async () => {
        try {
          const path = await download.path();
          if (!path) return;
          const bytes = await readFile(path);
          await caught(bytes, download.url());
        } catch {
          // Not a file we could read; the person can try another link.
        } finally {
          download.delete().catch(() => undefined);
        }
      })();
    });
    // Or as a response, where the browser rendered it in its own viewer
    // instead. The body is not always readable from there — a viewer takes
    // it over — so when it is not, the same URL is asked for again with
    // this browser's cookies, which for a file just served is the same file.
    page.on('response', (response) => {
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (!type.includes('application/pdf') || !response.ok()) return;
      if (!['document', 'other'].includes(response.request().resourceType())) return;
      void (async () => {
        let bytes = null;
        try {
          bytes = await response.body();
        } catch {
          // Taken over by the viewer; asked for again below.
        }
        if (!bytes || !isPdf(bytes)) {
          // What comes back from a viewer is the viewer's own page.
          bytes = await fetchFileThrough(page.context(), [response.url()]).catch(() => null);
        }
        if (bytes) await caught(bytes, response.url());
      })();
    });
    page.on('popup', (popup) => {
      if (session?.root !== page && session?.page !== page) return;
      void attach(popup);
      popup.once('close', () => {
        if (session && session.page === popup && !page.isClosed()) void attach(page);
      });
    });
    page.once('close', () => {
      // Closed from outside — the sign-in window taking the profile over, a
      // crash. The session stays, not live, so a PDF it caught can still be
      // collected; the next `open` replaces it.
      if (session?.root === page) {
        clearTimeout(session.idle);
        wake();
      }
    });
  }

  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return; // Not Chromium; the person gets no picture, and the status says loading.
  }
  mine.cdp = cdp;
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    if (session?.cdp === cdp) {
      session.frame = { seq: ++frameSeq, data };
      wake();
    }
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp
    .send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    })
    .catch(() => undefined);
  changed();
}

/** A PDF has arrived, from a download or a response: keep it, and say so. */
async function caught(bytes, from) {
  if (!session || !bytes || bytes.length > MAX_PDF_BYTES || !isPdf(bytes)) return;
  session.pdf = { bytes, from };
  changed();
}

/**
 * Something the person did in the picture, done to the page. Coordinates are
 * in the page's own pixels — the app scales from the picture it shows — and
 * keys are the DOM's names, which Playwright shares. Anything that is not
 * one of these shapes is refused rather than guessed at.
 */
export async function input(event) {
  if (!live()) throw closedError();
  touch();
  const { page } = session;
  // A click or a key is the person answering the page — the box ticked, say
  // — which is what tells a check that comes back after it from a check.
  if (event.type === 'down' || event.type === 'keydown') session.acted = true;
  const x = clamp(event.x, VIEWPORT.width);
  const y = clamp(event.y, VIEWPORT.height);
  const button = BUTTONS.has(event.button) ? event.button : 'left';
  switch (event.type) {
    case 'move':
      return page.mouse.move(x, y);
    case 'down':
      await page.mouse.move(x, y);
      return page.mouse.down({ button, clickCount: clicks(event.clickCount) });
    case 'up':
      return page.mouse.up({ button, clickCount: clicks(event.clickCount) });
    case 'wheel':
      await page.mouse.move(x, y);
      return page.mouse.wheel(clamp(event.dx, 2000) * Math.sign(Number(event.dx) || 0), clamp(event.dy, 2000) * Math.sign(Number(event.dy) || 0));
    case 'keydown':
      if (!acceptKey(event.key)) return undefined;
      return page.keyboard.down(event.key).catch(() => undefined);
    case 'keyup':
      if (!acceptKey(event.key)) return undefined;
      return page.keyboard.up(event.key).catch(() => undefined);
    case 'insert':
      if (typeof event.text !== 'string' || !event.text || event.text.length > 10_000) return undefined;
      return page.keyboard.insertText(event.text);
    case 'navigate': {
      const target = String(event.url || '').trim();
      const reason = rejectUrl(target);
      if (reason) throw new Error(reason);
      session.loading = true;
      changed();
      return page.goto(target, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    }
    case 'back':
      return page.goBack({ waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    case 'forward':
      return page.goForward({ waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    case 'reload':
      session.loading = true;
      changed();
      return page.reload({ waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    default:
      throw new Error(`unknown input: ${String(event.type)}`);
  }
}

/**
 * The PDF for the page the person is on. The one already caught, if the
 * browser has met a file; otherwise the page is walked to its file the way
 * the signed-in retry walks a landing page — its `citation_pdf_url`, IEEE's
 * stamp endpoints — with the links the page itself shows once rendered, and
 * with this browser's cookies. Throws, worded for the person, when neither
 * gives a file.
 */
export async function grab() {
  if (!live()) throw closedError();
  touch();
  if (session.pdf) return { from: session.pdf.from, size: session.pdf.bytes.length };
  const { page } = session;
  const url = page.url();
  if (rejectUrl(url)) throw new Error('the page the browser is on is not one a PDF can be fetched from');
  let html = '';
  try {
    html = await page.content();
  } catch {
    // Mid-navigation; the candidates from the URL alone are still worth a try.
  }
  const urls = [...pdfCandidates(url), ...pdfLinksIn(html, url), url];
  // The page fetches first, with the standing it has — a bot check passed
  // binds its clearance to this page's user-agent, which the profile's own
  // requests do not share — and the profile's fetch follows the links after.
  const bytes = (await fetchFileInPage(page, urls, MAX_PDF_BYTES)) || (await fetchFileThrough(page.context(), urls));
  if (!bytes) {
    throw new Error(
      `no PDF was found from ${new URL(url).hostname} — open the file itself in the browser here, or sign in first if the page is asking for it`,
    );
  }
  session.pdf = { bytes, from: url };
  changed();
  return { from: url, size: bytes.length };
}

/** The bytes of the PDF caught or grabbed, or null. Kept until the session is closed. */
export function pdfBytes() {
  return session?.pdf?.bytes ?? null;
}

/** Close the page. The profile stays open for the fetches, as after a sign-in. */
export async function close() {
  const open = session;
  session = null;
  if (!open) return { open: false };
  clearTimeout(open.idle);
  if (open.cdp) {
    await open.cdp.send('Page.stopScreencast').catch(() => undefined);
    await open.cdp.detach().catch(() => undefined);
  }
  for (const page of new Set([open.page, open.root])) {
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
  }
  wake();
  return { open: false };
}
