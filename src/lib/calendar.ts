// The Calendar page's workings: the days a view shows, the meetings read from
// Google Calendar for them, and where each goes on the grid. Nothing here
// touches the DOM; Calendar.tsx draws what this works out, and
// scripts/calendar.test.mjs pins the arithmetic.
//
// The page reads calendars only (`CALENDAR_SCOPE` in google.ts is read-only):
// the account's calendar list, and the events of each in the span on screen,
// with recurring ones already expanded by Google (`singleEvents`).

export type CalendarView = 'day' | 'week' | 'month';

export const VIEWS: { id: CalendarView; label: string; key: string }[] = [
  { id: 'day', label: 'Day', key: 'D' },
  { id: 'week', label: 'Week', key: 'W' },
  { id: 'month', label: 'Month', key: 'M' },
];

/** One of the account's calendars, as the page tells them apart. */
export interface CalendarInfo {
  id: string;
  name: string;
  /** Google's colour for it, a hex string. */
  color: string;
  primary: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: Date;
  /** Exclusive: an all-day event on the 3rd runs from the 3rd to the 4th. */
  end: Date;
  allDay: boolean;
  location?: string;
  /** A Google Meet (or other conferencing) link, when the meeting has one. */
  meet?: string;
  /** The event in Google Calendar. */
  link?: string;
  description?: string;
  /** Who was invited, besides the person, and whether they have answered. */
  attendees: { name: string; email: string; response: Response; self: boolean }[];
  /** The person's own answer, when they were invited. */
  response?: Response;
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** The calendar's colour, or the event's own when it was given one. */
  color: string;
  organizer?: string;
  /** For one meeting of a repeating series: the series' id, so a tag can be put on every one of them. */
  seriesId?: string;
}

/** The key a tag on a meeting's whole series is kept under on a project; null for a meeting that does not repeat. */
export const seriesKey = (event: CalendarEvent): string | null => (event.seriesId ? `${event.calendarId}:${event.seriesId}` : null);

/** The keys a project may hold a tag for this meeting under: the meeting's own first, then its series'. */
export const tagKeys = (event: CalendarEvent): string[] => {
  const series = seriesKey(event);
  return series ? [event.id, series] : [event.id];
};

export type Response = 'accepted' | 'declined' | 'tentative' | 'needsAction';

/** A timed event placed on a day's column: minutes from midnight, and which of the overlapping columns it takes. */
export interface Placed {
  event: CalendarEvent;
  top: number;
  height: number;
  column: number;
  columns: number;
}

export interface Span {
  start: Date;
  /** Exclusive. */
  end: Date;
}

// ------------------------------------------------------------------ days ---

export const MINUTES_IN_DAY = 24 * 60;

export const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const addDays = (date: Date, days: number): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());

export const addMonths = (date: Date, months: number): Date => {
  // The same day of the month where it exists; the month's last day where it does not (31 January → 28 February).
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last));
};

export const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const sameMonth = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

/** A day as `YYYY-MM-DD` in local time: a key, and what Google is asked for an all-day event by. */
export const dayKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * The day the week starts on where the person is, as `Date.getDay` counts
 * (0 Sunday … 6 Saturday): Monday over most of the world, Sunday in the US,
 * India and others. From the browser's locale, where it says; Sunday when it
 * does not.
 */
export function firstWeekday(locale: string = typeof navigator === 'undefined' ? 'en-US' : navigator.language): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    if (first) return first % 7; // Intl counts Monday 1 … Sunday 7
  } catch {
    // an unknown locale
  }
  return 0;
}

export function startOfWeek(date: Date, firstDay: number): Date {
  const day = startOfDay(date);
  const back = (day.getDay() - firstDay + 7) % 7;
  return addDays(day, -back);
}

/** The days a view shows around `date`: one, its week, or its month's grid of six weeks. */
export function spanFor(view: CalendarView, date: Date, firstDay: number): Span {
  if (view === 'day') {
    const start = startOfDay(date);
    return { start, end: addDays(start, 1) };
  }
  if (view === 'week') {
    const start = startOfWeek(date, firstDay);
    return { start, end: addDays(start, 7) };
  }
  const start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1), firstDay);
  return { start, end: addDays(start, 42) };
}

/** Every day in a span, in order. */
export function daysIn(span: Span): Date[] {
  const days: Date[] = [];
  for (let day = startOfDay(span.start); day < span.end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The same view a step on, or back. */
export function step(view: CalendarView, date: Date, direction: 1 | -1): Date {
  if (view === 'day') return addDays(date, direction);
  if (view === 'week') return addDays(date, 7 * direction);
  return addMonths(date, direction);
}

const MONTH_YEAR: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };

/** What the head of the page says the view is of. */
export function periodLabel(view: CalendarView, date: Date, firstDay: number, locale?: string): string {
  if (view === 'month') return date.toLocaleDateString(locale, MONTH_YEAR);
  if (view === 'day') return date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const { start, end } = spanFor('week', date, firstDay);
  const last = addDays(end, -1);
  // The locale's own way of writing a span of days: "October 12 – 18, 2026" in the US, "12–18 October 2026" in Britain.
  const form = new Intl.DateTimeFormat(locale, { day: 'numeric', month: sameMonth(start, last) ? 'long' : 'short', year: 'numeric' });
  return form.formatRange(start, last);
}

export const timeLabel = (date: Date, locale?: string): string => date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }).replace(/:00(?=\s?[ap]m)/i, '');

/** An hour of the day as the time axis names it. */
export const hourLabel = (hour: number, locale?: string): string => new Date(2000, 0, 1, hour).toLocaleTimeString(locale, { hour: 'numeric' }).replace(/:00/, '');

/** How long an event runs, said. */
export function durationLabel(event: CalendarEvent): string {
  if (event.allDay) {
    const days = Math.round((event.end.getTime() - event.start.getTime()) / 86_400_000);
    return days > 1 ? `${days} days` : 'All day';
  }
  const minutes = Math.round((event.end.getTime() - event.start.getTime()) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** When an event is, for its card: the day where it is not the one on screen, then the times. */
export function whenLabel(event: CalendarEvent, locale?: string): string {
  const day = event.start.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  if (event.allDay) {
    const days = Math.round((event.end.getTime() - event.start.getTime()) / 86_400_000);
    return days > 1 ? `${day} – ${addDays(event.end, -1).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}` : day;
  }
  return `${day} · ${timeLabel(event.start, locale)} – ${timeLabel(event.end, locale)}`;
}

// ---------------------------------------------------------------- events ---

/** Whether an event has any of a day. */
export const onDay = (event: CalendarEvent, day: Date): boolean => {
  const start = startOfDay(day);
  const end = addDays(start, 1);
  return event.start < end && event.end > start;
};

export const eventsOn = (events: CalendarEvent[], day: Date): CalendarEvent[] => events.filter((event) => onDay(event, day));

/** Whether an event takes the all-day row of a day view: all-day, or running past midnight. */
export const spansDays = (event: CalendarEvent): boolean => event.allDay || !sameDay(event.start, new Date(event.end.getTime() - 1));

const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime() || a.title.localeCompare(b.title);

export const sortEvents = (events: CalendarEvent[]): CalendarEvent[] => [...events].sort(byStart);

const minutesInto = (date: Date, day: Date) => Math.max(0, Math.min(MINUTES_IN_DAY, (date.getTime() - startOfDay(day).getTime()) / 60_000));

/**
 * The timed events of a day laid side by side where they overlap, the way
 * every calendar does it: events are taken in order of start, each goes in
 * the first column free at its start, and a run of events that touch shares
 * its width between the columns it needed. An event is drawn at least a
 * quarter of an hour tall, so a ten-minute one can still be read.
 */
export function placeTimed(events: CalendarEvent[], day: Date, minHeight = 15): Placed[] {
  const timed = sortEvents(events.filter((event) => !spansDays(event) && onDay(event, day)));
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let columnEnds: number[] = [];
  let groupEnd = -1;
  const close = () => {
    const columns = columnEnds.length;
    for (const item of group) item.columns = columns;
    group = [];
    columnEnds = [];
  };
  for (const event of timed) {
    const top = minutesInto(event.start, day);
    const bottom = Math.max(top + minHeight, minutesInto(event.end, day));
    if (group.length && top >= groupEnd) close();
    let column = columnEnds.findIndex((end) => end <= top);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(bottom);
    } else columnEnds[column] = bottom;
    const item: Placed = { event, top, height: bottom - top, column, columns: 1 };
    group.push(item);
    placed.push(item);
    groupEnd = Math.max(groupEnd, bottom);
  }
  if (group.length) close();
  return placed;
}

/** Google's event palette, by the `colorId` an event can carry. */
const EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb',
  '2': '#33b679',
  '3': '#8e24aa',
  '4': '#e67c73',
  '5': '#f6bf26',
  '6': '#f4511e',
  '7': '#039be5',
  '8': '#616161',
  '9': '#3f51b5',
  '10': '#0b8043',
  '11': '#d50000',
};

interface GoogleDateTime {
  dateTime?: string;
  date?: string;
}

interface GoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
}

/** As much of Google's event as the page reads. */
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  colorId?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  attendees?: GoogleAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  eventType?: string;
  recurringEventId?: string;
}

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  accessRole?: string;
}

const localDay = (iso: string): Date => {
  // An all-day event's date is a calendar day, not an instant: `new Date('2026-10-13')` would be midnight UTC.
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
};

const response = (status: string | undefined): Response | undefined =>
  status === 'accepted' || status === 'declined' || status === 'tentative' || status === 'needsAction' ? status : undefined;

/** One of Google's events as the page holds it; null for one it cannot place (no times) or that was cancelled. */
export function parseEvent(item: GoogleEvent, calendar: CalendarInfo): CalendarEvent | null {
  if (item.status === 'cancelled') return null;
  const allDay = Boolean(item.start?.date);
  const startAt = allDay ? item.start?.date : item.start?.dateTime;
  const endAt = allDay ? item.end?.date : item.end?.dateTime;
  if (!startAt) return null;
  const start = allDay ? localDay(startAt) : new Date(startAt);
  const end = endAt ? (allDay ? localDay(endAt) : new Date(endAt)) : allDay ? addDays(start, 1) : new Date(start.getTime() + 30 * 60_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const people = (item.attendees ?? []).filter((attendee) => !attendee.resource);
  const self = people.find((attendee) => attendee.self);
  const meet = item.hangoutLink || item.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri;
  return {
    id: `${calendar.id}:${item.id}`,
    calendarId: calendar.id,
    title: item.summary?.trim() || '(No title)',
    start,
    end: end > start ? end : allDay ? addDays(start, 1) : new Date(start.getTime() + 30 * 60_000),
    allDay,
    location: item.location?.trim() || undefined,
    meet: meet || undefined,
    link: item.htmlLink,
    description: item.description?.trim() || undefined,
    attendees: people.map((attendee) => ({
      name: attendee.displayName || attendee.email || '',
      email: attendee.email || '',
      response: response(attendee.responseStatus) ?? 'needsAction',
      self: Boolean(attendee.self),
    })),
    response: self ? response(self.responseStatus) : undefined,
    status: item.status === 'tentative' ? 'tentative' : 'confirmed',
    color: (item.colorId && EVENT_COLORS[item.colorId]) || calendar.color,
    organizer: item.organizer?.displayName || item.organizer?.email,
    ...(item.recurringEventId ? { seriesId: item.recurringEventId } : {}),
  };
}

export function parseCalendar(entry: GoogleCalendarListEntry): CalendarInfo {
  return {
    id: entry.id,
    name: entry.summaryOverride?.trim() || entry.summary?.trim() || entry.id,
    color: entry.backgroundColor || '#1f5e52',
    primary: Boolean(entry.primary),
  };
}

// ------------------------------------------------------------------- API ---

const API = 'https://www.googleapis.com/calendar/v3';

/** A refusal from Google Calendar, with the status kept where the page can read it: 401 and 403 mean the grant, not the network. */
export class CalendarRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarRequestError';
  }
}

async function get<T>(token: string, url: string): Promise<T> {
  const answer = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!answer.ok) {
    let detail = '';
    try {
      const body = (await answer.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? '';
    } catch {
      // not JSON
    }
    throw new CalendarRequestError(answer.status, detail || `Google Calendar answered ${answer.status}`);
  }
  return (await answer.json()) as T;
}

/**
 * The account's calendars, as Google lists them for the person: the ones
 * they have not hidden there, with the primary first.
 */
export async function fetchCalendars(token: string): Promise<CalendarInfo[]> {
  const calendars: CalendarInfo[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ minAccessRole: 'reader', showHidden: 'false', maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await get<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(token, `${API}/users/me/calendarList?${params}`);
    for (const entry of page.items ?? []) if (!entry.hidden && entry.selected !== false) calendars.push(parseCalendar(entry));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** Every event of one calendar in a span, recurrences expanded, in order of start. */
export async function fetchEvents(token: string, calendar: CalendarInfo, span: Span): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: span.start.toISOString(),
      timeMax: span.end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await get<{ items?: GoogleEvent[]; nextPageToken?: string }>(token, `${API}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`);
    for (const item of page.items ?? []) {
      const event = parseEvent(item, calendar);
      if (event) events.push(event);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

/** The events of every calendar given, in a span, together and in order. A calendar that refuses is left out rather than failing the rest. */
export async function fetchAllEvents(token: string, calendars: CalendarInfo[], span: Span): Promise<{ events: CalendarEvent[]; refused: CalendarInfo[] }> {
  const refused: CalendarInfo[] = [];
  const lists = await Promise.all(
    calendars.map((calendar) =>
      fetchEvents(token, calendar, span).catch((error: unknown) => {
        // An expired or missing grant is for the caller to deal with; one calendar's refusal is not.
        if (error instanceof CalendarRequestError && (error.status === 401 || (error.status === 403 && calendar.primary))) throw error;
        refused.push(calendar);
        return [] as CalendarEvent[];
      }),
    ),
  );
  return { events: sortEvents(lists.flat()), refused };
}
