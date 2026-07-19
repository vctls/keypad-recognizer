// Shared test setup. The key idea: we load a fixture page, then inject the *unmodified*
// userscript into the page's main world and drive it through its existing test hooks
// (window.__KR__) against the fixture's ground truth (window.__gen__ / window.__stub__).
// The script needs no test-only code — those hooks already exist for dev/testing.
const fs = require("fs");
const path = require("path");

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "keypad-recognizer.user.js"),
  "utf8"
);

/**
 * Navigate to a fixture, force-enable the script, and inject it.
 * @param {import('@playwright/test').Page} page
 * @param {string} fixture  e.g. "keypad-generator.html"
 * @param {Record<string,string>} params  URL query params
 */
async function setup(page, fixture, params = {}) {
  const qs = new URLSearchParams(params).toString();
  await page.goto(`/stubs/${fixture}${qs ? "?" + qs : ""}`);
  // Wait for the fixture to publish its ground-truth object.
  await page.waitForFunction(() => window.__gen__ || window.__stub__);
  // Enable without whitelisting, then inject the real script (its IIFE runs start()).
  await page.evaluate(() => localStorage.setItem("kr:forceEnable", "true"));
  await page.evaluate(SCRIPT);
  await page.waitForFunction(() => !!window.__KR__);
}

module.exports = { setup, SCRIPT };
