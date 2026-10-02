# Disaster Declaration Watch

A long-running service that polls federal, state, and local sources for new disaster and emergency declarations and pushes an alert (Slack, SMS, webhook) within seconds of the source publishing it.

## What it watches

| Level | Source | Poll | What it's good for |
|---|---|---|---|
| Federal | OpenFEMA declarations + designated areas | 60s / 120s | Authoritative DR/EM/FM record, counties, programs. Also catches counties added to existing declarations. |
| Federal | SBA disaster declarations (Federal Register, including public inspection) | 5 min | SBA administrative and economic-injury declarations, often issued with no FEMA declaration. |
| Federal | White House Presidential Actions + Briefings RSS | 30s | Presidential approvals when they're posted there. |
| State | 130 of the 150 governor press / executive order / emergency agency pages in the state source list | 60–180s | Official governor proclamations and orders, usually the first published source. See [State coverage](#state-coverage). |
| State + local | 6 Google News search feeds | 60s | Counties, cities, parishes, tribes, press reports of presidential approvals, and the states whose sites can't be watched. |

Every item goes through a classifier (`src/classify.ts`) that decides whether it's a declaration, a request, or an expansion, and which level and state it belongs to. Items are then grouped into **events** (`src/events.ts`), so ten outlets covering one governor's declaration produce one alert.

Alert types:

- **NEW**: first time this event has been seen from any source.
- **OFFICIALLY CONFIRMED**: an event first seen in the press now has a government source (governor feed, OpenFEMA).
- **DECLARATION EXPANDED**: an official source added counties to a known declaration.
- **DECLARATION REQUESTED**: a governor asked for a federal declaration. This is usually the earliest signal of a coming federal declaration.
- **DECLARATION RENEWED** (off by default): a standing declaration was renewed or extended, such as Texas's monthly disaster proclamation renewals, Hawaii's "Tenth Proclamation Relating to...", or Alabama's "Second Supplemental State of Emergency". Add `renewed` to `ALERT_STATUSES` to receive these.

## How fast is "seconds"?

Once a source publishes, detection takes one poll interval (30–60s), and delivery takes milliseconds after that. The limit is how quickly each source publishes:

- **Governor feeds:** publish when the press release goes out. This is the fastest official signal.
- **Google News:** usually indexes local coverage within minutes.
- **OpenFEMA:** loads declarations in a daily batch around 11:00 UTC, typically 1–3 days after the declaration date (measured against the Sept 2026 declarations). It's the system of record, not the early warning. Alerts from it are mostly "OFFICIALLY CONFIRMED".
- **fema.gov pages and press releases:** blocked for automated clients (Akamai returns 403), so they aren't used.

Presidential approvals are currently announced mostly on social media, then in the press. Here they show up first through news coverage and the affected governor's feed.

## Run it

Requires Node 24+ (runs TypeScript directly, uses built-in SQLite).

```bash
npm install
cp .env.example .env           # set USER_AGENT and at least one alert channel
node src/index.ts --once       # one pass over every source: connectivity + what it classifies
node src/index.ts --test-alert # send a sample alert through your configured channels
node src/index.ts --digest-preview # print today's digest and write DATA_DIR/digest-preview.html
node src/index.ts --digest     # email the digest now (needs SMTP settings)
node src/index.ts --smoke-test # end-to-end check of every connection; add --send --to=you@org.com to email it
npm start                      # run continuously
npm test
```

The first poll of each source records what's already there **without alerting**, so you don't get a flood of old items at startup. Keep `DATA_DIR` on persistent storage, or every restart re-baselines.

HTTP endpoints (default port 8787):

- `GET /health`: per-source status. Returns 503 if OpenFEMA is failing. Point uptime monitoring here.
- `GET /events?limit=50`: recent events, with the number of sources that reported each.

## Daily email digest

Alongside the real-time alerts, the service emails one end-of-day summary at `DIGEST_TIME` in `DIGEST_TZ` (default 17:00 America/New_York). Set `DIGEST_TO` and an email provider in `.env` to turn it on:

- **Gmail API:** set `MAIL_PROVIDER=gmail`, `GMAIL_CLIENT_ID`, and `GMAIL_CLIENT_SECRET`, then run `node src/index.ts --gmail-auth` once. It opens Google sign-in, asks only to send mail, and saves the refresh token to `.env`. If the OAuth app's publishing status is "Testing", Google expires the token after 7 days; set it to "In production" to keep it.
- **SMTP:** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`.

- **Subject:** the yes/no answer, such as `Disaster watch Thu, Oct 1: YES, 2 new declarations, 1 request` or `Disaster watch Thu, Oct 1: no new declarations`.
- **Alerts:** every alert since the last digest, filtered by `WATCH_STATES` and `ALERT_STATUSES` the same way Slack is.
- **Official endpoints:** a Yes/No row for each of the government endpoints. "Yes" means it listed at least one item it hadn't listed before, or something it posted matched a declaration. Items already present when a source was first watched don't count.
- **Status:** each endpoint is marked `ok`, `unreliable` (more than 25% of checks failed), or `down` (no check succeeded), with the last error. A "No" from a down endpoint means it couldn't be checked, not that nothing was posted.
- **News searches:** one line with the number of new articles and declaration matches.

Each digest covers the time since the previous one was sent, so a restart or a failed send doesn't leave a gap. A failed send retries every 15 minutes. On first start, the window begins at that moment. If that day's send time has already passed, the first digest goes out the next day.

`--digest-preview` and `--digest` cover the time since the last scheduled digest (or the last 24 hours) and don't change the schedule.

### Once a day from cron or launchd, without the always-on service

`node src/index.ts --daily` sends once per day, at or after `DIGEST_TIME` in `DIGEST_TZ`. It does nothing when called earlier, or again after that day's email has gone out, so it's safe to schedule often. When it's due, it waits up to 2 minutes for the network, polls every source once (retrying failures once after 10 seconds), and emails the digest covering everything since the previous email to `DIGEST_TO`, with `DIGEST_CC` copied. A failed send is retried twice; if it still fails, the next check tries again. `--force` sends regardless of the time; `--no-send` prints the digest instead.

On this Mac, `~/Library/LaunchAgents/com.uschamber.disaster-watch.daily.plist` runs it every 10 minutes under `caffeinate -i`, so the email goes out at 3:00 PM Eastern when the Mac is awake, or at the first check after it wakes. It logs to `~/Library/Logs/disaster-watch/daily.log`.

```bash
launchctl print gui/$(id -u)/com.uschamber.disaster-watch.daily   # status and last exit code
node src/index.ts --daily --force                                  # send today's email now
launchctl bootout gui/$(id -u)/com.uschamber.disaster-watch.daily # turn it off
```

The Mac has to be on and awake: a laptop asleep on battery at 3:00 PM sends late. Polling once a day means detection waits for the next run, and the job can open at most 5 linked documents per listing page per run.

## Smoke test

`--smoke-test` checks the whole pipeline against real data without touching the service's database:

1. **Historical replay.** It finds the day with the most FEMA declarations on record (March 13, 2020: 108 COVID-19 emergency declarations across 56 states and territories). Then it replays that day's OpenFEMA declarations and county designations, plus SBA's Federal Register notices from the following two weeks, through classification, event grouping, and alerting. Use `--date=YYYY-MM-DD` to replay a different day.
2. **Live connections.** It polls every source once with nothing baselined and no age limit, so every declaration a site currently lists goes through the classifier. A failed source is retried once after 10 seconds.
3. **State by state.** For each state and territory, it reports the most recent FEMA declaration, how many of the state's own endpoints responded, and how many declarations they listed, with the latest one.

State websites only list their recent items and can't be queried by date, so the state check uses whatever each site lists today. "Connected, no declarations listed" means the site works but nothing on it currently reads as a declaration. The report is printed and written to `DATA_DIR/smoke-test.html`. `--send` emails it to `--to=` (or `DIGEST_TO`) using the SMTP settings.

## Status portal

The daily job, a one-pass check (`--once`), and the always-on digest each post a run to the Chamber status portal. The same calendar day posts once. A failed attempt uses its own id, so a later success the same day is still recorded. Add these to `.env` (they are not committed):

```bash
STATUS_PORTAL_URL=https://usccfruntimemonitor.vercel.app
STATUS_INGEST_TOKEN=the daily disaster watch token from the portal .ingest-tokens file
```

If either value is missing, the watch still runs and prints that the portal was skipped. `poll_stats` has an index on `hour` so a backfill can group a day of checks without scanning every source row.

## Deploy

It's a single always-on process with a small SQLite file. Serverless cron can't poll at sub-minute intervals, so run it on something persistent: a small VM, Fly.io, Railway, or Render with a mounted volume.

```bash
docker build -t disaster-watch .
docker run -d --restart=always -v disaster-watch-data:/data --env-file .env -p 8787:8787 disaster-watch
```

## Configuration

- **`config/sources.json`**: every source. Source types:
  - `rss`: RSS or Atom feed. Set `"mode": "declarations"` for feeds that only carry declarations (every item alerts, even with a bare title).
  - `page`: an HTML listing page. The first poll records every link; later polls look at new links only. A new link alerts if its text reads as a declaration. Otherwise the service opens the linked page or PDF (up to 5 per poll) and classifies that. Options: `linkPattern` / `textPattern` (regexes limiting which links count), `mode: "declarations"`, `inspect: false`, `timeoutSeconds`.
  - `json`: a JSON, GraphQL, or search API behind a JavaScript-rendered newsroom. Takes `url`, an optional POST `body` and `headers`, `itemsPath`, and dot-path `fields` for title, link, date, and summary.
  - `google-news`: any Google News query.
- **Year-specific URLs** need updating each January: Georgia and Nevada executive orders, New Jersey press, Colorado executive orders, Oklahoma OEM, and South Carolina EMD. When one goes stale, it keeps returning the old year's page. It stays "healthy" but stops finding new items.
- **`config/governors.json`**: sitting governors, used to infer the state from headlines like "Gov. Abbott declares...". **Update it after the November 2026 elections** (36 governorships turn over in January 2027).
- **`.env`**: alert channels and filters (`WATCH_STATES`, `ALERT_STATUSES`, SMS rules). See `.env.example`.

By default, SMS only goes out for declarations that involve a government source (`SMS_TIER=official`). Slack and webhooks get everything, including press-only reports and requests.

## Known gaps

- **20 of the 150 state pages can't be watched** (see the table below). Minnesota and Arizona's emergency agency run bot challenges (hCaptcha, Cloudflare), and this service doesn't try to get past them. Kentucky, Michigan, and parts of Ohio, Oregon, and Wyoming render their lists in JavaScript with no public API. New Hampshire returns 403 to automated clients. An extra Google News query targets these states.
- **Browser user agent:** Colorado, Ohio, and the Tennessee Secretary of State reject non-browser clients on public pages, so those sources send a browser user agent (`"browserUserAgent": true`). Every other request identifies itself with `USER_AGENT`.
- **Bandwidth:** HTML pages don't always support conditional requests, so page polling can download up to about 9 GB a day. That's roughly one request per minute per site. Wisconsin's 3.5 MB press page polls every 10 minutes for this reason.
- **Local declarations** (about 3,000 counties and far more cities) have no central feed. Coverage depends on local press, so small jurisdictions may be missed or detected late.
- **State detection** relies on state and governor names in headlines. Unrecognized events still alert, labeled "Unknown state".
- **The classifier is rule-based.** Expect occasional false positives, such as economic "emergencies" like diesel shortages, which are real declarations but not disasters. Real headlines that fail go into `test/classify.test.ts`.
- **Google News RSS** has no formal SLA or license. For commercial use, consider swapping in a licensed news API behind the same `rss` / `google-news` source interface.

## State coverage

How each state's three listed sources (governor press releases, executive orders, emergency management agency) are watched. "feed" means RSS, "page" means HTML page watching, and "API" means the JSON API behind the site. A dash means the source isn't watched; the reason follows in parentheses. Checked Sept 30, 2026.

| State | Press releases | Executive orders | Emergency management |
|---|---|---|---|
| AL | feed | feed | feed (declarations only) |
| AK | feed | feed | page |
| AZ | feed | page | — (ein.az.gov: Cloudflare challenge) |
| AR | page | — (list has no links; orders appear in the newsroom) | feed |
| CA | feed | page (Cal OES proclamations) | feed |
| CO | page | page ("D" disaster orders only) | page |
| CT | page | page | page |
| DE | feed | page | feed |
| FL | page | page | page |
| GA | feed | page | feed |
| HI | feed | feed (emergency proclamations) | feed |
| ID | feed | feed | feed |
| IL | API | page | API |
| IN | API | page | page |
| IA | feed | page | page (disaster proclamations) + news feed |
| KS | page | page | page |
| KY | — (JavaScript-rendered) | — (no order list) | — (JavaScript-rendered) |
| LA | feed | feed | page |
| ME | feed | page | page |
| MD | page | page | — (news loaded by a hidden web part) |
| MA | page | page | page |
| MI | — (JavaScript search) | — (JavaScript search) | — (JavaScript search) |
| MN | — (hCaptcha) | — (hCaptcha) | — (hCaptcha) |
| MS | feed | page | page (msema.org/news) |
| MO | feed | page | page |
| MT | API | page | page |
| NE | feed | page | page |
| NV | page | page | page |
| NH | — (403) | — (403) | page |
| NJ | page | page | page (ready.nj.gov/news; the list repeated the executive-order URL here) |
| NM | page | page | feed |
| NY | page | page | feed |
| NC | feed (NCDPS + governor) | page | feed |
| ND | feed | page | feed |
| OH | page | — (JavaScript-rendered) | page |
| OK | API | page | page (declarations only) |
| OR | page (apps.oregon.gov) | — (JavaScript-rendered) | page |
| PA | API | page (PEMA proclamations) | API |
| RI | feed | — (403) | page |
| SC | page | page | page |
| SD | — (server sends malformed HTTP headers) | page | — (JavaScript app) |
| TN | page | page | page |
| TX | feed | page (proclamations) | page |
| UT | feed | feed (ceremonial declarations, classified) | feed |
| VT | feed | feed | feed (vem.vermont.gov; the list gave Utah DPS's URL) |
| VA | API | page | page |
| WA | feed | page | page |
| WV | feed | page | page |
| WI | page (every 10 min) | page | feed |
| WY | API | — (JavaScript app) | page |

Territories and freely associated states (PR, VI, GU, AS, MP, FM, MH, PW) are covered through OpenFEMA, SBA, and news. The source list had no territory URLs.
