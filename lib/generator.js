'use strict';
/*
 * Target-space generator for SNIPR.
 *
 * Patterns:
 *   3L = 3 letters  -> 26^3 = 17,576 possibilities
 *   4L = 4 letters  -> 26^4 = 456,976 possibilities
 *   3C = 3 chars (a-z0-9) -> 36^3 = 46,656 possibilities
 *   4C = 4 chars (a-z0-9) -> 36^4 = 1,679,616 possibilities
 *   custom length 1..6 with letters/digits toggles
 *
 * The whole space is NEVER materialised in memory: names are derived
 * on the fly from an index. A bijective scramble (i -> (offset + i*mult) % total,
 * mult coprime with total) gives a repeat-free "random" order with O(1) memory,
 * so "usernames left to check" is always exactly total - checked.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

function charsetFor(charsetKey) {
  // 'L' = letters only, 'C' = letters + digits, 'D' = digits only
  if (charsetKey === 'C') return LETTERS + DIGITS;
  if (charsetKey === 'D') return DIGITS;
  return LETTERS;
}

function spaceSize(charsetKey, len) {
  const base = charsetFor(charsetKey).length;
  let n = 1;
  for (let i = 0; i < len; i++) n *= base;
  return n; // max 36^6 ~ 2.1e9, safe as a JS Number
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

/* Deterministic PRNG so a given run can be reproduced / resumed conceptually */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * target = { kind:'pattern', charset:'L'|'C', len:3 }
 *        | { kind:'list', names:[...] }
 *        | { kind:'single', name:'x' }
 */
function describeTarget(target) {
  if (!target) return 'nothing';
  if (target.kind === 'pattern') {
    const label = `${target.len}${target.charset === 'C' ? 'C' : 'L'}`;
    return `${label} pattern (${target.charset === 'C' ? 'a-z0-9' : 'a-z'})`;
  }
  if (target.kind === 'list') return `custom list (${target.names.length} names)`;
  if (target.kind === 'single') return `single: ${target.name}`;
  return 'unknown';
}

function totalFor(target) {
  if (!target) return 0;
  if (target.kind === 'pattern') return spaceSize(target.charset, target.len);
  if (target.kind === 'list') return target.names.length;
  if (target.kind === 'single') return 1;
  return 0;
}

/* raw index -> username (base-N counter) */
function nameAtRaw(target, i) {
  if (target.kind === 'list') return target.names[i] || '';
  if (target.kind === 'single') return target.name;
  const cs = charsetFor(target.charset);
  const base = cs.length;
  let x = i, s = '';
  for (let k = 0; k < target.len; k++) { s = cs[x % base] + s; x = Math.floor(x / base); }
  return s;
}

/* Pick a bijective scramble so pattern sweeps feel random but never repeat. */
function makeOrder(target, shuffled, seed) {
  const total = totalFor(target);
  if (!shuffled || total < 2) return { mult: 1, offset: 0 };
  const rnd = mulberry32(seed || 1337);
  let mult = 0;
  while (mult < 2 || gcd(mult, total) !== 1) mult = 1 + Math.floor(rnd() * (total - 1));
  const offset = Math.floor(rnd() * total);
  return { mult, offset };
}

function nameAt(target, order, i) {
  if (target.kind === 'list' || target.kind === 'single') return nameAtRaw(target, i);
  const total = totalFor(target);
  const j = (order.offset + i * order.mult) % total;
  return nameAtRaw(target, j);
}

/* Count helpers used by both API and UI */
const PATTERN_PRESETS = [
  { id: '3L', len: 3, charset: 'L' },
  { id: '3C', len: 3, charset: 'C' },
  { id: '4L', len: 4, charset: 'L' },
  { id: '4C', len: 4, charset: 'C' },
].map(p => ({ ...p, count: spaceSize(p.charset, p.len) }));

module.exports = {
  LETTERS, DIGITS, charsetFor, spaceSize, describeTarget, totalFor,
  nameAt, makeOrder, PATTERN_PRESETS, mulberry32,
};
