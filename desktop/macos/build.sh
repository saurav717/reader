#!/bin/sh
# Builds Reader.app and Reader.dmg on a Mac (the macOS app workflow runs it on
# GitHub's macOS runners):
#   desktop/macos/build.sh [outDir]            # default: dist-macos
# Signed and notarized when these are set, unsigned otherwise:
#   MACOS_SIGN_IDENTITY   "Developer ID Application: Your Name (TEAMID)", in a keychain this can use
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   for notarytool (an app-specific password)
# READER_SITE is the site the app opens and pairs with (https://saurav717.github.io/reader/).
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/dist-macos}"
SITE="${READER_SITE:-https://saurav717.github.io/reader/}"
UV_VERSION=0.7.2
UV_SHA_ARM=8edc0bea8a9e35409f970b352036326393e79a6039577d8cc9ef63872c178a99
UV_SHA_INTEL=7d30b59d54900c97c492f3c07ff21cc3387a9e5bd8ca6db2d502462eaaeefd68

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/companion/pyproject.toml")"
WORK="$OUT/work"
APP="$OUT/Reader.app"
rm -rf "$OUT"
mkdir -p "$WORK" "$APP/Contents/MacOS" "$APP/Contents/Resources"
echo "Reader.app with Companion $VERSION, for $SITE"

# The launcher, for Apple silicon and Intel.
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos11" -o "$WORK/Reader-$arch" "$ROOT/desktop/macos/Reader.swift"
done
lipo -create -output "$APP/Contents/MacOS/Reader" "$WORK/Reader-arm64" "$WORK/Reader-x86_64"

# uv, both architectures in one binary, checked against the hashes above.
for pair in "aarch64:$UV_SHA_ARM" "x86_64:$UV_SHA_INTEL"; do
  arch="${pair%%:*}"; sha="${pair#*:}"
  curl -LsSf -o "$WORK/uv-$arch.tar.gz" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$arch-apple-darwin.tar.gz"
  echo "$sha  $WORK/uv-$arch.tar.gz" | shasum -a 256 -c -
  tar -xzf "$WORK/uv-$arch.tar.gz" -C "$WORK"
done
lipo -create -output "$APP/Contents/Resources/uv" "$WORK/uv-aarch64-apple-darwin/uv" "$WORK/uv-x86_64-apple-darwin/uv"

# The Companion's wheel and the script that installs it.
node "$ROOT/scripts/build-companion.mjs" "$WORK/site" "$SITE" >/dev/null
cp "$WORK/site/companion/reader_companion-$VERSION-py3-none-any.whl" "$APP/Contents/Resources/"
sed "s|__SITE__|$SITE|" "$ROOT/desktop/macos/install.sh" > "$APP/Contents/Resources/install.sh"

# The icon, from the site's.
ICONSET="$WORK/Reader.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/public/icons/reader-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  [ "$double" -le 512 ] && sips -z "$double" "$double" "$ROOT/public/icons/reader-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$ROOT/public/icons/reader-512.png" "$ICONSET/icon_256x256@2x.png"
iconutil -c icns -o "$APP/Contents/Resources/Reader.icns" "$ICONSET"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Reader</string>
  <key>CFBundleDisplayName</key><string>Reader</string>
  <key>CFBundleIdentifier</key><string>io.github.saurav717.reader</string>
  <key>CFBundleExecutable</key><string>Reader</string>
  <key>CFBundleIconFile</key><string>Reader</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>ReaderCompanionVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Signed inside out, with the hardened runtime and a secure timestamp, as notarizing requires.
if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  echo "Signing as $MACOS_SIGN_IDENTITY"
  codesign --force --timestamp --options runtime --sign "$MACOS_SIGN_IDENTITY" "$APP/Contents/Resources/uv"
  codesign --force --timestamp --options runtime --sign "$MACOS_SIGN_IDENTITY" "$APP"
  codesign --verify --strict --deep --verbose=2 "$APP"
else
  echo "No MACOS_SIGN_IDENTITY: the app is ad-hoc signed, and macOS will warn about it."
  codesign --force --sign - "$APP/Contents/Resources/uv"
  codesign --force --sign - "$APP"
fi

# The disk image: the app, and Applications to drag it to.
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
# hdiutil's own guess at the size is often too small ("No space left on device"),
# and it now and then finds the disk busy: give it the size, and three tries.
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 40 ))
for try in 1 2 3; do
  if hdiutil create -volname Reader -srcfolder "$STAGE" -fs HFS+ -size "${SIZE_MB}m" -ov -format UDZO "$OUT/Reader.dmg"; then
    break
  fi
  [ "$try" = 3 ] && exit 1
  echo "hdiutil failed; trying again"
  sleep 5
done

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" "$OUT/Reader.dmg"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    echo "Notarizing (Apple checks it; a few minutes)…"
    xcrun notarytool submit "$OUT/Reader.dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$OUT/Reader.dmg"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$OUT/Reader.dmg"
    echo "notarized" > "$OUT/status"
  else
    echo "signed" > "$OUT/status"
  fi
else
  echo "unsigned" > "$OUT/status"
fi
rm -rf "$WORK"
echo "Built $OUT/Reader.dmg ($(cat "$OUT/status"))"
