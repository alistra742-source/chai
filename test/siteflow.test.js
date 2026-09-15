'use strict';
/*
 * Unit tests for the sniper-flow engine — the pure parts that decide whether we
 * click the right control and, above all, whether a name we show as "sniped"
 * really came from the site (and not from the list we were trying).
 *
 *   npm test
 */

const assert = require('assert');
const sf = require('../lib/siteflow');

let pass = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push({ name, e }); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\nsiteflow — pure logic');

ok('norm squashes whitespace and case', () => {
  assert.equal(sf.norm('  Random  IZE \n'), 'random ize'.replace('  ', ' '));
  assert.equal(sf.norm('4C'), '4c');
  assert.equal(sf.norm(null), '');
});

ok('patternInfo understands 4C and custom patterns', () => {
  const p = sf.patternInfo('4C');
  assert.equal(p.id, '4C');
  assert.equal(p.total, 1679616);           // 36^4
  assert.equal(sf.patternInfo('4c').id, '4C');
  assert.equal(sf.patternInfo('3L').total, 17576);       // 26^3
  assert.equal(sf.patternInfo('3C').total, 46656);       // 36^3
  assert.equal(sf.patternInfo('4L').total, 456976);      // 26^4
  assert.equal(sf.patternInfo('5C').total, Math.pow(36, 5));
  assert.equal(sf.patternInfo('nonsense').id, '4C');     // safe default
});

ok('patternMatchers offers every plausible label for 4C', () => {
  const m = sf.patternMatchers('4C');
  for (const want of ['4c', '4 c', '4 chars', '4 characters', '4-char', '4c names']) {
    assert.ok(m.includes(want), 'missing ' + want);
  }
});

ok('the flow runs in the asked-for order', () => {
  const ids = sf.stepsOf(sf.FLOWS.discord, '4C').map(s => s.id);
  const order = ['names', 'pattern', 'load', 'randomize', 'sniper-tab', 'start', 'watch'];
  let cursor = -1;
  for (const id of order) {
    const at = ids.indexOf(id);
    assert.ok(at > cursor, `${id} out of order`);
    cursor = at;
  }
  assert.deepEqual(sf.STEP_IDS, ids);
});

ok('both platforms point at a real https site and have tab labels', () => {
  for (const id of ['discord', 'gunslol']) {
    const f = sf.FLOWS[id];
    assert.ok(f, 'missing flow ' + id);
    assert.match(f.site, /^https:\/\//);
    assert.ok(f.namesTab.includes('names'));
    assert.ok(f.sniperTab.length, 'sniper tab labels');
    assert.ok(f.startButton.includes('start'));
  }
  assert.ok(sf.FLOWS.gunslol.sniperTab.some(t => t.includes('guns.lol')));
});

console.log('\nsiteflow — "what did it actually snipe?"');

ok('reads a username out of the site\'s own JSON', () => {
  assert.deepEqual(sf.extractSniped('{"success":true,"username":"k4ito"}').map(n => n.name), ['k4ito']);
  const r = sf.extractSniped('{"claimed":"q7zz","ok":true}');
  assert.equal(r[0].name, 'q7zz');
  assert.ok(r[0].why.length > 5, 'keeps the snippet it saw');
});

ok('reads a name out of a wrapped websocket frame', () => {
  assert.deepEqual(sf.extractSniped('42["snipe",{"success":true,"username":"k4ito"}]').map(n => n.name), ['k4ito']);
  assert.deepEqual(sf.extractSniped('data: {"event":"claimed","claimed":"vx91"}').map(n => n.name), ['vx91']);
});

ok('reads a username out of a rendered success message', () => {
  assert.deepEqual(sf.extractSniped('Sniped: vx91 — enjoy!').map(n => n.name), ['vx91']);
  assert.deepEqual(sf.extractSniped('@abc was sniped successfully').map(n => n.name), ['abc']);
  assert.deepEqual(sf.extractSniped('congrats, you claimed 4c0x').map(n => n.name), ['4c0x']);
});

ok('an ATTEMPT is never shown as a snipe', () => {
  const attempts = [
    '{"username":"attempt1"}',                          // just the name being tried
    '{"taken":true,"username":"someoneelse"}',        // in use
    '{"taken":false,"username":"zz9"}',              // free, but not claimed by us
    '{"available":true,"username":"zz9"}',
    '{"error":"rate limited, try again"}',
    '{"status":200}',
  ];
  for (const t of attempts) {
    assert.deepEqual(sf.extractSniped(t), [], 'must not be a snipe: ' + t);
  }
});

ok('available names are reported separately, never as snipes', () => {
  assert.deepEqual(sf.extractFound('{"taken":false,"username":"zz9"}').map(n => n.name), ['zz9']);
  assert.deepEqual(sf.extractFound('{"available":true,"data":{"username":"ab12"}}').map(n => n.name), ['ab12']);
  assert.deepEqual(sf.extractFound('nice, @abcd is available').map(n => n.name), ['abcd']);
  assert.deepEqual(sf.extractSniped('{"taken":false,"username":"zz9"}'), []);
});

ok('never mistakes site chrome for a sniped name', () => {
  const noise = [
    'Discord Sniper started successfully',
    '{"status":"success","message":"Sniping started"}',
    'Guns.lol sniper stopped',
    'randomize names list loading',
    'success',
    'loading names please wait',
  ];
  for (const t of noise) assert.deepEqual(sf.extractSniped(t), [], 'false positive on: ' + t);
});

ok('deduplicates the same name across payloads', () => {
  assert.equal(sf.extractSniped('sniped abc and later abc again sniped').length, 1);
});

ok('plausible() rejects junk and keeps real usernames', () => {
  for (const good of ['ab', 'k4ito', '@zz9', 'a.b-c_d', 'x'.repeat(32)]) assert.ok(sf.plausible(good), good);
  for (const bad of ['', 'a', '123', 'true', 'null', 'discord', 'sniper', 'https://x', 'x'.repeat(33), 'site.com']) {
    assert.ok(!sf.plausible(bad), 'should reject ' + bad);
  }
});

console.log('\nsiteflow — environment report');

ok('browserReport is explicit, never vague', () => {
  const r = sf.browserReport();
  assert.equal(typeof r.playwright, 'boolean');
  assert.equal(typeof r.headless, 'boolean');
  assert.ok(r.browser === null || typeof r.browser === 'string');
  if (!r.browser) assert.ok(r.error && r.error.length > 10, 'must say what to install');
});

console.log('\n' + (fails.length ? `${fails.length} FAILED, ${pass} passed` : `all ${pass} checks passed`) + '\n');
if (fails.length) process.exit(1);
