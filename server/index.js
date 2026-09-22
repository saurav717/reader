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
app.use('/api', apiRouter);
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(port, () => {
  console.log(`reader listening on http://localhost:${port}`);
});
