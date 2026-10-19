// How electron-builder packages Koios (npm run dist, after scripts/prepare-companion.mjs):
//   macOS    Koios-<version>.dmg, one universal app; signed and notarized with the secrets the
//            desktop app workflow passes (CSC_LINK, APPLE_ID…), unsigned without them
//   Windows  Koios-Setup-<version>.exe, a setup wizard (for you or everyone, where to); uninstalled
//            from Settings -> Apps or the Start menu (build/installer.nsh)
//   Linux    Koios-<version>-<arch>.AppImage, a .deb and an .rpm
// …-unsigned in the .dmg's and the .exe's names when READER_UNSIGNED is set (the workflow sets it with no
// certificate), and beside them the files the app updates itself from (updates.js): latest-mac.yml with
// Koios-<version>-mac.zip, latest.yml with the .exe's .blockmap, latest-linux.yml.
//
// The app was called Reader until 0.16. What an installed copy is known by stays as it was, so Koios installs
// over Reader rather than beside it: the app id (macOS, and Windows' uninstall entry), the reader-app:// links
// Google's sign-in comes back by, and the folder the app keeps its things in (main.js). The Linux packages are
// named koios and replace the reader package.
// The version is READER_APP_VERSION (the desktop app workflow: the Companion's major.minor, and the run's
// number, so every release is newer than the last), else the Companion's (companion/pyproject.toml).
const info = require('./companion/info.json');

const version = process.env.READER_APP_VERSION || info.version;
const unsigned = process.env.READER_UNSIGNED ? '-unsigned' : '';
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
  appId: 'io.github.saurav717.reader',
  productName: 'Koios',
  copyright: 'saurav717',
  extraMetadata: { version },
  directories: { output: 'dist', buildResources: 'build' },
  // Released by the desktop app workflow (gh release), not by electron-builder (--publish never). Where the app
  // looks for a newer version: the newest release's files (updates.js).
  publish: [{ provider: 'generic', url: 'https://github.com/saurav717/reader/releases/latest/download' }],
  // reader-app:// links open the app: how Google's sign-in in the browser comes back to it (main.js).
  protocols: [{ name: 'Koios', schemes: ['reader-app'] }],
  files: ['main.js', 'notes.js', 'updates.js', 'google.js', 'preload-ui.js', 'preload-site.js', 'ui/**', 'build/icon.png', 'package.json'],
  // The meeting recorder's native program (notes.js) runs from outside the archive: the SDK looks for it in app.asar.unpacked.
  asarUnpack: ['node_modules/@recallai/desktop-sdk/**'],
  extraResources: [{ from: 'companion', to: 'companion' }],
  mac: {
    category: 'public.app-category.education',
    // The .zip is what the app updates itself from (updates.js); people download the .dmg.
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    icon: 'build/icon.png',
    // The .zip's name (the .dmg names itself below).
    artifactName: 'Koios-${version}-mac.${ext}',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize,
    // What recording a meeting needs, and what macOS says when it asks (notes.js).
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Koios records the meetings you choose, to write up their notes for your project.',
      NSAudioCaptureUsageDescription: 'Koios records the sound of the meetings you choose, to write up their notes for your project.',
      NSScreenCaptureUsageDescription: 'Koios records the meetings you choose, to write up their notes for your project.',
      NSAppleEventsUsageDescription: 'Koios finds the meeting you are in, to take its notes.',
    },
    // Files already built for both architectures, the same in both halves of the universal app: uv (lipo, in
    // prepare-companion.mjs), and the meeting recorder's native program and its GStreamer libraries, which
    // Recall.ai ships universal (notes.js).
    x64ArchFiles: 'Contents/Resources/{companion/uv,app.asar.unpacked/node_modules/@recallai/desktop-sdk/**}',
    // The two halves' app.asar are the same (the app's own JavaScript), so neither is merged into the other file by
    // file: merging (electron-builder's default) fails on the symlinks in the recorder's GStreamer framework, unpacked
    // beside it. @electron/universal then checks the two are identical and keeps one.
    mergeASARs: false,
  },
  dmg: {
    title: 'Koios ${version}',
    artifactName: `Koios-\${version}${unsigned}.dmg`,
    background: 'build/dmg-background.png',
    iconSize: 112,
    window: { width: 600, height: 400 },
    contents: [
      { x: 160, y: 196 },
      { x: 440, y: 196, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Koios',
    uninstallDisplayName: 'Koios',
    include: 'build/installer.nsh',
    artifactName: `Koios-Setup-\${version}${unsigned}.\${ext}`,
  },
  linux: {
    target: ['AppImage', 'deb', 'rpm'],
    executableName: 'koios',
    syncDesktopName: true,
    icon: 'build/icon.png',
    category: 'Education',
    maintainer: 'saurav717 <saurav717@users.noreply.github.com>',
    synopsis: 'Read research papers, keep notes and run code on this computer',
    description: 'Koios, for research papers: search arXiv, OpenAlex and Semantic Scholar, collect and highlight papers, and run their code on this computer through the Koios Companion.',
    desktop: {
      entry: { Keywords: 'papers;research;arxiv;notes;jupyter;', Actions: 'Uninstall;' },
      desktopActions: { Uninstall: { Name: 'Uninstall Koios', Exec: 'koios --uninstall' } },
    },
  },
  appImage: { artifactName: 'Koios-${version}-${arch}.AppImage' },
  // Installed over the reader package of 0.15 and before, which it takes the place of.
  deb: { artifactName: 'koios_${version}_${arch}.deb', packageCategory: 'education', fpm: ['--replaces', 'reader', '--conflicts', 'reader'] },
  rpm: { artifactName: 'koios-${version}.${arch}.rpm', fpm: ['--replaces', 'reader', '--conflicts', 'reader'] },
};
