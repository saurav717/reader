export type View =
  | { kind: 'home' }
  | { kind: 'all' }
  | { kind: 'reading' }
  | { kind: 'unread' }
  | { kind: 'finished' }
  | { kind: 'unsorted' }
  | { kind: 'junk' }
  | { kind: 'collection'; id: string }
  | { kind: 'paper'; id: string };
