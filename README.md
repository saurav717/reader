# Reader

A reader for research papers. Search arXiv, OpenAlex, Semantic Scholar, Crossref and
Google Scholar from one box — papers or the people who wrote them — see every place a paper can be
read from and open it from whichever one will part with a file, read it as its PDF or
reflowed as text to highlight it, and keep what you collect: the PDFs in your own
Google Drive, the notes and the bibliography in a Git repository.

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

`npm install` pulls a Chromium for the browser tests. To skip it —
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` — which is enough for
everything except `scripts/smoke.mjs`, `scripts/versions-drive.mjs` and
`scripts/scholar-flow.mjs`.

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
field instead of on an identifier. A name neither index keeps a record for — which
is most people who are not prolific authors — falls back to that broader search on
its own rather than showing an empty panel, and offers the person's Google Scholar
profile alongside it.

| Source | Needs the proxy | Papers | Authors | On by default |
| --- | --- | --- | --- | --- |
| arXiv | yes | yes | by name | with a proxy |
| OpenAlex | no | yes | yes | yes |
| Semantic Scholar | no | yes | yes | no |
| Crossref | no | yes | by name | yes |
| Google Scholar | yes | yes | yes | **no** — see below |

### Every copy of a paper, not just the first link

Open a result and it lists **everywhere the paper can be read** — the publisher's
copy, the arXiv preprint, each institutional repository deposit, PubMed Central —
with what each one is and whether it is a file or a page you would have to click
through. This is the same list Google Scholar shows as "All 14 versions", built
from [Unpaywall](https://unpaywall.org/), OpenAlex's full `locations` array,
Semantic Scholar and Crossref — and, when the paper came from Scholar, from
Scholar's own versions page, which is the longest of the lot. They are folded
together on the URL, so one copy that five sources all report appears once.

It matters because a single link is a coin toss. A DOI resolves to a login wall, a
repository link has rotted, a URL ending in `.pdf` turns out to be a landing page —
and none of that is knowable until it is asked. So the reader **tries each copy in
turn**, best first, and takes the first one that returns actual PDF bytes. The proxy
is what makes that answerable rather than a guess: it refuses anything that is not a
PDF, so a landing page counts as a failure and the next copy gets a turn. The order
is files before pages, and preprint servers before repositories before publishers,
which is the order in which they answer an anonymous request without a paywall, a
cookie banner or a captcha in the way.

The line under the title in the reader then says which copy you are looking at.

### Google Scholar

Scholar publishes no API, so `server/scholar.js` asks for the same pages a person
would open — the search results, a profile, an "all versions" cluster — and parses
the HTML. It is a real source, with a chip of its own, and it answers three things
nothing else does:

- **Papers no index has a record of.** Theses, technical reports, workshop papers, a
  copy on somebody's own page. This is why a search for a person who is not a
  prolific author finds anything at all.
- **People, by their own profile.** Scholar's profile search gives the affiliation,
  the verified email domain — the one thing that reliably tells two people of the
  same name apart — and a curated list of what they have written.
- **Every version of a paper.** "All 84 versions" is the longest list of copies
  anywhere, and it feeds straight into the versions list above.

**It will often refuse.** Scholar blocks servers far more readily than people, and
the proxy is a server. When it answers with a captcha the panel says so, in those
words, and the other four sources carry on — a refusal is never shown as "no
results". That is also why Scholar is off by default: a source that fails half the
time should be a choice, not a surprise.

**When it does, you can be shown the captcha.** A captcha is Scholar asking for a
person, and the panel offers to supply one: press *Show me the captcha* and the
proxy opens the refused page in a real browser window on its own machine, captcha
and all. Solve it there. The moment Scholar accepts the answer it shows the results
in that window; the proxy notices, closes the window, and the search runs again —
this time through that browser, which now carries the cookie the solve earned. The
proxy keeps asking Scholar through that browser from then on, so one solve lasts
(its profile is `~/.reader/scholar-profile`; delete it to go back to plain
requests). The window has to be the proxy's rather than a tab of your own: a
captcha solved in your browser would satisfy Google about your browser, and it is
the proxy Google is asking about. So this needs a proxy with a screen — `npm start`
on your own machine, pointed at from Settings → Paper proxy — and the Cloudflare
Worker says so instead of offering.

Two things make it work more often. `SCHOLAR_BROWSER=1 npm start` drives a real
Chromium for every request instead of sending a plain one, which Google's
fingerprinting minds much less. And running the proxy somewhere that is not a
datacentre — a laptop, a home server — matters more than anything else. From
Cloudflare Workers, expect captchas.

The proxy is polite whatever the mode: one Scholar request at a time, at least a
second and a half apart, with a five-minute cache, so typing in the search box does
not spend the whole budget on the first word. Its terms of service do not permit
automated access; this is here for one person's own reading, not for pointing a
crowd at.

Every result also carries a plain link to its Scholar page, and every person to
their profile, which works whether or not the source is turned on.

#### Through SerpApi instead

[SerpApi](https://serpapi.com) fetches Scholar's pages on its own machines and
answers with JSON, so a proxy that goes through it is never the one Scholar shows
a captcha to. It is the way Scholar works from anywhere that looks like a server,
the Cloudflare Worker above all. It costs money past a free allowance — one
SerpApi search per Scholar page asked for: a search, a person, a profile's works,
a paper's versions — and it needs a key, so it is opt-in:

```bash
SERPAPI_KEY=… npm start                        # the Node proxy
npx --yes wrangler@4 secret put SERPAPI_KEY    # the Worker, then redeploy it
```

With the key set every Scholar route goes through SerpApi (`server/serpapi.js`),
mapped onto the same shapes as the direct parsing, so nothing downstream knows
which was asked; `/health` says `"scholar": "serpapi"`. Without it the proxy asks
Scholar directly as above. The key never leaves the proxy: not into the page,
which anyone can read, and not into an answer. A refusal from SerpApi — a bad key,
a spent allowance — is reported as SerpApi's, not as a captcha, so the panel does
not offer a window for it. The five-minute cache applies either way, so typing in
the search box does not spend the allowance on the first word twice.

`SERPAPI_KEY=… node scripts/scholar-live.mjs` asks SerpApi for real, from any
machine, and prints what came back; it is the check to run once, since the field
names are SerpApi's and not a contract — `scripts/serpapi.test.mjs` pins the
mapping to saved answers in their documented shape.

### Getting a paper from a terminal

`npm run fetch` is the same resolution and download, run from Node rather than
from a page. It is an npm script, so it has to be run **from a clone of this
repository** — `npm run` looks for `package.json` in the directory you are in,
and says `ENOENT … package.json` if it is not there:

```bash
git clone https://github.com/saurav717/reader.git
cd reader
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install    # see below
npm run fetch -- "attention is all you need" --email you@example.org
```

Everything after `--` goes to the script; without it, npm keeps the flags for
itself.

`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is worth the typing: Playwright is a
devDependency for the browser tests, and installing it otherwise downloads a few
hundred megabytes of Chromium that the fetcher never touches. Drop the variable
when you want to run `scripts/smoke.mjs` and the rest.

```bash
npm run fetch -- 1706.03762 --email you@example.org
npm run fetch -- --doi 10.5555/3295222.3295349 --list
```

It searches, lists every copy it found, tries them in order, and writes the first
one that hands over a PDF — named exactly as the app names it in Drive.

It is worth having for one reason beyond convenience: **it isolates the failure**.
The app needs a proxy because a browser tab may not fetch a cross-origin PDF — that
is the browser's rule, not the network's, and Node has no such rule. So if
`npm run fetch` gets the paper and the app does not, the paper is fine and the proxy
is the problem. If `npm run fetch` cannot get it either, no proxy was ever going to.

With Google Drive for desktop, `--out` is all that "save it to Drive" needs, since
the folder *is* Drive:

```bash
npm run fetch -- "attention is all you need" --out ~/"Google Drive/My Drive/Papers_collection"
```

Without it, add the paper in the app: uploading needs a Google token, the app
has one in the browser, and nothing here holds a refresh token on disk.

### Adding a paper is saving it to Drive and opening it

**Add to collection** on a search result does the whole chain in one press: put the
paper in the collection, find every copy, download from whichever one answers, put
the file in `My Drive/Papers_collection/<paper>/`, and open the paper on **the copy
that was just saved** — read back out of Drive, which the browser can do directly.
The button reports each step as it goes — *Finding a copy…*, *Downloading…*,
*Saving to Drive from arXiv…* — and the reader opens when the file is in Drive.

Every step after the first is best effort, and the result says what did not
happen. A paper none of the indexes has a free copy of is still added and still
opened — on its abstract, with the copies to try by hand — and a line under the
result says the file is not in Drive and which copies were tried. Drive refusing
the upload (the Drive API not enabled on the Cloud project, say) is reported the
same way, with Google's own reason. A paper that went up without its PDF says so
too. None of that is left to the sync log behind Settings, because the result is
where you are looking at the time.

**Read** beside it is the same add without the wait: the paper opens at once and
Drive catches up in the background.

Saving needs Drive connected and a proxy configured. Without either the button
still adds and opens the paper, and a line under the result says the file will
not reach Drive, which half is missing and where to fix it — because that is
exactly where the question gets asked. A result lists every place the paper can
be read and those links open on a click, which makes the file look like something
the page already has. It is not: opening a link is a *navigation*, which the
browser allows across origins, while reading the same URL from script is a
*fetch*, which it refuses. Until something fetches the bytes on the page's behalf
there is nothing to upload, and that something is the proxy. Drive
cannot stand in for it — its API takes bytes, not a URL to go and collect.

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
npm run build:pages                                   # no proxy compiled in
VITE_API_BASE=https://…workers.dev npm run build:pages   # or name one now
```

Without a proxy the app still runs, and says so in the UI: search falls back to
OpenAlex, Crossref and Semantic Scholar (all of which send CORS headers, and all
of which index arXiv), the reader shows abstracts, PDFs become links out rather
than something you can read or save here, and Drive saves metadata without the
PDF. Highlighting, collections, notes and export are unaffected.

To get arXiv and the PDFs back on a static host, put the proxy on Cloudflare's
free tier — `worker/index.js` is the same routes in Workers form:

```bash
# your site's origin goes in ALLOWED_ORIGINS at the top of worker/index.js;
# it ships with https://saurav717.github.io and the two localhost ports.
npm run check:worker    # bundles it without deploying: ~24 KiB, no bindings
npm run deploy:worker   # asks you to log in the first time, then prints the URL
```

The URL it prints is `https://reader-arxiv-proxy.<your-subdomain>.workers.dev`
— `name` in `wrangler.toml` is the first half of it. Check it before depending
on it:

```bash
curl -H 'Origin: https://saurav717.github.io' https://<that>/health
# {"ok":true}, and Access-Control-Allow-Origin echoing that same origin
```

A wide-open proxy is one anyone can point at arXiv on your account's quota, so
`ALLOWED_ORIGINS` is not optional — a site that is not on the list fails CORS,
and from the page that looks exactly like the Worker being down. An origin is a
scheme and a host: `https://saurav717.github.io`, never the `/reader/` path the
app is served under.

Then tell the app about it. Either rebuild with `VITE_API_BASE` set to the
Worker's URL, or — and this is the point of it being a setting — paste that URL
into **Settings → Paper proxy** and press **Test it**. The address is kept in
this browser beside the client ID, takes effect immediately, and arXiv appears
in the source list without a reload. A site published once can be pointed at a
proxy, or moved to another one, without being rebuilt or redeployed.

`VITE_API_BASE` remains the default for the build; the setting only overrides
it. A proxy address has to be same-origin or `https` (or `http://localhost`),
since an `https` page cannot call an `http` one.

Whichever you pick, add the resulting origin to **Authorised JavaScript origins**
on your OAuth client before Google sign-in will work there.

## Connecting Google

Sign-in and Drive are two separate consents, and both are optional — without them
the app still works, with your library in this browser only.

There is no backend here, and that shapes everything below: the app talks to
Google from the page itself, with an OAuth client **you** own. Nothing you sign
into is visible to anyone hosting the site.

### 1. A Google Cloud project with the Drive API on

In the [Google Cloud Console](https://console.cloud.google.com/), create a
project (or pick one you already have), then **APIs & Services → Library →
Google Drive API → Enable**. Without this the sign-in works and every Drive call
comes back 403.

### 2. An OAuth client ID

**APIs & Services → Credentials → Create credentials → OAuth client ID → Web
application.**

You will be asked to configure the **OAuth consent screen** first if you have
not before: **External** user type, an app name, your own address for the
support and developer contact fields. Leave it in **Testing** and add every
Google account you will sign in with under **Test users** (newer consoles put
this under **Google Auth Platform → Audience**) — an app in testing can only be
used by the accounts listed there, which for a personal reading tool is exactly
right.

Miss that step and sign-in stops at Google's own page, before the app sees
anything:

> **Access blocked: <app> has not completed the Google verification process.**
> The app is currently being tested and can only be accessed by
> developer-approved testers. Error 403: `access_denied`

The fix is to add *that* account — the one named at the bottom of the block
page, which is not always the one you meant to use — to **Test users**, and to
sign in again. (A testing app's grant also expires after seven days, so you will
be asked to consent again about weekly. **Publish app** stops both: a
`drive.file`-only app asks for no sensitive scope and so is not subject to
Google's verification review, despite what the block page implies.)

Under **Scopes**, nothing needs adding: the app asks for what it needs at the
moment it needs it.

Then, on the client itself, fill in **Authorised JavaScript origins** with every
origin the app is served from — scheme and host, no path, no trailing slash:

| Where you run it | Origin to add |
| --- | --- |
| `npm run dev` | `http://localhost:5173` |
| `npm start` (built server) | `http://localhost:8080` |
| GitHub Pages | `https://yourname.github.io` |
| Vercel | `https://your-project.vercel.app` |

`https://yourname.github.io/reader/` is **not** an origin — the path is not part
of one, and pasting it is the most common reason sign-in fails with
`redirect_uri_mismatch` or a popup that closes instantly. **Authorised redirect
URIs** can be left empty: this app uses the token flow, which has no redirect.

Changes to a client can take a few minutes to propagate.

### 3. Give the app the client ID

Copy the client ID — it looks like
`000000000000-xxxxxxxxxxxx.apps.googleusercontent.com` — and put it in one of
three places, in order of how permanent you want it:

| Where | Applies to | Needs a rebuild |
| --- | --- | --- |
| **Settings → Google OAuth client ID** | this browser | no |
| `.env` (`VITE_GOOGLE_CLIENT_ID=…`, see `.env.example`) | your local builds, and it is gitignored | yes |
| `.env.production` | every build of this repo, including the deployed site | yes |

`.env.production` is committed, and holds the client ID this project's own
deployment is built with. That is deliberate: a client ID is **not** a secret.
It is visible in the page source of every browser-side OAuth flow by design,
and it is useless anywhere else, because Google only honours it on the origins
listed under **Authorised JavaScript origins** on the client itself. Someone who
copies it into their own site gets `redirect_uri_mismatch`, not your Drive.

The client **secret** issued alongside it is a different matter — and this app
never uses it. There is no backend to keep one in, and the token flow the page
uses does not send one. Leave it in the Cloud Console; it belongs in none of
these files.

A client ID set in Settings wins over the compiled-in one, so a fork does not
have to rebuild to use its own.

### 4. Connect Drive, which the app asks for first

With a client ID configured, **the connect screen stands in front of the app
until Drive is connected**. One button does both consents at once: your name and
email, and one scope, `drive.file` — *see, edit, create and delete only the
specific Drive files you use with this app*. Google's consent screen will phrase
it roughly that way. The app cannot read anything in your Drive that it did not
create, which is the whole point of using that scope rather than the blanket
one. **Not now** goes straight to the app with everything kept in this browser.

It asks **on every visit**, because it has to. A page with no backend cannot
hold a refresh token, so the token dies with the tab, and a paper added before
you reconnect is a paper Drive never hears about. The asking is cheap after the
first time: the app remembers *that* you connected, and reconnecting reuses the
grant you already gave — Google's window opens and closes again without a
question. Sign out, and it forgets.

Settings keeps both consents separately, for signing in without Drive at all.

Allow the popup if the browser blocks it — every step opens one, and a blocked
popup looks like nothing happening. The app says so when it can; see the table
under **What lands in Drive, and when**.

Settings then reads **Google Drive connected**, with a count of how many papers
are saved, and a **Sync all** button that pushes everything already in your
library.

### 5. Check it

Add a paper, open it, and look for the cloud tick in the reader's top bar —
click it and Drive opens on the file. In Drive itself, **My Drive →
Papers_collection**.

Tokens live in memory only, because there is no backend to hold a refresh token.
After an hour the app quietly asks Google for a new one using the grant you have
already given, with no dialog. Closing the tab ends the session; **Sign out**
revokes the token outright.

### What lands in Drive

```
My Drive/
  Papers_collection/                                  <- name configurable in Settings
    Fourier Neural Operator … (arXiv 2010.08895)/     <- one folder per paper
      Fourier Neural Operator … (arXiv 2010.08895).pdf
      Fourier Neural Operator … (arXiv 2010.08895).json
```

Every paper gets a folder of its own, created the first time it is saved, and
each row in a collection carries a Drive button that opens it. Which collections
a paper belongs to is recorded in the sidecar rather than in the path, because a
paper can be in several at once and a path can only say one thing.

A library synced under the older layout — one folder per collection — is moved
across the first time each paper syncs again: the files are re-parented in place
rather than downloaded and uploaded a second time.

The `.json` sidecar holds the paper's metadata and your highlights, shaped after the
[W3C Web Annotation](https://www.w3.org/TR/annotation-model/) model, so the export
is the storage format rather than a lossy copy of it. It is re-uploaded whenever you
edit a highlight or a note.

Two consequences of using the least-privilege `drive.file` scope, both deliberate:

- The app can only see files it created itself. It cannot read the rest of your Drive.
- For the same reason it cannot write into a pre-existing folder you point it at, so
  it creates its own top-level folder instead. Rename it in Settings; move it in Drive
  and the app will create a new one next time.

PDFs are fetched through the proxy — arXiv, or whichever repository Unpaywall,
OpenAlex or Semantic Scholar points at. A paper with no free copy anywhere any of
them can see saves its metadata sidecar and says so in the sync log.

### Removing a paper

The bin on a row does not act at once: a notice names the paper, says that it
leaves every collection with its highlights, and says what happens in Drive
before it happens. With Drive connected, the paper's folder is **moved to
`Papers_collection/Junk`**, PDF and sidecar inside it — not deleted — so getting
it back is dragging the folder up one level in Drive. Saving the same paper again
later makes a fresh folder in the root and leaves the junked one alone.

```
My Drive/
  Papers_collection/
    Junk/
      Fourier Neural Operator … (arXiv 2010.08895)/   <- removed from the library
```

If Drive refuses the move, the paper stays in the library and the notice says
why; it offers to remove the entry anyway and leave the copy in Drive where it
is. If Drive is not connected the notice says the copy stays put and offers to
connect first. A paper that was never saved to Drive says so, and only the entry
goes.

### What happens when you click Read

This is the whole path, because it is the part that has the most ways to go
quiet:

1. **The PDF is located.** arXiv papers already know where theirs is. For
   everything else the reader asks Unpaywall (if you have given a contact
   address), then OpenAlex, then Semantic Scholar — a search result and the
   per-work record often disagree about what is free to read. What it finds is
   kept with the paper, so the next open is immediate.
2. **It is fetched through the proxy**, in full, and handed to the browser's own
   viewer as a blob. In full, because a failure you can explain beats a blank
   grey pane. If Drive already holds a copy, it comes from there instead and the
   line under the title says **PDF from your Drive**.
3. **The same bytes go to Drive** — `Papers_collection/<title>/<title>.pdf`,
   beside the `.json` sidecar of your highlights. The copy uploaded is the one
   on screen, so reading a paper and saving it is one download, not two. The
   line under the title reads *saving to Drive…* while it happens, and a cloud
   tick appears in the top bar when it is done; click it and Drive opens on the
   file.
4. **Afterwards the reader opens that copy**, not the publisher's.

Step 3 is on by default and is **Settings → Save a paper when I open it**. It
exists because adding a paper is not when its PDF is usually within reach:
papers collected before you connected Drive, before you configured a proxy, or
on a day the publisher was down, have nothing in Drive but their metadata.
Opening one is the moment the file is at hand.

If nothing arrives in Drive, it is one of five things, and the app says which:

| What you see | What it is |
| --- | --- |
| No **PDF** switch in the top bar, a *no server* banner in Discover | No proxy configured — see **Settings → Paper proxy** |
| *its PDF will not reach Drive* under **Add to collection** on every search result | The line says which of the two is missing — the Drive consent, the proxy, or both |
| *Added, but the file is not in Drive* or *Added, but Drive would not take it* under the result you just added | The download or the upload failed, and the line carries the reason — which copies were tried, or what Google answered |
| *No open-access PDF could be found* in the sync log | The paper is not free to read anywhere the three indexes can see |
| *Drive request failed (403)* | The Drive API is not enabled on your Cloud project |
| A popup that closes instantly, or `redirect_uri_mismatch` | The origin is not on the OAuth client's **Authorised JavaScript origins** — and a path is not an origin |
| *Access blocked … has not completed the Google verification process*, `access_denied` | The consent screen is in **Testing** and the account shown on that page is not one of its **Test users** |
| *The Google window was closed before sign-in finished* | Either it was closed, or it was the block page above — that page ends the window without telling the app why, so the message carries the same advice |
| *The browser blocked the Google sign-in window* | Pop-ups are blocked for this site; allow them and click again |
| Nothing at all, Settings shows Drive as not connected | Sign-in is only identity; **Connect Drive** is the second consent |

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
4. It is fetched **once**. Opening a paper straight from a search result asks
   for the same file twice — the viewer to show it, the Drive sync to upload it
   — so a download in progress is handed to both, and the last one is held for
   a minute afterwards in case the second request is a moment late. The copy
   that goes to Drive is the copy on screen.

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

## Papers behind a login: signing in with your institution

IEEE, ACM, Springer, Elsevier and the rest hand their PDFs to a browser that has
signed in through a university, and a web page to everyone else. The proxy is
everyone else. It asks for the paper anonymously, gets the sign-in page, refuses
it — a page is not a PDF — and the result says so:

> Added, but the file is not in Drive: None of the 2 known copies of this paper
> would hand over a PDF (tried IEEE ×2) — IEEE asks for a sign-in.

Nothing the app's own page can do changes that. It may *open* the publisher in a
new tab, and if you are signed in there the PDF shows — but it may not *read* what
comes back, cookies or no cookies; that is the browser's cross-origin rule, and it
is the same rule that made the proxy necessary in the first place. So the sign-in
has to happen where the fetching happens: on the proxy.

That is what the offer under the result does. **Sign in at ieeexplore.ieee.org
with your institution** opens a real browser window — Chromium, on the machine
the proxy runs on — at the publisher's own page for the paper, where the
*Institutional Sign In* link is. Sign in there the way you would anywhere:
pick your institution, log in with its account, come back to the paper. Then
close the window, or press **I have signed in**, and the reader asks for the
paper again — and this time the proxy asks through that signed-in browser,
which is what turns the page into the file. It is saved to Drive and opened
like any other.

The session is kept in a browser profile of the proxy's own (`~/.reader/browser-profile`,
or `READER_PROFILE_DIR`), so the next paper from the same publisher needs no
sign-in: a copy that comes back as a login wall is retried through the profile
before anyone is asked. **Settings → Institutional access → Forget sign-ins**
deletes the profile and every session in it. Nothing is written anywhere else,
and no cookie ever reaches the page.

**It needs the proxy on your own machine.** A window has to open on a screen, and
the Cloudflare Worker has neither a screen nor a browser — so from the Worker the
same result explains that instead of offering a sign-in. The site on GitHub Pages
does not have to be rebuilt to use it:

```bash
git clone https://github.com/saurav717/reader.git && cd reader
npm install          # with the Chromium: that is the window
npm run build
npm start            # http://localhost:8080
```

then paste `http://localhost:8080` into **Settings → Paper proxy** on the site
and press **Test it**. The site keeps talking to Google for Drive as before; only
the fetching moves to your machine, and the proxy answers the site's origin by
name (`ALLOWED_ORIGINS`, comma-separated, extends the list). Settings shows
whether the proxy it is talking to can open a window, and why not when it cannot
— Playwright not installed, no Chromium, no display.

Two things worth knowing. If a sign-in page refuses the browser as "not secure"
— Google-backed institutional accounts sometimes do this to a Chromium that is
not Chrome — run the proxy with `READER_BROWSER_CHANNEL=chrome` (or `msedge`) and
it uses the browser you already have, with a profile of its own. And a sign-in
only gets what your institution subscribes to: a publisher that still answers
with a page after you have signed in is one your library does not have, and the
result says that too.

For IEEE specifically the landing page never links the file, so a signed-in
fetch asks IEEE's stamp endpoints for it by article number; for everyone else
the page's `citation_pdf_url` — the tag publishers put there for Google Scholar
— is followed to the file. `scripts/access.test.mjs` pins both.

### With only the Worker: hand the file over yourself

The Worker will never sign in for you, but the page can take a file from you.
Under the same result — and in the reader, when a PDF fails to load — is the
other way through: **open it at ieeexplore.ieee.org** in a tab of your own,
where your institution's sign-in already holds and the PDF simply shows,
download it, and **drop it on the result** or choose the file. It is checked to
be a PDF (a sign-in page saved as `.pdf` is refused), goes up to the paper's
folder in Drive, and the paper opens on it, with *PDF from your file* under the
title. Nothing leaves the browser except to Drive, and no proxy is involved at
all — which makes it the route that works from the site on GitHub Pages as it
is, and from any publisher, IEEE or not.

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
src/lib/api.ts          where the proxy is: the build's default, the setting
                        that overrides it, and the check behind "Test it"
src/lib/sources.ts      arXiv / OpenAlex / Semantic Scholar / Crossref search,
                        author search, the merge, and the OpenAlex lineage
                        query behind the lookup box
src/lib/sidecar.ts      the annotation format both mirrors write
src/lib/github.ts       the Git mirror: notes, index, BibTeX, one commit a flush
src/lib/contact.ts      the address OpenAlex, Crossref and Unpaywall ask for
src/lib/lookup.ts       dictionary and Wikipedia lookups for a selection
src/lib/status.ts       reading, not started or finished
src/lib/paperContent.ts fetches and sanitises the full text
src/lib/pdf.ts          finds a paper's PDF, fetches it (Drive first, then each
                        known copy in turn), and saves it
src/lib/locations.ts    every place a paper can be read from, and the Scholar links
src/lib/scholar.ts      the Google Scholar source, through the proxy
server/scholar.js       Scholar's pages, fetched and parsed; also the politeness
                        and the telling apart of a captcha from a network block
server/scholarBrowser.js  the same, through a real Chromium (SCHOLAR_BROWSER=1), and
                        the window a captcha is shown in
server/serpapi.js       Scholar through SerpApi instead, when SERPAPI_KEY is set
src/lib/google.ts       Google Identity Services + Drive REST
src/lib/driveSync.ts    what a synced paper looks like in Drive
src/lib/store.tsx       app state, IndexedDB persistence, the sync queue
src/lib/db.ts           IndexedDB wrapper
src/components/         the UI
scripts/smoke.mjs       browser smoke test (see below)
scripts/pdf-proxy.test.mjs  what the PDF proxy serves and what it refuses
scripts/search.test.mjs     query shapes, de-duplication and ranking
scripts/locations.test.mjs  which copies of a paper are collected, how duplicates
                            fold together, the order they are tried in, and the
                            fall-through when one will not answer
scripts/versions-drive.mjs  the whole chain in a browser (see below)
scripts/scholar.test.mjs    reading Scholar's HTML, pinned to saved fixtures
scripts/scholar-captcha.test.mjs  the captcha window's routes, and what they refuse to open
scripts/serpapi.test.mjs    Scholar through SerpApi, pinned to its documented answers
scripts/scholar-flow.mjs    Scholar search → versions → download → Drive → viewer
scripts/scholar-live.mjs    asks the real Scholar; run by hand, not in CI
scripts/fetch-paper.mjs     find and download a paper from a terminal, with no
                            browser and no proxy — `npm run fetch`
scripts/fakeGoogle.mjs      Identity Services and Drive, stubbed, for the two
                            browser tests
scripts/github.test.mjs     what the Git mirror writes, and that a flush is
                            one commit
scripts/proxy-setting.test.mjs  which proxy address wins, and what is refused
scripts/bundle.mjs          loads the app's TypeScript into the test runner
```

Your library, collections and highlights live in IndexedDB. Settings and the last
view live in `localStorage`.

## Tests

```bash
npm test                       # everything below that needs no network
npm run test:api               # the PDF proxy's rules, and the institutional sign-in around it
npm run test:unit              # query building, merging, the Git mirror, the proxy setting

npm run build && npm start     # in one terminal
node scripts/smoke.mjs         # in another

npm run build                  # then, needing no server of its own:
node scripts/versions-drive.mjs

npm run build:pages            # and the same checks against the static build,
BUILD=dist-pages SITE_PATH=/reader/ node scripts/versions-drive.mjs   # as Pages serves it

node scripts/scholar-flow.mjs  # the Scholar chain, against saved Scholar pages
npm run test:scholar           # ask the real Scholar — by hand, from a laptop
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
which is not on arXiv opens on its PDF too, that a synced paper is read back out of
Drive rather than fetched through the proxy twice, and that a paper collected before
Drive was connected is uploaded when it is opened — the copy on screen, fetched once. It writes screenshots to
`.smoke/`, and stubs arXiv, the PDF routes, the dictionary, Wikipedia, OpenAlex,
Crossref and Semantic Scholar, so it needs no network beyond the local server.

`scripts/versions-drive.mjs` drives the chain this reader exists for, on a paper
that is *not* on arXiv: search every index → list every copy → try them in order →
watch the first two fail (a publisher link that gives back a web page, a repository
link that has rotted) → download from the third → upload it to Drive → read it back
out of Drive and show it. It brings its own server and its own Drive: Google
Identity Services, the Drive REST API and the PDF proxy are all stubbed in the page,
so it needs no network and no Google account. It also checks that a name no index
keeps a record for says so, and offers Scholar. `BUILD` and `SITE_PATH` run the same
checks against `dist-pages` under a sub-path, which is the shape the deployed site
is served in.

`scripts/scholar-flow.mjs` does the same for the Scholar source: search Scholar →
open the paper → ask Scholar for every version → try each until one hands over a
file → save it to Drive → show the saved copy. Everything on this side of Scholar
is the shipped code, including the proxy routes and the HTML parsing; only the one
fetch this repository cannot make is replaced, by the saved pages in
`scripts/fixtures/`. It also checks that a captcha is reported as a captcha rather
than as an empty result.

**`npm run test:scholar` is the one that asks Scholar itself**, and it is meant to
be run by hand from a machine Google trusts. It prints what came back for a paper
and for a person, whether anything parsed, and — when nothing did — whether Scholar
refused or the request never reached it at all. `--save` overwrites the fixtures
with what Scholar returned, which is how to find out what changed when the parsing
tests start failing.

## Known limits

- PDF mode hands the file to the browser's own viewer, so highlighting only works in
  Reflow mode — which is why the switch is there, and why choosing it sticks. Reflow
  needs an HTML rendering, which arXiv has for recent papers and ar5iv has for most
  older ones; otherwise the reader falls back to the abstract.
- A PDF is only there to be had if the paper is open access, or your institution
  subscribes to it. Behind a paywall, every copy in the versions list is the
  publisher's, none of them will answer an anonymous request, and the reader says
  which ones it tried and offers the sign-in above — which only a proxy on your own
  machine can open a window for, never the Worker.
- Google Scholar is scraped, not queried, because there is no API to query. That
  means two things. It breaks if Google changes its markup — `npm test` pins the
  parsing to saved fixtures, so it fails loudly rather than returning nothing — and
  it is refused outright from datacentre IPs, which is where a proxy usually runs.
  `node scripts/scholar-live.mjs` says which of those is happening from a given
  machine.
- The whole PDF is fetched before the viewer sees it, which is what makes a failure
  explainable rather than a blank pane — but it also means no progressive rendering,
  and a cap (64 MB) on how big a file the proxy will pass. The most recent one is
  also held for a minute after it lands so that the viewer and the Drive upload are
  one download; that is one paper's worth of memory, not a cache of your library.
- A static deployment cannot save PDFs to Drive on its own. Drive will not fetch a
  URL for you, and the browser will not fetch a publisher's PDF from the page, so
  without a proxy the only thing that reaches Drive is the metadata sidecar. The
  Worker in `worker/` is what makes the rest of it work, and Settings → Paper proxy
  is where its address goes.
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
