const { test, expect } = require("@playwright/test");
const { setup } = require("./helpers");

// Hello bank! / BNP "cas" login screen. Two live regressions, each guarded here:
//   1. A strict `style-src` CSP (no 'unsafe-inline') strips inline `style="…"` attributes, so the
//      panel — previously built from an innerHTML string with inline styles — rendered unstyled.
//      The fix builds each node's style via CSSOM, which `style-src` does not govern.
//   2. A multi-step form reveals a PRE-RENDERED keypad step by toggling a class (no node inserted),
//      which a childList-only MutationObserver never saw. The fix also observes attribute changes.
test.describe("Hello bank! stub — strict style-src CSP + attribute-reveal multi-step keypad", () => {
  test("panel renders styled under a strict style-src CSP (CSSOM, not stripped inline styles)", async ({ page }) => {
    await setup(page, "hellobank-stub.html", { expected: "4602873159", len: "10" });
    const r = await page.evaluate(() => {
      // Prove the CSP actually strips inline style attributes in this context, so the assertions
      // below are meaningful (not just "styles happened to apply").
      const probe = document.createElement("div");
      probe.innerHTML = '<i id="krcsptest" style="padding:20px">x</i>';
      document.body.appendChild(probe);
      const strippedPad = getComputedStyle(probe.querySelector("#krcsptest")).padding;
      probe.remove();

      const form = document.querySelector("#kr-panel form");
      const btn = document.getElementById("kr-type");
      return {
        strippedPad,
        formBg: getComputedStyle(form).backgroundColor,
        btnBg: getComputedStyle(btn).backgroundColor,
        formPadTop: getComputedStyle(form).paddingTop,
      };
    });
    expect(r.strippedPad, "CSP must strip inline style attributes for this test to be meaningful").toBe("0px");
    expect(r.formBg, "panel card keeps its dark background via CSSOM").toBe("rgb(16, 24, 40)");
    expect(r.btnBg, "type button keeps its blue background via CSSOM").toBe("rgb(47, 107, 255)");
    expect(r.formPadTop, "panel card keeps its padding via CSSOM").toBe("12px");
  });

  test("auto-detects the keypad when the step is revealed by a class toggle (no node insertion)", async ({ page }) => {
    await setup(page, "hellobank-stub.html", { expected: "4602873159", len: "10" });

    // Before reveal: keypad step is display:none → nothing to type on.
    const before = await page.evaluate(() => document.getElementById("kr-type").disabled);
    expect(before, "type button starts disabled (keypad hidden)").toBe(true);

    // Reveal exactly like the live page: toggle a class, insert no nodes.
    await page.evaluate(() => window.__stub__.reveal());

    // The observer must catch the attribute change and re-detect on its own — we do NOT call detect.
    await page.waitForFunction(() => {
      const b = document.getElementById("kr-type");
      return b && !b.disabled;
    }, undefined, { timeout: 5000 });

    const r = await page.evaluate(async () => {
      const kp = await window.__KR__.findKeypad();
      const grid = document.getElementById("grid-keyboard");
      const truth = window.__stub__.posToDigit;
      const wrong = [];
      for (const d of "0123456789") {
        const el = kp && kp.byDigit[d];
        const idx = el ? [...grid.children].indexOf(el) : -1;
        if (idx < 0 || String(truth[idx]) !== d) wrong.push({ d, idx });
      }
      return { covered: kp ? kp.covered : 0, dominant: window.__KR__.dominantMethod(kp ? kp.keys : []), wrong };
    });
    expect(r.covered, `all 10 digits read (wrong: ${JSON.stringify(r.wrong)})`).toBe(10);
    expect(r.wrong).toEqual([]);
    expect(r.dominant, "text keypad read via textContent").toBe("text");
  });

  test("types the expected code after reveal", async ({ page }) => {
    await setup(page, "hellobank-stub.html", { expected: "4602873159", len: "10" });
    const entered = await page.evaluate(async () => {
      window.__stub__.reveal();
      window.__stub__.reset();
      await window.__KR__.typeSecret("4602873159", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("4602873159");
  });

  test("survives reshuffle-per-keypress", async ({ page }) => {
    await setup(page, "hellobank-stub.html", { expected: "4602873159", len: "10", reshuffle: "keypress" });
    const entered = await page.evaluate(async () => {
      window.__stub__.reveal();
      window.__stub__.reset();
      await window.__KR__.typeSecret("4602873159", () => {});
      return window.__stub__.entered;
    });
    expect(entered).toBe("4602873159");
  });
});
