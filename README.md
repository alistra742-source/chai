# SNIPR — multi-platform username sniper

A self-hostable username sniper/availability checker for **guns.lol**, **Discord**,
**Instagram** and **TikTok**, with a web dashboard, a **6-browser swarm with a live
cam wall**, and exact possibility/remaining math.

Every engine in this app is **real** — no simulation, no fake hits. A run either
hits the platforms (server-side, from your browser, or from 6 browser windows on
the host) or it reports the errors the platforms give back.

Pick a platform, pick a target pattern (`3L`, `3C`, `4L`, `4C`, custom
length/charset, or a paste-your-own list), and sweep the whole space while the
dashboard shows:

- **possibilities** — exact size of the target space (`26³ = 17,576`, `36³ = 46,656`, `26⁴ = 456,976`, `36⁴ = 1,679,616`)
- **valid** — usernames that are free/unclaimed (hits)
- **taken / invalid / premium 💎 / errors** — the rest, counted separately
- **left to check** — `total − checked`, live, plus speed and ETA

## Run it

```bash
node server.js          # zero dependencies for the server/browser engines, Node 18+
# open http://localhost:3000
```

Want a rotating exit IP (Tor circuits or a proxy list)? See
[Rotating exit IPs](#rotating-exit-ips--tor-circuits--proxy-list-zero-dependencies).

## Engines

| Engine | What it does |
|---|---|
| **Server** | Real checks fired from the machine running `server.js`. The actual sniper when self-hosted on your own IP. |
| **Browser-direct** | Real checks from **your** browser (Discord via the CORS-enabled Pomelo endpoint; others relayed through `/api/proxy`). |
| **⚡ Swarm** | **SIX real browsers sniping at the same time on the host**, each with a **live screenshot cam** streamed to the dashboard. |

### Swarm — 6 real browsers + live cam

```bash
npm i playwright              # only needed for headless host browsers
node server.js                # pick "⚡ SWARM" in the engine dropdown
```

The swarm drives a browser that already exists on the host, in this order:

1. the **Google Chrome** you have installed (`channel: chrome`)
2. **Microsoft Edge** (`channel: msedge`)
3. playwright's own **chromium** (`npx playwright install chromium`)

so you do **not** need the `playwright install` download if Chrome or Edge is
installed. If none of the three exists, the run says so and switches to HYDRA
instead of dying (see below).

- Launches **6 isolated browser contexts** (6 UA-fingerprinted "browsers"), each pulling
  names from the shared scramble cursor concurrently — every name is handed out once.
- Real page loads per username (`guns.lol/<name>`, `tiktok.com/@<name>`, `instagram.com/<name>/`);
  Discord is checked via `fetch` **from inside a live discord.com page** (real browser TLS/cookies).
- **LIVE CAM**: every browser's screen is captured ~1×/s (`Page.captureScreenshot`) and served
  at `/api/cam/1.jpg … /api/cam/6.jpg` — the dashboard shows a 6-pane camera wall with
  per-browser target/counters overlaid.
- Launch problems are never silent: `/api/state` → `swarm.error` carries the reason
  (e.g. *"Google Chrome: ... / chromium: Executable doesn't exist"*) and the dashboard
  shows it under the start/stop buttons.
- **HYDRA fallback**: if the host has no real browser at all, the swarm runs as
  **6 parallel Web Workers inside your own browser** — same 6 panes, streaming per-worker
  telemetry (current target / checked / valid / last status) instead of video. Those workers
  do **real** checks too: Discord straight from your browser, other platforms via `/api/proxy`.
  There is no simulated mode to fall back to.

## Latest GitHub tools this is copied from (updated 2026)

- **guns.lol** — [efekrbas/guns.lol-username-checker](https://github.com/efekrbas/guns.lol-username-checker)
  (2026, 141★, Selenium): unclaimed detection via h1/title markers — *"username not found"* /
  *"bulunamad"*, title *"everything you want"* / *"istediğin her şey"* — plus the
  **premium-alias filter** (names starting/ending with `. - _` need premium; SNIPR tags them 💎
  instead of wasting requests), per-request **UA rotation**, retry/backoff, and the Chrome
  hardening flags (`--headless=new --no-sandbox --disable-blink-features=AutomationControlled`,
  `navigator.webdriver` removal) now used by the swarm.
  [CuteTenshii/guns-solver](https://github.com/CuteTenshii/guns-solver) (2026): guns.lol fronts
  **Cloudflare** (cf_clearance on analytics) — a real browser passes it naturally, which is why
  the swarm uses real page loads.
  Older/backup logic: [xnxv/guns.lol.scanner](https://github.com/xnxv/guns.lol.scanner),
  [02h9/Guns.lol-usernames-checker](https://github.com/02h9/Guns.lol-usernames-checker)
  (*"This user is not claimed"* marker),
  [M58-ENSIBS/guns.lol-fetcher](https://github.com/M58-ENSIBS/guns.lol-fetcher)
  (`_next/data/<buildId>/<name>.json` → `error == "User not found"`).
- **Discord** — [daskeptaxd/username-checker](https://github.com/daskeptaxd/username-checker):
  `POST /api/v9/unique-username/username-attempt-unauthed` → `{taken}` (Pomelo; still the current
  no-token method — confirmed active in [unfooled/universal-username-checker](https://github.com/unfooled/universal-username-checker), 2026).
- **TikTok** — [swagkarna/TikTok-Username-Checker](https://github.com/swagkarna/TikTok-Username-Checker):
  `api16-normal-c-useast1a.tiktokv.com/aweme/v1/unique/id/check/?…&unique_id=<name>` → `{is_valid}`;
  fallbacks: oembed + profile-page status (no token needed, confirmed 2026).
- **Instagram** — `i.instagram.com/api/v1/users/web_profile_info/?username=` with web app-id
  `936619743392459`; 404 ⇒ available; page-scan fallback. (Note: IG is the most aggressive
  blocker — [unfooled](https://github.com/unfooled/universal-username-checker) now requires an
  account token there; from datacenter IPs expect 401/429.)

## Rotating exit IPs — Tor circuits / proxy list (zero dependencies)

Section **4 · Exit IP** on the dashboard (or `POST /api/net`) puts the whole
sweep behind a **rotating exit IP**. Three modes:

| Mode | What actually happens |
|---|---|
| **off** | direct — the machine's own IP (default) |
| **🧅 Tor** | every request goes through a Tor SOCKS5 port. Each request opens a **fresh circuit**: the app authenticates to Tor with a unique throwaway SOCKS5 username/password, and with Tor's `IsolateSOCKSAuth` (on by default for `SocksPort`) that means a **different exit node per request**. Every *N* requests it also sends **`SIGNAL NEWNYM`** on the control port for a hard new identity (throttled to Tor's own 10 s limit). |
| **Proxy list** | one proxy per line (`socks5://…` or `http://…`, with optional `user:pass@`), used **round-robin — one per request**. |

The layer is implemented in `lib/proxy.js`: a real SOCKS5 client (greeting,
user/pass auth, CONNECT), HTTP proxies via `CONNECT`, per-request agents, and
the Tor control protocol. `lib/http.js` is a small `fetch`-alike used by every
checker, so **server, browser-relayed and swarm** checks all go through it.

`lib/http.js` also owns the things these sites need to answer at all:

- **A cookie jar.** guns.lol answers `307` with `location` pointing at the
  *same* url plus `set-cookie: guns_clearance=…`. A client that drops cookies
  re-requests forever, so one username check became **six** requests — that is
  where the `HTTP 429 (Cloudflare challenge?)` rows came from, and the `401`s
  once a clearance cookie minted for one exit was replayed from another. The
  cookie is stored per host and sent back, which turns the same check into
  `200` + `Username not found`. Cookies are remembered *between* checks only
  when the exit never changes (direct, or Tor without per-connection
  isolation).
- **One exit IP per check.** All redirect hops of a single check share one proxy
  route, so a cookie minted on hop 1 is still valid on hop 2. Rotation still
  happens per check, not per hop.
- **Bounded retries.** `429 / 403 / 503` on a GET are retried (up to 3 attempts)
  with backoff, honouring `Retry-After`, each attempt on a fresh route. POST is
  never retried, so a Discord availability check can't be submitted twice.
- **Adaptive back-off.** When the server engine sees a rate-limit/block from the
  target, every worker pauses (2 s, doubling to 30 s, decaying again on healthy
  answers) and the dashboard shows `⏸ … is throttling this IP` instead of a wall
  of identical error rows.

```bash
# torrc (or /etc/tor/torrc)
SocksPort 9050 IsolateSOCKSAuth   # fresh circuit per SOCKS5 credential pair
ControlPort 9051                  # needed for SIGNAL NEWNYM rotation
HashedControlPassword <hash>      # then set TOR_CONTROL_PASSWORD, or leave the control port closed
```

Environment defaults (the dashboard can change all of it at runtime):

| Variable | Meaning |
|---|---|
| `SNIPR_PROXY` | `tor` \| `list` \| `off` (default `off`) |
| `SNIPR_PROXY_LIST` | comma/newline separated proxy list (implies `list`) |
| `TOR_SOCKS` | Tor SOCKS5 address, default `socks5://127.0.0.1:9050` |
| `TOR_CONTROL` | Tor control address, default `127.0.0.1:9051` |
| `TOR_CONTROL_PASSWORD` | password for the control port (omit to clear) |

**Test exit IP** on the dashboard runs a real request through the current route
to `check.torproject.org` and shows the exit IP plus whether it really is a Tor
exit — so you can prove the tunnel works before a sweep. The run stats line
keeps showing requests routed, new identities issued and exits seen.

- **⚡ Swarm** passes the route to Playwright (`browser.newContext({ proxy })`),
  one proxy per browser, so the six browsers don't share an exit IP.
- The **swarm** picks up rotation between circuits; Chromium cannot send SOCKS5
  credentials, so Tor circuit isolation applies to the server/browser-relayed
  engines and the swarm follows `NEWNYM` instead.
- The **browser/HYDRA** engine checks Discord from *your* browser, which no
  server-side proxy can route — use **server** or **swarm** for full Tor
  coverage.
- Honest caveat: Tor exit nodes are widely blocked or rate-limited (Instagram,
  TikTok and guns.lol will often answer 403/429). Rotation helps with per-IP
  limits, it does not make a blocked exit look residential — keep the delay on,
  and prefer your own IP or a proxy list where Tor fails. Better still: leave
  the route **off** for guns.lol on a normal connection now that the clearance
  cookie is replayed — the 429s there were self-inflicted, not Cloudflare.

Run the proxy test suite (mock SOCKS5 server, mock CONNECT proxy, mock Tor
control port, real HTTPS through the tunnel):

```bash
npm test        # node test/net.test.js
```

## Possibility math

| Pattern | Charset | Count |
|---|---|---|
| 3L | `a-z` | 26³ = **17,576** |
| 3C | `a-z0-9` | 36³ = **46,656** |
| 4L | `a-z` | 26⁴ = **456,976** |
| 4C | `a-z0-9` | 36⁴ = **1,679,616** |

Custom lengths 1–6 with letters/digits toggles use the same `base^len` math. The sweep order is
a bijective scramble (`i → (offset + i·mult) mod total`, `gcd(mult, total) = 1`) — random-looking,
never repeats, never materialises the space in memory, so *left to check* stays exact even with
6 browsers pulling from the same cursor. The server owns that cursor: browser workers ask for
`/api/targets?n=…` and get names nobody else has, so six browsers can never double-check a name
(or finish a 17,576-name sweep after the first 2,000).

## API

| Endpoint | Description |
|---|---|
| `GET /api/state` | live counters + swarm mode/worker telemetry + feed |
| `GET /api/swarm` | real browser detected? playwright available? swarm running? per-browser stats |
| `GET /api/net` | current rotating-exit config + live stats (requests routed, rotations, exits seen, errors) |
| `POST /api/net` | `{mode: off\|tor\|list, torSocks, torControl, torPassword, isolate, rotateEvery, rotateIntervalMs, list}` |
| `POST /api/net/test` | one real request through the current route → `{ip, isTor, ms}` (proves the tunnel) |
| `GET /api/cam/1.jpg…6.jpg` | live screenshot of browser N (swarm mode) |
| `POST /api/start` | `{platform, engine: server\|browser\|swarm, target, concurrency, delay, shuffle}` |
| `POST /api/stop` | abort run + kill browsers |
| `GET /api/targets?n=` | next chunk of names — server-owned cursor, handed out exactly once (hydra/browser workers) |
| `POST /api/report` | workers post results back |
| `POST /api/proxy` | server-side batch check (hydra, non-Discord) |
| `POST /api/check` | single ad-hoc check |
| `GET /api/hits.txt` | download the valid hits |

Hits are appended to `results/hits_<platform>_<pattern>.txt`.

## Legal

Educational tool. Automated availability checking can violate the ToS of the platforms involved —
keep request rates low, and don't use hits for squatting, impersonation or fraud. You are
responsible for what you do with it.
