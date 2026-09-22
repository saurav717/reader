# Reader

A reader for research papers. Search arXiv, OpenAlex and Semantic Scholar from one
box, collect what you want to read, highlight it, and — if you connect Google Drive —
keep a copy of every paper you add in your own Drive, with your annotations beside it.

![the reader with the discover panel and the notes rail open](docs/reader.png)

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

For a production build:

```bash
npm run build
npm start            # http://localhost:8080
```

`npm start` runs a small Express server that serves the build **and** the `/api`
routes. Those routes are not optional: arXiv sends no CORS headers, so the browser
cannot fetch its search API, HTML renderings or PDFs directly. Everything else
(OpenAlex, Semantic Scholar, Google) is called straight from the page.

## Putting it online

The app needs a server for the `/api` routes, so a pure static host will not do.
Two paths that work as-is:

**Vercel** — `api/[...path].js` and `vercel.json` are committed, so it deploys
unchanged:

```bash
npx vercel            # first run links the project and gives you a preview URL
npx vercel --prod
```

**Any Node host** (Render, Railway, Fly, a VPS) — build command `npm run build`,
start command `npm start`, and it listens on `$PORT`.

Whichever you pick, add the resulting origin to **Authorised JavaScript origins**
on your OAuth client before Google sign-in will work there.

## Connecting Google

Sign-in and Drive are two separate consents, and both are optional — without them
the app still works, with your library in this browser only.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API**.
2. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type
   **Web application**. Add your origin (`http://localhost:5173` for dev,
   `http://localhost:8080` for the built server, or your deployed origin) to
   **Authorised JavaScript origins**.
3. Put the client ID either in `.env` as `VITE_GOOGLE_CLIENT_ID` (see
   `.env.example`) or paste it into **Settings** in the app — the latter is stored
   in `localStorage` and needs no rebuild.
4. **Sign in with Google** asks only for your name and email. **Connect Drive** is a
   second, incremental consent for the `drive.file` scope.

### What lands in Drive

```
My Drive/
  Paper Reader/                      <- name configurable in Settings
    Operator learning/               <- one folder per collection
      Fourier Neural Operator … (arXiv 2010.08895).pdf
      Fourier Neural Operator … (arXiv 2010.08895).json
```

The `.json` sidecar holds the paper's metadata and your highlights, shaped after the
[W3C Web Annotation](https://www.w3.org/TR/annotation-model/) model, so the export
is the storage format rather than a lossy copy of it. It is re-uploaded whenever you
edit a highlight or a note.

Two consequences of using the least-privilege `drive.file` scope, both deliberate:

- The app can only see files it created itself. It cannot read the rest of your Drive.
- For the same reason it cannot write into a pre-existing folder you point it at, so
  it creates its own top-level folder instead. Rename it in Settings; move it in Drive
  and the app will create a new one next time.

PDFs are fetched through this app's server, which only proxies arXiv. Papers from
other publishers save their metadata sidecar but no PDF.

## How highlighting works

A highlight is stored as the quoted text plus 32 characters either side, not as a
character offset (`src/lib/anchor.ts`). That way it survives a re-render, a switch
between the HTML and abstract views, and a new arXiv version of the same paper. The
numeric offset is kept only to break ties between several identical quotes. When a
quote genuinely cannot be found, the note is kept and flagged rather than dropped.

In the reader: select text, then click a colour or press `1`–`4`; `N` highlights and
opens a note. `⌘K` / `Ctrl-K` opens the palette, which searches your library and
arXiv together.

## Layout

```
server/api.js           the /api routes (arXiv proxy), shared by dev and prod
server/index.js         production Express server
src/lib/anchor.ts       text-quote anchoring: resolve, paint, unpaint
src/lib/sources.ts      arXiv / OpenAlex / Semantic Scholar search
src/lib/paperContent.ts fetches and sanitises the full text
src/lib/google.ts       Google Identity Services + Drive REST
src/lib/driveSync.ts    what a synced paper looks like in Drive
src/lib/store.tsx       app state, IndexedDB persistence, the sync queue
src/lib/db.ts           IndexedDB wrapper
src/components/         the UI
scripts/smoke.mjs       browser smoke test (see below)
```

Your library, collections and highlights live in IndexedDB. Settings and the last
view live in `localStorage`.

## Tests

```bash
npm run build && npm start     # in one terminal
node scripts/smoke.mjs         # in another
```

A Playwright script that drives a real Chromium through search → add → read →
highlight → note → reload, checks the highlight re-anchors and the note survives,
and writes screenshots to `.smoke/`. It stubs the arXiv responses, so it needs no
network beyond the local server.

## Known limits

- PDF mode hands the file to the browser's own viewer, so highlighting only works in
  Reflow mode. Reflow needs an HTML rendering, which arXiv has for recent papers and
  ar5iv has for most older ones; otherwise the reader falls back to the abstract.
- Tokens are held in memory only — there is no backend to hold a refresh token — so
  Drive re-authorises silently on the first sync after an hour.
- Semantic Scholar rate-limits unauthenticated search fairly aggressively.
