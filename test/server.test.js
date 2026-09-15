'use strict';
/*
 * Boots the real server on a throwaway port and checks the HTTP surface end to
 * end — the dashboard, the state the browser polls, and that bad requests are
 * refused instead of silently doing something.
 *
 *   node test/server.test.js
 *
 * It never starts a sniping run (that would open real browsers and hit the live
 * site), so this suite is safe to run anywhere.
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3900 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let pass = 0;
const fails = [];
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const get = async (p) => {
  const res = await fetch(BASE + p);
  const text = await res.text();
  return { res, text, json: (() => { try { return JSON.parse(text); } catch (_) { return null; } })() };
};
const post = async (p, body) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { res, json: (() => { try { return JSON.parse(text); } catch (_) { return null; } })() };
};

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } };
  process.on('exit', cleanup);

  // wait for readiness
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!up) {
    console.log('\nserver never came up on ' + BASE + '\n--- server log ---\n' + log);
    cleanup();
    process.exit(1);
  }

  console.log('\nserver — HTTP surface');

  await ok('GET / serves the dashboard', async () => {
    const { res, text } = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok(text.includes('START SNIPING'), 'start button present');
    assert.ok(text.includes('LIVE CAM'), 'cam wall present');
    assert.ok(text.includes('/style.css') && text.includes('/app.js'), 'assets referenced');
  });

  await ok('the stylesheet and the app script are served with the right types', async () => {
    const css = await get('/style.css');
    assert.equal(css.res.status, 200);
    assert.match(css.res.headers.get('content-type'), /text\/css/);
    assert.ok(css.text.includes('--acid'), 'theme tokens present');
    const js = await get('/app.js');
    assert.equal(js.res.status, 200);
    assert.match(js.res.headers.get('content-type'), /javascript/);
  });

  await ok('GET /api/state reports flows, patterns and a browser verdict', async () => {
    const { res, json } = await get('/api/state');
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.flows.map(f => f.id), ['discord', 'gunslol']);
    assert.deepEqual(json.patterns.map(p => p.id), ['3L', '3C', '4L', '4C']);
    assert.equal(typeof json.browser.playwright, 'boolean');
    if (!json.browser.browser) assert.ok(json.browser.error, 'a missing browser must be explained');
  });

  await ok('cam endpoints answer 204 before any run (never a fake frame)', async () => {
    const res = await fetch(BASE + '/api/cam/1.jpg');
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
  });

  await ok('POST /api/start refuses an unknown platform', async () => {
    const { res, json } = await post('/api/start', { platform: 'myspace' });
    assert.equal(res.status, 400);
    assert.match(json.error, /unknown platform/);
  });

  await ok('POST /api/login requires both fields', async () => {
    const a = await post('/api/login', { platform: 'discord', email: 'a@b.c' });
    assert.equal(a.res.status, 400);
    const b = await post('/api/login', { platform: 'nope', email: 'a@b.c', password: 'x' });
    assert.equal(b.res.status, 400);
  });

  await ok('POST /api/verify really tries to launch a browser', async () => {
    const { res, json } = await post('/api/verify', {});
    assert.equal(res.status, 200);
    assert.equal(typeof json.ok, 'boolean');
    if (json.ok) assert.ok(json.browser, 'names the browser it launched');
    else assert.ok(json.error && json.error.length > 10, 'a failure must say why');
  });

  await ok('POST /api/probe needs a real url', async () => {
    const { res, json } = await post('/api/probe', { site: 'notaurl' });
    assert.equal(res.status, 400);
    assert.ok(json.error);
  });

  await ok('POST /api/parse explains how a site message would be read', async () => {
    const good = await post('/api/parse', { text: '{"success":true,"username":"k4ito"}' });
    assert.deepEqual(good.json.sniped.map(n => n.name), ['k4ito']);
    const attempt = await post('/api/parse', { text: '{"taken":false,"username":"zz9"}' });
    assert.deepEqual(attempt.json.sniped, [], 'an attempt is not a snipe');
    assert.deepEqual(attempt.json.found.map(n => n.name), ['zz9']);
  });

  await ok('unknown paths 404 instead of pretending', async () => {
    const { res, json } = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(json.ok, false);
  });

  cleanup();
  console.log('\n' + (fails.length ? `${fails.length} FAILED, ${pass} passed` : `all ${pass} checks passed`) + '\n');
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
