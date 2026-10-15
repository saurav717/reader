export type View =
  | { kind: 'home' }
  | { kind: 'all' }
  | { kind: 'reading' }
  | { kind: 'unread' }
  | { kind: 'finished' }
  | { kind: 'unsorted' }
  | { kind: 'junk' }
  | { kind: 'collection'; id: string }
  | { kind: 'paper'; id: string }
  /** The Playground: its home with no id, one playground with one. A page of its own, at /playground. */
  | { kind: 'playground'; id?: string }
  /** Every project side by side, at /projects. */
  | { kind: 'projects' }
  /** The signed-in account's Google Calendar, by day, week or month, at /calendar. */
  | { kind: 'calendar' }
  /** One project: its overview, its papers to read, its workspace — a paper beside the project's code — or its paper, being written. */
  | { kind: 'project'; id: string; mode?: 'overview' | 'read' | 'workspace' | 'write' | 'logbook'; /** On the Logbook: which of its tabs (src/lib/logbook.ts, LOGBOOK_TABS). */ section?: string };
