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
  /** One project: its overview, or its workspace — a paper beside the project's code. */
  | { kind: 'project'; id: string; mode?: 'overview' | 'workspace' };
