export type View =
  | { kind: 'all' }
  | { kind: 'reading' }
  | { kind: 'unread' }
  | { kind: 'finished' }
  | { kind: 'unsorted' }
  | { kind: 'collection'; id: string }
  | { kind: 'paper'; id: string };
