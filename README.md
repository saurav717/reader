# Reader

A reader for research papers. Search arXiv, OpenAlex, Semantic Scholar and Crossref
from one box — papers or the people who wrote them — read the paper as its PDF, or
reflowed as text where there is one, to highlight it, and keep what you collect: the
PDFs in your own Google Drive, the notes and the bibliography in a Git repository.

![the library on the left, the paper in the middle, the highlights pane on the right, and the three-pane lookup box over a selection](docs/reader.png)

The window is in three parts. On the left, the library: your collections, and the
papers in them split into what you are **reading now**, what you have **not started**
and what you have **finished**. In the middle, the paper. On the right, a dock
holding **Discover** and **Highlights** — tabs, so the reading column never has a
panel crowding it on both sides.

Right-click a selection in a paper and a box opens with three panes: what the word
**means**, where the idea **comes from** — a background paragraph, the earliest
papers to use the phrase, the most cited ones since, and links out — and a
**comment** that highlights the passage as you type it, the way Acrobat does.

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
cannot fetch its search API, HTML renderings or PDFs directly — and neither do the
publishers and repositories that hold everything else. Everything else — OpenAlex,
Semantic Scholar, Crossref, Unpaywall, GitHub and Google — sends CORS headers and is
called straight from the page.

## Searching

The **Papers** tab searches every selected source at once and merges the answers
into one list. Sources are merged rather than concatenated: two records of the same
paper — matched on DOI, then arXiv id, then a normalised title — become one entry
that takes the best field from each, so the abstract can come from one index and the
open-access PDF from another. The order is [reciprocal rank
fusion](https://dl.acm.org/doi/10.1145/1571941.1572114): each source votes with
`1/(60 + rank)`, so a paper two indexes both rank highly beats one that only a single
index ranked first, without their scores having to mean the same thing.

Quote a phrase to match it exactly. A query that *is* an arXiv id jumps straight to
that paper; one that merely contains a number does not.

The **Authors** tab searches OpenAlex's and Semantic Scholar's author records —
affiliation, paper count, citations, h-index, ORCID — and opening a person lists
what they wrote. Neither index disambiguates people perfectly, so two records of the
same person can appear; when none of them is the right person, "search every paper
with that name on it" falls back to matching the name across every source's author
field instead of on an identifier.

| Source | Needs the proxy | Papers | Authors |
| --- | --- | --- | --- |
| arXiv | yes | yes | by name |
| OpenAlex | no | yes | yes |
| Semantic Scholar | no | yes | yes |
| Crossref | no | yes | by name |

There is deliberately no Google Scholar. It has no public API, its terms forbid
automated access, and it blocks datacentre IPs — which is exactly where this app's
proxy runs. Its results are also mostly links to publisher landing pages rather than
to anything this reader could open. The four sources above return structured
metadata *and* open-access locations, which is what actually gets a paper on screen.

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

**A static host** (GitHub Pages, S3, Netlify without functions) — possible, with a
caveat. `npm run build:pages` produces `dist-pages/` for a `/reader/` sub-path:

```bash
npm run build:pages                                   # no proxy: static mode
VITE_API_BASE=https://…workers.dev npm run build:pages   # with a proxy
```

Without a proxy the app still runs, and says so in the UI: search falls back to
OpenAlex and Semantic Scholar (both send CORS headers, and both index arXiv), the
reader shows abstracts, PDFs become links out rather than something you can read
or save here, and Drive saves metadata without the PDF. Highlighting, collections,
notes and export are unaffected.

To get arXiv and the PDFs back on a static host, put the proxy on Cloudflare's
free tier — `worker/index.js` is the same five routes in Workers form:

```bash
npx wrangler deploy                                   # prints your worker URL
```

Edit `ALLOWED_ORIGINS` in `worker/index.js` to your own site first; a wide-open
proxy is one anyone can point at arXiv on your account's quota. Then rebuild with
`VITE_API_BASE` set to the worker URL.

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

PDFs are fetched through this app's server — arXiv, or whichever repository
Unpaywall, OpenAlex or Semantic Scholar points at. A paper with no free copy anywhere
any of them can see saves its metadata sidecar and says so in the sync log.

## Mirroring to a Git repository

Drive holds the PDFs. A repository holds everything that is text:

```
collections/<collection>/<paper>.json    the W3C annotation sidecar
collections/<collection>/<paper>.md      the paper and your highlights, readable
library.json                             the index
references.bib                           BibTeX for everything you have added
```

The split is on purpose, and it is the whole reason both exist. A PDF is a binary
blob: committing it bloats a repository's history permanently, runs into the 100 MB
per-file limit and Git LFS's 1 GB free tier, and gains nothing from being diffed —
and pushing publisher PDFs to a *public* repository is redistribution rather than
personal use. Notes and highlights are the opposite: small, textual, and worth being
able to read back through `git log`.

Point it at a repository in **Settings → Git mirror**. It needs:

- **A repository that already exists**, with at least one commit — an empty
  repository has no branch to write to. A private one, ideally.
- **A fine-grained personal access token**, scoped to that one repository, with
  **Contents: read and write** and nothing else.

Two things to know about the token. It lives in this browser's `localStorage`, so
any script running on this origin could read it — scope it narrowly, give it an
expiry, and revoke it when you stop using the app. And because there is no backend,
that is the only place it *can* live; if that is not a trade you want, the Drive
mirror alone needs no long-lived secret.

Writes are batched. Everything that changes within a few seconds of each other —
adding a paper, three highlights and a note — goes into **one commit** built through
the Git Data API, rather than one commit per file through the Contents API. A flush
whose tree turns out identical to the one already there makes no commit at all, so
re-syncing an unchanged paper does not fill the history with noise. The ref update is
never forced: if something else pushed in between, the write fails and the next flush
rebuilds on top of it rather than throwing that commit away.

### Reading the copy in Drive

Once a paper has been synced, Drive holds the same bytes the proxy fetched — and
Google's API, unlike arXiv and the publishers, answers the browser directly. So
the reader reads a synced paper back out of Drive instead of fetching it again:
one request to Google rather than a round trip through the server to arXiv, and
the line under the title says **PDF from your Drive** when that is where it came
from. A paper already in Drive therefore opens even on a deployment with no
server at all. If the copy has been deleted or the grant has lapsed, the reader
falls back to the proxy without saying anything.

Drive can only ever be the *second* place a PDF comes from. Putting a file there
means uploading bytes, and getting the bytes in the first place is exactly the
cross-origin fetch the browser refuses — there is no asking Drive to go and
fetch a URL on your behalf. So the proxy is what gets a paper into Drive, and
Drive is what saves you going back to the proxy afterwards.

For the same reason, a PDF you downloaded from arXiv yourself and dropped into
the folder is not picked up: under the `drive.file` scope the app cannot see
files it did not create. Widening that scope would let it read the rest of your
Drive, which is the trade this app deliberately does not make.

## Getting the PDF

arXiv, OpenAlex and Semantic Scholar all answer a search with an abstract. Only
arXiv also hands over something to reflow, so for everything else the PDF *is* the
paper, and the reader goes and gets it:

1. Most open-access results already carry a link — `best_oa_location` from
   OpenAlex, `openAccessPdf` from Semantic Scholar.
2. When a result carries none, the reader asks both APIs again by DOI when it
   opens the paper. A search hit and the per-work record do not always agree
   about what is free to read. What it finds is kept with the paper.
3. The file is fetched through `/api/pdf`, because a publisher's PDF is
   cross-origin and the browser will not read it from the page.

A paper opens on its PDF: the paper as it was published, figures, tables,
typesetting and all, handed to the browser's own viewer. The **Reflow / PDF**
switch in the top bar appears whenever there is a PDF to show, and the button
beside it saves the file.

Reflow is the other half of the switch, and the one you can highlight. Choosing
either sets what the *next* paper opens in too — under **Reading** in Settings if
you would rather set it there — so a reader who never wants the text rendering
never sees it, and one who always does never sees a PDF. The reflowed text is
only fetched once it is being looked at, so reading PDFs costs no round trip for
an HTML rendering nobody reads.

Where there is no PDF to open — no proxy to fetch it through, or no free copy
anywhere OpenAlex or Semantic Scholar can see — the reader falls back to the
reflowed text, or to the abstract, and says which.

`/api/pdf` is the only route that fetches a URL this app did not choose, so it is
deliberately narrow: https only, never at a private, loopback or link-local
address, every redirect hop checked against the same rules, a size cap, and the
body has to actually be a PDF — which keeps it from being a general-purpose proxy
and catches the publisher who answers a sign-in page instead of the paper.
`scripts/pdf-proxy.test.mjs` is those rules written down (`npm run test:api`).

## How highlighting works

A highlight is stored as the quoted text plus 32 characters either side, not as a
character offset (`src/lib/anchor.ts`). That way it survives a re-render, a switch
between the HTML and abstract views, and a new arXiv version of the same paper. The
numeric offset is kept only to break ties between several identical quotes. When a
quote genuinely cannot be found, the note is kept and flagged rather than dropped.

In the reader: select text, then click a colour or press `1`–`4`; `N` highlights and
opens a note. `⌘K` / `Ctrl-K` opens the palette, which searches your library and
arXiv together.

## The lookup box

Right-click a selection — or use **Look up** on the selection toolbar, which a
trackpad can reach. Three panes, each fetched straight from the browser from a
keyless service that sends CORS headers, so the box works on a static host with no
proxy at all:

| Pane | Where it comes from | When it has nothing |
| --- | --- | --- |
| Meaning | [dictionaryapi.dev](https://dictionaryapi.dev); chips pick which word of a phrase to define | says so, and links to Wiktionary |
| Where it comes from | Wikipedia's lede, plus OpenAlex sorted oldest-first and most-cited-first | falls back to the search links below it |
| Comment | your own library | — |

The comment pane writes a real highlight as soon as there is something to attach it
to — a colour you pick, or the first character you type — so the passage is marked
up while you are still writing, and the comment lands in the Highlights pane and in
the Drive sidecar like any other note. **Discard** removes it again.

None of it is a term-of-art oracle: the dictionary has nothing to say about
"attention head", and OpenAlex's oldest match for a phrase is the oldest thing it
has indexed, which is not always the thing that coined it.

## Layout

```
server/api.js           the /api routes (arXiv and PDF proxy), dev and prod
server/fetchPdf.js      which URLs the PDF route will fetch, and what it accepts
                        back; shared with the Cloudflare Worker
server/index.js         production Express server
src/lib/anchor.ts       text-quote anchoring: resolve, paint, unpaint
src/lib/sources.ts      arXiv / OpenAlex / Semantic Scholar / Crossref search,
                        author search, the merge, and the OpenAlex lineage
                        query behind the lookup box
src/lib/sidecar.ts      the annotation format both mirrors write
src/lib/github.ts       the Git mirror: notes, index, BibTeX, one commit a flush
src/lib/contact.ts      the address OpenAlex, Crossref and Unpaywall ask for
src/lib/lookup.ts       dictionary and Wikipedia lookups for a selection
src/lib/status.ts       reading, not started or finished
src/lib/paperContent.ts fetches and sanitises the full text
src/lib/pdf.ts          finds a paper's PDF, fetches it (Drive first), and saves it
src/lib/google.ts       Google Identity Services + Drive REST
src/lib/driveSync.ts    what a synced paper looks like in Drive
src/lib/store.tsx       app state, IndexedDB persistence, the sync queue
src/lib/db.ts           IndexedDB wrapper
src/components/         the UI
scripts/smoke.mjs       browser smoke test (see below)
scripts/pdf-proxy.test.mjs  what the PDF proxy serves and what it refuses
scripts/search.test.mjs     query shapes, de-duplication and ranking
scripts/github.test.mjs     what the Git mirror writes, and that a flush is
                            one commit
scripts/bundle.mjs          loads the app's TypeScript into the test runner
```

Your library, collections and highlights live in IndexedDB. Settings and the last
view live in `localStorage`.

## Tests

```bash
npm test                       # everything below that needs no network
npm run test:api               # the PDF proxy's rules
npm run test:unit              # query building, result merging, the Git mirror

npm run build && npm start     # in one terminal
node scripts/smoke.mjs         # in another
```

`scripts/bundle.mjs` is how the unit tests reach the app's TypeScript: Node can strip
the types itself but will not resolve the extension-less imports the app is written
with, so the module under test is bundled with esbuild first.

A Playwright script that drives a real Chromium through search → add → read →
highlight → open the PDF → download it → look up → comment → note → reload, checks
the panels are on the sides they should be, that a paper opens on its PDF and that
the browser's viewer really renders it, that the highlights re-anchor, that the note
and the chosen mode survive a reload, that results from several sources merge into
one list, that an author search finds a person and opens their papers, that a paper
which is not on arXiv opens on its PDF too, and that a synced paper is read back out
of Drive rather than fetched through the proxy twice. It writes screenshots to
`.smoke/`, and stubs arXiv, the PDF routes, the dictionary, Wikipedia, OpenAlex,
Crossref and Semantic Scholar, so it needs no network beyond the local server.

## Known limits

- PDF mode hands the file to the browser's own viewer, so highlighting only works in
  Reflow mode — which is why the switch is there, and why choosing it sticks. Reflow
  needs an HTML rendering, which arXiv has for recent papers and ar5iv has for most
  older ones; otherwise the reader falls back to the abstract.
- A PDF is only there to be had if the paper is open access. Behind a paywall, the
  best either index can offer is the landing page, and the reader says so rather
  than pretending the file is coming.
- The whole PDF is fetched before the viewer sees it, which is what makes a failure
  explainable rather than a blank pane — but it also means no progressive rendering,
  and a cap (64 MB) on how big a file the proxy will pass.
- Tokens are held in memory only — there is no backend to hold a refresh token — so
  Drive re-authorises silently on the first sync after an hour.
- The GitHub token is the exception, and has to be stored in `localStorage` for the
  mirror to work without a backend. See above.
- Semantic Scholar rate-limits unauthenticated search fairly aggressively; its author
  endpoints are the first to say so.
- Author disambiguation is the indexes', not ours. OpenAlex and Semantic Scholar each
  merge and split people imperfectly, so one person can appear as two records with
  different citation counts, and two people who share a name can appear as one.
- Crossref and Unpaywall want a contact address, and Unpaywall refuses without one.
  Setting it in Settings is optional; leaving it empty costs you Unpaywall's PDF
  lookups and the faster "polite pool" on OpenAlex and Crossref.
- The lookup box is English-only: the dictionary endpoint and the Wikipedia it
  queries are both `en`.
- A comment made from the lookup box anchors like any other highlight, so in PDF
  mode — where there is no text layer of ours to anchor to — there is no right-click
  box either.
