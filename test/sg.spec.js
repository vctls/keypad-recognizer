const { test, expect } = require("@playwright/test");
const { setup } = require("./helpers");

// Société Générale's "clavier virtuel" packs the whole keypad into ONE server-rendered image
// (img#img_clavier) with transparent <span class="btn-clavier"> hover overlays as the click
// targets — the digit graphics live only in the shared sprite, never in the DOM. The reader
// crops each key's region out of that sprite (spriteRegionOf + fingerprintBitsFromRegion) and
// matches the crop against reference glyphs.
//
// What this suite guards, engine-neutrally: the shared-sprite reader end to end — locating the
// containing image, cropping each key's tight ink bbox (with the cell border excluded),
// producing STABLE + DISCRIMINATIVE fingerprints, the geometric clustering that treats the 16
// overlays as one keypad, and the click replay. To stay independent of cross-browser PNG
// rasterisation (a real-PNG fixture only matches baked refs in the browser they were captured
// in), the sg-stub draws its sprite at runtime and the test seeds the per-origin glyph cache
// with region fingerprints taken in THIS browser, then drives the real reader against them. The
// shipped "sg" reference glyphs are validated live on the bank itself.

// Seed the learned glyph cache with a region fingerprint per digit cell, labelled from the
// stub's ground truth — using the userscript's own region reader, in this browser.
async function seedCacheFromSprite(page) {
  await page.evaluate(() => {
    const K = window.__KR__;
    K.clearGlyphCache();
    for (const s of document.querySelectorAll("span.btn-clavier")) {
      const id = s.id.replace("hover_touche_", "");
      const digit = window.__stub__.posToDigit[id];
      if (!digit) continue; // blank cell
      const reg = K.spriteRegionOf(s);
      const bits = reg && K.fingerprintBitsFromRegion(reg.img, reg.sx, reg.sy, reg.sw, reg.sh);
      if (bits) K.cacheAdd(bits, digit);
    }
  });
}

test.describe("Société Générale stub — shared-sprite keypad", () => {
  test("crops all 10 keys out of the shared sprite and maps each to its cell", async ({ page }) => {
    await setup(page, "sg-stub.html", { expected: "135790" });
    await seedCacheFromSprite(page);
    const r = await page.evaluate(async () => {
      const kp = await window.__KR__.findKeypad();
      const truth = window.__stub__.posToDigit; // span-id -> digit
      const wrong = [];
      for (const d of "0123456789") {
        const el = kp && kp.byDigit[d];
        const id = el && el.id.replace("hover_touche_", "");
        if (!id || truth[id] !== d) wrong.push({ d, id, truthForCell: id ? truth[id] : null });
      }
      return { covered: kp ? kp.covered : 0, dominant: window.__KR__.dominantMethod(kp ? kp.keys : []), wrong };
    });
    expect(r.covered, `should read all 10 digits (wrong: ${JSON.stringify(r.wrong)})`).toBe(10);
    expect(r.wrong, `every key must map to the correct cell`).toEqual([]);
    expect(r.dominant, "keys read via the glyph reader (sprite crop)").toBe("glyph");
  });

  test("localizes the keypad purely from geometry (no recognition)", async ({ page }) => {
    await setup(page, "sg-stub.html", { expected: "135790" });
    const r = await page.evaluate(() => {
      const loc = window.__KR__.localizeKeypad();
      const digitCells = Object.keys(window.__stub__.posToDigit)
        .map((id) => document.getElementById("hover_touche_" + id));
      return {
        rows: loc ? loc.rows : 0,
        cols: loc ? loc.cols : 0,
        cellCount: loc ? loc.els.length : 0,
        allDigitCellsLocalized: !!loc && digitCells.every((el) => loc.els.includes(el)),
      };
    });
    expect(r.rows).toBe(4);
    expect(r.cols).toBe(4);
    expect(r.cellCount).toBe(16);
    expect(r.allDigitCellsLocalized, "all 10 digit cells fall inside the localized keypad").toBe(true);
  });

  test("types the expected code by clicking the overlay keys", async ({ page }) => {
    await setup(page, "sg-stub.html", { expected: "135790" });
    await seedCacheFromSprite(page);
    const entered = await page.evaluate(async () => {
      window.__stub__.reset();
      await window.__KR__.typeSecret("135790", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("135790");
  });

  // Regression: live SG DROPS taps spaced closer than ~250 ms (a debounced handler) yet still
  // churns the DOM on every tap, and pipes accepted digits into #codeSecret while a numeric
  // identifiant sits pre-filled in another field. Earlier adaptive pacing read only "did the DOM
  // change?" (true even for dropped taps) and a max() entry-length (pinned by the numeric
  // username) — so it never backed off and typed only ~3/6. The replayer must detect the drops
  // via the GROWING field and self-tune its gap to land all six.
  test("backs off on a debounced keypad and types all 6 digits", async ({ page }) => {
    await setup(page, "sg-stub.html", { expected: "135790", debounce: "250", user: "12345678" });
    await seedCacheFromSprite(page);
    const r = await page.evaluate(async () => {
      window.__stub__.reset();
      await window.__KR__.typeSecret("135790", () => {});
      return { entered: window.__stub__.entered, field: document.getElementById("codeSecret").value.length };
    });
    expect(r.entered).toBe("135790");
    expect(r.field).toBe(6);
  });
});
