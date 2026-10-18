// The Calendar page: the signed-in account's Google Calendar, read and shown
// by day, week or month, with every meeting in the span on screen. A page of
// its own in the rail, like the Playground: the library and the dock step
// aside for it. The arithmetic — which days a view shows, where an event sits
// on the grid — is in lib/calendar.ts; reading the calendar is a scope asked
// for on its own the first time, as Colab's is (lib/google.ts).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import * as google from '../lib/google';
import { basePath } from '../lib/route';
import { Armillary } from './Quiet';
import {
  CALL_NAMES,
  CalendarRequestError,
  MINUTES_IN_DAY,
  VIEWS,
  accountKey,
  addDays,
  atKeys,
  createEvent,
  dayKey,
  daysIn,
  deleteEvent,
  draftOf,
  draftProblem,
  durationLabel,
  emptyDraft,
  eventsOn,
  fetchAllEvents,
  fetchCalendars,
  firstWeekday,
  hourLabel,
  onDay,
  periodLabel,
  placeTimed,
  readAccountPref,
  respondToEvent,
  sameDay,
  sameMonth,
  seriesKey,
  sortEvents,
  spanFor,
  spansDays,
  startOfDay,
  step,
  tagKeys,
  timeKey,
  timeLabel,
  toHalfHour,
  updateEvent,
  whenLabel,
  withEvent,
  withoutEvent,
  zoomLink,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarView,
  type EventDraft,
  type Response as Rsvp,
  type Span,
} from '../lib/calendar';
import { initialsOf, meetingProject, projectInfo, projectsOf, withMeeting, type Project } from '../lib/projects';
import { canMakeZoom, makeZoomMeeting } from '../lib/zoom';
import { fileGranolaNotes } from '../lib/meetingNotes';
import { useLogbook } from '../lib/logbookStore';
import { inDesktopApp, recorderBridge } from '../lib/recorder';
import { isHost, joinMeeting, knowEvents } from '../lib/notetaker';

/** Where the Reader app for Mac, Windows and Linux is published (docs/desktop-app.md). */
const DESKTOP_RELEASES = 'https://github.com/saurav717/reader/releases/latest';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, ExternalIcon, PeopleIcon, PinIcon, PlusIcon, RestoreIcon, TrashIcon, VideoIcon } from './icons';

const VIEW_KEY = 'reader.calendar.view';
/** The calendars an account has hidden on the page: its own, as each account's calendars are (see accountKey). */
const HIDDEN_KEY = 'reader.calendar.hidden';
/**
 * That this account connected the calendar once in this browser: the page then
 * offers to reconnect quietly rather than to connect anew. Per account, since
 * another account signed in here has granted nothing, and Google asks it everything.
 */
const CONNECTED_KEY = 'reader.calendar.connected';
/** Told when the calendar is connected or forgotten, so Settings and the page agree. */
const ACCESS_CHANGED = 'reader:calendar-access';
/** A pixel per minute and a quarter: an hour is 75px tall, enough for a half-hour meeting's title and time. */
const HOUR_PX = 75;
const REFRESH_MS = 5 * 60_000;

const readView = (): CalendarView => {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return stored === 'day' || stored === 'month' ? stored : 'week';
  } catch {
    return 'week';
  }
};

const readHidden = (email: string | undefined): string[] => {
  try {
    const stored = JSON.parse(readAccountPref(localStorage, HIDDEN_KEY, email) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const wasConnected = (email: string | undefined): boolean => {
  try {
    return readAccountPref(localStorage, CONNECTED_KEY, email) === 'true';
  } catch {
    return false;
  }
};

const rememberConnected = (email: string | undefined, connected: boolean): void => {
  if (!email) return;
  try {
    if (connected) localStorage.setItem(accountKey(CONNECTED_KEY, email), 'true');
    else localStorage.removeItem(accountKey(CONNECTED_KEY, email));
  } catch {
    // only a preference
  }
};

const tellAccess = () => window.dispatchEvent(new Event(ACCESS_CHANGED));

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether this tab's sign-in can read the calendar now; follows the token as it is renewed, forgotten or signed out. */
export function useCalendarAccess(): boolean {
  const [has, setHas] = useState(google.hasCalendarAccess);
  useEffect(() => {
    const check = () => setHas(google.hasCalendarAccess());
    const stop = google.onSessionChange(check);
    window.addEventListener(ACCESS_CHANGED, check);
    const tick = window.setInterval(check, 30_000);
    check();
    return () => {
      stop();
      window.removeEventListener(ACCESS_CHANGED, check);
      window.clearInterval(tick);
    };
  }, []);
  return has;
}

/** Settings → Google: whether the calendar is connected, and the button that connects or forgets it. */
export function CalendarConnect() {
  const { user, settings } = useStore();
  const connected = useCalendarAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = settings.googleClientId.trim();
  if (!user) return null;
  const connect = () => {
    setError(null);
    setBusy(true);
    // Synchronous up to Google's window: the click has to still be there for it.
    google
      .connectCalendar(clientId)
      .then(() => {
        rememberConnected(user.email, true);
        tellAccess();
      })
      .catch((failure: unknown) => setError(message(failure)))
      .finally(() => setBusy(false));
  };
  const forget = () => {
    google.dropCalendar();
    rememberConnected(user.email, false);
    tellAccess();
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 12, marginTop: 10 }}>
      <CalendarIcon size={20} style={{ color: connected ? 'var(--accent)' : 'var(--muted)' }} />
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{connected ? 'Google Calendar connected' : 'Google Calendar not connected'}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          {connected
            ? 'Your meetings are on the Calendar page, by day, week or month. Your calendar changes only when you change it there: a meeting added, changed or deleted, or an invitation answered.'
            : error || 'The Calendar page shows the meetings in this account’s calendars, and can add to them. Connecting asks Google once, for your calendars and their events.'}
        </div>
      </div>
      {connected ? (
        <button type="button" className="btn sm" onClick={forget} title="Forget the calendar in this tab. Google’s grant stays until you take it away at myaccount.google.com/permissions">
          Forget
        </button>
      ) : (
        <button type="button" className="btn primary sm" onClick={connect} disabled={busy || !clientId}>
          {busy ? 'Connecting…' : wasConnected(user.email) ? 'Reconnect calendar' : 'Connect calendar'}
        </button>
      )}
    </div>
  );
}

interface Loaded {
  span: Span;
  events: CalendarEvent[];
  refused: CalendarInfo[];
  at: number;
}

interface Picked {
  event: CalendarEvent;
  /** Where the card goes: beside what was clicked. */
  anchor: DOMRect;
}

export default function Calendar({ onOpenSettings, onOpenProject }: { onOpenSettings: () => void; /** A project, on its overview — or on a tab of its logbook. */ onOpenProject?: (id: string, section?: string) => void }) {
  const { user, settings, collections, updateCollection } = useStore();
  const clientId = settings.googleClientId.trim();
  const connected = useCalendarAccess();
  const [view, setViewState] = useState<CalendarView>(readView);
  const [date, setDate] = useState<Date>(() => new Date());
  const [now, setNow] = useState<Date>(() => new Date());
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const email = user?.email;
  const [hidden, setHiddenState] = useState<string[]>(() => readHidden(email));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** The editor: a new event being drafted, or an existing one (`of`) being changed — and the project it is for. */
  const [editing, setEditing] = useState<{ draft: EventDraft; of?: CalendarEvent; projectId: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** An answer to an invitation on its way to Google. */
  const [responding, setResponding] = useState(false);
  const cache = useRef(new Map<string, Loaded>());
  const firstDay = useMemo(() => firstWeekday(), []);
  const span = useMemo(() => spanFor(view, date, firstDay), [view, date, firstDay]);
  const spanKey = `${span.start.getTime()}-${span.end.getTime()}`;

  const setView = (next: CalendarView) => {
    setViewState(next);
    setPicked(null);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // only a preference
    }
  };
  const setHidden = (next: string[]) => {
    setHiddenState(next);
    try {
      if (email) localStorage.setItem(accountKey(HIDDEN_KEY, email), JSON.stringify(next));
    } catch {
      // only a preference
    }
  };

  // Whose hidden calendars: a sign-in from nobody's library happens in place, without a reload.
  useEffect(() => setHiddenState(readHidden(email)), [email]);

  // The clock, for today's line and "now".
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(tick);
  }, []);

  const load = useCallback(
    async (force = false) => {
      if (!connected || !clientId) return;
      const held = cache.current.get(spanKey);
      if (held && !force && Date.now() - held.at < REFRESH_MS) {
        setLoaded(held);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const token = await google.calendarToken(clientId);
        if (!token) {
          tellAccess();
          return;
        }
        let list = calendars;
        if (!list || force) {
          list = await fetchCalendars(token);
          setCalendars(list);
        }
        const { events, refused } = await fetchAllEvents(token, list, span);
        const next: Loaded = { span, events, refused, at: Date.now() };
        cache.current.set(spanKey, next);
        setLoaded(next);
      } catch (failure) {
        if (failure instanceof CalendarRequestError && failure.status === 401) {
          // The grant is gone (taken away at Google, or the token revoked): back to the connect card.
          google.dropCalendar();
          tellAccess();
          setError('Google no longer accepts this sign-in for your calendar. Connect it again.');
        } else if (failure instanceof CalendarRequestError && failure.status === 403) {
          setError(`Google Calendar refused: ${failure.message}. If this is your own copy of Reader, the Google Calendar API has to be turned on in its Cloud project.`);
        } else setError(message(failure));
      } finally {
        setLoading(false);
      }
    },
    [connected, clientId, spanKey, span, calendars],
  );

  // The span on screen, as it changes; and again every few minutes while the page is in view.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!connected) return;
    const again = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const tick = window.setInterval(again, REFRESH_MS);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', again);
    };
  }, [connected, load]);

  const connect = () => {
    setError(null);
    setConnecting(true);
    google
      .connectCalendar(clientId)
      .then(() => {
        rememberConnected(email, true);
        tellAccess();
      })
      .catch((failure: unknown) => setError(message(failure)))
      .finally(() => setConnecting(false));
  };

  const goToday = () => {
    setDate(new Date());
    setPicked(null);
  };
  const go = (direction: 1 | -1) => {
    setDate((current) => step(view, current, direction));
    setPicked(null);
  };
  const openDay = (day: Date) => {
    setDate(day);
    setView('day');
  };

  // Keys: ← → for the step, T for today, D W M for the views, Esc closes the card.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === 'Escape') {
        setPicked(null);
        setEditing(null);
        return;
      }
      if (editing) return;
      if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
      else if (event.key.toLowerCase() === 't') goToday();
      else if (event.key.toLowerCase() === 'd') setView('day');
      else if (event.key.toLowerCase() === 'w') setView('week');
      else if (event.key.toLowerCase() === 'm') setView('month');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, Boolean(editing)]);

  const shown = useMemo(() => (loaded && loaded.span.start.getTime() === span.start.getTime() && loaded.span.end.getTime() === span.end.getTime() ? loaded : null), [loaded, span]);
  const events = useMemo(() => (shown ? shown.events.filter((event) => !hidden.includes(event.calendarId)) : []), [shown, hidden]);
  const days = useMemo(() => daysIn(span), [span]);
  const meetings = events.filter((event) => event.response !== 'declined').length;
  const projects = useMemo(() => projectsOf(collections), [collections]);
  /** The project each meeting on screen is tagged with, by the meeting's id. */
  const tags = useMemo(() => {
    const map = new Map<string, Project>();
    for (const event of events) {
      const project = meetingProject(projects, tagKeys(event));
      if (project) map.set(event.id, project);
    }
    return map;
  }, [events, projects]);
  /**
   * Tag a meeting — or, for one of a series, every meeting in it — as a
   * project's, or as no project's. The key is kept on the project's own
   * record, so it goes to Drive with the library; it leaves every other
   * project it was on.
   */
  const tag = (event: CalendarEvent, projectId: string | null, series: boolean) => {
    const key = (series && seriesKey(event)) || event.id;
    for (const project of projects) {
      const mine = project.id === projectId;
      if (!mine && !project.project.meetings?.[key]) continue;
      void updateCollection(project.id, (collection) => ({
        project: withMeeting(projectInfo(collection) ?? project.project, key, mine ? { title: event.title, taggedAt: new Date().toISOString() } : null),
      }));
    }
  };

  // Granola's notes of the meetings that have ended, filed in their projects' logbooks as the calendar is read (lib/meetingNotes.ts).
  const granolaKey = settings.granolaKey.trim();
  const [noteNews, setNoteNews] = useState<string | null>(null);
  useEffect(() => {
    if (!granolaKey || !shown || !email) return;
    let gone = false;
    void fileGranolaNotes(granolaKey, shown.events, projects, email).then((result) => {
      if (gone) return;
      if (result.error) setNoteNews(`Granola’s notes could not be read: ${result.error}`);
      else if (result.filed) setNoteNews(`${result.filed === 1 ? 'A meeting’s notes were' : `${result.filed} meetings’ notes were`} filed from Granola in ${result.filed === 1 ? 'its project' : 'their projects'}.`);
    });
    return () => {
      gone = true;
    };
    // Each time the calendar is read (`shown.at`), not each time a project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granolaKey, shown?.at, email]);

  // The notetaker matches a meeting found on the computer to its event: it has the week on screen without asking again.
  useEffect(() => {
    if (shown) knowEvents(shown.events);
  }, [shown]);

  const pick = (event: CalendarEvent, target: HTMLElement) => setPicked({ event, anchor: target.getBoundingClientRect() });

  // ---- making, changing, deleting and answering: each goes to Google, then into what is on screen.
  /** The calendars events can be put on: the person's own, and shared ones they may write to. */
  const writable = useMemo(() => (calendars ?? []).filter((calendar) => calendar.writable), [calendars]);
  const calendarOf = (event: CalendarEvent) => calendars?.find((calendar) => calendar.id === event.calendarId);
  /** The events on screen changed, in the cache too, so a step away and back shows the same. */
  const patchEvents = (change: (events: CalendarEvent[]) => CalendarEvent[]) => {
    setLoaded((current) => {
      if (!current) return current;
      const next = { ...current, events: change(current.events) };
      cache.current.set(`${current.span.start.getTime()}-${current.span.end.getTime()}`, next);
      return next;
    });
  };
  const tokenOrSay = async (): Promise<string | null> => {
    const token = await google.calendarToken(clientId);
    if (!token) {
      tellAccess();
      setError('The calendar has to be connected again first.');
    }
    return token;
  };
  const said = (failure: unknown) => (failure instanceof CalendarRequestError && failure.status === 403 ? 'Google would not allow that on this calendar.' : message(failure));
  /** A new event from `start`, on the person's own calendar unless they pick another. */
  const startNew = (start: Date, allDay = false) => {
    if (!writable.length) {
      setError('None of your calendars can be written to from here, so there is nowhere to put a new event.');
      return;
    }
    setPicked(null);
    setEditError(null);
    setEditing({ draft: emptyDraft((writable.find((calendar) => calendar.primary) ?? writable[0]).id, start, allDay), projectId: null });
  };
  /** New from the head: the next half hour of today when today is on screen, else nine in the morning of the day shown. */
  const startNewNow = () => {
    const today = sameDay(date, now) || (view !== 'day' && daysIn(span).some((day) => sameDay(day, now)));
    startNew(today ? new Date(toHalfHour(now).getTime() + 30 * 60_000) : new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9));
  };
  const startEdit = (event: CalendarEvent) => {
    setPicked(null);
    setEditError(null);
    setEditing({ draft: draftOf(event), of: event, projectId: tags.get(event.id)?.id ?? null });
  };
  const save = async () => {
    if (!editing) return;
    const problem = draftProblem(editing.draft);
    if (problem) {
      setEditError(problem);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const token = await tokenOrSay();
      if (!token) return;
      const list = calendars ?? [];
      const next = editing.of ? await updateEvent(token, list, editing.of, editing.draft) : await createEvent(token, list.find((calendar) => calendar.id === editing.draft.calendarId)!, editing.draft);
      const before = editing.of?.id;
      patchEvents((events) => withEvent(before ? withoutEvent(events, before) : events, next));
      // The project picked in the editor: the meeting tagged with it (this one; a series keeps its own tag unless changed).
      const had = editing.of ? tags.get(editing.of.id)?.id ?? null : null;
      if (editing.projectId !== had || (editing.of && editing.of.id !== next.id && editing.projectId)) tag(next, editing.projectId, false);
      setEditing(null);
    } catch (failure) {
      setEditError(said(failure));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (event: CalendarEvent) => {
    if (!window.confirm(`Delete “${event.title}”${event.seriesId ? ' — this one only; the rest of the series stays' : ''}?`)) return;
    setSaving(true);
    try {
      const token = await tokenOrSay();
      if (!token) return;
      await deleteEvent(token, event);
      patchEvents((events) => withoutEvent(events, event.id));
      setEditing(null);
      setPicked(null);
    } catch (failure) {
      if (editing) setEditError(said(failure));
      else setError(said(failure));
    } finally {
      setSaving(false);
    }
  };
  const respond = async (event: CalendarEvent, response: Rsvp) => {
    const calendar = calendarOf(event);
    if (!calendar || event.response === response) return;
    setResponding(true);
    try {
      const token = await tokenOrSay();
      if (!token) return;
      const next = await respondToEvent(token, calendar, event, response);
      patchEvents((events) => withEvent(events, next));
      setPicked((current) => (current && current.event.id === event.id ? { ...current, event: next } : current));
    } catch (failure) {
      setError(said(failure));
    } finally {
      setResponding(false);
    }
  };

  const head = (
    <div className="collection-head cal-head">
      <div className="collection-titlebar">
        <span className="junk-mark">
          <CalendarIcon size={18} />
        </span>
        <h1 className="collection-title">Calendar</h1>
        {connected ? (
          <>
            <button type="button" className="btn sm" onClick={goToday} title="Today (T)">
              Today
            </button>
            <span className="cal-step">
              <button type="button" className="icon-btn sm" onClick={() => go(-1)} aria-label={`Previous ${view}`} title={`Previous ${view} (←)`}>
                <ChevronLeftIcon size={16} />
              </button>
              <button type="button" className="icon-btn sm" onClick={() => go(1)} aria-label={`Next ${view}`} title={`Next ${view} (→)`}>
                <ChevronRightIcon size={16} />
              </button>
            </span>
            <h2 className="cal-period">{periodLabel(view, date, firstDay)}</h2>
            <span style={{ flexGrow: 1 }} />
            <button type="button" className="btn primary sm cal-new" onClick={startNewNow} disabled={!calendars} title="A new event — or click an empty hour on the grid">
              <PlusIcon size={14} />
              New
            </button>
            <div className="segmented" role="tablist" aria-label="View">
              {VIEWS.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={view === item.id} onClick={() => setView(item.id)} title={`${item.label} (${item.key})`}>
                  {item.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn sm" onClick={() => void load(true)} disabled={loading} aria-label="Refresh" title="Read the calendar again now" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RestoreIcon size={14} />
              {loading ? 'Reading…' : 'Refresh'}
            </button>
          </>
        ) : null}
      </div>
      <p className="collection-sub">
        {user?.email ? <span>{user.email}</span> : null}
        {connected && shown ? <span>{meetings === 0 ? 'nothing scheduled' : `${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}`} this {view}</span> : null}
        {connected && calendars && calendars.length > 1 ? (
          <span className="cal-cals" role="group" aria-label="Calendars">
            {calendars.map((calendar) => {
              const off = hidden.includes(calendar.id);
              return (
                <button
                  key={calendar.id}
                  type="button"
                  className={`cal-cal${off ? ' is-off' : ''}`}
                  aria-pressed={!off}
                  title={off ? `Show ${calendar.name}` : `Hide ${calendar.name}`}
                  onClick={() => setHidden(off ? hidden.filter((id) => id !== calendar.id) : [...hidden, calendar.id])}
                >
                  <i style={{ background: calendar.color }} />
                  {calendar.name}
                </button>
              );
            })}
          </span>
        ) : null}
        {shown?.refused.length ? <span title={shown.refused.map((calendar) => calendar.name).join(', ')}>{shown.refused.length === 1 ? `${shown.refused[0].name} could not be read` : `${shown.refused.length} calendars could not be read`}</span> : null}
      </p>
    </div>
  );

  if (!clientId) {
    return (
      <div className="main library-main cal" aria-label="Calendar">
        {head}
        <Empty
          title="Google sign-in is not set up"
          text="The calendar is read from the Google account you sign in with. Settings → Google needs a client ID first."
          action={{ label: 'Open Settings', onClick: onOpenSettings }}
        />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="main library-main cal" aria-label="Calendar">
        {head}
        <Empty title="Sign in to see your calendar" text="Your meetings are read from the Google account you sign in with, by day, week or month." action={{ label: 'Sign in', onClick: onOpenSettings }} />
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="main library-main cal" aria-label="Calendar">
        {head}
        <Empty
          title={wasConnected(user.email) ? 'Reconnect your calendar' : 'See your meetings here'}
          text={
            wasConnected(user.email)
              ? `The sign-in for ${user.email} has to be renewed for the calendar. One click; Google asks nothing new.`
              : `Reader shows the calendars in ${user.email} — the ones you keep and the meetings in them — by day, week or month, and lets you add a meeting, change one, or answer an invitation from here. Connecting asks Google once, for your calendars and their events.`
          }
          error={error}
          note={
            wasConnected(user.email)
              ? undefined
              : 'A calendar is what Google calls a sensitive permission, so until this copy of Reader is verified with Google its window first says “Google hasn’t verified this app”: Advanced, then Go to Reader, lets you through to the usual consent screen.'
          }
          more={{ href: `${basePath()}privacy/`, label: 'What Reader does with your calendar: the privacy policy' }}
          action={{ label: connecting ? 'Connecting…' : wasConnected(user.email) ? 'Reconnect calendar' : 'Connect Google Calendar', onClick: connect, disabled: connecting, primary: true }}
        />
      </div>
    );
  }

  return (
    <div className="main library-main cal" aria-label="Calendar" aria-busy={loading}>
      {head}
      {error ? (
        <p className="banner error" style={{ margin: '0 32px 12px' }}>
          {error}
        </p>
      ) : null}
      {noteNews ? (
        <p className="banner cal-news" role="status" style={{ margin: '0 32px 12px' }}>
          {noteNews}
          <button type="button" className="link-btn" onClick={() => setNoteNews(null)}>
            Dismiss
          </button>
        </p>
      ) : null}
      {view === 'month' ? (
        <MonthGrid days={days} date={date} events={events} today={now} tags={tags} onDay={openDay} onEvent={pick} picked={picked?.event.id} onSlot={(day) => startNew(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9))} />
      ) : (
        <TimeGrid days={days} events={events} now={now} tags={tags} onEvent={pick} picked={picked?.event.id} onDay={view === 'week' ? openDay : undefined} onSlot={(start) => startNew(start)} />
      )}
      {!shown && !loading && !error ? <div className="cal-blank">Reading your calendar…</div> : null}
      {picked ? (
        <EventCard
          picked={picked}
          calendar={calendarOf(picked.event)}
          projects={projects}
          project={tags.get(picked.event.id)}
          onTag={(projectId, series) => tag(picked.event, projectId, series)}
          onOpenProject={onOpenProject}
          onEdit={() => startEdit(picked.event)}
          onDelete={() => void remove(picked.event)}
          onRespond={(response) => void respond(picked.event, response)}
          responding={responding}
          granolaKey={Boolean(granolaKey)}
          onOpenSettings={onOpenSettings}
          onClose={() => setPicked(null)}
        />
      ) : null}
      {editing ? (
        <EventEditor
          editing={editing}
          calendars={writable}
          projects={projects}
          zoomRoom={settings.zoomRoom}
          onProject={(projectId) => setEditing({ ...editing, projectId })}
          busy={saving}
          error={editError}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={() => void save()}
          onDelete={editing.of ? () => void remove(editing.of!) : undefined}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function Empty({ title, text, error, note, more, action }: { title: string; text: string; error?: string | null; note?: string; /** A page that says more, under the note. */ more?: { href: string; label: string }; action: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean } }) {
  return (
    <div className="scroll" style={{ padding: '18px 32px 32px' }}>
      <div className="cal-empty">
        <Armillary size={64} />
        <h2>{title}</h2>
        <p>{text}</p>
        {error ? <p className="banner error">{error}</p> : null}
        <button type="button" className={`btn${action.primary ? ' primary' : ''}`} onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
        {note ? <p className="cal-empty-note">{note}</p> : null}
        {more ? (
          <p className="cal-empty-note">
            <a href={more.href} style={{ color: 'inherit' }}>
              {more.label}
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

const colorStyle = (event: CalendarEvent): CSSProperties => ({ '--ev': event.color }) as CSSProperties;

/** The mark of the project a meeting is tagged with, as the rail draws projects; nothing when it has none. */
function Tag({ project, named = false }: { project?: Project; named?: boolean }) {
  if (!project) return null;
  return (
    <span className={`cal-tag${named ? ' is-named' : ''}`} title={`Project: ${project.name}`}>
      <span className="pj-mark sm" style={{ background: project.color }}>
        {initialsOf(project.name)}
      </span>
      {named ? <span className="cal-tag-name">{project.name}</span> : null}
    </span>
  );
}

const eventClass = (event: CalendarEvent, extra = '', picked?: string) =>
  `cal-ev${extra ? ` ${extra}` : ''}${event.response === 'declined' ? ' is-declined' : ''}${event.response === 'tentative' || event.status === 'tentative' ? ' is-tentative' : ''}${event.response === 'needsAction' ? ' is-asked' : ''}${picked === event.id ? ' is-picked' : ''}`;

/** The month: six weeks of seven days, each day's events as a short list, the rest behind "+N more". */
function MonthGrid({ days, date, events, today, tags, onDay, onEvent, picked, onSlot }: { days: Date[]; date: Date; events: CalendarEvent[]; today: Date; tags: Map<string, Project>; onDay: (day: Date) => void; onEvent: (event: CalendarEvent, target: HTMLElement) => void; picked?: string; /** A double-click on a day's empty space: a new event that day. */ onSlot?: (day: Date) => void }) {
  const MOST = 3;
  return (
    <div className="cal-month" role="grid" aria-label="Month">
      <div className="cal-month-days" role="row">
        {days.slice(0, 7).map((day) => (
          <span key={dayKey(day)} role="columnheader">
            {day.toLocaleDateString(undefined, { weekday: 'short' })}
          </span>
        ))}
      </div>
      <div className="cal-month-cells">
        {days.map((day) => {
          const here = sortEvents(eventsOn(events, day));
          const spanning = here.filter(spansDays);
          const timed = here.filter((event) => !spansDays(event));
          const listed = [...spanning, ...timed];
          const more = listed.length - MOST;
          const isToday = sameDay(day, today);
          return (
            <div
              key={dayKey(day)}
              role="gridcell"
              className={`cal-month-cell${sameMonth(day, date) ? '' : ' is-outside'}${isToday ? ' is-today' : ''}`}
              aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
              title={onSlot ? 'Double-click to add an event' : undefined}
              onDoubleClick={(click) => {
                if (onSlot && (click.target === click.currentTarget || (click.target as HTMLElement).classList.contains('cal-month-list'))) onSlot(day);
              }}
            >
              <button type="button" className="cal-month-num" onClick={() => onDay(day)} title="Open this day">
                {day.getDate() === 1 ? day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : day.getDate()}
              </button>
              <div className="cal-month-list">
                {listed.slice(0, more > 1 ? MOST : listed.length).map((event) => (
                  <button key={event.id} type="button" className={eventClass(event, spansDays(event) ? 'is-bar' : 'is-line', picked)} style={colorStyle(event)} onClick={(click) => onEvent(event, click.currentTarget)} title={event.title}>
                    {spansDays(event) ? null : <time>{timeLabel(event.start)}</time>}
                    <span>{event.title}</span>
                    <Tag project={tags.get(event.id)} />
                  </button>
                ))}
                {more > 1 ? (
                  <button type="button" className="cal-more" onClick={() => onDay(day)}>
                    +{more} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A spanning event's place in the all-day row: which column it starts in and how many it takes, clipped to the days shown. */
function lanes(events: CalendarEvent[], days: Date[]): { event: CalendarEvent; from: number; span: number; lane: number }[] {
  const first = days[0];
  const end = addDays(days[days.length - 1], 1);
  const ends: number[] = [];
  return sortEvents(events.filter((event) => spansDays(event) && event.start < end && event.end > first)).map((event) => {
    const from = Math.max(0, Math.round((startOfDay(event.start).getTime() - first.getTime()) / 86_400_000));
    const to = Math.min(days.length, Math.ceil((event.end.getTime() - first.getTime()) / 86_400_000));
    let lane = ends.findIndex((taken) => taken <= from);
    if (lane === -1) {
      lane = ends.length;
      ends.push(to);
    } else ends[lane] = to;
    return { event, from, span: Math.max(1, to - from), lane };
  });
}

/** A day or a week on a time axis: the all-day row above, the hours below, each column's meetings side by side where they overlap. */
function TimeGrid({ days, events, now, tags, onEvent, picked, onDay, onSlot }: { days: Date[]; events: CalendarEvent[]; now: Date; tags: Map<string, Project>; onEvent: (event: CalendarEvent, target: HTMLElement) => void; picked?: string; onDay?: (day: Date) => void; /** A click on an empty hour: a new event starting there, on the half hour. */ onSlot?: (start: Date) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const single = days.length === 1;
  const allDay = useMemo(() => lanes(events, days), [events, days]);
  const laneCount = allDay.reduce((most, item) => Math.max(most, item.lane + 1), 0);
  const hasToday = days.some((day) => sameDay(day, now));
  // Opens on the working morning, or an hour before now when today is on screen.
  const firstKey = dayKey(days[0]);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const minutes = hasToday ? Math.max(0, now.getHours() * 60 + now.getMinutes() - 60) : 7 * 60;
    box.scrollTop = (minutes / 60) * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, single]);
  const columns: CSSProperties = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };
  const timed = useMemo(() => days.map((day) => placeTimed(events, day)), [days, events]);
  const agenda = single ? sortEvents(eventsOn(events, days[0])) : [];
  const inMeetings = agenda.filter((event) => !event.allDay && event.response !== 'declined').reduce((total, event) => total + (Math.min(event.end.getTime(), addDays(days[0], 1).getTime()) - Math.max(event.start.getTime(), days[0].getTime())) / 60_000, 0);
  return (
    <div className={`cal-time${single ? ' is-day' : ''}`}>
      <div className="cal-time-main">
        <div className="cal-time-head" style={columns}>
          <span className="cal-time-corner" aria-hidden="true" />
          {days.map((day) => {
            const isToday = sameDay(day, now);
            return (
              <div key={dayKey(day)} className={`cal-time-day${isToday ? ' is-today' : ''}`}>
                <span className="cal-time-wd">{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                {onDay ? (
                  <button type="button" className="cal-time-num" onClick={() => onDay(day)} title="Open this day">
                    {day.getDate()}
                  </button>
                ) : (
                  <span className="cal-time-num">{day.getDate()}</span>
                )}
              </div>
            );
          })}
          {laneCount ? (
            <>
              <span className="cal-allday-cap">all day</span>
              <div className="cal-allday" style={{ gridColumn: `2 / span ${days.length}`, gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${laneCount}, 22px)` }}>
                {allDay.map(({ event, from, span, lane }) => (
                  <button key={event.id} type="button" className={eventClass(event, 'is-bar', picked)} style={{ ...colorStyle(event), gridColumn: `${from + 1} / span ${span}`, gridRow: lane + 1 }} onClick={(click) => onEvent(event, click.currentTarget)} title={event.title}>
                    <span>{event.title}</span>
                    <Tag project={tags.get(event.id)} />
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div ref={scroller} className="cal-time-scroll">
          <div className="cal-time-body" style={{ ...columns, height: 24 * HOUR_PX }}>
            <div className="cal-hours" aria-hidden="true">
              {Array.from({ length: 24 }, (_, hour) => (
                <span key={hour} style={{ top: hour * HOUR_PX }}>
                  {hour ? hourLabel(hour) : ''}
                </span>
              ))}
            </div>
            {days.map((day, index) => {
              const isToday = sameDay(day, now);
              const minutesNow = now.getHours() * 60 + now.getMinutes();
              return (
                <div
                  key={dayKey(day)}
                  className={`cal-col${isToday ? ' is-today' : ''}${onSlot ? ' can-add' : ''}`}
                  role="group"
                  aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                  title={onSlot ? 'Click an empty hour to add an event' : undefined}
                  onClick={(click) => {
                    if (!onSlot || click.target !== click.currentTarget) return;
                    const box = click.currentTarget.getBoundingClientRect();
                    const minutes = Math.max(0, Math.min(MINUTES_IN_DAY - 30, ((click.clientY - box.top) / HOUR_PX) * 60));
                    onSlot(toHalfHour(new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60)));
                  }}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <i key={hour} className="cal-hline" style={{ top: hour * HOUR_PX }} />
                  ))}
                  {timed[index].map(({ event, top, height, column, columns: count }) => {
                    const width = 100 / count;
                    const short = height < 40;
                    return (
                      <button
                        key={event.id}
                        type="button"
                        className={eventClass(event, `is-block${short ? ' is-short' : ''}`, picked)}
                        style={{ ...colorStyle(event), top: (top / 60) * HOUR_PX, height: (height / 60) * HOUR_PX - 2, left: `calc(${column * width}% + 2px)`, width: `calc(${width}% - 4px)` }}
                        onClick={(click) => onEvent(event, click.currentTarget)}
                        title={`${event.title} · ${timeLabel(event.start)} – ${timeLabel(event.end)}`}
                      >
                        <Tag project={tags.get(event.id)} />
                        <span className="cal-ev-title">{event.title}</span>
                        <span className="cal-ev-time">
                          {timeLabel(event.start)} – {timeLabel(event.end)}
                          {event.location && !short ? ` · ${event.location}` : ''}
                        </span>
                      </button>
                    );
                  })}
                  {isToday ? <span className="cal-now" style={{ top: (minutesNow / MINUTES_IN_DAY) * 24 * HOUR_PX }} aria-hidden="true" /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {single ? <Agenda day={days[0]} events={agenda} inMeetings={inMeetings} now={now} tags={tags} onEvent={onEvent} picked={picked} /> : null}
    </div>
  );
}

/** Beside the day: its meetings as a list, the one on now marked. */
function Agenda({ day, events, inMeetings, now, tags, onEvent, picked }: { day: Date; events: CalendarEvent[]; inMeetings: number; now: Date; tags: Map<string, Project>; onEvent: (event: CalendarEvent, target: HTMLElement) => void; picked?: string }) {
  const hours = Math.floor(inMeetings / 60);
  const minutes = Math.round(inMeetings % 60);
  const inMeetingsLabel = inMeetings ? `${hours ? `${hours} h` : ''}${hours && minutes ? ' ' : ''}${minutes ? `${minutes} min` : ''} in meetings` : null;
  const isToday = sameDay(day, now);
  return (
    <aside className="cal-agenda" aria-label="Scheduled">
      <h3>
        {isToday ? 'Today' : day.toLocaleDateString(undefined, { weekday: 'long' })}
        <small>{events.length === 0 ? 'nothing scheduled' : `${events.length} ${events.length === 1 ? 'event' : 'events'}${inMeetingsLabel ? ` · ${inMeetingsLabel}` : ''}`}</small>
      </h3>
      {events.length === 0 ? <p className="cal-agenda-free">The day is yours.</p> : null}
      {events.map((event) => {
        const onNow = isToday && !event.allDay && event.start <= now && event.end > now;
        const past = isToday && event.end <= now;
        return (
          <button key={event.id} type="button" className={`cal-agenda-row${onNow ? ' is-now' : ''}${past ? ' is-past' : ''}${picked === event.id ? ' is-picked' : ''}${event.response === 'declined' ? ' is-declined' : ''}`} style={colorStyle(event)} onClick={(click) => onEvent(event, click.currentTarget)}>
            <span className="cal-agenda-when">
              {event.allDay || !onDay(event, day) ? 'All day' : <>{timeLabel(event.start)}<small>{durationLabel(event)}</small></>}
            </span>
            <span className="cal-agenda-what">
              <b>{event.title}</b>
              {event.location ? <small>{event.location}</small> : null}
              <Tag project={tags.get(event.id)} named />
              {onNow ? <em>now</em> : null}
            </span>
            {event.meet ? (
              <a className="cal-join" href={event.meet} target="_blank" rel="noreferrer" onClick={(click) => (click.stopPropagation(), joinMeeting(event, tags.get(event.id)?.id ?? null))} title="Join the video call">
                <VideoIcon size={14} />
                Join
              </a>
            ) : null}
          </button>
        );
      })}
    </aside>
  );
}

const RESPONSES: Record<string, string> = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', needsAction: 'Not answered' };

/** One meeting, in a card beside what was clicked: when, where, who, the link to join and the event in Google Calendar. */
function EventCard({
  picked,
  calendar,
  projects,
  project,
  onTag,
  onOpenProject,
  onEdit,
  onDelete,
  onRespond,
  responding,
  granolaKey,
  onOpenSettings,
  onClose,
}: {
  picked: Picked;
  calendar?: CalendarInfo;
  projects: Project[];
  /** The project the meeting is tagged with now. */
  project?: Project;
  onTag: (projectId: string | null, series: boolean) => void;
  onOpenProject?: (id: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRespond: (response: Rsvp) => void;
  responding: boolean;
  /** Whether a Granola key is set, to read the notes back with. */
  granolaKey: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const { event, anchor } = picked;
  const writable = Boolean(calendar?.writable);
  const card = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  /** For a meeting that repeats: whether the tag goes on every one in the series (the usual want) or this one alone. */
  const [series, setSeries] = useState(Boolean(event.seriesId));
  useEffect(() => {
    const away = (press: PointerEvent) => {
      if (!card.current?.contains(press.target as Node)) onClose();
    };
    // After this click has finished, so the click that opened the card does not close it.
    const timer = window.setTimeout(() => window.addEventListener('pointerdown', away), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', away);
    };
  }, [onClose]);
  const WIDTH = 340;
  const HEIGHT = 480;
  const room = typeof window === 'undefined' ? { w: 1200, h: 800 } : { w: window.innerWidth, h: window.innerHeight };
  const left = anchor.right + WIDTH + 12 < room.w ? anchor.right + 8 : Math.max(8, anchor.left - WIDTH - 8);
  const top = Math.max(8, Math.min(anchor.top, room.h - HEIGHT - 8));
  const going = event.attendees.filter((attendee) => attendee.response === 'accepted').length;
  const stop = (click: ReactMouseEvent) => click.stopPropagation();
  return (
    <div ref={card} className="cal-card" role="dialog" aria-label={event.title} style={{ ...colorStyle(event), left, top, width: WIDTH }}>
      <button type="button" className="icon-btn sm cal-card-close" onClick={onClose} aria-label="Close">
        <CloseIcon size={14} />
      </button>
      <h3>{event.title}</h3>
      <p className="cal-card-when">
        {whenLabel(event)}
        {!event.allDay ? <small>{durationLabel(event)}</small> : null}
      </p>
      {event.location ? (
        <p className="cal-card-line">
          <PinIcon size={14} />
          <span>{event.location}</span>
        </p>
      ) : null}
      {event.attendees.length ? (
        <p className="cal-card-line">
          <PeopleIcon size={14} />
          <span>
            {event.attendees.length} {event.attendees.length === 1 ? 'guest' : 'guests'}
            {going ? ` · ${going} going` : ''}
            {event.organizer ? ` · from ${event.organizer}` : ''}
          </span>
        </p>
      ) : null}
      <p className="cal-card-line is-meta">
        <i className="cal-card-dot" />
        <span>
          {calendar?.name ?? 'Calendar'}
          {event.response ? ` · ${RESPONSES[event.response]}` : ''}
        </span>
      </p>
      {/* The "Join Zoom:" line this page writes is the Join button's, not something to read twice. */}
      {event.description?.replace(/^Join Zoom: \S+\s*/, '').trim() ? <p className="cal-card-desc">{event.description.replace(/^Join Zoom: \S+\s*/, '').replace(/<[^>]+>/g, '').slice(0, 400)}</p> : null}
      {event.response && writable ? (
        <div className="cal-card-rsvp">
          <span className="cal-card-rsvp-cap">Going?</span>
          <div className="segmented sm" role="radiogroup" aria-label="Your answer" aria-busy={responding}>
            {(
              [
                ['accepted', 'Yes'],
                ['tentative', 'Maybe'],
                ['declined', 'No'],
              ] as const
            ).map(([response, label]) => (
              <button key={response} type="button" role="radio" aria-checked={event.response === response} disabled={responding} onClick={() => onRespond(response)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="cal-card-project">
        <button
          type="button"
          className={`cal-card-tag${project ? ' is-on' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          title={project ? `${project.name} — change the project this meeting is for` : 'Tag this meeting with the project it is for'}
          onClick={() => setMenu(!menu)}
        >
          {project ? (
            <span className="pj-mark sm" style={{ background: project.color }}>
              {initialsOf(project.name)}
            </span>
          ) : (
            <span className="pj-mark sm cal-tag-none">＋</span>
          )}
          <span className="cal-card-tag-name">{project ? project.name : 'Add to a project'}</span>
          <span className="cal-card-tag-chev">⌄</span>
        </button>
        {project && onOpenProject ? (
          <button type="button" className="link-btn cal-card-open" onClick={() => onOpenProject(project.id)}>
            Open project
          </button>
        ) : null}
        {event.seriesId ? (
          <div className="segmented sm cal-card-series" role="radiogroup" aria-label="Tag which meetings">
            <button type="button" role="radio" aria-checked={series} onClick={() => setSeries(true)} title="The tag goes on every meeting in this series">
              Whole series
            </button>
            <button type="button" role="radio" aria-checked={!series} onClick={() => setSeries(false)} title="The tag goes on this meeting alone">
              This one only
            </button>
          </div>
        ) : null}
        {menu ? (
          <div className="nav-pmenu cal-pmenu" role="menu" aria-label="Projects">
            <span className="nav-pmenu-head">{event.seriesId && series ? 'Every one of these is for' : 'This meeting is for'}</span>
            {projects.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.id === project?.id}
                className={item.id === project?.id ? 'is-on' : undefined}
                onClick={() => {
                  onTag(item.id, series);
                  setMenu(false);
                }}
              >
                <span className="nav-pmenu-sq" style={{ background: item.color }} />
                <span className="nav-pmenu-name">{item.name}</span>
              </button>
            ))}
            {projects.length === 0 ? <span className="cal-pmenu-none">No projects yet. Start one on the Projects page, and tag your meetings with it here.</span> : null}
            <span className="nav-pmenu-line" />
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!project}
              className="is-quiet"
              onClick={() => {
                onTag(null, series);
                setMenu(false);
              }}
            >
              ○ No project
            </button>
          </div>
        ) : null}
      </div>
      {event.notetaker || project ? <NotesLine event={event} project={project} hasKey={granolaKey} onOpenProject={onOpenProject} onOpenSettings={onOpenSettings} /> : null}
      <div className="cal-card-actions">
        {event.meet ? (
          <a className="btn primary sm" href={event.meet} target="_blank" rel="noreferrer" onClick={(click) => (stop(click), joinMeeting(event, project?.id ?? null))} title={`Join the ${CALL_NAMES[event.callKind ?? 'video']} call`}>
            <VideoIcon size={14} />
            {event.callKind && event.callKind !== 'video' ? `Join ${CALL_NAMES[event.callKind].replace('Google ', '')}` : 'Join'}
          </a>
        ) : null}
        {event.link ? (
          <a className="btn sm" href={event.link} target="_blank" rel="noreferrer" onClick={stop}>
            <ExternalIcon size={13} />
            Open in Google Calendar
          </a>
        ) : null}
        {writable ? (
          <>
            <span style={{ flexGrow: 1 }} />
            <button type="button" className="btn sm" onClick={onEdit} title="Change this event">
              Edit
            </button>
            <button type="button" className="icon-btn sm cal-card-delete" onClick={onDelete} aria-label="Delete this event" title={event.seriesId ? 'Delete this one — the rest of the series stays' : 'Delete this event'}>
              <TrashIcon size={14} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

const NotesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4" />
  </svg>
);

/**
 * What becomes of a meeting's notes, on its card: Granola taking them, and
 * where they go — or, once the meeting is over, that they are filed, with the
 * way to them; or what is missing for them to be.
 */
function NotesLine({ event, project, hasKey, onOpenProject, onOpenSettings }: { event: CalendarEvent; project?: Project; hasKey: boolean; onOpenProject?: (id: string, section?: string) => void; onOpenSettings: () => void }) {
  const { log, status } = useLogbook(project);
  const filed = project && status === 'ready' ? log.notes.find((note) => note.meeting === event.id) : undefined;
  // A meeting not set to notes on the calendar has a line only once notes were taken of it (Join, or the offer).
  if (!event.notetaker && !filed) return null;
  const over = event.end.getTime() < Date.now();
  const reader = event.notetaker === 'reader';
  const app = inDesktopApp();
  const recorder = Boolean(recorderBridge());
  let said: ReactNode;
  if (filed) said = <>Notes filed in <b>{project!.name}</b>{filed.source === 'granola' ? ' from Granola' : filed.source === 'reader' ? ', recorded by Reader' : ''}.</>;
  else if (reader && !project) said = <>Reader takes notes on your computer. Tag a project below and they are filed in its logbook.</>;
  else if (reader && !isHost(event)) said = <>Only the meeting’s host{event.organizer ? `, ${event.organizer},` : ''} records it with Reader; the notes are filed in <b>{project!.name}</b> for everyone in the project, you included.</>;
  else if (reader && over) said = <>No notes were filed for this meeting: Reader records it only while the Reader app is open on a computer in the call.</>;
  else if (reader && !app) said = <>Reader takes notes in the <b>Reader app</b> on your Mac or PC — no bot joins — and files them in <b>{project!.name}</b>. Have it open when the meeting starts.</>;
  else if (reader && !recorder) said = <>Reader’s notes need the Reader app on a Mac or a Windows PC; this computer cannot record meetings.</>;
  else if (reader) said = <>Reader will take notes on this computer when the meeting opens — no bot joins — and file them in <b>{project!.name}</b>.</>;
  else if (!project) said = <>Granola is taking notes. Tag a project below and they are filed in its logbook when the meeting ends.</>;
  else if (!hasKey) said = <>Granola is taking notes. Add your Granola key in Settings and they are filed in <b>{project.name}</b> when it ends.</>;
  else if (over) said = <>Waiting for Granola’s notes; they are filed in <b>{project.name}</b> as soon as Granola has them.</>;
  else said = <>Granola will take notes, filed in <b>{project.name}</b> when it ends — for everyone in the project.</>;
  return (
    <div className={`cal-card-notes${filed ? ' is-filed' : ''}`}>
      {reader ? <span className="cal-reader-mark" aria-hidden="true">R</span> : <span className="cal-granola" aria-hidden="true">G</span>}
      <span className="cal-card-notes-text">{said}</span>
      {filed && project && onOpenProject ? (
        <button type="button" className="link-btn" onClick={() => onOpenProject(project.id, 'meetings')}>
          Open notes
        </button>
      ) : reader && !app && project ? (
        <a className="link-btn" href={DESKTOP_RELEASES} target="_blank" rel="noreferrer">
          Get the app
        </a>
      ) : !reader && !hasKey && project ? (
        <button type="button" className="link-btn" onClick={onOpenSettings}>
          Settings
        </button>
      ) : null}
    </div>
  );
}

/** The editor: a new event, or one being changed. Saves to Google; the page shows the result. */
function EventEditor({
  editing,
  calendars,
  projects,
  zoomRoom,
  onProject,
  busy,
  error,
  onChange,
  onSave,
  onDelete,
  onCancel,
}: {
  editing: { draft: EventDraft; of?: CalendarEvent; projectId: string | null };
  /** The calendars it may go on: the writable ones. */
  calendars: CalendarInfo[];
  /** The projects it may be for, and the person's own Zoom room. */
  projects: Project[];
  zoomRoom: string;
  onProject: (projectId: string | null) => void;
  busy: boolean;
  error: string | null;
  onChange: (draft: EventDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
  onCancel: () => void;
}) {
  const { draft, of } = editing;
  const set = (change: Partial<EventDraft>) => onChange({ ...draft, ...change });
  // A Zoom meeting made by the Worker, when it has Zoom's credentials (lib/zoom.ts).
  const [zoomMaker, setZoomMaker] = useState(false);
  const [making, setMaking] = useState<string | null>(null);
  useEffect(() => {
    void canMakeZoom().then(setZoomMaker);
  }, []);
  const makeZoom = async () => {
    setMaking('Making a Zoom meeting…');
    try {
      const made = await makeZoomMeeting(draft);
      set({ call: 'zoom', zoom: made.url });
      setMaking(made.passcode ? `Made. Passcode ${made.passcode} — it is in the link.` : null);
    } catch (failure) {
      setMaking(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const project = projects.find((item) => item.id === editing.projectId);
  const minutes = (draft.end.getTime() - draft.start.getTime()) / 60_000;
  /** All day shows an inclusive last day; the draft's end stays exclusive. */
  const lastDay = addDays(draft.end, -1);
  const setStart = (next: Date) => set({ start: next, end: new Date(next.getTime() + Math.max(draft.allDay ? 24 * 60 : 15, minutes) * 60_000) });
  const toggleAllDay = (allDay: boolean) => {
    if (allDay) set({ allDay, start: startOfDay(draft.start), end: addDays(startOfDay(draft.end > startOfDay(addDays(draft.start, 1)) ? addDays(draft.end, -1) : draft.start), 1) });
    else {
      const start = new Date(draft.start.getFullYear(), draft.start.getMonth(), draft.start.getDate(), 9);
      set({ allDay, start, end: new Date(start.getTime() + 60 * 60_000) });
    }
  };
  return (
    <div
      className="cal-editor-shade"
      onPointerDown={(press) => {
        if (press.target === press.currentTarget) onCancel();
      }}
    >
      <form
        className="cal-editor"
        role="dialog"
        aria-label={of ? 'Edit event' : 'New event'}
        onSubmit={(submit) => {
          submit.preventDefault();
          onSave();
        }}
        onKeyDown={(key) => {
          if (key.key === 'Escape') onCancel();
        }}
      >
        <h3>{of ? 'Edit event' : 'New event'}</h3>
        <input className="cal-editor-title" placeholder="Title" value={draft.title} onChange={(change) => set({ title: change.target.value })} autoFocus aria-label="Title" />
        <div className="cal-editor-when">
          <input type="date" value={dayKey(draft.start)} onChange={(change) => change.target.value && setStart(atKeys(change.target.value, draft.allDay ? '00:00' : timeKey(draft.start)))} aria-label="Date" />
          {draft.allDay ? (
            <>
              <span className="cal-editor-to">to</span>
              <input type="date" value={dayKey(lastDay)} min={dayKey(draft.start)} onChange={(change) => change.target.value && set({ end: addDays(atKeys(change.target.value), 1) })} aria-label="Last day" />
            </>
          ) : (
            <>
              <input type="time" value={timeKey(draft.start)} step={300} onChange={(change) => change.target.value && setStart(atKeys(dayKey(draft.start), change.target.value))} aria-label="Start time" />
              <span className="cal-editor-to">–</span>
              <input type="time" value={timeKey(draft.end)} step={300} onChange={(change) => change.target.value && set({ end: atKeys(dayKey(draft.start), change.target.value) })} aria-label="End time" />
            </>
          )}
          <label className="cal-editor-allday">
            <input type="checkbox" checked={draft.allDay} onChange={(change) => toggleAllDay(change.target.checked)} />
            All day
          </label>
        </div>
        <div className="cal-editor-row">
          <select value={draft.calendarId} onChange={(change) => set({ calendarId: change.target.value })} aria-label="Calendar">
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
          <input placeholder="Where" value={draft.location} onChange={(change) => set({ location: change.target.value })} aria-label="Where" />
        </div>
        <textarea placeholder="Notes" rows={3} value={draft.description} onChange={(change) => set({ description: change.target.value })} aria-label="Notes" />
        <div className="cal-editor-call">
          <span className="cal-editor-cap">
            <VideoIcon size={14} />
            Video call
          </span>
          <div className="segmented sm" role="radiogroup" aria-label="Video call">
            {(
              [
                ['none', 'None'],
                ['meet', 'Google Meet'],
                ['zoom', 'Zoom'],
              ] as const
            ).map(([call, label]) => (
              <button key={call} type="button" role="radio" aria-checked={draft.call === call} onClick={() => set({ call, ...(call === 'zoom' && !draft.zoom && zoomRoom ? { zoom: zoomRoom } : {}) })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {draft.call === 'meet' && of?.callKind !== 'meet' ? <p className="cal-editor-note">Google makes the Meet call when you save, and its link goes on the event.</p> : null}
        {draft.call === 'zoom' ? (
          <div className="cal-editor-zoom">
            <input placeholder="Zoom link — zoom.us/j/… or zoom.us/my/…" value={draft.zoom} onChange={(change) => set({ zoom: change.target.value })} aria-label="Zoom link" aria-invalid={Boolean(draft.zoom.trim()) && !zoomLink(draft.zoom)} />
            {zoomRoom && draft.zoom !== zoomRoom ? (
              <button type="button" className="btn sm" onClick={() => set({ zoom: zoomRoom })} title={zoomRoom}>
                Use my room
              </button>
            ) : null}
            {zoomMaker ? (
              <button type="button" className="btn sm" onClick={() => void makeZoom()} disabled={making === 'Making a Zoom meeting…'} title="A new Zoom meeting at this time, made by the site’s Zoom account">
                Make one
              </button>
            ) : null}
            {making ? <small className="cal-editor-note">{making}</small> : null}
          </div>
        ) : null}
        <div className="cal-editor-call">
          <span className="cal-editor-cap">
            <NotesIcon />
            Notes
          </span>
          <div className="segmented sm" role="radiogroup" aria-label="Notes">
            {(
              [
                ['none', 'Off', 'Nobody takes notes'],
                ['reader', 'Reader', 'Reader’s desktop app records the meeting on your computer — no bot joins the call — and writes the notes up'],
                ['granola', 'Granola', 'Granola, on your computer, takes the notes; Reader reads them back with your Granola key'],
              ] as const
            ).map(([notes, label, title]) => (
              <button key={notes} type="button" role="radio" aria-checked={draft.notes === notes} onClick={() => set({ notes })} title={title}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="cal-editor-call">
          <span className="cal-editor-cap">
            <span className="pj-mark sm" style={{ background: project?.color ?? 'var(--border)' }} aria-hidden="true" />
            Project
          </span>
          <select className="cal-editor-project" value={editing.projectId ?? ''} onChange={(change) => onProject(change.target.value || null)} aria-label="Project">
            <option value="">No project</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {draft.notes !== 'none' ? (
          <p className="cal-editor-note">
            {draft.notes === 'reader' ? (
              <>Reader records it on your computer when it starts — in the Reader app for Mac or Windows, with no bot in the call — and writes it up. </>
            ) : (
              <>Granola takes the notes on your computer; Reader reads them back when it ends. </>
            )}
            {project ? (
              <>
                The notes are filed in <b>{project.name}</b> → Logbook → Meetings{project.project.shared ? ', for everyone in the project' : ''}.
              </>
            ) : (
              'Pick the project it is for, and the notes are filed there.'
            )}
          </p>
        ) : null}
        {of?.seriesId ? <p className="cal-editor-note">This is one meeting of a series: the change is to this one only, and the rest of the series stays as it is.</p> : null}
        {error ? <p className="banner error">{error}</p> : null}
        <div className="cal-editor-actions">
          {onDelete ? (
            <button type="button" className="btn sm cal-editor-delete" onClick={onDelete} disabled={busy}>
              Delete
            </button>
          ) : null}
          <span style={{ flexGrow: 1 }} />
          <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
