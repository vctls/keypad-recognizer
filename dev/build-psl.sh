#!/usr/bin/env bash
# Regenerate the embedded Public Suffix List fragment used by isWhitelisted() for
# registrable-domain (eTLD+1) matching. Output is printed to stdout; paste it into
# the "Public Suffix List" block in keypad-recognizer.user.js.
#
# Only the ICANN section is embedded, and single-label plain rules (e.g. "com", "fr")
# are dropped: they are behavior-identical to the PSL default rule ("*"), so omitting
# them keeps the blob small without changing any registrable-domain result. Multi-label
# rules ("co.uk"), wildcards ("*.ck") and exceptions ("!www.ck") are kept — those are
# the ones that actually diverge from the default rule.
set -euo pipefail

URL="https://publicsuffix.org/list/public_suffix_list.dat"
raw="$(curl -fsSL "$URL")"

version="$(printf '%s\n' "$raw" | awk -F': ' '/^\/\/ VERSION:/{v=$2} END{print v}')"

rules="$(printf '%s\n' "$raw" \
  | awk '/===BEGIN ICANN DOMAINS===/{f=1;next} /===END ICANN DOMAINS===/{f=0} f' \
  | grep -v '^//' | grep -v '^[[:space:]]*$' \
  | grep -E '\.|^\*|^!')"

count="$(printf '%s\n' "$rules" | wc -l | tr -d ' ')"

echo "  // ---- Public Suffix List (ICANN section) — regenerate with dev/build-psl.sh ----"
echo "  // Source: $URL"
echo "  // Version: $version   Behavior-affecting rules: $count"
echo "  // Single-label rules are omitted (identical to the PSL default '*' rule)."
echo "  const PSL_RULES = new Set(("
printf '%s\n' "$rules" | tr '\n' ' ' | fold -s -w 108 \
  | sed 's/[[:space:]]*$//' | sed 's/^/    "/' | sed 's/$/ " +/'
echo '    "").split(/\s+/).filter(Boolean));'
