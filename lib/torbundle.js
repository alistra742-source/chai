'use strict';
/*
 * Tor, provisioned by the app itself.
 *
 * lib/tor.js can run a Tor daemon, but only if a `tor` binary exists — and on a
 * fresh cloud container it never does (`apt-get install tor` has no package
 * lists, and the user has no shell). So "▶ start Tor" used to be a dead button
 * that answered with an install command nobody could run.
 *
 * This module removes that dependency: it fetches the OFFICIAL Tor Expert
 * Bundle from dist.torproject.org, verifies it against the SHA-256 published
 * next to it, and unpacks just the parts we need (`tor/` + the geoip databases)
 * into a cache directory. After that lib/tor.js runs that binary exactly like a
 * system one — only with LD_LIBRARY_PATH pointing at the bundled libevent/ssl,
 * which the expert bundle needs (it is not linked with an rpath).
 *
 * Everything is zero-dependency:
 *   - the download uses `https` / `http` directly (with redirects + progress)
 *   - the archive is unpacked with a small streaming tar reader over
 *     zlib.createGunzip(), so we never depend on the `tar` binary either.
 *
 *   pickVersion(html)                  – newest stable release in the listing
 *   artifactName(version)              – the bundle name for this platform
 *   fetchBuffer(url, opts)             – GET with redirects, cap, progress
 *   extractTarGz(buf, {keep})          – Map<path, {mode, data}>
 *   install({version, dir})            – download + verify + unpack → {bin}
 *   findInstalled({dir})               – reuse a previous install
 *   defaultDir()                       – ~/.snipr/tor (SNIPR_TOR_HOME overrides)
 *
 * Verification is HTTPS + the published checksum: it detects a corrupt or
 * truncated download. It is not a GPG signature check, so it trusts
 * dist.torproject.org's TLS — same trust model as the Tor Browser updater.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');

const BASE = process.env.SNIPR_TOR_MIRROR || 'https://dist.torproject.org/torbrowser/';
const SUMS = 'sha256sums-signed-build.txt';
const MAX_BYTES = 160 * 1024 * 1024;
const DEFAULT_TIMEOUT = 240000;

/* The parts of the bundle we keep: the daemon, its shared libraries and the
 * geoip database (it is what tor reads to label relays). Everything else is
 * dead weight here — the debug symbols, docs, the bridge pluggable transports
 * (~30 MB for lyrebird/conjure alone) and the IPv6 geoip table. */
const KEEP = ['tor/', 'data/geoip'];
const SKIP = ['tor/pluggable_transports/', 'data/geoip6'];

const SUFFIX = {
  'linux-x64': 'linux-x86_64',
  'darwin-x64': 'macos-x86_64',
  'darwin-arm64': 'macos-aarch64',
};

/* ------------------------------- helpers --------------------------------- */

function defaultDir() {
  return process.env.SNIPR_TOR_HOME || path.join(os.homedir(), '.snipr', 'tor');
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function artName(version, platform = process.platform, arch = process.arch) {
  const suffix = SUFFIX[`${platform}-${arch}`];
  return suffix ? `tor-expert-bundle-${suffix}-${version}.tar.gz` : '';
}

/* `artifactName(null)` is a cheap "can this host auto-install at all?" probe. */
function artifactName(version) {
  return version ? artName(version) : SUFFIX[`${process.platform}-${process.arch}`] || '';
}

function supported() {
  return !!SUFFIX[`${process.platform}-${process.arch}`];
}

function unsupportedReason() {
  return `automatic Tor setup has no build for ${process.platform}/${process.arch} — install Tor yourself `
    + '(Debian/Ubuntu: apt-get install tor · macOS: brew install tor), or run Tor Browser and point the route '
    + 'at 127.0.0.1:9150, or use a proxy list';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ---------------------------- release listing ---------------------------- */

/* The directory index has one `<a href="15.0.22/">` per release. Alphas
 * (`16.0a11`) are skipped: the expert bundle only exists for stable builds. */
function pickVersion(html) {
  const versions = [];
  const re = /href="(\d+\.\d+(?:\.\d+)?)\/"/g;
  let m;
  while ((m = re.exec(String(html || '')))) versions.push(m[1]);
  if (!versions.length) return '';
  const key = (v) => v.split('.').map(Number);
  versions.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < 3; i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return versions[versions.length - 1];
}

/* ------------------------------- download -------------------------------- */

function request(url, { timeoutMs = 30000, onResponse } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let mod;
    try {
      mod = new URL(url).protocol === 'http:' ? http : https;
    } catch (e) { return reject(new Error(`bad url ${url}: ${e.message}`)); }
    const req = mod.get(url, { headers: { 'user-agent': 'SNIPR-tor-provision/1.0' } }, (res) => {
      if (settled) { res.resume(); return; }
      settled = true;
      resolve(res);
    });
    req.once('error', (e) => done(reject, new Error(`${url}: ${e.message}`)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`${url}: timed out after ${Math.round(timeoutMs / 1000)}s`)); });
    if (onResponse) req.once('response', onResponse);
  });
}

async function fetchBuffer(url, { timeoutMs = DEFAULT_TIMEOUT, maxBytes = MAX_BYTES, redirects = 5, onProgress } = {}) {
  const res = await request(url, { timeoutMs });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    if (redirects <= 0) throw new Error(`${url}: too many redirects`);
    return fetchBuffer(new URL(res.headers.location, url).toString(), { timeoutMs, maxBytes, redirects: redirects - 1, onProgress });
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`${url}: HTTP ${res.statusCode}`);
  }
  const total = Number(res.headers['content-length']) || 0;
  if (total && total > maxBytes) throw new Error(`${url}: ${Math.round(total / 1048576)} MB is larger than the ${Math.round(maxBytes / 1048576)} MB cap`);
  const chunks = [];
  let got = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      got += c.length;
      if (got > maxBytes) { res.destroy(new Error(`${url}: exceeded the ${Math.round(maxBytes / 1048576)} MB cap`)); return; }
      chunks.push(c);
      if (onProgress) onProgress({ bytes: got, total });
    });
    res.once('error', reject);
    res.once('end', resolve);
  });
  return Buffer.concat(chunks);
}

async function getText(url, opts) {
  return (await fetchBuffer(url, { maxBytes: 8 * 1024 * 1024, ...opts })).toString('utf8');
}

/* sha256sums-signed-build.txt: "<64 hex>  <name>" (sometimes "*<name>"). */
function parseSums(text, name) {
  const want = path.basename(name);
  for (const line of String(text || '').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m && path.basename(m[2]) === want) return m[1];
  }
  return '';
}

/* ---------------------------- the tar reader ------------------------------ */

function readOctal(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readString(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function checksumOk(header) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : header[i];
  return sum === readOctal(header, 148, 8);
}

/*
 * Unpack a .tar.gz held in memory, keeping only the entries `keep` matches.
 * Streaming: bytes are consumed header by header, and the data of entries we do
 * not want is dropped as it arrives instead of being buffered.
 */
function extractTarGz(gzBuffer, { keep, skip } = {}) {
  const wanted = (name) => (!keep || keep.some(k => name === k || name.startsWith(k)))
    && !(skip || []).some(s => name === s || name.startsWith(s));
  const files = new Map();
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let pending = Buffer.alloc(0);
    let entry = null;
    let skip = 0;          // bytes of a member's padding still to drop
    let finished = false;

    const fail = (e) => {
      if (finished) return;
      finished = true;
      gunzip.destroy();
      reject(e);
    };
    const done = () => {
      if (finished) return;
      finished = true;
      gunzip.destroy();
      resolve(files);
    };

    gunzip.once('error', fail);
    gunzip.on('data', (chunk) => {
      if (finished) return;
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        for (;;) {
          // member data is padded to a 512-byte boundary: drop the padding
          // before looking for the next header
          if (skip > 0) {
            if (pending.length === 0) return;
            const take = Math.min(skip, pending.length);
            skip -= take;
            pending = pending.subarray(take);
            if (skip > 0) return;
            continue;
          }
          if (entry) {
            if (pending.length === 0) return;
            const take = Math.min(entry.remaining, pending.length);
            if (entry.data) entry.data.push(Buffer.from(pending.subarray(0, take)));
            entry.remaining -= take;
            pending = pending.subarray(take);
            if (entry.remaining === 0) {
              if (entry.data) files.set(entry.name, { mode: entry.mode, data: Buffer.concat(entry.data) });
              skip = entry.pad;
              entry = null;
            }
            continue;
          }
          if (pending.length < 512) return;
          const header = Buffer.from(pending.subarray(0, 512));
          pending = pending.subarray(512);
          if (header.every(b => b === 0)) continue;              // padding / end of archive
          if (!checksumOk(header)) return fail(new Error('tor archive: corrupt tar header'));
          const type = String.fromCharCode(header[156] || 0x30);
          const name = readString(header, 0, 100).replace(/^\.\//, '').replace(/\/+$/, '');
          const mode = readOctal(header, 100, 8) || 0o644;
          const size = (type === '5' || type === '1' || type === '2') ? 0 : readOctal(header, 124, 12);
          if (!name) continue;
          if (!size) {
            if (wanted(name) && type === '0') files.set(name, { mode, data: Buffer.alloc(0) });
            continue;
          }
          entry = {
            name, mode, remaining: size, pad: (512 - (size % 512)) % 512,
            data: (type === '0' && wanted(name)) ? [] : null,
          };
        }
      } catch (e) { fail(e); }
    });
    gunzip.once('end', done);
    gunzip.end(gzBuffer);
  });
}

/* -------------------------------- install --------------------------------- */

/* Where a previous install lives, newest release first. */
function findInstalled({ dir } = {}) {
  const root = dir || defaultDir();
  let versions;
  try {
    versions = fs.readdirSync(root);
  } catch (_) { return null; }
  const ordered = versions
    .filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))
    .sort((a, b) => {
      const x = a.split('.').map(Number);
      const y = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
      return 0;
    })
    .reverse();
  for (const v of ordered) {
    const bin = path.join(root, v, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor');
    if (isFile(bin)) return { bin, version: v, dir: path.join(root, v) };
  }
  return null;
}

/*
 * Download, verify and unpack the expert bundle. Returns
 * { ok, bin, version, dir, bytes, ms, cached } or throws.
 *
 * `onProgress` gets { phase, version, bytes, total, pct } so the dashboard can
 * show what a 30-second first start is actually doing.
 */
async function install({ version, dir, timeoutMs = DEFAULT_TIMEOUT, onProgress = () => {}, base = BASE } = {}) {
  const started = Date.now();
  const root = dir || defaultDir();
  const report = (s) => { try { onProgress(s); } catch (_) {} };

  if (!version) {
    report({ phase: 'resolving' });
    const listing = await getText(base, { timeoutMs: Math.min(timeoutMs, 30000) });
    version = pickVersion(listing);
    if (!version) throw new Error(`could not find a Tor release list at ${base}`);
  }
  if (!supported()) throw new Error(unsupportedReason());

  const name = artifactName(version);
  // the artifacts live in their own release directory: .../torbrowser/15.0.22/<name>
  const release = `${base.replace(/\/?$/, '/')}${version}/`;
  const target = path.join(root, version);
  const bin = path.join(target, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor');
  if (isFile(bin)) {
    report({ phase: 'ready', version, dir: target, bin });
    return { ok: true, bin, version, dir: target, bytes: 0, ms: Date.now() - started, cached: true };
  }

  report({ phase: 'checksums', version });
  let expected = '';
  try {
    expected = parseSums(await getText(release + SUMS, { timeoutMs: Math.min(timeoutMs, 30000) }), name);
  } catch (_) { /* the listing can be reachable when the sums file is not */ }

  report({ phase: 'downloading', version, bytes: 0, total: 0 });
  const gz = await fetchBuffer(release + name, {
    timeoutMs,
    onProgress: (p) => report({
      phase: 'downloading',
      version,
      bytes: p.bytes,
      total: p.total,
      pct: p.total ? Math.round((p.bytes / p.total) * 100) : 0,
    }),
  });

  report({ phase: 'verifying', version, bytes: gz.length });
  const got = sha256(gz);
  if (expected && got !== expected) {
    throw new Error(`${name} failed its SHA-256 check (published ${expected.slice(0, 12)}…, downloaded ${got.slice(0, 12)}…) — refusing to run it`);
  }
  if (!expected) report({ phase: 'verifying', version, bytes: gz.length, warning: `no published checksum found for ${name}; integrity could not be verified` });

  report({ phase: 'extracting', version, bytes: gz.length });
  const files = await extractTarGz(gz, { keep: KEEP, skip: SKIP });
  if (!files.size) throw new Error(`${name}: no tor binary inside the archive`);

  for (const [rel, f] of files) {
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data, { mode: 0o644 });
  }
  /* The tar's own modes are 0700 and an uploaded file loses its exec bit
   * anyway: make the daemon and its libraries executable, and nothing else. */
  const torDir = path.join(target, 'tor');
  try {
    for (const f of fs.readdirSync(torDir)) {
      const p = path.join(torDir, f);
      if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755);
    }
  } catch (_) {}
  fs.chmodSync(bin, 0o755);

  report({ phase: 'ready', version, dir: target, bin, bytes: gz.length });
  return {
    ok: true, bin, version, dir: target, bytes: gz.length, ms: Date.now() - started, cached: false,
    verified: !!expected, files: files.size,
  };
}

/* ------------------------------ user message ------------------------------ */

function describeInstall(state) {
  if (!state || !state.phase) return '';
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  switch (state.phase) {
    case 'resolving': return 'looking up the current Tor release…';
    case 'checksums': return `downloading Tor ${state.version} · fetching the published checksum…`;
    case 'downloading':
      return state.total
        ? `downloading Tor ${state.version} · ${state.pct}% (${mb(state.bytes)} of ${mb(state.total)})`
        : `downloading Tor ${state.version} · ${mb(state.bytes)}`;
    case 'verifying': return `verifying the Tor download (SHA-256)…`;
    case 'extracting': return `unpacking Tor ${state.version}…`;
    default: return '';
  }
}

module.exports = {
  BASE, SUMS, KEEP, SKIP, MAX_BYTES, SUFFIX,
  defaultDir, findInstalled, install, artifactName, supported, unsupportedReason,
  pickVersion, parseSums, fetchBuffer, getText, extractTarGz, sha256, describeInstall,
};
