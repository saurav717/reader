// After `vite build` for GitHub Pages: a copy of index.html in a folder for
// each page with a fixed address (/reader/playground/, /reader/library/ …),
// so GitHub Pages answers those with the app rather than its 404. Addresses
// with an id in them (/reader/paper/<id>, /reader/playground/<id>) cannot be
// files; the site's own 404 page sends them to /reader/?route=<the address>,
// and the app puts the address back before it reads it (src/main.tsx).
//
//   node scripts/pages-routes.mjs dist-pages
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const STATIC_ROUTES = ['playground', 'library', 'reading', 'unread', 'finished', 'unsorted', 'junk', 'usage'];

const out = process.argv[2] || 'dist-pages';
for (const route of STATIC_ROUTES) {
  await mkdir(join(out, route), { recursive: true });
  await copyFile(join(out, 'index.html'), join(out, route, 'index.html'));
}
console.log(`pages-routes: index.html copied for ${STATIC_ROUTES.map((r) => `/${r}/`).join(' ')}`);
