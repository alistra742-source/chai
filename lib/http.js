'use strict';
/*
 * SNIPR HTTP client — a small `fetch`-alike built on http/https so that every
 * request can be routed through the rotating proxy layer (lib/proxy.js).
 *
 * The platform checkers call `fetchWithTimeout(url, opts, ms)` exactly like
 * they used to call global fetch, and get back an object with
 * `{ status, ok, headers, text(), json(), url }`. Each call asks the proxy pool
 * for an Agent, so:
 *
 *   - mode "off"  → the default global agent (direct, same as before)
 *   - mode "tor"  → a fresh Tor SOCKS5 tunnel per request (rotating circuit)
 *   - mode "list" → the next proxy in the list
 *
 * Redirects are followed manually (max 5), the body is capped at 8 MB, and
 * `accept-encoding: identity` is sent so nothing has to be gunzipped.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const proxyPool = require('./proxy');

const MAX_BODY = 8 * 1024 * 1024;   // 8 MB is far more than any platform page
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function toHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = String(v);
  }
  if (!out['accept-encoding']) out['accept-encoding'] = 'identity';
  return out;
}

function requestOnce(target, { method, headers, body, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    let agent;
    try { agent = proxyPool.agentFor(target.href); } catch (e) { return reject(e); }

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

async function fetchWithTimeout(urlStr, opts = {}, timeoutMs = 12000) {
  let target;
  try { target = new URL(urlStr); } catch (_) { throw new Error(`invalid url ${urlStr}`); }
  const maxRedirects = opts.redirect === 'manual' ? 0 : 5;
  let method = String(opts.method || 'GET').toUpperCase();
  let body = opts.body;
  let headers = toHeaders(opts.headers);

  for (let hop = 0; ; hop++) {
    const res = await requestOnce(target, { method, headers, body, timeoutMs, insecure: !!opts.insecure });
    if (!maxRedirects || !REDIRECT_CODES.has(res.status) || !res.headers.location) return res;

    const next = new URL(res.headers.location, target);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return res;
    if (hop >= maxRedirects) return res;

    // fetch semantics: 303 always becomes GET, 301/302 do for non-GET/HEAD too
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      const h = toHeaders(opts.headers);
      delete h['content-type'];
      delete h['content-length'];
      headers = h;
    }
    target = next;
  }
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

module.exports = { fetchWithTimeout, exitCheck, requestOnce, toHeaders };
