#!/usr/bin/env bash
# Launch the Firefox instance that firefox-devtools-mcp attaches to (Marionette
# port 2828), using a PERSISTENT profile so installed extensions (Tampermonkey,
# uBlock Origin, etc.) and their settings survive across sessions.
#
# This mirrors dev/launch-chrome.sh. The MCP server is configured with
# `--connectExisting --marionettePort 2828`, i.e. it only *attaches* to an
# already-running Firefox via Marionette — it does not launch one. Run this
# script at the start of a session (or after a reboot) before using the browser
# tools, then reconnect the firefox-devtools MCP so it attaches.
#
# The instance is deliberately isolated from any daily-driver Firefox:
#   * a dedicated profile dir (KR_FIREFOX_PROFILE),
#   * --no-remote --new-instance so it never merges with a running Firefox,
#   * its own Marionette port.
set -euo pipefail

PROFILE="${KR_FIREFOX_PROFILE:-$HOME/.local/share/keypad_recog/firefox-profile}"
PORT="${KR_MARIONETTE_PORT:-2828}"
# Default to Developer Edition (allows disabling extension-signature enforcement);
# override with e.g. KR_FIREFOX_BIN=/usr/bin/firefox for release Firefox.
FIREFOX="${KR_FIREFOX_BIN:-/usr/bin/firefox-devedition}"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; }

if port_open; then
  echo "Marionette already listening on :${PORT} — nothing to do."
  exit 0
fi

mkdir -p "$PROFILE"

# Clear stale profile locks from a previous, non-clean shutdown (harmless if absent).
rm -f "$PROFILE"/lock "$PROFILE"/.parentlock 2>/dev/null || true

# Persisted prefs for the automation profile: enable Marionette on our port,
# allow unsigned/dev extensions (Developer Edition only; ignored on release),
# and suppress first-run noise.
cat > "$PROFILE/user.js" <<EOF
user_pref("marionette.enabled", true);
user_pref("marionette.port", ${PORT});
user_pref("xpinstall.signatures.required", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
EOF

echo "Launching Firefox with profile: $PROFILE (Marionette :$PORT)"
nohup "$FIREFOX" \
  --profile "$PROFILE" \
  --marionette \
  --no-remote \
  --new-instance \
  about:blank >/tmp/keypad_recog-firefox.log 2>&1 &

# Wait for the Marionette socket to come up.
for _ in $(seq 1 60); do
  if port_open; then
    echo "Ready on :${PORT}."
    exit 0
  fi
  sleep 0.3
done
echo "Timed out waiting for Firefox Marionette on :${PORT} (see /tmp/keypad_recog-firefox.log)" >&2
exit 1
