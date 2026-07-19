// ==UserScript==
// @name         Keypad Recognizer — DEV loader (hot reload)
// @namespace    https://github.com/vctls/keypad_recog
// @version      0.1.0
// @description  Fetches keypad-recognizer.user.js from a local dev server and hot-reloads it on change. Install this ONCE; edit the real script freely.
// @match        http://localhost:8137/*
// @match        https://clients.boursobank.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/*
 * Dev workflow (hot reload):
 *   1. Serve the repo:   python3 -m http.server 8137   (run from the repo root)
 *   2. Install THIS loader once in Tampermonkey/Violentmonkey.
 *   3. Develop against  http://localhost:8137/stubs/boursobank-stub.html
 *   4. Edit keypad-recognizer.user.js -> within ~POLL_MS the script re-runs live
 *      (the main script is idempotent: it tears down the old panel/observer first).
 *
 * To test on the REAL site: the loader also matches clients.boursobank.com and pulls
 * the script via GM_xmlhttpRequest (bypasses mixed-content). NOTE: the bank's CSP may
 * block eval() there — if so, iterate on the stub and install the built script normally
 * for final validation on the live site.
 *
 * Set POLL_MS = 0 to disable polling (then just reload the page to pick up changes).
 */

(function () {
  "use strict";

  const SCRIPT_URL = "http://localhost:8137/keypad-recognizer.user.js";
  const POLL_MS = 1500;
  let last = null;

  // Dev convenience: auto-enable the main script here so you never have to whitelist
  // during development (it reads this shared GM value via store.get("forceEnable")).
  if (typeof GM_setValue !== "undefined") { try { GM_setValue("kr:forceEnable", true); } catch (e) {} }

  function get(url, onText, onErr) {
    if (typeof GM_xmlhttpRequest !== "undefined") {
      GM_xmlhttpRequest({
        method: "GET", url,
        onload: (r) => (r.status >= 200 && r.status < 300 ? onText(r.responseText) : onErr(r.status)),
        onerror: () => onErr("network"),
      });
    } else {
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? r.text().then(onText) : onErr(r.status)))
        .catch(() => onErr("network"));
    }
  }

  function run() {
    get(SCRIPT_URL + "?_=" + Date.now(), (code) => {
      if (code === last) return;               // unchanged since last fetch
      last = code;
      try {
        // Direct eval keeps the loader's GM_* grants in scope for the main script.
        // eslint-disable-next-line no-eval
        eval(code + "\n//# sourceURL=keypad-recognizer.user.js");
        console.log("[KR dev] script (re)loaded");
      } catch (e) {
        console.error("[KR dev] eval failed:", e);
      }
    }, (err) => console.warn("[KR dev] fetch failed (" + err + ") — is `python3 -m http.server 8137` running in the repo root?"));
  }

  run();
  if (POLL_MS > 0) setInterval(run, POLL_MS);
})();
