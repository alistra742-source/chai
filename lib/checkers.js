'use strict';
/*
 * SNIPR platform checkers.
 *
 * The availability logic for every platform below is copied from public
 * open-source GitHub tools (credits in each function + README):
 *
 *  guns.lol   -> xnxv/guns.lol.scanner  + 02h9/Guns.lol-usernames-checker
 *                GET https://guns.lol/<u> ; body contains
 *                "This user is not claimed"  => available (unclaimed)
 *                plus M58-ENSIBS/guns.lol-fetcher Next.js data API as fallback
 *
 *  Discord    -> daskeptaxd/username-checker ("Discord 4L sniper")
 *                POST https://discord.com/api/v9/unique-username/username-attempt-unauthed
 *                { username } -> { taken: true|false }   (Pomelo API)
 *
 *  TikTok     -> swagkarna/TikTok-Username-Checker
 *                GET api16-normal-c-useast1a.tiktokv.com/aweme/v1/unique/id/check/
 *                ...&unique_id=<u> -> { is_valid: true } => available
 *                fallbacks: tiktok oembed + www.tiktok.com/@<u> status code
 *
 *  Instagram  -> classic web_profile_info v1 API with the public
 *                x-ig-app-id 936619743392459 ; 404 => available
 *                fallback: www.instagram.com/<u>/ page scan
 *
 * Every result here is a REAL network hit — there is no simulated engine.
 *
 * Outbound requests go through lib/http.js, so when the rotating proxy layer is
 * enabled (Tor circuits / proxy list) EVERY platform check below is tunnelled
 * through it without a single change here.
 *
 * That client also owns the things these sites require to answer at all: a
 * cookie jar (guns.lol hands out a clearance cookie on a 307 to the same url —
 * without replaying it every check becomes a redirect storm and the site
 * answers 429/401), one exit IP per logical check, and bounded retries on
 * 429/403/503. Errors carry a `kind` (`ratelimited` / `blocked`) so the run
 * loop can back off instead of hammering.
 */

const { fetchWithTimeout } = require('./http');
const proxyPool = require('./proxy');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

// copied from efekrbas/guns.lol-username-checker (2026):
// aliases starting/ending with . - _ require guns.lol premium — free accounts can't claim them
function isPremiumAlias(name) {
  return /^[._-]|[._-]$/.test(name);
}

class CheckError extends Error {
  constructor(message, kind = 'error') { super(message); this.kind = kind; }
}

const brief = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 140);

/*
 * What actually went wrong on the wire matters: an unroutable Tor port and a
 * target that never answers are both "network error" but need opposite fixes.
 *
 *   kind 'proxy'   -> the configured route could not be dialled (Tor not
 *                     running, dead proxy, typo'd host). The run loop stops
 *                     instead of blaming the platform for every name.
 *   kind 'timeout' -> the route works, the host did not answer in time.
 *   kind 'network' -> DNS/TLS/reset, with the OS error code in the message.
 */
function networkError(host, err) {
  if (err instanceof CheckError) return err;
  const raw = brief((err && err.message) || err || 'unknown error');
  const code = (err && err.code) || (err && err.cause && err.cause.code) || '';
  if (proxyPool.isProxyError(err)) {
    return new CheckError(`can't reach the proxy route (${code ? code + ': ' : ''}${raw}) — check the route in section 4 (is Tor running? is the proxy alive?)`, 'proxy');
  }
  if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(`${raw} ${code}`)) {
    return new CheckError(`timed out reaching ${host}${code ? ' (' + code + ')' : ''}`, 'timeout');
  }
  return new CheckError(`network error reaching ${host}${code ? ' (' + code + ')' : ''}: ${raw}`, 'network');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------- guns.lol -------------------------------- */
async function checkGunsLol(name) {
  // Premium-alias filter — copied from efekrbas/guns.lol-username-checker (2026)
  if (isPremiumAlias(name)) return { status: 'premium', via: 'efekrbas-filter', note: 'premium-only alias (. - _ edges)' };
  // Copied from xnxv/guns.lol.scanner (check_username) & 02h9's gunslol.py:
  // profile page of an unclaimed username contains "This user is not claimed".
  let res, text;
  try {
    res = await fetchWithTimeout(`https://guns.lol/${encodeURIComponent(name)}`, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    text = await res.text();
  } catch (e) {
    throw networkError('guns.lol', e);
  }
  if (/this user is not claimed/i.test(text)) return { status: 'available', http: res.status, via: 'profile-page' };
  // markers copied from efekrbas/guns.lol-username-checker (h1/title, EN + TR)
  const title = ((text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').toLowerCase();
  const h1 = (text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || []).map(t => t.toLowerCase()).join('|');
  if (h1.includes('username not found') || h1.includes('bulunamad') ||
      title.includes('everything you want') || title.includes('istediğin her şey')) {
    return { status: 'available', http: res.status, via: 'efekrbas-markers' };
  }
  if (/just a moment|attention required/i.test(title)) {
    throw new CheckError('cloudflare challenge — real-browser swarm or residential IP needed', 'blocked');
  }
  // Rate limiting / blocks fail fast: retrying the Next.js fallback below would
  // only add more requests to a site that is already refusing them.
  if (res.status === 429) {
    throw new CheckError('guns.lol rate limited (HTTP 429) — increase the delay or rotate exits', 'ratelimited');
  }
  if (res.status === 401 || res.status === 403) {
    // lib/http.js has already retried this on every other exit the route can
    // offer, so reaching here means the whole route is refused, not one name.
    throw new CheckError(
      proxyPool.canRotate()
        ? `guns.lol rejected every exit we tried (HTTP ${res.status}) — the route's IPs are flagged by Cloudflare; use a residential proxy list or your own IP`
        : `guns.lol rejected this IP (HTTP ${res.status}) — Cloudflare is refusing the exit; needs a residential IP (or leave the route off)`,
      'blocked');
  }
  if (res.status === 307 || res.status === 308) {
    throw new CheckError(`guns.lol clearance redirect never resolved (HTTP ${res.status}) — avoid changing exit IP mid-check`, 'blocked');
  }
  if (res.status === 404) return { status: 'available', http: 404, via: 'profile-page' };
  if (res.ok && title) return { status: 'taken', http: res.status, via: 'profile-page' };

  // Fallback copied from M58-ENSIBS/guns.lol-fetcher: Next.js data route,
  // pageProps.data.error === "User not found" => available.
  try {
    const home = await fetchWithTimeout('https://guns.lol/', { headers: { 'user-agent': UA } });
    const buildId = (await home.text()).match(/"buildId":"([^"]+)"/);
    if (buildId) {
      const api = await fetchWithTimeout(
        `https://guns.lol/_next/data/${buildId[1]}/${encodeURIComponent(name)}.json`,
        { headers: { 'user-agent': UA } });
      const j = await api.json().catch(() => null);
      const err = j && j.pageProps && j.pageProps.data && j.pageProps.data.error;
      if (err === 'User not found') return { status: 'available', http: api.status, via: 'next-data' };
      if (j && j.pageProps && j.pageProps.data) return { status: 'taken', http: api.status, via: 'next-data' };
    }
  } catch (_) { /* fall through */ }
  throw new CheckError(`guns.lol unexpected HTTP ${res.status} — no availability marker found`, res.status >= 500 ? 'blocked' : 'error');
}

/* -------------------------------- Discord -------------------------------- */
const DISCORD_BAD = /(discord|clyde)/i;
function discordNameValid(name) {
  return /^[a-z0-9._]{2,32}$/.test(name) && !/^[._]|[._]$/.test(name) && !/\.\./.test(name) && !DISCORD_BAD.test(name);
}

async function checkDiscord(name) {
  // Copied from daskeptaxd/username-checker — the Pomelo unauthenticated
  // availability endpoint used by Discord's own signup page.
  if (!discordNameValid(name)) return { status: 'invalid', http: 0, via: 'rules', note: 'violates Discord username rules' };
  let res;
  try {
    res = await fetchWithTimeout('https://discord.com/api/v9/unique-username/username-attempt-unauthed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ username: name }),
    });
  } catch (e) {
    throw networkError('discord.com', e);
  }
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    throw new CheckError(`rate limited ${j.retry_after || ''}`.trim(), 'ratelimited');
  }
  if (res.status === 400) return { status: 'invalid', http: 400, via: 'pomelo' };
  if (!res.ok) throw new CheckError(`discord HTTP ${res.status} (403 = datacenter IP blocked — check from your own machine)`);
  const j = await res.json().catch(() => null);
  if (!j || typeof j.taken !== 'boolean') throw new CheckError('unexpected discord payload');
  return { status: j.taken ? 'taken' : 'available', http: 200, via: 'pomelo' };
}

/* -------------------------------- TikTok --------------------------------- */
async function checkTikTok(name) {
  // The fallbacks below swallow their own errors; keep the first real cause so
  // the final message says something useful instead of a generic "network error".
  let cause = null;
  // Primary: mobile "unique id check" API — copied from
  // swagkarna/TikTok-Username-Checker main.py (_checker).
  try {
    const url = 'https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/unique/id/check/'
      + '?device_id=6622992447704270341&os_version=13.6.1&app_name=musical_ly'
      + '&version_code=17.4.0&channel=App%20Store&device_platform=iphone'
      + '&device_type=iPhone10%2C5&unique_id=' + encodeURIComponent(name);
    const res = await fetchWithTimeout(url, {
      headers: {
        'user-agent': UA,
        'sdk-version': '1',
        'x-tt-token': '0344ccb2867669f08b78f1db63b65933c1b38145729bad08b9725b6218dd2649'
          + '4098feb938ee86b1ca42cac5fd714b8da943',
      },
    });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j && typeof j.is_valid === 'boolean') {
        return { status: j.is_valid ? 'available' : 'taken', http: res.status, via: 'mobile-api' };
      }
    }
  } catch (e) { if (e instanceof CheckError) throw e; cause = cause || e; }

  // Fallback 1: oembed (200 = user exists).
  try {
    const oembed = await fetchWithTimeout(
      'https://www.tiktok.com/oembed?url=' + encodeURIComponent(`https://www.tiktok.com/@${name}`),
      { headers: { 'user-agent': UA } });
    if (oembed.ok) return { status: 'taken', http: oembed.status, via: 'oembed' };
    if (oembed.status === 404) return { status: 'available', http: 404, via: 'oembed' };
  } catch (e) { if (e instanceof CheckError) throw e; cause = cause || e; }

  // Fallback 2: profile page status, used by onemanbuilds/TikTokUsernameChecker.
  try {
    const res = await fetchWithTimeout(`https://www.tiktok.com/@${encodeURIComponent(name)}`, {
      headers: { 'user-agent': UA }, redirect: 'follow',
    });
    if (res.status === 404) return { status: 'available', http: 404, via: 'www' };
    if (res.ok) return { status: 'taken', http: res.status, via: 'www' };
  } catch (e) { if (e instanceof CheckError) throw e; cause = cause || e; }
  throw networkError('tiktok', cause);
}

/* ------------------------------- Instagram ------------------------------- */
function instagramNameValid(name) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(name) && !/^[._]|[._]$/.test(name) && !/\.\./.test(name);
}

async function checkInstagram(name) {
  if (!instagramNameValid(name)) return { status: 'invalid', http: 0, via: 'rules', note: 'violates Instagram username rules' };
  let cause = null;
  // Primary: web_profile_info v1 API with the public web app id.
  try {
    const res = await fetchWithTimeout(
      'https://i.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(name),
      {
        headers: {
          'user-agent': UA, 'x-ig-app-id': IG_APP_ID, accept: '*/*',
          'x-requested-with': 'XMLHttpRequest', referer: 'https://www.instagram.com/',
        },
      });
    if (res.status === 404) return { status: 'available', http: 404, via: 'web-profile-api' };
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j && j.data) return { status: j.data.user ? 'taken' : 'available', http: 200, via: 'web-profile-api' };
    }
  } catch (e) { if (e instanceof CheckError) throw e; cause = cause || e; }

  // Fallback: public profile page (404 / "Sorry, this page isn't available").
  try {
    const res = await fetchWithTimeout(`https://www.instagram.com/${encodeURIComponent(name)}/`, {
      headers: { 'user-agent': UA }, redirect: 'follow',
    });
    if (res.status === 404) return { status: 'available', http: 404, via: 'www' };
    if (res.ok) {
      const t = await res.text();
      if (/page not found|sorry, this page isn/i.test(t)) return { status: 'available', http: 200, via: 'www' };
      return { status: 'taken', http: 200, via: 'www' };
    }
    if (res.status === 302 || res.status === 429 || res.status === 403) {
      throw new CheckError(`instagram blocked this IP (HTTP ${res.status}) — needs residential IP`, 'blocked');
    }
  } catch (e) {
    if (e instanceof CheckError) throw e;
    cause = cause || e;
  }
  throw networkError('instagram', cause);
}

const CHECKERS = {
  gunslol: checkGunsLol,
  discord: checkDiscord,
  tiktok: checkTikTok,
  instagram: checkInstagram,
};

async function liveCheck(platform, name) {
  const fn = CHECKERS[platform];
  if (!fn) throw new CheckError(`unknown platform ${platform}`);
  return fn(name);
}

module.exports = { liveCheck, CheckError, UA, isPremiumAlias };
