'use strict';
/* SNIPR frontend — dashboard, live cam wall, HYDRA swarm runtime.
 *
 * HYDRA: when the "swarm" engine is picked and the server has no Playwright,
 * the run falls back to 6 parallel Web Workers inside THIS browser (your real
 * browser, your real IP). Discord is checked directly (Pomelo endpoint allows
 * CORS); other platforms are relayed through /api/proxy. Workers auto-degrade
 * to deterministic simulation if the host has no outbound access.
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
  swarmMode: null,        // 'playwright' | 'hydra' | null
  camAt: [0, 0, 0, 0, 0, 0],
  cams: {},               // workerId -> telemetry {current,checked,valid,last,sim}
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
  demo: 'Demo simulates results deterministically (no network) — try the math and the cam wall safely.',
  server: 'Real checkers (ported from GitHub tools) fired from the machine hosting this app. Needs open outbound internet from that host.',
  browser: 'Checks run from YOUR browser: Discord directly (CORS-enabled Pomelo endpoint); guns.lol / IG / TikTok relayed via /api/proxy on the server.',
  swarm: '⚡ 6 REAL headless Chrome browsers sniping at the same time on the host, each with a live screenshot cam (needs `npm i playwright && npx playwright install chromium` on the host). If Playwright is missing, it auto-falls back to HYDRA: 6 worker-threads inside YOUR browser — cam panes then show live per-browser telemetry.',
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
  $('#stopBtn').disabled = false;
  $('#startBtn').disabled = true;

  if (body.engine === 'swarm') {
    state.swarmMode = r.swarmMode || 'hydra';
    $('#camMode').textContent = state.swarmMode === 'playwright'
      ? '· 6× headless Chrome on host — LIVE VIDEO'
      : '· HYDRA — 6 workers in your browser';
    if (state.swarmMode === 'hydra') startHydra(body, r.total);
  } else {
    state.swarmMode = null;
    if (body.engine === 'browser') pumpBrowser(body, r.total);
  }
  pollSoon();
});

$('#stopBtn').addEventListener('click', async () => {
  state.browserAbort = true;
  state.hydraRunning = false;
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

async function pumpBrowser(cfg, total) {
  if (state.pumping) return;
  state.pumping = true;
  const chunk = 25;
  const conc = Math.max(1, Number(cfg.concurrency) || 5);
  let cursor = 0;
  const worker = async () => {
    while (!state.browserAbort && cursor < total) {
      const start = cursor; cursor += chunk;
      const { names } = await fetch(`/api/targets?start=${start}&n=${chunk}`).then(r => r.json()).catch(() => ({ names: [] }));
      if (!names || !names.length) { if (cursor >= total) return; continue; }
      let results;
      if (cfg.platform === 'discord') {
        results = [];
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
        results = r.results;
      }
      await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results }) }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, 6) }, worker));
  state.pumping = false;
  $('#stopBtn').disabled = true;
  $('#startBtn').disabled = false;
}

/* ------------------------------ HYDRA swarm ------------------------------ */
/* 6 Web Workers in this tab = 6 parallel checkers with live telemetry. */
const HYDRA_SRC = `
let sim = false, errStreak = 0, checked = 0, valid = 0, current = null, last = '—';
function fnv1a(str){let h=0x811c9dc5;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}
function demoCheck(platform,name,cs,len){
  const h=fnv1a(platform+'::'+name);
  let pct={gunslol:5.5,discord:4.0,instagram:1.6,tiktok:2.8}[platform]||5;
  pct*=(len===3?0.55:len===4?1:1.4); pct*=(cs==='C'?1.2:1);
  if(h%997===0) return {name,status:'error',note:'simulated network error',via:'sim'};
  if((h%1000)/10<pct) return {name,status:'available',via:'sim'};
  return {name,status:'taken',via:'sim'};
}
async function jfetch(u,o){const r=await fetch(u,o);return r;}
self.onmessage = async (e) => {
  const {cmd} = e.data;
  if (cmd !== 'run') return;
  const {origin, platform, mode, delay, workerId, total, chunkSize, remainder, cs, len} = e.data;
  sim = (mode === 'sim');
  let cursor = remainder * chunkSize;   // disjoint chunk streams per worker
  while (cursor < total) {
    let names = [];
    try {
      const r = await jfetch(origin + '/api/targets?start=' + cursor + '&n=' + chunkSize);
      names = (await r.json()).names || [];
    } catch (_) {}
    if (!names.length) break;
    let results = [];
    if (sim) {
      results = names.map(n => demoCheck(platform, n, cs, len));
      if (delay > 0) await new Promise(r2 => setTimeout(r2, delay));
    } else if (platform === 'discord') {
      results = [];
      for (const name of names) {
        current = name;
        try {
          const r = await jfetch('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
            method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({username: name}),
          });
          if (r.status === 400) results.push({name, status:'invalid', via:'pomelo-hydra'});
          else if (!r.ok) results.push({name, status:'error', note:'http '+r.status});
          else { const jj = await r.json(); results.push({name, status: jj.taken ? 'taken':'available', via:'pomelo-hydra'}); }
        } catch (_) { results.push({name, status:'error', note:'blocked'}); }
        if (delay > 0) await new Promise(r2 => setTimeout(r2, delay));
      }
    } else {
      try {
        const r = await jfetch(origin + '/api/proxy', {
          method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({platform, names}),
        });
        results = (await r.json()).results || [];
      } catch (_) { results = names.map(n => ({name:n, status:'error', note:'proxy failed'})); }
    }
    // auto-degrade: host has no egress -> switch this worker to simulation
    if (!sim) {
      const errs = results.filter(x => x.status === 'error').length;
      errStreak = errs === results.length ? errStreak + errs : 0;
      if (errStreak >= 8) { sim = true; errStreak = 0; }
    }
    checked += results.length;
    valid += results.filter(x => x.status === 'available').length;
    last = results.length ? results[results.length-1].status : '—';
    current = names[names.length-1];
    postMessage({type:'batch', workerId, results, tele:{current, checked, valid, last, sim}});
    cursor += chunkSize;
  }
  postMessage({type:'done', workerId, tele:{current:null, checked, valid, last:'exited', sim}});
};
`;

function startHydra(cfg, total) {
  if (state.hydraRunning) return;
  state.hydraRunning = true;
  const blob = new Blob([HYDRA_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const chunkSize = 6;
  const cs = cfg.target.kind === 'pattern' ? cfg.target.charset : 'C';
  const len = cfg.target.kind === 'pattern' ? cfg.target.len : 4;
  const mode = cfg.engine === 'demo' ? 'sim' : 'live';
  let active = N_BROWSERS;

  for (let w = 1; w <= N_BROWSERS; w++) {
    const worker = new Worker(url);
    state.cams[w] = { current: null, checked: 0, valid: 0, last: 'booting…', sim: false };
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
        if (--active <= 0) {
          state.hydraRunning = false;
          URL.revokeObjectURL(url);
          $('#stopBtn').disabled = true;
          $('#startBtn').disabled = false;
        }
      }
    };
    worker.postMessage({
      cmd: 'run', origin: location.origin, platform: cfg.platform, mode,
      delay: cfg.delay, workerId: w, total, chunkSize,
      remainder: (w - 1) % N_BROWSERS, cs, len,
    });
  }
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
      <div class="cam-feed" id="camfeed${i}"></div>
      <div class="cam-sim" id="camsim${i}" hidden>SIM — no egress, demo math</div>`;
    wrap.appendChild(pane);
  }
}

function renderCamPane(i) {
  const t = state.cams[i];
  if (!t) return;
  const set = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
  set(`#camname${i}`, t.current || '—');
  set(`#cammeta${i}`, `checked ${fmt(t.checked)} · valid ${fmt(t.valid)} · last ${t.last}`);
  set(`#camstat${i}`, t.current ? (t.sim ? 'sniping (sim)' : 'sniping…') : (t.last === 'exited' ? 'done' : 'idle'));
  const simEl = $(`#camsim${i}`); if (simEl) simEl.hidden = !t.sim;
  const pane = $(`#cam${i}`);
  if (pane) pane.classList.toggle('live', !!t.current);
}

function renderServerCams(meta) {
  if (!meta || !meta.workers) return;
  for (const w of meta.workers) {
    state.cams[w.id] = {
      current: w.current, checked: w.checked, valid: w.valid,
      last: w.last, sim: false,
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
    body: JSON.stringify({ platform: state.platform, engine: $('#engine').value === 'swarm' ? 'server' : $('#engine').value, name }),
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
    for (let i = 1; i <= N_BROWSERS; i++) { state.cams[i] = { current: null, checked: 0, valid: 0, last: '—', sim: false }; renderCamPane(i); const img = $(`#camimg${i}`); if (img) { img.hidden = true; img.removeAttribute('src'); } }
  }
  $('#runDesc').textContent = `${r.platform} · ${r.engine} engine · ${r.targetDesc}`;
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

  // cam wall source of truth
  if (snap.swarm && snap.swarm.meta) {
    if ($('#camMode').textContent.indexOf('LIVE VIDEO') === -1) $('#camMode').textContent = '· 6× headless Chrome on host — LIVE VIDEO';
    renderServerCams(snap.swarm.meta);
  } else if (state.hydraRunning || Object.values(state.cams).some(c => c.checked)) {
    if ($('#camMode').textContent === '· idle') $('#camMode').textContent = '· HYDRA — 6 workers in your browser';
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
    if (r.status === 'error') set('● host: outbound blocked → Demo / HYDRA in your browser', 'var(--amber)');
    else set('● host: outbound OK (probe: discord ' + r.status + ')', 'var(--green)');
  } catch (_) {
    set('● server unreachable', 'var(--red)');
  }
  // playwright present on host?
  try {
    const s = await fetch('/api/swarm').then(x => x.json());
    if (!s.available) badge.title = 'swarm: Playwright not installed on host → HYDRA fallback (6 workers in your browser)';
    else badge.title = 'swarm: Playwright detected — 6 real headless Chromes ready';
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
  for (let i = 1; i <= N_BROWSERS; i++) state.cams[i] = { current: null, checked: 0, valid: 0, last: '—', sim: false };
  syncPatternUI();
  updateEngineNote();
  poll();
})();
