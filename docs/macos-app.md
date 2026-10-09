# Reader for macOS: Reader.app in a `.dmg`

The *Connect this computer* card's **Download for macOS** gives a `.command`
in a zip until a release of Reader.app is published, then that `.dmg`. macOS
stops anything downloaded that Apple hasn't checked, once, with *"Apple could
not verify … is free of malware"*. A `.dmg` signed with a Developer ID and
**notarized** by Apple opens with no warning at all; that needs a paid Apple
Developer membership. Without one, the same app is published unsigned and
needs one click in System Settings the first time. This is how to make either.

## What it is

`Reader.dmg` holds **Reader.app**: drag it to Applications and open it.

- **The first time** (and after an update) it shows a small window while it
  installs the Reader Companion from the wheel inside it, with the `uv` inside
  it and uv's own Python. Then it runs `reader-companion setup --no-app`: the
  Jupyter server at every login, the Reader extension in VS Code, and the site
  opened to pair.
- **Every time after**, it runs `reader-companion open`. That starts the
  Companion if it isn't running and opens the site in a window of its own
  (Chrome, Edge or Brave as an app window, else your default browser).

The parts:
- [`desktop/macos/Reader.swift`](../desktop/macos/Reader.swift): the app, a small AppKit program.
- [`desktop/macos/install.sh`](../desktop/macos/install.sh): what it runs to set up.
- [`desktop/macos/build.sh`](../desktop/macos/build.sh): builds, signs, notarizes and makes the `.dmg`.
- [`.github/workflows/macos-app.yml`](../.github/workflows/macos-app.yml): runs `build.sh` on GitHub's Macs.

## Without the membership: the same app, not notarized

Signing and notarizing cost US$99 a year (below). Without them the workflow
still builds the very same Reader.app, and **Actions → macOS app → Run
workflow** with *release* ticked, and every merge into `main` that touches the
app or the Companion, publishes it as `Reader-unsigned.dmg`. The
card offers that one, with the step it needs: macOS stops it the first time
(*"Apple could not verify…"*). Click **Done**, then **Open Anyway** in System
Settings → Privacy & Security, and **Open**. That is once per Mac; after it,
Reader opens like any app. (The app copies its `uv` out and clears that copy's
quarantine mark, so the setup doesn't get stopped a second time.)

The one-line installer on the card (`curl … companion-setup.sh | sh`, pasted
into Terminal) isn't stopped at all, since macOS only checks what a browser
downloads, and it makes a Reader app too.

When a notarized `Reader.dmg` is published later, the card offers that
instead, with no step.

## What you need (once): an Apple Developer membership

Signing and notarizing need the **Apple Developer Program**: US$99 a year, in
your own name (an individual) or a company's. Nothing else costs anything.

1. **Join** at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/)
   with your Apple Account. It usually takes a day or two to be approved.
2. **Make a Developer ID Application certificate.** On your Mac, open Xcode →
   Settings → Accounts, add the Apple Account, pick the team, then **Manage
   Certificates… → + → Developer ID Application**. (Or without Xcode:
   Keychain Access → Certificate Assistant → *Request a Certificate From a
   Certificate Authority*, saved to disk, then upload that request at
   developer.apple.com → Certificates → + → *Developer ID Application* and
   open the `.cer` it gives you.)
3. **Export it as a `.p12`.** In Keychain Access → *My Certificates*,
   right-click **Developer ID Application: Your Name (TEAMID)** → *Export*,
   choose a password. Then turn it into one line of text:
   `base64 -i DeveloperID.p12 | pbcopy`.
4. **Make an app-specific password** for notarizing at
   [account.apple.com](https://account.apple.com) → Sign-In and Security →
   App-Specific Passwords.
5. **Find your Team ID** at developer.apple.com → Account → Membership
   details (10 characters).

## Then: five secrets, and a tag

In **github.com/saurav717/reader → Settings → Secrets and variables →
Actions → New repository secret**, add:

| Secret | What goes in it |
|---|---|
| `MACOS_CERTIFICATE` | the base64 text from step 3 |
| `MACOS_CERTIFICATE_PASSWORD` | the `.p12`'s password |
| `APPLE_ID` | the Apple Account's email |
| `APPLE_TEAM_ID` | the Team ID |
| `APPLE_APP_PASSWORD` | the app-specific password |

Then merge any pull request that touches the app or the Companion: each merge
into `main` builds and publishes the release by itself. (Or **Actions → macOS
app → Run workflow** with *release* ticked, or push a tag `app-v…`.)
The workflow builds the app for Apple silicon and Intel, signs it with the
hardened runtime, sends the `.dmg` to Apple's notary service, staples the
ticket to it, checks it with `spctl`, and publishes it as a GitHub Release.
The site needs no change: the card asks GitHub for the newest release with a
`Reader.dmg` and offers that from then on.

Until the secrets are there, the workflow builds an **unsigned** `Reader.dmg`
on each pull request that touches the app, as an artifact to try out, and a
release publishes it as `Reader-unsigned.dmg` (see above).

## Updating

Change the Companion (its version in `companion/pyproject.toml`) and merge:
the merge publishes `app-v<version>`. Reader.app compares its own Companion with
the one installed and sets up again when they differ.

## Windows

Windows has the same thing, *SmartScreen*, for an unsigned installer.
Signing for it needs a code-signing certificate: Microsoft's
[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
(about US$10 a month) or one from a certificate authority. That isn't built
yet.
