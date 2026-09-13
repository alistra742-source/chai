'use strict';
/*
 * SNIPR — multi-platform username sniper (guns.lol / Discord / Instagram / TikTok)
 * Zero-dependency Node server (Node 18+, uses built-in fetch).
 *
 *   node server.js            # PORT=3000 by default, binds 0.0.0.0
 *
 * Engines (all real, no simulation):
 *   server  – real checks from this machine (copied GitHub-tool logic)
 *   browser – real checks from YOUR browser (Discord direct via CORS,
 *             others proxied through /api/proxy)
 *   swarm   – SIX real headless browsers in parallel with live screenshot
 *             cams (uses the Chrome/Edge already installed on the host, or
 *             playwright's chromium; if no real browser exists the run falls
 *             back to HYDRA — 6 real checkers inside the user's browser)
 *
 * Every engine can run through the rotating proxy layer (lib/proxy.js):
 * Tor circuits (per-request SOCKS5 isolation +SIGNAL NEWNYM) or a round-robin
 * proxy list. See GET/POST /api/net and POST /api/net/test.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { liveCheck } = require('./lib/checkers');
const { Swarm, bind, detectPlaywright, detectBrowser, swarm } = require('./lib/swarm');
const proxyPool = require('./lib/proxy');
const { exitCheck } = require('./lib/http');
const {
  describeTarget, totalFor, nameAt, makeOrder, PATTERN_PRESETS, mulberry32,
} = require('./lib/generator');

// let the swarm module use the run cursor + recorder without circular imports
bind(nameAt, (run, name, res) => record(run, name, res));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESULTS_DIR = path.join(__dirname, 'results');
const MAX_CONCURRENCY = 24;
const FEED_CAP = 400;        // recent rows kept for the UI feed
const AVAILABLE_CAP = 20000; // in-memory list of hits (count keeps going)
const COUNTED_CAP = 400000;  // names tracked for exact de-duplication

const PLATFORMS = {
  gunslol: { id: 'gunslol', label: 'guns.lol', url: (u) => `https://guns.lol/${u}`, accent: '#ff2e4d' },
  discord: { id: 'discord', label: 'Discord', url: () => 'https://discord.com', accent: '#5865F2' },
  instagram: { id: 'instagram', label: 'Instagram', url: (u) => `https://instagram.com/${u}`, accent: '#e1306c' },
  tiktok: { id: 'tiktok', label: 'TikTok', url: (u) => `https://tiktok.com/@${u}`, accent: '#25f4ee' },
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });

/* ------------------------------ run state -------------------------------- */
let run = null;       // the single active (or last) run
let runSeq = 0;

function newRun(cfg) {
  const total = totalFor(cfg.target);
  const seed = (Math.random() * 0xffffffff) >>> 0;
  return {
    id: ++runSeq,
    platform: cfg.platform,
    engine: cfg.engine,
    target: cfg.target,
    targetDesc: describeTarget(cfg.target),
    order: makeOrder(cfg.target, cfg.shuffle, seed),
    concurrency: cfg.concurrency,
    delay: cfg.delay,
    total,
    cursor: 0,       // names handed out to browser workers so far (disjoint)
    counted: new Set(), // every name already recorded — nothing counts twice
    checked: 0,
    available: [],   // names (capped at AVAILABLE_CAP)
    availableCount: 0,
    takenCount: 0,
    invalidCount: 0,
    premiumCount: 0,
    errorCount: 0,
    feed: [],        // recent rows, newest last
    startedAt: null,
    finishedAt: null,
    running: false,
    abort: false,
    error: null,     // why a run died (e.g. swarm launch failure) — shown in the UI
    rateWindow: [],  // {t, n} for rolling rate
    lastErrors: [],
  };
}

function record(state, name, res) {
  // De-duplicate: a name can only ever count once per run, so "checked" stays
  // exact even if several browser workers overlap.
  if (state.counted.has(name)) return;
  if (state.counted.size < COUNTED_CAP) state.counted.add(name);
  state.checked++;
  const now = Date.now();
  state.rateWindow.push({ t: now, n: 1 });
  if (state.rateWindow.length > 4096) state.rateWindow.splice(0, 2048);

  if (res.status === 'available') {
    state.availableCount++;
    if (state.available.length < AVAILABLE_CAP) state.available.push(name);
  } else if (res.status === 'taken') state.takenCount++;
  else if (res.status === 'invalid') state.invalidCount++;
  else if (res.status === 'premium') state.premiumCount++;
  else state.errorCount++;

  state.feed.push({ seq: state.checked, name, status: res.status, via: res.via, note: res.note, t: now });
  if (state.feed.length > FEED_CAP) state.feed.splice(0, state.feed.length - FEED_CAP);

  if (res.status === 'error' && state.lastErrors.length < 20) {
    state.lastErrors.push(`${name}: ${res.note || 'error'}`);
  }

  // persist hits
  if (res.status === 'available') {
    const tag = `${state.platform}_${state.target.kind === 'pattern' ? state.target.len + state.target.charset : state.target.kind}`;
    fs.appendFile(path.join(RESULTS_DIR, `hits_${tag}.txt`), name + '\n', () => {});
  }
}

function ratePerMin(state) {
  const now = Date.now();
  const recent = state.rateWindow.filter(p => now - p.t < 15000);
  if (recent.length < 2) return 0;
  const span = Math.max(1, now - recent[0].t);
  return Math.round((recent.length / span) * 60000);
}

function stateSnapshot(state) {
  if (!state) {
    return { run: null, swarm: { available: !!detectPlaywright(), browser: detectBrowser(), error: null, mode: null, meta: null }, platforms: platformMeta(), presets: PATTERN_PRESETS, proxy: proxyPool.status() };
  }
  const checked = state.checked;
  const rate = state.running ? ratePerMin(state) : 0;
  const remaining = Math.max(0, state.total - checked);
  return {
    swarm: {
      available: !!detectPlaywright(),
      browser: detectBrowser(),   // e.g. "Google Chrome", null when none found
      error: run.error || swarm.lastError || null,
      mode: state.engine === 'swarm' ? (swarm.running ? 'playwright' : (detectBrowser() ? 'playwright' : 'hydra')) : null,
      meta: swarm.running ? swarm.meta() : null,
    },
    run: {
      id: state.id,
      platform: state.platform,
      engine: state.engine,
      targetDesc: state.targetDesc,
      total: state.total,
      checked,
      handedOut: state.cursor,
      availableCount: state.availableCount,
      takenCount: state.takenCount,
      invalidCount: state.invalidCount,
      premiumCount: state.premiumCount,
      errorCount: state.errorCount,
      remaining,
      running: state.running,
      error: state.error,
      ratePerMin: rate,
      etaSec: rate > 0 ? Math.round((remaining / rate) * 60) : (state.running && state.total ? null : 0),
      elapsedSec: state.startedAt ? Math.round(((state.finishedAt || Date.now()) - state.startedAt) / 1000) : 0,
      feed: state.feed.slice(-120),
      available: state.available.slice(-2000),
      lastErrors: state.lastErrors.slice(10),
      concurrency: state.concurrency,
      delay: state.delay,
    },
    platforms: platformMeta(),
    presets: PATTERN_PRESETS,
    proxy: proxyPool.status(),
  };
}

function platformMeta() {
  const out = {};
  for (const k of Object.keys(PLATFORMS)) out[k] = { id: k, label: PLATFORMS[k].label, accent: PLATFORMS[k].accent };
  return out;
}

/* ------------------------------ engines ---------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runServerEngine(state) {
  state.running = true;
  state.startedAt = Date.now();
  const cursor = { i: 0 };
  const nworkers = Math.max(1, Math.min(MAX_CONCURRENCY, state.concurrency || 5));

  const worker = async () => {
    while (!state.abort) {
      const i = cursor.i++;
      if (i >= state.total) return;
      const name = nameAt(state.target, state.order, i);
      let res;
      try {
        res = await liveCheck(state.platform, name);
      } catch (e) {
        res = { status: 'error', http: 0, via: 'exception', note: String(e.message || e).slice(0, 140) };
      }
      record(state, name, res);
      if (state.delay > 0) {
        const jitter = state.delay * (0.7 + Math.random() * 0.6);
        await sleep(jitter);
      }
    }
  };

  await Promise.all(Array.from({ length: nworkers }, worker));
  state.running = false;
  state.finishedAt = Date.now();
}

/* ------------------------------ http utils ------------------------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^([.][.][/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

/* ------------------------------ server ----------------------------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return json(res, 200, stateSnapshot(run));
    }
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, stateSnapshot(run));
    }

    if (req.method === 'POST' && p === '/api/start') {
      const body = await readBody(req);
      const platform = String(body.platform || '');
      const engine = String(body.engine || 'server');
      if (!PLATFORMS[platform]) return json(res, 400, { ok: false, error: 'unknown platform' });
      if (!['server', 'browser', 'swarm'].includes(engine)) return json(res, 400, { ok: false, error: 'bad engine' });
      if (run && run.running && !run.abort) return json(res, 409, { ok: false, error: 'a run is already active — stop it first' });

      let target;
      if (body.target && body.target.kind === 'pattern') {
        const len = Math.max(1, Math.min(6, Number(body.target.len) || 0));
        const charset = ['L', 'C', 'D'].includes(body.target.charset) ? body.target.charset : 'L';
        target = { kind: 'pattern', len, charset };
      } else if (body.target && body.target.kind === 'list') {
        const names = [...new Set(String(body.target.names || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
        if (!names.length) return json(res, 400, { ok: false, error: 'empty list' });
        if (names.length > 200000) return json(res, 400, { ok: false, error: 'list too large (max 200k)' });
        target = { kind: 'list', names };
      } else if (body.target && body.target.kind === 'single') {
        const name = String(body.target.name || '').trim().toLowerCase();
        if (!name) return json(res, 400, { ok: false, error: 'empty name' });
        target = { kind: 'single', name };
      } else {
        return json(res, 400, { ok: false, error: 'missing target' });
      }

      run = newRun({
        platform, engine, target,
        concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number(body.concurrency) || 5)),
        delay: Math.max(0, Math.min(10000, Number(body.delay) || 0)),
        shuffle: body.shuffle !== false,
      });

      let swarmMode = null;
      let note = null;
      if (engine === 'server') {
        runServerEngine(run).catch(e => {
          run.error = 'server engine crashed: ' + String(e.message || e).slice(0, 180);
          run.running = false;
          console.error('[SNIPR] server engine crashed:', e);
        });
      } else if (engine === 'swarm' && detectBrowser()) {
        swarmMode = 'playwright';
        note = 'swarming with ' + detectBrowser();
        swarm.start(run, 6).catch(e => {
          console.error('[SNIPR] swarm crashed:', e);
          run.error = 'swarm crashed: ' + String(e.message || e).slice(0, 180);
          run.running = false;
          run.finishedAt = Date.now();
        });
      } else {
        // browser engine, or swarm with no real browser on the host -> HYDRA:
        // 6 workers inside the user's browser doing REAL checks.
        if (engine === 'swarm') {
          swarmMode = 'hydra';
          note = detectPlaywright()
            ? 'no Chrome/Edge found on host — running 6 workers in your browser'
            : 'playwright not installed on host — running 6 workers in your browser';
        }
        run.running = true;
        run.startedAt = Date.now();
      }
      return json(res, 200, {
        ok: true, runId: run.id, total: run.total, orderSeed: run.order,
        swarmMode, note, browser: detectBrowser(), proxy: proxyPool.describe(),
      });
    }

    if (req.method === 'POST' && p === '/api/stop') {
      if (run) { run.abort = true; }
      swarm.stop().catch(() => {});
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/check') { // single ad-hoc check
      const body = await readBody(req);
      const name = String(body.name || '').trim().toLowerCase();
      const platform = String(body.platform || '');
      if (!name || !PLATFORMS[platform]) return json(res, 400, { ok: false, error: 'bad request' });
      let out;
      try {
        out = { name, ...(await liveCheck(platform, name)) };
      } catch (e) {
        out = { name, status: 'error', note: String(e.message || e).slice(0, 140) };
      }
      return json(res, 200, out);
    }

    if (req.method === 'POST' && p === '/api/proxy') { // hydra/browser engine: server-side batch check
      const body = await readBody(req);
      const platform = String(body.platform || '');
      const names = Array.isArray(body.names) ? body.names.slice(0, 60).map(s => String(s).toLowerCase()) : [];
      if (!PLATFORMS[platform] || !names.length) return json(res, 400, { ok: false, error: 'bad request' });
      const out = [];
      for (const name of names) {
        try { const r = await liveCheck(platform, name); out.push({ name, status: r.status, via: r.via, note: r.note }); }
        catch (e) { out.push({ name, status: 'error', note: String(e.message || e).slice(0, 140) }); }
      }
      return json(res, 200, { results: out });
    }

    if (req.method === 'POST' && p === '/api/report') { // browser/hydra workers report results
      const body = await readBody(req);
      if (run && (run.engine === 'browser' || run.engine === 'swarm') && !run.abort && Array.isArray(body.results)) {
        for (const r of body.results.slice(0, 200)) {
          record(run, String(r.name || '').toLowerCase(), { status: r.status, via: r.via, note: r.note });
        }
        if (run.checked >= run.total) { run.running = false; run.finishedAt = Date.now(); }
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/targets') {
      // browser/hydra workers pull the next chunk. The SERVER owns the cursor,
      // so every name is handed out exactly once — no duplicate work, no early
      // "finish" caused by the same name being reported by several workers.
      if (!run || (run.engine !== 'browser' && run.engine !== 'swarm')) return json(res, 400, { ok: false, error: 'no active browser run' });
      const n = Math.max(1, Math.min(60, Number(u.searchParams.get('n')) || 25));
      const start = run.cursor;
      const names = [];
      while (names.length < n && run.cursor < run.total) {
        names.push(nameAt(run.target, run.order, run.cursor++));
      }
      return json(res, 200, { names, start, next: run.cursor, total: run.total, done: run.cursor >= run.total });
    }

    if (req.method === 'GET' && p === '/api/swarm') {
      return json(res, 200, {
        available: !!detectPlaywright(),
        browser: detectBrowser(),
        error: swarm.lastError || null,
        mode: swarm.running ? 'playwright' : 'idle',
        meta: swarm.running ? swarm.meta() : null,
      });
    }

    if (req.method === 'GET' && /^\/api\/cam\/([1-6])\.jpg$/.test(p)) {
      const n = Number(p.match(/^\/api\/cam\/([1-6])\.jpg$/)[1]);
      const buf = swarm.camOf(n);
      if (!buf) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      return res.end(buf);
    }

    if (req.method === 'GET' && p === '/api/hits.txt') {
      const lines = run ? run.available : [];
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="snipr_hits_${run ? run.platform : 'none'}.txt"`,
      });
      return res.end(lines.join('\n'));
    }

    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

    // --- rotating proxy layer (Tor circuits / proxy list) -------------------
    if (req.method === 'GET' && p === '/api/net') {
      return json(res, 200, { ok: true, proxy: proxyPool.status() });
    }

    if (req.method === 'POST' && p === '/api/net') {
      const body = await readBody(req);
      try {
        const proxy = proxyPool.setConfig(body);
        return json(res, 200, { ok: true, proxy });
      } catch (e) {
        return json(res, 400, { ok: false, error: String(e.message || e), proxy: proxyPool.status() });
      }
    }

    if (req.method === 'POST' && p === '/api/net/test') {
      // proves the current config end to end: one real request through the
      // proxy to check.torproject.org, which answers with the exit IP
      try {
        const out = await exitCheck(20000);
        return json(res, 200, { ok: !!out.ok, ...out, proxy: proxyPool.status() });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e).slice(0, 200), proxy: proxyPool.status() });
      }
    }


    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[SNIPR] listening on http://${HOST}:${PORT}`);
  const pw = detectPlaywright();
  const browser = detectBrowser();
  console.log(`[SNIPR] engines: server | browser | swarm — real checks only (no demo)`);
  console.log(`[SNIPR] playwright: ${pw ? 'yes' : 'no'} · real browser: ${browser || 'none found (swarm falls back to 6 in-browser workers)'}`);
  const proxy = proxyPool.initFromEnv();
  console.log(`[SNIPR] proxy: ${proxy.label}`);
});
