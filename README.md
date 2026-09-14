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
`lib/tor.js` runs and stops a Tor daemon for you, and `lib/torbundle.js` fetches
the official Tor binaries when the host has none — so Tor mode needs no torrc,
no control password and no `apt-get install` from you.

`lib/http.js` also owns the things these sites need to answer at all:

- **A cookie jar.** guns.lol answers `307` with `location` pointing at the
  *same* url plus `set-cookie: guns_clearance=…`. A client that drops cookies
  re-requests forever, so one username check became **six** requests — that is
  where the `HTTP 429 (Cloudflare challenge?)` rows came from, and the `401`s
  once a clearance cookie minted for one exit was replayed from another. The
  cookie is stored per host and sent back, which turns the same check into
  `200` + `Username not found`.
- **Cookies follow the exit that earned them.** The jar is keyed to the current
  egress identity (`identityTag()`), and is emptied when that identity changes —
  including on every `SIGNAL NEWNYM`. So a clearance/bot cookie can never be
  replayed from an IP the platform has already refused. In the modes where the
  exit changes on its own (proxy list: per request · isolated Tor: per
  connection) cookies live only for their own redirect chain.
- **One exit IP per check.** All redirect hops of a single check share one proxy
  route, so a cookie minted on hop 1 is still valid on hop 2. Rotation still
  happens per check, not per hop.
- **Bounded retries.** `429 / 403 / 503` on a GET are retried (up to 3 attempts)
  with backoff, honouring `Retry-After`, each attempt on a fresh route. POST is
  never retried, so a Discord availability check can't be submitted twice. A
  `401` is retried the same way **only when the retry can land on another exit**
  (proxy list, or isolated Tor circuits): a 401 means *this exit* was refused, and
  asking again from the same IP only adds rejected requests.
- **Rejected exits are skipped, not reused.** `401 / 403 / 429` marks that exit in
  `status().blocked`; in **proxy list** mode the next request prefers an exit that
  has not just been refused (60 s cooldown, 30 s for a rate limit; cleared when
  the route changes).
  Without this a sweep keeps asking the same three dirty proxies forever — which
  is what a full wordlist of `401`s looks like.
- **Adaptive back-off.** When the server engine sees a rate limit (`429`), every
  worker pauses (2 s, doubling to 30 s, decaying again on healthy answers) and the
  dashboard shows `⏸ … is throttling this IP` instead of a wall of identical rows.
- **A wall of blocks stops the run.** `401/403` are *not* a rate limit — pausing
  cannot un-block an IP — so instead they are counted: after **12 straight
  blocks** with no healthy answer in between, the run stops and `run.error` says
  exactly that (`every check is being rejected — stopped after 12 straight blocks: …`)
  instead of turning a 46,656-name sweep into 46,656 error rows. The same guard
  exists in the swarm (`every browser is being blocked`).
- **A route that cannot be dialled is refused, not blamed on the site.** This is
  what a wall of `exception — network error reaching …` rows usually means: Tor
  is not running, a proxy host/port is wrong, or the proxy is dead — so every
  request dies before it reaches the platform. Tunnels dialled by our side are
  tagged, the checker reports `can't reach the proxy route (…)` with the OS
  error (`ECONNREFUSED 127.0.0.1:9050`), and:

  - `POST /api/net` returns `route: {ok:false, error, hint, suggest}` immediately
    after you **apply route**, so the dashboard says `⚠ saved, but the route does
    not answer: …` and then names the fix that actually applies: a daemon is
    already answering on another port (`suggest.torSocks`, one click to adopt —
    Tor Browser listens on **9150**, not 9050), or there is no Tor at all and the
    `▶ start Tor` button is the way out (below);
  - `POST /api/start` **refuses to start** a run on an undiallable route;
  - if the route dies mid-run, the engine stops after 3 straight proxy failures
    instead of marking the whole wordlist as errors.

  `POST /api/net/check` probes the current route on demand. The probe does a TCP
  connect to the proxy (plus the SOCKS5 greeting) and also warns when a Tor
  control port is unreachable — that alone does not stop rotation, it only
  disables `SIGNAL NEWNYM`.

### Starting Tor from the dashboard (`▶ start Tor`)

Section **4 · Exit IP** shows the daemon state and, in Tor mode, `▶ start Tor` /
`■ stop Tor`. `lib/tor.js` starts and manages the daemon itself, from a generated
torrc:

```
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
ControlPort 127.0.0.1:9051
HashedControlPassword 16:…        # minted by `tor --hash-password`, random
CookieAuthentication 0
DataDirectory <temp dir>
ClientOnly 1
AvoidDiskWrites 1
Log notice stdout
```

so per-request circuit isolation **and** `SIGNAL NEWNYM` both work with no setup
on your side (the plaintext control password never lands in the torrc). `■ stop
Tor` kills it and removes its DataDirectory.

| Situation | What the dashboard does |
|---|---|
| a Tor is already listening (e.g. **Tor Browser**, 9150) | adopts it as-is — no control password for someone else's daemon, so rotation is per-request circuit isolation |
| a `tor` binary exists, nothing listening | `▶ start Tor` runs one on 9050/9051 (or the next free port) and switches the route to it in one click |
| **no `tor` binary (a container)** | `▶ start Tor` fetches the official **Tor Expert Bundle**, verifies it and runs **that** — one click, no shell, nothing installed system-wide (below) |

#### `▶ start Tor` with no Tor on the host

`lib/torbundle.js` removes the last manual step. On a host with no `tor` binary
(Fresh container? No package lists? No shell?) the button:

1. reads `dist.torproject.org/torbrowser/` and picks the newest **stable** release
   (alphas such as `16.0a11` have no expert bundle);
2. downloads `tor-expert-bundle-linux-x86_64-<version>.tar.gz` (~32 MB) with live
   progress, and pulls `sha256sums-signed-build.txt` from the same release folder;
3. **refuses to run the download unless the SHA-256 matches** the published one;
4. unpacks it — with a streaming tar reader over `zlib`, so the `tar` binary is
   not needed either — keeping only the daemon, its shared libraries and the
   geoip table (the bundle's debug symbols, docs and bridge transports are ~50 MB
   of dead weight, so the cache ends up ~20 MB);
5. runs it exactly like a system tor, with `LD_LIBRARY_PATH` pointing at its
   bundled libevent/OpenSSL, and switches the route to it.

Progress is shown live in section 4 (`downloading Tor 15.0.22 — 42% (13.5 MB of
32.3 MB)`, `verifying the Tor download (SHA-256)…`, `bootstrapping into the
network — 45%`), because a first start takes ~30–60 s. The bundle is kept under
`~/.snipr/tor/<version>/` (override with `SNIPR_TOR_HOME`), so every later start
is instant, and it is never installed system-wide: nothing is written outside
that cache, and deleting the directory removes it completely.

Automatic setup covers Linux x86_64 and macOS (x86_64/arm64), the platforms the
Tor Project publishes expert bundles for; elsewhere the line says so and falls
back to `apt-get install tor` / `brew install tor` or a proxy list. The download
is an HTTPS fetch from `dist.torproject.org` checked against the checksum
published next to it — the same trust model as the Tor Browser updater, not a
GPG signature check.

The daemon is a child of this app and is killed when the app exits, so a preview
restart never leaves an orphan holding 9050. If the download fails, the button
reports why and Tor mode stays off — no half-installed state is left behind.
`TOR_DISCOVER_PORTS` (default `9050,9150`) lists the ports probed for an existing
daemon.

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
| `TOR_DISCOVER_PORTS` | ports probed for an already-running Tor daemon (default `9050,9150`) |
| `SNIPR_PROXY_LIST` | comma/newline separated proxy list (implies `list`) |
| `TOR_SOCKS` | Tor SOCKS5 address, default `socks5://127.0.0.1:9050` |
| `TOR_CONTROL` | Tor control address, default `127.0.0.1:9051` |
| `TOR_CONTROL_PASSWORD` | password for the control port (omit to clear) |
| `SNIPR_TOR_HOME` | where a fetched Tor bundle is cached (default `~/.snipr/tor`) |
| `SNIPR_TOR_MIRROR` | base URL for the Tor release listing/download (default `https://dist.torproject.org/torbrowser/`) |

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
- **If you see `guns.lol rejected this IP (HTTP 401)` for every name**, that is
  Cloudflare refusing the exit, not the usernames: it is the *route* that needs
  changing (route **off** on a normal connection, or a residential proxy list),
  not the delay. With a rotating route the same message says *"rejected every
  exit we tried"*, which means all of the route's exits are flagged. The run
  stops after 12 in a row instead of grinding on — nothing is silently scored as
  `taken`.
- **Tor mode needs a Tor daemon on the same machine as this app** — and
  `▶ start Tor` now supplies one itself, downloading the official bundle when the
  host has no `tor` binary (above). You therefore no longer need a shell, a
  package manager or a locally installed Tor to use Tor mode.
- **Tor exits are still Tor exits, and guns.lol knows.** A rotation changes the
  IP, it does not make a Tor exit look residential: real sweeps through the
  fetched bundle produce `kind: blocked` (`guns.lol rejected every exit we tried
  (HTTP 403)`) and the run stops after 12 in a row. Where a target rejects Tor
  wholesale, use a **proxy list** (`socks5://…` / `http://…`, e.g. a residential
  proxy provider) or leave the route **off**.

Every one of the behaviours above is covered — cookie replay, one exit per
redirect chain, cookies dropped on a Tor rotation, 401 retried only when the
route can rotate, rejected exits skipped, identity/route health, Tor discovery,
the generated torrc, and the whole Tor bundle path (release listing, platform
artifact name, checksum parsing and mismatch rejection, tar extraction against a
mock Tor Project server, cache reuse, install progress). Run the proxy test
suite (mock SOCKS5 server, mock CONNECT proxy, mock Tor control port, real HTTPS
through the tunnel):

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
| `GET /api/net` | current rotating-exit config + live stats (requests routed, rotations, exits seen, errors) + Tor daemon/binary state |
| `POST /api/net` | `{mode: off\|tor\|list, torSocks, torControl, torPassword, isolate, rotateEvery, rotateIntervalMs, list, discoverPorts}` |
| `POST /api/net/tor` | `{action: start\|stop\|status, install?}` — start a **managed local Tor** (generated torrc, `IsolateSOCKSAuth`, random control password) and switch the route to it, or stop the one this app started. A start with no `tor` on the host fetches and verifies the official Tor bundle first (`install: false` disables that); `status` is cheap and carries the install/daemon progress the dashboard polls while a start runs |
| `POST /api/net/check` | probe the configured route → `{ok, error, results[]}` (TCP/SOCKS5 reachability, no traffic to the target) |
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
