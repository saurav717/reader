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
 * next request reconnects to the same browser and carries on. Five minutes
 * with nobody polling closes the browser, through an alarm.
 */
import puppeteer from '@cloudflare/puppeteer';
import { BROWSER_UA } from '../server/scholar.js';
import { rejectUrl } from '../server/fetchPdf.js';
import { pdfCandidates, pdfLinksIn } from '../server/pdfLinks.js';
import { closedError, startsWithPdf, VIEWPORT } from '../server/browseShared.js';
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
/** How long to wait before asking Cloudflare for a new browser a second time, after it said no. */
const RATE_LIMIT_RETRY_MS = 12_000;

/**
 * What a refusal to start a browser means, worded for the person. Cloudflare
 * allows a few new browsers a minute and a few alive at once, and only some
 * minutes of browser time a day on its free plan.
 */
export const RATE_LIMITED =
  'Cloudflare would not start another browser just now: its free plan allows only a few new browsers a minute, a few alive at once, and some minutes of browser time a day. Wait a minute and try again — a browser already open is reused rather than started again — or move the Worker to the Workers Paid plan.';

const rateLimited = (error) => /429|rate limit|too many/i.test(String(error?.message || error));

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
      if (path === '/close') return json({ ok: true, ...(await this.close()) });
      return json({ error: 'not found' }, 404);
    } catch (error) {
      if (error?.code === 'closed') return json({ error: 'no browser is open' }, 409);
      return json({ error: String(error?.message || error) }, path === '/grab' || path === '/pdf' ? 404 : 400);
    }
  }

  /** The alarm: close a browser nobody has looked at for a while. */
  async alarm() {
    if (this.browser && Date.now() - this.lastSeen >= IDLE_MS) await this.close();
    else if (this.browser) await this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  // ------------------------------------------------------------ status ----

  idle() {
    return { ...availability(this.env), open: false, seq: this.seq, pdf: null, persistent: Boolean(this.env.SESSIONS) };
  }

  async status(after) {
    if (!this.browser || !this.page) return this.idle();
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
      // A browser already open is kept and pointed at the new site: starting
      // browsers is the thing Cloudflare rations, so one is started only
      // when there is none to reuse.
      if (!this.browser || !this.page || this.page.isClosed()) {
        await this.forget();
        const { browser, id } = await this.acquire();
        this.token = crypto.randomUUID();
        await this.state.storage.put('session', { token: this.token, id });
        await this.adopt(browser, id);
        await this.page.setUserAgent(BROWSER_UA).catch(() => undefined);
        await restoreCookies(this.env, this.page);
      }
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
   * for twice with a pause between when Cloudflare says it has handed out
   * enough for the minute.
   */
  async acquire() {
    const kept = await this.state.storage.get('session').catch(() => null);
    const tried = new Set();
    const candidates = [];
    if (kept?.id) candidates.push(kept.id);
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
    try {
      const browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
      return { browser, id: browser.sessionId() };
    } catch (error) {
      if (!rateLimited(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
    try {
      const browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
      return { browser, id: browser.sessionId() };
    } catch (error) {
      throw new Error(rateLimited(error) ? RATE_LIMITED : String(error?.message || error));
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
      const bytes = await fetchFileWithCookies(page, [this.pdf.from]);
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
    const bytes = await fetchFileWithCookies(page, [...pdfCandidates(url), ...pdfLinksIn(html, url), url]);
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
