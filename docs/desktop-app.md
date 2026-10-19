# The Koios desktop app: macOS, Windows and Linux

Koios as a real app: a window of its own, with no browser needed or looked
for. It installs like any program (a `.dmg` on macOS, a setup wizard on
Windows, a `.deb`, `.rpm` or AppImage on Linux) and uninstalls like one. The
*Connect this computer* card's **Download for …** offers the newest release for
the computer it's on. Until a release exists, the card falls back to the
installer scripts (`.command`, `.cmd`, `curl … | sh`).

## Reader became Koios (0.16)

The app was called **Reader** until 0.16; from the release after the rename its installers, its window, its menus
and its dialogs say **Koios** (`Koios-<version>.dmg`, `Koios-Setup-<version>.exe`, `koios_<version>_amd64.deb`…).
What an installed copy is known by stayed the same, so Koios takes Reader's place rather than sitting beside it:

| Kept | Why |
| --- | --- |
| The app id `io.github.saurav717.reader` | macOS and Windows know it as the same app: Windows' installer replaces Reader, and the Companion still finds the app if you move or delete it. |
| The folder it keeps its things in (`Reader`, in the system's app-data folder) | Your sign-ins, the library not in Google Drive and the window's place carry over. |
| `reader-app://` links | Google's sign-in comes back to the app by them (the Worker's callback). |
| The Companion's command, `reader-companion`, and its folders `~/Reader` and `~/.reader-companion` | Everything already set up keeps working. |

- **macOS:** a Reader app can't update itself into Koios (its updater looks for `Reader.app` inside the update).
  Download Koios once from the site or the releases page, drag it to Applications, open it, then delete Reader.
  From then on Koios updates itself.
- **Windows:** run `Koios-Setup-<version>.exe`: it installs over Reader (same app id), and the Start menu has Koios.
- **Linux:** the `koios` package replaces the `reader` one (`Replaces:` and `Conflicts: reader`); the AppImage is
  `Koios-<version>-x86_64.AppImage`.
- The site's **Download for …** offers the newest release under either name, and the Companion's own installers
  are `Koios-Companion-mac.zip`, `Koios-Companion-Setup.cmd` and `koios-companion-setup.sh` (the `Reader-…` names
  still download them, for old links).

## What it is

The app is [Electron](https://www.electronjs.org/): it carries its own engine,
so the page runs the same on every system, and it reaches the Companion on
`127.0.0.1` as Chrome does. That includes Safari's Macs, where a browser tab
can't. The window shows the site itself (`https://koios.dev/`).
So the app always has the newest site with no app update.

- **The first time it opens** (and after an update that brings a newer
  Companion) it shows how setting up goes. It installs the Koios Companion
  from the wheel inside the app, with the `uv` inside the app, and a Python of
  its own in `~/.reader-companion/python`. Then it runs
  `reader-companion setup --no-app --print-url`: the Jupyter server at every
  login, the Koios extension in VS Code, and the page paired with this
  computer. The address it prints opens in the window.
- **Every time after**, it runs `reader-companion open --print-url`, which
  starts the Companion if it isn't running, and shows the site.
- If the Companion can't start, the window says why and offers **Try again**
  or **Open Koios without it**. Only running code on this computer needs it.

**Meeting notes.** On macOS and Windows the app also carries Recall.ai's
Desktop Recording SDK ([`desktop/app/notes.js`](../desktop/app/notes.js)): it
finds a Zoom, Meet, Teams or Slack meeting open on the computer and records it
for Koios's notes when the site asks — no bot joins the call (see the README's
Calendar section). macOS asks once for the microphone, screen recording and
accessibility; Settings → Account → Meetings has a button for each.

Links to other sites open in your browser. The Companion's own pages (Jupyter,
VS Code) stay in the app.

**Signing in to Google** happens in your browser: Google turns sign-in down
inside an app's window ("This browser or app may not be secure"). The app opens
the site's [`app-sign-in`](../public/app-sign-in/index.html) page there, Google's
usual window signs you in, and the page hands the result back to the app with a
`reader-app://` link (the browser may ask once to open Koios). The app checks
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
| macOS | `Koios-<version>.dmg` (one app for Apple silicon and Intel) | Open it, drag **Koios** to Applications, open Koios. |
| Windows | `Koios-Setup-<version>.exe` | A setup wizard: for you only (no admin password) or for everyone on the PC, and where to. Koios is then in the Start menu and on the desktop. |
| Linux | `koios_<version>_amd64.deb` (Ubuntu, Debian), `koios-<version>.x86_64.rpm` (Fedora, openSUSE), `Koios-<version>-x86_64.AppImage` (any) | Open the package with your software installer (or `sudo apt install ./koios_….deb`, `sudo dnf install ./koios-….rpm`). Or make the AppImage executable and run it: it adds itself to your applications. |

## Uninstalling

Every way of uninstalling does the same:
- stops the Companion and stops it starting at login;
- removes its `reader-companion://` link, the Companion program, the Koios app
  and its shortcuts;
- removes the Koios extension from VS Code (a box to untick if you'd rather
  keep it).

Your files stay unless you tick **Also delete my files and settings**. That
deletes `~/Reader` (your projects and notebooks), `~/.reader-companion` (the
Companion's settings and its Python), and what the app keeps: a library you
didn't sign in to Google Drive with. A library in Google Drive is never
touched. (`~/Reader` is never deleted when it's been set to your home folder,
Documents, Desktop or the like.)

| | How |
|---|---|
| macOS | Open Koios → **Koios** menu → **Uninstall Koios…**. It moves Koios to the Bin when it's done. Dragging Koios to the Bin yourself works too: the Companion notices within a couple of minutes and stops starting at login (your files stay). |
| Windows | **Settings → Apps → Installed apps → Koios → Uninstall**, or **Uninstall Koios** in the Start menu, or **Help → Uninstall Koios…** in the app. |
| Linux | **Uninstall Koios** in your applications (right-click Koios, or its own entry for the AppImage), or **Help → Uninstall Koios…** in the app, or `koios --uninstall`. These ask for your password to remove the package. `sudo apt remove koios` / `sudo dnf remove koios` work too: the Companion notices the app is gone and stops starting at login. |

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
`main` that touches them publishes a new GitHub Release, `app-v<version>` (as do
**Actions → Desktop app → Run workflow** with *release* ticked, and a tag
`app-v<version>`, which names its own version). `<version>` is the Companion's
major.minor and the workflow run's number — `0.14.312` — so every release is
newer than the one before. The site asks GitHub for the newest release and
offers it.

Every version stays published, each for every system:
[github.com/saurav717/reader/releases](https://github.com/saurav717/reader/releases).
Beside the installers, each release has the files the app updates itself from:
`latest-mac.yml` with `Koios-<version>-mac.zip`, `latest.yml` with the
`.exe`'s `.blockmap`, and `latest-linux.yml`.

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

## Staying signed in

The site's sign-in is Google's token flow in the page: an access token that
lasts an hour, with no backend to renew it, so every visit reconnects with a
click. The app does better (`desktop/app/google.js`): it signs in by the
authorization-code flow, through the browser — Google turns sign-in down
inside an app's own window — and keeps the refresh token Google gives,
sealed by the system (the Keychain on a Mac, DPAPI on Windows, the keyring
on Linux) in the app's data folder. From then on the app opens signed in,
renewing the token itself with no window; the page is told there is a kept
sign-in (`readerDesktop.google.kept`) and signs in as it loads, with no
click. Sign out and the app forgets the grant and gives it back to Google.

The exchange needs the OAuth client's secret, so the Worker makes it
(`worker/googleDesktop.js`, `/google/desktop/*`), with the same client the
site uses and the `GOOGLE_CLIENT_SECRET` secret; the Worker keeps nothing.
Set it up once:

1. Google Cloud Console → APIs & Services → Credentials → the Web client
   Koios uses → **Authorised redirect URIs** → add
   `https://<your worker>/google/desktop/callback`.
2. The client's secret (shown on the same page) on the Worker:
   `npx wrangler secret put GOOGLE_CLIENT_SECRET`, then deploy the Worker.
3. `/health` answers `"googleDesktop": true`. The next sign-in in the app
   asks for consent once (Google gives a refresh token on consent), and keeps.

The site does the same now, where the Worker is set up so (`src/lib/googleStay.ts`):
consent in a popup that lands on the same callback page, which hands the code to
the page that opened it instead of to the app; the exchange at the same route,
with PKCE; the refresh token kept in the browser's `localStorage` rather than the
system's keychain — the one difference, and the reason the app's way is still
the safer of the two. A renewal from the grant needs no window, so the hourly
prompt goes; a grant Google refuses (`invalid_grant`) is forgotten and the next
ask opens Google's window again.

Without the secret, the app signs in the way the site does
(`public/app-sign-in/`), an hour at a time. An OAuth consent screen left in
**Testing** has its refresh tokens expire after seven days; **Publish app**
ends that.

## Updating

The app updates itself (`desktop/app/updates.js`). Twenty seconds after it
opens, and every six hours after, it asks the newest release whether there is a
newer version, downloads it in the background, and offers **Restart Now**; with
**Later** it is put in place the next time Koios quits. **Check for Updates…**
(the Koios menu on a Mac, Help elsewhere) and **Settings → Updates → Koios
app** ask now; **Help → Every Version of Koios** opens the releases page.

- **Windows, Linux**: electron-updater — the setup `.exe` run again silently,
  the AppImage replaced, or the `.deb`/`.rpm` installed (it asks for your
  password).
- **macOS**: the new `Koios.app` is downloaded as a `.zip`, checked against
  its SHA-512 in `latest-mac.yml`, and, once Koios has quit, takes the old
  one's place. (electron-updater's own way on a Mac needs a Developer ID
  signature.) A Koios run from its disk image, or from a folder you can't
  write to, is sent to the releases page instead. An unsigned app is new to
  macOS after each update, so meeting notes may need Koios switched off and on
  again in System Settings → Privacy & Security; signing the app ends that.

To go back to an older version, download it from the releases page and install
it over the newer one; the app doesn't go back by itself.

The site updates by itself: the app shows the site. For the Companion, change
its version in `companion/pyproject.toml` and merge: the merge publishes
`app-v<version>`. The app compares the Companion inside it with the installed
one and sets up again when its own is newer. **Settings → Updates → Update**
on the site also updates an installed Companion, without a new app.
