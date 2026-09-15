'use strict';
/*
 * SNIPR — real-browser sniper console.
 *
 *   node server.js          # PORT=3000 by default, binds 0.0.0.0
 *
 * One job, done for real: open SIX real Chromium browsers on the sniper site
 * (usersniper.com) and walk the flow —
 *
 *   Names tab -> 4C -> wait for the names -> Randomize -> <platform> Sniper
 *   tab -> Start -> report the name the SITE says it sniped
 *
 * Every browser is a real browser with a live screenshot on the dashboard, and
 * the only names the dashboard shows as "sniped" are the ones the site itself
 * reported (its own fetch/XHR/WebSocket traffic, or the text it rendered).
 * There is no demo mode and no simulated result anywhere in this code.
 *
 * It expects an account you already have: paste your login in the UI (kept in
 * memory only) or set USERSNIPER_EMAIL / USERSNIPER_PASSWORD. It never creates
 * an account for you.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  siteSniper, FLOWS, PATTERNS, browserReport, verifyBrowser, analyzeSiteText,
} = require('./lib/siteflow');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESULTS_DIR = path.join(__dirname, 'results');

fs.mkdirSync(RESULTS_DIR, { recursive: true });

let run = null;
let runSeq = 0;

function newRun(cfg) {
  return {
    id: ++runSeq,
    platform: cfg.platform,
    pattern: cfg.pattern,
    browsers: cfg.browsers,
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    abort: false,
    error: null,
    snipes: [],
    found: [],
    foundNames: new Set(),
    tap: [],
    steps: [],
    steps_log: [],
    flow: null,
  };
}

function publicFlow(flow) {
  return {
    id: flow.id,
    label: flow.label,
    accent: flow.accent,
    site: flow.site,
    siteLabel: flow.siteLabel,
    namesTab: flow.namesTab[0],
    sniperTab: flow.sniperTab[0],
  };
}

function snapshot() {
  const browser = browserReport();
  const base = {
    ok: true,
    now: Date.now(),
    browser,
    login: siteSniper.loginState(),
    flows: Object.values(FLOWS).map(publicFlow),
    patterns: PATTERNS,
    run: null,
  };
  if (!run) return base;
  const elapsedSec = run.startedAt ? Math.round(((run.finishedAt || Date.now()) - run.startedAt) / 1000) : 0;
  base.run = {
    id: run.id,
    platform: run.platform,
    pattern: run.pattern,
    browsers: run.browsers,
    running: run.running && !run.abort,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    elapsedSec,
    flow: run.flow,
    steps: run.steps,
    steps_log: run.steps_log.slice(-80),
    snipes: run.snipes.slice(-200),
    snipedCount: run.snipes.length,
    found: run.found.slice(-60),
    foundCount: run.found.length,
    tap: run.tap.slice(-40),
    workers: siteSniper.meta().workers,
    workerError: siteSniper.meta().error,
  };
  return base;
}

/* ------------------------------- http utils ------------------------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
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

/* Can this machine reach the sniper site at all? (The browsers do the real work;
 * this only explains a blank screen and tells you when Cloudflare is refusing
 * the server — which is normal and not what the real browsers see.) */
async function probeSite(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20000),
    });
    const server = res.headers.get('server') || '';
    const cf = /cloudflare/i.test(server) || !!res.headers.get('cf-ray');
    return {
      ok: res.ok,
      status: res.status,
      server,
      cloudflare: cf,
      ms: Date.now() - started,
      note: res.ok
        ? `${url} answers HTTP ${res.status}${cf ? ' (Cloudflare)' : ''} — a real browser passes it`
        : `${url} answers HTTP ${res.status}${cf ? ' (Cloudflare)' : ''} to this server; the real browsers in the flow may still get through`,
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(e.message || e).slice(0, 200), note: `this server cannot reach ${url} (${String(e.message || e).slice(0, 120)})` };
  }
}

/* --------------------------------- server -------------------------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/api/state' || p === '/api/meta')) return json(res, 200, snapshot());
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

    if (req.method === 'POST' && p === '/api/start') {
      const body = await readBody(req);
      const platform = String(body.platform || 'discord');
      const flow = FLOWS[platform];
      if (!flow) return json(res, 400, { ok: false, error: 'unknown platform — pick discord or gunslol' });
      if (run && run.running && !run.abort) return json(res, 409, { ok: false, error: 'a run is already going — press Stop first' });

      const browsers = Math.max(1, Math.min(6, Number(body.browsers) || 6));
      const cfg = {
        platform,
        pattern: String(body.pattern || '4C').trim().toUpperCase().slice(0, 12),
        browsers,
        flow: platform,
        site: String(body.site || flow.site).trim(),
        namesTab: String(body.namesTab || '').trim() || null,
        sniperTab: String(body.sniperTab || '').trim() || null,
        headful: !!body.headful,
      };

      const rep = browserReport();
      if (!rep.browser) return json(res, 400, { ok: false, error: rep.error, browser: rep });

      run = newRun(cfg);
      siteSniper.start(run, cfg).then(() => {
        if (run) { run.running = false; run.finishedAt = run.finishedAt || Date.now(); }
      }).catch(e => {
        if (run) {
          run.error = String(e.message || e).slice(0, 240);
          run.running = false;
          run.finishedAt = Date.now();
        }
      });

      return json(res, 200, {
        ok: true,
        runId: run.id,
        browser: rep.browser,
        browsers,
        flow: publicFlow(flow),
        pattern: cfg.pattern,
        total: (PATTERNS.find(x => x.id === cfg.pattern) || {}).total || null,
        note: `${rep.browser} x${browsers} — walking the ${flow.label} flow on ${cfg.site}`,
      });
    }

    if (req.method === 'POST' && p === '/api/stop') {
      if (run) { run.abort = true; run.running = false; run.finishedAt = Date.now(); }
      await siteSniper.stop();
      return json(res, 200, { ok: true });
    }

    /* Your account, your credentials: held in memory for this process only,
     * never written to disk, never sent anywhere except the login form of the
     * site you pointed it at. */
    if (req.method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const platform = String(body.platform || 'discord');
      if (!FLOWS[platform]) return json(res, 400, { ok: false, error: 'unknown platform' });
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!email || !password) return json(res, 400, { ok: false, error: 'email and password are both required' });
      siteSniper.setCreds(platform, email, password);
      return json(res, 200, { ok: true, login: siteSniper.loginState() });
    }

    /* Actually launches a browser and closes it again — the only honest way to
     * answer "can this machine run the six browsers?". */
    if (req.method === 'POST' && p === '/api/verify') {
      const body = await readBody(req);
      const out = await verifyBrowser({ headless: !body.headful && !process.env.SNIPR_HEADFUL });
      return json(res, 200, out);
    }

    if (req.method === 'POST' && p === '/api/probe') {
      const body = await readBody(req);
      const flow = FLOWS[String(body.platform || 'discord')];
      const url = String(body.site || (flow ? flow.site : '')).trim();
      if (!/^https?:\/\//.test(url)) return json(res, 400, { ok: false, error: 'need an http(s) url' });
      return json(res, 200, await probeSite(url));
    }

    if (req.method === 'GET' && /^\/api\/cam\/[1-6]\.jpg$/.test(p)) {
      const n = Number(p.match(/\/api\/cam\/([1-6])\.jpg$/)[1]);
      const buf = siteSniper.camOf(n);
      if (!buf) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      return res.end(buf);
    }

    if (req.method === 'GET' && p === '/api/snipes.txt') {
      const lines = run ? run.snipes.map(s => `@${s.name}\t${new Date(s.at).toISOString()}\t${s.via}`) : [];
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="snipr_sniped.txt"',
      });
      return res.end(lines.join('\n'));
    }

    // A pasted message can be pasted back in to see how it would be read.
    if (req.method === 'POST' && p === '/api/parse') {
      const body = await readBody(req);
      const out = analyzeSiteText(String(body.text || ''));
      return json(res, 200, { ok: true, ...out });
    }

    if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: `unknown endpoint ${p}` });
    if (req.method === 'GET') return serveStatic(res, p);
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const rep = browserReport();
  console.log(`[SNIPR] listening on http://${HOST}:${PORT}`);
  console.log(`[SNIPR] real browsers: ${rep.browsers.length ? rep.browsers.join(', ') : 'NONE — ' + rep.error}`);
  console.log(`[SNIPR] flows: ${Object.values(FLOWS).map(f => `${f.label} -> ${f.site}`).join(' | ')}`);
  const login = siteSniper.loginState();
  console.log(`[SNIPR] account: ${login.env ? 'USERSNIPER_EMAIL/USERSNIPER_PASSWORD from the environment' : 'nothing stored yet — paste it in the dashboard (memory only)'}`);
});
