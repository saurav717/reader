export type View =
  | { kind: 'all' }
  | { kind: 'reading' }
  | { kind: 'unsorted' }
  | { kind: 'collection'; id: string }
  | { kind: 'paper'; id: string };
