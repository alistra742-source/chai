'use strict';
/*
 * SNIPR — real-browser sniper-site driver.
 *
 * What this does, honestly and literally:
 *
 *   It opens SIX real Chromium browsers (Playwright: the Chrome/Edge you have
 *   installed, else Playwright's own Chromium) on the sniper site you picked,
 *   signs each one into YOUR account, walks the exact flow you asked for —
 *
 *     Names tab -> pick the pattern (4C by default) -> wait for the names to
 *     load -> Randomize -> <platform> Sniper tab -> Start
 *
 *   — keeps a live screenshot ("cam") of every browser, and reports the name
 *   the SITE says it sniped. It never reports the name it was trying for: the
 *   only names that reach the dashboard are ones the site itself mentioned in a
 *   success message (its own fetch/XHR/WebSocket traffic, or the text it renders).
 *
 *   There is no demo mode, no simulated result and no fake counter. If a browser
 *   cannot be launched, the run stops and says exactly why.
 *
 * Account creation is deliberately NOT automated: bring an account you already
 * have (paste your login in the UI, or set USERSNIPER_EMAIL / USERSNIPER_PASSWORD),
 * or sign in manually with SNIPR_HEADFUL=1 once.
 */

const fs = require('fs');
const path = require('path');

const CAM_W = 448;
const CAM_H = 280;
const STEP_POLL_MS = 1200;
const TAP_CAP = 300;   // raw site messages kept per page
const RUN_TAP_CAP = 120; // raw site messages surfaced in the UI
const TIME_BUDGET_MS = 90000;

/* ------------------------------ patterns --------------------------------- */
/* The pattern is clicked ON THE SITE — this app only knows the math so the
 * dashboard can show how big the space is (36^4 = 1,679,616 for 4C). */
const PATTERNS = [
  { id: '3L', len: 3, charset: 'L', total: 26 ** 3, label: '3 letters' },
  { id: '3C', len: 3, charset: 'C', total: 36 ** 3, label: '3 letters + digits' },
  { id: '4L', len: 4, charset: 'L', total: 26 ** 4, label: '4 letters' },
  { id: '4C', len: 4, charset: 'C', total: 36 ** 4, label: '4 letters + digits' },
];

function patternInfo(raw) {
  const s = String(raw || '4C').trim().toUpperCase().replace(/\s+/g, '');
  const preset = PATTERNS.find(p => p.id === s);
  if (preset) return preset;
  const m = s.match(/^([1-9])([LCD])$/);
  if (m) {
    const len = Math.min(8, Number(m[1]));
    const charset = m[2];
    const base = charset === 'D' ? 10 : charset === 'L' ? 26 : 36;
    return { id: s, len, charset, total: Math.pow(base, len), label: `${len} ${charset === 'L' ? 'letters' : charset === 'D' ? 'digits' : 'chars'}` };
  }
  return PATTERNS[3];
}

/* Everything we are willing to click for "4C" — the site may label it 4C, 4c,
 * "4 chars", "4-character", "4c names"… */
function patternMatchers(raw) {
  const p = patternInfo(raw);
  const id = p.id.toLowerCase();
  const typed = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // something typed by hand ("4 chars", "4-characters") is tried verbatim first
  const typedFirst = typed && !/^[1-9][lcd]$/.test(typed) ? [typed] : [];
  return [...new Set([
    ...typedFirst,
    id,
    `${id} names`,
    `${p.len} c`,
    `${p.len}c`,
    `${p.len} char`,
    `${p.len} chars`,
    `${p.len} characters`,
    `${p.len}-char`,
    p.len + (p.charset === 'C' ? ' chars' : p.charset === 'L' ? ' letters' : ' digits'),
    `${p.len} ${p.charset === 'C' ? 'letters' : p.charset === 'L' ? 'letters' : 'digits'} + digits`,
  ])];
}

/* ------------------------------ flow definitions -------------------------- */
const NAMES_TAB = ['names', 'name list', 'names list', 'username list', 'usernames'];

const FLOWS = {
  discord: {
    id: 'discord',
    label: 'Discord',
    accent: '#5865f2',
    site: 'https://usersniper.com',
    siteLabel: 'usersniper.com',
    namesTab: NAMES_TAB,
    sniperTab: ['discord sniper', 'discord sniping', 'discord', 'discord sniper names'],
    startButton: ['start sniping', 'start sniper', 'start', 'begin', 'go'],
  },
  gunslol: {
    id: 'gunslol',
    label: 'guns.lol',
    accent: '#ff2e4d',
    site: 'https://usersniper.com',
    siteLabel: 'usersniper.com',
    namesTab: NAMES_TAB,
    sniperTab: ['guns.lol sniper', 'guns.lol', 'gunslol', 'guns lol', 'guns.lol names', 'guns'],
    startButton: ['start sniping', 'start sniper', 'start', 'begin', 'go'],
  },
};

const STEP_IDS = ['open', 'signin', 'names', 'pattern', 'load', 'randomize', 'sniper-tab', 'start', 'watch'];

function stepsOf(flow, pattern) {
  return [
    { id: 'open', label: `open ${flow.siteLabel}` },
    { id: 'signin', label: 'sign in to your account' },
    { id: 'names', label: 'open the Names tab' },
    { id: 'pattern', label: `pick ${patternInfo(pattern).id} (${patternInfo(pattern).label})` },
    { id: 'load', label: 'wait for the names to load' },
    { id: 'randomize', label: 'click Randomize' },
    { id: 'sniper-tab', label: `open the ${flow.label} Sniper tab` },
    { id: 'start', label: 'click Start' },
    { id: 'watch', label: 'watch what the site snipes' },
  ];
}

/* ------------------------------ text helpers ------------------------------ */
/* Pure + unit tested (test/siteflow.test.js). */

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/* Words that are never a sniped username, even when they sit right next to the
 * word "sniped" (site chrome: "Discord Sniper started…", "success", …). */
const NOISE = new Set([
  'sniped', 'snipe', 'sniper', 'sniping', 'success', 'successful', 'successfully', 'claimed',
  'claim', 'discord', 'guns', 'gunslol', 'lol', 'username', 'usernames', 'name', 'names',
  'start', 'started', 'starting', 'stop', 'stopped', 'randomize', 'randomized', 'randomise',
  'available', 'taken', 'invalid', 'premium', 'attempt', 'attempts', 'error', 'warning',
  'true', 'false', 'null', 'undefined', 'undefined', 'http', 'https', 'www', 'com', 'net',
  'login', 'logout', 'signin', 'account', 'dashboard', 'waiting', 'loading', 'please',
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'now', 'new', 'has', 'was', 'were',
  'seconds', 'second', 'minute', 'min', 'time', 'just', 'only', 'found', 'search', 'result',
  'results', 'free', 'user', 'users', 'checking', 'checked', 'list',
  // JSON plumbing words — they sit right next to "success" and are never a name
  'message', 'msg', 'status', 'event', 'type', 'data', 'code', 'detail', 'info', 'text',
  'items', 'payload', 'response', 'request', 'again', 'later', 'then', 'been', 'being',
  'timestamp', 'count', 'total', 'progress', 'state', 'error_code', 'reason', 'sniping',
]);

const NAME_RE_SRC = '[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?';

function plausible(s) {
  const t = norm(s).replace(/^@/, '');
  if (!t || t.length < 2 || t.length > 32) return false;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  if (NOISE.has(t)) return false;
  if (/\.(com|net|org|io|gg|lol|json|js|css|png|jpg)$/.test(t)) return false;
  return true;
}

const SUCCESS_WORD = '(?:sniped|snipe|claimed|grabbed|secured|got|won|yours|congrats(?:ulations)?|success(?:ful(?:ly)?)?)';

/* ---------- what a site payload means (pure, unit-tested) ---------- */
/* Which keys mean "here is the name we just sniped for you"… */
const STRONG_NAME_KEY = /^(claimed|claim_?name|sniped|snipe|sniped_?name|sniped_?username|grabbed|won|got)$/;
/* …versus keys that are just "the name we are looking at" (an attempt). */
const WEAK_NAME_KEY = /^(user_?name|user|name|nick|nickname|login|result|value|target)$/;
const SUCCESS_KEY = /^(success|successful|ok|done|claimed|sniped|won|grabbed|snipe_?success|is_?success)$/;
const AVAILABLE_KEY = /^(available|is_?available|free|is_?free|unclaimed)$/;
const TAKEN_KEY = /^(taken|is_?taken)$/;

/* Grab the first complete JSON object out of a frame that may be wrapped, e.g.
 *   "42[\"snipes\",{\"success\":true,\"username\":\"k4ito\"}]" */
function firstJsonObject(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0; let inStr = false; let esc = false;
    const end = Math.min(s.length, i + 20000);
    for (let j = i; j < end; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const o = JSON.parse(s.slice(i, j + 1));
            if (o && typeof o === 'object') return o;
          } catch (_) { /* not this one */ }
          break;
        }
      }
    }
  }
  return null;
}

function collectPairs(node, acc, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return acc;
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
  for (const [k, v] of entries) {
    const key = String(k).toLowerCase();
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') acc.push({ key, value: v });
    else collectPairs(v, acc, depth + 1);
  }
  return acc;
}

/* A site payload is only a SNIPE when it says it got/claimed something. A bare
 * "username":"x" (or an available/taken answer) is an attempt, and an attempt is
 * exactly what the dashboard must never dress up as a result. */
function readPairs(pairs, addSniped, addFound) {
  const strVal = p => (typeof p.value === 'string' ? p.value : null);
  const success = pairs.some(p => SUCCESS_KEY.test(p.key) && (p.value === true || p.value === 'true'))
    || pairs.some(p => STRONG_NAME_KEY.test(p.key) && typeof p.value === 'string');
  const strong = pairs.map(p => (STRONG_NAME_KEY.test(p.key) ? strVal(p) : null)).find(v => plausible(v));
  const weak = pairs.map(p => (WEAK_NAME_KEY.test(p.key) ? strVal(p) : null)).find(v => plausible(v));
  const available = pairs.some(p => AVAILABLE_KEY.test(p.key) && (p.value === true || p.value === 'true'))
    || pairs.some(p => TAKEN_KEY.test(p.key) && p.value === false);

  if (strong) return addSniped(strong, `the site reported “${strong}” as claimed/sniped`);
  if (weak && success) return addSniped(weak, `the site answered success with “${weak}”`);
  if (weak && available) return addFound(weak, `the site says “${weak}” is available`);
  return null;
}

/* Everything a chunk of site output tells us. Returns
 *   { sniped: [{name, why}], found: [{name, why}] } */
function analyzeSiteText(text) {
  const raw = String(text || '');
  const sniped = new Map();
  const found = new Map();
  const addTo = map => (name, why) => {
    if (!plausible(name)) return;
    const key = norm(name).replace(/^@/, '');
    if (!map.has(key)) map.set(key, { name: key, why: norm(why).slice(0, 90) });
  };
  const addSniped = addTo(sniped);
  const addFound = addTo(found);

  const obj = firstJsonObject(raw);
  if (obj) readPairs(collectPairs(obj, [], 0), addSniped, addFound);

  // explicit claimed/sniped keys in frames we could not parse
  const isJsonKey = m => /^"\s*:/.test(raw.slice(m.index + m[0].length, m.index + m[0].length + 3));
  const strongKeyRe = new RegExp(`"(?:claimed|sniped|snipe|grabbed|won|got)"\\s*:\\s*"(${NAME_RE_SRC})"`, 'gi');
  for (const m of raw.matchAll(strongKeyRe)) if (!isJsonKey(m)) addSniped(m[1], m[0]);

  // a success word right next to a name: "sniped abc", "claimed: abc"
  const afterRe = new RegExp(`\\b${SUCCESS_WORD}\\b[^a-z0-9@]{0,24}@?(${NAME_RE_SRC})`, 'gi');
  for (const m of raw.matchAll(afterRe)) if (!isJsonKey(m)) addSniped(m[1], m[0]);
  // "@abc was claimed", "abc has been claimed" — an explicit owner, no adverbs
  const atBeforeRe = new RegExp(`@(${NAME_RE_SRC})\\s+(?:\\w+\\s+){0,2}${SUCCESS_WORD}\\b`, 'gi');
  for (const m of raw.matchAll(atBeforeRe)) addSniped(m[1], m[0]);
  const copulaBeforeRe = new RegExp(`\\b(${NAME_RE_SRC})\\s+(?:was|is|has\\s+been|got)\\s+${SUCCESS_WORD}\\b`, 'gi');
  for (const m of raw.matchAll(copulaBeforeRe)) if (!isJsonKey(m)) addSniped(m[1], m[0]);

  // availability mentions are reported separately, never as a snipe
  const availAfter = new RegExp(`\\b(?:available|unclaimed|not\\s+claimed|is\\s+free)\\b[^a-z0-9@]{0,24}@?(${NAME_RE_SRC})`, 'gi');
  for (const m of raw.matchAll(availAfter)) if (!isJsonKey(m)) addFound(m[1], m[0]);
  const availBefore = new RegExp(`@?(${NAME_RE_SRC})\\s+(?:is\\s+)?(?:available|free|unclaimed|not\\s+claimed)\\b`, 'gi');
  for (const m of raw.matchAll(availBefore)) if (!isJsonKey(m)) addFound(m[1], m[0]);

  return { sniped: [...sniped.values()], found: [...found.values()] };
}

function extractSniped(text) { return analyzeSiteText(text).sniped; }
function extractFound(text) { return analyzeSiteText(text).found; }

/* --------------------- real browser discovery --------------------------- */
function channelPath(channel) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const candidates = channel === 'chrome' ? (
    win ? [
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : mac ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  ) : (
    win ? [
      path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : mac ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  );
  return candidates.filter(p => p && fs.existsSync(p))[0] || null;
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

/* Ordered launch strategies: installed Chrome, installed Edge, Playwright's own Chromium. */
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

/* What the dashboard shows in the header — never a vague "ok". */
function browserReport() {
  const pw = detectPlaywright();
  const plan = launchPlan();
  return {
    playwright: !!pw,
    browser: plan.length ? plan[0].name : null,
    browsers: plan.map(p => p.name),
    headless: process.env.SNIPR_HEADFUL ? false : true,
    error: plan.length ? null
      : !pw ? 'playwright is not installed — run `npm i playwright`'
        : 'no usable browser: install Google Chrome, or run `npx playwright install --with-deps chromium`',
  };
}

/* A browser binary on disk is not the same as a browser that can start (the
 * container case: chromium is there but its system libraries are not). This
 * launches one for real and closes it again, so the dashboard can say which of
 * the two situations you are in before a run is attempted. */
async function verifyBrowser({ headless = !process.env.SNIPR_HEADFUL, timeoutMs = 45000 } = {}) {
  const pw = detectPlaywright();
  const plans = launchPlan();
  if (!pw || !plans.length) return { ok: false, browser: null, error: browserReport().error, ms: 0 };
  const started = Date.now();
  const failures = [];
  for (const plan of plans) {
    try {
      const browser = await pw.chromium.launch({ headless, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(plan.channel ? { channel: plan.channel } : {}) });
      const page = await browser.newPage();
      await page.setContent('<title>snipr</title><p>ok</p>').catch(() => {});
      await browser.close();
      return { ok: true, browser: plan.name, ms: Date.now() - started, error: null };
    } catch (e) {
      failures.push(launchFailure(plan.name, e));
    }
  }
  return { ok: false, browser: null, ms: Date.now() - started, error: 'could not launch a real browser — ' + failures.join(' | ') };
}

/* Turn Playwright's (very long) launch dump into the one line that matters. */
function launchFailure(name, e) {
  const msg = String((e && e.message) || e);
  const lib = msg.match(/error while loading shared libraries: ([^\s:]+)/);
  if (lib) return `${name}: the browser cannot start — missing system library ${lib[1]}. Run \`npx playwright install --with-deps chromium\` (or install Google Chrome).`;
  const missing = msg.match(/Executable doesn't exist[^\n]*/);
  if (missing) return `${name}: ${missing[0].slice(0, 140)}`;
  return `${name}: ${msg.split('\n')[0].slice(0, 160)}`;
}

/* ------------------------------ in-page click ---------------------------- */
/* The sniper site's markup is not something we can hardcode (it is behind
 * Cloudflare and changes), so every control is found by its *visible text* —
 * exact text wins over partial, real buttons win over wrapper divs, and the
 * smallest matching element is clicked so the handler actually fires. */
function finderFn({ matchers, forbid }) {
  const normT = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const els = Array.from(document.querySelectorAll(
    'button,a,[role="button"],[role="tab"],[role="menuitem"],[role="switch"],input[type="submit"],input[type="button"],summary,li,label,span,div,p'
  ));
  const own = el => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += ' ' + n.textContent;
    return normT(t);
  };
  const best = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) continue;
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null) continue;
    const o = own(el);
    const f = normT(el.innerText || el.textContent);
    if (!f || f.length > 90) continue;
    if (forbid && forbid.some(b => normT(b) === o || normT(b) === f)) continue;
    const tag = el.tagName;
    const interactive = /^(BUTTON|A|INPUT|SUMMARY|LI|LABEL)$/.test(tag)
      || ['button', 'tab', 'menuitem', 'switch'].includes(el.getAttribute('role') || '') ? 0 : 1;
    for (const m of matchers) {
      const mm = normT(m);
      if (!mm) continue;
      let score = -1;
      if (o === mm) score = 0;
      else if (f === mm) score = 1;
      else if (o.startsWith(mm + ' ') || o.endsWith(' ' + mm)) score = 2;
      else if (o.includes(mm)) score = 3;
      else if (f.includes(mm)) score = 4;
      if (score < 0) continue;
      best.push({ score, interactive, area: r.width * r.height, el, mm });
      break;
    }
  }
  if (!best.length) return null;
  best.sort((a, b) => a.score - b.score || a.interactive - b.interactive || a.area - b.area);
  const hit = best[0];
  try { hit.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { /* ignore */ }
  const info = {
    tag: hit.el.tagName,
    text: String(hit.el.innerText || hit.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    matched: hit.mm,
  };
  try { hit.el.click(); } catch (_) {
    hit.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  return info;
}

async function clickAny(page, matchers, opts = {}) {
  const { timeout = 20000, forbid = null, what = 'control' } = opts;
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(finderFn, { matchers, forbid }).catch(e => { last = e; return null; });
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  throw new Error(`could not find ${what} — tried [${matchers.join(' | ')}]`
    + (last ? ` (${String(last.message || last).slice(0, 80)})` : ''));
}

async function typeInto(page, selector, value) {
  const el = await page.$(selector).catch(() => null);
  if (!el) return false;
  await el.fill(value).catch(async () => { await el.click(); await page.keyboard.type(value, { delay: 15 }); });
  return true;
}

/* Does this page still show a login form? */
async function loginForm(page) {
  return page.evaluate(() => {
    const pw = document.querySelector('input[type="password"]');
    if (!pw) return null;
    const r = pw.getBoundingClientRect();
    const visible = r.width > 2 && r.height > 2;
    if (!visible) return null;
    const inputs = Array.from(document.querySelectorAll('input')).slice(0, 10).map(i => ({
      type: i.type, name: i.name || '', id: i.id || '', ph: i.placeholder || '',
    }));
    return { inputs };
  }).catch(() => null);
}

/* Wait until the names the site generated are on screen and nothing is loading. */
async function waitForNamesLoad(page, log, timeout = TIME_BUDGET_MS) {
  const deadline = Date.now() + timeout;
  let quiet = 0;
  let last = { rows: 0, busy: true };
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const busy = /\b(loading|please wait|fetching|scanning|generating|starting|checking)\b/i.test(text.slice(0, 4000));
      const leaves = Array.from(document.querySelectorAll('td,li,code,span,div,tr,option')).filter(el => el.childElementCount === 0);
      const toks = [];
      for (const el of leaves) {
        const t = (el.textContent || '').trim();
        if (/^[a-z0-9][a-z0-9._-]{1,7}$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1) toks.push(t);
        }
      }
      return { busy, rows: toks.length, sample: toks.slice(0, 6) };
    }).catch(() => ({ busy: true, rows: 0, sample: [] }));
    last = snap;
    if (!snap.busy && snap.rows >= 8) {
      quiet++;
      if (quiet >= 2) {
        log('ok', `names loaded — ${snap.rows} rows on screen (${snap.sample.join(', ')}…)`);
        return { ok: true, ...snap };
      }
    } else quiet = 0;
    await page.waitForTimeout(700);
  }
  log('warn', `names list never went quiet (saw ${last.rows} row-ish elements) — clicking Randomize anyway`);
  return { ok: false, ...last, timedOut: true };
}

/* ------------------------------ site traffic tap -------------------------- */
/* fetch/XHR are wrapped in-page; WebSocket frames come from CDP, because
 * monkey-patching the WebSocket constructor tends to break the very realtime
 * connection we want to watch. */
const TAP_INIT = () => {
  const push = (kind, url, text) => {
    try {
      const t = window.__SNIPR_TAP || (window.__SNIPR_TAP = []);
      t.push({ kind, url: String(url || '').slice(0, 180), text: String(text == null ? '' : text).slice(0, 4000), t: Date.now() });
      if (t.length > 300) t.splice(0, t.length - 300);
    } catch (_) { /* ignore */ }
  };
  window.__sniprPush = push;
  const of = window.fetch;
  if (of) {
    window.fetch = function (...args) {
      const url = (args[0] && args[0].url) || args[0];
      return of.apply(this, args).then(res => {
        try { res.clone().text().then(t => push('fetch', url, t)).catch(() => {}); } catch (_) { /* ignore */ }
        return res;
      });
    };
  }
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('load', () => { try { push('xhr', url, this.responseText); } catch (_) { /* ignore */ } });
    return oo.call(this, method, url, ...rest);
  };
};

class Tap {
  constructor(page, onItem) {
    this.page = page;
    this.onItem = onItem;
    this.stopped = false;
  }

  async install() {
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      this.cdp = cdp;
      cdp.on('Network.webSocketFrameReceived', e => {
        const payload = e && e.response && e.response.payloadData;
        if (payload) this.onItem({ kind: 'ws', url: '', text: String(payload) });
      });
      await cdp.send('Network.enable').catch(() => {});
    } catch (_) { /* no CDP: fetch/XHR tap still works */ }
  }

  /* Drain everything the site has said since the last call. */
  async drain() {
    if (this.stopped) return [];
    const items = await this.page.evaluate(() => {
      const t = window.__SNIPR_TAP || [];
      window.__SNIPR_TAP = [];
      return t;
    }).catch(() => []);
    return Array.isArray(items) ? items : [];
  }

  async pageText() {
    return this.page.evaluate(() => {
      if (!document.body) return '';
      return document.body.innerText.slice(-6000);
    }).catch(() => '');
  }

  close() { this.stopped = true; try { if (this.cdp) this.cdp.detach(); } catch (_) { /* ignore */ } }
}

/* ------------------------------ the sniper -------------------------------- */
class SiteSniper {
  constructor() {
    this.browser = null;
    this.browserName = null;
    this.contexts = [];
    this.pages = [];
    this.taps = [];
    this.workers = [];
    this.running = false;
    this.abort = false;
    this.lastError = null;
    this.creds = {};       // per platform, memory only — never written to disk
    this.startedAt = 0;
  }

  setCreds(platform, email, password) {
    if (!email || !password) return false;
    this.creds[platform] = { email: String(email), password: String(password) };
    return true;
  }

  credsFor(platform) {
    const direct = this.creds[platform];
    if (direct) return direct;
    const envEmail = process.env.USERSNIPER_EMAIL || process.env.SNIPR_EMAIL;
    const envPass = process.env.USERSNIPER_PASSWORD || process.env.SNIPR_PASSWORD;
    if (envEmail && envPass) return { email: envEmail, password: envPass };
    return null;
  }

  loginState() {
    const out = {};
    for (const id of Object.keys(FLOWS)) out[id] = !!(this.creds[id] || (process.env.USERSNIPER_EMAIL && process.env.USERSNIPER_PASSWORD));
    out.env = !!(process.env.USERSNIPER_EMAIL && process.env.USERSNIPER_PASSWORD);
    return out;
  }

  meta() {
    return {
      running: this.running,
      browser: this.browserName,
      error: this.lastError,
      browsers: this.workers.length,
      workers: this.workers.map(w => ({
        id: w.id,
        step: w.step,
        stepIndex: w.stepIndex,
        stepCount: w.stepCount,
        status: w.status,
        lastAt: w.lastAt,
        camAt: w.camAt || 0,
        snipes: w.snipes || 0,
        notes: w.notes.slice(-6),
      })),
    };
  }

  camOf(n) {
    const w = this.workers[n - 1];
    return w && w.cam ? w.cam : null;
  }

  async stop() {
    this.abort = true;
    this.running = false;
    const browser = this.browser;
    this.browser = null;
    setTimeout(async () => { try { if (browser) await browser.close(); } catch (_) { /* ignore */ } }, 60);
    return true;
  }

  async start(run, opts = {}) {
    const flow = FLOWS[opts.flow] || FLOWS.discord;
    const count = Math.max(1, Math.min(6, Number(opts.browsers) || 6));
    const headless = opts.headful == null ? !process.env.SNIPR_HEADFUL : !opts.headful;
    const site = String(opts.site || flow.site).trim();
    const pattern = patternInfo(opts.pattern);
    const steps = stepsOf(flow, pattern);
    const matchers = {
      names: (opts.namesTab ? [opts.namesTab] : []).concat(flow.namesTab),
      sniper: (opts.sniperTab ? [opts.sniperTab] : []).concat(flow.sniperTab),
      pattern: patternMatchers(pattern.id),
      start: flow.startButton,
    };

    run.steps = steps.map(s => ({ id: s.id, label: s.label, done: 0, total: count }));
    run.flow = { id: flow.id, label: flow.label, site, siteLabel: flow.siteLabel, pattern: pattern.id, total: pattern.total, browsers: count, headless };

    const log = (level, msg, worker) => {
      run.steps_log = run.steps_log || [];
      run.steps_log.push({ t: Date.now(), level, msg, worker: worker || null });
      if (run.steps_log.length > 300) run.steps_log.splice(0, run.steps_log.length - 300);
    };

    const pw = detectPlaywright();
    const plans = launchPlan();
    if (!pw || !plans.length) {
      const rep = browserReport();
      this.lastError = rep.error;
      run.error = rep.error;
      run.running = false;
      throw new Error(rep.error);
    }

    const failures = [];
    for (const plan of plans) {
      try {
        this.browser = await pw.chromium.launch({
          headless,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--lang=en-US',
            '--no-first-run',
            '--mute-audio',
          ],
          ...(plan.channel ? { channel: plan.channel } : {}),
        });
        this.browserName = plan.name;
        this.lastError = null;
        break;
      } catch (e) {
        failures.push(launchFailure(plan.name, e));
      }
    }
    if (!this.browser) {
      this.lastError = 'could not launch a real browser — ' + failures.join(' | ');
      run.error = this.lastError;
      run.running = false;
      throw new Error(this.lastError);
    }
    log('ok', `${this.browserName} launched (${headless ? 'headless' : 'headful'}) — opening ${count} real browser windows`);

    this.workers = [];
    this.pages = [];
    this.taps = [];
    this.contexts = [];
    this.running = true;
    this.abort = false;
    run.running = true;
    run.startedAt = Date.now();

    const contextOpts = {
      viewport: { width: CAM_W, height: CAM_H },
      locale: 'en-US',
      deviceScaleFactor: 1,
    };

    /* Leader first: it signs in, then its cookies are shared with the other
     * browsers, so one account is not hammered with six logins. */
    let storageState = null;
    for (let i = 0; i < count; i++) {
      let context;
      try {
        context = await this.browser.newContext({ ...contextOpts, ...(i > 0 && storageState ? { storageState } : {}) });
      } catch (e) {
        run.error = 'browser context failed: ' + String(e.message || e).slice(0, 160);
        break;
      }
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await context.addInitScript(TAP_INIT);
      const page = await context.newPage();
      const worker = {
        id: i + 1, step: 'booting', stepIndex: -1, stepCount: steps.length, status: 'idle',
        notes: [], snipes: 0, cam: null, camAt: 0, lastAt: Date.now(),
      };
      const tap = new Tap(page, item => this.onTap(run, worker, item));
      this.workers.push(worker);
      this.contexts.push(context);
      this.pages.push(page);
      this.taps.push(tap);
      page.on('dialog', d => d.dismiss().catch(() => {}));
    }

    if (!this.pages.length) {
      await this.stop();
      run.running = false;
      run.finishedAt = Date.now();
      throw new Error(run.error || 'no browser pages could be created');
    }

    /* cam loop — a real screenshot of each browser, ~1/s */
    const camLoop = (async () => {
      while (!this.abort) {
        await Promise.all(this.pages.map(async (page, i) => {
          try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 45, timeout: 4000 });
            if (this.workers[i]) { this.workers[i].cam = buf; this.workers[i].camAt = Date.now(); }
          } catch (_) { /* page busy/slow — keep the previous frame */ }
        }));
        await new Promise(r => setTimeout(r, 900));
      }
    })();
    camLoop.catch(() => {});

    const makeCtx = (i, doLogin) => {
      const worker = this.workers[i];
      const ctx = {
        run, flow, site, pattern, steps, matchers, worker, log,
        page: this.pages[i], tap: this.taps[i],
        abort: () => this.abort || run.abort,
        doLogin,
      };
      ctx.note = this.noteFor(run, worker, log);
      return ctx;
    };

    /* the leader signs in first, then hands its session to the other browsers */
    try {
      await this.installTap(0);
      await this.drive(makeCtx(0, true));
      storageState = await this.contexts[0].storageState().catch(() => null);
      if (storageState && storageState.cookies && storageState.cookies.length) {
        log('ok', `session captured (${storageState.cookies.length} cookies) — sharing it with browsers 2-${this.pages.length}`);
        for (let i = 1; i < this.contexts.length; i++) {
          await this.contexts[i].addCookies(storageState.cookies).catch(() => {});
        }
      }
    } catch (e) {
      if (!e || e.aborted !== true) {
        this.lastError = String(e.message || e).slice(0, 200);
        run.error = this.lastError;
        log('err', this.lastError, 1);
      }
    }

    const tasks = [];

    /* the other browsers walk the same flow on the shared session */
    for (let i = 1; i < this.pages.length; i++) {
      const ctx = makeCtx(i, false);
      tasks.push((async () => {
        await new Promise(r => setTimeout(r, i * 1500)); // stagger, don't slam the site
        if (this.abort || run.abort) return;
        await this.installTap(i);
        try { await this.drive(ctx); }
        catch (e) {
          if (!e || e.aborted !== true) ctx.note('err', String(e.message || e).slice(0, 160));
        }
      })());
    }

    /* every browser now watches the site's own output for what it snipes */
    for (let i = 0; i < this.pages.length; i++) {
      const ctx = makeCtx(i, i === 0);
      tasks.push(this.watch(ctx));
    }

    await Promise.all(tasks);

    this.running = false;
    run.running = false;
    run.finishedAt = Date.now();
    await this.stop();
    return true;
  }

  async installTap(i) {
    if (this.taps[i] && !this.taps[i].installed) {
      this.taps[i].installed = true;
      await this.taps[i].install();
    }
  }

  /* Walk one browser through the whole flow, then watch the site's own output
   * for the name it actually sniped. */
  noteFor(run, worker, log) {
    return (level, msg) => {
      worker.notes.push({ t: Date.now(), level, msg: String(msg).slice(0, 200) });
      if (worker.notes.length > 40) worker.notes.splice(0, worker.notes.length - 40);
      worker.status = level === 'err' ? 'error' : level === 'warn' ? 'warn' : 'ok';
      worker.lastAt = Date.now();
      if (log) log(level, msg, worker.id);
    };
  }

  async drive(ctx) {
    const { page, worker, run, steps, matchers } = ctx;
    const note = ctx.note;
    const bail = () => { if (ctx.abort()) throw Object.assign(new Error('stopped'), { aborted: true }); };
    const at = async (id) => {
      const idx = steps.findIndex(s => s.id === id);
      worker.stepIndex = idx;
      worker.step = id;
      worker.status = 'running';
      worker.lastAt = Date.now();
      if (idx >= 0 && run.steps && run.steps[idx]) run.steps[idx].done++; // per-browser progress
      bail();
    };

    // 1 · open the site
    await at('open');
    const resp = await page.goto(ctx.site, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const status = resp ? resp.status() : 0;
    const title = await page.title().catch(() => '');
    if (status >= 400) {
      const err = new Error(`${ctx.flow.siteLabel} answered HTTP ${status} to this browser`);
      err.kind = 'blocked';
      throw err;
    }
    note('info', `${ctx.flow.siteLabel} loaded (HTTP ${status}) — “${title.slice(0, 60)}”`);
    await page.waitForTimeout(1200);

    // 2 · sign in (never creates an account)
    await at('signin');
    const form = await loginForm(page);
    if (!form) {
      note('ok', 'already signed in (no login form)');
    } else {
      const creds = this.credsFor(ctx.flow.id);
      if (!creds) {
        note('warn', `a login form is on screen — paste your ${ctx.flow.siteLabel} account in “Sign-in” (this app never creates accounts)`);
      } else {
        const pwSel = 'input[type="password"]';
        const userSel = 'input[type="email"],input[name*="user" i],input[name*="email" i],input[id*="user" i],input[id*="email" i],input[type="text"]';
        const u = await typeInto(page, userSel, creds.email);
        const p = await typeInto(page, pwSel, creds.password);
        note(u && p ? 'info' : 'warn', u && p ? 'filled the login form with your account' : 'could not find the login fields');
        if (u && p) {
          try {
            const hit = await clickAny(page, ['log in', 'login', 'sign in', 'signin', 'continue', 'submit'], { timeout: 8000, what: 'the login button' });
            note('info', `clicked “${hit.text}”`);
          } catch (e) { await page.keyboard.press('Enter').catch(() => {}); }
          const deadline = Date.now() + 45000;
          let gone = false;
          while (Date.now() < deadline && !aborted()) {
            if (!(await loginForm(page))) { gone = true; break; }
            await page.waitForTimeout(1000);
          }
          note(gone ? 'ok' : 'warn', gone ? 'signed in' : 'the login form is still there — check the account details');
        }
      }
    }
    bail();
    await page.waitForTimeout(1500);

    // 3 · Names tab
    await at('names');
    try {
      const hit = await clickAny(page, matchers.names, { timeout: 25000, what: 'the Names tab' });
      note('ok', `opened “${hit.text}”`);
    } catch (e) {
      note('warn', e.message);
    }
    bail();
    await page.waitForTimeout(1000);

    // 4 · the pattern, e.g. 4C
    await at('pattern');
    try {
      const hit = await clickAny(page, matchers.pattern, { timeout: 20000, what: `the ${ctx.pattern.id} pattern` });
      note('ok', `picked “${hit.text}” (${ctx.pattern.id})`);
    } catch (e) {
      note('warn', e.message);
    }
    bail();

    // 5 · wait for the names to actually load
    await at('load');
    const loaded = await waitForNamesLoad(page, note);
    if (!loaded.ok) note('warn', 'continuing without a confirmed load');

    // 6 · Randomize
    await at('randomize');
    try {
      const hit = await clickAny(page, ['randomize', 'randomise', 'shuffle', 'scramble', 'random'], { timeout: 20000, what: 'the Randomize button' });
      note('ok', `clicked “${hit.text}”`);
    } catch (e) {
      note('warn', e.message);
    }
    await page.waitForTimeout(1500);
    bail();

    // 7 · the platform's Sniper tab
    await at('sniper-tab');
    try {
      const hit = await clickAny(page, matchers.sniper, { timeout: 25000, forbid: matchers.names, what: `the ${ctx.flow.label} Sniper tab` });
      note('ok', `opened “${hit.text}”`);
    } catch (e) {
      note('warn', e.message);
    }
    bail();
    await page.waitForTimeout(1500);

    // 8 · Start
    await at('start');
    try {
      const hit = await clickAny(page, matchers.start, { timeout: 25000, forbid: ['stop', 'stop sniping'], what: 'the Start button' });
      note('ok', `clicked “${hit.text}” — sniping`);
    } catch (e) {
      note('err', e.message);
      throw e;
    }

    // 9 · every browser now just watches
    await at('watch');
  }

  /* Poll everything the site emits (its own fetch/XHR/WebSocket payloads and the
   * text it renders) and hand every success mention to the run. Runs until Stop. */
  async watch(ctx) {
    const { worker, run, tap, note } = ctx;
    let idle = 0;
    while (!this.abort && !run.abort) {
      const items = tap ? await tap.drain() : [];
      const before = worker.snipes || 0;
      for (const item of items) this.onTap(run, worker, item);
      const text = tap ? await tap.pageText() : '';
      if (text) this.onTap(run, worker, { kind: 'dom', url: '', text });
      idle = (worker.snipes || 0) > before ? 0 : idle + 1;
      if (idle === 15) note('info', 'watching the site for a snipe…');
      await new Promise(r => setTimeout(r, STEP_POLL_MS));
    }
  }

  /* One message from the site. Names that the site tied to a success word are
   * emitted as snipes: never the name we were aiming for, only what it said. */
  onTap(run, worker, item) {
    if (!item || !item.text) return;
    const text = String(item.text);
    const { sniped, found } = analyzeSiteText(text);
    for (const n of sniped) {
      run.snipes = run.snipes || [];
      if (run.snipes.some(s => s.name === n.name)) continue;
      const entry = { name: n.name, at: Date.now(), worker: worker ? worker.id : null, via: item.kind, why: n.why };
      run.snipes.push(entry);
      if (run.snipes.length > 500) run.snipes.splice(0, run.snipes.length - 500);
      if (worker) worker.snipes = (worker.snipes || 0) + 1;
      try {
        fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
        fs.appendFile(path.join(__dirname, '..', 'results', `sniped_${run.platform || 'run'}.txt`), `${new Date(entry.at).toISOString()} @${n.name}  (${item.kind}: ${n.why})\n`, () => {});
      } catch (_) { /* ignore */ }
      if (run.steps_log) {
        run.steps_log.push({ t: Date.now(), level: 'snipe', msg: `SNIPED @${n.name}`, worker: worker ? worker.id : null });
        if (run.steps_log.length > 300) run.steps_log.splice(0, run.steps_log.length - 300);
      }
    }

    /* Names the site says are merely available are kept in their own list — a
     * snipe is a claim, an available name is only an attempt's answer. */
    if (found.length) {
      run.found = run.found || [];
      run.foundNames = run.foundNames || new Set();
      for (const n of found) {
        if (run.found.length >= 200) break;
        if (run.foundNames.has(n.name)) continue;
        run.foundNames.add(n.name);
        run.found.push({ name: n.name, at: Date.now(), worker: worker ? worker.id : null, via: item.kind, why: n.why });
      }
    }

    // keep a small, honest window on what the site actually said
    const interesting = item.kind === 'ws' || item.kind === 'dom' || /[{}]/.test(text) || /snip|claim|success|available|taken/i.test(text);
    if (interesting) {
      run.tap = run.tap || [];
      run.tap.push({ at: Date.now(), worker: worker ? worker.id : null, kind: item.kind, text: text.replace(/\s+/g, ' ').slice(0, 240) });
      if (run.tap.length > RUN_TAP_CAP) run.tap.splice(0, run.tap.length - RUN_TAP_CAP);
    }
  }
}

module.exports = {
  SiteSniper,
  siteSniper: new SiteSniper(),
  FLOWS,
  PATTERNS,
  STEP_IDS,
  stepsOf,
  patternInfo,
  patternMatchers,
  extractSniped,
  extractFound,
  analyzeSiteText,
  plausible,
  norm,
  detectPlaywright,
  detectBrowser,
  launchPlan,
  browserReport,
  verifyBrowser,
};
