'use strict';
/*
 * SNIPR browser swarm — SIX real headless browsers sniping in parallel (the
 * Chrome/Edge already installed on the host, or playwright's chromium), each
 * with a live screenshot feed ("live cam") streamed to the dashboard.
 *
 * Browser-hardening flags, UA rotation, retry/backoff and the guns.lol
 * unclaimed-detection logic are copied from the latest generation of GitHub
 * sniping tools:
 *
 *  - efekrbas/guns.lol-username-checker (2026, Selenium):
 *      --headless=new --no-sandbox --disable-blink-features=AutomationControlled,
 *      navigator.webdriver removal, eager page loads, random UA per request,
 *      unclaimed when h1/title contains "username not found" / "bulunamad"
 *      or title contains "everything you want" / "istediğin her şey",
 *      premium-alias filter (names starting/ending with . - _ need premium).
 *  - CuteTenshii/guns-solver (2026): guns.lol fronts Cloudflare; a REAL
 *      browser passes the challenge naturally — which is exactly what this
 *      swarm is for (no cf_clearance/captcha-provider needed).
 *  - daskeptaxd/username-checker: Discord Pomelo unauthed endpoint, here
 *      evaluated from inside a real discord.com page context.
 *
 * Requires on the host:  npm i playwright, plus a real browser. The swarm
 * prefers the browser you already have installed (Google Chrome / Edge) and
 * only falls back to Playwright's own Chromium download. If no real browser
 * exists on the host the server switches the run to HYDRA mode — 6 workers
 * inside the user's own browser, still doing real checks.
 */

const fs = require('fs');
const path = require('path');
const proxyPool = require('./proxy');

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
];

const CAM_W = 420, CAM_H = 260;

function isPremiumAlias(name) {
  // copied from efekrbas/guns.lol-username-checker: ". - _" edges need premium
  return /^[._-]|[._-]$/.test(name);
}

let pwModule = null;
function detectPlaywright() {
  if (pwModule !== null) return pwModule;
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const pw = require(mod);
      if (pw && pw.chromium) { pwModule = pw; return pw; }
    } catch (_) { /* next */ }
  }
  pwModule = false;
  return false;
}

/* --------------------- real browser discovery --------------------------- */
/* Chrome/Edge are what users actually have; Playwright's bundled Chromium
 * only exists after `npx playwright install chromium`. */
function channelPath(channel) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const candidates = channel === 'chrome' ? (
    win ? [
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : mac ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  ) : (
    win ? [
      path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : mac ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  );
  return candidates.filter(p => p && fs.existsSync(p))[0] || null;
}

/* Ordered launch strategies: installed Chrome, installed Edge, bundled Chromium. */
function launchPlan() {
  const pw = detectPlaywright();
  if (!pw) return [];
  const plans = [];
  if (channelPath('chrome')) plans.push({ name: 'Google Chrome', channel: 'chrome' });
  if (channelPath('msedge')) plans.push({ name: 'Microsoft Edge', channel: 'msedge' });
  try {
    const exe = pw.chromium.executablePath();
    if (exe && fs.existsSync(exe)) plans.push({ name: 'Playwright Chromium', channel: null });
  } catch (_) { /* not installed */ }
  return plans;
}

function detectBrowser() {
  const plans = launchPlan();
  return plans.length ? plans[0].name : null;
}

class Swarm {
  constructor() {
    this.workers = [];   // per-browser stats
    this.pages = [];
    this.browser = null;
    this.browserName = null;
    this.lastError = null;
    this.running = false;
    this.abort = false;
    this.available = false;
  }

  meta() {
    return {
      mode: 'playwright',
      running: this.running,
      browser: this.browserName || null,
      proxy: this.proxyLabel || null,
      error: this.lastError || null,
      browsers: this.workers.length,
      workers: this.workers.map((w, i) => ({
        id: i + 1,
        ua: w.ua ? w.ua.slice(0, 60) + '…' : null,
        current: w.current,
        checked: w.checked,
        valid: w.valid,
        last: w.last,
        lastAt: w.lastAt,
        camAt: w.camAt || 0,
        nav: w.nav || 0,   // navigations done
      })),
    };
  }

  async start(run, count = 6) {
    const pw = detectPlaywright();
    const plans = launchPlan();
    if (!pw || !plans.length) {
      this.lastError = 'no real browser on the host — install Google Chrome/Edge or run `npx playwright install chromium`';
      throw new Error(this.lastError);
    }

    const args = [
      // flags copied from efekrbas/guns.lol-username-checker
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions',
      '--lang=en-US',
      '--no-first-run',
      '--mute-audio',
    ];

    const failures = [];
    for (const plan of plans) {
      try {
        this.browser = await pw.chromium.launch({
          headless: true,
          args,
          ...(plan.channel ? { channel: plan.channel } : {}),
        });
        this.browserName = plan.name;
        this.lastError = null;
        break;
      } catch (e) {
        failures.push(`${plan.name}: ${String(e.message || e).slice(0, 140)}`);
      }
    }
    if (!this.browser) {
      this.lastError = 'could not launch a real browser — ' + failures.join(' | ');
      throw new Error(this.lastError);
    }

    this.workers = [];
    this.pages = [];
    this.running = true;
    this.abort = false;
    run.running = true;
    run.startedAt = run.startedAt || Date.now();

    const cursor = { i: 0 };
    const platform = run.platform;
    // rotating proxy layer: one proxy per browser, so the 6 swarm browsers do
    // not all share a single exit IP (Tor: distributed over the proxy list, or
    // the Tor SOCKS5 port with NEWNYM rotation between circuits)
    const proxies = proxyPool.playwrightProxies(count);
    this.proxyLabel = proxies ? proxyPool.describe() : null;

    for (let w = 0; w < count; w++) {
      const context = await this.browser.newContext({
        viewport: { width: CAM_W, height: CAM_H + 40 },
        userAgent: UA_LIST[w % UA_LIST.length], // UA rotation from efekrbas
        locale: 'en-US',
        ...(proxies && proxies[w] ? { proxy: proxies[w] } : {}),
      });
      // copied: hide navigator.webdriver (anti-automation detection)
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const page = await context.newPage();
      this.pages.push(page);
      this.workers.push({
        ua: UA_LIST[w % UA_LIST.length], current: null, checked: 0,
        valid: 0, last: 'booting…', lastAt: Date.now(), cam: null, camAt: 0, nav: 0,
      });
    }

    // prep pages: discord needs a discord.com page to fetch from
    if (platform === 'discord') {
      await Promise.all(this.pages.map(p => p.goto('https://discord.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})));
    }

    const camLoop = (async () => {
      while (!this.abort) {
        await Promise.all(this.pages.map(async (page, i) => {
          try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 40, timeout: 2000 });
            this.workers[i].cam = buf;
            this.workers[i].camAt = Date.now();
          } catch (_) { /* page busy — keep last frame */ }
        }));
        await new Promise(r => setTimeout(r, 900));
      }
    })();
    camLoop.catch(() => {});

    const worker = async (i) => {
      const w = this.workers[i];
      const page = this.pages[i];
      while (!this.abort && !run.abort) {
        const idx = cursor.i++;
        if (idx >= run.total) return;
        const name = nameFor(run, idx);
        w.current = name;
        let res;
        try {
          res = await this.checkWithBrowser(page, w, platform, name, run);
        } catch (e) {
          res = { status: 'error', via: 'swarm', note: String(e.message || e).slice(0, 120) };
        }
        w.checked++;
        w.last = res.status;
        w.lastAt = Date.now();
        w.nav++;
        if (res.status === 'available') w.valid++;
        recordTo(run, name, res);
        // polite jitter (copied: random delay pattern from efekrbas)
        const base = run.delay || 250;
        await new Promise(r => setTimeout(r, base * (0.7 + Math.random() * 0.6)));
      }
    };

    await Promise.all(this.workers.map((_, i) => worker(i).catch(() => {})));
    this.running = false;
    run.running = false;
    run.finishedAt = Date.now();
    await this.stop();
  }

  async checkWithBrowser(page, w, platform, name, run) {
    if (platform === 'gunslol' && isPremiumAlias(name)) {
      return { status: 'premium', via: 'efekrbas-filter', note: 'premium-only alias (. - _ edges)' };
    }

    if (platform === 'discord') {
      // real fetch from inside a discord.com page (browser TLS + cookies)
      const r = await page.evaluate(async (username) => {
        try {
          const res = await fetch('/api/v9/unique-username/username-attempt-unauthed', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username }),
          });
          if (res.status === 429) return { s: 'ratelimited' };
          if (!res.ok) return { s: 'http' + res.status };
          const j = await res.json();
          return { s: j.taken ? 'taken' : 'available' };
        } catch (e) { return { s: 'error', note: String(e).slice(0, 80) }; }
      }, name).catch(e => { throw new Error('page eval failed: ' + String(e).slice(0, 80)); });
      if (r.s === 'ratelimited') throw new Error('discord rate limited this browser');
      if (r.s === 'http400') return { status: 'invalid', via: 'pomelo-browser' };
      if (r.s === 'available' || r.s === 'taken') return { status: r.s, via: 'pomelo-browser' };
      throw new Error('discord: ' + (r.note || r.s));
    }

    // navigation-based platforms: real page load per username
    const url = platform === 'gunslol' ? `https://guns.lol/${encodeURIComponent(name)}`
      : platform === 'tiktok' ? `https://www.tiktok.com/@${encodeURIComponent(name)}`
        : `https://www.instagram.com/${encodeURIComponent(name)}/`;

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000, ...{} })
      .catch(e => { throw new Error('nav failed: ' + String(e).slice(0, 80)); });
    await page.waitForTimeout(350); // let markers render (eager-style load)

    const http = resp ? resp.status() : 0;
    if (http === 404) return { status: 'available', http, via: 'browser-nav' };

    const page_info = await page.evaluate(() => {
      const h1s = [...document.querySelectorAll('h1')].map(h => (h.textContent || '').toLowerCase());
      return { title: (document.title || '').toLowerCase(), h1: h1s.join(' | '), body: document.body ? document.body.innerText.slice(0, 4000).toLowerCase() : '' };
    }).catch(() => ({ title: '', h1: '', body: '' }));

    if (platform === 'gunslol') {
      // detection copied from efekrbas/guns.lol-username-checker (EN + TR markers)
      const unclaimed =
        page_info.h1.includes('username not found') || page_info.h1.includes('bulunamad') ||
        page_info.title.includes('everything you want') || page_info.title.includes('istediğin her şey') ||
        page_info.body.includes('this user is not claimed'); // xnxv/guns.lol.scanner marker
      if (page_info.title.includes('just a moment') || page_info.title.includes('attention required')) {
        throw new Error('cloudflare challenge — slow down or use residential IP');
      }
      if (!page_info.title) throw new Error('empty page (timeout/cf)');
      return { status: unclaimed ? 'available' : 'taken', http, via: 'browser-nav' };
    }

    if (platform === 'tiktok') {
      if (/page not found|couldn.?t find/i.test(page_info.body)) return { status: 'available', http, via: 'browser-nav' };
      return { status: 'taken', http, via: 'browser-nav' };
    }

    // instagram
    if (/page not found|sorry, this page isn/i.test(page_info.body)) return { status: 'available', http, via: 'browser-nav' };
    if (http === 200 && page_info.title.includes('instagram')) return { status: 'taken', http, via: 'browser-nav' };
    if (http === 302 || http === 429 || http === 403) throw new Error(`instagram blocked (http ${http}) — needs residential IP`);
    return { status: 'taken', http, via: 'browser-nav' };
  }

  camOf(n) { const w = this.workers[n - 1]; return w && w.cam ? w.cam : null; }

  async stop() {
    this.abort = true;
    this.running = false;
    this.browserName = null;
    setTimeout(async () => {
      try { if (this.browser) await this.browser.close(); } catch (_) {}
      this.browser = null;
      this.pages = [];
    }, 50);
  }
}

/* helpers injected by server to avoid circular imports */
let _nameFor = null, _recordTo = null;
function bind(nameFor, recordTo) { _nameFor = nameFor; _recordTo = recordTo; }
function nameFor(run, idx) { return _nameFor(run, idx); }
function recordTo(run, name, res) { return _recordTo(run, name, res); }

module.exports = { Swarm, bind, detectPlaywright, detectBrowser, launchPlan, isPremiumAlias, UA_LIST, swarm: new Swarm() };
