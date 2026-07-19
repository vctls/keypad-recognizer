# Keypad Recognizer — Plan & Spec

## Goal

A best-effort **userscript** that detects shuffled numeric login keypads (the
anti-autofill virtual PIN pads used by many banks) and bridges them to a password
manager: it injects a real password field, and when the manager fills it, the value is
"typed" on the virtual keypad by simulating clicks.

- **Generic**, not per-site hardcoded, but with per-site reference data where needed.
- Activation gated by a **user-managed whitelist**, matched by **registrable domain**
  (eTLD+1 via an embedded Public Suffix List): enabling a bank's main site also activates
  a login keypad served from a sibling subdomain in a cross-origin iframe.
- No guarantee it works everywhere — degrade gracefully, surface failures.
- For the user's **own accounts** only. It deliberately bridges an anti-automation
  control; the secret briefly lives in page JS/DOM and is never logged or transmitted.

## Architecture

Pipeline: **whitelist gate → detector → reader → input bridge → replayer**

### 1. Whitelist gate
- Origins stored in GM storage (`GM_getValue`/`GM_setValue`), falls back to
  `localStorage` when GM is absent (direct injection / tests).
- A frame is enabled if its exact origin is listed **or a listed origin shares its
  registrable domain** (eTLD+1, computed from the embedded ICANN Public Suffix List;
  regenerate with `dev/build-psl.sh`). This is what reaches keypads hosted in a
  cross-origin iframe on a sibling subdomain (e.g. La Banque Postale's keypad at
  `voscomptesenligne.labanquepostale.fr` under a page on `www.labanquepostale.fr`).
- The script is **not** `@noframes` (must run in the keypad iframe); menu commands are
  registered only in the top frame or in already-active frames to avoid sub-frame spam.
- Menu commands: enable/disable this site, show panel, detect now.
- `forceEnable` flag bypasses the whitelist (used by the dev loader).

### 2. Detector (heuristic, generic — spatial clustering, Phase 2)
- Collect a broad net of clickable candidates: `.sasmap__key, button, [role=button],
  a[href], [onclick], [data-matrix-key], [data-key], [data-digit], [tabindex]`, filtered
  by a visibility + size sanity check (panel's own nodes excluded).
- **Cluster by geometry:** group candidates into sets of near-uniform size (±20%); a
  cluster of ≥10 equally-sized elements is the geometric signature of a keypad. Digits are
  read **only within** promising clusters (cheap, and scoping avoids stray page digits
  polluting the digit→element map). A bounded whole-page scan (≤60 candidates) is the
  fallback.
- The keypad is the cluster whose readable keys **cover 0–9**.
- Runs on load and on DOM mutations (debounced `MutationObserver`) for SPA pages, plus
  `visibilitychange`/`pageshow`. While the panel is up, a cheap geometry-only recheck
  decides whether the keypad is gone (→ hide panel) without re-reading glyphs on every
  reshuffle mutation.

### 3. Reader (layered, first match wins)
1. **Text** — `textContent` single digit.
2. **Attributes** — `aria-label`, `title`, `alt`, `value`, `data-*`.
3. **Glyph fingerprint** — for image/SVG/canvas digits: rasterize at the glyph's **natural
   size**, pick an ink measure, crop to the digit's **tight ink bounding box**, square + centre
   it, and box-average into a **24×24** ink-coverage hash (576-bit). "Ink" = **alpha** coverage
   for transparent glyphs (so it's **color/theme-independent** — light-on-dark keypads hash the
   same as dark-on-light), else luminance contrast vs the corner-estimated background.
   Foreground=1 polarity throughout. The **ink-bbox normalization** (shared with the sprite-region
   reader via `hashInkBox`) is what lets a glyph that *tightly fills* its own image — a bank's
   own PNG/SVG font, e.g. **Banque Populaire's opaque PNG digits** — line up with the centred,
   wide-margin synthetic templates; a naive whole-frame scale misaligns them and abstains on
   ~9/10 keys. Recognition = nearest **digit** (min Hamming over that digit's templates); accepted
   only if distance ≤ 115 (~20%) **and** it beats the 2nd-best *digit* by ≥ 18 bits — otherwise
   it **abstains** (returns null) rather than guess. It never returns a wrong digit; it just
   recognizes fewer on hostile fonts.
   Template sources:
   - **Baked** BoursoBank `sasmap` glyphs (all 10 digits, fingerprinted through the whole-glyph
     ink-bbox pipeline — regenerate them if that pipeline changes).
   - **Synthetic multi-font templates** built lazily at runtime: digits 0–9 rendered in
     ~12 common fonts × {normal, bold} as self-contained SVG data: URIs (CSP-safe, no
     deps). Recognizes font-rendered image keypads never seen before — validated on Arial,
     Times, Georgia, Tahoma, Trebuchet, Arial Black, Comic Sans, Palatino, Garamond, etc.
   - **Learned per-origin cache** (`glyphCache:<origin>`, hash→digit): confident matches are
     stored and checked first, so recognition is instant and stable across reshuffles/
     sessions. Menu command "KR: Clear glyph cache (this site)".
- Deferred last-resort fallback for hostile glyphs (heavy/condensed display fonts, noisy
  images): OCR (Tesseract, lazy-loaded) and/or a manual calibration wizard.

### 4. Input bridge (UI)
- Floating panel (light DOM, `all:initial` + inline styles) with
  `<input type="password" autocomplete="current-password">`, a "Type on keypad" button,
  and a status line. Light DOM (not shadow) so password managers detect the field.

### 5. Replayer
- **Re-scans the keypad immediately before every click** (survives reshuffles).
- Dispatches a full event sequence: `pointerover → pointerenter → pointerdown →
  mousedown → focus → pointerup → mouseup → click`, real coordinates, human-like
  randomized delays (~70–160 ms).
- No auto-submit: the user always reviews the typed dots and submits the form themselves.
  (An opt-in auto-submit was prototyped in Phase 2 but removed — unreliable across sites
  and an unnecessary security liability for a tool that handles login secrets.)

## Status — Phase 1 COMPLETE, validated on the live site

Verified on **clients.boursobank.com** and via the stub:
- Glyph reader matches all 10 live glyphs at **Hamming distance 0**.
- Panel renders under BoursoBank's CSP (inline styles allowed).
- **Synthetic clicks (`isTrusted=false`) are accepted** by BoursoBank (dots fill).
- Full production chain verified through **real Tampermonkey**: sandboxed script →
  glyph reader → simulated clicks → keypad → correct password entered.

## Key findings & decisions

- **BoursoBank is a pure image keypad.** Digits are SVGs
  (`<img class="sasmap__img">` inside `button.sasmap__key[data-matrix-key=XXX]`); a click
  submits the opaque `data-matrix-key` token, **never the digit**. DOM/text reading is
  useless here → glyph recognition is mandatory, so it was brought forward into Phase 1.
- **Digit ↔ position ↔ token all shuffle per session** (reshuffle on page load; possibly
  also on focus/visibility events). The replayer therefore re-reads before every click.
- **Userscript sandbox gotcha:** under Tampermonkey the global `window` is a proxy that
  `PointerEvent`/`MouseEvent` constructors reject as `view` ("Failed to convert value to
  'Window'"). Use `document.defaultView` and only set `view` when valid. CDP injection
  runs in the page's real main world and never hits this — so **test through Tampermonkey,
  not only via CDP**.
- **Whitelist gate** is the usual reason "the panel doesn't appear": the script loads
  (menu commands present) but `start()` returns early until the site is enabled.

## Testing infrastructure

- `stubs/boursobank-stub.html` — offline fixture with the real captured glyphs, random
  tokens, ground-truth verification (`window.__stub__`). Params: `?expected=`, `?len=`,
  `?reshuffle=<ms>|keypress`.
- `stubs/bp-stub.html` — Banque Populaire / BPCE "icgauth" fixture: a 2×5 grid of
  `button.keyboard-button` keys, each carrying its digit as a CSS **background image** — a small
  **opaque** PNG (real glyphs captured live), no `<img>`/text. Exercises the opaque (luminance)
  ink path + ink-bbox normalization. Ground truth on `window.__stub__` (`digitToGlyph`,
  `posToDigit`, `entered`, `submitted`, `reset()`, `regenerate()`). Params: `?expected=`,
  `?len=`, `?reshuffle=<ms>|keypress`.
- `stubs/keypad-generator.html` — **seeded** generator for stress-testing the
  detector/localizer against many keypad *shapes and colors*. Everything derives from
  `?seed=`: layout (2×5…1×10…4×4), key shape (circle/rounded/square/pill), size, gap,
  light/dark hue-based palette, element type (`button`/`div`/`a`), digit rendering
  (`text` = readable, or `image` = SVG glyph in a random font → tests localization
  *without* recognition), and optional off-grid **decoys** (`?decoys=1`). Ground truth on
  `window.__gen__` (`byDigit`, `style`, `expected`, `entered`, `submitted`, `reset()`,
  `regenerate(seed)`). Params: `?seed=`, `?render=text|image|auto`, `?decoys=0|1`,
  `?expected=`, `?reshuffle=`.
- **Hot reload:** `python3 -m http.server 8137` + `dev/loader.user.js` (installed once in
  Tampermonkey). The loader re-fetches the main script every ~1.5 s and re-runs it; the
  main script is idempotent (tears down the old panel/observer). The loader also
  force-enables so no whitelisting is needed in dev. Editing the loader itself requires
  reinstalling it once.
- **Automated suite (`test/`, Playwright):** headless-Chromium regression suite that lives
  *outside* the script — it injects the unmodified `keypad-recognizer.user.js` into a
  fixture's main world and drives it through the existing `window.__KR__` hooks, asserting
  against `window.__gen__` / `window.__stub__` ground truth. Run with `npm test` (reuses a
  dev server on :8137 if running, else starts `python3 -m http.server 8137`). 84 tests:
  a ~40-seed sweep of the generator (exact position→digit recognition on text keypads,
  localization-only on image keypads, decoys never mistaken for keys), typing,
  reshuffle-per-keypress, the BoursoBank stub (10/10 real glyphs + typing + reshuffle), the
  Société Générale shared-sprite stub, the Banque Populaire opaque-PNG stub (10/10 +
  localization + typing + reshuffle), and the Hello bank! stub (strict `style-src` CSP panel
  rendering + attribute-reveal auto-detection + typing + reshuffle).
  Tests the detector/recognition logic via main-world injection; the Tampermonkey-sandbox
  event path stays a separate live check. Setup: `npm install && npx playwright install chromium`.
- **MCP-driven Chrome:** `dev/launch-chrome.sh` starts Chrome on `:9222` with a persistent
  profile (`~/.local/share/keypad_recog/chrome-profile`) that has Tampermonkey + uBlock
  Origin Lite installed. The MCP server only attaches; it never launches Chrome.

## Known limitations

- Synthetic events are `isTrusted=false`. BoursoBank accepts them; a strict site might
  not — that would need a browser-extension + debugger route.
- Baked references only cover BoursoBank glyphs. Other image keypads need their own
  references, OCR, or manual calibration.
- On the real bank site, strict CSP may block the dev loader's `eval()` — iterate on the
  stub, install the built script normally for final live validation.

## Roadmap

- **Phase 2 — COMPLETE**, validated on the stub via CDP (`keypad-recognizer.user.js` v0.2.0):
  - Spatial-clustering detector — isolates the 10-key cluster (10/10 glyph coverage),
    ignoring the erase/connect/dots; correct typing survives `reshuffle=keypress`.
  - SPA polish — panel hides when the keypad is removed, re-shows when it returns.
  - Better status/error UX — "detected N/10 (method)" line; type failures report which
    digits are missing.
  - `GM_registerMenuCommand` de-spam — menu stays at 4 commands across hot-reloads (was
    climbing 4→8→12…); unregisters the prior batch where supported, else registers once.
  - **Live-confirmed** on `clients.boursobank.com/connexion/saisie-mot-de-passe` through
    real Tampermonkey (dev loader injects; the bank's CSP allows the loader's `eval()`).
- **Phase 3 — IN PROGRESS.** Goal: recognize *arbitrary* image keypads with **no user
  input**, vision-first. Step 1 (keypad-zone localization) and step 2 (per-digit cell
  localization) are **done** and validated on the stub:
  - `localizeKeypad()` picks the most keypad-like geometric cluster (a compact grid of
    ≥2 rows × ≥2 cols whose cell count ≈ rows×cols; falls back to the largest cluster) and
    returns its `els`, per-cell `cells` rects, bounding `zone`, and `rows`/`cols` —
    **independent of digit recognition**, so it localizes unknown keypads too.
  - **Debug overlay** (`#kr-overlay`, `pointer-events:none`): a cyan box + "keypad zone
    R×C" label around the zone, and a box per cell — **green + the recognized digit** when
    read, **pink `?`** when only localized. Tracks scroll/resize/reshuffle; toggle via
    "KR: Toggle detection overlay" (persisted, default on during dev).
  - **Stress-tested** with the seeded generator across many shapes/colors/layouts/element
    types and text-vs-image rendering (with decoys): localization matches ground truth,
    recognized position→digit maps are exact (10/10) on text keypads, image keypads
    localize as "?" without recognition, and decoy clusters are ignored.
  - Robustness fix from that testing: the overlay + zone are driven by the
    *recognized digit cells* when recognition succeeds, so a same-size neighbour (e.g. a
    submit button) swept into the size-cluster is neither boxed nor counted.
  - **Glyph recognition for unknown keypads — done (dependency-free):** the fingerprint is
    now a 24×24 ink-coverage hash (alpha-based → color/theme-independent), matched against
    **synthetic multi-font templates** (digits in ~12 fonts × 2 weights, built lazily from
    SVG data: URIs) plus the baked BoursoBank refs, with a **learned per-origin cache**.
    Per-digit nearest + margin gate → abstains rather than guessing (never wrong). Verified
    via Playwright: common fonts recognize 10/10, a broad safety invariant holds (no wrong
    digit across all image seeds), light-on-dark recognized (~9/10), BoursoBank still 10/10.
    80 tests green.
  - **Banque Populaire / BPCE ("icgauth") — done (v0.5.0), diagnosed live.** Its keys are
    `button.keyboard-button`s whose digit is an **opaque** PNG set as a CSS `background`
    (no `<img>`/text). The reader hit the opaque (luminance) ink path fine, but the glyph
    *tightly fills* its little PNG with no margin, so the old whole-frame scale misaligned it
    with the centred synthetic templates and abstained on 9/10 keys — the live symptom was
    "only one digit detected". Fix: **ink-bbox normalization** in `fingerprintBitsFromImage`
    (crop to the digit's tight bbox, square+centre, box-average — shared with the region reader
    via `hashInkBox`); the baked BoursoBank refs were regenerated in the new space. Live
    diagnosis on `www.icgauth.banquepopulaire.fr` confirmed 10/10 recognition; guarded by
    `stubs/bp-stub.html` + `test/bp.spec.js`.
  - **Hello bank! / BNP Paribas ("cas") — done (v0.6.0), diagnosed live.** A plain TEXT keypad
    (`button.cas__btn--key` in `.cas__grid`, digit in `textContent`) that nonetheless exposed two
    generic bugs, both fixed and guarded by `stubs/hellobank-stub.html` + `test/hellobank.spec.js`:
    - **Panel rendered unstyled** under the page's strict CSP `style-src 'nonce-…'` (no
      `'unsafe-inline'`). The browser STRIPS every `style="…"` attribute parsed from `innerHTML`, so
      the panel's form/input/button (built from an innerHTML string) fell back to UA defaults, while
      the wrap `div` (styled via `.style.cssText`) rendered fine. Fix: build every panel node's style
      via **CSSOM** (`element.style`), which `style-src` does not govern. (The debug overlay already
      used CSSOM, which is why only the panel was affected.)
    - **Keypad not auto-detected.** It's a multi-step form that PRE-RENDERS the keypad step hidden and
      REVEALS it on username submit by toggling a class — no node is inserted. The `MutationObserver`
      watched `childList` only, so the reveal fired nothing and the keypad sat undetected (it "worked"
      only when some *unrelated* DOM insertion happened to trigger a re-detect). Fix: the observer now
      also watches visibility-affecting attributes (`class`/`style`/`hidden`/`aria-hidden`/`disabled`),
      and ignores mutations inside our own panel/overlay to avoid a self-triggered detect loop.
  - _Next (deferred, last resort):_ OCR (Tesseract, lazy-loaded, CSP-feasibility-gated) and
    a manual calibration wizard for hostile glyphs the template matcher abstains on
    (condensed display fonts like Impact, thin monospace, noisy raster images).
- **Phase 4** — password-manager field-detection tuning, multi-keypad pages, whitelist
  import/export, optional MV3 extension port (for `isTrusted` / CSP-hard sites).

## Files

- `keypad-recognizer.user.js` — the userscript (whole pipeline).
- `stubs/boursobank-stub.html` — offline test fixture (real BoursoBank glyphs).
- `stubs/sg-stub.html` — Société Générale shared-sprite fixture.
- `stubs/bp-stub.html` — Banque Populaire opaque-PNG background-image fixture (real glyphs).
- `stubs/hellobank-stub.html` — Hello bank! fixture: strict `style-src` CSP + multi-step form that
  reveals a pre-rendered text keypad by class toggle.
- `stubs/keypad-generator.html` — seeded generator of varied keypads for detector testing.
- `test/` — Playwright suite (`detector.spec.js`, `sg.spec.js`, `bp.spec.js`, `hellobank.spec.js`, `helpers.js`);
  `package.json` + `playwright.config.js` at the repo root. Run with `npm test`.
- `dev/loader.user.js` — hot-reload dev loader (install once).
- `dev/launch-chrome.sh` — launches the persistent-profile Chrome for MCP testing.
- `docs/spec/plan.md` — this document.
