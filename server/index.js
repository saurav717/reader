// Production server: the same /api handler the dev server uses, plus the built
// client. `npm run build && npm start`.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRouter from './api.js';
import { loopbackHost, tokenRequired } from './guard.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dirname, '..', 'dist');
const port = Number(process.env.PORT) || 8080;

// Where to listen. Without READER_TOKEN the proxy answers whoever can reach
// it — the sign-in, the browser, a fetch through somebody's institutional
// session — so it may only be reachable from this machine: loopback, and
// nothing else. READER_HOST widens that, and is refused without the token
// that makes widening it safe. See server/guard.js.
const host = process.env.READER_HOST || '127.0.0.1';
if (!tokenRequired() && !loopbackHost(host)) {
  console.error(
    `reader: READER_HOST=${host} would listen beyond this machine, and READER_TOKEN is not set.\n` +
      'Set READER_TOKEN (and paste it into Settings → Paper proxy in the app), or leave READER_HOST unset to listen on 127.0.0.1 only.',
  );
  process.exit(1);
}

const app = express();
app.use('/api', apiRouter);
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(port, host, () => {
  console.log(`reader listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  console.log(
    tokenRequired()
      ? 'reader: READER_TOKEN is set — the sign-in, browser and SerpApi routes want it (Settings → Paper proxy).'
      : 'reader: no READER_TOKEN — listening on this machine only, with every route open to it.',
  );
});
