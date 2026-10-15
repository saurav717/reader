// The meetings a project has on the calendar, and Granola's notes of them
// filed in its logbook — for the Calendar page, which files them as it reads
// the week, and the logbook's Meetings tab, which shows a project's meetings
// to come and files what is due when it opens.

import * as google from './google';
import { addDays, fetchAllEvents, fetchCalendars, startOfDay, tagKeys, type CalendarEvent } from './calendar';
import { collectNotes, meetingsDue } from './granola';
import { hasNotesFor } from './logbook';
import { fileNotes, loadLogbook } from './logbookStore';
import { meetingProject, type Project } from './projects';

/** What filing found: how many notes went in, and the meetings still waiting on Granola, by id. */
export interface Filed {
  filed: number;
  waiting: string[];
  error?: string;
}

const busy = new Set<string>();

/**
 * Granola's notes of the meetings given that are due (lib/granola.ts,
 * `meetingsDue`) and tagged with a project, filed in that project's logbook —
 * each meeting once, however often this runs.
 */
export async function fileGranolaNotes(key: string, events: CalendarEvent[], projects: Project[], by: string, now = new Date()): Promise<Filed> {
  const due = meetingsDue(events, now)
    .map((event) => ({ event, project: meetingProject(projects, tagKeys(event)) }))
    .filter((item): item is { event: CalendarEvent; project: Project } => Boolean(item.project) && item.project!.project.shared?.role !== 'viewer' && !busy.has(item.event.id));
  if (!key.trim() || !due.length) return { filed: 0, waiting: [] };
  // What the logbooks have already, so a meeting filed once is not asked for again.
  const logs = new Map<string, Awaited<ReturnType<typeof loadLogbook>> | null>();
  for (const { project } of due) if (!logs.has(project.id)) logs.set(project.id, await loadLogbook(project).catch(() => null));
  const pending = due.filter(({ event, project }) => {
    const log = logs.get(project.id);
    return log && !hasNotesFor(log.notes, event.id);
  });
  if (!pending.length) return { filed: 0, waiting: [] };
  pending.forEach(({ event }) => busy.add(event.id));
  try {
    const found = await collectNotes(
      key,
      pending.map(({ event }) => event),
      by,
      now,
    );
    let filed = 0;
    for (const project of new Set(pending.map((item) => item.project))) {
      const notes = pending.filter((item) => item.project === project && found.has(item.event.id)).map((item) => found.get(item.event.id)!);
      if (notes.length) filed += await fileNotes(project, notes);
    }
    return { filed, waiting: pending.filter(({ event }) => !found.has(event.id)).map(({ event }) => event.id) };
  } catch (error) {
    return { filed: 0, waiting: pending.map(({ event }) => event.id), error: error instanceof Error ? error.message : String(error) };
  } finally {
    pending.forEach(({ event }) => busy.delete(event.id));
  }
}

/**
 * The meetings of a project on the calendar, from a fortnight back to a
 * fortnight on: those tagged with it, or with a series tagged with it. Null
 * when the calendar is not connected in this tab.
 */
export async function projectMeetings(clientId: string, project: Project, projects: Project[], now = new Date()): Promise<CalendarEvent[] | null> {
  if (!clientId || !project.project.meetings || !Object.keys(project.project.meetings).length) return [];
  const token = await google.calendarToken(clientId).catch(() => null);
  if (!token) return null;
  const calendars = await fetchCalendars(token);
  const span = { start: addDays(startOfDay(now), -14), end: addDays(startOfDay(now), 15) };
  const { events } = await fetchAllEvents(token, calendars, span);
  return events.filter((event) => meetingProject(projects, tagKeys(event))?.id === project.id);
}
