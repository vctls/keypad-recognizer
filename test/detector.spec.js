const { test, expect } = require("@playwright/test");
const { setup, SCRIPT } = require("./helpers");

// Regression anchors + a numeric sweep, so we cover many layout/shape/render/color combos.
const ANCHOR_SEEDS = ["1", "7", "42", "hello", "abc", "xyz", "2", "3", "5", "11"];
const SWEEP_SEEDS = Array.from({ length: 30 }, (_, i) => String(50 + i));
const TEXT_SEEDS = [...ANCHOR_SEEDS, ...SWEEP_SEEDS];

// A handful for the heavier typing checks (keeps total runtime sane).
const TYPING_SEEDS = ["1", "7", "42", "hello", "55", "63"];
const IMAGE_SEEDS = ["1", "4", "9", "42", "93", "hello", "70", "88"];

// Reads the userscript's recognition result and compares it to the generator's ground
// truth. Returns everything the assertions need in one round-trip.
async function readGeneratorResult(page) {
  return page.evaluate(async () => {
    const kp = await window.__KR__.findKeypad();
    const loc = window.__KR__.localizeKeypad();
    const keys = [...document.querySelectorAll(".key")];
    const decoys = [...document.querySelectorAll(".decoy")];
    const map = {};
    for (const d of "0123456789") map[d] = kp && kp.byDigit[d] ? keys.indexOf(kp.byDigit[d]) : -1;
    const digitCells = Object.values(window.__gen__.byDigit).map((i) => keys[i]);
    return {
      covered: kp ? kp.covered : 0,
      map,
      truth: window.__gen__.byDigit,
      // every ground-truth digit cell was localized
      allDigitCellsLocalized: !!loc && digitCells.every((el) => loc.els.includes(el)),
      // a decoy was never treated as a key
      decoyInKeypad: !!loc && decoys.some((el) => loc.els.includes(el)),
      hasDecoys: decoys.length > 0,
      style: window.__gen__.style,
    };
  });
}

test.describe("generator — text keypads (localization + exact recognition)", () => {
  for (const seed of TEXT_SEEDS) {
    test(`seed=${seed}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed, render: "text", decoys: "1" });
      const r = await readGeneratorResult(page);

      expect(r.covered, `should recognize all 10 digits (style: ${JSON.stringify(r.style)})`).toBe(10);
      expect(r.map, "recognized position→digit must match ground truth exactly").toEqual(r.truth);
      expect(r.allDigitCellsLocalized, "every ground-truth digit cell must be localized").toBe(true);
      expect(r.decoyInKeypad, "a decoy must never be treated as a key").toBe(false);
    });
  }
});

test.describe("generator — image keypads (localization + recognition safety)", () => {
  for (const seed of IMAGE_SEEDS) {
    test(`seed=${seed}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed, render: "image", decoys: "1" });
      const r = await page.evaluate(async () => {
        const kp = await window.__KR__.findKeypad();
        const loc = window.__KR__.localizeKeypad();
        const keys = [...document.querySelectorAll(".key")];
        const g = window.__gen__;
        const digitCells = Object.values(g.byDigit).map((i) => keys[i]);
        const decoys = [...document.querySelectorAll(".decoy")];
        // SAFETY: every digit the recognizer *claims* must be correct (it may abstain, but
        // must never map a digit to the wrong cell). Font-robust across engines.
        const wrong = [];
        for (const d of "0123456789") {
          const el = kp && kp.byDigit[d];
          if (el) { const idx = keys.indexOf(el); if (idx !== g.byDigit[d]) wrong.push({ d, idx, truth: g.byDigit[d] }); }
        }
        return {
          localized: !!loc,
          cellCount: loc ? loc.els.length : 0,
          allDigitCellsLocalized: !!loc && digitCells.every((el) => loc.els.includes(el)),
          decoyInKeypad: !!loc && decoys.some((el) => loc.els.includes(el)),
          recognized: kp ? kp.covered : 0,
          wrong,
          style: g.style,
        };
      });
      expect(r.localized, `must localize the keypad (style: ${JSON.stringify(r.style)})`).toBe(true);
      expect(r.allDigitCellsLocalized, "all digit cells localized without recognition").toBe(true);
      expect(r.cellCount, "should localize at least the 10 digit cells").toBeGreaterThanOrEqual(10);
      expect(r.decoyInKeypad).toBe(false);
      expect(r.wrong, `recognizer must never claim a wrong digit (got ${JSON.stringify(r.wrong)})`).toEqual([]);
    });
  }
});

// Common fonts must be recognized *fully* — this is the Phase-3 recognition capability.
// (Font-substitution differs across engines, so this list stays to broadly-available,
// shape-distinct faces; unusual display/mono fonts are allowed to abstain, covered above.)
test.describe("generator — image keypad recognition (common fonts, full 10/10)", () => {
  for (const font of ["Arial", "Times New Roman", "Georgia", "Tahoma"]) {
    test(`font=${font}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed: "1", render: "image", font });
      const r = await page.evaluate(async () => {
        const kp = await window.__KR__.findKeypad();
        const keys = [...document.querySelectorAll(".key")];
        const map = {};
        for (const d of "0123456789") map[d] = kp && kp.byDigit[d] ? keys.indexOf(kp.byDigit[d]) : -1;
        return { covered: kp ? kp.covered : 0, map, truth: window.__gen__.byDigit };
      });
      expect(r.covered).toBe(10);
      expect(r.map).toEqual(r.truth);
    });
  }
});

// The reader has three digit sources (readDigit): text, attributes, then glyph. Text is
// covered above; these cover the attribute path (aria-label/…) and the glyph path's
// background-image source (extractImageSource) — both otherwise untested.
test.describe("generator — attribute-based keypads (reader step 2)", () => {
  for (const seed of ["1", "42", "7"]) {
    test(`seed=${seed}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed, render: "attr", decoys: "1" });
      const r = await page.evaluate(async () => {
        const kp = await window.__KR__.findKeypad();
        const keys = [...document.querySelectorAll(".key")];
        const map = {};
        for (const d of "0123456789") map[d] = kp && kp.byDigit[d] ? keys.indexOf(kp.byDigit[d]) : -1;
        return { covered: kp ? kp.covered : 0, map, truth: window.__gen__.byDigit, method: window.__KR__.dominantMethod(kp ? kp.keys : []) };
      });
      expect(r.covered).toBe(10);
      expect(r.map).toEqual(r.truth);
      expect(r.method).toMatch(/^attr:/);
    });
  }
});

test.describe("generator — background-image glyphs (extractImageSource bg path)", () => {
  for (const font of ["Arial", "Georgia"]) {
    test(`font=${font}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed: "1", render: "bg", font });
      const r = await page.evaluate(async () => {
        const kp = await window.__KR__.findKeypad();
        const keys = [...document.querySelectorAll(".key")];
        const map = {};
        for (const d of "0123456789") map[d] = kp && kp.byDigit[d] ? keys.indexOf(kp.byDigit[d]) : -1;
        return { covered: kp ? kp.covered : 0, map, truth: window.__gen__.byDigit, method: window.__KR__.dominantMethod(kp ? kp.keys : []) };
      });
      expect(r.covered).toBe(10);
      expect(r.map).toEqual(r.truth);
      expect(r.method).toBe("glyph");
    });
  }
});

test.describe("glyph cache", () => {
  test("learns confident matches (per-origin, persisted)", async ({ page }) => {
    await setup(page, "keypad-generator.html", { seed: "1", render: "image", font: "Arial" });
    const cacheSize = await page.evaluate(async () => {
      await window.__KR__.findKeypad();                 // recognize -> populate cache
      const raw = JSON.parse(localStorage.getItem("kr:glyphCache:http://localhost:8137") || "[]");
      return raw.length;
    });
    expect(cacheSize).toBeGreaterThan(0);
  });
});

test.describe("generator — typing", () => {
  for (const seed of TYPING_SEEDS) {
    test(`type seed=${seed}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed, render: "text" });
      const entered = await page.evaluate(async () => {
        window.__gen__.reset();
        await window.__KR__.typeSecret(window.__gen__.expected, () => {});
        return window.__gen__.entered;
      });
      const expected = await page.evaluate(() => window.__gen__.expected);
      expect(entered).toBe(expected);
    });
  }
});

test.describe("generator — reshuffle-per-keypress (re-scan before every click)", () => {
  for (const seed of ["1", "42", "hello"]) {
    test(`seed=${seed}`, async ({ page }) => {
      await setup(page, "keypad-generator.html", { seed, render: "text", reshuffle: "keypress" });
      const entered = await page.evaluate(async () => {
        window.__gen__.reset();
        await window.__KR__.typeSecret(window.__gen__.expected, () => {});
        return window.__gen__.entered;
      });
      const expected = await page.evaluate(() => window.__gen__.expected);
      expect(entered).toBe(expected);
    });
  }
});

test.describe("BoursoBank stub — real glyphs", () => {
  test("recognizes all 10 live glyphs to the correct token", async ({ page }) => {
    await setup(page, "boursobank-stub.html", { expected: "1234567890", len: "10" });
    const r = await page.evaluate(async () => {
      const kp = await window.__KR__.findKeypad();
      const truth = window.__stub__.tokenToDigit; // token -> digit
      let correct = 0;
      const wrong = [];
      for (const d of "0123456789") {
        const el = kp.byDigit[d];
        const token = el && el.getAttribute("data-matrix-key");
        if (token && truth[token] === d) correct++;
        else wrong.push({ d, token, truthForToken: token ? truth[token] : null });
      }
      return { covered: kp.covered, correct, wrong };
    });
    expect(r.covered).toBe(10);
    expect(r.correct, `wrong: ${JSON.stringify(r.wrong)}`).toBe(10);
  });

  test("types the expected password", async ({ page }) => {
    await setup(page, "boursobank-stub.html", { expected: "1234567890", len: "10" });
    const entered = await page.evaluate(async () => {
      window.__stub__.reset();
      await window.__KR__.typeSecret("1234567890", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("1234567890");
  });

  test("survives reshuffle-per-keypress", async ({ page }) => {
    await setup(page, "boursobank-stub.html", { expected: "1234567890", len: "10", reshuffle: "keypress" });
    const entered = await page.evaluate(async () => {
      window.__stub__.reset();
      await window.__KR__.typeSecret("1234567890", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("1234567890");
  });
});

// ---------------------------------------------------------------------------
// Registrable-domain (Public Suffix List) matching. This backs the whitelist so
// that enabling a bank's main site also activates the login keypad served from a
// sibling subdomain in a cross-origin iframe (the La Banque Postale case), while
// multi-level suffixes (foo.co.uk) are handled correctly rather than by a naive
// last-two-labels guess. Pure functions on __KR__, so any loaded fixture works.
test.describe("whitelist — registrable domain (Public Suffix List)", () => {
  test("registrableDomain resolves eTLD+1 across suffix shapes", async ({ page }) => {
    await setup(page, "keypad-generator.html", { seed: "1", render: "text" });
    const got = await page.evaluate(() => {
      const f = window.__KR__.registrableDomain;
      return {
        lbpWww: f("www.labanquepostale.fr"),
        lbpKeypad: f("voscomptesenligne.labanquepostale.fr"),
        com: f("a.b.example.com"),
        coUk: f("a.b.example.co.uk"),           // multi-level ICANN suffix
        publicSuffix: f("co.uk"),               // a suffix itself -> no registrable domain
        wildcard: f("a.foo.ck"),                // *.ck rule
        wildcardSuffix: f("foo.ck"),            // *.ck -> foo.ck is itself a suffix
        exception: f("www.ck"),                 // !www.ck exception
        ip: f("127.0.0.1"),
        single: f("localhost"),
      };
    });
    expect(got.lbpWww).toBe("labanquepostale.fr");
    expect(got.lbpKeypad).toBe("labanquepostale.fr");
    expect(got.com).toBe("example.com");
    expect(got.coUk).toBe("example.co.uk");
    expect(got.publicSuffix).toBe("");
    expect(got.wildcard).toBe("a.foo.ck");
    expect(got.wildcardSuffix).toBe("");
    expect(got.exception).toBe("www.ck");
    expect(got.ip).toBe("127.0.0.1");
    expect(got.single).toBe("");
  });

  test("domainWhitelisted matches a sibling subdomain but not an unrelated host", async ({ page }) => {
    await setup(page, "keypad-generator.html", { seed: "1", render: "text" });
    const r = await page.evaluate(() => {
      const dw = window.__KR__.domainWhitelisted;
      const wl = ["https://www.labanquepostale.fr"]; // user enabled the bank's main site
      return {
        keypadFrame: dw("voscomptesenligne.labanquepostale.fr", wl), // served in a cross-origin iframe
        sameHost: dw("www.labanquepostale.fr", wl),
        otherBank: dw("www.boursobank.com", wl),
        registrarSibling: dw("evil.fr", wl),      // different registrable domain
        emptyWhitelist: dw("voscomptesenligne.labanquepostale.fr", []),
      };
    });
    expect(r.keypadFrame).toBe(true);
    expect(r.sameHost).toBe(true);
    expect(r.otherBank).toBe(false);
    expect(r.registrarSibling).toBe(false);
    expect(r.emptyWhitelist).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-frame: keypad inside an iframe (the La Banque Postale shape). Verifies the
// COMPACT in-frame panel (input + emoji button, no title/status) and that the frame
// which owns the keypad tells the top frame to retire its dead eager panel. Same-origin
// iframe here (Playwright can't serve two hosts), which still exercises isTopFrame,
// COMPACT, the postMessage ping, and the same-domain guard.
test.describe("cross-frame — keypad in an iframe", () => {
  test("iframe gets a compact panel; top-frame panel is suppressed", async ({ page }) => {
    await page.goto("/stubs/iframe-host.html?seed=1&render=text");
    await page.evaluate(() => localStorage.setItem("kr:forceEnable", "true"));
    // Wait for the iframe's generator to publish ground truth.
    await page.waitForFunction(() => {
      const f = document.getElementById("kp");
      return f && f.contentDocument && f.contentDocument.readyState === "complete" && f.contentWindow.__gen__;
    });
    const frame = page.frames().find((f) => f.url().includes("keypad-generator"));
    // Inject the real script into both frames (top first, so its message listener is ready).
    await page.evaluate(SCRIPT);
    await frame.evaluate(SCRIPT);
    await page.waitForFunction(() => !!window.__KR__);
    await frame.waitForFunction(() => !!window.__KR__);

    // The iframe panel is the compact variant and reads the keypad.
    const inFrame = await frame.evaluate(async () => {
      const kp = await window.__KR__.findKeypad();
      const p = document.getElementById("kr-panel");
      const btn = p && p.querySelector("#kr-type");
      return {
        covered: kp ? kp.covered : 0,
        hasInput: !!(p && p.querySelector("#kr-input")),
        hasClose: !!(p && p.querySelector("#kr-close")),
        hasStatus: !!(p && p.querySelector("#kr-status")),
        btnText: btn ? btn.textContent : null,
      };
    });
    expect(inFrame.covered).toBe(10);
    expect(inFrame.hasInput).toBe(true);
    expect(inFrame.hasClose, "compact panel has no close/title row").toBe(false);
    expect(inFrame.hasStatus, "compact panel has no status line").toBe(false);
    expect(inFrame.btnText, "action button shows only the emoji").toBe("🔢");

    // The top frame (no keypad of its own) retires its eager panel once the iframe announces.
    await page.waitForFunction(() => {
      const p = document.getElementById("kr-panel");
      return p && p.style.display === "none";
    }, { timeout: 4000 });

    // The top frame's own panel is the FULL variant (regression guard: not made compact).
    const topHadFull = await page.evaluate(() => {
      const p = document.getElementById("kr-panel");
      return !!(p && p.querySelector("#kr-status") !== null);
    });
    expect(topHadFull, "top frame keeps the full panel structure").toBe(true);

    // Keypad-aware placement: the compact panel was pinned via left/top (not the default
    // right/bottom corner), i.e. positionPanel ran to keep it clear of the keys.
    const placed = await frame.evaluate(() => {
      const p = document.getElementById("kr-panel");
      return { left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom };
    });
    expect(placed.left, "panel positioned by left offset").toMatch(/px$/);
    expect(placed.top).toMatch(/px$/);
    expect(placed.right).toBe("auto");
    expect(placed.bottom).toBe("auto");
  });
});
