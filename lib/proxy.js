'use strict';
/*
 * SNIPR rotating-proxy layer — zero dependencies, no global fetch patching.
 *
 * Three modes:
 *
 *   off    direct connections (the default; nothing changes).
 *
 *   tor    every request goes through a Tor SOCKS5 port. TWO real rotation
 *          mechanisms, both implemented here:
 *
 *            1. circuit isolation — each connection authenticates to Tor with a
 *               fresh SOCKS5 username/password pair. With `IsolateSOCKSAuth`
 *               (enabled by default on Tor's SocksPort) Tor builds a SEPARATE
 *               circuit per credential pair, so the exit IP changes per
 *               request without touching the control port at all.
 *            2. `SIGNAL NEWNYM` on the Tor control port, throttled to Tor's own
 *               10 second NEWNYM limit, which forces a brand new exit node for
 *               every circuit opened afterwards.
 *
 *   list   round-robin over a user supplied proxy list (socks5:// or http://).
 *          Each request takes the next proxy, so the source IP changes request
 *          by request.
 *
 * SOCKS5 is implemented here (greeting, optional user/pass auth, CONNECT) and
 * HTTP proxies use CONNECT tunnelling. lib/http.js asks this pool for an Agent
 * per request, so every platform checker and every batch worker is covered.
 *
 * torrc the app expects (see README):
 *   SocksPort 9050 IsolateSOCKSAuth
 *   ControlPort 9051
 *   HashedControlPassword <...>      # or leave the control port closed
 */

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const torLayer = require('./tor');

const SOCKS_PROTOCOLS = ['socks5', 'socks5h', 'socks'];
const HTTP_PROTOCOLS = ['http', 'https'];

/* ------------------------------- config ---------------------------------- */
function splitHostPort(str, fallbackPort) {
  const s = String(str || '').trim().replace(/^[a-z0-9+.-]+:\/\//i, '');
  const m = s.match(/^\[?([^\]]+?)\]?:(\d+)$/) || s.match(/^([^:]+)$/);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) || fallbackPort };
}

function defaultPort(protocol) {
  if (SOCKS_PROTOCOLS.includes(protocol)) return 1080;
  if (protocol === 'https') return 443;
  return 8080;
}

/* "socks5://user:pass@127.0.0.1:9050" | "127.0.0.1:9050" -> proxy object */
function parseProxy(raw, label) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('empty proxy');
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(text) ? text : 'http://' + text;
  let u;
  try { u = new URL(withScheme); } catch (_) { throw new Error(`cannot parse proxy "${text}"`); }
  const protocol = String(u.protocol || '').replace(/:$/, '').toLowerCase();
  if (!SOCKS_PROTOCOLS.includes(protocol) && !HTTP_PROTOCOLS.includes(protocol)) {
    throw new Error(`unsupported proxy protocol "${protocol}" (use socks5:// or http://)`);
  }
  if (!u.hostname) throw new Error(`proxy "${text}" has no host`);
  const user = u.username ? decodeURIComponent(u.username) : '';
  const pass = u.password ? decodeURIComponent(u.password) : '';
  return {
    protocol, host: u.hostname, port: Number(u.port) || defaultPort(protocol),
    user, pass,
    auth: user ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null,
    label: label || `${protocol}://${u.hostname}:${Number(u.port) || defaultPort(protocol)}`,
  };
}

function parsePorts(text, fallback) {
  const out = String(text == null ? '' : text).split(/[\s,;]+/).map(Number).filter(n => n > 0 && n < 65536);
  return out.length ? [...new Set(out)] : fallback;
}

const config = {
  mode: 'off',                                        // 'off' | 'tor' | 'list'
  torSocks: process.env.TOR_SOCKS || 'socks5://127.0.0.1:9050',
  torControl: process.env.TOR_CONTROL || '127.0.0.1:9051',
  torPassword: process.env.TOR_CONTROL_PASSWORD || '',
  isolate: true,                                      // fresh SOCKS5 creds per connection
  rotateEvery: 1,                                     // NEWNYM every N requests (0 = never)
  rotateIntervalMs: 10000,                            // Tor ignores NEWNYM faster than this
  list: [],
  // Where else to look for a Tor daemon when the configured SOCKS port does not
  // answer: 9050 = tor daemon, 9150 = Tor Browser. TOR_DISCOVER_PORTS overrides.
  discoverPorts: parsePorts(process.env.TOR_DISCOVER_PORTS, [9050, 9150]),
};

const stats = {
  requests: 0,      // requests handed a route by the pool
  tunnels: 0,       // tunnels actually opened
  rotations: 0,     // successful NEWNYM signals
  exits: [],        // observed exit IPs {ip, at}
  errors: [],       // last few failures
  lastExit: null,
  lastRotateAt: 0,
};

let rr = 0;                    // round-robin cursor for list mode
let rotateTimer = null;
let sessionSeq = 0;
let circuitGen = 0;            // bumped whenever the Tor exit may have changed
const badExits = new Map();    // proxyKey -> timestamp until which it is skipped

/* ------------------------------ helpers ---------------------------------- */
function noteError(msg) {
  stats.errors.push({ t: Date.now(), msg: String(msg).slice(0, 200) });
  if (stats.errors.length > 8) stats.errors.splice(0, stats.errors.length - 8);
}

/*
 * Every failure that happens on OUR side of the wire (dialling the proxy,
 * negotiating SOCKS5, the tunnel itself) is tagged `proxy: true`. That is the
 * difference between "the route you configured is dead" — Tor not running, a
 * typo'd host, a dead proxy — and "the site refused this request". Without the
 * tag both read as a bare "network error" and the wrong thing gets blamed.
 */
function proxyError(msg, extra) {
  const err = new Error(String(msg));
  err.proxy = true;
  if (extra) Object.assign(err, extra);
  return err;
}

function isProxyError(e) {
  if (!e) return false;
  if (e.proxy) return true;
  const msg = String(e.message || e);
  return /^socks5 |^proxy |^tor control|socks5 proxy (closed|is not)|proxy CONNECT timeout/.test(msg);
}

function describe() {
  if (config.mode === 'tor') {
    const p = splitHostPort(config.torSocks, 9050);
    return `Tor SOCKS5 ${p ? p.host + ':' + p.port : config.torSocks}` +
      (config.isolate ? ' · rotating circuits' : '') +
      (config.rotateEvery > 0 && config.torControl ? ' · NEWNYM every ' + config.rotateEvery : '');
  }
  if (config.mode === 'list') return `${config.list.length} proxies · round-robin per request`;
  return 'direct (no proxy)';
}

function proxyKey(p) { return `${p.protocol}://${p.host}:${p.port}`; }

/*
 * Exits the target itself rejected. A blocked exit is not a dead proxy (the
 * tunnel works fine — the site answered 401/403/429 on it), so it is not an
 * error: it is simply the wrong exit to send the next request from. In list mode
 * the next request prefers an exit that has not been rejected recently, which is
 * what stops a sweep from asking the same three dirty proxies forever.
 */
const BAD_EXIT_COOLDOWN_MS = 60000;
const MAX_BAD_EXITS = 64;

function noteBlocked(key, ms = BAD_EXIT_COOLDOWN_MS) {
  if (!key || config.mode !== 'list') return;      // only a list has exits to skip
  badExits.set(key, Date.now() + Math.max(1000, Number(ms) || BAD_EXIT_COOLDOWN_MS));
  while (badExits.size > MAX_BAD_EXITS) badExits.delete(badExits.keys().next().value);
}

function isBadExit(key) {
  const until = badExits.get(key);
  if (!until) return false;
  if (until <= Date.now()) { badExits.delete(key); return false; }
  return true;
}

/* A fresh SOCKS5 credential pair = a fresh Tor circuit (IsolateSOCKSAuth). */
function nextSessionCreds() {
  sessionSeq += 1;
  return { user: `snipr-${sessionSeq.toString(36)}-${crypto.randomBytes(4).toString('hex')}`, pass: 'x' };
}

/* ------------------------------ SOCKS5 ----------------------------------- */
/*
 * Incremental byte reader. A SOCKS5 reply can arrive split over many TCP
 * segments, so bytes are buffered and handed out in exact counts. Anything the
 * proxy sent beyond the handshake is unshifted back onto the socket once the
 * reader detaches, so the TLS handshake never loses a byte.
 */
function makeReader(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];

  const flush = () => {
    while (waiters.length && buf.length >= waiters[0].n) {
      const w = waiters.shift();
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  };
  const onData = (chunk) => { buf = Buffer.concat([buf, chunk]); flush(); };
  socket.on('data', onData);

  const read = (n) => new Promise((resolve, reject) => {
    waiters.push({ n, resolve, reject });
    flush();
  });
  read.fail = (err) => { while (waiters.length) waiters.shift().reject(err); };
  read.detach = () => {
    socket.removeListener('data', onData);
    if (buf.length && !socket.destroyed) {
      const leftover = buf;
      buf = Buffer.alloc(0);
      socket.unshift(leftover);
    }
  };
  return read;
}

function encodeAddress(target) {
  const ipVersion = net.isIP(target.host);
  if (ipVersion === 6) return Buffer.concat([Buffer.from([0x04]), Buffer.from(parseIpv6(target.host))]);
  if (ipVersion === 4) return Buffer.concat([Buffer.from([0x01]), Buffer.from(target.host.split('.').map(Number))]);
  const host = Buffer.from(target.host, 'utf8');
  return Buffer.concat([Buffer.from([0x03, host.length]), host]);
}

function parseIpv6(str) {
  // expand "::" shorthand into 8 groups
  const [head, tail] = String(str).split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = new Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h.filter(Boolean), ...fill, ...t]
    .flatMap(g => [(parseInt(g || '0', 16) >> 8) & 0xff, parseInt(g || '0', 16) & 0xff]);
}

const SOCKS_ERRORS = [
  'succeeded', 'general failure', 'not allowed by ruleset', 'network unreachable',
  'host unreachable', 'connection refused', 'TTL expired', 'command not supported',
  'address type not supported',
];

/* TCP + SOCKS5 handshake + CONNECT, resolving with a raw socket to `target`. */
function socks5Connect(proxy, target, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let read = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (read) read.fail(err);
      socket.destroy();
      // everything a SOCKS5 tunnel can complain about is a route failure
      if (err && !err.proxy) err.proxy = true;
      reject(err instanceof Error ? err : proxyError(String(err)));
    };
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs, () => fail(proxyError(`socks5 timeout talking to ${proxy.host}:${proxy.port}`)));
    socket.once('error', e => fail(new Error(`socks5 ${proxy.host}:${proxy.port}: ${e.message}`)));
    socket.once('connect', async () => {
      read = makeReader(socket);
      socket.once('close', () => fail(new Error('socks5 proxy closed the connection')));
      try {
        const useAuth = !!(proxy.user || proxy.pass);
        socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));

        const greet = await read(2);
        if (greet[0] !== 0x05) return fail(new Error('socks5 proxy is not SOCKS5'));
        const method = greet[1];
        if (method === 0xff) return fail(new Error('socks5 proxy rejected every auth method'));
        if (method === 0x02) {
          if (!useAuth) return fail(new Error('socks5 proxy requires a username/password'));
          const u = Buffer.from(proxy.user || '', 'utf8');
          const p = Buffer.from(proxy.pass || '', 'utf8');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          const auth = await read(2);
          if (auth[0] !== 0x01 || auth[1] !== 0x00) return fail(new Error('socks5 authentication failed'));
        } else if (method !== 0x00) {
          return fail(new Error(`socks5 proxy asked for unsupported auth method 0x${method.toString(16)}`));
        }

        const port = Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), encodeAddress(target), port]));

        const head = await read(4);
        const rep = head[1];
        const atyp = head[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 0;
        if (atyp === 0x03) {
          const len = await read(1);
          await read(1 + len[0] + 2);
        } else if (atyp !== 0x01 && atyp !== 0x04) {
          return fail(new Error(`socks5 CONNECT got address type 0x${atyp.toString(16)}`));
        } else {
          await read(addrLen + 2);
        }
        if (rep !== 0x00) return fail(new Error(`socks5 CONNECT ${target.host}:${target.port} failed: ${SOCKS_ERRORS[rep] || 'code ' + rep}`));

        stats.tunnels++;
        socket.setTimeout(0);
        read.detach();
        settled = true;
        resolve(socket);
      } catch (e) { fail(e); }
    });
  });
}

/* --------------------------- HTTP CONNECT -------------------------------- */
function httpTunnelConnect(proxy, target, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = proxy.protocol === 'https' ? https : http;
    const req = mod.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      headers: { host: `${target.host}:${target.port}`, ...(proxy.auth ? { 'proxy-authorization': proxy.auth } : {}) },
      agent: false, timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(proxyError(`proxy ${proxyKey(proxy)} refused CONNECT (HTTP ${res.statusCode})`));
      }
      stats.tunnels++;
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(proxyError(`proxy CONNECT timeout (${proxyKey(proxy)})`)));
    req.once('error', e => reject(proxyError(`proxy ${proxyKey(proxy)}: ${e.message}`)));
    req.end();
  });
}

function tunnel(proxy, target, timeoutMs) {
  return SOCKS_PROTOCOLS.includes(proxy.protocol)
    ? socks5Connect(proxy, target, timeoutMs)
    : httpTunnelConnect(proxy, target, timeoutMs);
}

/* ------------------------------- agents ---------------------------------- */
/* Per-request agents: keepAlive is off, so every HTTP request opens its own
 * tunnel — which is what makes Tor circuit isolation actually rotate an IP. */
class TunnelHttpsAgent extends https.Agent {
  constructor(proxy, target, opts = {}) {
    super({ keepAlive: false, maxSockets: opts.maxSockets || 32 });
    this.proxy = proxy;
    this.target = target;
  }

  createConnection(options, cb) {
    const proxy = this.proxy;
    const target = {
      host: options.host || this.target.host,
      port: Number(options.port) || this.target.port,
    };
    tunnel(proxy, target)
      .then(socket => {
        socket.pause();   // let the TLS layer own the socket's reads
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || (net.isIP(target.host) ? undefined : target.host),
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });
        tlsSocket.once('error', err => noteError(err.message));
        if (typeof cb === 'function') cb(null, tlsSocket);
        return tlsSocket;
      })
      .catch(err => { noteError(err.message); if (typeof cb === 'function') cb(err); });
    return undefined;   // async: createSocket waits for cb()
  }
}

class TunnelHttpAgent extends http.Agent {
  constructor(proxy, target, opts = {}) {
    super({ keepAlive: false, maxSockets: opts.maxSockets || 32 });
    this.proxy = proxy;
    this.target = target;
  }

  createConnection(...args) {
    let options = args[0]; let cb = null;
    if (typeof args[0] === 'object' && args[0] !== null) { options = args[0]; cb = args[1]; }
    else if (typeof args[1] === 'object' && args[1] !== null) { options = { host: args[0], port: args[1], ...args[2] }; cb = args[2] && args[3]; }
    const target = {
      host: (options && options.host) || this.target.host,
      port: Number(options && options.port) || this.target.port,
    };
    tunnel(this.proxy, target)
      .then(socket => { if (typeof cb === 'function') cb(null, socket); return socket; })
      .catch(err => { noteError(err.message); if (typeof cb === 'function') cb(err); });
    return undefined;
  }
}

/* ------------------------------ routing ---------------------------------- */
const agentCache = new Map();
let cacheEpoch = 0;

function route() {
  if (config.mode === 'tor') {
    let proxy;
    try { proxy = parseProxy(config.torSocks, 'tor'); } catch (e) { noteError(e.message); return null; }
    if (config.isolate) {
      const creds = nextSessionCreds();
      return { proxy: { ...proxy, ...creds }, key: `${proxyKey(proxy)}#${creds.user}` };
    }
    return { proxy, key: proxyKey(proxy) };
  }
  if (config.mode === 'list') {
    const n = config.list.length;
    if (!n) return null;
    // Prefer an exit the target has not just rejected; if every one of them is
    // cooling down, take the round-robin pick anyway rather than wedging.
    let proxy = null;
    for (let i = 0; i < n; i++) {
      const p = config.list[rr++ % n];
      if (!isBadExit(proxyKey(p))) { proxy = p; break; }
    }
    if (!proxy) proxy = config.list[rr++ % n];
    return { proxy, key: proxyKey(proxy) };
  }
  return null;
}

/*
 * Acquire ONE egress route and count it as a request. A redirect chain is a
 * single logical check: the caller keeps the session for every hop so a cookie
 * handed out on the first hop is replayed from the same exit on the next one
 * (a fresh exit per hop is exactly what makes clearance cookies 401).
 *
 * Returns null in "off" mode (direct) or when the config is unusable.
 */
function beginSession() {
  if (config.mode === 'off') return null;
  stats.requests++;
  maybeRotate();
  return route();
}

/*
 * Hand the caller an Agent for this URL (or undefined for a direct request).
 *
 *   session === undefined -> legacy per-request routing (one route per call)
 *   session === null      -> direct
 *   session === {proxy}   -> reuse this route (see beginSession)
 */
function agentFor(urlStr, session) {
  let url;
  try { url = new URL(urlStr); } catch (_) { return undefined; }
  const target = {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
  };
  const r = session === undefined ? beginSession() : session;
  if (!r) return undefined;

  const key = `${cacheEpoch}|${r.key}|${target.protocol}|${target.host}:${target.port}`;
  let agent = agentCache.get(key);
  if (!agent) {
    agent = target.protocol === 'https:'
      ? new TunnelHttpsAgent(r.proxy, target)
      : new TunnelHttpAgent(r.proxy, target);
    agentCache.set(key, agent);
    if (agentCache.size > 64) agentCache.delete(agentCache.keys().next().value);
  }
  return agent;
}

/*
 * True when every request leaves from the SAME exit (direct, or Tor without
 * per-connection isolation). Only then may cookies be remembered between
 * separate checks: in a rotating mode a clearance cookie minted for one exit
 * must never be replayed from another. `identityTag()` is the precise form —
 * this stays as the yes/no view of it.
 */
function identityStable() {
  return identityTag() !== null;
}

/*
 * WHICH exit the long-lived cookie jar belongs to, as an opaque tag — or null
 * when there is no such exit.
 *
 * identityStable() alone is not enough: Tor without per-connection isolation
 * keeps one exit only UNTIL the next SIGNAL NEWNYM, so a clearance cookie
 * minted before a rotation would be replayed from a different exit afterwards,
 * which is exactly how guns.lol answers 401. The generation counter changes on
 * every rotation, so the jar is dropped with it (see lib/http.js `jarFor`).
 */
function identityTag() {
  if (config.mode === 'off') return 'direct';                       // one IP for the process
  if (config.mode === 'tor' && !config.isolate) return `tor-circuit-${circuitGen}`;
  return null;   // list: a new proxy per request · isolated tor: a new circuit per connection
}

/*
 * Can a retry actually land on a DIFFERENT exit? If not, retrying a rejected
 * request only adds load to a site that is already refusing us.
 */
function canRotate() {
  if (config.mode === 'list') return config.list.length > 1;
  if (config.mode === 'tor') return config.isolate;   // fresh SOCKS5 creds = fresh circuit
  return false;
}

/* ------------------------ NEWNYM (control port) -------------------------- */
function torControlEndpoint() {
  const p = splitHostPort(config.torControl, 9051);
  return p || null;
}

/* Talks the Tor control protocol: AUTHENTICATE then SIGNAL NEWNYM. */
function torNewNym(timeoutMs = 8000) {
  const ep = torControlEndpoint();
  if (!ep) return Promise.reject(new Error('no Tor control port configured'));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ep.host, port: ep.port });
    let buf = '';
    let stage = 0;               // 0 = authenticating, 1 = signalling
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) { noteError(err.message); reject(err); } else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error('Tor control port timed out')), timeoutMs);
    socket.once('error', e => finish(new Error(`Tor control ${ep.host}:${ep.port}: ${e.message}`)));
    socket.once('connect', () => {
      const pass = String(config.torPassword || '').replace(/"/g, '\\"');
      socket.write(pass ? `AUTHENTICATE "${pass}"\r\n` : 'AUTHENTICATE\r\n');
    });
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('250') || line.startsWith('650')) {
          if (stage === 0) { stage = 1; socket.write('SIGNAL NEWNYM\r\n'); }
          else {
            stats.rotations++;
            stats.lastRotateAt = Date.now();
            // the exit behind us may be gone now: anything learned on it (a
            // clearance cookie) must not be replayed on the new circuit
            circuitGen++;
            socket.write('QUIT\r\n');
            finish(null);
          }
        } else if (line.startsWith('5')) {
          finish(new Error(`Tor control rejected the command (${line}) — set the control password or disable ControlPort`));
        }
      }
    });
  });
}

/* Request-driven rotation, throttled to Tor's 10s NEWNYM limit. */
function maybeRotate() {
  if (config.mode !== 'tor' || !config.rotateEvery || !config.torControl) return;
  if (stats.requests % config.rotateEvery !== 0) return;
  const wait = config.rotateIntervalMs - (Date.now() - stats.lastRotateAt);
  if (wait <= 0) { torNewNym().catch(() => {}); return; }
  if (rotateTimer) return;
  rotateTimer = setTimeout(() => {
    rotateTimer = null;
    torNewNym().catch(() => {});
  }, wait);
  if (rotateTimer.unref) rotateTimer.unref();
}

/* ------------------------------ status ----------------------------------- */
function noteExit(ip, isTor) {
  if (!ip) return;
  stats.lastExit = { ip, isTor: !!isTor, at: Date.now() };
  stats.exits.push({ ip, isTor: !!isTor, at: Date.now() });
  if (stats.exits.length > 40) stats.exits.splice(0, stats.exits.length - 40);
}

function status() {
  return {
    mode: config.mode,
    label: describe(),
    tor: {
      socks: config.torSocks,
      control: config.torControl,
      hasPassword: !!config.torPassword,
      isolate: config.isolate,
      discoverPorts: config.discoverPorts,
      // whether a `tor` binary exists on this host, and the state of the daemon
      // we started ourselves (see lib/tor.js)
      binary: torLayer.findBinary(),
      daemon: torLayer.status(),
    },
    rotateEvery: config.rotateEvery,
    rotateIntervalMs: config.rotateIntervalMs,
    list: config.list.map(p => ({ label: p.label, protocol: p.protocol, host: p.host, port: p.port, auth: !!p.auth })),
    stats: {
      requests: stats.requests,
      tunnels: stats.tunnels,
      rotations: stats.rotations,
      lastExit: stats.lastExit,
      exitsSeen: new Set(stats.exits.map(e => e.ip)).size,
      exits: stats.exits.slice(-12),
      errors: stats.errors.slice(-4),
    },
    // exits the target itself rejected, currently being skipped in list mode
    blocked: [...badExits.entries()].filter(([, until]) => until > Date.now()).map(([key]) => key),
    canRotate: canRotate(),
  };
}

/* ---------------------------- route health ------------------------------- */
/*
 * Is the configured route dial-able at all? A TCP connect (plus the SOCKS5
 * greeting when the proxy speaks SOCKS5) catches the failure that actually
 * happens in practice — Tor not running, a typo'd host/port, a dead proxy —
 * BEFORE a run turns the whole wordlist into "network error" rows.
 */
function probeProxy(p, timeoutMs = 4000) {
  return new Promise(resolve => {
    const started = Date.now();
    let done = false;
    const socket = net.connect({ host: p.host, port: p.port });
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error: error || null, label: proxyKey(p), ms: Date.now() - started });
    };
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs, () => finish(false, `no answer from ${p.host}:${p.port} within ${timeoutMs}ms`));
    socket.once('error', e => finish(false, `${p.host}:${p.port}: ${e.message}`));
    socket.once('connect', () => {
      if (!SOCKS_PROTOCOLS.includes(p.protocol)) return finish(true);   // CONNECT proxies answer on connect
      socket.write(Buffer.from([0x05, 0x01, 0x00]));                    // prove it really is SOCKS5
    });
    socket.once('data', chunk => {
      if (!chunk || !chunk.length) return finish(false, `${p.host}:${p.port} closed without answering`);
      if (chunk[0] !== 0x05) return finish(false, `${p.host}:${p.port} is not a SOCKS5 proxy`);
      finish(true);
    });
  });
}

async function checkRoute(timeoutMs = 4000) {
  if (config.mode === 'off') return { ok: true, mode: 'off', label: describe(), results: [], warnings: [], hint: null, suggest: null, ms: 0 };

  const started = Date.now();
  const proxies = [];
  if (config.mode === 'tor') {
    try { proxies.push(parseProxy(config.torSocks, 'tor')); }
    catch (e) { return { ok: false, mode: 'tor', error: `tor SOCKS address invalid: ${e.message}`, results: [], warnings: [], ms: Date.now() - started }; }
  } else {
    if (!config.list.length) return { ok: false, mode: 'list', error: 'the proxy list is empty', results: [], warnings: [], ms: Date.now() - started };
    proxies.push(...config.list.slice(0, 3));   // a sample is enough, lists can be long
  }

  const results = await Promise.all(proxies.map(p => probeProxy(p, timeoutMs)));
  const bad = results.filter(r => !r.ok);
  const warnings = [];

  // A closed control port is not fatal (circuit isolation still rotates), but it
  // does silently disable SIGNAL NEWNYM, so say so.
  if (config.mode === 'tor' && config.torControl && config.rotateEvery > 0) {
    const c = await probeControl(config.torControl, timeoutMs);
    if (!c.ok) warnings.push(`tor control port unreachable (${c.error}) — SIGNAL NEWNYM rotation is off, circuit isolation still rotates`);
  }

  // A Tor route that cannot be dialled has exactly two fixes, and both are
  // visible from here: a daemon IS running on another port (Tor Browser's 9150),
  // or one has to be started/installed. Say which, instead of leaving the user
  // with "ECONNREFUSED 127.0.0.1:9050" and no next step.
  let suggest = null;
  let hint = null;
  if (config.mode === 'tor' && bad.length) {
    const configured = splitHostPort(config.torSocks, 9050);
    const ports = [...new Set([...config.discoverPorts, 9050].filter(p => !configured || p !== configured.port))];
    const found = await torLayer.discover({ socksPorts: ports, timeout: Math.min(timeoutMs, 2000) });
    if (found.ok) {
      suggest = { torSocks: found.socks, torControl: found.control || '' };
      hint = `a Tor daemon does answer on ${found.socks} — point the SOCKS5 address at it`;
    } else if (torLayer.findBinary()) {
      // a tor exists here (system or a bundle we fetched earlier): it just is
      // not running
      hint = `no Tor SOCKS port answered (${ports.join(', ')} probed) — ${torLayer.installHint()}, or set the route to direct`;
    } else {
      hint = `no Tor SOCKS port answered (${ports.join(', ')} probed) — ${torLayer.installHint()}`;
    }
  }

  return {
    ok: bad.length === 0,
    mode: config.mode,
    label: describe(),
    error: bad.length ? bad.map(r => r.error).join(' · ') : null,
    results,
    warnings,
    hint,
    suggest,
    ms: Date.now() - started,
  };
}

function probeControl(hostPort, timeoutMs = 4000) {
  const hp = splitHostPort(hostPort, 9051);
  return new Promise(resolve => {
    if (!hp) return resolve({ ok: false, error: `cannot parse "${hostPort}"` });
    let done = false;
    const socket = net.connect({ host: hp.host, port: hp.port });
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error: error || null });
    };
    socket.setTimeout(timeoutMs, () => finish(false, `no answer from ${hp.host}:${hp.port}`));
    socket.once('error', e => finish(false, `${hp.host}:${hp.port}: ${e.message}`));
    socket.once('data', () => finish(true));   // 250-... banner means a control port is there
    socket.once('connect', () => socket.write('PROTOCOLINFO 1\r\n'));
  });
}

/* ------------------------------ config API ------------------------------- */
function setConfig(patch = {}) {
  const before = JSON.stringify([config.mode, config.torSocks, config.list.length, config.isolate]);
  if (patch.mode !== undefined) {
    const mode = String(patch.mode);
    if (!['off', 'tor', 'list'].includes(mode)) throw new Error('proxy mode must be off, tor or list');
    config.mode = mode;
  }
  if (patch.torSocks !== undefined) {
    let text = String(patch.torSocks || '').trim() || 'socks5://127.0.0.1:9050';
    // a bare "127.0.0.1:9050" is the Tor SOCKS port — the UI hint shows it that
    // way, so do not quietly read it as an HTTP proxy and reject it
    if (!/^[a-z0-9+.-]+:\/\//i.test(text)) text = 'socks5://' + text;
    const p = parseProxy(text, 'tor');
    if (!SOCKS_PROTOCOLS.includes(p.protocol)) throw new Error('the Tor proxy must be a socks5:// address');
    config.torSocks = `socks5://${p.user ? encodeURIComponent(p.user) + ':' + encodeURIComponent(p.pass) + '@' : ''}${p.host}:${p.port}`;
  }
  if (patch.torControl !== undefined) {
    const text = String(patch.torControl || '').trim();
    if (!text) config.torControl = '';
    else {
      const p = splitHostPort(text, 9051);
      if (!p) throw new Error('cannot parse the Tor control address');
      config.torControl = `${p.host}:${p.port}`;
    }
  }
  if (patch.torPassword !== undefined) config.torPassword = String(patch.torPassword || '');
  if (patch.isolate !== undefined) config.isolate = !!patch.isolate;
  if (patch.rotateEvery !== undefined) config.rotateEvery = Math.max(0, Math.min(10000, Number(patch.rotateEvery) || 0));
  if (patch.rotateIntervalMs !== undefined) config.rotateIntervalMs = Math.max(1000, Math.min(600000, Number(patch.rotateIntervalMs) || 10000));
  if (patch.list !== undefined) {
    const lines = Array.isArray(patch.list) ? patch.list : String(patch.list || '').split(/[\n,;]+/);
    const parsed = [];
    const bad = [];
    lines.map(s => String(s).trim()).filter(Boolean).forEach((line, i) => {
      try { parsed.push(parseProxy(line)); } catch (e) { bad.push(`line ${i + 1}: ${e.message}`); }
    });
    if (bad.length) throw new Error(bad.slice(0, 3).join(' · '));
    config.list = parsed;
  }
  if (config.mode === 'tor') {
    // fail fast on a typo instead of at the first request
    const p = splitHostPort(config.torSocks, 9050);
    if (!p) throw new Error('cannot parse the Tor SOCKS address');
  }
  if (patch.discoverPorts !== undefined || patch.torDiscoverPorts !== undefined) {
    const raw = patch.discoverPorts !== undefined ? patch.discoverPorts : patch.torDiscoverPorts;
    const ports = Array.isArray(raw) ? raw.map(Number).filter(n => n > 0 && n < 65536) : parsePorts(raw, []);
    config.discoverPorts = ports.length ? [...new Set(ports)] : [9050, 9150];
  }
  if (config.mode === 'list' && !config.list.length) throw new Error('proxy list mode needs at least one proxy');
  if (before !== JSON.stringify([config.mode, config.torSocks, config.list.length, config.isolate])) reset();
  return status();
}

function reset() {
  cacheEpoch++;
  agentCache.clear();
  rr = 0;
  circuitGen++;
  badExits.clear();
}

/* Playwright/Chromium proxy objects for the swarm (one per browser). */
function playwrightProxies(count = 6) {
  if (config.mode === 'off') return null;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (config.mode === 'tor') {
      let p;
      try { p = parseProxy(config.torSocks, 'tor'); } catch (_) { return null; }
      // Chromium cannot authenticate to SOCKS5, so isolation creds are optional
      out.push({ server: `socks5://${p.host}:${p.port}`, ...(p.user ? { username: p.user, password: p.pass } : {}) });
    } else if (config.list.length) {
      const p = config.list[i % config.list.length];
      out.push({ server: `${p.protocol}://${p.host}:${p.port}`, ...(p.user ? { username: p.user, password: p.pass } : {}) });
    }
  }
  return out.length ? out : null;
}

function initFromEnv() {
  const mode = String(process.env.SNIPR_PROXY || '').trim().toLowerCase();
  const listEnv = String(process.env.SNIPR_PROXY_LIST || '').trim();
  try {
    if (listEnv) setConfig({ mode: 'list', list: listEnv });
    else if (mode === 'tor' || mode === 'list' || mode === 'off') setConfig({ mode });
  } catch (e) { noteError('SNIPR_PROXY: ' + e.message); }
  return status();
}

module.exports = {
  setConfig, status, describe, initFromEnv, agentFor, beginSession, identityStable, reset,
  identityTag, canRotate, noteBlocked, isBadExit,
  torNewNym, playwrightProxies, noteExit, parseProxy, checkRoute, probeProxy, isProxyError, proxyError,
  socks5Connect, tunnel, httpTunnelConnect, agentCache,
  config, stats,
};
