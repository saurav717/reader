# Reader Companion: your machines, one click from the page

The Playground runs code on any Jupyter server. Today you start that server
yourself: a `pip install`, a long `jupyter server` command with this site's
origin in it, then you paste the token into a form. That works, but it is the
wrong job to give a person, and it stops when the terminal closes.

The **Companion** does that job. It is a small app you install once (a `.dmg`
on a Mac, an installer on Windows, a single binary on Linux and GPU boxes).
It keeps a Jupyter server running in the background, pairs with the site in
one click, and keeps a folder on disk, the site and VS Code showing the same
project. This document is the design. **None of it is built yet.**

---

## The idea in one paragraph

A playground project is **a folder on disk**. The Companion owns that folder
and the kernel that runs it, and it is the one thing every client talks to:
the website in any browser, VS Code through a thin extension, and another
Companion on a GPU machine. The disk is the source of truth. The site and
VS Code are views onto it, and a copy in your Google Drive keeps the project
readable when the machine is off. The site already speaks Jupyter
(`chooseBackend` in `src/lib/colab.ts`), so the first version needs almost no
new code on the page: pairing just produces the `{ url, token }` record the
"Add a server" form makes by hand today.

```
            ┌────────────── your Mac ───────────────┐
            │                                       │
 browser ───┼──► Companion (menu bar)               │
 (site)     │      ├─ Jupyter server (kernels, files)
            │      ├─ file watcher ──► live updates │
 VS Code ───┼──►   ├─ pairing + device tokens       │
 (extension)│      └─ sync ──────────────┐          │
            │   ~/Reader/Projects/<name>/ │          │
            └─────────────────────────────┼──────────┘
                                          │  folder copied before a run,
                                          ▼  runs/ and results/ back
                         ┌──── GPU machine ────┐
                         │ Companion (headless)│        Google Drive
                         │ Jupyter + kernels   │        (a read-only mirror
                         └─────────────────────┘         of each project)
```

---

## What it looks like

### 1 · Install

- **Download from the site.** Playground → **Your compute** → **Get the
  Companion** detects the OS and offers `Reader-Companion.dmg` (Apple Silicon
  and Intel in one universal build), a Windows installer, or for Linux and
  GPU boxes:
  `curl -fsSL https://…/install.sh | sh`.
- **Signed and notarized.** The `.dmg` is signed with a Developer ID and
  notarized, so macOS opens it without the "unidentified developer" warning.
  It updates itself (Sparkle on macOS, the same feed for the other builds).
- **No Python needed up front.** On first run it uses a bundled
  [`uv`](https://github.com/astral-sh/uv) to create its own Python environment
  with `jupyter_server` and `ipykernel`, in `~/Library/Application
  Support/Reader`. A project can ask for more (a `requirements.txt` or
  `pyproject.toml`), and the Companion installs it into that project's own
  environment. Your system Python is never touched.

### 2 · Pair with the site (one click)

1. The Companion opens to a single screen: **Connect to Reader**.
2. Clicking it opens the site at `/playground#pair=<one-time-code>`. The code
   goes in the URL **fragment**, so it never reaches a server or a log.
3. The page shows **"Connect this Mac (Saurav's MacBook Pro)?"**. You click
   **Connect**, and the page and Companion exchange the code for a long-lived
   **device token**.
4. **This PC** appears under *Your compute* with a green dot, and the
   "Where should it run?" dialog picks it by default. Nothing is typed or pasted.

The other way round works too: the site shows a 6-digit code, and you type it
into the Companion. That covers pairing a second browser, or a phone.

**Settings → Devices** lists every paired machine, with its last-seen time
and a **Revoke** button.

### 3 · The menu bar

```
 ● Reader Companion
 ─────────────────────────────
   Connected · 2 browsers, VS Code
   Kernel: python 3.12 · idle
 ─────────────────────────────
   Projects
     attention-sweep        ▸  Open in VS Code
     flash-attn-repro       ▸  Reveal in Finder
 ─────────────────────────────
   GPU machines
     ● lab-a100   (idle)
     ○ runpod-4090 (offline)
 ─────────────────────────────
   Pause · Settings · Quit
```

It starts at login (optional), uses no CPU while idle, and stops kernels that
have been idle for a set time.

### 4 · A project, three ways in

Each project is a plain folder:

```
~/Reader/Projects/attention-sweep/
  .reader/project.json   ← id, title, papers it cites, which machine runs it
  notebook.ipynb
  train.py
  runs/   results/       ← what comes back from a GPU run
```

- **On the site.** The project opens exactly as it does today. Edits go through
  the Jupyter contents API straight to disk.
- **In Finder or any editor.** Edit `train.py` in anything. The Companion's file
  watcher sees the change and pushes it to every open page, and the page
  refreshes that file in place. If you also had unsaved edits to it, the page
  offers **Keep mine / Take the disk's** instead of overwriting.
- **In VS Code.** See below.

### 5 · VS Code

You need **no extension** to start: **Open in VS Code** on the site (and in
the menu bar) uses VS Code's own `vscode://file/<path>` link to open the folder.
VS Code's Jupyter support can then use the Companion's server as the kernel.

The **Reader extension** (VS Code Marketplace and Open VSX) makes that
seamless and adds the site's own features:

- **Reader sidebar.** Your projects (the Companion lists them), the papers each
  one cites, and its GPU machines with their state.
- **Kernel picked automatically.** It registers the Companion with VS Code's
  Jupyter extension, using the remote-server provider API, so a notebook in a
  Reader project runs on the right kernel with no prompt.
- **Citations.** A `# ¶ FlashAttention-2 §3.1` comment becomes a link, and its
  hover shows the passage. Clicking opens the paper on the site at that place.
- **Run on GPU.** The command palette's **Reader: Run on lab-a100** calls the
  Companion to sync the folder, run the command, and stream the output into a
  terminal. `runs/` and `results/` come back the way the site's split mode
  does it.
- **Open on the site.** This opens the same project in the browser, with
  Metrics and the Explain pages.

The extension holds no state and no sync logic of its own. It only talks to
the Companion on `localhost`, so VS Code and the site can never disagree.

### 6 · GPU machines without SSH tunnels

You install the same Companion on the GPU box in headless mode
(`reader-companion --headless`) and pair it with a code. Then it appears
under *GPU machines* everywhere.

- **It dials out.** It opens an outbound connection to the site's relay (see
  below), so there is no port to open, no tunnel, and no `?token=` to copy.
  That works behind a lab firewall or NAT, and on RunPod and similar hosts.
- **Split mode is direct.** The Mac's Companion copies the folder to the GPU
  Companion before a run and brings `runs/` and `results/` back. It copies
  only what changed (content hashes), and it can handle large files, unlike
  the page's current 2 MB limit through the contents API.

### 7 · "Updated online"

The disk is the truth, but the project should not vanish when the laptop is
closed:

- **A Drive mirror.** The library already lives in your Google Drive. The
  Companion mirrors each project's text files (code, notebooks, `project.json`,
  small results) to `Reader/Projects/<name>/` there. The site reads that copy
  when no Companion is online and shows the project **read-only**, with
  "last synced 2 h ago".
- **A second computer.** A Companion on another machine pulls the mirror on
  first open, so the project follows you. If both machines changed the same
  file while apart, one copy is kept as `train (conflict, MacBook).py` and you
  choose. Nothing is silently lost.
- **Git where it fits.** A project that is a git repository (*From a
  repository*) syncs through git instead. The Companion shows its branch and
  status, and never commits on its own.
- **Out of the mirror.** `runs/`, `results/` and weights above a size limit
  are listed but not uploaded, unless a project's keep rules (playground.md,
  step 7) say so.

---

## How it connects

The page has to reach the Companion from any browser. There are two routes,
and both carry the same protocol (Jupyter's REST and WebSocket APIs, plus a
small `/companion/*` set for pairing, file events and sync):

1. **Directly on `localhost`.** The Companion listens on
   `127.0.0.1:<port>`, and the page connects there. This is the fastest route,
   and nothing leaves the machine. Browsers differ on whether an `https://`
   page may call `http://localhost`, and some ask for local-network
   permission. The page tries this route first.
2. **Through the relay.** The Companion keeps one outbound WebSocket open to
   the site's Worker (a Durable Object per paired device, much like the
   Worker's existing Colab socket relay in `worker/colabSocket.js`). The page
   connects to the same object. This route works in every browser, from a
   phone, and for GPU machines behind NAT.
   **Traffic is encrypted end to end** with a key exchanged at pairing, so the
   relay forwards bytes it cannot read.

The page uses the direct route whenever it answers, falls back to the relay,
and shows which one it is on in the machine chip.

### Security

- A pairing code is single-use and lasts five minutes. A device token is
  scoped to one device, stored in the OS keychain, and can be revoked from
  either side.
- The Companion accepts requests only from the site's origin, from the
  extension (with a token it gets over a local socket), or from the relay with
  a valid device token.
- Kernels run as you, inside the projects folder. The file API serves nothing
  outside `~/Reader/Projects` unless you add a folder in Settings.
- Secrets (playground.md, step 8) live in the keychain and are passed to a
  kernel's environment. They are never put in the Drive mirror.

---

## What it is built from

| Part | Choice | Why |
|---|---|---|
| Companion core | **Go**, one static binary | Cross-compiles to macOS, Windows, Linux (x86 and ARM) with no runtime. The same binary runs the GUI's backend and the headless GPU mode. |
| Desktop shell | **Tauri** (menu bar + pairing screen) | A ~10 MB app instead of Electron's ~150 MB, and it uses the system web view. It packages to `.dmg` and `.msi`, with signing and auto-update built in. |
| Kernels | `jupyter_server` + `ipykernel`, in a `uv`-managed env | The protocol the page already speaks. `uv` makes the first-run install take seconds. |
| Relay | The existing Cloudflare Worker + a Durable Object | It is already deployed, and it already relays a socket for Colab. |
| Mirror | Google Drive, through the same `drive.file` scope the library uses | No new account, and no new consent. |
| VS Code | A TypeScript extension, published to the Marketplace and Open VSX | Thin: it talks only to the Companion. |

---

## Order of work

Each step is useful on its own:

1. **`reader-companion` CLI.** It starts Jupyter with the right flags, keeps it
   running, and pairs through `/playground#pair=`. The page's only change is
   to accept the fragment and save the server record it carries. That alone
   removes the copy-and-paste.
2. **The Mac app.** It wraps step 1 in Tauri as a signed, notarized `.dmg`, with
   the menu bar, launch at login, and auto-update.
3. **File watching and live updates.** It pushes disk changes to open pages,
   with the keep-mine/take-disk choice.
4. **Open in VS Code** (a link, no extension), then the **extension**: the
   sidebar, automatic kernel, citations, Run on GPU.
5. **Relay and headless GPU mode.** Outbound pairing for GPU boxes, end-to-end
   encryption, and Companion-to-Companion sync for split mode.
6. **The Drive mirror.** Read-only when offline, a second computer, and conflict
   copies.
7. **Windows and Linux desktop builds.** The core already runs there from
   step 1.

## Open questions

- **Where projects live by default:** `~/Reader/Projects`, or ask on first run?
- **The relay's cost and limits:** heavy kernel output through Durable Objects
  may need a cap, or the direct route, for large outputs.
- **Apple Developer ID:** notarizing needs a paid Apple developer account
  ($99/year).
- **One Companion, many accounts:** pair it with one Google account at a time,
  matching the library's "one library per account"?
