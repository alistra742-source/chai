'use strict';
/*
 * Managed local Tor.
 *
 * Tor mode in lib/proxy.js needs a Tor daemon on the machine running this app.
 * That is the single most common reason a route "does not answer"
 * (ECONNREFUSED 127.0.0.1:9050), so this module turns it into something the
 * dashboard can fix instead of a wall of errors:
 *
 *   findBinary()  – is there a `tor` on this host at all? PATH first, then the
 *                   bundle a previous start downloaded (cached)
 *   ensureBinary() – get one: system tor → cached bundle → download the
 *                   official Tor Expert Bundle (lib/torbundle.js). This is what
 *                   makes "▶ start Tor" work on a container with no tor binary
 *                   and no package lists.
 *   discover()    – is a daemon already listening? (9050 = tor, 9150 = Tor
 *                   Browser; the control port is probed the same way)
 *   start()       – run our own: a generated torrc with
 *                   `SocksPort <port> IsolateSOCKSAuth` (one circuit per
 *                   SOCKS5 credential pair, which is what the per-request
 *                   rotation uses) and a control port protected by a random
 *                   HashedControlPassword we generate with `tor --hash-password`
 *                   — so SIGNAL NEWNYM works with no user setup.
 *   stop()        – kill it and remove its DataDirectory.
 *
 * The daemon is a child of this process: it dies with the app (see the `exit`
 * hook) so a preview restart never leaves an orphan holding 9050.
 *
 * The bundle a start downloads is kept (so a restart is instant) and dropped
 * only by the user; if the download fails the answer is still an exact command
 * for the platform plus the two routes that do not need Tor (a proxy list, or
 * direct).
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const torbundle = require('./torbundle');

const EXE = process.platform === 'win32' ? 'tor.exe' : 'tor';
const COMMON_BIN = process.platform === 'darwin'
  ? ['/opt/homebrew/bin/tor', '/usr/local/bin/tor', '/usr/bin/tor']
  : ['/usr/bin/tor', '/usr/sbin/tor', '/usr/local/bin/tor', '/usr/local/sbin/tor', '/snap/bin/tor'];

const DEFAULT_SOCKS_PORT = 9050;      // tor daemon; Tor Browser uses 9150
const DEFAULT_CONTROL_PORT = 9051;    // tor daemon; Tor Browser uses 9151
const DEFAULT_SOCKS_PORTS = [9050, 9150];
const DEFAULT_CONTROL_PORTS = [9051, 9151];
const LOG_KEEP = 8;

const state = {
  child: null, dir: null, bin: null,
  socks: '', control: '', password: '',
  bootstrap: 0, version: '', error: null, startedAt: 0, reused: false, source: '',
  log: [],
  // { phase: resolving|checksums|downloading|verifying|extracting|ready|failed,
  //   version, bytes, total, pct, error } — what a first start is busy with
  install: null,
};

let binCache;       // undefined = not scanned yet, null = scanned and absent
let managedCache;   // same, for the bundle lib/torbundle.js downloaded for us

/* ------------------------------ discovery -------------------------------- */
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/* A tor the user (or the image) installed. */
function findSystemBinary({ refresh = false } = {}) {
  if (binCache !== undefined && !refresh) return binCache;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [...dirs.map(d => path.join(d, EXE)), ...COMMON_BIN];
  binCache = candidates.find(isFile) || null;
  return binCache;
}

/* A tor WE downloaded earlier (lib/torbundle.js). */
function findManagedBinary({ refresh = false } = {}) {
  if (managedCache !== undefined && !refresh) return managedCache;
  managedCache = torbundle.findInstalled();
  return managedCache;
}

function findBinary(opts) {
  return findSystemBinary(opts) || (findManagedBinary(opts) || {}).bin || null;
}

/* The bundled daemon ships its own libevent/openssl and is not linked with an
 * rpath, so it only starts with its directory on the loader path. */
function loaderEnv(binDir) {
  if (!binDir) return null;
  const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const old = process.env[key];
  return { [key]: old ? `${binDir}${path.delimiter}${old}` : binDir };
}

/*
 * Produce a usable tor binary. Order of preference:
 *   1. a tor already on this host (system install, Homebrew, whatever)
 *   2. a bundle a previous start downloaded
 *   3. the official Tor Expert Bundle, downloaded, checksum-verified and
 *      unpacked into the cache dir
 *
 * Returns { ok, bin, source: 'system'|'cache'|'downloaded', version, dir } or
 * { ok:false, error }. `allowDownload:false` stops after step 2.
 */
async function ensureBinary({ allowDownload = true, timeoutMs, onProgress } = {}) {
  const sys = findSystemBinary({ refresh: true });
  if (sys) {
    state.install = { phase: 'ready', source: 'system', bin: sys };
    return { ok: true, bin: sys, source: 'system' };
  }
  const cached = findManagedBinary({ refresh: true });
  if (cached) {
    state.install = { phase: 'ready', source: 'cache', bin: cached.bin, version: cached.version, dir: cached.dir };
    return { ok: true, bin: cached.bin, source: 'cache', version: cached.version, dir: cached.dir };
  }
  if (!allowDownload) {
    const error = torbundle.supported()
      ? 'no tor binary on this host yet — press “▶ start Tor” and the app will fetch the official Tor bundle for you'
      : torbundle.unsupportedReason();
    state.install = { phase: 'failed', error };
    return { ok: false, error };
  }

  state.install = { phase: 'resolving' };
  try {
    const out = await torbundle.install({
      timeoutMs,
      onProgress: (p) => {
        state.install = { ...p, active: p.phase !== 'ready' };
        if (onProgress) { try { onProgress(state.install); } catch (_) {} }
      },
    });
    managedCache = undefined;
    binCache = undefined;
    state.install = {
      phase: 'ready', source: out.cached ? 'cache' : 'downloaded',
      bin: out.bin, version: out.version, dir: out.dir,
      bytes: out.bytes, ms: out.ms, verified: out.verified !== false,
    };
    return { ok: true, bin: out.bin, source: out.cached ? 'cache' : 'downloaded', version: out.version, dir: out.dir, bytes: out.bytes, ms: out.ms };
  } catch (e) {
    const error = `could not fetch a Tor binary: ${e.message}`;
    state.install = { phase: 'failed', error };
    return { ok: false, error };
  }
}

/* What to tell someone whose Tor route cannot be dialled. */
function installHint() {
  const bin = findBinary();
  if (bin) return 'no Tor daemon is running — press “▶ start Tor” to start the one on this host';
  if (!torbundle.supported()) return torbundle.unsupportedReason();
  return 'no Tor daemon is running and no tor binary is installed — press “▶ start Tor”: the app downloads the official Tor bundle '
    + '(~32 MB, checksum-verified, kept for next time), or use a proxy list / set the route to direct';
}

function portFree(host, port, timeoutMs = 400) {
  return new Promise(resolve => {
    let done = false;
    const socket = net.connect({ host, port });
    const fin = (free) => { if (done) return; done = true; socket.destroy(); resolve(free); };
    socket.setTimeout(timeoutMs, () => fin(false));      // something is sitting on it
    socket.once('error', () => fin(true));               // refused = free
    socket.once('connect', () => fin(false));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* Is a SOCKS5 proxy answering here? The greeting is enough — Tor answers
 * [0x05, 0x00] and offers the isolation credentials we ask for below. */
function socksAlive(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    let done = false;
    const socket = net.connect({ host, port });
    const fin = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => fin(false));
    socket.once('error', () => fin(false));
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once('data', chunk => fin(!!chunk && chunk.length > 0 && chunk[0] === 0x05));
  });
}

/* A Tor control port answers PROTOCOLINFO with a 250 banner. */
function controlAlive(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    let done = false;
    const socket = net.connect({ host, port });
    const fin = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => fin(false));
    socket.once('error', () => fin(false));
    socket.once('connect', () => socket.write('PROTOCOLINFO 1\r\n'));
    socket.once('data', chunk => fin(!!chunk && chunk.length > 0));
  });
}

/*
 * Look for a Tor daemon that is ALREADY running on this machine. Used both by
 * the route check (to point at 9150 when the user is running Tor Browser
 * instead of the 9050 daemon they typed) and before we start one ourselves.
 */
async function discover({
  host = '127.0.0.1',
  socksPorts = DEFAULT_SOCKS_PORTS,
  controlPorts = DEFAULT_CONTROL_PORTS,
  timeout = 1200,
} = {}) {
  const socks = [];
  const controls = [];
  await Promise.all([
    ...socksPorts.map(async p => { if (await socksAlive(host, p, timeout)) socks.push(p); }),
    ...controlPorts.map(async p => { if (await controlAlive(host, p, timeout)) controls.push(p); }),
  ]);
  socks.sort((a, b) => a - b);
  controls.sort((a, b) => a - b);
  return {
    ok: socks.length > 0,
    socks: socks.length ? `socks5://${host}:${socks[0]}` : '',
    socksPort: socks[0] || 0,
    control: controls.length ? `${host}:${controls[0]}` : '',
    controlPort: controls[0] || 0,
    ports: { socks, controls },
  };
}

/* ------------------------------ the torrc -------------------------------- */
/*
 * `IsolateSOCKSAuth` is what makes "fresh circuit per request" work: Tor gives
 * a separate circuit to every distinct SOCKS5 username/password pair, and
 * lib/proxy.js mints a throwaway pair per request. `AvoidDiskWrites` keeps the
 * daemon quiet on a container filesystem.
 */
function torrcFor({ host = '127.0.0.1', socksPort = DEFAULT_SOCKS_PORT, controlPort = 0, hash = '', dataDir = '', geoip = '', geoip6 = '' } = {}) {
  const lines = [
    '# generated by SNIPR — managed local Tor daemon',
    `SocksPort ${host}:${socksPort} IsolateSOCKSAuth`,
  ];
  if (controlPort && hash) {
    lines.push(`ControlPort ${host}:${controlPort}`, `HashedControlPassword ${hash}`, 'CookieAuthentication 0');
  }
  lines.push(`DataDirectory ${dataDir}`, 'ClientOnly 1', 'AvoidDiskWrites 1');
  // a downloaded bundle carries its own geoip databases: without these tor
  // logs a failure warning on every start
  if (geoip) lines.push(`GeoIPFile ${geoip}`);
  if (geoip6) lines.push(`GeoIPv6File ${geoip6}`);
  lines.push('Log notice stdout');
  return lines.join('\n') + '\n';
}

/* tor mints the control password hash itself, so the user never sees `tor
 * --hash-password` and the plaintext password never touches the torrc. */
function hashPassword(bin, password, timeoutMs = 15000, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--hash-password', password], {
      stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('tor --hash-password timed out'));
    }, timeoutMs);
    child.stdout.on('data', c => { out += c.toString('utf8'); });
    child.stderr.on('data', c => { err += c.toString('utf8'); });
    child.once('error', e => { clearTimeout(timer); reject(new Error(`tor --hash-password: ${e.message}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      const hash = out.split('\n').map(s => s.trim()).find(s => /^16:[A-Za-z0-9+/=]+$/.test(s));
      if (code !== 0 || !hash) {
        return reject(new Error(`tor --hash-password failed (exit ${code}): ${(err || out).trim().slice(0, 120)}`));
      }
      resolve(hash);
    });
  });
}

/* ------------------------------- start/stop ------------------------------ */
function removeDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function killChild() {
  const child = state.child;
  state.child = null;
  if (!child) return;
  try { child.kill('SIGKILL'); } catch (_) {}
}

function resetState() {
  state.socks = '';
  state.control = '';
  state.password = '';
  state.bootstrap = 0;
  state.reused = false;
  state.log = [];
}

/*
 * Start (or adopt) a Tor daemon and return the route to point the proxy layer
 * at: { ok, socks, control, password, pid, bootstrap, version, ms }.
 *
 * - a SOCKS5 port that already answers is adopted as-is. We did not start it,
 *   so we have no control password for it: SIGNAL NEWNYM rotation is off and
 *   the per-request circuit isolation carries the rotation instead.
 * - `bin` is overridable (tests, or a tor in a non-standard place). Without it
 *   the binary is located or downloaded first (see ensureBinary).
 */
async function start({ host = '127.0.0.1', socksPort, controlPort, bin, timeoutMs = 90000, allowDownload = true, onProgress } = {}) {
  const started = Date.now();
  if (state.child) {
    return { ok: true, reused: true, socks: state.socks, control: state.control, password: state.password,
      pid: state.child.pid, bootstrap: state.bootstrap, version: state.version, ms: 0,
      note: 'a managed Tor daemon is already running' };
  }

  const preferred = Number(socksPort) || DEFAULT_SOCKS_PORT;
  if (await socksAlive(host, preferred)) {
    const found = await discover({ host, socksPorts: [preferred] });
    state.reused = true;
    state.socks = found.socks;
    state.control = '';
    state.password = '';
    state.bootstrap = 100;
    state.startedAt = Date.now();
    state.error = null;
    return { ok: true, reused: true, socks: found.socks, control: '', password: '',
      pid: 0, bootstrap: 100, version: '', ms: Date.now() - started,
      note: `adopted the Tor daemon already listening on ${found.socks}` };
  }

  let exe = bin || '';
  let libDir = '';
  let source = bin ? 'given' : '';
  if (exe) {
    if (!isFile(exe)) {
      const error = `no tor binary at ${exe}`;
      state.error = error;
      return { ok: false, error };
    }
  } else {
    const got = await ensureBinary({ allowDownload, timeoutMs: Math.max(timeoutMs, 240000), onProgress });
    if (!got.ok) {
      state.error = got.error;
      return { ok: false, error: got.error, install: state.install };
    }
    exe = got.bin;
    source = got.source;
    // a bundled daemon needs its own libs on the loader path; a system tor
    // must not inherit ours
    if (got.source !== 'system') libDir = path.dirname(exe);
  }

  // a bundled tor ships its own libevent/openssl: every invocation of it —
  // --hash-password included — needs them on the loader path
  const env = loaderEnv(libDir);

  let password = '';
  let hash = '';
  let note = null;
  try {
    password = crypto.randomBytes(16).toString('hex');
    hash = await hashPassword(exe, password, 15000, env);
  } catch (e) {
    password = '';
    hash = '';
    note = `control port disabled (${e.message}) — rotation falls back to per-request circuit isolation`;
  }

  const port = Number(socksPort) || ((await portFree(host, DEFAULT_SOCKS_PORT)) ? DEFAULT_SOCKS_PORT : await freePort());
  const ctl = !hash ? 0
    : Number(controlPort) || ((await portFree(host, DEFAULT_CONTROL_PORT)) ? DEFAULT_CONTROL_PORT : await freePort());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipr-tor-'));
  const torrcPath = path.join(dir, 'torrc');
  const data = libDir ? path.join(path.dirname(libDir), 'data') : '';
  const geoip = data && isFile(path.join(data, 'geoip')) ? path.join(data, 'geoip') : '';
  const geoip6 = data && isFile(path.join(data, 'geoip6')) ? path.join(data, 'geoip6') : '';
  fs.writeFileSync(torrcPath, torrcFor({ host, socksPort: port, controlPort: ctl, hash, dataDir: dir, geoip, geoip6 }), { mode: 0o600 });

  const child = spawn(exe, ['-f', torrcPath], { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
  state.child = child;
  state.dir = dir;
  state.bin = exe;
  state.socks = `socks5://${host}:${port}`;
  state.control = ctl ? `${host}:${ctl}` : '';
  state.password = password;
  state.bootstrap = 0;
  state.error = null;
  state.startedAt = Date.now();
  state.reused = false;
  state.log = [];
  state.source = source;

  return await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!out.ok) {
        // never leave a half-bootstrapped daemon holding the port
        try { child.kill('SIGKILL'); } catch (_) {}
        if (state.child === child) { state.child = null; state.error = out.error; }
        removeDir(state.dir);
        state.dir = null;
      }
      resolve(out);
    };
    const onLine = (line) => {
      const text = String(line).trim();
      if (!text) return;
      state.log.push(text);
      if (state.log.length > LOG_KEEP) state.log.shift();
      const boot = text.match(/Bootstrapped (\d+)% \((.*?)\)/);
      if (boot) state.bootstrap = Number(boot[1]);
      // "Tor 0.4.9.12 running on Linux …" at startup, "Tor version …" elsewhere
      const ver = text.match(/Tor (?:version )?([0-9][0-9.]*[0-9])\b/);
      if (ver) state.version = ver[1];
      if (boot && state.bootstrap >= 100) {
        finish({ ok: true, reused: false, socks: state.socks, control: state.control, password,
          pid: child.pid, bootstrap: 100, version: state.version, ms: Date.now() - started, dir, note, source: state.source });
      }
    };
    const consume = (stream) => {
      let buf = '';
      stream.on('data', chunk => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          onLine(line);
        }
      });
    };
    consume(child.stdout);
    consume(child.stderr);

    timer = setTimeout(() => finish({
      ok: false,
      error: `tor did not finish bootstrapping within ${Math.round(timeoutMs / 1000)}s — last output: ${state.log[state.log.length - 1] || 'nothing'}`,
    }), timeoutMs);
    if (timer.unref) timer.unref();

    child.once('error', e => finish({ ok: false, error: `cannot run ${exe}: ${e.message}` }));
    child.once('exit', (code, signal) => {
      if (settled) return;
      finish({ ok: false, error: `tor exited (${signal || code}) before bootstrapping — last output: ${state.log[state.log.length - 1] || 'nothing'}` });
    });
  });
}

async function stop() {
  const child = state.child;
  if (!child) {
    removeDir(state.dir);
    state.dir = null;
    state.error = null;
    resetState();
    return { ok: true, stopped: false };
  }
  state.child = null;
  await new Promise(resolve => {
    let done = false;
    let timer = null;
    const fin = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', fin);
    try { child.kill('SIGTERM'); } catch (_) { fin(); }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} fin(); }, 4000);
    if (timer.unref) timer.unref();
  });
  removeDir(state.dir);
  state.dir = null;
  state.error = null;
  resetState();
  return { ok: true, stopped: true };
}

function status() {
  const bin = findBinary();
  return {
    installed: !!bin,
    binary: bin,
    // can this host auto-fetch Tor at all (linux x64 / macOS)?
    canInstall: torbundle.supported(),
    // what the last (or in-flight) fetch is doing, so the dashboard can show it
    install: state.install,
    running: !!state.child,
    reused: state.reused,
    pid: state.child ? state.child.pid : 0,
    socks: state.socks,
    control: state.control,
    hasPassword: !!state.password,
    bootstrap: state.bootstrap,
    version: state.version,
    source: state.source,
    startedAt: state.startedAt,
    error: state.error,
    log: state.log.slice(-4),
  };
}

/* A managed daemon must not outlive the app (or a preview restart would leave
 * an orphan holding 9050). SIGKILL is synchronous enough for an `exit` hook. */
process.once('exit', () => {
  killChild();
  removeDir(state.dir);
});

module.exports = {
  findBinary, findSystemBinary, findManagedBinary, ensureBinary, installHint,
  discover, start, stop, status,
  torrcFor, hashPassword, socksAlive, controlAlive, portFree, freePort, loaderEnv,
  DEFAULT_SOCKS_PORT, DEFAULT_CONTROL_PORT, DEFAULT_SOCKS_PORTS, DEFAULT_CONTROL_PORTS,
  state,
};
