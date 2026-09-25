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
import { MAX_PDF_BYTES, rejectUrl } from '../server/fetchPdf.js';
import { grabTargets } from '../server/pdfLinks.js';
import { BUTTONS, challengedHost, checkAfter, clamp, clicks, closedError, fetchFileInPage, isMainDocument, startsWithPdf, VIEWPORT } from '../server/browseShared.js';
import {
  apply,
  availability,
  defaultDriver,
  fetchFileWithCookies,
  limitsOf,
  NAVIGATION_TIMEOUT_MS,
  NO_BROWSER,
  forClient,
  restoreCookies,
  saveCookies,
  storedCookies,
} from './browse.js';
import * as browserless from './browserless.js';

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
 * How long a request to open the browser is held while Cloudflare will not
 * start one, rather than handing the person a refusal to click through;
 * and how long to wait between looks when Cloudflare gives no time of its
 * own — when every browser it allows at once is alive and held, a slot
 * comes free only when whoever holds one lets go, which it does not
 * announce. Where it does say how long until another browser may be
 * started, that is what is waited, once, instead of asking for a browser
 * again and again — a refused ask may well count against the minute the
 * way an answered one does, so the old way of asking every few seconds
 * could keep the minute's allowance spent on its own.
 */
export const RATE_LIMIT_PATIENCE_MS = 50_000;
export const RATE_LIMIT_RETRY_MS = 12_000;
/** The least and the most a single wait is, whatever Cloudflare says: a look is cheap, a minute is its window. */
const WAIT_MIN_MS = 2_000;
const WAIT_MAX_MS = 60_000;

/**
 * What a refusal to start a browser means, worded for the person. Cloudflare
 * allows a few new browsers a minute and a few alive at once, and only some
 * minutes of browser time a day on its free plan.
 */
export const RATE_LIMITED =
  'Cloudflare would not start another browser just now: its free plan allows only a few new browsers a minute, a few alive at once, and some minutes of browser time a day. A browser already open is reused rather than started again, and one is kept for most of a minute after the pane closes, so a second try often needs none — wait and try again, or move the Worker to the Workers Paid plan.';

export const rateLimited = (error) => /429|rate limit|too many/i.test(String(error?.message || error));

/**
 * Whether the refusal is the day's browser time, spent — which no wait
 * short of tomorrow cures, so it is said at once rather than counted
 * down. Told from Cloudflare's words, since the status code is the same.
 */
export const dailyLimited = (error) => /today|daily|per day|time limit|browser time|quota/i.test(String(error?.message || error));

/**
 * Whether Cloudflare's limits say a browser may start — nothing named to
 * wait for, room for one more, a start allowed — so that a refusal
 * contradicts them. The limits know the minute's and the concurrent
 * allowances and nothing of the day's, so a start allowed and refused
 * all the same is what the day's browser time being spent looks like.
 */
export function contradicted(limits) {
  if (!limits) return false;
  const { alive, max, allowed, nextInMs } = limits;
  const full = alive !== null && max !== null && max > 0 && alive >= max;
  return !full && allowed !== null && allowed > 0 && nextInMs === 0;
}

/** What a refusal that contradicts the limits most likely means, worded for the person. */
export const LIKELY_DAY_SPENT =
  "Cloudflare says a browser may start, yet refuses to start one. On the free plan that is what the day's browser time being spent looks like — its limits know the minute's and the concurrent allowances, not the day's — and the Browser Rendering page of the Cloudflare dashboard shows today's use. Until its day rolls over, the Node proxy on your own machine (`npm start` in the reader repository, pointed at from Settings → Paper proxy) has no such limit; or move the Worker to the Workers Paid plan, which has hours a month.";

/** What the day's browser time being spent means, worded for the person. */
export const DAY_SPENT =
  "Cloudflare's free plan gives this Worker some minutes of browser time a day, and today's are spent, so no browser will start until its day rolls over. Until then the Node proxy on your own machine (`npm start` in the reader repository, pointed at from Settings → Paper proxy) has no such limit — or move the Worker to the Workers Paid plan, which has hours a month.";

/** A wait, said for a person: "12 seconds", "about 3 minutes". */
export function saidWait(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Which of Cloudflare's limits was met, from what it said its limits are —
 * the sentence that tells the person what to wait for, or nothing when
 * nothing is known.
 */
export function whichLimit(limits) {
  if (!limits) return '';
  const { alive, max, allowed, nextInMs } = limits;
  if (alive !== null && max !== null && max > 0 && alive >= max) {
    return `All ${max} of the browsers it allows alive at once are alive, and none is free to take over — each is let go a minute and a half after whatever was driving it lets go.`;
  }
  if (allowed === 0 && nextInMs > 0) return `This minute's new browsers are used up; the next is allowed in ${saidWait(nextInMs)}.`;
  if (allowed === 0) return "This minute's new browsers are used up, and Cloudflare did not say when the next is allowed — if it keeps refusing, the day's browser time may be spent.";
  return '';
}

/**
 * The refusal, worded for the person: which limit it was, where Cloudflare
 * said its limits, and Cloudflare's own reason on the end where it gave one
 * — the minute's allowance and the day's are refused with the same status
 * code, and only its words tell them apart.
 */
export function rateLimitedMessage(error, limits = null) {
  const raw = String(error?.message || error || '');
  const said = (raw.match(/message:\s*(.+)$/s) || [])[1]?.trim().replace(/[.\s]+$/, '');
  return [RATE_LIMITED, whichLimit(limits), said ? `Cloudflare said: ${said}.` : ''].filter(Boolean).join(' ');
}

/**
 * How long to wait before looking again, given what Cloudflare said: the
 * time it named, within reason, else a few seconds — the looks are cheap.
 */
export function waitFor(limits) {
  const named = limits?.nextInMs || 0;
  if (named > 0) return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, named));
  return RATE_LIMIT_RETRY_MS;
}

/**
 * The error handed up when the patience runs out: the message, and — for
 * the app, which counts it down and tries again on its own — how many
 * seconds until Cloudflare said it would allow another browser, or a
 * minute where it said nothing.
 */
export function refusal(error, limits, { daily = false } = {}) {
  const raw = String(error?.message || error || '');
  const said = (raw.match(/message:\s*(.+)$/s) || [])[1]?.trim().replace(/[.\s]+$/, '');
  // A refusal the limits contradict is most likely the day's time too, and said so.
  const likely = !daily && Boolean(error) && contradicted(limits);
  const message = daily
    ? [DAY_SPENT, said ? `Cloudflare said: ${said}.` : ''].filter(Boolean).join(' ')
    : likely
      ? [LIKELY_DAY_SPENT, said ? `Cloudflare said: ${said}.` : ''].filter(Boolean).join(' ')
      : rateLimitedMessage(error, limits);
  const made = new Error(message);
  made.code = 'rate-limited';
  // No wait to count down for the day: it is the person's to come back from.
  made.retryAfter = daily || likely ? null : Math.max(1, Math.ceil((limits?.nextInMs || WAIT_MAX_MS) / 1000));
  made.daily = daily || likely;
  made.browsers = limits || null;
  return made;
}

/** How long the pane waits before asking Browserless again, when its browsers were all in use. */
export const BROWSERLESS_BUSY_RETRY_S = 20;

export const BROWSERLESS_BUSY =
  "Browserless would not start another browser just now: this plan's browsers are all in use, or one was asked for too soon after the last. " +
  'A session of this account is most likely still running — the last pane, closed a moment ago, or a copy of the paper being fetched through Browserless — ' +
  'and it ends when it is done or its time is up (two minutes on the free plan).';

/**
 * The refusal Browserless's "too many requests" becomes: the same shape as
 * Cloudflare's rate limit (`refusal`), so the pane counts it down and tries
 * again on its own, with Browserless's own words on the end.
 */
export function browserlessBusy(error) {
  const raw = String(error?.message || error || '');
  const said = (raw.match(/message:\s*(.+)$/s) || [])[1]?.trim().replace(/[.\s]+$/, '');
  const made = new Error([BROWSERLESS_BUSY, said ? `Browserless said: ${said}.` : ''].filter(Boolean).join(' '));
  made.code = 'rate-limited';
  made.retryAfter = BROWSERLESS_BUSY_RETRY_S;
  made.daily = false;
  made.browsers = null;
  return made;
}

/**
 * How long each step of opening the browser may take before it is given
 * up on. Puppeteer waits three minutes for any answer over the protocol,
 * and Cloudflare will accept a connection to a session whose Chrome is no
 * longer answering, so without these a session that has died quietly —
 * or a held browser whose socket went without saying so — left the open
 * request pending for minutes, and every click after it queued behind.
 * A step that runs out is abandoned: the session it was on is avoided
 * for a while, the connection let go, and the request answered with what
 * took too long, so the next click starts afresh.
 */
export const DEADLINES = {
  /** The whole of an open, from the click to the first picture. Longer than the rate-limit patience plus a start. */
  open: 90_000,
  /** One look at Cloudflare's sessions or limits. */
  ask: 8_000,
  /** Connecting to a session, to the first protocol answer. */
  connect: 15_000,
  /** Starting a browser and connecting to it. */
  launch: 30_000,
  /** Taking a browser as this session's: its pages listed, the screencast started. */
  adopt: 20_000,
  /** A new page in a held browser. */
  page: 10_000,
  /** Putting a kept sign-in's cookies into a fresh browser: one call for the lot, so this is mostly the hop to the browser. */
  restore: 15_000,
  /** The first picture. */
  picture: 10_000,
  /** Closing a browser for good, before it is merely disconnected from. */
  close: 5_000,
};
/** How long a session that would not answer is left alone for. Longer than Cloudflare keeps an unconnected one. */
const AVOID_MS = 3 * 60_000;
/**
 * How long a host is remembered as one whose check for a person is
 * Cloudflare's, so that the next open there starts at Browserless rather
 * than meeting the check from Cloudflare's browser first and moving.
 */
export const REMEMBER_MS = 7 * 24 * 60 * 60_000;

/** What the pane says when the browser at Browserless went while it was open: the plan's time for a session, most likely. */
export const ENDED_AT_BROWSERLESS =
  "The browser at Browserless closed: its plan allows a session so long (two minutes on the free plan; BROWSERLESS_SESSION_MS raises it on a paid one), and the time is up. Open the site again for another — a check already passed there does not carry over, so tick the box again if it comes.";

/** The hosts remembered, with this one added and the stale ones dropped. Pure: pinned by the tests. */
export function challengedAfter(hosts, host, now = Date.now()) {
  const kept = {};
  for (const [name, until] of Object.entries(hosts && typeof hosts === 'object' ? hosts : {})) {
    if (typeof until === 'number' && until > now) kept[name] = until;
  }
  if (host) kept[host] = now + REMEMBER_MS;
  return kept;
}

/** Whether a host is remembered, and the memory not stale. */
export function isRemembered(hosts, host, now = Date.now()) {
  const until = hosts && typeof hosts === 'object' && host ? hosts[host] : undefined;
  return typeof until === 'number' && until > now;
}

/** A batch of input as the pane sends it — an array, or `{ events }`, or one event — or null when it is too much at once. */
export function eventsIn(body) {
  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  return events.length > 64 ? null : events;
}

/** The mouse's buttons as DevTools counts them. */
const BUTTON_FLAGS = { left: 1, right: 2, middle: 4 };

/** The button DevTools wants named on a move, from the buttons down. */
export function buttonOf(buttons) {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return 'none';
}

/**
 * Whether the page itself came as a refusal of the visitor rather than as
 * the page or a sign-in: 403 and 429 are what a site answers a network it
 * will not serve with, and a page at that status from Cloudflare's browser
 * is one to try from a browser elsewhere. A 401 is a sign-in, and stays.
 */
export function refusedOutright(response) {
  try {
    const status = Number(response.status?.());
    return status === 403 || status === 429;
  } catch {
    return false;
  }
}

/** A stream's watcher, taken off the set; the socket is closed by whoever calls, after the last status. */
function gone(object, watcher) {
  watcher.closed = true;
  object.streams.delete(watcher);
}

/** The host a URL names, as the app and the check name it: without a `www.`. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The promise's answer, or — after `ms` — an error naming what took too
 * long, after which whatever it was is not waited for. The promise itself
 * runs on; a caller that must not leak what it gives (a connection) says
 * so with `abandoned`, called with the answer should one come later.
 */
export function within(ms, what, promise, abandoned = null) {
  let timer;
  let late = false;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(timedOut(what, ms));
    }, ms);
  });
  if (abandoned) {
    promise.then((answer) => (late ? abandoned(answer) : undefined)).catch(() => undefined);
  }
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

function timedOut(what, ms) {
  const error = new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`);
  error.code = 'timeout';
  return error;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

export class BrowserSession {
  constructor(state, env) {
    this.state = state;
    this.rawEnv = env;
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
    /** The panes streaming frames over a WebSocket, each with what it last got. */
    this.streams = new Set();
    /** Where the mouse is on the page and which buttons are down, for input sent without waiting. */
    this.mouse = { x: 0, y: 0, buttons: 0 };
    this.url = '';
    this.title = '';
    this.loading = false;
    /** A PDF the browser met: its bytes where they could be read, else where to fetch it from. */
    this.pdf = null;
    /**
     * The site's check for a person, when that is what the page is: which
     * host's, how many times running it has come, and how many of those
     * after the person did something to it (see `checkAfter`). The app
     * says, from this, whether the box is worth ticking.
     */
    this.check = null;
    /** Whether the person has done something to the page since it last arrived — the box ticked, say. */
    this.acted = false;
    /** Whose browser is held: Cloudflare's, or Browserless's (worker/browserless.js); null when none is. */
    this.where = null;
    /** The hand-over of the session to a browser at Browserless, while one is in flight. */
    this.moving = null;
    /** Why the last hand-over gave no browser at Browserless, for the line under the page; null when it did, or none was tried. */
    this.fallbackError = null;
    /** Why the browser went while the pane was open, when that is known — Browserless's time for a session up, say — for the pane to say. */
    this.ended = null;
    this.lastSeen = 0;
    this.opening = null;
    /** How Cloudflare's browser is reached; a test points this at a fake. */
    this.driver = defaultDriver;
    this.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.now = () => Date.now();
    /** What Cloudflare last said its limits were, for the status and the refusals. */
    this.limits = null;
    /** How long each step may take; a test shortens these. */
    this.deadlines = { ...DEADLINES };
    /** Sessions that would not answer, and until when each is left alone. */
    this.avoid = new Map();
    /** The last thing that went wrong opening, and when — for the status, since nobody can see the logs. */
    this.lastError = null;
    /** When the open in flight began, for the status to say how long it has been. */
    this.openingSince = 0;
    /** Counts the opens; an open whose number is no longer this one was abandoned, and stops at its next step. */
    this.run = 0;
    /**
     * The last few things that happened, with when — kept in storage as
     * well, since the object is evicted between a refusal and anyone
     * coming to look at the status, and memory goes with it.
     */
    this.log = [];
  }

  // ---------------------------------------------------------- requests ----

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Whose object this is. The Worker names the object by the client id
    // and sends the id along, and the jar of cookies is keyed by it too, so
    // a sign-in made here is put back for this person and no other.
    const client = url.searchParams.get('client') || '';
    if (client && this.env.READER_CLIENT !== client) this.env = forClient(this.rawEnv, client);
    try {
      if (path === '/status') return json(await this.report());
      if (path === '/open') return json({ ok: true, ...(await this.open(url.searchParams.get('url') || '')) });
      // `/pdf` met a host's check for a person: remembered, so that a pane
      // opened there starts at Browserless (see worker/index.js).
      if (path === '/note-check') {
        await this.remember(hostOf(`https://${url.searchParams.get('host') || ''}`));
        return json({ ok: true });
      }

      const token = url.searchParams.get('session') || '';
      const live = await this.ensure(token);
      if (path === '/frame') {
        if (!live) return json(this.idle());
        const after = Number(url.searchParams.get('after'));
        return json(await this.waitForChange(Number.isFinite(after) ? after : -1));
      }
      // The stream: one WebSocket that carries every frame and status the
      // moment there is one, and takes input the other way — where a poll
      // brought one frame a round trip and a request carried one batch.
      if (path === '/stream') {
        if (!live) return json(this.idle(), 409);
        if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'a WebSocket upgrade' }, 426);
        return this.stream();
      }
      if (!live) throw closedError();
      if (path === '/input') {
        const body = await request.json().catch(() => ({}));
        const events = eventsIn(body);
        if (!events) return json({ error: 'too many events at once' }, 400);
        this.takeInput(events);
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
      if (error?.code === 'rate-limited') {
        return json({ error: error.message, retryAfter: error.retryAfter, daily: Boolean(error.daily), browsers: error.browsers || null }, 429, {
          ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
        });
      }
      if (error?.code === 'timeout') return json({ error: error.message, retryAfter: 5 }, 504);
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
    return {
      ...availability(this.env),
      open: false,
      seq: this.seq,
      pdf: null,
      persistent: Boolean(this.env.SESSIONS),
      browsers: this.limits,
      ...(this.ended ? { ended: this.ended } : {}),
    };
  }

  /**
   * The status with what can be seen of the object from outside, for
   * whoever is looking at `/browse/status` because the pane is stuck:
   * whether a browser is held at all, whether an open is in flight and for
   * how long, what Cloudflare says its limits are now, and the last thing
   * that went wrong. Nothing here waits on the browser.
   */
  async report() {
    await this.recall();
    let browsers = this.limits;
    try {
      const fresh = await within(this.deadlines.ask, 'asking Cloudflare its limits', limitsOf(this.env, this.driver));
      if (fresh) browsers = this.limits = fresh;
    } catch {
      // What it last said, then.
    }
    return {
      ...(await this.status(-1)),
      frame: undefined,
      browsers,
      held: Boolean(this.browser),
      page: Boolean(this.page && !this.page.isClosed()),
      id: this.id || null,
      opening: this.opening ? { forMs: Date.now() - this.openingSince } : null,
      avoiding: [...this.avoid.entries()].filter(([, until]) => until > Date.now()).map(([id]) => id),
      lastError: this.lastError,
      log: this.log,
    };
  }

  /** Write down what just happened, here and in storage. */
  note(what) {
    this.log = [...this.log, { at: new Date().toISOString(), what }].slice(-20);
    this.state.storage.put('diagnostics', { log: this.log, lastError: this.lastError, limits: this.limits }).catch(() => undefined);
  }

  /** What an earlier instance wrote down, when this one has nothing of its own yet. */
  async recall() {
    if (this.log.length || this.lastError) return;
    const kept = await this.state.storage.get('diagnostics').catch(() => null);
    if (!kept) return;
    this.log = Array.isArray(kept.log) ? kept.log : [];
    this.lastError = kept.lastError || null;
    if (!this.limits && kept.limits) this.limits = kept.limits;
  }

  async status(after) {
    if (!this.browser || !this.page || !this.token) return this.idle();
    return {
      ...availability(this.env),
      // Whose browser it is now, which a hand-over changes mid-session — and
      // why it did not, when Browserless gave no browser to hand it to.
      ...(this.where ? { where: this.where } : {}),
      ...(this.fallbackError ? { fallbackError: this.fallbackError } : {}),
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
      check: this.check,
      browsers: this.limits,
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
    for (const watcher of this.streams) this.push(watcher);
  }

  // ------------------------------------------------------------ stream ----

  /**
   * A WebSocket to the pane: the status, with the frame, sent whenever
   * something is newer than what this socket last got — which is what a
   * poll asked for, without the round trip between one frame and the
   * next — and input taken off it as it comes. Closed, with the last
   * status, when the browser goes.
   */
  stream() {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const watcher = { socket: server, after: -1, closed: false };
    this.streams.add(watcher);
    const gone = () => {
      watcher.closed = true;
      this.streams.delete(watcher);
    };
    server.addEventListener('message', (event) => {
      if (watcher.closed) return;
      let body;
      try {
        body = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      const events = eventsIn(body);
      if (!events || !this.browser || !this.page || !this.token) return;
      this.takeInput(events);
    });
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    this.push(watcher);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The status since what this socket last got, when anything is newer; the browser gone closes it after. */
  push(watcher) {
    if (watcher.closed) return;
    const open = Boolean(this.browser && this.page && this.token);
    if (open && this.seq <= watcher.after && this.changed <= watcher.after) return;
    const after = watcher.after;
    watcher.after = this.seq;
    if (!open) gone(this, watcher);
    void this.status(after)
      .then((status) => {
        try {
          watcher.socket.send(JSON.stringify(status));
        } catch {
          // Closed under us; the close event takes it off the set.
        }
        if (!open) {
          try {
            watcher.socket.close(1000, 'the browser closed');
          } catch {
            // Closed already.
          }
        }
      })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------- input ----

  /**
   * Input, sent to the page as it comes and not waited for: the answer to
   * a click used to wait for the browser to take it, a scroll for two such
   * waits, and the next batch from the pane for the answer — a round trip
   * to the browser for every event, which from an object far from its
   * browser is most of a second a scroll. Now every event in a batch goes
   * down the wire at once, in order, and the pane hears back at once. To
   * the page the batch was meant for: a hand-over mid-batch swaps the
   * page, and the rest — a release, a key up — is for the one that went.
   */
  takeInput(events) {
    this.touch();
    const page = this.page;
    const cdp = this.cdp;
    for (const event of events) {
      if (this.page !== page || !page || page.isClosed()) break;
      if (event?.type === 'down' || event?.type === 'keydown') this.acted = true;
      this.dispatch(page, cdp, event || {});
    }
  }

  /**
   * One event, to the page. The mouse goes over the page's own DevTools
   * session with the state kept here — where it is, which buttons are
   * down — so nothing waits and nothing is refused (Puppeteer keeps the
   * mouse's state per page and refuses a release it saw no press for).
   * Keys, text and navigation go through Puppeteer as before, which sends
   * on the call and is not waited for either. Without a session of the
   * page's, the old way.
   */
  dispatch(page, cdp, event) {
    const mouse = this.mouse;
    const flag = BUTTON_FLAGS[BUTTONS.has(event.button) ? event.button : 'left'];
    const button = BUTTONS.has(event.button) ? event.button : 'left';
    const send = (params) => {
      cdp.send('Input.dispatchMouseEvent', { modifiers: page.keyboard?._modifiers || 0, x: mouse.x, y: mouse.y, ...params }).catch(() => undefined);
    };
    const moved = () => send({ type: 'mouseMoved', buttons: mouse.buttons, button: buttonOf(mouse.buttons) });
    if (cdp && ['move', 'down', 'up', 'wheel'].includes(event.type)) {
      switch (event.type) {
        case 'move':
          mouse.x = clamp(event.x, VIEWPORT.width);
          mouse.y = clamp(event.y, VIEWPORT.height);
          return moved();
        case 'down':
          mouse.x = clamp(event.x, VIEWPORT.width);
          mouse.y = clamp(event.y, VIEWPORT.height);
          moved();
          mouse.buttons |= flag;
          return send({ type: 'mousePressed', button, buttons: mouse.buttons, clickCount: clicks(event.clickCount) });
        case 'up':
          mouse.buttons &= ~flag;
          return send({ type: 'mouseReleased', button, buttons: mouse.buttons, clickCount: clicks(event.clickCount) });
        case 'wheel':
          mouse.x = clamp(event.x, VIEWPORT.width);
          mouse.y = clamp(event.y, VIEWPORT.height);
          moved();
          return send({
            type: 'mouseWheel',
            button: 'none',
            buttons: mouse.buttons,
            deltaX: clamp(Math.abs(Number(event.dx) || 0), 2000) * Math.sign(Number(event.dx) || 0),
            deltaY: clamp(Math.abs(Number(event.dy) || 0), 2000) * Math.sign(Number(event.dy) || 0),
          });
        default:
          return undefined;
      }
    }
    void apply(page, event).catch(() => undefined);
    return undefined;
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
        const browser = await this.connectTo(kept.id);
        await within(this.deadlines.adopt, 'taking the browser back', this.adopt(browser, kept.id));
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
    if (!availability(this.env).available) throw new Error(NO_BROWSER);
    if (this.opening) await this.opening.catch(() => undefined);
    if (this.moving) await this.moving.catch(() => undefined);
    // Whose browser this site gets: Cloudflare's, unless there is none, or
    // the site is one whose check Cloudflare's browser was refused by.
    const at = await this.browserFor(url);
    this.openingSince = Date.now();
    const run = ++this.run;
    // An open given up on — its deadline passed, or another open begun —
    // runs on in the background until its next step, where this stops it,
    // letting go of a browser it got that nothing else knows of.
    const still = async (browser = null) => {
      if (this.run === run) return;
      if (browser && browser !== this.browser) await this.letGo(browser);
      const error = new Error('this open was abandoned');
      error.code = 'abandoned';
      throw error;
    };
    const work = async () => {
      // A browser of the wrong kind — Cloudflare's, for a site whose check
      // it cannot pass — is let go, so the one started below is the right one.
      if (this.browser && this.where && this.where !== at) {
        this.note(`letting go of ${this.where}'s browser: ${hostOf(url)} is for ${at}'s`);
        await this.letGo(this.browser);
      }
      // A browser already open is kept and pointed at the new site — the one
      // the pane is showing, or the one kept since the pane closed: starting
      // browsers is the thing Cloudflare rations, so one is started only
      // when there is none to reuse.
      if (this.browser && (!this.page || this.page.isClosed())) {
        // The page went — closed by the site, or crashed — but the browser
        // is still this object's: a new page in it costs Cloudflare nothing,
        // where a new browser is the thing it rations. Should the browser
        // not give one, it is closed rather than left held: a held browser
        // is one of the few Cloudflare allows alive, and nothing else can
        // take one over while something is connected to it.
        const browser = this.browser;
        try {
          const page = await within(this.deadlines.page, 'opening a page in the browser', browser.newPage());
          await within(this.deadlines.adopt, 'starting the picture', this.attach(page));
        } catch {
          await this.letGo(browser);
        }
      }
      if (!this.browser || !this.page || this.page.isClosed()) {
        // The session held before an eviction is read before it is forgotten, so it can be tried first.
        const kept = await this.state.storage.get('session').catch(() => null);
        await this.forget();
        // The kept sign-in is read from KV while the browser is being got,
        // rather than after: it is needed only once there is a page.
        const cookies = storedCookies(this.env).catch(() => []);
        const { browser, id } = await this.acquire(kept, at);
        await still(browser);
        try {
          await within(this.deadlines.adopt, 'taking the browser', this.adopt(browser, id));
          // No user-agent override: the browser presents itself as what it is,
          // string and client hints agreeing. See `open` in worker/browse.js.
        } catch (error) {
          // A browser that will not be taken is let go and avoided, not held.
          this.avoid.set(id, Date.now() + AVOID_MS);
          await this.letGo(browser);
          throw error;
        }
        // The sign-in made last time, put back in one call. Its failing —
        // or taking too long — costs that sign-in, not the open: the page
        // still opens, and the person signs in again where they need to. It
        // used to fail the open outright and leave the browser avoided, and
        // a browser that took ten seconds to take a hundred cookies one at
        // a time was "putting the sign-in back took longer than 10 seconds"
        // at every open, with no browser ever shown.
        await within(this.deadlines.restore, 'putting the sign-in back', restoreCookies(this.env, this.page, { cookies: await cookies, cdp: this.cdp }))
          .then((count) => {
            if (count) this.note(`put ${count} cookies of the kept sign-in back`);
          })
          .catch((error) => this.note(`the kept sign-in was not put back: ${String(error?.message || error)}`));
      } else if (!this.cdp) {
        // Kept since the pane closed, with its screencast stopped: started again.
        try {
          await within(this.deadlines.adopt, 'starting the picture', this.attach(this.page));
        } catch (error) {
          await this.letGo(this.browser);
          throw error;
        }
      }
      if (!this.token) {
        this.token = crypto.randomUUID();
        await this.state.storage.put('session', { token: this.token, id: this.id });
      }
      await still();
      this.touch();
      this.pdf = null;
      this.check = null;
      this.acted = false;
      this.fallbackError = null;
      this.ended = null;
      this.url = url;
      this.loading = true;
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {
        // A slow or refused page is still a page the person can see and act on.
      });
      await still();
      // The page came as Cloudflare's check, and the session is being handed
      // to a browser at Browserless: waited for, so the first status is that
      // browser's page and not a check the person would tick for nothing.
      if (this.moving) await this.moving.catch(() => undefined);
      await still();
      this.loading = false;
      // The screencast starts with the first paint after it is asked for; a
      // page already painted may not send one, so the first picture is taken.
      if (!this.frame) {
        try {
          const data = await within(this.deadlines.picture, 'the first picture', this.page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' }));
          this.frame = { seq: ++this.seq, data };
        } catch {
          // The next paint will bring one.
        }
      }
      this.bump();
      await this.state.storage.setAlarm(Date.now() + IDLE_MS);
      return this.status(-1);
    };
    // The whole open has a deadline of its own, so the request is answered
    // whatever step hung — and the browser it was on is let go, so the
    // next click starts afresh rather than behind it.
    const mine = within(this.deadlines.open, 'opening the browser', work());
    this.opening = mine;
    try {
      const status = await mine;
      this.lastError = null;
      this.note(`opened ${url}`);
      return status;
    } catch (error) {
      this.lastError = { message: String(error?.message || error), code: error?.code || null, at: new Date().toISOString(), url };
      this.note(`open failed (${error?.code || 'error'}): ${String(error?.message || error)}`);
      if (error?.code === 'timeout') {
        this.run += 1; // whatever step is still running stops at its next
        if (this.id) this.avoid.set(this.id, Date.now() + AVOID_MS);
        await this.letGo(this.browser);
      }
      throw error;
    } finally {
      if (this.opening === mine) this.opening = null;
    }
  }

  /**
   * Done with a browser, for good: closed, given a moment to be, else
   * disconnected from — never left held, since a held browser is one of
   * the few Cloudflare allows alive and nothing else can take it over.
   * Everything about the session is forgotten with it.
   */
  async letGo(browser) {
    if (this.browser === browser || !browser) await this.forget();
    if (!browser) return;
    try {
      await within(this.deadlines.close, 'closing the browser', browser.close());
    } catch {
      try {
        await browser.disconnect();
      } catch {
        // Gone already.
      }
    }
  }

  /** A connection to a session, given its deadline; one that answers late is let go rather than leaked. */
  connectTo(id) {
    return within(this.deadlines.connect, `connecting to browser session ${id}`, this.driver.connect(this.env, id), (browser) =>
      browser.disconnect?.().catch?.(() => undefined),
    );
  }

  /**
   * A browser to drive, starting one only as the last resort: first the one
   * this object had before it was evicted, then any session of the
   * account's that nothing is connected to — one left by an earlier
   * eviction, or by the stateless fallback — and only then a new one.
   *
   * Cloudflare is asked what it will allow before it is asked for a
   * browser: `limits()` says how many are alive against how many may be,
   * whether another may be started this minute, and if not how long until
   * one may. A minute spent is waited out for exactly that long, once, with
   * the request held; a full house — every browser it allows alive, all
   * held by something — is looked at again every few seconds for a session
   * that has come free, since nothing announces one. Asking for a browser
   * is the one thing done only when Cloudflare says it will answer, or
   * will not say: a refused ask may well count against the minute the way
   * an answered one does. When the patience runs out the refusal names
   * the limit met and how long until another try, for the app to count
   * down and try again on its own.
   */
  async acquire(kept, at = 'cloudflare') {
    if (at === 'browserless') {
      // Browserless rations nothing by the minute, keeps no session to take
      // over, and says what is wrong in its own words: started, or not.
      let browser;
      try {
        browser = await within(this.deadlines.launch, 'starting a browser at Browserless', this.driver.launch(this.env, { at }), (late) =>
          late.close?.().catch?.(() => undefined),
        );
      } catch (error) {
        // Its browsers all in use — one of this account's is still running:
        // the last pane's, closed a moment ago and not yet gone, or a copy
        // `/pdf` is fetching through Browserless, whose session runs until
        // the file is had or its time is up — is a wait, not a fault, and
        // handed up as one, for the pane to count down and try again.
        if (!browserless.tooBusy(error)) throw error;
        this.note(`Browserless refused a browser: ${String(error?.message || error)}`);
        throw browserlessBusy(error);
      }
      this.note(`started a browser at Browserless (${browser.sessionId()})`);
      return { browser, id: browser.sessionId() };
    }
    if (kept === undefined) kept = await this.state.storage.get('session').catch(() => null);
    const started = this.now();
    let first = kept?.id || null;
    let refused = null;
    let contradictions = 0;
    for (;;) {
      const adopted = await this.adoptFree(first);
      if (adopted) {
        this.note(`took over browser session ${adopted.id}`);
        return adopted;
      }
      first = null;
      const limits = await within(this.deadlines.ask, 'asking Cloudflare its limits', limitsOf(this.env, this.driver)).catch(() => null);
      this.limits = limits;
      // Asked for a browser only when Cloudflare says it will answer, or
      // will not say: not with the minute spent, and not with every browser
      // it allows alive — a start cannot succeed then, and the ask may cost.
      const full = limits?.alive !== null && limits?.max !== null && limits?.max > 0 && limits?.alive >= limits?.max;
      const askable = !limits || (!full && (limits.allowed === null || limits.allowed > 0));
      if (askable) {
        try {
          const browser = await within(this.deadlines.launch, 'starting a browser', this.driver.launch(this.env), (late) =>
            late.close?.().catch?.(() => undefined),
          );
          this.note(`started browser session ${browser.sessionId()}`);
          return { browser, id: browser.sessionId() };
        } catch (error) {
          if (!rateLimited(error)) throw error;
          this.note(`Cloudflare refused a browser: ${String(error?.message || error)}`);
          // The day's time spent is not a minute's wait; said now.
          if (dailyLimited(error)) throw refusal(error, limits, { daily: true });
          refused = error;
          // Refused with the limits saying it may start: looked at once
          // more, in case the limits lag, and then said — a minute of
          // asking would not cure the day's time, and costs the person.
          if (contradicted(limits) && ++contradictions >= 2) throw refusal(error, limits);
        }
      }
      const wait = waitFor(limits);
      if (this.now() - started + wait > RATE_LIMIT_PATIENCE_MS) throw refusal(refused, limits);
      await this.sleep(wait);
    }
  }

  /**
   * A session of the account's that nothing is connected to, connected to
   * and taken — the one named first, then whatever Cloudflare lists as
   * free — or null when there is none. Listed afresh on each call: a
   * session held a moment ago may be free now.
   */
  async adoptFree(first) {
    const candidates = first ? [first] : [];
    try {
      for (const session of await within(this.deadlines.ask, "asking Cloudflare for its sessions", this.driver.sessions(this.env))) {
        if (!session.connectionId && session.sessionId && !candidates.includes(session.sessionId)) candidates.push(session.sessionId);
      }
    } catch {
      // Not knowable; a new one, then.
    }
    // A few a pass, since each look costs up to its deadline. A Browserless
    // session held before an eviction is gone with it: nothing reconnects.
    for (const id of candidates.filter((id) => !browserless.isBrowserless(id) && (this.avoid.get(id) || 0) <= Date.now()).slice(0, 3)) {
      try {
        return { browser: await this.connectTo(id), id };
      } catch (error) {
        if (error?.code === 'timeout') {
          this.avoid.set(id, Date.now() + AVOID_MS);
          this.note(`session ${id} did not answer; left alone for a while`);
        }
        // Gone, or taken, or not answering; the next.
      }
    }
    return null;
  }

  /** Take a connected browser as this session's, and its page as the one shown. */
  async adopt(browser, id) {
    this.browser = browser;
    this.id = id;
    this.where = browserless.isBrowserless(id) ? 'browserless' : 'cloudflare';
    this.touch();
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        // A browser at Browserless goes when its plan's time for a session
        // is up, pane open or not; said, so the pane can say why it closed.
        if (this.token && this.where === 'browserless') {
          this.ended = ENDED_AT_BROWSERLESS;
          this.note(`the browser at Browserless (${id}) went: its session's time is up, or it was closed there`);
        }
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
    this.mouse = { x: 0, y: 0, buttons: 0 };
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
      // The page itself arriving — as the site's check for a person, or as
      // the site — is what says whether the check is on, and whether it came
      // back after the person answered it. Only the page: the check's own
      // widget is a frame from Cloudflare's domain and says nothing.
      page.on('response', (response) => {
        if (this.page !== page || !isMainDocument(response, page)) return;
        const host = challengedHost(response);
        const next = host ? checkAfter(this.check, host, this.acted) : null;
        this.acted = false;
        // Cloudflare's check, met by Cloudflare's browser, which it never
        // passes — with a browser elsewhere to hand the session to. And a
        // site refusing Cloudflare's browser in its own words, with no box
        // at all — "unusual activity from your network", a 403 or a 429
        // for the page itself — is handed over the same way: the site's
        // objection is to the address, which is the one thing a browser
        // elsewhere changes.
        if (this.where === 'cloudflare' && browserless.configured(this.env)) {
          if (host) void this.handOver(response.url(), host);
          else if (refusedOutright(response)) void this.handOver(response.url(), hostOf(response.url()));
        }
        if (JSON.stringify(next) === JSON.stringify(this.check)) return;
        this.check = next;
        this.bump();
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
    const { urls, why } = await grabTargets(url, html);
    const bytes = (await fetchFileInPage(page, urls, MAX_PDF_BYTES)) || (await fetchFileWithCookies(page, urls));
    if (!bytes) {
      throw new Error(
        why ||
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
    // A browser at Browserless is closed, not kept: its time is metered,
    // and starting another is not the thing rationed there.
    if (this.where === 'browserless') return this.close();
    await saveCookies(this.env, page).catch(() => undefined);
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
      this.cdp = null;
    }
    this.token = null;
    this.frame = null;
    this.pdf = null;
    this.check = null;
    this.acted = false;
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
    if (browser) this.note(`closed browser session ${this.id}`);
    if (browser && this.page) await within(this.deadlines.close, 'keeping the cookies', saveCookies(this.env, this.page)).catch(() => undefined);
    await this.letGo(browser);
    return { open: false };
  }

  // ------------------------------------------------- a browser elsewhere ----

  /**
   * Whose browser a site gets: Browserless's where there is no other, or
   * where the site is remembered as one whose check for a person is
   * Cloudflare's — met from Cloudflare's browser once, or by `/pdf` —
   * and Cloudflare's otherwise, since it is the free one.
   */
  async browserFor(url) {
    if (!this.env.BROWSER) return 'browserless';
    if (!browserless.configured(this.env)) return 'cloudflare';
    return (await this.remembered(hostOf(url))) ? 'browserless' : 'cloudflare';
  }

  /** Remember a host as one whose check Cloudflare's browser cannot pass, for a while. */
  async remember(host) {
    if (!host) return;
    const hosts = (await this.state.storage.get('challenged').catch(() => null)) || {};
    await this.state.storage.put('challenged', challengedAfter(hosts, host, this.now())).catch(() => undefined);
  }

  /** Whether a host is so remembered. */
  async remembered(host) {
    if (!host) return false;
    const hosts = (await this.state.storage.get('challenged').catch(() => null)) || {};
    return isRemembered(hosts, host, this.now());
  }

  /**
   * Cloudflare's check, met by Cloudflare's browser: the session is handed
   * to a browser at Browserless — started, given the sign-in's cookies,
   * pointed at the same page — and Cloudflare's is closed. The token stays,
   * so the pane carries on as it was, with the status saying whose browser
   * it is now; the host is remembered, so the next open there starts at
   * Browserless. Should Browserless not give a browser, Cloudflare's is
   * kept, and the app says the check will not pass from it. One hand-over
   * at a time: the check's page comes more than once while it runs.
   */
  async handOver(url, host) {
    if (this.moving) return this.moving;
    const from = this.browser;
    const token = this.token;
    this.moving = (async () => {
      await this.remember(host);
      this.note(`${host} checks for a person; handing the session to a browser at Browserless`);
      let browser;
      try {
        browser = await within(this.deadlines.launch, 'starting a browser at Browserless', this.driver.launch(this.env, { at: 'browserless' }), (late) =>
          late.close?.().catch?.(() => undefined),
        );
      } catch (error) {
        this.lastError = { message: String(error?.message || error), code: error?.code || null, at: new Date().toISOString(), url };
        this.fallbackError = String(error?.message || error);
        this.note(`Browserless gave no browser: ${this.fallbackError}`);
        this.bump();
        return;
      }
      if (this.browser !== from || this.token !== token) {
        // Let go of meanwhile — the pane closed, the open abandoned — so this one is not wanted either.
        await browser.close().catch(() => undefined);
        return;
      }
      const id = browser.sessionId();
      try {
        // Taken as this session's in place of Cloudflare's, the token kept:
        // `adopt` swaps the browser and moves the screencast to its page.
        await within(this.deadlines.adopt, 'taking the browser at Browserless', this.adopt(browser, id));
        await this.state.storage.put('session', { token: this.token, id }).catch(() => undefined);
        await within(this.deadlines.restore, 'putting the sign-in back', restoreCookies(this.env, this.page, { cdp: this.cdp })).catch(() => undefined);
        this.check = null;
        this.acted = false;
        this.pdf = null;
        this.frame = null;
        this.fallbackError = null;
        this.url = url;
        this.loading = true;
        this.bump();
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
        this.loading = false;
        if (!this.frame) {
          try {
            const data = await within(this.deadlines.picture, 'the first picture', this.page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' }));
            this.frame = { seq: ++this.seq, data };
          } catch {
            // The next paint will bring one.
          }
        }
        this.bump();
        this.note(`handed over to Browserless (${id}) at ${url}`);
      } catch (error) {
        this.lastError = { message: String(error?.message || error), code: error?.code || null, at: new Date().toISOString(), url };
        this.fallbackError = String(error?.message || error);
        this.note(`the hand-over failed: ${this.fallbackError}`);
        await this.letGo(browser);
      } finally {
        // Cloudflare's browser, closed for good either way: it is one of
        // the few allowed alive, and nothing drives it now.
        try {
          await within(this.deadlines.close, "closing Cloudflare's browser", from.close());
        } catch {
          await from?.disconnect?.().catch?.(() => undefined);
        }
      }
    })().finally(() => {
      this.moving = null;
    });
    return this.moving;
  }

  /** Drop everything about the session, without touching the browser. */
  async forget() {
    if (this.cdp) await this.cdp.detach().catch(() => undefined);
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.where = null;
    this.fallbackError = null;
    this.ended = null;
    this.token = null;
    this.frame = null;
    this.pdf = null;
    this.check = null;
    this.acted = false;
    this.url = '';
    this.title = '';
    this.loading = false;
    await this.state.storage.delete('session').catch(() => undefined);
    await this.state.storage.deleteAlarm().catch(() => undefined);
    this.wake();
  }
}
