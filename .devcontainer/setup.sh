#!/usr/bin/env bash
# Runs once, when the Codespace is created: the dependencies, the Chromium the
# sign-in window is opened in, and the built site the proxy serves.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p /workspaces/.reader
npm ci
# Playwright's Chromium, plus the libraries it needs on this image. It lands
# in /workspaces so a rebuild of the container does not lose it.
npx playwright install --with-deps chromium
npm run build
