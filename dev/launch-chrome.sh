#!/usr/bin/env bash
# Launch the Chrome instance that chrome-devtools-mcp attaches to (port 9222),
# using a PERSISTENT profile so installed extensions (Tampermonkey, uBlock Origin
# Lite) and their settings survive across sessions.
#
# The MCP server is configured with `--browserUrl http://127.0.0.1:9222`, i.e. it
# only *attaches* to an already-running Chrome — it never launches one. Run this
# script at the start of a session (or after a reboot) before using the browser
# tools.
set -euo pipefail

PROFILE="${KR_CHROME_PROFILE:-$HOME/.local/share/keypad_recog/chrome-profile}"
PORT="${KR_CHROME_PORT:-9222}"
CHROME="${KR_CHROME_BIN:-google-chrome}"

if curl -s -o /dev/null "http://127.0.0.1:${PORT}/json/version"; then
  echo "Chrome already listening on :${PORT} — nothing to do."
  exit 0
fi

# Clear stale single-instance locks (harmless if absent).
rm -f "$PROFILE"/Singleton* 2>/dev/null || true

echo "Launching Chrome with profile: $PROFILE (debug port :$PORT)"
nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  about:blank >/tmp/keypad_recog-chrome.log 2>&1 &

# Wait for the debug endpoint to come up.
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/json/version"; then
    echo "Ready on :${PORT}."
    exit 0
  fi
  sleep 0.3
done
echo "Timed out waiting for Chrome on :${PORT} (see /tmp/keypad_recog-chrome.log)" >&2
exit 1
