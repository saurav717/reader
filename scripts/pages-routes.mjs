// After `vite build` for GitHub Pages: a copy of index.html in a folder for
// each page with a fixed address (/reader/playground/, /reader/library/ …),
// so GitHub Pages answers those with the app rather than its 404. A page with
// an id keeps it in the query (/reader/playground/?id=<id>, src/lib/route.ts),
// so paper/ and collection/ are folders here too, and a reload never needs the
// 404. Older links with the id in the path (/reader/paper/<id>) still reach
// the site's own 404 page, which sends them to /reader/?route=<the address>,
// and the app puts the address back before it reads it (src/main.tsx).
//
//   node scripts/pages-routes.mjs dist-pages
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const STATIC_ROUTES = ['playground', 'paper', 'collection', 'library', 'reading', 'unread', 'finished', 'unsorted', 'junk', 'usage'];

const out = process.argv[2] || 'dist-pages';
for (const route of STATIC_ROUTES) {
  await mkdir(join(out, route), { recursive: true });
  await copyFile(join(out, 'index.html'), join(out, route, 'index.html'));
}
console.log(`pages-routes: index.html copied for ${STATIC_ROUTES.map((r) => `/${r}/`).join(' ')}`);

// Jekyll, which builds the GitHub Pages site, publishes no file whose name starts with "_" or ".",
// so a chunk named that way 404s and whatever imports it fails ("Importing a module script failed").
const hidden = (await readdir(out, { recursive: true })).filter((path) => path.split(/[\\/]/).some((part) => /^[_.]/.test(part)));
if (hidden.length) {
  console.error(`pages-routes: GitHub Pages (Jekyll) would leave these out: ${hidden.join(', ')}`);
  process.exit(1);
}
