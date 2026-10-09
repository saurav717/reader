#!/bin/sh
# Inside Reader.app (Contents/Resources): what the app runs the first time it
# opens, and after an update. Installs the Reader Companion from the wheel
# beside this script, with the uv beside it, then runs `reader-companion setup`.
# --no-app: Reader.app is the app, so setup doesn't make another one.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE="${READER_SITE:-__SITE__}"

# An app starts with a short PATH. Take the login shell's, so the Companion (and
# the terminals it opens on the page) find Homebrew, conda and the rest.
LOGIN_PATH="$("${SHELL:-/bin/zsh}" -lc 'printf %s "$PATH"' 2>/dev/null </dev/null || true)"
[ -n "$LOGIN_PATH" ] && PATH="$LOGIN_PATH"
export PATH="$HOME/.local/bin:$PATH"
export UV="$HERE/uv"
# uv's own Python, never /usr/bin/python3: on a Mac without Xcode's tools that asks to install them.
export UV_PYTHON_PREFERENCE=only-managed

echo "Installing the Reader Companion…"
"$UV" tool install --force --python 3.12 --from "$(ls "$HERE"/reader_companion-*.whl | head -n 1)" reader-companion
BIN="$("$UV" tool dir --bin)"
exec "$BIN/reader-companion" setup --site "$SITE" --no-app
