#!/usr/bin/env bash
# Prints the one thing to paste into Settings → Paper proxy, and where the
# proxy's screen is. Runs when a terminal attaches, so it is the first thing
# in it.
set -uo pipefail
STATE=/workspaces/.reader
KEY="$(cat "$STATE/proxy-key" 2>/dev/null || echo '<key not made yet: wait for start.sh>')"
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  PROXY="https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/api/k/${KEY}"
  SCREEN="https://${CODESPACE_NAME}-6080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/vnc.html?autoconnect=true&resize=scale"
else
  PROXY="http://localhost:8080/api/k/${KEY}"
  SCREEN="http://localhost:6080/vnc.html?autoconnect=true&resize=scale"
fi
if [ -n "${SERPAPI_KEY:-}" ]; then
  SCHOLAR="through SerpApi (SERPAPI_KEY is set), which is never shown a captcha."
else
  SCHOLAR="asked directly, from a datacentre, which Scholar mostly answers with a
  captcha — the app offers to show it to you in the pop-up. To go through
  SerpApi instead, as the Worker does: github.com → Settings → Codespaces →
  Secrets → SERPAPI_KEY for this repository, then stop and start the Codespace."
fi
cat <<MSG

  reader proxy
  ------------
  Paste this into Settings → Paper proxy and press "Test it":

    $PROXY

  Port 8080 has to be Public (Ports panel → right-click 8080 → Port Visibility)
  for the site on GitHub Pages to reach it. Keep 6080 private: that is the
  proxy's screen, and the app opens it for you as a pop-up when a sign-in or
  a captcha needs you —

    $SCREEN

  Google Scholar: $SCHOLAR

  Log: $STATE/proxy.log

MSG
