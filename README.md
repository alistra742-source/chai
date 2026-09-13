# SNIPR — multi-platform username sniper

A self-hostable username sniper/availability checker for **guns.lol**, **Discord**,
**Instagram** and **TikTok**, with a web dashboard, a **6-browser swarm with a live
cam wall**, and exact possibility/remaining math.

Pick a platform, pick a target pattern (`3L`, `3C`, `4L`, `4C`, custom
length/charset, or a paste-your-own list), and sweep the whole space while the
dashboard shows:

- **possibilities** — exact size of the target space (`26³ = 17,576`, `36³ = 46,656`, `26⁴ = 456,976`, `36⁴ = 1,679,616`)
- **valid** — usernames that are free/unclaimed (hits)
- **taken / invalid / premium 💎 / errors** — the rest, counted separately
- **left to check** — `total − checked`, live, plus speed and ETA

## Run it

```bash
node server.js          # zero dependencies for demo/server/browser engines, Node 18+
# open http://localhost:3000
```

## Engines

| Engine | What it does |
|---|---|
| **Demo** | Deterministic simulation — works anywhere, even with no internet. |
| **Server** | Real checks fired from the machine running `server.js`. The actual sniper when self-hosted on your own IP. |
| **Browser-direct** | Real checks from **your** browser (Discord via the CORS-enabled Pomelo endpoint; others relayed through `/api/proxy`). |
| **⚡ Swarm** | **SIX real headless Chrome browsers sniping at the same time**, each with a **live screenshot cam** streamed to the dashboard. |

### Swarm — 6 real browsers + live cam

```bash
npm i playwright
npx playwright install chromium
node server.js        # pick "⚡ SWARM" in the engine dropdown
```

- Launches **6 isolated browser contexts** (6 UA-fingerprinted "browsers"), each pulling
  names from the shared scramble cursor concurrently.
- Real page loads per username (`guns.lol/<name>`, `tiktok.com/@<name>`, `instagram.com/<name>/`);
  Discord is checked via `fetch` **from inside a live discord.com page** (real browser TLS/cookies).
- **LIVE CAM**: every browser's screen is captured ~1×/s (`Page.captureScreenshot`) and served
  at `/api/cam/1.jpg … /api/cam/6.jpg` — the dashboard shows a 6-pane camera wall with
  per-browser target/counters overlaid.
- **HYDRA fallback**: if Playwright isn't installed on the host, the swarm automatically runs
  as **6 parallel Web Workers inside your own browser** instead — same cam wall, but the panes
  stream per-worker telemetry (current target / checked / valid / last status) instead of video.
  Workers auto-degrade to simulation if the host has no outbound access (badge shows *SIM*).
  Discord checks stay **real** in HYDRA — they go straight from your browser to Discord.

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
6 browsers pulling from the same cursor.

## API

| Endpoint | Description |
|---|---|
| `GET /api/state` | live counters + swarm mode/worker telemetry + feed |
| `GET /api/swarm` | playwright available? swarm running? per-browser stats |
| `GET /api/cam/1.jpg…6.jpg` | live screenshot of browser N (swarm mode) |
| `POST /api/start` | `{platform, engine: demo\|server\|browser\|swarm, target, concurrency, delay, shuffle}` |
| `POST /api/stop` | abort run + kill browsers |
| `GET /api/targets?start=&n=` | next chunk of names (hydra/browser workers) |
| `POST /api/report` | workers post results back |
| `POST /api/proxy` | server-side batch check (hydra, non-Discord) |
| `POST /api/check` | single ad-hoc check |
| `GET /api/hits.txt` | download the valid hits |

Hits are appended to `results/hits_<platform>_<pattern>.txt`.

## Legal

Educational tool. Automated availability checking can violate the ToS of the platforms involved —
keep request rates low, and don't use hits for squatting, impersonation or fraud. You are
responsible for what you do with it.
