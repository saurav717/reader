/**
 * The browser inside the reader, from the Worker, held open: a Durable
 * Object that keeps one connection to Cloudflare's browser for as long as
 * the session lasts.
 *
 * worker/browse.js drives the same browser statelessly — connect, act,
 * disconnect, on every request — which works but is slow to use: each frame
 * and each click pays for a fresh connection, and Cloudflare lets one
 * connection at a time into a session, so input waits for frames and frames
 * for input. A Durable Object is the one place in a Worker that can hold
 * something between requests, so this holds the browser: connected once,
 * Chrome's own screencast running into memory (a JPEG whenever the page
 * changes), input done straight away on the open connection, and the app's
 * long-poll for frames answered the moment there is something new — the
 * shape of server/browse.js, on Cloudflare.
 *
 * Every request from the Worker reaches the same object (one session at a
 * time, as on the Node proxy). Opening hands the app a token that every
 * request after must carry; the browser session's own id is kept in the
 * object's storage so that, should the object be evicted while idle, the
 * next request reconnects to the same browser and carries on. Two minutes
 * with nobody polling closes the browser, through an alarm.
 *
 * Closing the pane does not close the browser straight away: it is kept,
 * blank, for most of a minute, because the next thing the person does is
 * so often to open the pane again — at another site, or after the copies
 * were tried once more with the sign-in just made — and starting browsers
 * is what Cloudflare rations most tightly (a few a minute on the free
 * plan). A browser kept is one pointed at the new site; a browser closed
 * is one asked for again, and refused.
 */
import puppeteer from '@cloudflare/puppeteer';
import { MAX_PDF_BYTES, rejectUrl } from '../server/fetchPdf.js';
import { pdfCandidates, pdfLinksIn } from '../server/pdfLinks.js';
import { closedError, fetchFileInPage, startsWithPdf, VIEWPORT } from '../server/browseShared.js';
import {
  apply,
  availability,
  fetchFileWithCookies,
  KEEP_ALIVE_MS,
  NAVIGATION_TIMEOUT_MS,
  NO_BROWSER,
  restoreCookies,
  saveCookies,
} from './browse.js';

/** How long a frame poll waits before answering with nothing new. */
const POLL_MS = 8_000;
/**
 * Close a session nobody has polled for this long. Short, because browser
 * time is what Cloudflare's free plan rations by the day, and a pane that
 * was closed without saying so should not run the clock for long.
 */
const IDLE_MS = 2 * 60_000;
/**
 * How long a browser is kept after the pane closes, for the next open to
 * reuse. Long enough to cover picking another site or trying the copies
 * again first; short, because every second of it is browser time the free
 * plan counts by the day, and nobody may come back.
 */
const LINGER_MS = 45_000;
/**
 * How long to wait between asking Cloudflare for a new browser again, after
 * it said no, and for how long in all. Its limit is a few new browsers a
 * minute, and a few alive at once for `KEEP_ALIVE_MS` after their last
 * connection, so most refusals clear within the minute; the request is held
 * that long rather than handing the person a refusal to click through.
 */
const RATE_LIMIT_RETRY_MS = 12_000;
const RATE_LIMIT_PATIENCE_MS = 50_000;

/**
 * What a refusal to start a browser means, worded for the person. Cloudflare
 * allows a few new browsers a minute and a few alive at once, and only some
 * minutes of browser time a day on its free plan.
 */
export const RATE_LIMITED =
  'Cloudflare would not start another browser just now, even after most of a minute of asking: its free plan allows only a few new browsers a minute, a few alive at once, and some minutes of browser time a day. Wait a minute and try again — a browser already open is reused rather than started again, and one is kept for most of a minute after the pane closes so that a second try needs none — or move the Worker to the Workers Paid plan.';

export const rateLimited = (error) => /429|rate limit|too many/i.test(String(error?.message || error));

/**
 * The refusal, worded for the person, with Cloudflare's own reason on the
 * end where it gave one — the minute's allowance and the day's are refused
 * with the same status code, and only its words tell them apart.
 */
export function rateLimitedMessage(error) {
  const raw = String(error?.message || error || '');
  const said = (raw.match(/message:\s*(.+)$/s) || [])[1]?.trim().replace(/[.\s]+$/, '');
  return said ? `${RATE_LIMITED} Cloudflare said: ${said}.` : RATE_LIMITED;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export class BrowserSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.browser = null;
    this.page = null;
    this.cdp = null;
    /** The app's token for this session, and Cloudflare's id for the browser. */
    this.token = null;
    this.frame = null;
    this.seq = 0;
    this.changed = 0;
    this.waiters = new Set();
    this.url = '';
    this.title = '';
    this.loading = false;
    /** A PDF the browser met: its bytes where they could be read, else where to fetch it from. */
    this.pdf = null;
    this.lastSeen = 0;
    this.opening = null;
  }

  // ---------------------------------------------------------- requests ----

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/status') return json(await this.status(-1));
      if (path === '/open') return json({ ok: true, ...(await this.open(url.searchParams.get('url') || '')) });

      const token = url.searchParams.get('session') || '';
      const live = await this.ensure(token);
      if (path === '/frame') {
        if (!live) return json(this.idle());
        const after = Number(url.searchParams.get('after'));
        return json(await this.waitForChange(Number.isFinite(after) ? after : -1));
      }
      if (!live) throw closedError();
      if (path === '/input') {
        const body = await request.json().catch(() => ({}));
        const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
        if (events.length > 64) return json({ error: 'too many events at once' }, 400);
        this.touch();
        for (const event of events) await apply(this.page, event || {});
        return json({ ok: true });
      }
      if (path === '/grab' || path === '/pdf') {
        const bytes = await this.grab();
        return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
      }
      if (path === '/close') return json({ ok: true, ...(await this.release()) });
      return json({ error: 'not found' }, 404);
    } catch (error) {
      if (error?.code === 'closed') return json({ error: 'no browser is open' }, 409);
      return json({ error: String(error?.message || error) }, path === '/grab' || path === '/pdf' ? 404 : 400);
    }
  }

  /**
   * The alarm: close a browser nobody has looked at for a while — sooner
   * when the pane was closed and the browser is only being kept in case.
   */
  async alarm() {
    if (!this.browser) return;
    const limit = this.token ? IDLE_MS : LINGER_MS;
    const since = Date.now() - this.lastSeen;
    if (since >= limit) await this.close();
    else await this.state.storage.setAlarm(Date.now() + (limit - since));
  }

  // ------------------------------------------------------------ status ----

  idle() {
    return { ...availability(this.env), open: false, seq: this.seq, pdf: null, persistent: Boolean(this.env.SESSIONS) };
  }

  async status(after) {
    if (!this.browser || !this.page || !this.token) return this.idle();
    return {
      ...availability(this.env),
      open: true,
      session: this.token,
      persistent: Boolean(this.env.SESSIONS),
      url: this.url,
      title: this.title,
      seq: this.seq,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      loading: this.loading,
      frame: this.frame && this.frame.seq > after ? this.frame.data : undefined,
      pdf: this.pdf ? { from: this.pdf.from, size: this.pdf.bytes ? this.pdf.bytes.length : 0 } : null,
    };
  }

  /** `status()`, once something has changed since `after` — or after `POLL_MS`. */
  async waitForChange(after) {
    this.touch();
    const changedSince = () => !this.browser || this.seq > after || this.changed > after;
    if (!changedSince()) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, POLL_MS);
        const waiters = this.waiters;
        function done() {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        }
        waiters.add(done);
      });
    }
    return this.status(after);
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  /** Note a change the frame counter does not cover — the URL, the title, a PDF. */
  bump() {
    this.changed = ++this.seq;
    this.wake();
  }

  touch() {
    this.lastSeen = Date.now();
  }

  // ----------------------------------------------------------- session ----

  /**
   * Whether the token names this session and the browser is there to be
   * driven — reconnecting to it first, if the object was evicted since.
   */
  async ensure(token) {
    if (!token) return false;
    if (!this.token) {
      // Evicted while idle: the token and the browser's id are in storage.
      const kept = await this.state.storage.get('session');
      if (!kept || kept.token !== token) return false;
      this.token = kept.token;
      try {
        const browser = await puppeteer.connect(this.env.BROWSER, kept.id);
        await this.adopt(browser, kept.id);
      } catch {
        await this.forget();
        return false;
      }
    }
    if (this.token !== token) return false;
    if (!this.browser || !this.page) return false;
    return true;
  }

  async open(url) {
    const reason = rejectUrl(url);
    if (reason) throw new Error(reason);
    if (!this.env.BROWSER) throw new Error(NO_BROWSER);
    if (this.opening) await this.opening.catch(() => undefined);
    this.opening = (async () => {
      // A browser already open is kept and pointed at the new site — the one
      // the pane is showing, or the one kept since the pane closed: starting
      // browsers is the thing Cloudflare rations, so one is started only
      // when there is none to reuse.
      if (!this.browser || !this.page || this.page.isClosed()) {
        await this.forget();
        const { browser, id } = await this.acquire();
        await this.adopt(browser, id);
        // No user-agent override: the browser presents itself as what it is,
        // string and client hints agreeing. See `open` in worker/browse.js.
        await restoreCookies(this.env, this.page);
      } else if (!this.cdp) {
        // Kept since the pane closed, with its screencast stopped: started again.
        await this.attach(this.page);
      }
      if (!this.token) {
        this.token = crypto.randomUUID();
        await this.state.storage.put('session', { token: this.token, id: this.id });
      }
      this.touch();
      this.pdf = null;
      this.url = url;
      this.loading = true;
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {
        // A slow or refused page is still a page the person can see and act on.
      });
      this.loading = false;
      // The screencast starts with the first paint after it is asked for; a
      // page already painted may not send one, so the first picture is taken.
      if (!this.frame) {
        try {
          const data = await this.page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });
          this.frame = { seq: ++this.seq, data };
        } catch {
          // The next paint will bring one.
        }
      }
      this.bump();
      await this.state.storage.setAlarm(Date.now() + IDLE_MS);
      return this.status(-1);
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /**
   * A browser to drive, starting one only as the last resort: first the one
   * this object had before it was evicted, then any session of the
   * account's that nothing is connected to — one left by an earlier
   * eviction, or by the stateless fallback — and only then a new one, asked
   * for again every few seconds for most of a minute when Cloudflare says it
   * has handed out enough for the minute, looking between asks for a session
   * that has come free meanwhile.
   */
  async acquire() {
    const kept = await this.state.storage.get('session').catch(() => null);
    const adopt = async (first) => {
      // Tried afresh each pass: a session busy a moment ago may be free now.
      const tried = new Set();
      const candidates = first ? [first] : [];
      try {
        for (const session of await puppeteer.sessions(this.env.BROWSER)) {
          if (!session.connectionId && session.sessionId) candidates.push(session.sessionId);
        }
      } catch {
        // Not knowable; a new one, then.
      }
      for (const id of candidates) {
        if (tried.has(id)) continue;
        tried.add(id);
        try {
          return { browser: await puppeteer.connect(this.env.BROWSER, id), id };
        } catch {
          // Gone, or taken; the next.
        }
      }
      return null;
    };
    const started = Date.now();
    let first = kept?.id || null;
    for (;;) {
      const adopted = await adopt(first);
      if (adopted) return adopted;
      first = null;
      try {
        const browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
        return { browser, id: browser.sessionId() };
      } catch (error) {
        if (!rateLimited(error)) throw error;
        if (Date.now() - started + RATE_LIMIT_RETRY_MS > RATE_LIMIT_PATIENCE_MS) throw new Error(rateLimitedMessage(error));
      }
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
    }
  }

  /** Take a connected browser as this session's, and its page as the one shown. */
  async adopt(browser, id) {
    this.browser = browser;
    this.id = id;
    this.touch();
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        this.browser = null;
        this.page = null;
        this.cdp = null;
        this.wake();
      }
    });
    const pages = await browser.pages();
    const real = pages.filter((page) => page.url() !== 'about:blank');
    const page = real[real.length - 1] || pages[pages.length - 1] || (await browser.newPage());
    await this.attach(page);
  }

  /** Point the screencast and the listeners at a page — the one opened, or a pop-up it spawned. */
  async attach(page) {
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
      this.cdp = null;
    }
    this.page = page;
    this.url = page.url();
    await page.setViewport(VIEWPORT).catch(() => undefined);
    if (!page.__readerAttached) {
      page.__readerAttached = true;
      page.on('dialog', (dialog) => dialog.dismiss().catch(() => undefined));
      page.on('framenavigated', (frame) => {
        if (this.page !== page || frame !== page.mainFrame()) return;
        this.url = frame.url();
        page
          .title()
          .then((title) => {
            if (this.page === page) {
              this.title = title;
              this.bump();
            }
          })
          .catch(() => undefined);
        this.bump();
      });
      page.on('load', () => {
        if (this.page === page) {
          this.loading = false;
          this.bump();
        }
      });
      // A PDF, met: its bytes where the response can be read, else where to
      // fetch it from with the session's cookies when it is collected.
      page.on('response', (response) => {
        const type = (response.headers()['content-type'] || '').toLowerCase();
        if (!type.includes('application/pdf') || !response.ok()) return;
        if (!['document', 'other'].includes(response.request().resourceType())) return;
        const from = response.url();
        if (rejectUrl(from)) return;
        void (async () => {
          let bytes = null;
          try {
            bytes = new Uint8Array(await response.buffer());
          } catch {
            // Taken over by the viewer; fetched with cookies at collection.
          }
          this.pdf = { from, bytes: bytes && startsWithPdf(bytes) ? bytes : null };
          this.bump();
        })();
      });
      page.on('popup', (popup) => {
        void this.attach(popup);
        popup.once('close', () => {
          if (this.page === popup && !page.isClosed()) void this.attach(page);
        });
      });
      page.once('close', () => {
        if (this.page === page) {
          this.page = null;
          this.wake();
        }
      });
    }
    let cdp;
    try {
      cdp = await page.createCDPSession();
    } catch {
      return; // No picture, then; the status says so by never carrying one.
    }
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      if (this.cdp === cdp) {
        this.frame = { seq: ++this.seq, data };
        this.wake();
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
    this.bump();
  }

  /**
   * The PDF: the one met, or the one the page links, fetched with the
   * session's cookies (see worker/browse.js).
   */
  async grab() {
    this.touch();
    if (this.pdf?.bytes) return this.pdf.bytes;
    const page = this.page;
    const url = page.url();
    if (this.pdf?.from) {
      // The page fetches first: a file behind a bot check comes only to the
      // browser that passed it, never to a fetch of the Worker's own.
      const bytes = (await fetchFileInPage(page, [this.pdf.from], MAX_PDF_BYTES)) || (await fetchFileWithCookies(page, [this.pdf.from]));
      if (bytes) {
        this.pdf = { from: this.pdf.from, bytes };
        await saveCookies(this.env, page);
        return bytes;
      }
    }
    if (rejectUrl(url)) throw new Error('the page the browser is on is not one a PDF can be fetched from');
    let html = '';
    try {
      html = await page.content();
    } catch {
      // Mid-navigation; the candidates from the URL alone are still worth a try.
    }
    const urls = [...pdfCandidates(url), ...pdfLinksIn(html, url), url];
    const bytes = (await fetchFileInPage(page, urls, MAX_PDF_BYTES)) || (await fetchFileWithCookies(page, urls));
    if (!bytes) {
      throw new Error(
        `no PDF was found from ${new URL(url).hostname} — open the file itself in the browser here, or sign in first if the page is asking for it`,
      );
    }
    this.pdf = { from: url, bytes };
    await saveCookies(this.env, page);
    this.bump();
    return bytes;
  }

  /**
   * The pane closed: the browser is kept for `LINGER_MS`, blank and with
   * its screencast stopped, for the next open to point somewhere — and
   * nothing the app still holds can reach it, since its token is dropped.
   * The alarm closes it for real if nobody comes back.
   */
  async release() {
    const { browser, page } = this;
    if (!browser || !page || page.isClosed()) return this.close();
    await saveCookies(this.env, page).catch(() => undefined);
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
      this.cdp = null;
    }
    this.token = null;
    this.frame = null;
    this.pdf = null;
    this.url = '';
    this.title = '';
    this.loading = false;
    // The id stays, without a token, so that an object evicted meanwhile
    // still knows which session to adopt first.
    await this.state.storage.put('session', { token: null, id: this.id }).catch(() => undefined);
    // Off the site, so nothing it left running spends the time the browser
    // is kept for; the sign-in's cookies are in the jar, not the page.
    await page.goto('about:blank').catch(() => undefined);
    this.touch();
    await this.state.storage.setAlarm(Date.now() + LINGER_MS).catch(() => undefined);
    this.wake();
    return { open: false };
  }

  /** Close the browser for good: the alarm's way, after a linger or an idle nobody came back from. */
  async close() {
    const browser = this.browser;
    if (browser && this.page) await saveCookies(this.env, this.page).catch(() => undefined);
    await this.forget();
    if (browser) await browser.close().catch(() => undefined);
    return { open: false };
  }

  /** Drop everything about the session, without touching the browser. */
  async forget() {
    if (this.cdp) await this.cdp.detach().catch(() => undefined);
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.token = null;
    this.frame = null;
    this.pdf = null;
    this.url = '';
    this.title = '';
    this.loading = false;
    await this.state.storage.delete('session').catch(() => undefined);
    await this.state.storage.deleteAlarm().catch(() => undefined);
    this.wake();
  }
}
