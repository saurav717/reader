// Production server: the same /api handler the dev server uses, plus the built
// client. `npm run build && npm start`.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRouter from './api.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dirname, '..', 'dist');
const port = Number(process.env.PORT) || 8080;

const app = express();

// A proxy reachable from the internet — one in a Codespace, say, whose port
// is public so the site on GitHub Pages can call it — holds an institutional
// sign-in that anyone who found its address could fetch through. So with
// READER_PROXY_KEY set, the routes answer only under `/api/k/<key>/`, and
// the key rides in the address pasted into Settings → Paper proxy. Without
// the variable, `/api` answers as before, which is right for localhost.
const key = (process.env.READER_PROXY_KEY || '').trim();
if (key) {
  app.use(`/api/k/${key}`, apiRouter);
  app.use('/api', (_req, res) => {
    res.status(403).json({ error: 'this proxy answers only under its key; see the address it printed when it started' });
  });
} else {
  app.use('/api', apiRouter);
}
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(port, () => {
  console.log(`reader listening on http://localhost:${port}`);
});
