// ==UserScript==
// @name         UserSniper Helper — Discord Sniper flow
// @namespace    local.usersniper.helper
// @version      0.1.0
// @description  On usersniper.com: Names -> pick 4c -> Randomize -> Discord Sniper -> Start, and shows the username that was ACTUALLY sniped. Runs in your browser on your normal connection — no proxies.
// @match        *://usersniper.com/*
// @match        *://www.usersniper.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ==============================================================
   *  The script finds UI elements by their visible text, so it
   *  works even without knowing the site's exact DOM. If a label
   *  on the site differs, edit the CONFIG values below.
   * ============================================================== */
  const CONFIG = {
    namesTab: "Names",
    fourChar: "4c",
    randomize: "Randomize",
    sniperTab: "Discord Sniper",
    startButton: "Start",
    waitTimeoutMs: 15000, // max ms to wait for a tab/button to appear
    loadDelayMs: 3500,    // ms to sit after a tab loads / randomize is clicked
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- overlay panel ---------------- */
  let panel, logBox;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;width:330px;" +
      "background:rgba(14,14,18,.96);color:#e6e6ea;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "border:1px solid #3a3a44;border-radius:10px;padding:10px 12px;box-shadow:0 8px 30px rgba(0,0,0,.55);";
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<strong style="font-size:13px">UserSniper Helper</strong>' +
      '<button id="us-panel-close" title="Close" style="background:none;border:none;color:#8a8a93;cursor:pointer;font-size:15px;line-height:1">✕</button></div>' +
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
      '<button id="us-panel-all" style="flex:1;background:#23a55a;border:none;color:#fff;border-radius:6px;padding:6px 4px;font:inherit;cursor:pointer">Run all</button>' +
      '<button id="us-panel-names" style="flex:1;background:#5865f2;border:none;color:#fff;border-radius:6px;padding:6px 4px;font:inherit;cursor:pointer">Names flow</button>' +
      '<button id="us-panel-snipe" style="flex:1;background:#faa61a;border:none;color:#fff;border-radius:6px;padding:6px 4px;font:inherit;cursor:pointer">Start sniper</button></div>' +
      '<div style="font-size:11px;color:#8a8a93;margin-bottom:6px">Logs every step, and shows the username that was actually sniped in a banner.</div>' +
      '<div id="us-panel-log" style="max-height:150px;overflow:auto;background:#0a0a0d;border-radius:6px;padding:6px 8px;color:#9cdcfe;white-space:pre-wrap;word-break:break-word"></div>';
    document.documentElement.appendChild(panel);
    panel.querySelector("#us-panel-close").onclick = () => panel && panel.remove();
    panel.querySelector("#us-panel-all").onclick = () => runAll();
    panel.querySelector("#us-panel-names").onclick = () => runFlow();
    panel.querySelector("#us-panel-snipe").onclick = () => startSniper();
    logBox = panel.querySelector("#us-panel-log");
  }

  function log(msg, kind) {
    console.log("[UserSniper Helper]", msg);
    ensurePanel();
    const color = kind === "ok" ? "#7ee787" : kind === "err" ? "#ff7b72" : "#9cdcfe";
    const line = document.createElement("div");
    line.style.color = color;
    line.textContent = "› " + msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  /* ---------------- flexible lookup by visible text ---------------- */
  function candidates() {
    return [
      ...document.querySelectorAll(
        "button,a,[role='tab'],[role='button'],[role='menuitem'],label,li,span,input,select,option,[class*='tab'],[class*='Tab'],[class*='btn'],[class*='Btn']"
      ),
    ].filter((el) => el.getClientRects().length > 0);
  }

  function findByText(want, mode) {
    const w = want.trim().toLowerCase();
    const found = candidates()
      .map((el) => {
        const s = (el.textContent || "").trim();
        return { el, s: s.toLowerCase(), len: s.length };
      })
      .filter(({ s, len }) => len > 0 && len <= 80 && (mode === "loose" ? s.includes(w) : s === w))
      .sort((a, b) => a.len - b.len);
    return found[0] ? found[0].el : null;
  }

  async function waitFor(find, label, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || CONFIG.waitTimeoutMs)) {
      const el = find();
      if (el) return el;
      await sleep(300);
    }
    throw new Error("Timed out looking for: " + label);
  }

  /* Tries exact text first, then loose text (e.g. "Start" vs "Start sniping"). */
  async function clickStep(label, attempts) {
    for (const [text, mode] of attempts) {
      try {
        const el = await waitFor(() => findByText(text, mode), label, 8000);
        el.click();
        log("Clicked: " + label, "ok");
        await sleep(500);
        return;
      } catch (e) {
        /* try next matching strategy */
      }
    }
    throw new Error("Timed out looking for: " + label);
  }

  /* ---------------- flow: Names -> 4c -> Randomize ---------------- */
  async function runFlow() {
    ensurePanel();
    try {
      log("Starting Names flow…");
      await clickStep(CONFIG.namesTab + " tab", [
        [CONFIG.namesTab, "exact"],
        [CONFIG.namesTab, "loose"],
      ]);
      log("Names tab opened, waiting for it to load…");
      await sleep(CONFIG.loadDelayMs);

      await clickStep(CONFIG.fourChar + " option", [
        [CONFIG.fourChar, "exact"],
        [CONFIG.fourChar, "loose"],
      ]);
      log("Selected " + CONFIG.fourChar + ", waiting for it to load…");
      await sleep(CONFIG.loadDelayMs);

      await clickStep(CONFIG.randomize + " button", [
        [CONFIG.randomize, "loose"],
        [CONFIG.randomize, "exact"],
      ]);
      log("Randomize clicked. Next: Discord Sniper -> Start.", "ok");
    } catch (err) {
      log("Names flow stopped: " + err.message, "err");
    }
  }

  /* ---------------- Discord Sniper -> Start ---------------- */
  async function startSniper() {
    ensurePanel();
    try {
      await clickStep(CONFIG.sniperTab + " tab", [
        [CONFIG.sniperTab, "exact"],
        [CONFIG.sniperTab, "loose"],
      ]);
      log("Discord Sniper tab opened, waiting…");
      await sleep(1500);

      await clickStep(CONFIG.startButton + " button", [
        [CONFIG.startButton, "exact"],
        [CONFIG.startButton, "loose"],
      ]);
      log("Sniper started — watching for the username that actually gets sniped…", "ok");
    } catch (err) {
      log("Could not start sniper: " + err.message, "err");
    }
  }

  async function runAll() {
    ensurePanel();
    log("Running full flow: Names -> 4c -> Randomize -> Discord Sniper -> Start");
    await runFlow();
    await sleep(800);
    await startSniper();
  }

  /* ---------------- detect the ACTUALLY sniped username ---------------- */
  const SUCCESS_PATTERNS = [
    /(?:sniped|claimed|got it|successfully)\s*[^\n@]{0,60}@([A-Za-z0-9_.]{2,32})/i,
    /@([A-Za-z0-9_.]{2,32})[^\n]{0,60}(?:sniped|claimed|success)/i,
    /(?:name|username)\s+(?:sniped|claimed)\s*[:\-]?\s*@?([A-Za-z0-9_.]{2,32})/i,
  ];

  function showSniped(username) {
    ensurePanel();
    let banner = document.getElementById("us-sniped-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "us-sniped-banner";
      banner.style.cssText =
        "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "background:#23a55a;color:#fff;font:700 17px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;" +
        "padding:12px 26px;border-radius:12px;box-shadow:0 8px 30px rgba(35,165,90,.45);";
      document.documentElement.appendChild(banner);
    }
    banner.textContent = "✅ Sniped: @" + username;
  }

  function watchForSnipedNames() {
    const seen = new Set();
    let lastCheck = 0;
    setInterval(() => {
      const now = performance.now();
      if (now - lastCheck < 1200) return;
      lastCheck = now;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = (node.textContent || "").trim();
        if (text.length < 2 || text.length > 200 || seen.has(text)) continue;
        if (!/snip|claim|success|got/i.test(text)) continue;
        seen.add(text); // evaluate each message once
        let detected = false;
        for (const re of SUCCESS_PATTERNS) {
          const m = text.match(re);
          if (m) {
            log("SNIPED: @" + m[1], "ok");
            showSniped(m[1]);
            detected = true;
            break;
          }
        }
        if (
          !detected &&
          /sn(ipe|ned)|claim|success/i.test(text) &&
          !/trying|attempt|target|watching|wait|search/i.test(text)
        ) {
          log("Possible success message: " + text.slice(0, 80), "ok");
        }
      }
    }, 1200);
    log("Watching for sniped usernames…");
  }

  /* ---------------- boot ---------------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensurePanel();
      watchForSnipedNames();
    });
  } else {
    ensurePanel();
    watchForSnipedNames();
  }
  log("Ready. Log in to usersniper.com with your own account, then open the panel and click Run all.");
})();