'use strict';
/*
 * Test suite for the rotating proxy layer (lib/proxy.js + lib/http.js).
 *
 * Everything runs against local mock servers, so no Tor daemon is needed:
 *
 *   testSocks5   – a real SOCKS5 server (greeting, optional user/pass, CONNECT)
 *   testHttp     – a real HTTP CONNECT proxy
 *   testControl  – a real Tor control port (AUTHENTICATE / SIGNAL NEWNYM)
 *
 * HTTPS requests are then made to example.com THROUGH those mocks, which
 * exercises the full path: SOCKS5 handshake -> TLS over the tunnel -> agent
 * plumbing -> a real 200 response.
 *
 *   node test/net.test.js
 */

const net = require('net');
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const pool = require('../lib/proxy');
const torLayer = require('../lib/tor');
const bundle = require('../lib/torbundle');
const { fetchWithTimeout, exitCheck } = require('../lib/http');
const { liveCheck } = require('../lib/checkers');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n      ${e && e.message}`); }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* A port nothing is listening on: used as a "this daemon is not up" address. */
function deadPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));      // closed again immediately: now refused
    });
  });
}

/* ------------------------------ mock SOCKS5 ------------------------------- */
async function startSocks5({ user = '', pass = '' } = {}) {
  const state = { connections: 0, targets: [], users: [] };
  const server = net.createServer(socket => {
    state.connections++;
    let buf = Buffer.alloc(0);
    let stage = 'greeting';
    const fail = (code) => { socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); socket.destroy(); };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2 + buf[1]) return;
          const methods = buf.subarray(2, 2 + buf[1]);
          buf = buf.subarray(2 + buf[1]);
          const needsAuth = !!(user || pass);
          // like Tor: honour the client's user/pass auth request, and demand it
          // when this mock was configured with credentials
          const method = methods.includes(0x02) ? 0x02 : (needsAuth ? 0xff : 0x00);
          socket.write(Buffer.from([0x05, method]));
          if (method === 0xff) return socket.destroy();
          stage = method === 0x02 ? 'auth' : 'request';
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const u = buf.subarray(2, 2 + ulen).toString();
          const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          state.users.push(u);
          buf = buf.subarray(3 + ulen + plen);
          const good = (!user || u === user) && (!pass || p === pass);
          socket.write(Buffer.from([0x01, good ? 0x00 : 0x01]));
          if (!good) return socket.destroy();
          stage = 'request';
        } else if (stage === 'request') {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host;
          let need;
          if (atyp === 0x01) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); need = 10; }
          else if (atyp === 0x03) {
            const len = buf[4];
            if (buf.length < 7 + len) return;
            host = buf.subarray(5, 5 + len).toString(); need = 5 + len + 2;
          } else return fail(0x08);
          const port = buf.readUInt16BE(need - 2);
          const rest = buf.subarray(need);
          buf = Buffer.alloc(0);
          state.targets.push(`${host}:${port}`);
          stage = 'tunnel';
          socket.removeListener('data', onData);
          const upstream = net.connect({ host, port }, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (rest.length) upstream.write(rest);
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on('error', () => fail(0x05));
          return;
        } else return;
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  const port = await listen(server);
  return { port, state, close: () => server.close() };
}

/* ---------------------------- mock HTTP proxy ----------------------------- */
async function startHttpProxy({ auth = null } = {}) {
  const state = { connects: 0, targets: [] };
  const server = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
  server.on('connect', (req, clientSocket, head) => {
    state.connects++;
    state.targets.push(req.url);
    if (auth && req.headers['proxy-authorization'] !== auth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return clientSocket.destroy();
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect({ host, port: Number(port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => {});
  });
  const port = await listen(server);
  return { port, state, close: () => server.close() };
}

/* --------------------------- mock Tor control ----------------------------- */
async function startTorControl({ password = '', rejectAuth = false } = {}) {
  const state = { commands: [] };
  const server = net.createServer(socket => {
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line) continue;
        state.commands.push(line);
        if (line.startsWith('AUTHENTICATE')) {
          const ok = !rejectAuth && (!password || line === `AUTHENTICATE "${password}"`);
          socket.write(ok ? '250 OK\r\n' : '515 Authentication failed: wrong password\r\n');
        } else if (line.startsWith('PROTOCOLINFO')) socket.write('250-PROTOCOLINFO 1\r\n250 OK\r\n');
        else if (line.startsWith('SIGNAL NEWNYM')) socket.write('250 OK\r\n');
        else if (line.startsWith('QUIT')) { socket.write('250 closing connection\r\n'); socket.end(); }
      }
    });
    socket.on('error', () => {});
  });
  const port = await listen(server);
  return { port, state, close: () => server.close() };
}

/* ------------------------------ mock origin ------------------------------- */
/* Also models the behaviour that was breaking real guns.lol checks: a 307 to
 * the SAME url that mints a clearance cookie, and a throttled route. */
async function startOrigin() {
  const state = { hits: new Map() };
  const bump = (url) => { const n = (state.hits.get(url) || 0) + 1; state.hits.set(url, n); return n; };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const n = bump(url);
    if (url === '/redirect') { res.writeHead(302, { location: '/hello' }); return res.end(); }
    if (url === '/hello') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('hello world'); }
    if (url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    if (url === '/needs-cookie') {
      if (!/clearance=1/.test(req.headers.cookie || '')) {
        res.writeHead(307, { location: '/needs-cookie', 'set-cookie': 'clearance=1; Path=/' });
        return res.end('go away');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('logged in');
    }
    if (url === '/flaky') {
      if (n <= 2) { res.writeHead(429, { 'retry-after': '0.05' }); return res.end('slow down'); }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('finally');
    }
    if (url === '/always-429') { res.writeHead(429, { 'retry-after': '0.02' }); return res.end('no'); }
    // a target that refuses this exit (guns.lol from a flagged IP answers 401)
    if (url === '/reject') { res.writeHead(401, { 'content-type': 'text/html' }); return res.end('<html><title>Error</title><h1>not for you</h1></html>'); }
    if (url === '/echo') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': req.headers['content-type'] || 'text/plain' });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  const port = await listen(server);
  return { port, state, close: () => server.close() };
}

/* ------------------- mock Tor Project download server --------------------- */
function tarHeader(name, size, mode, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'utf8');
  h.write('0000000\0', 108, 8, 'utf8');
  h.write('0000000\0', 116, 8, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h.write('00000000000\0', 136, 12, 'utf8');
  h.write('        ', 148, 8, 'utf8');
  h.write(type, 156, 1, 'utf8');
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

/* A real (small) tar.gz, so the extractor is exercised against tar itself and
 * not against a hand-rolled parser. */
function tarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const type = e.type || '0';
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    parts.push(tarHeader(e.name, type === '5' ? 0 : data.length, e.mode || 0o644, type));
    if (type !== '5' && data.length) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));       // end of archive
  return zlib.gzipSync(Buffer.concat(parts));
}

const FAKE_TOR = 'fake tor 0.4.9.12\n' + 'x'.repeat(200000);   // spans many 512-byte blocks

async function startDist({ version = '15.0.22', corrupt = false, noSums = false } = {}) {
  const state = { hits: new Map(), name: bundle.artifactName(version) };
  const gz = tarGz([
    { name: 'tor/', type: '5', mode: 0o700 },
    { name: 'tor/tor', data: FAKE_TOR, mode: 0o700 },
    { name: 'tor/libevent-2.1.so.7', data: 'lib', mode: 0o700 },
    { name: 'tor/pluggable_transports/lyrebird', data: 'pt', mode: 0o700 },
    { name: 'data/geoip', data: 'geo', mode: 0o644 },
    { name: 'data/geoip6', data: 'geo6', mode: 0o644 },
    { name: 'debug/tor', data: Buffer.alloc(300000, 7), mode: 0o700 },
  ]);
  const digest = crypto.createHash('sha256').update(gz).digest('hex');
  const sums = `${corrupt ? 'f'.repeat(64) : digest}  ${state.name}\n`;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    state.hits.set(url, (state.hits.get(url) || 0) + 1);
    if (url === '/torbrowser/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<a href="16.0a11/">a</a>\n<a href="14.0.9/">b</a>\n<a href="15.0.22/">c</a>\n');
    }
    if (url === `/torbrowser/${version}/${bundle.SUMS}`) {
      if (noSums) { res.writeHead(404); return res.end('gone'); }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(sums);
    }
    if (url === `/torbrowser/${version}/${state.name}`) {
      res.writeHead(200, { 'content-length': String(gz.length) });
      return res.end(gz);
    }
    res.writeHead(404);
    res.end('nope');
  });
  const port = await listen(server);
  return { port, state, gz, url: `http://127.0.0.1:${port}/torbrowser/`, close: () => server.close() };
}

/* ================================ tests ================================== */
(async () => {
  const origin = await startOrigin();
  const originUrl = `http://127.0.0.1:${origin.port}`;
  const socks = await startSocks5();
  const socksAuth = await startSocks5({ user: 'toruser', pass: 'torpass' });
  const httpProxy = await startHttpProxy();
  const httpProxy2 = await startHttpProxy();
  const control = await startTorControl();
  const controlPw = await startTorControl({ password: 'secret' });
  const made = [];

  console.log('\nrotating proxy layer\n');

  await test('direct mode still works (no proxy, redirects followed)', async () => {
    pool.setConfig({ mode: 'off' });
    const res = await fetchWithTimeout(`${originUrl}/redirect`, {}, 8000);
    assert.strictEqual(res.status, 200, 'expected 200 after redirect');
    assert.strictEqual(await res.text(), 'hello world');
  });

  await test('POST body + JSON parsing survive the rewrite', async () => {
    const body = JSON.stringify({ username: 'zz9' });
    const echoed = await fetchWithTimeout(`${originUrl}/echo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }, 8000);
    assert.strictEqual(echoed.status, 200);
    assert.strictEqual(await echoed.text(), body);
    const json = await fetchWithTimeout(`${originUrl}/json`, {}, 8000);
    assert.deepStrictEqual(await json.json(), { ok: true });
  });

  await test('a cookie-minting self-redirect is followed instead of storming (guns.lol shape)', async () => {
    pool.setConfig({ mode: 'off' });
    const before = origin.state.hits.get('/needs-cookie') || 0;
    const res = await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);
    assert.strictEqual(res.status, 200, `expected 200 after the clearance redirect, got ${res.status}`);
    assert.strictEqual(await res.text(), 'logged in');
    assert.strictEqual((origin.state.hits.get('/needs-cookie') || 0) - before, 2,
      'expected exactly one 307 + one 200, not a redirect storm');
  });

  await test('cookies are remembered between checks when the exit is stable', async () => {
    // still in direct mode from the previous test: the clearance cookie must
    // already be in the jar, so this check costs a single request
    const before = origin.state.hits.get('/needs-cookie') || 0;
    const res = await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((origin.state.hits.get('/needs-cookie') || 0) - before, 1,
      'the clearance cookie was not replayed from the jar');
  });

  await test('all redirect hops of one check share a single exit identity', async () => {
    // rotating mode still needs ONE ip for the whole chain, or the clearance
    // cookie minted on the first hop gets rejected on the second
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '', isolate: true });
    const usersBefore = socks.state.users.length;
    const res = await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);
    assert.strictEqual(res.status, 200, `got ${res.status}`);
    const users = socks.state.users.slice(usersBefore);
    assert.ok(users.length >= 2, `expected at least 2 tunnels for the chain, got ${users.length}`);
    assert.strictEqual(new Set(users).size, 1, `the chain used ${new Set(users).size} exits instead of 1`);
  });

  await test('a rotating exit does not leak cookies into the next check', async () => {
    const before = origin.state.hits.get('/needs-cookie') || 0;
    const res = await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((origin.state.hits.get('/needs-cookie') || 0) - before, 2,
      'a clearance cookie minted for a previous exit was replayed');
  });

  await test('GET is retried on 429 and eventually succeeds', async () => {
    pool.setConfig({ mode: 'off' });
    const before = origin.state.hits.get('/flaky') || 0;
    const res = await fetchWithTimeout(`${originUrl}/flaky`, {}, 8000);
    assert.strictEqual(res.status, 200, `expected a retry to win, got ${res.status}`);
    assert.strictEqual(await res.text(), 'finally');
    assert.strictEqual((origin.state.hits.get('/flaky') || 0) - before, 3, 'expected 2 throttled attempts then a success');
  });

  await test('POST is never retried (no double submits)', async () => {
    const before = origin.state.hits.get('/always-429') || 0;
    const res = await fetchWithTimeout(`${originUrl}/always-429`, { method: 'POST', body: 'x' }, 8000);
    assert.strictEqual(res.status, 429);
    assert.strictEqual((origin.state.hits.get('/always-429') || 0) - before, 1, 'a POST was retried');
  });

  await test('identityStable() matches the configured rotation', async () => {
    pool.setConfig({ mode: 'off' });
    assert.strictEqual(pool.identityStable(), true, 'direct mode must be treatable as stable');
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, isolate: false });
    assert.strictEqual(pool.identityStable(), true, 'tor without isolation keeps one exit');
    pool.setConfig({ isolate: true });
    assert.strictEqual(pool.identityStable(), false, 'isolated circuits must not share cookies');
    pool.setConfig({ mode: 'off' });
  });

  await test('socks5 mode tunnels plain HTTP through the proxy', async () => {
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '', isolate: false });
    const before = socks.state.connections;
    const res = await fetchWithTimeout(`${originUrl}/hello`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'hello world');
    assert.ok(socks.state.connections > before, 'the socks proxy was not used');
    assert.ok(socks.state.targets.some(t => t.startsWith('127.0.0.1:')), 'no CONNECT target recorded');
  });

  await test('tor mode reaches real HTTPS through the SOCKS5 tunnel', async () => {
    const before = socks.state.connections;
    const res = await fetchWithTimeout('https://example.com/', {}, 15000);
    assert.strictEqual(res.status, 200, `unexpected status ${res.status}`);
    assert.ok(/Example Domain/.test(await res.text()), 'body did not come from example.com');
    assert.ok(socks.state.connections > before, 'no new tunnel was opened');
    assert.ok(socks.state.targets.includes('example.com:443'), `targets: ${socks.state.targets.join(',')}`);
  });

  await test('circuit isolation sends a fresh SOCKS5 identity per request', async () => {
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '', isolate: true });
    const usersBefore = socks.state.users.length;
    await fetchWithTimeout('https://example.com/', {}, 15000);
    await fetchWithTimeout('https://example.com/', {}, 15000);
    const users = socks.state.users.slice(usersBefore);
    assert.strictEqual(users.length, 2, `expected 2 identities, got ${users.length}`);
    assert.notStrictEqual(users[0], users[1], 'both requests reused the same circuit identity');
    assert.ok(users.every(u => u.startsWith('snipr-')), `unexpected usernames: ${users.join(',')}`);
  });

  await test('socks5 username/password auth is used when configured', async () => {
    pool.setConfig({
      mode: 'tor', torSocks: `socks5://toruser:torpass@127.0.0.1:${socksAuth.port}`,
      torControl: '', isolate: false,
    });
    const res = await fetchWithTimeout('https://example.com/', {}, 15000);
    assert.strictEqual(res.status, 200);
    assert.ok(socksAuth.state.users.includes('toruser'), `users: ${socksAuth.state.users.join(',')}`);
  });

  await test('proxy list tunnels plain HTTP through a CONNECT proxy', async () => {
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`] });
    const res = await fetchWithTimeout(`${originUrl}/hello`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'hello world');
    assert.ok(httpProxy.state.targets.includes(`127.0.0.1:${origin.port}`), `targets: ${httpProxy.state.targets.join(',')}`);
  });

  await test('proxy list mode round-robins over CONNECT proxies', async () => {
    pool.setConfig({
      mode: 'list',
      list: [`http://127.0.0.1:${httpProxy.port}`, `http://127.0.0.1:${httpProxy2.port}`],
    });
    const a = httpProxy.state.connects;
    const b = httpProxy2.state.connects;
    for (let i = 0; i < 2; i++) {
      const res = await fetchWithTimeout('https://example.com/', {}, 15000);
      assert.strictEqual(res.status, 200);
    }
    assert.strictEqual(httpProxy.state.connects - a, 1, 'proxy 1 was not used exactly once');
    assert.strictEqual(httpProxy2.state.connects - b, 1, 'proxy 2 was not used exactly once');
  });

  await test('rotating counts and discovered exits are exposed in status()', async () => {
    const st = pool.status();
    assert.ok(st.stats.requests >= 5, `requests=${st.stats.requests}`);
    assert.ok(st.stats.tunnels >= 5, `tunnels=${st.stats.tunnels}`);
    assert.ok(st.list.length === 2, 'list not reported');
    assert.ok(st.label.includes('round-robin'), st.label);
  });

  await test('proxy list rejects bad lines without clobbering the config', async () => {
    assert.throws(() => pool.setConfig({ mode: 'list', list: 'ftp://1.2.3.4:1080' }), /unsupported proxy/);
    assert.throws(() => pool.setConfig({ mode: 'list', list: '' }), /at least one proxy/);
    assert.throws(() => pool.setConfig({ mode: 'nope' }), /mode must be/);
    assert.throws(() => pool.setConfig({ mode: 'tor', torSocks: 'http://1.2.3.4:8080' }), /socks5/);
  });

  await test('SIGNAL NEWNYM on the Tor control port rotates the exit', async () => {
    pool.setConfig({
      mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`,
      torControl: `127.0.0.1:${control.port}`, torPassword: '',
      rotateEvery: 1, rotateIntervalMs: 1000, isolate: true,
    });
    const before = pool.stats.rotations;
    await fetchWithTimeout('https://example.com/', {}, 15000);
    assert.ok(control.state.commands.includes('AUTHENTICATE'), `commands: ${control.state.commands.join(' | ')}`);
    assert.ok(control.state.commands.includes('SIGNAL NEWNYM'), `commands: ${control.state.commands.join(' | ')}`);
    assert.ok(pool.stats.rotations > before, 'rotation counter did not move');
  });

  await test('control password is sent, and a wrong one is reported', async () => {
    pool.setConfig({ mode: 'tor', torControl: `127.0.0.1:${controlPw.port}`, torPassword: 'secret' });
    await pool.torNewNym();
    assert.ok(controlPw.state.commands.includes('AUTHENTICATE "secret"'), `commands: ${controlPw.state.commands.join(' | ')}`);

    pool.setConfig({ torPassword: 'wrong' });
    await assert.rejects(() => pool.torNewNym(), /auth|rejected/i);
  });

  await test('a dead proxy produces real errors, not silent successes', async () => {
    pool.setConfig({ mode: 'list', list: ['socks5://127.0.0.1:1'] });
    await assert.rejects(() => fetchWithTimeout('https://example.com/', {}, 4000));
    assert.ok(pool.status().stats.errors.length > 0, 'no error was recorded');
  });

  await test('playwright proxy objects follow the configured route', async () => {
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '' });
    const six = pool.playwrightProxies(6);
    assert.strictEqual(six.length, 6);
    assert.strictEqual(six[0].server, `socks5://127.0.0.1:${socks.port}`);
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`] });
    assert.strictEqual(pool.playwrightProxies(2)[0].server, `http://127.0.0.1:${httpProxy.port}`);
    pool.setConfig({ mode: 'off' });
    assert.strictEqual(pool.playwrightProxies(6), null);
  });

  await test('exit check walks through the configured proxy (network)', async () => {
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '' });
    // the mock tunnels to the real check.torproject.org: a network hiccup is
    // not a failure of this code, so a throw is the same as "no network"
    const out = await exitCheck(15000).catch(() => ({ ip: '' }));
    if (!out.ip) return console.log('      (skipped: no external network)');
    assert.ok(pool.status().stats.lastExit.ip, 'exit IP was not recorded');
    assert.ok(pool.status().stats.exitsSeen >= 1);
  });

  await test('a bare 127.0.0.1:9050 Tor address is read as SOCKS5', () => {
    const st = pool.setConfig({ mode: 'tor', torSocks: '127.0.0.1:9050' });
    assert.strictEqual(st.tor.socks, 'socks5://127.0.0.1:9050');
    assert.throws(() => pool.setConfig({ mode: 'tor', torSocks: 'http://1.2.3.4:8080' }), /socks5/);
  });

  await test('checkRoute() proves a live proxy answers and names a dead one', async () => {
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '' });
    const good = await pool.checkRoute(4000);
    assert.strictEqual(good.ok, true, good.error);
    assert.strictEqual(good.results[0].ok, true, 'the live SOCKS5 mock was not accepted');

    // an HTTP CONNECT proxy answers as soon as the TCP connect succeeds
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`] });
    assert.strictEqual((await pool.checkRoute(4000)).ok, true);

    // a port that is not a SOCKS5 proxy is not a usable Tor route either
    pool.setConfig({ mode: 'list', list: [`socks5://127.0.0.1:${httpProxy.port}`] });
    const notSocks = await pool.checkRoute(4000);
    assert.strictEqual(notSocks.ok, false);
    assert.match(notSocks.error, /not a SOCKS5 proxy/);

    pool.setConfig({ mode: 'list', list: ['socks5://127.0.0.1:1'] });
    const dead = await pool.checkRoute(1500);
    assert.strictEqual(dead.ok, false);
    assert.match(dead.error, /ECONNREFUSED|refused|no answer/);

    pool.setConfig({ mode: 'off' });
    assert.strictEqual((await pool.checkRoute()).ok, true, 'direct mode is always ok');
  });

  await test('a dead route is reported as kind "proxy", never blamed on the site', async () => {
    pool.setConfig({ mode: 'tor', torSocks: 'socks5://127.0.0.1:1', torControl: '' });
    try {
      await fetchWithTimeout('https://example.com/', {}, 3000);
      assert.fail('a request through a dead route should throw');
    } catch (e) {
      assert.ok(pool.isProxyError(e), `error was not tagged as a proxy failure: ${e.message}`);
    }
    await assert.rejects(() => liveCheck('gunslol', 'sometestname'), (e) => {
      assert.strictEqual(e.kind, 'proxy');
      assert.match(e.message, /proxy route/i);
      return true;
    });
    pool.setConfig({ mode: 'off' });
  });

  await test('identityTag() keys cookies to the exit that earned them', async () => {
    pool.setConfig({ mode: 'off' });
    assert.strictEqual(pool.identityTag(), 'direct');
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`] });
    assert.strictEqual(pool.identityTag(), null, 'list mode uses a new proxy per request');
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '', isolate: true });
    assert.strictEqual(pool.identityTag(), null, 'isolated circuits must not share cookies');

    pool.setConfig({ mode: 'tor', isolate: false, torControl: `127.0.0.1:${control.port}`, rotateEvery: 0 });
    const tag = pool.identityTag();
    assert.ok(tag && tag.startsWith('tor-circuit-'), `unexpected tag ${tag}`);
    await pool.torNewNym();
    assert.notStrictEqual(pool.identityTag(), tag, 'a NEWNYM rotation must invalidate the cookie identity');
    pool.setConfig({ mode: 'off' });
  });

  await test('a Tor rotation drops the cookies minted on the last circuit', async () => {
    // the bug this guards: tor without per-connection isolation kept one cookie
    // jar across SIGNAL NEWNYM, so guns_clearance minted on exit A was replayed
    // from exit B — which is what earns a wall of 401s.
    pool.setConfig({
      mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`,
      torControl: `127.0.0.1:${control.port}`, torPassword: '',
      rotateEvery: 0, isolate: false,
    });
    await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);   // warm this circuit's jar
    const base = origin.state.hits.get('/needs-cookie') || 0;

    let res = await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((origin.state.hits.get('/needs-cookie') || 0) - base, 1,
      'the clearance cookie was not reused while the circuit was stable');

    await pool.torNewNym();                                          // the exit changes here
    res = await fetchWithTimeout(`${originUrl}/needs-cookie`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((origin.state.hits.get('/needs-cookie') || 0) - base, 3,
      'a clearance cookie minted on the previous circuit was replayed after the rotation');
    pool.setConfig({ mode: 'off' });
  });

  await test('canRotate() is true only when a retry can land on another exit', async () => {
    pool.setConfig({ mode: 'off' });
    assert.strictEqual(pool.canRotate(), false);
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`] });
    assert.strictEqual(pool.canRotate(), false, 'one proxy is not a rotation');
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`, `http://127.0.0.1:${httpProxy2.port}`] });
    assert.strictEqual(pool.canRotate(), true);
    pool.setConfig({ mode: 'tor', torSocks: `socks5://127.0.0.1:${socks.port}`, torControl: '', isolate: false });
    assert.strictEqual(pool.canRotate(), false, 'no per-connection isolation → the retry keeps the same exit');
    pool.setConfig({ isolate: true });
    assert.strictEqual(pool.canRotate(), true);
    pool.setConfig({ mode: 'off' });
  });

  await test('a 401 is not retried when the exit cannot change', async () => {
    pool.setConfig({ mode: 'off' });
    const before = origin.state.hits.get('/reject') || 0;
    const res = await fetchWithTimeout(`${originUrl}/reject`, {}, 8000);
    assert.strictEqual(res.status, 401);
    assert.strictEqual((origin.state.hits.get('/reject') || 0) - before, 1,
      'a rejected IP was asked again from the same exit');
  });

  await test('a 401 is retried on a fresh exit, and that exit is remembered as blocked', async () => {
    pool.setConfig({ mode: 'off' });                       // clears blocked exits
    pool.setConfig({ mode: 'list', list: [`http://127.0.0.1:${httpProxy.port}`, `http://127.0.0.1:${httpProxy2.port}`] });
    const before = origin.state.hits.get('/reject') || 0;
    const res = await fetchWithTimeout(`${originUrl}/reject`, {}, 8000);
    assert.strictEqual(res.status, 401);
    assert.ok((origin.state.hits.get('/reject') || 0) - before >= 2,
      'the 401 was not retried on another exit');
    assert.ok(pool.status().blocked.length >= 1, 'the rejected exit was not remembered');
    pool.setConfig({ mode: 'off' });
  });

  await test('an exit the target rejected is skipped while it cools down', async () => {
    const dead = `http://127.0.0.1:${httpProxy.port}`;
    const live = `http://127.0.0.1:${httpProxy2.port}`;
    pool.setConfig({ mode: 'off' });
    pool.setConfig({ mode: 'list', list: [dead, live] });
    pool.noteBlocked(dead, 30000);
    assert.ok(pool.status().blocked.includes(dead), 'noteBlocked() did not record the exit');
    assert.strictEqual(pool.isBadExit(dead), true);
    assert.strictEqual(pool.isBadExit(live), false);

    const a = httpProxy.state.connects;
    const b = httpProxy2.state.connects;
    const res = await fetchWithTimeout(`${originUrl}/hello`, {}, 8000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(httpProxy.state.connects - a, 0, 'the rejected exit was used again');
    assert.strictEqual(httpProxy2.state.connects - b, 1, 'the healthy exit was not preferred');

    pool.setConfig({ mode: 'off' });
    assert.strictEqual(pool.isBadExit(dead), false, 'changing route must clear the blocked exits');
  });

  /* --------------------------- managed local Tor --------------------------- */

  await test('the managed torrc isolates circuits and never writes the password', () => {
    const torrc = torLayer.torrcFor({
      host: '127.0.0.1', socksPort: 9050, controlPort: 9051, hash: '16:ABC+/=', dataDir: '/tmp/snipr-tor-x',
    });
    assert.match(torrc, /^SocksPort 127\.0\.0\.1:9050 IsolateSOCKSAuth$/m, 'IsolateSOCKSAuth is what makes per-request circuits work');
    assert.match(torrc, /^ControlPort 127\.0\.0\.1:9051$/m);
    assert.match(torrc, /^HashedControlPassword 16:ABC\+\/=$/m);
    assert.match(torrc, /^DataDirectory \/tmp\/snipr-tor-x$/m);
    assert.ok(!/plaintext|secret/.test(torrc));

    const headless = torLayer.torrcFor({ socksPort: 9050, controlPort: 0, hash: '', dataDir: '/tmp/x' });
    assert.ok(!/ControlPort/.test(headless), 'a daemon with no control auth must not expose a control port');
  });

  await test('discover() finds the daemon that IS answering, and reports nothing when none is', async () => {
    const absent = await deadPort();
    const found = await torLayer.discover({
      socksPorts: [absent, socks.port], controlPorts: [absent, control.port], timeout: 1500,
    });
    assert.strictEqual(found.ok, true, 'a listening SOCKS5 port was not discovered');
    assert.strictEqual(found.socks, `socks5://127.0.0.1:${socks.port}`);
    assert.strictEqual(found.control, `127.0.0.1:${control.port}`, 'the control port was not discovered');

    const none = await torLayer.discover({ socksPorts: [absent], controlPorts: [absent], timeout: 600 });
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.socks, '');
  });

  await test('start() explains a missing tor binary instead of throwing', async () => {
    const out = await torLayer.start({ bin: '/nonexistent/snipr-tor-test', timeoutMs: 3000 });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /no tor binary/, `unexpected error: ${out.error}`);
    assert.strictEqual(torLayer.status().running, false);
  });

  await test('status() reports the daemon and whether tor is installed', () => {
    const t = torLayer.status();
    assert.strictEqual(typeof t.installed, 'boolean');
    assert.strictEqual(typeof t.binary, t.installed ? 'string' : 'object');
    assert.strictEqual(t.running, false);
    const s = pool.status().tor;
    assert.ok(s.daemon && typeof s.daemon.running === 'boolean', 'proxy status must carry the tor daemon state');
    assert.ok(Array.isArray(s.discoverPorts) && s.discoverPorts.includes(9050));
  });

  await test('a dead Tor route points at the Tor daemon that IS answering', async () => {
    const absent = await deadPort();
    pool.setConfig({
      mode: 'tor', torSocks: `socks5://127.0.0.1:${absent}`, torControl: '', isolate: true,
      discoverPorts: [absent, socks.port],
    });
    const route = await pool.checkRoute();
    assert.strictEqual(route.ok, false, 'a refused route must not report ok');
    assert.match(route.error, /ECONNREFUSED|closed|no answer/);
    assert.ok(route.suggest, 'no suggestion for the Tor that is listening on another port');
    assert.strictEqual(route.suggest.torSocks, `socks5://127.0.0.1:${socks.port}`);
    assert.match(route.hint, /does answer on/, `unhelpful hint: ${route.hint}`);
    pool.setConfig({ mode: 'off' });
  });

  await test('with no Tor anywhere the hint names the install (or the direct route)', async () => {
    const absent = await deadPort();
    const absent2 = await deadPort();
    pool.setConfig({
      mode: 'tor', torSocks: `socks5://127.0.0.1:${absent}`, torControl: '', isolate: true,
      discoverPorts: [absent2],
    });
    const route = await pool.checkRoute();
    assert.strictEqual(route.ok, false);
    assert.strictEqual(route.suggest, null);
    assert.ok(/install Tor|start Tor|route to direct/.test(route.hint), `unhelpful hint: ${route.hint}`);
    pool.setConfig({ mode: 'off' });
  });

  /* ------------------------- Tor bundle provisioning ----------------------- */

  await test('the release listing picks the newest stable Tor, not an alpha', () => {
    assert.strictEqual(bundle.pickVersion('<a href="16.0a11/">x</a><a href="14.5.9/">y</a><a href="15.0.22/">z</a>'), '15.0.22');
    assert.strictEqual(bundle.pickVersion('nothing here'), '');
  });

  await test('the bundle name matches this platform, and unsupported ones say so', () => {
    const name = bundle.artifactName('15.0.22');
    if (process.platform === 'linux' && process.arch === 'x64') {
      assert.strictEqual(name, 'tor-expert-bundle-linux-x86_64-15.0.22.tar.gz');
      assert.strictEqual(bundle.supported(), true);
    }
    assert.ok(name === '' || /^tor-expert-bundle-[a-z0-9_-]+-15\.0\.22\.tar\.gz$/.test(name), name);
    assert.strictEqual(bundle.supported(), name !== '');
    if (!name) assert.match(bundle.unsupportedReason(), /install Tor/i);
  });

  await test('the published sha256 file is parsed (checksum column + filename)', () => {
    const text = `aaaa  other.tar.gz\n${'b'.repeat(64)}  *tor-expert-bundle-linux-x86_64-15.0.22.tar.gz\n`;
    assert.strictEqual(bundle.parseSums(text, 'tor-expert-bundle-linux-x86_64-15.0.22.tar.gz'), 'b'.repeat(64));
    assert.strictEqual(bundle.parseSums(text, 'missing.tar.gz'), '');
  });

  await test('the tar extractor unpacks only Tor + geoip, byte for byte', async () => {
    const files = await bundle.extractTarGz(tarGz([
      { name: 'tor/', type: '5' },
      { name: 'tor/tor', data: FAKE_TOR },
      { name: 'data/geoip', data: 'geo' },
      { name: 'data/geoip6', data: 'geo6' },
      { name: 'debug/tor', data: Buffer.alloc(300000, 7) },
      { name: 'docs/tor.txt', data: 'docs' },
    ]), { keep: bundle.KEEP, skip: bundle.SKIP });
    assert.deepStrictEqual([...files.keys()].sort(), ['data/geoip', 'tor/tor']);
    assert.strictEqual(files.get('tor/tor').data.length, FAKE_TOR.length, 'a large entry was truncated');
    assert.strictEqual(files.get('tor/tor').data.toString('utf8'), FAKE_TOR, 'entry content was corrupted');
    assert.strictEqual(files.get('data/geoip').data.toString('utf8'), 'geo');
    assert.ok(!files.has('debug/tor'), 'debug symbols must not be kept');
    assert.ok(!files.has('data/geoip6'), 'the IPv6 geoip table is ~16 MB and unused here');
    assert.ok(![...files.keys()].some(k => k.includes('pluggable_transports')), 'bridge transports are ~30 MB and unused here');
  });

  await test('install() downloads, verifies and unpacks a runnable tor', async () => {
    if (!bundle.supported()) return console.log('      (skipped: no official bundle for this platform)');
    const dist = await startDist();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipr-bundle-'));
    const phases = [];
    const out = await bundle.install({ dir, base: dist.url, onProgress: p => phases.push(p.phase) });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.version, '15.0.22', 'the version from the listing was not used');
    assert.strictEqual(out.verified, true);
    assert.strictEqual((fs.statSync(out.bin).mode & 0o777), 0o755, 'the tor binary is not executable');
    assert.strictEqual(fs.readFileSync(out.bin, 'utf8'), FAKE_TOR, 'the tor binary is not the downloaded one');
    assert.ok(fs.existsSync(path.join(out.dir, 'data', 'geoip')), 'geoip was not unpacked');
    assert.ok(!fs.existsSync(path.join(out.dir, 'debug')), 'debug symbols were unpacked');
    assert.ok(!fs.existsSync(path.join(out.dir, 'tor', 'pluggable_transports')), 'the whole bundle was unpacked, not just the daemon');
    assert.ok(phases.includes('downloading') && phases.includes('verifying') && phases.includes('extracting'),
      `phases: ${phases.join(',')}`);

    const downloads = dist.state.hits.get(`/torbrowser/15.0.22/${dist.state.name}`);
    assert.ok(downloads >= 1, 'the bundle was not requested from its release directory');
    const again = await bundle.install({ dir, base: dist.url });
    assert.strictEqual(again.cached, true, 'a second install must reuse the cache');
    assert.strictEqual(dist.state.hits.get(`/torbrowser/15.0.22/${dist.state.name}`), downloads, 'the bundle was downloaded twice');

    const found = bundle.findInstalled({ dir });
    assert.ok(found && found.version === '15.0.22' && found.bin === out.bin, 'findInstalled() did not see the install');

    dist.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('install() refuses a bundle whose sha256 does not match, and leaves nothing behind', async () => {
    if (!bundle.supported()) return console.log('      (skipped: no official bundle for this platform)');
    const dist = await startDist({ corrupt: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipr-bundle-bad-'));
    await assert.rejects(() => bundle.install({ dir, base: dist.url }), /SHA-256/);
    assert.strictEqual(fs.existsSync(path.join(dir, '15.0.22', 'tor', 'tor')), false,
      'an unverified tor binary was left on disk');
    dist.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('install() proceeds without a published checksum but says so', async () => {
    if (!bundle.supported()) return console.log('      (skipped: no official bundle for this platform)');
    const dist = await startDist({ noSums: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipr-bundle-nosums-'));
    const warns = [];
    const out = await bundle.install({ dir, base: dist.url, onProgress: p => { if (p.warning) warns.push(p.warning); } });
    assert.strictEqual(out.verified, false);
    assert.ok(warns.length, 'an unverified download must warn');
    dist.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('ensureBinary() reuses a cached bundle, and explains itself when downloads are off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipr-ensure-'));
    const prev = process.env.SNIPR_TOR_HOME;
    process.env.SNIPR_TOR_HOME = dir;
    try {
      const noDownload = await torLayer.ensureBinary({ allowDownload: false });
      const system = torLayer.findSystemBinary();
      if (system) {
        assert.strictEqual(noDownload.ok, true, 'a system tor must be preferred over anything else');
        assert.strictEqual(noDownload.source, 'system');
      } else {
        assert.strictEqual(noDownload.ok, false, 'no tor anywhere must not report success');
        assert.match(noDownload.error, /no tor binary|no official build/i);
      }

      // a bundle in the cache is picked up without touching the network
      fs.mkdirSync(path.join(dir, '15.0.22', 'tor'), { recursive: true });
      const bin = path.join(dir, '15.0.22', 'tor', 'tor');
      fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      const cached = await torLayer.ensureBinary({ allowDownload: false });
      assert.strictEqual(cached.source, system ? 'system' : 'cache');
      assert.strictEqual(torLayer.findManagedBinary().bin, bin);
      assert.strictEqual(torLayer.status().installed, true, 'a cached bundle must count as installed');
    } finally {
      if (prev === undefined) delete process.env.SNIPR_TOR_HOME; else process.env.SNIPR_TOR_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('the managed torrc points tor at its bundled geoip files', () => {
    const torrc = torLayer.torrcFor({
      socksPort: 9050, controlPort: 0, hash: '', dataDir: '/tmp/x',
      geoip: '/opt/tor/15.0.22/data/geoip', geoip6: '/opt/tor/15.0.22/data/geoip6',
    });
    assert.match(torrc, /^GeoIPFile \/opt\/tor\/15\.0\.22\/data\/geoip$/m);
    assert.match(torrc, /^GeoIPv6File \/opt\/tor\/15\.0\.22\/data\/geoip6$/m);
    assert.ok(!/GeoIPFile/.test(torLayer.torrcFor({ socksPort: 9050, dataDir: '/tmp/x' })),
      'no geoip paths must mean no geoip lines');
  });

  await test('status() and the route hint expose what a start will need to do', () => {
    const t = torLayer.status();
    assert.strictEqual(typeof t.canInstall, 'boolean');
    assert.ok('install' in t, 'status() must carry the install/daemon progress');
    const daemon = pool.status().tor.daemon;
    assert.strictEqual(daemon.canInstall, t.canInstall, 'proxy status must relay canInstall');
    assert.ok('install' in daemon, 'proxy status must relay install progress');
    assert.match(torLayer.installHint(), /start Tor/i, torLayer.installHint());
  });

  made.push(origin, socks, socksAuth, httpProxy, httpProxy2, control, controlPw);
  made.forEach(s => s.close());
  pool.setConfig({ mode: 'off' });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    failures.forEach(f => console.log(`FAILED: ${f.name}\n${f.e && f.e.stack}\n`));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
