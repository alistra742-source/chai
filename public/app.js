'use strict';
/*
 * SNIPR dashboard — talks to the local server, renders the flow, the snipes and
 * the six live cams. No frameworks, no build step: the server is the source of
 * truth and this file only draws what /api/state reports.
 */

const $ = id => document.getElementById(id);
const ICONS = { discord: '🎮', gunslol: '🔫' };

const ui = {
  platform: 'discord',
  pattern: '4C',
  patterns: [],
  flows: [],
  lastSnipesKey: '',
  firstState: true,
};

const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const clock = t => new Date(t).toLocaleTimeString('en-US', { hour12: false });

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function flow() {
  return ui.flows.find(f => f.id === ui.platform) || ui.flows[0] || { id: 'discord', label: 'Discord', site: 'https://usersniper.com', siteLabel: 'usersniper.com' };
}

/* ------------------------------- build ---------------------------------- */

function buildPlatforms() {
  const box = $('platforms');
  box.innerHTML = '';
  for (const f of ui.flows) {
    const b = el('button', 'platform');
    b.type = 'button';
    b.dataset.id = f.id;
    b.style.setProperty('--accent', f.accent || '#c9ff3d');
    b.setAttribute('aria-pressed', String(f.id === ui.platform));
    b.appendChild(el('span', 'ic', ICONS[f.id] || '◎'));
    b.appendChild(el('span', 'nm', f.label));
    b.appendChild(el('span', 'sub', `${f.siteLabel} · ${f.sniperTab || ''}`));
    b.addEventListener('click', () => selectPlatform(f.id));
    box.appendChild(b);
  }
}

function buildPatterns() {
  const box = $('patterns');
  box.innerHTML = '';
  for (const p of ui.patterns) {
    const b = el('button', 'pat');
    b.type = 'button';
    b.dataset.id = p.id;
    b.setAttribute('aria-pressed', String(p.id === ui.pattern));
    b.appendChild(el('b', null, p.id));
    b.appendChild(el('i', null, `${p.label} · ${fmt(p.total)}`));
    b.addEventListener('click', () => {
      ui.pattern = p.id;
      $('patternCustom').value = '';
      syncPattern();
    });
    box.appendChild(b);
  }
}

function syncPattern() {
  for (const b of document.querySelectorAll('.pat')) b.setAttribute('aria-pressed', String(b.dataset.id === ui.pattern));
  const p = ui.patterns.find(x => x.id === ui.pattern);
  $('patternNote').textContent = p
    ? `${p.id} = ${fmt(p.total)} possible names (${p.label}). SNIPR clicks this label on the site — the space math is only shown for context.`
    : `SNIPR will click “${ui.pattern}” on the site.`;
}

function selectPlatform(id) {
  ui.platform = id;
  for (const b of document.querySelectorAll('.platform')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
  const f = flow();
  $('platformNote').textContent = `${f.label}: Names tab → pattern → Randomize → “${f.sniperTab}” tab → Start on ${f.site}`;
  $('heroSite').textContent = f.siteLabel;
  $('siteUrl').value = f.site;
  $('namesTab').value = '';
  $('sniperTab').value = '';
  $('probeOut').textContent = 'not probed yet';
  $('probeOut').className = 'muted small';
}

/* ------------------------------- render --------------------------------- */

function render(state) {
  const b = state.browser || {};
  const running = !!(state.run && state.run.running);

  const chipState = $('chipState');
  chipState.className = 'chip' + (running ? ' live' : '');
  chipState.querySelector('b').textContent = running ? 'sniping' : 'idle';

  const chipBrowser = $('chipBrowser');
  if (b.browser) {
    chipBrowser.textContent = `browser: ${b.browser}${b.headless ? ' (headless)' : ''}`;
    chipBrowser.className = 'chip';
  } else {
    chipBrowser.textContent = 'browser: none found';
    chipBrowser.className = 'chip bad';
  }

  const acc = state.login || {};
  const chipAccount = $('chipAccount');
  const stored = acc[ui.platform] || acc.env;
  chipAccount.textContent = stored ? 'account: stored (memory)' : 'account: none';
  chipAccount.className = 'chip' + (stored ? ' live' : '');
  $('loginOut').textContent = stored ? 'stored for this process — never written to disk' : 'nothing stored yet';

  /* browser missing is a hard stop, said out loud */
  if (!b.browser) {
    $('runError').hidden = false;
    $('runError').textContent = b.error || 'no real browser available on this machine';
    $('startBtn').disabled = true;
  } else if (!running) {
    $('runError').hidden = true;
    $('startBtn').disabled = false;
  }
  $('startBtn').disabled = running || !b.browser;
  $('stopBtn').disabled = !running;

  renderFlow(state);
  renderSnipes(state);
  renderFound(state);
  renderTap(state);
  renderTiles(state);
  renderLog(state);
  renderCams(state);
}

function renderFlow(state) {
  const ol = $('timeline');
  const run = state.run;
  if (!run || !run.steps || !run.steps.length) {
    ol.innerHTML = '';
    ol.appendChild(el('li', 'muted small', 'press START SNIPING to walk the flow'));
    $('workers').innerHTML = '';
    $('workers').appendChild(el('p', 'muted empty', 'no browsers started yet'));
    return;
  }
  ol.innerHTML = '';
  run.steps.forEach((s, i) => {
    const li = el('li', s.done >= (run.browsers || 1) ? 'done' : '');
    li.appendChild(el('span', 'idx', String(i + 1).padStart(2, '0')));
    li.appendChild(el('span', null, s.label));
    li.appendChild(el('span', 'bar', `${s.done}/${s.total}`));
    ol.appendChild(li);
  });

  const box = $('workers');
  box.innerHTML = '';
  const ws = run.workers || [];
  if (!ws.length) {
    box.appendChild(el('p', 'muted empty', 'no browsers started yet'));
    return;
  }
  ws.forEach((w, i) => {
    const row = el('div', 'worker');
    row.dataset.s = w.status || 'idle';
    row.appendChild(el('span', 'n', `br ${w.id || i + 1}`));
    row.appendChild(el('span', 'st', (w.step || 'idle') + (w.stepIndex >= 0 ? ` (${w.stepIndex + 1}/${w.stepCount})` : '')));
    const note = (w.notes && w.notes.length) ? w.notes[w.notes.length - 1].msg : 'waiting…';
    row.appendChild(el('span', 'note', note));
    box.appendChild(row);
  });
}

function renderSnipes(state) {
  const run = state.run;
  const list = (run && run.snipes) || [];
  $('snipedCount').textContent = fmt(list.length);
  $('snipedNote').textContent = list.length
    ? `newest first · the site's own words are kept next to each name`
    : '';
  const key = list.map(s => s.name).join(',');
  if (key === ui.lastSnipesKey) return;
  ui.lastSnipesKey = key;

  const box = $('sniped');
  box.innerHTML = '';
  if (!list.length) {
    box.appendChild(el('p', 'muted empty', 'nothing yet — the name the site reports as claimed lands here, with the exact line it came from'));
    return;
  }
  for (const s of list.slice().reverse()) {
    const row = el('div', 'snipe');
    row.appendChild(el('span', 'who', '@' + s.name));
    const why = el('span', 'why', `${s.via || 'site'}: ${s.why || ''}`);
    why.title = s.why || '';
    row.appendChild(why);
    const meta = el('span', 'meta');
    meta.appendChild(el('span', null, `br ${s.worker || '?'}`));
    meta.appendChild(el('br'));
    meta.appendChild(el('span', null, clock(s.at)));
    row.appendChild(meta);
    box.appendChild(row);
  }
}

function renderFound(state) {
  const run = state.run;
  const list = (run && run.found) || [];
  $('foundCount').textContent = fmt(list.length);
  const box = $('found');
  box.innerHTML = '';
  if (!list.length) {
    box.appendChild(el('p', 'muted empty', 'available names the site mentioned are listed here — kept apart from snipes, because “available” is not “sniped”'));
    return;
  }
  for (const f of list.slice().reverse().slice(0, 60)) {
    const item = el('div', 'item');
    const b = el('b', null, f.name);
    item.appendChild(b);
    item.appendChild(el('span', null, `  ${f.via || ''} · br ${f.worker || '?'} · ${clock(f.at)}`));
    box.appendChild(item);
  }
}

function renderTap(state) {
  const run = state.run;
  const list = (run && run.tap) || [];
  const box = $('tap');
  box.innerHTML = '';
  if (!list.length) {
    box.appendChild(el('p', 'muted empty', 'nothing yet'));
    return;
  }
  for (const t of list.slice().reverse()) {
    const item = el('div', 'item', `[${t.kind}] br${t.worker || '?'} ${t.text}`);
    item.title = t.text;
    box.appendChild(item);
  }
}

function renderTiles(state) {
  const run = state.run;
  const box = $('tiles');
  box.innerHTML = '';
  const p = ui.patterns.find(x => x.id === (run && run.pattern));
  const tiles = [
    ['sniped', run ? run.snipedCount : 0, true],
    ['browsers', run ? (run.workers || []).length : 0],
    ['pattern', run ? run.pattern : ui.pattern],
    ['names in space', p ? p.total : (ui.patterns.find(x => x.id === ui.pattern) || {}).total],
    ['site says available', run ? run.foundCount : 0],
    ['elapsed', run ? run.elapsedSec + 's' : '—'],
  ];
  for (const [label, value, hl] of tiles) {
    const t = el('div', 'tile' + (hl ? ' hl' : ''));
    t.appendChild(el('em', null, label));
    t.appendChild(el('b', null, typeof value === 'number' ? fmt(value) : String(value)));
    box.appendChild(t);
  }
}

function renderLog(state) {
  const run = state.run;
  const ol = $('stepsLog');
  ol.innerHTML = '';
  const lines = (run && run.steps_log) || [];
  if (!lines.length) {
    ol.appendChild(el('li', 'muted', 'no steps yet'));
    return;
  }
  for (const l of lines.slice(-60)) {
    const li = el('li', l.level || 'info');
    li.appendChild(el('time', null, clock(l.t)));
    li.appendChild(el('span', null, `${l.worker ? `br${l.worker} ` : ''}${l.msg}`));
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

/* ------------------------------ cam wall -------------------------------- */

const CAMS = 6;
function buildCams() {
  const box = $('cams');
  box.innerHTML = '';
  for (let i = 1; i <= CAMS; i++) {
    const cam = el('div', 'cam');
    cam.dataset.n = String(i);
    const head = el('div', 'head');
    head.appendChild(el('b', null, `browser ${i}`));
    const live = el('span', 'live off', '○ offline');
    head.appendChild(live);
    cam.appendChild(head);
    const frame = el('div', 'frame idle');
    const img = el('img');
    img.alt = `live cam of browser ${i}`;
    frame.appendChild(img);
    cam.appendChild(frame);
    cam.appendChild(el('div', 'foot', 'idle — no run yet'));
    box.appendChild(cam);
  }
}

function renderCams(state) {
  const run = state.run;
  const running = !!(run && run.running);
  const ws = (run && run.workers) || [];
  $('camMode').textContent = running ? `· ${ws.length} browsers live` : (run ? '· stopped' : '· idle');
  for (let i = 1; i <= CAMS; i++) {
    const cam = document.querySelector(`.cam[data-n="${i}"]`);
    if (!cam) continue;
    const w = ws[i - 1];
    const img = cam.querySelector('img');
    const live = cam.querySelector('.live');
    const frame = cam.querySelector('.frame');
    const foot = cam.querySelector('.foot');
    if (!w) {
      live.className = 'live off';
      live.textContent = '○ offline';
      frame.className = 'frame idle';
      img.removeAttribute('src');
      foot.textContent = 'idle — no run yet';
      continue;
    }
    const fresh = w.camAt && Date.now() - w.camAt < 5000;
    live.className = 'live' + (fresh ? '' : ' off');
    live.textContent = fresh ? '● live' : '○ no frame';
    frame.className = 'frame' + (fresh ? '' : ' idle');
    if (running || fresh) {
      const stamp = w.camAt || 0;
      if (img.dataset.stamp !== String(stamp)) {
        img.dataset.stamp = String(stamp);
        img.src = `/api/cam/${i}.jpg?t=${stamp}`;
      }
    }
    const note = (w.notes && w.notes.length) ? w.notes[w.notes.length - 1].msg : 'working…';
    foot.innerHTML = '';
    foot.appendChild(el('b', null, w.step || 'idle'));
    foot.appendChild(el('span', null, ` · ${note}`));
  }
}

/* -------------------------------- actions -------------------------------- */

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({}));
}

async function start() {
  const f = flow();
  $('runError').hidden = true;
  ui.lastSnipesKey = '\u0000force'; // next state render redraws the sniped list
  const out = await post('/api/start', {
    platform: ui.platform,
    pattern: ui.pattern,
    browsers: Number($('browsers').value) || 6,
    headful: $('headful').checked,
    site: $('siteUrl').value.trim() || f.site,
    namesTab: $('namesTab').value.trim(),
    sniperTab: $('sniperTab').value.trim(),
  });
  if (!out.ok) {
    $('runError').hidden = false;
    $('runError').textContent = out.error || 'could not start the run';
    return;
  }
  $('startHint').textContent = out.note || '';
}

async function stop() {
  await post('/api/stop');
  $('startHint').textContent = 'stopping — browsers are being closed';
}

async function storeLogin() {
  const out = await post('/api/login', {
    platform: ui.platform,
    email: $('loginEmail').value.trim(),
    password: $('loginPassword').value,
  });
  const box = $('loginOut');
  if (out.ok) {
    $('loginPassword').value = '';
    box.className = 'muted small';
    box.textContent = 'stored for this process — sign-in happens in the browsers';
  } else {
    box.className = 'small';
    box.style.color = 'var(--danger)';
    box.textContent = out.error || 'could not store that';
  }
}

async function verifyBrowser() {
  const box = $('verifyOut');
  box.className = 'muted small';
  box.textContent = 'launching a real browser…';
  const out = await post('/api/verify', { headful: $('headful').checked });
  if (out.ok) {
    box.textContent = `${out.browser} really launched and closed in ${out.ms} ms — this machine can run the run`;
    box.className = 'small';
    box.style.color = 'var(--acid)';
  } else {
    box.textContent = out.error || 'could not launch a browser';
    box.className = 'small';
    box.style.color = 'var(--danger)';
  }
}

async function probe() {
  const f = flow();
  const box = $('probeOut');
  box.className = 'muted small';
  box.textContent = 'probing…';
  const url = $('siteUrl').value.trim() || f.site;
  const out = await post('/api/probe', { platform: ui.platform, site: url });
  const chip = $('chipSite');
  chip.textContent = `site: HTTP ${out.status || '—'}${out.cloudflare ? ' cf' : ''}`;
  chip.className = 'chip' + (out.ok ? '' : ' bad');
  box.textContent = out.note || out.error || 'no answer';
  box.className = 'muted small';
}

async function copySnipes() {
  const state = await (await fetch('/api/state')).json();
  const names = ((state.run && state.run.snipes) || []).map(s => s.name);
  const text = names.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('snipedNote').textContent = `copied ${names.length} name${names.length === 1 ? '' : 's'}`;
  } catch (_) {
    $('snipedNote').textContent = text ? text : 'nothing to copy';
  }
}

/* --------------------------------- boot --------------------------------- */

async function poll() {
  let state;
  try {
    state = await (await fetch('/api/state')).json();
  } catch (_) {
    return;
  }
  if (state.flows && state.flows.length && (!ui.flows.length || ui.firstState)) {
    ui.flows = state.flows;
    buildPlatforms();
  }
  if (state.patterns && state.patterns.length && !ui.patterns.length) {
    ui.patterns = state.patterns;
    ui.pattern = ui.patterns.find(p => p.id === '4C') ? '4C' : ui.patterns[0].id;
    buildPatterns();
    syncPattern();
  }
  if (ui.firstState) {
    selectPlatform(ui.platform);
    ui.firstState = false;
  }
  render(state);
}

function wire() {
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', stop);
  $('loginBtn').addEventListener('click', storeLogin);
  $('probeBtn').addEventListener('click', probe);
  $('verifyBtn').addEventListener('click', verifyBrowser);
  $('copySnipes').addEventListener('click', copySnipes);
  $('browsers').addEventListener('input', e => { $('browsersVal').textContent = e.target.value; });
  $('patternCustom').addEventListener('input', e => {
    const v = e.target.value.trim().toUpperCase();
    if (v) { ui.pattern = v; syncPattern(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
  });
}

buildCams();
wire();
poll();
setInterval(poll, 1200);
