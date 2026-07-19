# Keypad Recognizer

A userscript that detects shuffled numeric login keypads (the anti-autofill virtual
PIN pads used by many banks) and bridges them to your password manager: it injects a
real password field, and when the manager fills it, the value is "typed" on the
virtual keypad by simulating clicks.

Best-effort by design — no guarantee it works on every site. Activation is gated by a
whitelist you control; entries match by registrable domain (eTLD+1), so enabling a
bank's main site also covers a login keypad served from a sibling subdomain inside a
cross-origin iframe.

## Status

**Phases 1–2 complete; Phase 3 mostly complete.** Validated live on five banks:
**BoursoBank**, **La Banque Postale** (cross-origin iframe keypad), **Société Générale**
(shared-sprite), **Banque Populaire** (opaque-PNG background-image), and
**Hello bank!/BNP** (strict-CSP text keypad). Verified end-to-end: the reader decodes the
keys, and the replayer types passwords the site accepts, including when the keypad
reshuffles after every keypress.

Pipeline: `whitelist gate → detector → reader → input bridge → replayer`

- **Detector** — spatial-clustering scan: groups clickable candidates by near-uniform
  geometry and picks the ≥10-key cluster covering digits 0–9 (ignores erase/submit/decoys).
- **Reader** (layered, first match wins): text content → attributes
  (`aria-label`/`alt`/`data-*`) → **glyph fingerprint** — a 24×24 ink-coverage hash
  (alpha-based, so color/theme-independent) matched against **synthetic multi-font
  templates** (~12 fonts × 2 weights, built lazily as CSP-safe SVG data URIs) plus baked
  references, with a **learned per-origin cache**. It abstains rather than guess, so it
  never returns a wrong digit.
- **Input bridge** — floating panel with `<input type="password" autocomplete="current-password">`.
- **Replayer** — re-scans the keypad immediately before every click (survives reshuffles),
  dispatches a full pointer/mouse event sequence with human-like timing.

Recognizes many image keypads with **no user input** thanks to the synthetic-font matcher,
in addition to the baked **BoursoBank `sasmap`** references. Hostile glyphs the matcher
abstains on (condensed display fonts, noisy raster) would still need OCR (Tesseract,
deferred) or a manual calibration step (deferred).

## Files

- `keypad-recognizer.user.js` — the userscript (whole pipeline).
- `stubs/boursobank-stub.html` — offline fixture reproducing the BoursoBank keypad (real
  glyphs, shuffled tokens, ground-truth verification). URL params:
  `?expected=12345678` · `?len=8` · `?reshuffle=1500` (ms) · `?reshuffle=keypress`.
- `stubs/sg-stub.html` — Société Générale shared-sprite fixture.
- `stubs/bp-stub.html` — Banque Populaire opaque-PNG background-image fixture (real glyphs).
- `stubs/hellobank-stub.html` — Hello bank! fixture: strict `style-src` CSP + multi-step
  form that reveals a pre-rendered text keypad by class toggle.
- `stubs/keypad-generator.html` — seeded generator of varied keypad shapes/colors/layouts
  for detector stress-testing.
- `test/` — Playwright regression suite (run with `npm test`).
- `docs/spec/plan.md` — full plan & spec (authoritative status tracker).

## Install (real use)

1. Install Tampermonkey or Violentmonkey.
2. Add `keypad-recognizer.user.js`.
3. Visit a login keypad page, open the userscript menu → **KR: Enable on this site**, reload.
4. The panel appears when a keypad is detected. Let your manager fill the field (or type
   it), then **Type on keypad**. Review the dots and submit yourself.

## Browser for MCP-driven testing

The `chrome-devtools-mcp` server only *attaches* to a Chrome already running on
`:9222`; it never launches one. Start it with the persistent profile:

```bash
dev/launch-chrome.sh
```

The profile lives at `~/.local/share/keypad_recog/chrome-profile` and keeps installed
extensions (Tampermonkey, uBlock Origin Lite) and their settings across sessions. Run
the script at the start of a session (or after a reboot) before using browser tooling.

Likewise, `firefox-devtools-mcp` only *attaches* to a running Firefox via Marionette
(`--connectExisting --marionettePort 2828`); it never launches one. Start it with:

```bash
dev/launch-firefox.sh
```

This launches an isolated instance (`--no-remote --new-instance`, dedicated Marionette
port) against a persistent profile at `~/.local/share/keypad_recog/firefox-profile`, so
installed extensions and their settings survive across sessions. It defaults to Firefox
Developer Edition (so unsigned/dev extensions are allowed); override the binary with
`KR_FIREFOX_BIN=/usr/bin/firefox`, the profile with `KR_FIREFOX_PROFILE`, or the port
with `KR_MARIONETTE_PORT`. Run it at the start of a session (or after a reboot), then
reconnect the `firefox-devtools` MCP so it attaches.

## Dev workflow (hot reload)

Edit the script and see changes without reinstalling:

1. Serve the repo:  `python3 -m http.server 8137`  (from the repo root).
2. Install `dev/loader.user.js` **once** in Tampermonkey/Violentmonkey.
3. Develop against `http://localhost:8137/stubs/boursobank-stub.html`.
4. Edit `keypad-recognizer.user.js` — the loader re-fetches every ~1.5s and re-runs it
   live (the main script is idempotent: it tears down the old panel/observer first). No
   page reload needed. Set `POLL_MS = 0` in the loader to instead reload on page refresh.

The loader also matches `clients.boursobank.com` (pulls via `GM_xmlhttpRequest` to dodge
mixed-content), but the bank's CSP may block `eval()` there — iterate on the stub, then
install the built script normally for final validation on the live site.

## Test against the stub

Open `stubs/boursobank-stub.html` in a browser with the userscript active (add
`file:///*` access in the manager, or enable via the menu). Or drive it programmatically:
load the script, then call `window.__KR__.typeSecret("...")` and compare
`window.__stub__.submitted` to `expected`.

## Notes / limitations

- Simulated events are `isTrusted=false`. Most keypads accept them; a few strict sites
  won't — those would need a browser-extension + debugger route.
- The password lives briefly in the page's JS/DOM. It is never logged or transmitted.
  This tool intentionally bridges an anti-automation control — appropriate for your own
  accounts only.

## Roadmap

- **Phase 1 — ✅ complete.** End-to-end against BoursoBank, live-validated through real
  Tampermonkey (glyph reader, panel under CSP, accepted synthetic clicks).
- **Phase 2 — ✅ complete.** Spatial-clustering detector, SPA re-detection polish, better
  status/error UX, menu de-spam. Live-confirmed on `clients.boursobank.com`.
- **Phase 3 — 🔄 mostly complete.** Recognize *arbitrary* image keypads with no user
  input, vision-first:
  - ✅ Keypad-zone + per-cell localization (independent of recognition) with a debug overlay.
  - ✅ Dependency-free glyph recognition: 24×24 ink-coverage hash + synthetic multi-font
    templates + learned per-origin cache; abstains rather than guessing.
  - ✅ Five banks validated live (BoursoBank, La Banque Postale, Société Générale, Banque
    Populaire, Hello bank!/BNP).
  - ⏳ Deferred last resort: OCR (Tesseract, lazy-loaded) and a manual calibration wizard
    for hostile glyphs the matcher abstains on.
- **Phase 4 — ⬜ not started.** Password-manager field tuning, multi-keypad pages,
  whitelist import/export, optional MV3 extension port (for `isTrusted`/CSP-hard sites).
