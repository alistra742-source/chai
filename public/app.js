'use strict';
/* SNIPR frontend — dashboard, live cam wall, HYDRA swarm runtime.
 *
 * There is no simulation anywhere: every result comes from a real request.
 *
 * HYDRA: when the "swarm" engine is picked but the host has no real browser
 * to drive, the run falls back to 6 parallel Web Workers inside THIS browser
 * (your real browser, your real IP). Discord is checked directly (Pomelo
 * endpoint allows CORS); other platforms are relayed through /api/proxy.
 * The server hands out every name exactly once, so the six workers never
 * duplicate work.
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const N_BROWSERS = 6;

const PLATFORM_URL = {
  gunslol: (u) => `https://guns.lol/${u}`,
  instagram: (u) => `https://instagram.com/${u}`,
  tiktok: (u) => `https://tiktok.com/@${u}`,
  discord: () => null,
};

const state = {
  platform: 'gunslol',
  tab: 'pattern',
  feedFilter: 'all',
  pollTimer: null,
  lastRunId: null,
  feedRenderedKey: '',
  browserAbort: false,
  pumping: false,
  hydraRunning: false,
  hydraWorkers: [],
  lastCfg: null,          // config of the run in flight (hydra fallback)
  swarmMode: null,        // 'playwright' | 'hydra' | null
  camAt: [0, 0, 0, 0, 0, 0],
  cams: {},               // workerId -> telemetry {current,checked,valid,last}
  net: null,              // last proxy status from the server
  netFilled: false,       // controls seeded from the server once
  netToastUntil: 0,       // keep a test/apply result on screen briefly
};

/* ------------------------------ config UI ------------------------------- */
$$('.platform').forEach(btn => btn.addEventListener('click', () => {
  $$('.platform').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.platform = btn.dataset.platform;
  updateEngineNote();
}));

$$('.tab[data-tab]').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab[data-tab]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.tab = btn.dataset.tab;
  $('#tab-pattern').hidden = state.tab !== 'pattern';
  $('#tab-list').hidden = state.tab !== 'list';
  updateStartHint();
}));

$$('.chip').forEach(btn => btn.addEventListener('click', () => {
  $('#lenRange').value = btn.dataset.len;
  $('#lenVal').textContent = btn.dataset.len;
  $('#useLetters').checked = btn.dataset.charset === 'L' || btn.dataset.charset === 'C';
  $('#useDigits').checked = btn.dataset.charset === 'C' || btn.dataset.charset === 'D';
  syncPatternUI();
}));

$('#lenRange').addEventListener('input', () => syncPatternUI());
$('#useLetters').addEventListener('change', syncPatternUI);
$('#useDigits').addEventListener('change', syncPatternUI);

function customSpec() {
  const letters = $('#useLetters').checked, digits = $('#useDigits').checked;
  const len = Number($('#lenRange').value);
  const base = (letters ? 26 : 0) + (digits ? 10 : 0);
  const charset = letters && digits ? 'C' : digits ? 'D' : 'L';
  return { len, charset, base, count: base > 0 ? Math.pow(base, len) : 0 };
}

function syncPatternUI() {
  const c = customSpec();
  $('#lenVal').textContent = c.len;
  $('#customCount').textContent = c.base > 0
    ? `${c.base}^${c.len} = ${fmt(c.count)} possibilities`
    : 'select at least one charset';
  $$('.chip').forEach(b => b.classList.toggle('active',
    Number(b.dataset.len) === c.len && b.dataset.charset === c.charset));
  updateStartHint();
}

$('#concurrency').addEventListener('input', () => { $('#concVal').textContent = $('#concurrency').value; });
$('#delay').addEventListener('input', () => { $('#delayVal').textContent = $('#delay').value + 'ms'; });

$('#nameList').addEventListener('input', () => {
  const n = listNames().length;
  $('#listCount').textContent = `${fmt(n)} username${n === 1 ? '' : 's'}`;
  updateStartHint();
});

function listNames() {
  return [...new Set($('#nameList').value.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
}

const ENGINE_NOTES = {
  server: 'Real checkers (ported from GitHub tools) fired from the machine hosting this app. Needs open outbound internet from that host.',
  browser: 'Checks run from YOUR browser: Discord directly (CORS-enabled Pomelo endpoint); guns.lol / IG / TikTok relayed via /api/proxy on the server.',
  swarm: '⚡ 6 REAL browsers sniping at the same time on the host, each with a live screenshot cam. Uses the Google Chrome / Edge already installed (or playwright\'s chromium via `npm i playwright`). If the host has no real browser, the run falls back to HYDRA: 6 real checkers inside YOUR browser.',
};
function updateEngineNote() { $('#engineNote').textContent = ENGINE_NOTES[$('#engine').value] || ''; }
$('#engine').addEventListener('change', updateEngineNote);

function currentTarget() {
  if (state.tab === 'pattern') {
    const c = customSpec();
    return c.base > 0 ? { kind: 'pattern', len: c.len, charset: c.charset } : null;
  }
  return { kind: 'list', names: listNames() };
}

/* ---------------------- exit IP / Tor rotation --------------------------- */
const NET_NOTES = {
  off: 'Direct — every check leaves from the IP of the machine running this app.',
  tor: '🧅 Tor: checks are tunnelled through the Tor SOCKS5 port. Every request opens a fresh circuit (unique SOCKS5 credentials + Tor\'s IsolateSOCKSAuth), and every N requests a SIGNAL NEWNYM forces a brand-new exit node. Needs a local Tor with `SocksPort 9050 IsolateSOCKSAuth` and `ControlPort 9051`. Many platforms block Tor exits (expect errors on IG/TikTok) — a proxy list or your own IP works better there. Note: the browser/HYDRA engine checks Discord from YOUR browser, which no server-side proxy can route — use the server or swarm engine for full Tor coverage.',
  list: 'Round-robin: each request uses the next proxy in the list (socks5:// or http://), so the exit IP changes request by request. Bad lines are rejected when you apply.',
};
function setNetStatus(text, cls) {
  const el = $('#netStatus');
  el.textContent = text;
  el.className = 'muted small' + (cls ? ' ' + cls : '');
}

function syncNetUI() {
  const mode = $('#proxyMode').value;
  $$('label.tor-only').forEach(l => { l.hidden = mode !== 'tor'; });
  const pwLabel = $('#torPasswordChk').closest('label');
  const pwRow = $('#torPassword').closest('label');
  if (pwRow) pwRow.hidden = !(mode === 'tor' && $('#torPasswordChk').checked);
  if (pwLabel) pwLabel.hidden = mode !== 'tor';
  $('#proxyList').hidden = mode !== 'list';
  $('#netHint').textContent = NET_NOTES[mode] || '';
}

function netBody() {
  const chk = $('#torPasswordChk').checked;
  const pw = $('#torPassword').value;
  const every = Number($('#rotEvery').value);
  return {
    mode: $('#proxyMode').value,
    torSocks: $('#torSocks').value.trim(),
    torControl: $('#torControl').value.trim(),
    isolate: $('#torIsolate').checked,
    rotateEvery: every,
    rotateIntervalMs: Math.max(1000, (Number($('#rotInterval').value) || 10) * 1000),
    list: $('#proxyList').value,
    // never blank out a stored control password unless the box is unticked
    ...(chk ? (pw ? { torPassword: pw } : {}) : { torPassword: '' }),
  };
}

function netLabel(p) {
  if (!p || p.mode === 'off') return 'direct — this machine\'s IP';
  const s = p.stats || {};
  const bits = [`${fmt(s.requests)} routed`];
  if (s.rotations) bits.push(`${fmt(s.rotations)} × new identity`);
  if (s.exitsSeen) bits.push(`${fmt(s.exitsSeen)} exit${s.exitsSeen === 1 ? '' : 's'} seen`);
  if (s.lastExit && s.lastExit.ip) bits.push(`last exit ${s.lastExit.ip}${s.lastExit.isTor ? ' (Tor ✓)' : ''}`);
  const err = s.errors && s.errors.length ? s.errors[s.errors.length - 1].msg : null;
  return (p.mode === 'tor' ? '🧅 ' : '↻ ') + p.label + ' · ' + bits.join(' · ') + (err ? ' · ⚠ ' + err : '');
}

function renderNet(p) {
  if (!p) return;
  state.net = p;
  if (Date.now() < state.netToastUntil) return;
  setNetStatus(netLabel(p), p.mode === 'off' ? '' : 'tor');
  if (state.netFilled) return;
  state.netFilled = true;
  $('#proxyMode').value = p.mode;
  if (p.tor.socks) $('#torSocks').value = p.tor.socks;
  if (p.tor.control) $('#torControl').value = p.tor.control;
  $('#torIsolate').checked = p.tor.isolate !== false;
  $('#torPasswordChk').checked = !!p.tor.hasPassword;
  $('#rotEvery').value = String(p.rotateEvery);
  $('#rotEveryVal').textContent = String(p.rotateEvery);
  $('#rotInterval').value = String(Math.round(p.rotateIntervalMs / 1000));
  if (p.list.length) $('#proxyList').value = p.list.map(x => x.label).join('\n');
  syncNetUI();
}

async function loadNet() {
  const j = await fetch('/api/net').then(r => r.json()).catch(() => null);
  if (j && j.proxy) renderNet(j.proxy);
}

async function applyNet(silent) {
  const j = await fetch('/api/net', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(netBody()),
  }).then(r => r.json()).catch(() => null);
  if (!j) { setNetStatus('⚠ server unreachable', 'warn'); return false; }
  if (!j.ok) {
    state.netToastUntil = Date.now() + 6000;
    setNetStatus('⚠ ' + j.error, 'warn');
    if (j.proxy) state.net = j.proxy;
    return false;
  }
  // a route that saves but cannot be dialled is the #1 cause of "every name is
  // a network error", so say it right here instead of letting a run discover it
  if (j.route && !j.route.ok) {
    state.netToastUntil = Date.now() + 8000;
    setNetStatus('⚠ saved, but the route does not answer: ' + j.route.error, 'warn');
    return true;
  }
  if (j.route && j.route.warnings && j.route.warnings.length) {
    state.netToastUntil = Date.now() + 8000;
    setNetStatus('⚠ ' + j.route.warnings[0], 'warn');
    return true;
  }
  if (!silent) state.netToastUntil = Date.now() + 4000;
  setNetStatus(netLabel(j.proxy), j.proxy.mode === 'off' ? 'ok' : 'tor');
  return true;
}

async function testNet() {
  state.netToastUntil = Date.now() + 15000;
  setNetStatus('testing the exit IP through the configured route…');
  const j = await fetch('/api/net/test', { method: 'POST' }).then(r => r.json()).catch(() => null);
  if (!j) return setNetStatus('⚠ server unreachable', 'warn');
  if (!j.ok) return setNetStatus('⚠ ' + (j.error || 'exit test failed'), 'warn');
  const verdict = j.isTor === true ? ' — Tor ✓' : j.isTor === false ? ' — NOT a Tor exit' : '';
  setNetStatus(`exit IP ${j.ip}${verdict} · ${j.ms}ms · ${j.proxy}`, j.isTor ? 'ok' : 'warn');
}

$('#proxyMode').addEventListener('change', syncNetUI);
$('#torPasswordChk').addEventListener('change', syncNetUI);
$('#rotEvery').addEventListener('input', () => { $('#rotEveryVal').textContent = $('#rotEvery').value; });
$('#netApply').addEventListener('click', () => applyNet(false));
$('#netTest').addEventListener('click', testNet);

function updateStartHint() {
  const t = currentTarget();
  const total = !t ? 0 : t.kind === 'pattern'
    ? Math.pow({ L: 26, C: 36, D: 10 }[t.charset] || 26, t.len)
    : t.kind === 'list' ? t.names.length : 0;
  $('#startHint').textContent = total
    ? `${fmt(total)} usernames will be checked on ${state.platform}`
    : 'pick a pattern or paste a list';
}

/* ------------------------------ run control ------------------------------ */
$('#startBtn').addEventListener('click', async () => {
  const t = currentTarget();
  if (!t) return;
  if (t.kind === 'list' && !t.names.length) return;
  await applyNet(true);   // the run must use exactly what the panel shows
  const body = {
    platform: state.platform,
    engine: $('#engine').value,
    target: t,
    concurrency: Number($('#concurrency').value),
    delay: Number($('#delay').value),
    shuffle: $('#shuffle').checked,
  };
  const r = await fetch('/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(x => x.json()).catch(() => ({ ok: false, error: 'server unreachable' }));
  if (!r.ok) { $('#startHint').textContent = '⚠ ' + r.error; return; }
  state.browserAbort = false;
  state.lastCfg = body;
  $('#runError').hidden = true;
  $('#stopBtn').disabled = false;
  $('#startBtn').disabled = true;

  if (body.engine === 'swarm') {
    state.swarmMode = r.swarmMode || 'hydra';
    $('#camMode').textContent = state.swarmMode === 'playwright'
      ? `· 6× ${r.browser || 'real browser'} on host — LIVE VIDEO`
      : '· HYDRA — 6 real checkers in your browser';
    $('#startHint').textContent = r.note || '';
    if (state.swarmMode === 'hydra') startHydra(body);
  } else {
    state.swarmMode = null;
    if (body.engine === 'browser') pumpBrowser(body);
  }
  pollSoon();
});

$('#stopBtn').addEventListener('click', async () => {
  state.browserAbort = true;
  stopHydra();
  await fetch('/api/stop', { method: 'POST' });
  $('#stopBtn').disabled = true;
  $('#startBtn').disabled = false;
});

/* ------------------------- browser-direct engine ------------------------- */
async function checkDiscordDirect(name) {
  try {
    const r = await fetch('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name }),
    });
    if (r.status === 429) return { name, status: 'error', note: 'rate limited' };
    if (r.status === 400) return { name, status: 'invalid', via: 'pomelo' };
    if (!r.ok) return { name, status: 'error', note: 'http ' + r.status };
    const j = await r.json();
    return { name, status: j.taken ? 'taken' : 'available', via: 'pomelo-direct' };
  } catch (_) {
    return { name, status: 'error', note: 'blocked by browser (CORS/network)' };
  }
}

async function pumpBrowser(cfg) {
  if (state.pumping) return;
  state.pumping = true;
  const chunk = 25;
  const conc = Math.max(1, Math.min(6, Number(cfg.concurrency) || 5));
  let done = false;   // the server cursor is exhausted — every worker can stop
  const worker = async () => {
    while (!state.browserAbort && !done) {
      let names = [], last = false;
      try {
        const j = await fetch(`/api/targets?n=${chunk}`).then(r => r.json());
        names = j.names || []; last = !!j.done;
      } catch (_) { break; }
      if (!names.length) { done = true; break; }
      let results = [];
      if (cfg.platform === 'discord') {
        for (const n of names) {
          if (state.browserAbort) break;
          results.push(await checkDiscordDirect(n));
          if (cfg.delay > 0) await new Promise(res => setTimeout(res, cfg.delay));
        }
      } else {
        const r = await fetch('/api/proxy', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: cfg.platform, names }),
        }).then(x => x.json()).catch(() => ({ results: names.map(n => ({ name: n, status: 'error', note: 'proxy failed' })) }));
        results = r.results || [];
        if (cfg.delay > 0) await new Promise(res => setTimeout(res, cfg.delay));
      }
      await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results }) }).catch(() => {});
      if (last) { done = true; break; }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  state.pumping = false;
  $('#stopBtn').disabled = true;
  $('#startBtn').disabled = false;
}

/* ------------------------------ HYDRA swarm ------------------------------ */
/* 6 Web Workers in this tab = 6 parallel REAL checkers with live telemetry.
 * Each worker pulls its next chunk from the server cursor, so the six of them
 * split the space instead of re-checking each other's names. */
const HYDRA_SRC = `
let checked = 0, valid = 0, current = null, last = '—', stopped = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function checkOne(origin, platform, name) {
  if (platform === 'discord') {
    try {
      const r = await fetch('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      if (r.status === 429) return { name, status: 'error', note: 'rate limited' };
      if (r.status === 400) return { name, status: 'invalid', via: 'pomelo-hydra' };
      if (!r.ok) return { name, status: 'error', note: 'http ' + r.status };
      const j = await r.json();
      return { name, status: j.taken ? 'taken' : 'available', via: 'pomelo-hydra' };
    } catch (_) { return { name, status: 'error', note: 'blocked by browser (CORS/network)' }; }
  }
  try {
    const j = await fetch(origin + '/api/proxy', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, names: [name] }),
    }).then(r => r.json());
    return (j.results && j.results[0]) || { name, status: 'error', note: 'proxy returned nothing' };
  } catch (_) { return { name, status: 'error', note: 'proxy unreachable' }; }
}

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.cmd === 'stop') { stopped = true; return; }
  if (d.cmd !== 'run') return;
  const { origin, platform, delay, workerId, chunkSize } = d;
  while (!stopped) {
    let names = [], done = false;
    try {
      const j = await fetch(origin + '/api/targets?n=' + chunkSize).then(r => r.json());
      names = j.names || []; done = !!j.done;
    } catch (_) { break; }
    if (!names.length) break;
    const results = [];
    for (const name of names) {
      if (stopped) break;
      current = name;
      results.push(await checkOne(origin, platform, name));
      if (delay > 0) await sleep(delay * (0.7 + Math.random() * 0.6));
    }
    checked += results.length;
    valid += results.filter(x => x.status === 'available').length;
    last = results.length ? results[results.length - 1].status : '—';
    try {
      await fetch(origin + '/api/report', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results }),
      });
    } catch (_) {}
    postMessage({ type: 'batch', workerId, results, tele: { current, checked, valid, last } });
    if (done) break;
  }
  postMessage({ type: 'done', workerId, tele: { current: null, checked, valid, last: 'exited' } });
};
`;

let HYDRA_URL = null;

function startHydra(cfg) {
  if (state.hydraRunning) return;
  state.hydraRunning = true;
  state.lastCfg = cfg;
  HYDRA_URL = URL.createObjectURL(new Blob([HYDRA_SRC], { type: 'application/javascript' }));
  const chunkSize = 6;
  let active = N_BROWSERS;

  for (let w = 1; w <= N_BROWSERS; w++) {
    let worker;
    try { worker = new Worker(HYDRA_URL); } catch (_) { active--; continue; }
    state.hydraWorkers.push(worker);
    state.cams[w] = { current: null, checked: 0, valid: 0, last: 'booting…' };
    renderCamPane(w);
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'batch') {
        state.cams[d.workerId] = { ...state.cams[d.workerId], ...d.tele };
        fetch('/api/report', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ results: d.results }),
        }).catch(() => {});
        renderCamPane(d.workerId);
      } else if (d.type === 'done') {
        state.cams[d.workerId] = { ...state.cams[d.workerId], ...d.tele };
        renderCamPane(d.workerId);
        if (--active <= 0) endHydra();
      }
    };
    worker.onerror = () => {
      state.cams[w] = { ...state.cams[w], current: null, last: 'worker error' };
      renderCamPane(w);
      if (--active <= 0) endHydra();
    };
    worker.postMessage({
      cmd: 'run', origin: location.origin, platform: cfg.platform,
      delay: cfg.delay, workerId: w, chunkSize,
    });
  }
  if (active <= 0) endHydra();
}

function endHydra() {
  state.hydraRunning = false;
  state.hydraWorkers = [];
  if (HYDRA_URL) { URL.revokeObjectURL(HYDRA_URL); HYDRA_URL = null; }
  $('#stopBtn').disabled = true;
  $('#startBtn').disabled = false;
}

function stopHydra() {
  for (const w of state.hydraWorkers) {
    try { w.postMessage({ cmd: 'stop' }); w.terminate(); } catch (_) {}
  }
  state.hydraWorkers = [];
  if (state.hydraRunning) endHydra();
  else if (HYDRA_URL) { URL.revokeObjectURL(HYDRA_URL); HYDRA_URL = null; }
}

/* ------------------------------ LIVE CAM wall ---------------------------- */
function buildCams() {
  const wrap = $('#cams');
  wrap.innerHTML = '';
  for (let i = 1; i <= N_BROWSERS; i++) {
    const pane = document.createElement('div');
    pane.className = 'cam';
    pane.id = 'cam' + i;
    pane.innerHTML = `
      <div class="cam-top"><span class="cam-id">B${i}</span><span class="cam-dot"></span><span class="cam-stat" id="camstat${i}">offline</span></div>
      <img id="camimg${i}" alt="browser ${i} live feed" hidden>
      <div class="cam-name" id="camname${i}">—</div>
      <div class="cam-meta" id="cammeta${i}">checked 0 · valid 0</div>
      <div class="cam-feed" id="camfeed${i}"></div>`;
    wrap.appendChild(pane);
  }
}

function renderCamPane(i) {
  const t = state.cams[i];
  if (!t) return;
  const set = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
  set(`#camname${i}`, t.current || '—');
  set(`#cammeta${i}`, `checked ${fmt(t.checked)} · valid ${fmt(t.valid)} · last ${t.last}`);
  set(`#camstat${i}`, t.current ? 'sniping…' : (t.last === 'exited' ? 'done' : 'idle'));
  const pane = $(`#cam${i}`);
  if (pane) pane.classList.toggle('live', !!t.current);
}

function renderServerCams(meta) {
  if (!meta || !meta.workers) return;
  for (const w of meta.workers) {
    state.cams[w.id] = {
      current: w.current, checked: w.checked, valid: w.valid, last: w.last,
    };
    renderCamPane(w.id);
    const img = $(`#camimg${w.id}`);
    if (img && w.camAt && w.camAt !== state.camAt[w.id - 1]) {
      state.camAt[w.id - 1] = w.camAt;
      img.hidden = false;
      img.src = `/api/cam/${w.id}.jpg?t=${w.camAt}`;
    }
  }
}

/* ------------------------------ single check ---------------------------- */
$('#singleBtn').addEventListener('click', async () => {
  const name = $('#singleName').value.trim().toLowerCase();
  if (!name) return;
  $('#singleOut').className = 'pill';
  $('#singleOut').textContent = '…checking';
  const r = await fetch('/api/check', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: state.platform, name }),
  }).then(x => x.json()).catch(() => ({ status: 'error', note: 'server unreachable' }));
  $('#singleOut').className = 'pill ' + r.status;
  $('#singleOut').textContent = `${name}: ${r.status}${r.note ? ' — ' + r.note : ''}`;
});

/* ------------------------------ polling --------------------------------- */
function pollSoon() { setTimeout(poll, 300); }

async function poll() {
  clearTimeout(state.pollTimer);
  let snap;
  try {
    snap = await fetch('/api/state').then(r => r.json());
  } catch (_) {
    state.pollTimer = setTimeout(poll, 2500);
    return;
  }
  render(snap);
  state.pollTimer = setTimeout(poll, 900);
}

function render(snap) {
  const r = snap.run;
  if (!r) return;
  if (r.id !== state.lastRunId) {
    state.lastRunId = r.id;
    state.feedRenderedKey = '';
    state.cams = {};
    $('#feed').innerHTML = '<div class="muted empty">waiting for first results…</div>';
    for (let i = 1; i <= N_BROWSERS; i++) { state.cams[i] = { current: null, checked: 0, valid: 0, last: '—' }; renderCamPane(i); const img = $(`#camimg${i}`); if (img) { img.hidden = true; img.removeAttribute('src'); } }
  }
  if (snap.proxy) renderNet(snap.proxy);
  const route = snap.proxy && snap.proxy.mode !== 'off' ? ` · ${snap.proxy.mode === 'tor' ? '🧅 tor' : '↻ ' + snap.proxy.list.length + ' proxies'}` : '';
  $('#runDesc').textContent = `${r.platform} · ${r.engine} engine · ${r.targetDesc}${route}`;
  $('#stTotal').textContent = fmt(r.total);
  $('#stChecked').textContent = fmt(r.checked);
  $('#stValid').textContent = fmt(r.availableCount);
  $('#stTaken').textContent = fmt(r.takenCount);
  $('#stInvalid').textContent = fmt(r.invalidCount);
  $('#stPremium').textContent = fmt(r.premiumCount);
  $('#stErrors').textContent = fmt(r.errorCount);
  $('#stLeft').textContent = fmt(r.remaining);
  $('#stRate').textContent = fmt(r.ratePerMin);
  $('#stEta').textContent = r.etaSec == null ? '∞' : r.etaSec > 86400
    ? Math.round(r.etaSec / 86400) + 'd' : r.etaSec > 3600
      ? Math.round(r.etaSec / 3600) + 'h' : r.etaSec > 60
        ? Math.round(r.etaSec / 60) + 'm' : r.etaSec + 's';
  const pct = r.total ? Math.min(100, (r.checked / r.total) * 100) : 0;
  $('#progressBar').style.width = pct.toFixed(2) + '%';

  if (!r.running) {
    $('#stopBtn').disabled = true;
    $('#startBtn').disabled = false;
  } else if (!state.hydraRunning && !state.pumping) {
    $('#stopBtn').disabled = false;
    $('#startBtn').disabled = true;
  }

  // surface why a run died instead of silently flipping back to idle
  const err = r.error || (snap.swarm && snap.swarm.error) || null;
  const errEl = $('#runError');
  if (err) { errEl.hidden = false; errEl.textContent = '⚠ ' + err; } else { errEl.hidden = true; }

  // the target is throttling/blocking us: every worker is paused, so the error
  // rows stop instead of piling up. Say so, and point at the fix (delay/route).
  const th = r.throttle || null;
  const thEl = $('#runThrottle');
  if (th && th.active) {
    const left = Math.max(1, Math.ceil((th.waitMs || 0) / 1000));
    thEl.textContent = `⏸ ${r.platform} is throttling this IP (hit ${th.hits}) — all workers paused ${left}s. `
      + 'Raise the delay, or rotate the route (exit IP) in section 4.';
    thEl.hidden = false;
  } else thEl.hidden = true;

  // cam wall source of truth
  if (snap.swarm && snap.swarm.meta) {
    const label = '· 6× ' + (snap.swarm.meta.browser || 'real browser') + ' on host — LIVE VIDEO';
    if ($('#camMode').textContent !== label) $('#camMode').textContent = label;
    renderServerCams(snap.swarm.meta);
  } else if (state.hydraRunning || Object.values(state.cams).some(c => c.checked)) {
    const label = '· HYDRA — 6 real checkers in your browser';
    if ($('#camMode').textContent !== label) $('#camMode').textContent = label;
  }

  // the swarm engine without a real browser on the host (or a host swarm that
  // died on launch) keeps running as 6 real in-browser workers
  if (r.running && r.engine === 'swarm' && snap.swarm && snap.swarm.mode === 'hydra'
      && !state.hydraRunning && !state.browserAbort && state.lastCfg) {
    startHydra(state.lastCfg);
  }

  renderFeed(r);
}

function renderFeed(r) {
  let rows = r.feed || [];
  if (state.feedFilter === 'available') rows = rows.filter(x => x.status === 'available');
  else if (state.feedFilter === 'taken') rows = rows.filter(x => x.status === 'taken');
  else if (state.feedFilter === 'error') rows = rows.filter(x => x.status === 'error' || x.status === 'invalid');

  const key = r.checked + ':' + rows.length + ':' + state.feedFilter + ':' + (rows[rows.length - 1]?.seq || 0);
  if (key === state.feedRenderedKey) return;
  state.feedRenderedKey = key;

  const el = $('#feed');
  if (!rows.length) {
    el.innerHTML = '<div class="muted empty">no rows for this filter yet…</div>';
    return;
  }
  el.innerHTML = rows.slice().reverse().map(x => {
    const url = x.status === 'available' ? PLATFORM_URL[r.platform]?.(x.name) : null;
    const time = new Date(x.t).toLocaleTimeString();
    const note = x.note ? ` — ${x.note}` : '';
    return `<div class="frow ${x.status}">
      <span class="fname">${esc(x.name)}</span>
      <span class="fstat">${{ available: 'VALID ✅', taken: 'taken ❌', invalid: 'invalid ⚠', premium: 'premium 💎', error: 'error ⚠' }[x.status] || x.status}</span>
      <span class="fvia">${esc(x.via || '')}${esc(note)}</span>
      ${url ? `<a href="${url}" target="_blank" rel="noopener">open ↗</a>` : ''}
      <span class="ftime">${time}</span>
    </div>`;
  }).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$$('.tab[data-feed]').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab[data-feed]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.feedFilter = btn.dataset.feed;
  state.feedRenderedKey = '';
}));

/* --------------------------- copy / download ---------------------------- */
$('#copyHits').addEventListener('click', async () => {
  const snap = await fetch('/api/state').then(r => r.json()).catch(() => null);
  const hits = snap?.run?.available || [];
  try { await navigator.clipboard.writeText(hits.join('\n')); $('#copyHits').textContent = '⧉ copied!'; }
  catch (_) { $('#copyHits').textContent = '⧉ ' + hits.length + ' hits'; }
  setTimeout(() => { $('#copyHits').textContent = '⧉ copy valid'; }, 1500);
});

/* --------------------------- network badge ------------------------------ */
(async () => {
  const badge = $('#netBadge');
  const set = (t, c) => { badge.textContent = t; badge.style.color = c; };
  try {
    const r = await fetch('/api/check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'discord', engine: 'server', name: 'zzqx9v' }),
    }).then(x => x.json());
    if (r.status === 'error') set('● host: outbound blocked → run from your browser (HYDRA)', 'var(--amber)');
    else set('● host: outbound OK (probe: discord ' + r.status + ')', 'var(--green)');
  } catch (_) {
    set('● server unreachable', 'var(--red)');
  }
  // playwright present on host?
  try {
    const s = await fetch('/api/swarm').then(x => x.json());
    if (s.browser) badge.title = `swarm: ${s.browser} detected — 6 real browsers ready`;
    else if (s.available) badge.title = 'swarm: playwright installed but no real browser found — run `npx playwright install chromium` or install Google Chrome';
    else badge.title = 'swarm: playwright not installed on host → HYDRA fallback (6 real checkers in your browser)';
  } catch (_) {}
})();

/* ------------------------------- boot ----------------------------------- */
(async () => {
  $('.platform[data-platform="gunslol"]').classList.add('active');
  $('#lenRange').value = 3;
  $('#lenVal').textContent = '3';
  $('#useLetters').checked = true;
  $('#useDigits').checked = false;
  buildCams();
  for (let i = 1; i <= N_BROWSERS; i++) state.cams[i] = { current: null, checked: 0, valid: 0, last: '—' };
  syncPatternUI();
  updateEngineNote();
  syncNetUI();
  loadNet();
  poll();
})();
