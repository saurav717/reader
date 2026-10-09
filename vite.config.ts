import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import apiRouter from './server/api.js';

// The arXiv API and arXiv's HTML/PDF hosts send no CORS headers, so every
// request to them goes through our own /api routes. In dev that is Vite
// middleware; in production it is the same handler mounted on Express.
// VITE_BASE lets the same build serve a sub-path, e.g. /reader/ on GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    react(),
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
