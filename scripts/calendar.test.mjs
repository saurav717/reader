// The Calendar page's arithmetic: which days each view shows, how the views
// step, where overlapping meetings go on a day's column, what Google's event
// shapes become, and the page's address.
//
//   node --test scripts/calendar.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const cal = await load('src/lib/calendar.ts');
const route = await load('src/lib/route.ts');

after(cleanup);

const MONDAY = 1;
const SUNDAY = 0;
const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const calendar = { id: 'primary', name: 'Saurav', color: '#1f5e52', primary: true };
const ev = (title, start, end, extra = {}) => ({ id: title, calendarId: 'primary', title, start, end, allDay: false, attendees: [], status: 'confirmed', color: '#1f5e52', ...extra });

describe('the days a view shows', () => {
  it('a day is that day', () => {
    const span = cal.spanFor('day', d(2026, 10, 13, 15, 30), MONDAY);
    assert.deepEqual([span.start, span.end], [d(2026, 10, 13), d(2026, 10, 14)]);
    assert.equal(cal.daysIn(span).length, 1);
  });
  it('a week starts on the first weekday, whichever that is', () => {
    // 13 October 2026 is a Tuesday.
    assert.deepEqual(cal.spanFor('week', d(2026, 10, 13), MONDAY).start, d(2026, 10, 12));
    assert.deepEqual(cal.spanFor('week', d(2026, 10, 13), SUNDAY).start, d(2026, 10, 11));
    assert.equal(cal.daysIn(cal.spanFor('week', d(2026, 10, 13), MONDAY)).length, 7);
  });
  it('a month is six whole weeks from the week its first day is in', () => {
    const span = cal.spanFor('month', d(2026, 10, 13), MONDAY);
    assert.deepEqual(span.start, d(2026, 9, 28)); // 1 October 2026 is a Thursday
    assert.equal(cal.daysIn(span).length, 42);
    assert.deepEqual(cal.spanFor('month', d(2026, 11, 1), SUNDAY).start, d(2026, 11, 1)); // 1 November 2026 is a Sunday
  });
  it('steps by a day, a week or a month, and keeps the day of the month where it can', () => {
    assert.deepEqual(cal.step('day', d(2026, 10, 31), 1), d(2026, 11, 1));
    assert.deepEqual(cal.step('week', d(2026, 10, 13), -1), d(2026, 10, 6));
    assert.deepEqual(cal.step('month', d(2026, 10, 31), 1), d(2026, 11, 30));
    assert.deepEqual(cal.step('month', d(2026, 1, 31), 1), d(2026, 2, 28));
    assert.deepEqual(cal.step('month', d(2026, 12, 13), 1), d(2027, 1, 13));
  });
  it('names the period', () => {
    assert.equal(cal.periodLabel('month', d(2026, 10, 13), MONDAY, 'en-US'), 'October 2026');
    assert.match(cal.periodLabel('week', d(2026, 10, 13), MONDAY, 'en-US'), /^October 12\s*–\s*18, 2026$/);
    assert.match(cal.periodLabel('week', d(2026, 10, 13), MONDAY, 'en-GB'), /^12\s*–\s*18 October 2026$/);
    assert.match(cal.periodLabel('week', d(2026, 10, 31), MONDAY, 'en-US'), /^Oct 26\s*–\s*Nov 1, 2026$/);
    assert.match(cal.periodLabel('day', d(2026, 10, 13), MONDAY, 'en-US'), /Tuesday, October 13, 2026/);
  });
  it('reads the first weekday from the locale', () => {
    assert.equal(cal.firstWeekday('en-US'), 0);
    assert.equal(cal.firstWeekday('en-GB'), 1);
    assert.equal(cal.firstWeekday('not a locale at all'), 0);
  });
});

describe('placing meetings on a day', () => {
  const day = d(2026, 10, 13);
  it('a meeting takes the column alone when nothing overlaps it', () => {
    const placed = cal.placeTimed([ev('Standup', d(2026, 10, 13, 9, 30), d(2026, 10, 13, 10))], day);
    assert.deepEqual(placed.map(({ top, height, column, columns }) => ({ top, height, column, columns })), [{ top: 570, height: 30, column: 0, columns: 1 }]);
  });
  it('overlapping meetings share the width; the next free one has it back', () => {
    const placed = cal.placeTimed(
      [
        ev('A', d(2026, 10, 13, 9), d(2026, 10, 13, 10)),
        ev('B', d(2026, 10, 13, 9, 30), d(2026, 10, 13, 11)),
        ev('C', d(2026, 10, 13, 10), d(2026, 10, 13, 10, 30)),
        ev('D', d(2026, 10, 13, 14), d(2026, 10, 13, 15)),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((item) => [item.event.title, item]));
    assert.equal(by.A.column, 0);
    assert.equal(by.B.column, 1);
    assert.equal(by.C.column, 0); // A has ended, so C goes back to the first column
    assert.equal(by.A.columns, 2);
    assert.equal(by.C.columns, 2);
    assert.equal(by.D.column, 0);
    assert.equal(by.D.columns, 1);
  });
  it('a short meeting is drawn tall enough to read, and one past midnight is clipped to the day', () => {
    const placed = cal.placeTimed([ev('Ping', d(2026, 10, 13, 12), d(2026, 10, 13, 12, 5))], day);
    assert.equal(placed[0].height, 15);
    const late = cal.placeTimed([ev('Late', d(2026, 10, 12, 23), d(2026, 10, 13, 1))], day);
    assert.equal(late.length, 0, 'runs past midnight: the all-day row has it');
    assert.ok(cal.spansDays(ev('Late', d(2026, 10, 12, 23), d(2026, 10, 13, 1))));
    assert.ok(!cal.spansDays(ev('To midnight', d(2026, 10, 12, 23), d(2026, 10, 13, 0))));
  });
  it('all-day events and the day they are on', () => {
    const away = ev('Away', d(2026, 10, 13), d(2026, 10, 15), { allDay: true });
    assert.ok(cal.onDay(away, d(2026, 10, 14)));
    assert.ok(!cal.onDay(away, d(2026, 10, 15)));
    assert.equal(cal.durationLabel(away), '2 days');
    assert.equal(cal.durationLabel(ev('Call', d(2026, 10, 13, 9), d(2026, 10, 13, 10, 30))), '1 h 30 min');
  });
});

describe("Google's events", () => {
  it('a timed event, with its Meet link and who answered', () => {
    const event = cal.parseEvent(
      {
        id: 'abc',
        summary: ' Group meeting ',
        start: { dateTime: '2026-10-13T10:00:00+05:30' },
        end: { dateTime: '2026-10-13T11:00:00+05:30' },
        hangoutLink: 'https://meet.google.com/abc',
        htmlLink: 'https://calendar.google.com/event?eid=abc',
        location: 'Room 101',
        attendees: [
          { email: 'me@example.org', self: true, responseStatus: 'accepted' },
          { email: 'room@resource.calendar.google.com', resource: true },
          { email: 'advisor@example.org', displayName: 'Advisor', responseStatus: 'needsAction' },
        ],
        organizer: { email: 'advisor@example.org', displayName: 'Advisor' },
      },
      calendar,
    );
    assert.equal(event.title, 'Group meeting');
    assert.equal(event.id, 'primary:abc');
    assert.equal(event.allDay, false);
    assert.equal(event.start.getTime(), Date.parse('2026-10-13T04:30:00Z'));
    assert.equal(event.meet, 'https://meet.google.com/abc');
    assert.equal(event.response, 'accepted');
    assert.equal(event.attendees.length, 2, 'rooms are not guests');
    assert.equal(event.organizer, 'Advisor');
    assert.equal(event.color, '#1f5e52');
  });
  it('one meeting of a series knows its series, and is tagged under either key', () => {
    const one = cal.parseEvent({ id: 'abc_20261013T043000Z', recurringEventId: 'abc', summary: 'Group meeting', start: { dateTime: '2026-10-13T10:00:00+05:30' }, end: { dateTime: '2026-10-13T11:00:00+05:30' } }, calendar);
    assert.equal(one.seriesId, 'abc');
    assert.equal(cal.seriesKey(one), 'primary:abc');
    assert.deepEqual(cal.tagKeys(one), ['primary:abc_20261013T043000Z', 'primary:abc']);
    const once = cal.parseEvent({ id: 'xyz', summary: 'Lunch', start: { dateTime: '2026-10-13T12:00:00+05:30' }, end: { dateTime: '2026-10-13T13:00:00+05:30' } }, calendar);
    assert.equal(once.seriesId, undefined);
    assert.equal(cal.seriesKey(once), null);
    assert.deepEqual(cal.tagKeys(once), ['primary:xyz']);
  });
  it('an all-day event is a local day, not midnight UTC', () => {
    const event = cal.parseEvent({ id: 'x', summary: 'Deadline', start: { date: '2026-10-13' }, end: { date: '2026-10-14' } }, calendar);
    assert.ok(event.allDay);
    assert.deepEqual(event.start, d(2026, 10, 13));
    assert.deepEqual(event.end, d(2026, 10, 14));
  });
  it('a cancelled one is left out, an untitled one is named, a coloured one keeps its colour', () => {
    assert.equal(cal.parseEvent({ id: 'c', status: 'cancelled', start: { dateTime: '2026-10-13T10:00:00Z' } }, calendar), null);
    assert.equal(cal.parseEvent({ id: 'n', start: { dateTime: '2026-10-13T10:00:00Z' }, end: { dateTime: '2026-10-13T10:30:00Z' } }, calendar).title, '(No title)');
    assert.equal(cal.parseEvent({ id: 'k', summary: 'Flight', colorId: '11', start: { dateTime: '2026-10-13T10:00:00Z' }, end: { dateTime: '2026-10-13T10:30:00Z' } }, calendar).color, '#d50000');
    assert.equal(cal.parseEvent({ id: 'no-times', summary: 'x' }, calendar), null);
  });
  it('a calendar from the list', () => {
    assert.deepEqual(cal.parseCalendar({ id: 'p', summary: 'Saurav', backgroundColor: '#9fe1cb', primary: true }), { id: 'p', name: 'Saurav', color: '#9fe1cb', primary: true });
    assert.equal(cal.parseCalendar({ id: 'q', summary: 'Lab', summaryOverride: 'The lab' }).name, 'The lab');
  });
});

describe('the address', () => {
  it('/calendar is the page, and nothing more than that', () => {
    assert.equal(route.pathFor({ view: { kind: 'calendar' } }, '/reader/'), '/reader/calendar');
    assert.deepEqual(route.placeFor('/reader/calendar', '/reader/').view, { kind: 'calendar' });
    assert.deepEqual(route.placeFor('/reader/calendar/', '/reader/').view, { kind: 'calendar' });
    assert.equal(route.placeFor('/reader/calendar/extra', '/reader/'), null);
  });
});
