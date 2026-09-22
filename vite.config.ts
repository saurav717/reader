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
  build: { outDir: 'dist', sourcemap: process.env.VITE_SOURCEMAP !== 'false' },
});
