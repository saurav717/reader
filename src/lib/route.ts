// Where the page is, in the address bar. Every destination — Home, a list of
// the library, a collection, a paper, the usage page, the Playground and each
// playground in it — has a path of its own under the app's base, so a link
// can be kept, shared and reloaded, and Back goes where you were. Panels
// (the library, the dock, Ask AI) open over a page and do not change it.
//
//   /                      Home
//   /library               every paper     /reading /unread /finished /unsorted /junk
//   /collection/<id>       a collection
//   /paper/<id>            a paper
//   /usage                 who used what (the owner's)
//   /playground            the Playground's home
//   /playground/<id>       one playground

import type { View } from '../types.view';

/** A destination: a view of the library or a paper, or the usage page. */
export type Place = { view: View; usage?: boolean };

const LISTS = ['reading', 'unread', 'finished', 'unsorted', 'junk'] as const;

/** The app's base, with its trailing slash: '/' in dev, '/reader/' on GitHub Pages. */
export function basePath(base: string = import.meta.env?.BASE_URL ?? '/'): string {
  const withLead = base.startsWith('/') ? base : `/${base}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

/** The path for a destination, under `base`. */
export function pathFor(place: Place, base = basePath()): string {
  const { view } = place;
  const tail = place.usage
    ? 'usage'
    : view.kind === 'home'
      ? ''
      : view.kind === 'all'
        ? 'library'
        : view.kind === 'collection'
          ? `collection/${encodeURIComponent(view.id)}`
          : view.kind === 'paper'
            ? `paper/${encodeURIComponent(view.id)}`
            : view.kind === 'playground'
              ? view.id
                ? `playground/${encodeURIComponent(view.id)}`
                : 'playground'
              : view.kind;
  return `${base}${tail}`;
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * The destination a path names, or null for a path this app does not know
 * (the caller decides — usually Home). The base may be given with or without
 * its trailing slash, and a path may end in a slash or `index.html`.
 */
export function placeFor(pathname: string, base = basePath()): Place | null {
  const root = base.replace(/\/$/, '');
  if (pathname !== root && !pathname.startsWith(base)) return null;
  const rest = pathname
    .slice(base.length)
    .replace(/(^|\/)index\.html$/, '')
    .replace(/\/+$/, '');
  if (!rest) return { view: { kind: 'home' } };
  const [head, ...more] = rest.split('/');
  const id = more.length ? decode(more.join('/')) : '';
  if (head === 'library' && !id) return { view: { kind: 'all' } };
  if ((LISTS as readonly string[]).includes(head) && !id) return { view: { kind: head as (typeof LISTS)[number] } };
  if (head === 'usage' && !id) return { view: { kind: 'home' }, usage: true };
  if (head === 'collection' && id) return { view: { kind: 'collection', id } };
  if (head === 'paper' && id) return { view: { kind: 'paper', id } };
  if (head === 'playground') return { view: id ? { kind: 'playground', id } : { kind: 'playground' } };
  return null;
}

/** Whether two destinations are the same page. */
export const samePlace = (a: Place, b: Place) => pathFor(a, '/') === pathFor(b, '/');
