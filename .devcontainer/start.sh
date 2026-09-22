#!/usr/bin/env bash
# Runs every time the Codespace starts: the proxy, in the background, under a
# key of its own so a public port is not an open door. See address.sh for
# where the key ends up.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=/workspaces/.reader
mkdir -p "$STATE"

# One key per Codespace, made the first time and kept; the address pasted
# into Settings → Paper proxy carries it.
if [ ! -s "$STATE/proxy-key" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))' > "$STATE/proxy-key"
fi
READER_PROXY_KEY="$(cat "$STATE/proxy-key")"
export READER_PROXY_KEY

# The site on GitHub Pages calls this proxy from another origin, which means
# the port has to be public. The GitHub CLI can set that from inside; if it
# cannot (the token it has is not always allowed to), the Ports panel can.
if [ -n "${CODESPACE_NAME:-}" ] && command -v gh >/dev/null 2>&1; then
  gh codespace ports visibility 8080:public -c "$CODESPACE_NAME" >/dev/null 2>&1 || true
fi

# Already running from an earlier start (a reconnect runs this again).
if [ -s "$STATE/proxy.pid" ] && kill -0 "$(cat "$STATE/proxy.pid")" 2>/dev/null; then
  exit 0
fi

# setsid + nohup: the process outlives this script, which the Codespace
# otherwise cleans up after.
setsid nohup npm start > "$STATE/proxy.log" 2>&1 < /dev/null &
echo $! > "$STATE/proxy.pid"

bash .devcontainer/address.sh
