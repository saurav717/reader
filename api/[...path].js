// Vercel serverless entry. It reuses the same handler the Vite dev server and
// the Express server mount, so there is one implementation of the arXiv proxy.
import apiRouter from '../server/api.js';

export default function handler(req, res) {
  // The shared router is written for a handler mounted at /api, where the
  // prefix has already been stripped. Vercel passes the full path.
  req.url = (req.url || '/').replace(/^\/api(?=\/|\?|$)/, '') || '/';
  return apiRouter(req, res);
}
