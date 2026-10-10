// Where the page is, in the address bar. Every destination — Home, a list of
// the library, a collection, a paper, the usage page, the Playground and each
// playground in it — has a path of its own under the app's base, so a link
// can be kept, shared and reloaded, and Back goes where you were. Panels
// (the library, the dock, Ask AI) open over a page and do not change it.
//
//   /                      Home
//   /library               every paper     /reading /unread /finished /unsorted /junk
//   /collection/?id=<id>   a collection
//   /paper/?id=<id>        a paper
//   /usage                 who used what (the owner's)
//   /playground            the Playground's home
//   /playground/?id=<id>   one playground
//   /projects              every project, side by side
//   /project/?id=<id>      a project's overview; &view=workspace its workspace
//
// The id rides in the query, so every address is a folder that exists on a
// static host (GitHub Pages): a reload is answered by that folder's
// index.html, never by the host's 404 page. The older /paper/<id> form is
// still read, for links made before.

import type { View } from '../types.view';

/** A destination: a view of the library or a paper, or the usage page. */
export type Place = { view: View; usage?: boolean };

const LISTS = ['reading', 'unread', 'finished', 'unsorted', 'junk'] as const;

/** The app's base, with its trailing slash: '/' in dev, '/reader/' on GitHub Pages. */
export function basePath(base: string = import.meta.env?.BASE_URL ?? '/'): string {
  const withLead = base.startsWith('/') ? base : `/${base}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

const withId = (folder: string, id: string) => `${folder}/?id=${encodeURIComponent(id)}`;

/** The address for a destination, under `base`: a path, and `?id=` for a page with an id. */
export function pathFor(place: Place, base = basePath()): string {
  const { view } = place;
  const tail = place.usage
    ? 'usage'
    : view.kind === 'home'
      ? ''
      : view.kind === 'all'
        ? 'library'
        : view.kind === 'collection'
          ? withId('collection', view.id)
          : view.kind === 'paper'
            ? withId('paper', view.id)
            : view.kind === 'playground'
              ? view.id
                ? withId('playground', view.id)
                : 'playground'
              : view.kind === 'project'
                ? `${withId('project', view.id)}${view.mode === 'workspace' ? '&view=workspace' : ''}`
                : view.kind;
  return `${base}${tail}`;
}

/** Where the tab is, as `placeFor` reads it: the path and its query. */
export const currentAddress = () => `${window.location.pathname}${window.location.search}`;

/**
 * `path` (from `pathFor`) with what else `search` carries — a sign-in's
 * answer — kept, and its own `id` and `view` in place of any there were.
 */
export function addressWith(path: string, search: string): string {
  const [pathname, own = ''] = path.split('?');
  const params = new URLSearchParams(search);
  params.delete('id');
  params.delete('view');
  new URLSearchParams(own).forEach((value, key) => params.set(key, value));
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * The destination an address names, or null for one this app does not know
 * (the caller decides — usually Home). The base may be given with or without
 * its trailing slash, a path may end in a slash or `index.html`, and a page's
 * id comes from `?id=` or, in the older form, the path.
 */
export function placeFor(address: string, base = basePath()): Place | null {
  const [pathname, query = ''] = address.split('?');
  const root = base.replace(/\/$/, '');
  if (pathname !== root && !pathname.startsWith(base)) return null;
  const rest = pathname
    .slice(base.length)
    .replace(/(^|\/)index\.html$/, '')
    .replace(/\/+$/, '');
  if (!rest) return { view: { kind: 'home' } };
  const [head, ...more] = rest.split('/');
  const extra = more.length ? decode(more.join('/')) : '';
  // Only a page that has one reads `?id=`; anywhere else the query is not the route's.
  const id = extra || (new URLSearchParams(query).get('id') ?? '');
  if (head === 'library' && !extra) return { view: { kind: 'all' } };
  if ((LISTS as readonly string[]).includes(head) && !extra) return { view: { kind: head as (typeof LISTS)[number] } };
  if (head === 'usage' && !extra) return { view: { kind: 'home' }, usage: true };
  if (head === 'collection' && id) return { view: { kind: 'collection', id } };
  if (head === 'paper' && id) return { view: { kind: 'paper', id } };
  if (head === 'projects' && !extra) return { view: { kind: 'projects' } };
  if (head === 'project' && id) {
    const mode = new URLSearchParams(query).get('view') === 'workspace' ? 'workspace' : undefined;
    return { view: mode ? { kind: 'project', id, mode } : { kind: 'project', id } };
  }
  if (head === 'playground') return { view: id ? { kind: 'playground', id } : { kind: 'playground' } };
  return null;
}

/** Whether two destinations are the same page. */
export const samePlace = (a: Place, b: Place) => pathFor(a, '/') === pathFor(b, '/');
