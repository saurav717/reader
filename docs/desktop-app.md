# The Reader desktop app: macOS, Windows and Linux

Reader as a real app: a window of its own, with no browser needed or looked
for. It installs like any program (a `.dmg` on macOS, a setup wizard on
Windows, a `.deb`, `.rpm` or AppImage on Linux) and uninstalls like one. The
*Connect this computer* card's **Download for …** offers the newest release for
the computer it's on. Until a release exists, the card falls back to the
installer scripts (`.command`, `.cmd`, `curl … | sh`).

## What it is

The app is [Electron](https://www.electronjs.org/): it carries its own engine,
so the page runs the same on every system, and it reaches the Companion on
`127.0.0.1` as Chrome does. That includes Safari's Macs, where a browser tab
can't. The window shows the site itself (`https://saurav717.github.io/reader/`).
So the app always has the newest site with no app update.

- **The first time it opens** (and after an update that brings a newer
  Companion) it shows how setting up goes. It installs the Reader Companion
  from the wheel inside the app, with the `uv` inside the app, and a Python of
  its own in `~/.reader-companion/python`. Then it runs
  `reader-companion setup --no-app --print-url`: the Jupyter server at every
  login, the Reader extension in VS Code, and the page paired with this
  computer. The address it prints opens in the window.
- **Every time after**, it runs `reader-companion open --print-url`, which
  starts the Companion if it isn't running, and shows the site.
- If the Companion can't start, the window says why and offers **Try again**
  or **Open Reader without it**. Only running code on this computer needs it.

**Meeting notes.** On macOS and Windows the app also carries Recall.ai's
Desktop Recording SDK ([`desktop/app/notes.js`](../desktop/app/notes.js)): it
finds a Zoom, Meet, Teams or Slack meeting open on the computer and records it
for Reader's notes when the site asks — no bot joins the call (see the README's
Calendar section). macOS asks once for the microphone, screen recording and
accessibility; Settings → Account → Meetings has a button for each.

Links to other sites open in your browser. The Companion's own pages (Jupyter,
VS Code) stay in the app.

**Signing in to Google** happens in your browser: Google turns sign-in down
inside an app's window ("This browser or app may not be secure"). The app opens
the site's [`app-sign-in`](../public/app-sign-in/index.html) page there, Google's
usual window signs you in, and the page hands the result back to the app with a
`reader-app://` link (the browser may ask once to open Reader). The app checks
the link carries the code it opened the page with, and only the site's pages
can ask for a sign-in.

The parts:
- [`desktop/app/main.js`](../desktop/app/main.js): the app: the window, setting up, the menus, Uninstall.
- [`desktop/app/ui/`](../desktop/app/ui): its own pages: starting, uninstalling, no connection.
- [`desktop/app/scripts/prepare-companion.mjs`](../desktop/app/scripts/prepare-companion.mjs): puts uv (checked against pinned hashes) and the Companion's wheel inside the app.
- [`desktop/app/electron-builder.config.cjs`](../desktop/app/electron-builder.config.cjs): the installers.
- [`desktop/app/build/installer.nsh`](../desktop/app/build/installer.nsh): what the Windows installer and uninstaller add.
- [`.github/workflows/desktop-app.yml`](../.github/workflows/desktop-app.yml): builds all three on GitHub's own Macs, Windows and Linux machines, and publishes them.

## Installing

| | Download | Then |
|---|---|---|
| macOS | `Reader-<version>.dmg` (one app for Apple silicon and Intel) | Open it, drag **Reader** to Applications, open Reader. |
| Windows | `Reader-Setup-<version>.exe` | A setup wizard: for you only (no admin password) or for everyone on the PC, and where to. Reader is then in the Start menu and on the desktop. |
| Linux | `reader_<version>_amd64.deb` (Ubuntu, Debian), `reader-<version>.x86_64.rpm` (Fedora, openSUSE), `Reader-<version>-x86_64.AppImage` (any) | Open the package with your software installer (or `sudo apt install ./reader_….deb`, `sudo dnf install ./reader-….rpm`). Or make the AppImage executable and run it: it adds itself to your applications. |

## Uninstalling

Every way of uninstalling does the same:
- stops the Companion and stops it starting at login;
- removes its `reader-companion://` link, the Companion program, the Reader app
  and its shortcuts;
- removes the Reader extension from VS Code (a box to untick if you'd rather
  keep it).

Your files stay unless you tick **Also delete my files and settings**. That
deletes `~/Reader` (your projects and notebooks), `~/.reader-companion` (the
Companion's settings and its Python), and what the app keeps: a library you
didn't sign in to Google Drive with. A library in Google Drive is never
touched. (`~/Reader` is never deleted when it's been set to your home folder,
Documents, Desktop or the like.)

| | How |
|---|---|
| macOS | Open Reader → **Reader** menu → **Uninstall Reader…**. It moves Reader to the Bin when it's done. Dragging Reader to the Bin yourself works too: the Companion notices within a couple of minutes and stops starting at login (your files stay). |
| Windows | **Settings → Apps → Installed apps → Reader → Uninstall**, or **Uninstall Reader** in the Start menu, or **Help → Uninstall Reader…** in the app. |
| Linux | **Uninstall Reader** in your applications (right-click Reader, or its own entry for the AppImage), or **Help → Uninstall Reader…** in the app, or `reader --uninstall`. These ask for your password to remove the package. `sudo apt remove reader` / `sudo dnf remove reader` work too: the Companion notices the app is gone and stops starting at login. |

By hand, anywhere: `reader-companion uninstall --vscode` (add
`--delete-files` to delete your files too), then
`uv tool uninstall reader-companion`.

## Building it

```sh
cd desktop/app
npm ci
npm run dist          # this computer's installers, in desktop/app/dist
npm start             # or run it from source (after: node scripts/prepare-companion.mjs)
```

A `.dmg` needs a Mac and a Windows installer needs Windows (or Wine). The
workflow builds each on its own system: every pull request that touches the
app or the Companion builds all three as artifacts to try out. Each merge into
`main` that touches them publishes the GitHub Release `app-v<Companion version>`
(as do **Actions → Desktop app → Run workflow** with *release* ticked, and a
tag `app-v…`). The site asks GitHub for the newest release and offers it.

## Signing (optional)

Unsigned, the installers work, with one extra step the first time:
- the release names them `…-unsigned`;
- macOS stops the app once (*"Apple could not verify…"*): **Done**, then
  **Open Anyway** in System Settings → Privacy & Security;
- Windows SmartScreen asks once: **More info → Run anyway**.

Signed, they open with no warning.

### macOS: an Apple Developer membership

US$99 a year, at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/).

1. **Make a Developer ID Application certificate.** In Xcode → Settings →
   Accounts, add the Apple Account, pick the team, then **Manage
   Certificates… → + → Developer ID Application**.
2. **Export it as a `.p12`.** In Keychain Access → *My Certificates*,
   right-click **Developer ID Application: Your Name (TEAMID)** → *Export*,
   choose a password, then `base64 -i DeveloperID.p12 | pbcopy`.
3. **Make an app-specific password** at [account.apple.com](https://account.apple.com) →
   Sign-In and Security → App-Specific Passwords.
4. **Find your Team ID** at developer.apple.com → Account → Membership details.

### Windows: a code signing certificate

From a certificate authority, as a `.pfx`, then `base64 -w0 cert.pfx`.
[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
(about US$10 a month) is cheaper. The workflow doesn't use it yet.

### The secrets

In **github.com/saurav717/reader → Settings → Secrets and variables →
Actions → New repository secret**:

| Secret | What goes in it |
|---|---|
| `MACOS_CERTIFICATE` | the base64 `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | its password |
| `APPLE_ID` | the Apple Account's email |
| `APPLE_TEAM_ID` | the Team ID |
| `APPLE_APP_PASSWORD` | the app-specific password |
| `WINDOWS_CERTIFICATE` | the base64 `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | its password |

With the Apple ones, the workflow signs the app with the hardened runtime and
has Apple notarize it. Both installers are then published without
`-unsigned`, and the card says they open with no warning.

## Updating

The site updates by itself: the app shows the site. For the Companion, change
its version in `companion/pyproject.toml` and merge: the merge publishes
`app-v<version>`. The app compares the Companion inside it with the installed
one and sets up again when its own is newer. **Settings → Updates → Update**
on the site also updates an installed Companion, without a new app.
