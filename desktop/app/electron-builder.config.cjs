// How electron-builder packages Reader (npm run dist, after scripts/prepare-companion.mjs):
//   macOS    Reader-<version>.dmg, one universal app; signed and notarized with the secrets the
//            desktop app workflow passes (CSC_LINK, APPLE_ID…), unsigned without them
//   Windows  Reader-Setup-<version>.exe, a setup wizard (for you or everyone, where to); uninstalled
//            from Settings -> Apps or the Start menu (build/installer.nsh)
//   Linux    Reader-<version>-<arch>.AppImage, a .deb and an .rpm
// The version is the Companion's (companion/pyproject.toml): the app is the way it is installed.
const info = require('./companion/info.json');

const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
  appId: 'io.github.saurav717.reader',
  productName: 'Reader',
  copyright: 'saurav717',
  extraMetadata: { version: info.version },
  directories: { output: 'dist', buildResources: 'build' },
  // Released by the desktop app workflow (gh release), not by electron-builder: no update feeds.
  publish: [],
  files: ['main.js', 'notes.js', 'preload-ui.js', 'preload-site.js', 'ui/**', 'build/icon.png', 'package.json'],
  // The meeting recorder's native program (notes.js) runs from outside the archive: the SDK looks for it in app.asar.unpacked.
  asarUnpack: ['node_modules/@recallai/desktop-sdk/**'],
  extraResources: [{ from: 'companion', to: 'companion' }],
  mac: {
    category: 'public.app-category.education',
    target: [{ target: 'dmg', arch: ['universal'] }],
    icon: 'build/icon.png',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize,
    // What recording a meeting needs, and what macOS says when it asks (notes.js).
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Reader records the meetings you choose, to write up their notes for your project.',
      NSAudioCaptureUsageDescription: 'Reader records the sound of the meetings you choose, to write up their notes for your project.',
      NSScreenCaptureUsageDescription: 'Reader records the meetings you choose, to write up their notes for your project.',
      NSAppleEventsUsageDescription: 'Reader finds the meeting you are in, to take its notes.',
    },
    // Files already built for both architectures, the same in both halves of the universal app: uv (lipo, in
    // prepare-companion.mjs), and the meeting recorder's native program and its GStreamer libraries, which
    // Recall.ai ships universal (notes.js).
    x64ArchFiles: 'Contents/Resources/{companion/uv,app.asar.unpacked/node_modules/@recallai/desktop-sdk/**}',
  },
  dmg: {
    title: 'Reader ${version}',
    artifactName: 'Reader-${version}.dmg',
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
    shortcutName: 'Reader',
    uninstallDisplayName: 'Reader',
    include: 'build/installer.nsh',
    artifactName: 'Reader-Setup-${version}.${ext}',
  },
  linux: {
    target: ['AppImage', 'deb', 'rpm'],
    executableName: 'reader',
    syncDesktopName: true,
    icon: 'build/icon.png',
    category: 'Education',
    maintainer: 'saurav717 <saurav717@users.noreply.github.com>',
    synopsis: 'Read research papers, keep notes and run code on this computer',
    description: 'Reader for research papers: search arXiv, OpenAlex and Semantic Scholar, collect and highlight papers, and run their code on this computer through the Reader Companion.',
    desktop: {
      entry: { Keywords: 'papers;research;arxiv;notes;jupyter;', Actions: 'Uninstall;' },
      desktopActions: { Uninstall: { Name: 'Uninstall Reader', Exec: 'reader --uninstall' } },
    },
  },
  appImage: { artifactName: 'Reader-${version}-${arch}.AppImage' },
  deb: { artifactName: 'reader_${version}_${arch}.deb', packageCategory: 'education' },
  rpm: { artifactName: 'reader-${version}.${arch}.rpm' },
};
