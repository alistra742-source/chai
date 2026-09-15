# SNIPR — real-browser sniper console

Six **real Chromium browsers**, one live cam each, all walking the sniper site
you picked — and a dashboard that shows the name **the site actually sniped**,
never the name it was trying for.

There is no simulation, no demo mode and no fake counter anywhere in this
project. Either a real browser drives the real site and the site's own words are
reported, or the dashboard says exactly what stopped it.

```bash
npm i playwright            # once
npx playwright install --with-deps chromium   # a real browser + its system libs
node server.js              # http://localhost:3000
```

On a desktop with Chrome or Edge installed you can skip the browser download:
SNIPR launches installed **Google Chrome** first, then **Edge**, then Playwright's
Chromium, and reports which one it used.

## The flow (exactly what each browser does)

For **Discord** and for **guns.lol** — both on `usersniper.com` by default:

1. **open** the sniper site
2. **sign in** to *your* account (you paste it in the dashboard; see below)
3. **Names** tab
4. pick the **pattern** — `4C` by default (`3L`, `3C`, `4L`, `4C`, or whatever the
   site calls it, typed into the Advanced panel)
5. **wait** for the names to load, and actually confirm they did (rows on screen,
   no loading/busy text) before moving on
6. click **Randomize**
7. open the platform's **Sniper** tab (`Discord Sniper` / `guns.lol`)
8. click **Start**
9. **watch** — every browser keeps reading the site's own output

All six browsers run the whole sequence themselves, staggered so the site is not
slammed by six simultaneous logins. The first browser signs in and its session
cookies are handed to the other five.

## "Whatever it snipes" — how a snipe is decided

A name only reaches the **Sniped** panel when the *site* says it got something.
Each browser is tapped three ways, all real:

- **fetch / XHR responses** — wrapped in the page before any site script runs
- **WebSocket frames** — read through CDP (`Network.webSocketFrameReceived`), so
  the site's own realtime socket is observed, not replaced
- **rendered text** — the lines the site paints

A payload counts as a snipe only if it claims one (`claimed` / `sniped` /
`grabbed`, `"success":true` with a name, or a success word right next to a name
like `Sniped: vx91`). A bare `"username":"attempt1"`, a `"taken":true` answer or a
`"taken":false` availability answer is **not** a snipe — that is just the name
being tried, which is precisely the thing the dashboard must not dress up as a
result. Those availability mentions go to a separate **“Site says available”**
panel instead. Each snipe keeps the exact line it came from, so nothing is
invented.

The **Site traffic** panel shows the raw fetch/XHR/WS/DOM lines the site
produced. If the site words a claim differently than expected, the Sniped panel
stays empty and that panel shows the real wording — one line is then enough to
teach it (`POST /api/parse` will show you how any message would be read).

## Your account

SNIPR **never registers accounts**. Automating signup on someone else's service
is not something this tool does, so bring an account you already have:

- paste your email/username + password into section 4 of the dashboard — they are
  held in this Node process's memory only, never written to disk, and sent
  nowhere except the site's own login form; or
- set `USERSNIPER_EMAIL` / `USERSNIPER_PASSWORD` in the environment; or
- run with `SNIPR_HEADFUL=1`, sign in once by hand in the visible browser.

If no login form is on screen, the browsers are already signed in — nothing to do.

## Cam wall

Every browser is screenshotted about once a second (`Page.captureScreenshot`) and
served at `/api/cam/1.jpg … /api/cam/6.jpg`; the dashboard shows all six with the
step each browser is on and its last action. Before a run the frames are empty
(`204`) — never a placeholder image.

## Configuration

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | listen address (default `3000` on `0.0.0.0`) |
| `SNIPR_HEADFUL` | `1` = show the real browser windows (needs a desktop session) |
| `USERSNIPER_EMAIL`, `USERSNIPER_PASSWORD` | the account the browsers sign in with |

In the dashboard: platform, pattern, browser count (1–6), headful toggle, your
account, and an **Advanced** panel for the site URL and the **Names**/sniper tab
labels. Every control is found by its **visible text** — exact matches beat
partial ones, real buttons beat wrapper divs, and “Stop” can never be mistaken
for “Start”. If the site renames a tab, type the new label in Advanced and it is
used instead of the guess. Nothing about the site's markup is hardcoded, which is
also why a first run is logged step by step: if a label ever differs, the log
names the exact step and the text it was looking for.

## API

| Endpoint | Description |
|---|---|
| `GET /api/state` | everything the dashboard draws: browser verdict, flows, patterns, run steps, per-browser telemetry, snipes, availability mentions, raw site traffic |
| `POST /api/start` | `{platform, pattern, browsers, headful, site?, namesTab?, sniperTab?}` — opens the real browsers and walks the flow |
| `POST /api/stop` | stops the run and closes the browsers |
| `POST /api/login` | `{platform, email, password}` — memory only |
| `POST /api/probe` | can *this machine* reach the site? (real request; Cloudflare refusing the server is expected and does not block the real browsers) |
| `POST /api/parse` | `{text}` — how a site message would be read (`sniped` vs `found`) |
| `GET /api/cam/1..6.jpg` | live screenshot of browser N (`204` before a run) |
| `GET /api/snipes.txt` | download the sniped names (also appended to `results/sniped_<platform>.txt`) |
| `GET /api/health` | liveness |

## Tests

```bash
npm test        # pure flow/extraction tests, then a real HTTP smoke test
```

`test/siteflow.test.js` pins the parts that must not drift: the flow order, the
pattern math (`4C` = 36⁴ = 1,679,616), and — most importantly — that an
*attempt* can never be read as a snipe while real claims and wrapped WebSocket
frames still are. `test/server.test.js` boots the server on a throwaway port and
checks the dashboard, the state shape, the `204` cams, and that bad requests are
refused. Neither suite opens a browser or touches the live site.

## Honest caveats

- **The flow needs a real browser**: `npx playwright install --with-deps chromium`
  (bare `install chromium` downloads the binary but not the system libraries it
  links against, which is what “error while loading shared libraries:
  libglib-2.0.so.0” means).
- **Cloudflare**: usersniper.com answers this kind of request with `403` — the
  real browsers in the flow are the ones that matter, and the probe button shows
  what the server alone gets.
- **Six browsers, one account**: the session is shared, so nothing depends on six
  logins succeeding; drop to 1–2 browsers if the site dislikes parallel sessions.
- **Sniping usernames can violate a platform's terms of service**, and claiming a
  name you never intend to use takes it from someone else. An account you own,
  sane browser counts, and no hammering. You are responsible for how you use this.
