'use strict';
/*
 * SNIPR HTTP client — a small `fetch`-alike built on http/https so that every
 * request can be routed through the rotating proxy layer (lib/proxy.js).
 *
 * The platform checkers call `fetchWithTimeout(url, opts, ms)` exactly like
 * they used to call global fetch, and get back an object with
 * `{ status, ok, headers, text(), json(), url }`.
 *
 * Three behaviours here exist because plain `fetch` could not do them:
 *
 *  1. ONE EGRESS IDENTITY PER LOGICAL CHECK. Every redirect hop of a single
 *     call shares one proxy route (`proxyPool.beginSession()`), so an exit IP
 *     cannot change midway through a redirect chain.
 *
 *  2. A COOKIE JAR. guns.lol answers `307` with `location` pointing at the SAME
 *     url and a `set-cookie: guns_clearance=...`. A client that ignores cookies
 *     re-requests forever, so ONE username check became SIX requests — which is
 *     what produced the `HTTP 429` storm, and `401`s once a clearance cookie
 *     minted for one exit was replayed from another. Replaying the cookie ends
 *     the redirect after one hop (`200`, "Username not found" for a free name).
 *     Cookies are remembered between checks only when the exit never changes
 *     (direct, or Tor without per-connection isolation) — see
 *     `proxyPool.identityStable()`.
 *
 *  3. BOUNDED RETRIES for `429 / 403 / 503` on GET/HEAD, honouring
 *     `Retry-After`, each attempt on a fresh route (so a rotating proxy
 *     actually gets a new exit to retry from).
 *
 * Redirects are followed manually (max 5, each URL at most twice), the body is
 * capped at 8 MB, and `accept-encoding: identity` is sent so nothing has to be
 * gunzipped.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const proxyPool = require('./proxy');

const MAX_BODY = 8 * 1024 * 1024;   // 8 MB is far more than any platform page
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const RETRY_CODES = new Set([429, 403, 503]);
const MAX_ATTEMPTS = 3;
const MAX_JAR_HOSTS = 64;
const MAX_COOKIES_PER_HOST = 32;
const RETRY_AFTER_CAP_MS = 8000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = String(v);
  }
  if (!out['accept-encoding']) out['accept-encoding'] = 'identity';
  return out;
}

/* ------------------------------ cookie jar -------------------------------- */
/* hostname -> Map(cookieName -> value). Bounded on both axes so a long run
 * cannot grow it without limit. */
const cookieJar = new Map();

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function parseSetCookie(line) {
  if (!line) return null;
  const parts = String(line).split(';');
  const pair = parts.shift() || '';
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  const value = pair.slice(eq + 1).trim();
  let host = null;
  let expired = false;
  for (const attr of parts) {
    const i = attr.indexOf('=');
    const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : attr.slice(i + 1).trim();
    if (k === 'domain') host = normalizeHost(v) || null;
    else if (k === 'max-age' && Number(v) <= 0) expired = true;
    else if (k === 'expires' && v && Date.parse(v) <= Date.now()) expired = true;
  }
  return { name, value, host, expired };
}

function writeCookie(bag, name, value) {
  bag.delete(name);                 // re-insert so the freshest value is last
  bag.set(name, value);
  while (bag.size > MAX_COOKIES_PER_HOST) bag.delete(bag.keys().next().value);
}

/* `writes` is [globalJar?, chainJar?] — the chain jar is used in rotating
 * modes, where cookies must not outlive the exit that earned them. */
function rememberCookies(target, res, writes) {
  const raw = res.headers && res.headers['set-cookie'];
  if (!raw) return;
  const lines = Array.isArray(raw) ? raw : [raw];
  for (const line of lines) {
    const c = parseSetCookie(line);
    if (!c) continue;
    const host = normalizeHost(c.host || target.hostname);
    if (!host) continue;
    for (const jar of writes) {
      if (!jar) continue;
      let bag = jar.get(host);
      if (!bag) {
        if (jar.size >= MAX_JAR_HOSTS) jar.delete(jar.keys().next().value);
        bag = new Map();
        jar.set(host, bag);
      }
      if (c.expired || !c.value) bag.delete(c.name);
      else writeCookie(bag, c.name, c.value);
    }
  }
}

/* Both jars are hostname -> Map(name -> value); a cookie applies to the exact
 * host and to any subdomain of it. */
function bagCookies(jar, host) {
  const out = new Map();
  for (const [key, bag] of jar) {
    if (host !== key && !host.endsWith('.' + key)) continue;
    for (const [name, value] of bag) out.set(name, value);
  }
  return out;
}

/* Cookies for this hop: the long-lived jar only when the exit never changes,
 * plus whatever this chain minted for itself. */
function cookiesFor(target, chainJar, useGlobal) {
  const host = normalizeHost(target.hostname);
  const merged = useGlobal ? bagCookies(cookieJar, host) : new Map();
  if (chainJar) for (const [name, value] of bagCookies(chainJar, host)) merged.set(name, value);
  if (!merged.size) return '';
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
}

/* ------------------------------- requests --------------------------------- */
function requestOnce(target, { method, headers, body, timeoutMs, insecure, session }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    let agent;
    try { agent = proxyPool.agentFor(target.href, session); } catch (e) { return reject(e); }

    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: Number(target.port) || (isHttps ? 443 : 80),
      path: (target.pathname || '/') + (target.search || ''),
      method,
      headers,
      agent,                                   // undefined → direct connection
      timeout: timeoutMs,
      ...(insecure ? { rejectUnauthorized: false } : {}),
    });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    req.once('timeout', () => fail(new Error(`request timed out after ${timeoutMs}ms`)));
    req.once('error', err => fail(err));

    req.once('response', res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { fail(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.once('error', err => fail(err));
      res.once('end', () => {
        if (settled) return;
        settled = true;
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          headers: res.headers || {},
          url: target.href,
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
        });
      });
    });

    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

/* How long to wait before the next attempt of a throttled GET. */
function retryDelay(res, attempt) {
  const h = res.headers || {};
  const after = Number(h['retry-after'] ?? h['x-ratelimit-reset-after'] ?? h['x-ratelimit-after']);
  if (Number.isFinite(after) && after > 0) {
    // Retry-After is in seconds; some servers (Discord) send fractional seconds
    return Math.min(RETRY_AFTER_CAP_MS, Math.round(after * 1000));
  }
  return Math.min(4000, 700 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
}

/* One full redirect chain on one egress identity. */
async function runChain({ target, method, headers, body, timeoutMs, insecure, maxRedirects, attempt }) {
  const stable = proxyPool.identityStable();
  const chainJar = stable ? null : new Map();
  const writes = stable ? [cookieJar] : [chainJar];
  const session = proxyPool.beginSession();
  const perAttemptMs = attempt === 0 ? timeoutMs : Math.min(timeoutMs, 8000);

  let cur = target;
  let m = method;
  let b = body;
  let h = headers;
  const visited = new Map([[target.href, 1]]);

  for (let hop = 0; ; hop++) {
    const reqHeaders = { ...h };
    const cookie = cookiesFor(cur, chainJar, stable);
    if (cookie) reqHeaders.cookie = reqHeaders.cookie ? `${reqHeaders.cookie}; ${cookie}` : cookie;
    else delete reqHeaders.cookie;

    const res = await requestOnce(cur, { method: m, headers: reqHeaders, body: b, timeoutMs: perAttemptMs, insecure, session });
    rememberCookies(cur, res, writes);

    if (!maxRedirects || !REDIRECT_CODES.has(res.status) || !res.headers.location) return res;
    const next = new URL(res.headers.location, cur);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return res;
    if (hop >= maxRedirects) return res;
    // A self-redirect is legitimate ONCE (it carries the clearance cookie);
    // if it happens again nothing was learned and we stop instead of looping.
    const times = (visited.get(next.href) || 0) + 1;
    if (times > 2) return res;
    visited.set(next.href, times);

    // fetch semantics: 303 always becomes GET, 301/302 do for non-GET/HEAD too
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && m !== 'GET' && m !== 'HEAD')) {
      m = 'GET';
      b = undefined;
      const nh = { ...h };
      delete nh['content-type'];
      delete nh['content-length'];
      h = nh;
    }
    cur = next;
  }
}

async function fetchWithTimeout(urlStr, opts = {}, timeoutMs = 12000) {
  let target;
  try { target = new URL(urlStr); } catch (_) { throw new Error(`invalid url ${urlStr}`); }

  const method = String(opts.method || 'GET').toUpperCase();
  const headers = toHeaders(opts.headers);
  const body = opts.body;
  const maxRedirects = opts.redirect === 'manual' ? 0 : (Number(opts.maxRedirects) || MAX_REDIRECTS);
  // Only idempotent calls are retried, so a POST can never be submitted twice.
  const canRetry = opts.retry !== false && (method === 'GET' || method === 'HEAD');
  const attempts = canRetry ? Math.max(1, Math.min(5, Number(opts.retries) || MAX_ATTEMPTS)) : 1;

  let res = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    res = await runChain({
      target, method, headers, body, timeoutMs,
      insecure: !!opts.insecure, maxRedirects, attempt,
    });
    if (attempt === attempts - 1 || !RETRY_CODES.has(res.status)) return res;
    await sleep(retryDelay(res, attempt));
  }
  return res;
}

/* Asks an "am I behind Tor?" service through the CURRENT proxy config, so the
 * dashboard can prove the rotation path really works before a run starts. */
async function exitCheck(timeoutMs = 20000) {
  const started = Date.now();
  let res = await fetchWithTimeout('https://check.torproject.org/api/ip', { headers: { accept: 'application/json' } }, timeoutMs);
  let data = await res.json().catch(() => null);
  if (!data || !(data.IP || data.ip)) {
    res = await fetchWithTimeout('https://api.ipify.org/?format=json', { headers: { accept: 'application/json' } }, timeoutMs);
    data = await res.json().catch(() => null);
  }
  const ip = (data && (data.IP || data.ip)) || null;
  const isTor = data && typeof data.IsTor === 'boolean' ? data.IsTor : null;
  proxyPool.noteExit(ip, isTor);
  return {
    ok: !!ip, status: res.status, ip, isTor,
    ms: Date.now() - started,
    proxy: proxyPool.describe(),
  };
}

module.exports = { fetchWithTimeout, exitCheck, requestOnce, toHeaders, cookieJar };
