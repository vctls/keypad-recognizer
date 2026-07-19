# Site compatibility TODO

Banks that use the **shuffled/virtual PIN keypad** login pattern this script targets. The
high-value targets are French banks that render digits as **images or scrambled buttons**
(the DOM-scraping-resistant variant); many non-French "virtual keyboards" render digits as
plain text/CSS and don't need this tool at all.

For each site, check: (1) does the detector localize the keypad? (2) does the reader decode
0–9 (text vs glyph)? (3) do synthetic clicks register? (4) is the keypad in a cross-origin
iframe (needs the frames + registrable-domain path from v0.3.0)?

Legend: `[x]` confirmed working · `[~]` partial / needs work · `[ ]` not checked yet · `[-]` not applicable (no keypad — plain fields)

## Confirmed
- [x] **BoursoBank** (`clients.boursobank.com`) — image glyphs (`sasmap`); glyph reader + synthetic clicks work live. Keypad in top frame.
- [x] **La Banque Postale** (`www.labanquepostale.fr` → keypad iframe on `voscomptesenligne.labanquepostale.fr`) — plain-text keypad (`button.tb-btn-k`); cross-origin iframe, needs v0.3.0 frames + registrable-domain whitelist. Detector reads 0–9.
- [x] **Société Générale** (`particuliers.sg.fr`) — **shared-sprite keypad** (v0.4.0): the whole 4×4 grid is ONE server-rendered PNG (`img#img_clavier`, 10 digits + 6 blanks) with transparent `span.btn-clavier` hover overlays as the click targets; digits live only in the sprite, never in the DOM. Read by cropping each key's region out of the sprite (`spriteRegionOf` + `fingerprintBitsFromRegion`) against baked `sg` glyphs. Glyphs render deterministically (identical across sessions), so matches are exact. **Note:** SG debounces rapid taps — clicks spaced <~250 ms are silently dropped (30 ms→2/6, 90 ms→3/6, 250 ms→6/6), hence the ~260–420 ms inter-key delay in `typeSecret`. Two-step login: user ID first, keypad appears for the secret code. Confirmed live: 10/10 recognition + 6/6 typing (`#codeSecret` reaches "6 chiffres renseignés sur 6").
- [x] **Crédit Agricole** (`www.credit-agricole.fr`, per-region caisses) — keypad detection + typing work (user-tested live). ⚠️ KeePassXC does **not** autofill the **username** field on this site (the PIN/password bridge via the panel works). Markup specifics (glyph vs text, iframe) not yet documented.
- [x] **LCL** (`particuliers.secure.lcl.fr`) — keypad detection + typing work (user-tested live). ⚠️ Same as CA: KeePassXC does **not** autofill the **username** field; the keypad bridge works. Markup specifics not yet documented.
- [x] **Banque Populaire** (`www.icgauth.banquepopulaire.fr` — BPCE "icgauth" platform) — **opaque-PNG background-image keypad** (v0.5.0): a 2×5 grid of `button.keyboard-button`, each digit a small opaque anti-aliased PNG set as a CSS `background` (no `<img>`/text). Fixed by ink-bbox-normalizing the whole-glyph fingerprint (the glyph fills its PNG with no margin, so a naive full-frame scale misaligned it with the font templates → abstained on 9/10; the symptom was "only one digit detected"). Diagnosed live: 10/10 recognition.
- [x] **Caisse d'Épargne** (BPCE "icgauth" platform) — same opaque-PNG keypad as Banque Populaire; works out of the box with v0.5.0 (user-confirmed live).
- [x] **Hello bank!** (`connexion.hellobank.fr` — BNP Paribas "cas" platform) — plain-**text** keypad (`button.cas__btn--key` in `.cas__grid`, digit in `textContent`). Trivial to read, but exposed two GENERIC bugs fixed in v0.6.0: (1) the panel rendered unstyled under the page's strict CSP `style-src 'nonce-…'` (no `'unsafe-inline'`), which strips inline `style=` attributes — fixed by styling panel nodes via CSSOM (`element.style`); (2) it's a multi-step form that reveals a pre-rendered keypad step by CLASS TOGGLE (no node inserted), which a `childList`-only observer never caught — fixed by also observing `class`/`style`/`hidden`/`aria-hidden`/`disabled`. Confirmed live (user-tested). Note: dev hot-reload loader can't run here (CSP blocks its `eval()`) — live = installed script.

## Not applicable (no keypad — plain fields, tool not needed)
- [-] **Monabanq** (`www.monabanq.com`) — regular username + password field, no virtual keypad (user-checked live).
- [-] **CIC** (`www.cic.fr`) — login page uses a regular username + password field, no virtual keypad (user-checked live).
- [-] **Crédit Mutuel** (`www.creditmutuel.fr`) — regular username + password field, no virtual keypad (user-checked live); shares the CIC platform.
- [-] **Fortuneo** (`www.fortuneo.fr`) — regular username + password field, no virtual keypad (user-checked live).

## To check — French banks (image-glyph / scrambled keypad, highest relevance)
- _(none outstanding — see Confirmed / Not applicable above)_

## To check — beyond France (often text/CSS keypads; may not need this tool)
- [ ] Spanish banks with randomized virtual keypads (verify image vs text)
- [ ] Italian banks with randomized virtual keypads (verify image vs text)
- [ ] UK / LatAm banks with randomized virtual keypads (verify image vs text)

## Notes
- **KeePassXC username autofill** is separate from the keypad bridge. On some sites (Crédit
  Agricole, LCL) KeePassXC fills neither the site's own username field nor offers it — the
  user must type the identifier manually; the PIN/password keypad bridge still works. This is
  a KeePassXC ↔ site field-detection issue, not a keypad-recognition failure. Possible future
  improvement: have the panel also expose/bridge a username input (as it already does for the
  password) so the manager has a field it reliably detects.
- Many banks have migrated to app-based auth; some login pages listed here may no longer
  present a keypad. Verify the *current* markup before investing in per-site tuning.
- Each image-glyph bank likely needs its own glyph reference set (different digit fonts);
  the spatial-clustering localizer should port, but glyph templates won't be one-size-fits-all.
