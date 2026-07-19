const { test, expect } = require("@playwright/test");
const { setup } = require("./helpers");

// Banque Populaire / BPCE "icgauth" keypad: a 2x5 grid of <button class="keyboard-button">
// keys, each carrying its digit as a CSS *background image* — a small OPAQUE PNG (anti-aliased
// dark digit on a near-white ground), no <img>/<svg> child and no text. This exercises two
// things the earlier image keypads did not: the opaque (luminance) ink path rather than the
// alpha path, and — critically — ink-bbox normalisation. The bank glyph fills its little PNG
// with essentially no margin, so a naive whole-frame scale misaligns it with the centred,
// wide-margin synthetic-font templates and the recogniser abstains on ~9/10 keys (the live bug:
// "only one digit detected"). Cropping to the digit's tight ink bbox before hashing fixes it.
//
// The glyphs are the real ones captured from the live keypad. These simple PNGs decode
// effectively identically across engines, so recognition runs against the userscript's
// runtime-built synthetic-font templates in whatever browser runs the test — no cache seeding.

// byDigit gives the key element; map it back to its grid index → ground-truth digit.
test.describe("Banque Populaire stub — opaque-PNG background-image keypad", () => {
  test("recognizes all 10 opaque-PNG glyphs to the correct key", async ({ page }) => {
    await setup(page, "bp-stub.html", { expected: "1234567890", len: "10" });
    const r = await page.evaluate(async () => {
      window.__krkp = await window.__KR__.findKeypad();
      const kp = window.__krkp;
      const kb = document.getElementById("keyboard");
      const truth = window.__stub__.posToDigit;
      const wrong = [];
      for (const d of "0123456789") {
        const el = kp && kp.byDigit[d];
        const idx = el ? [...kb.children].indexOf(el) : -1;
        if (idx < 0 || String(truth[idx]) !== d) wrong.push({ d, idx, truthForCell: idx >= 0 ? truth[idx] : null });
      }
      return { covered: kp ? kp.covered : 0, dominant: window.__KR__.dominantMethod(kp ? kp.keys : []), wrong };
    });
    expect(r.covered, `should read all 10 digits (wrong: ${JSON.stringify(r.wrong)})`).toBe(10);
    expect(r.wrong, `every key must map to the correct digit`).toEqual([]);
    expect(r.dominant, "keys read via the glyph reader (opaque bg image)").toBe("glyph");
  });

  test("localizes the 2x5 keypad purely from geometry", async ({ page }) => {
    await setup(page, "bp-stub.html", { expected: "1234567890", len: "10" });
    const r = await page.evaluate(() => {
      const loc = window.__KR__.localizeKeypad();
      const keys = [...document.querySelectorAll("button.keyboard-button")];
      return {
        rows: loc ? loc.rows : 0,
        cols: loc ? loc.cols : 0,
        cellCount: loc ? loc.els.length : 0,
        allKeysLocalized: !!loc && keys.every((el) => loc.els.includes(el)),
      };
    });
    expect(r.rows).toBe(2);
    expect(r.cols).toBe(5);
    expect(r.cellCount).toBe(10);
    expect(r.allKeysLocalized, "all 10 keys fall inside the localized keypad").toBe(true);
  });

  test("types the expected password", async ({ page }) => {
    await setup(page, "bp-stub.html", { expected: "1234567890", len: "10" });
    const entered = await page.evaluate(async () => {
      window.__stub__.reset();
      await window.__KR__.typeSecret("1234567890", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("1234567890");
  });

  test("survives reshuffle-per-keypress", async ({ page }) => {
    await setup(page, "bp-stub.html", { expected: "1234567890", len: "10", reshuffle: "keypress" });
    const entered = await page.evaluate(async () => {
      window.__stub__.reset();
      await window.__KR__.typeSecret("1234567890", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("1234567890");
  });
});
