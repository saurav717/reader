import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import apiRouter from './server/api.js';

// The arXiv API and arXiv's HTML/PDF hosts send no CORS headers, so every
// request to them goes through our own /api routes. In dev that is Vite
// middleware; in production it is the same handler mounted on Express.
export default defineConfig({
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
  build: { outDir: 'dist', sourcemap: true },
});
