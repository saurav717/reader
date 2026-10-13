// The Calendar page: the signed-in account's Google Calendar, read and shown
// by day, week or month, with every meeting in the span on screen. A page of
// its own in the rail, like the Playground: the library and the dock step
// aside for it. The arithmetic — which days a view shows, where an event sits
// on the grid — is in lib/calendar.ts; reading the calendar is a scope asked
// for on its own the first time, as Colab's is (lib/google.ts).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../lib/store';
import * as google from '../lib/google';
import {
  CalendarRequestError,
  MINUTES_IN_DAY,
  VIEWS,
  addDays,
  dayKey,
  daysIn,
  durationLabel,
  eventsOn,
  fetchAllEvents,
  fetchCalendars,
  firstWeekday,
  hourLabel,
  onDay,
  periodLabel,
  placeTimed,
  sameDay,
  sameMonth,
  seriesKey,
  sortEvents,
  spanFor,
  spansDays,
  startOfDay,
  step,
  tagKeys,
  timeLabel,
  whenLabel,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarView,
  type Span,
} from '../lib/calendar';
import { initialsOf, meetingProject, projectInfo, projectsOf, withMeeting, type Project } from '../lib/projects';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, ExternalIcon, PeopleIcon, PinIcon, RestoreIcon, VideoIcon } from './icons';

const VIEW_KEY = 'reader.calendar.view';
const HIDDEN_KEY = 'reader.calendar.hidden';
/** That the calendar was connected once in this browser: the page then offers to reconnect quietly rather than to connect anew. */
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

const readHidden = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const wasConnected = (): boolean => {
  try {
    return localStorage.getItem(CONNECTED_KEY) === 'true';
  } catch {
    return false;
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
        localStorage.setItem(CONNECTED_KEY, 'true');
        tellAccess();
      })
      .catch((failure: unknown) => setError(message(failure)))
      .finally(() => setBusy(false));
  };
  const forget = () => {
    google.dropCalendar();
    localStorage.removeItem(CONNECTED_KEY);
    tellAccess();
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 12, marginTop: 10 }}>
      <CalendarIcon size={20} style={{ color: connected ? 'var(--accent)' : 'var(--muted)' }} />
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{connected ? 'Google Calendar connected' : 'Google Calendar not connected'}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          {connected
            ? 'Your meetings are on the Calendar page, by day, week or month. Read only: nothing here writes to your calendar.'
            : error || 'The Calendar page shows the meetings in this account’s calendars. Connecting asks Google for read access to them, once.'}
        </div>
      </div>
      {connected ? (
        <button type="button" className="btn sm" onClick={forget} title="Forget the calendar in this tab. Google’s grant stays until you take it away at myaccount.google.com/permissions">
          Forget
        </button>
      ) : (
        <button type="button" className="btn primary sm" onClick={connect} disabled={busy || !clientId}>
          {busy ? 'Connecting…' : wasConnected() ? 'Reconnect calendar' : 'Connect calendar'}
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

export default function Calendar({ onOpenSettings, onOpenProject }: { onOpenSettings: () => void; onOpenProject?: (id: string) => void }) {
  const { user, settings, collections, updateCollection } = useStore();
  const clientId = settings.googleClientId.trim();
  const connected = useCalendarAccess();
  const [view, setViewState] = useState<CalendarView>(readView);
  const [date, setDate] = useState<Date>(() => new Date());
  const [now, setNow] = useState<Date>(() => new Date());
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [hidden, setHiddenState] = useState<string[]>(readHidden);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
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
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      // only a preference
    }
  };

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
        localStorage.setItem(CONNECTED_KEY, 'true');
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
        return;
      }
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
  }, [view]);

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

  const pick = (event: CalendarEvent, target: HTMLElement) => setPicked({ event, anchor: target.getBoundingClientRect() });

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
          title={wasConnected() ? 'Reconnect your calendar' : 'See your meetings here'}
          text={
            wasConnected()
              ? `The sign-in for ${user.email} has to be renewed for the calendar. One click; Google asks nothing new.`
              : `Reader reads the calendars in ${user.email} — just reads: the calendars you keep and the meetings in them — and shows them by day, week or month. Connecting asks Google for read access, once.`
          }
          error={error}
          note={
            wasConnected()
              ? undefined
              : 'Reading a calendar is what Google calls a sensitive permission, so until this copy of Reader is verified with Google its window first says “Google hasn’t verified this app”: Advanced, then Go to Reader, lets you through to the usual consent screen.'
          }
          action={{ label: connecting ? 'Connecting…' : wasConnected() ? 'Reconnect calendar' : 'Connect Google Calendar', onClick: connect, disabled: connecting, primary: true }}
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
      {view === 'month' ? (
        <MonthGrid days={days} date={date} events={events} today={now} tags={tags} onDay={openDay} onEvent={pick} picked={picked?.event.id} />
      ) : (
        <TimeGrid days={days} events={events} now={now} tags={tags} onEvent={pick} picked={picked?.event.id} onDay={view === 'week' ? openDay : undefined} />
      )}
      {!shown && !loading && !error ? <div className="cal-blank">Reading your calendar…</div> : null}
      {picked ? (
        <EventCard
          picked={picked}
          calendar={calendars?.find((calendar) => calendar.id === picked.event.calendarId)}
          projects={projects}
          project={tags.get(picked.event.id)}
          onTag={(projectId, series) => tag(picked.event, projectId, series)}
          onOpenProject={onOpenProject}
          onClose={() => setPicked(null)}
        />
      ) : null}
    </div>
  );
}

function Empty({ title, text, error, note, action }: { title: string; text: string; error?: string | null; note?: string; action: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean } }) {
  return (
    <div className="scroll" style={{ padding: '18px 32px 32px' }}>
      <div className="cal-empty">
        <CalendarIcon size={28} />
        <h2>{title}</h2>
        <p>{text}</p>
        {error ? <p className="banner error">{error}</p> : null}
        <button type="button" className={`btn${action.primary ? ' primary' : ''}`} onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
        {note ? <p className="cal-empty-note">{note}</p> : null}
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
function MonthGrid({ days, date, events, today, tags, onDay, onEvent, picked }: { days: Date[]; date: Date; events: CalendarEvent[]; today: Date; tags: Map<string, Project>; onDay: (day: Date) => void; onEvent: (event: CalendarEvent, target: HTMLElement) => void; picked?: string }) {
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
            <div key={dayKey(day)} role="gridcell" className={`cal-month-cell${sameMonth(day, date) ? '' : ' is-outside'}${isToday ? ' is-today' : ''}`} aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}>
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
function TimeGrid({ days, events, now, tags, onEvent, picked, onDay }: { days: Date[]; events: CalendarEvent[]; now: Date; tags: Map<string, Project>; onEvent: (event: CalendarEvent, target: HTMLElement) => void; picked?: string; onDay?: (day: Date) => void }) {
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
                <div key={dayKey(day)} className={`cal-col${isToday ? ' is-today' : ''}`} role="group" aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}>
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
              <a className="cal-join" href={event.meet} target="_blank" rel="noreferrer" onClick={(click) => click.stopPropagation()} title="Join the video call">
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
  onClose,
}: {
  picked: Picked;
  calendar?: CalendarInfo;
  projects: Project[];
  /** The project the meeting is tagged with now. */
  project?: Project;
  onTag: (projectId: string | null, series: boolean) => void;
  onOpenProject?: (id: string) => void;
  onClose: () => void;
}) {
  const { event, anchor } = picked;
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
  const HEIGHT = 440;
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
      {event.description ? <p className="cal-card-desc">{event.description.replace(/<[^>]+>/g, '').slice(0, 400)}</p> : null}
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
      <div className="cal-card-actions">
        {event.meet ? (
          <a className="btn primary sm" href={event.meet} target="_blank" rel="noreferrer" onClick={stop}>
            <VideoIcon size={14} />
            Join
          </a>
        ) : null}
        {event.link ? (
          <a className="btn sm" href={event.link} target="_blank" rel="noreferrer" onClick={stop}>
            <ExternalIcon size={13} />
            Open in Google Calendar
          </a>
        ) : null}
      </div>
    </div>
  );
}
