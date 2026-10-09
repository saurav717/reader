import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import apiRouter from './server/api.js';

// Which build this is: the commit it was made from and when. The page carries it, and build.json beside
// the page says the same, so a window left open can tell when a newer one has been published
// (Settings → Updates, src/lib/siteBuild.ts).
const commit = (() => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
})();
const build = { commit, time: new Date().toISOString() };

// The arXiv API and arXiv's HTML/PDF hosts send no CORS headers, so every
// request to them goes through our own /api routes. In dev that is Vite
// middleware; in production it is the same handler mounted on Express.
// VITE_BASE lets the same build serve a sub-path, e.g. /reader/ on GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  define: { __READER_BUILD__: JSON.stringify(build) },
  plugins: [
    react(),
    {
      name: 'reader-build-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify(build) });
      },
    },
    {
      name: 'reader-api',
      configureServer(server) {
        server.middlewares.use('/api', apiRouter);
      },
    },
  ],
  server: { port: 5173 },
  // Sourcemaps are useful locally but needless weight in a repo that is
  // committed as build output.
  // pdf.js is a large library, loaded on demand as its own chunk the first
  // time a PDF is reflowed; the warning about its size says nothing new.
  // GitHub Pages builds the site with Jekyll, which leaves out any file whose name starts with "_".
  // Rollup names a shared helper chunk _commonjsHelpers-….js (xterm, the terminal, imports it), so
  // chunks lose a leading underscore; scripts/pages-routes.mjs refuses a build that still has one.
  build: {
    outDir: 'dist',
    sourcemap: process.env.VITE_SOURCEMAP !== 'false',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { chunkFileNames: (chunk) => `assets/${chunk.name.replace(/^[_.]+/, '') || 'chunk'}-[hash].js` } },
  },
  // The pdf.js worker is an ES module and is started as one.
  worker: { format: 'es' },
});
