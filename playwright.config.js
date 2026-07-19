// @ts-check
const { defineConfig, devices } = require("@playwright/test");

// The suite drives the fixtures under stubs/ over http (localStorage on the file:// "null"
// origin is unreliable). It reuses the dev server if one is already running on :8137.
module.exports = defineConfig({
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:8137",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "python3 -m http.server 8137",
    url: "http://localhost:8137/keypad-recognizer.user.js",
    reuseExistingServer: true,
    cwd: __dirname,
    timeout: 20000,
  },
});
