# Barcelola WhatsApp Bot — Redesign Design Doc

**Date:** 2026-04-25
**Status:** Draft, pending user review
**Author:** Brainstorming session with Claude

## 1. Purpose

Automate the WhatsApp operations of a Barcelona tour agency:

1. **Nightly broadcast (21:30 Europe/Madrid)** — publish tomorrow's tour list to a known set of WhatsApp groups, then close each group to non-admin messaging.
2. **Morning broadcast (08:30 Europe/Madrid)** — re-open the groups and send a good-morning message re-confirming today's tours.
3. **Booking confirmation (real-time)** — when a booking happens on the Wix website, DM the client a confirmation in WhatsApp.

Tours with 0 bookings are excluded. A staged rollout mechanism (explicit allowlist → rule-based → open) gates who receives booking-confirmation DMs during the initial debug period.

The existing codebase is not being reused as-is. Useful pieces (whatsapp-web.js integration patterns, QR flow) may be referenced but the project is restructured from scratch.

## 2. Key decisions

| # | Decision | Notes |
|---|---|---|
| 1 | Hybrid Wix integration | Webhook for real-time bookings + REST API poll for nightly/morning tour list |
| 2 | Single always-on Node process with in-process cron | No serverless (whatsapp-web.js needs persistent Chromium) |
| 3 | Two independent controls: pause-automations and disconnect-WhatsApp | Both persistent across restart |
| 4 | Session files on local disk (Fly.io volume in prod) | Manual migration path; no cloud-sync |
| 5 | Minimal single-page admin web UI (plain HTML + vanilla JS) | No React build step |
| 6 | Broadcast to known group list (newsletter model) | One message, many groups; test-group override during debug |
| 7 | Tour copy = local YAML (Hebrew description, meeting point); Wix = operational data (which tours, times, bookings) | Config lives in git |
| 8 | Wix read-only | Bot never cancels/writes to Wix |
| 9 | Fail-loud admin check before each broadcast | Bot must be admin of every target group |
| 10 | Bounded retry (3 attempts, 1m/5m/15m backoff) | Morning re-open is the safety net for nightly close failures |
| 11 | 0 tours tomorrow → skip broadcast, still close groups | No alert; rare edge case in current traffic |
| 12 | Min bookings = 1 | Configurable via settings.yaml |
| 13 | Node.js + TypeScript | whatsapp-web.js is Node-native; TS catches wrong-field/typo bugs |
| 14 | YAML for static config, SQLite for runtime data | Groups/tours/templates/allowlist in YAML; event log + job history + dedup in SQLite |
| 15 | Fly.io for production (Madrid region) | Docker-packaged; portable if we change platforms |
| 16 | Cloudflare Tunnel (named, persistent URL) for local webhook dev + curl fixtures for fast loop | No ngrok |
| 17 | Europe/Madrid timezone with DST | node-cron with timezone option |
| 18 | Lean testing — iteration speed over coverage | Unit tests on pure modules, a handful of integration tests on jobs + webhook handler |

## 3. Architecture (single process, modular monolith)

```
┌─────────────────────────────────────────────────┐
│              Single Node.js Process              │
├─────────────────────────────────────────────────┤
│  HTTP (Express)                                  │
│  ├─ POST /webhook/wix (from Wix)                │
│  ├─ GET/POST /admin/* (minimal HTML UI + API)   │
│  └─ GET /healthz                                 │
├─────────────────────────────────────────────────┤
│  Scheduler (node-cron, Europe/Madrid)           │
│  ├─ 21:30 → nightly job                         │
│  └─ 08:30 → morning job                         │
├─────────────────────────────────────────────────┤
│  Core modules                                    │
│  ├─ WhatsAppClient   (wrap whatsapp-web.js)     │
│  ├─ WixClient        (Wix REST API)             │
│  ├─ MessageBuilder   (pure: data + templates)   │
│  ├─ Broadcaster      (send to group list)       │
│  ├─ GroupAdminService(close/open, admin check)  │
│  ├─ BookingHandler   (webhook → DM flow)        │
│  ├─ AllowlistGate    (staged rollout filter)    │
│  ├─ ConfigLoader     (YAML + zod)               │
│  ├─ ControlState     (pause/connection flags)   │
│  └─ EventLog         (SQLite + winston)         │
└─────────────────────────────────────────────────┘
```

### Module boundaries

- `whatsapp/`, `wix/` are **adapters**; only these modules know about external APIs. Everything else speaks domain types.
- `jobs/` is the only layer that **orchestrates** — calling multiple services in sequence.
- `messaging/builder.ts` is **pure** — `(tours, templates, date) => string`. No I/O. Easiest to test.
- `persistence/` is the only module that touches SQLite.
- `control/state.ts` holds the in-memory pause/connection state; persisted to SQLite on change.

### Why single-process

At this scale (a few groups, dozens of bookings/day, one WhatsApp number) splitting into multiple services adds coordination complexity without payoff. Fly.io auto-restart covers the single-point-of-failure concern. If the project grows beyond this shape, splitting is a clean future move.

## 4. Project layout

```
whatsapp-bot/
├── src/
│   ├── config/
│   │   ├── loader.ts          # reads + validates YAML (zod)
│   │   └── schemas.ts         # zod schemas per file
│   ├── whatsapp/
│   │   ├── client.ts          # whatsapp-web.js wrapper
│   │   ├── session.ts         # LocalAuth at ./data/session
│   │   └── groupAdmin.ts      # close/open, admin check
│   ├── wix/
│   │   ├── client.ts          # Wix REST (typed)
│   │   ├── webhookVerifier.ts
│   │   └── types.ts
│   ├── messaging/
│   │   ├── builder.ts         # pure compose
│   │   ├── broadcaster.ts     # multi-group send w/ rate limit
│   │   └── directMessage.ts   # DM with allowlist gate
│   ├── jobs/
│   │   ├── nightlyJob.ts
│   │   ├── morningJob.ts
│   │   └── runner.ts          # common wrapper (retry, dry-run, logging)
│   ├── webhook/
│   │   └── bookingHandler.ts
│   ├── http/
│   │   ├── server.ts
│   │   ├── adminRoutes.ts
│   │   └── webhookRoutes.ts
│   ├── control/
│   │   ├── state.ts
│   │   └── commands.ts
│   ├── persistence/
│   │   ├── db.ts              # better-sqlite3
│   │   ├── eventLog.ts
│   │   ├── jobHistory.ts
│   │   ├── webhookDedup.ts
│   │   └── pendingDms.ts
│   ├── log/
│   │   └── logger.ts          # winston: console + rotating file
│   ├── scheduler.ts           # node-cron bootstrap
│   └── index.ts               # wiring + startup
├── config/
│   ├── groups.yaml
│   ├── tours.yaml
│   ├── templates.yaml
│   ├── allowlist.yaml
│   └── settings.yaml
├── data/                      # gitignored: session + sqlite + logs
├── tests/
│   ├── fixtures/
│   ├── unit/
│   └── integration/
├── web/                       # admin UI static assets
├── Dockerfile
├── fly.toml
├── .env.example
├── tsconfig.json
└── package.json
```

## 5. Configuration files

All YAML files live in `config/`. Loaded + validated on startup via `zod`. Invalid config → startup fails with a clear error. A "Reload config" button in the admin UI re-runs the loader without restarting.

### `config/groups.yaml`
```yaml
groups:
  - id: "120363012345678901@g.us"
    name: "Barcelola Tours - Main"
    active: true
  - id: "120363098765432109@g.us"
    name: "Barcelola Tours - Weekend"
    active: true
```

### `config/tours.yaml`
```yaml
# Keyed by Wix tour ID. Must match exactly.
tours:
  gaudi-modernista:
    name_he: "המסע בעקבות גאודי והמודרניסטה"
    emoji: "🌻"
    description_he: |
      בסיור נלמד ונכיר את הקטלאני המפורסם מכולם...
    meeting_point_he: "10:15 בכניסה למסעדת הארד רוק קפה, פלאסה קטלוניה."
  born-to-be-wild:
    name_he: "כשאומנות וקולינריה נפגשים Born to be wild"
    emoji: "🌻"
    description_he: |
      סיור לשכונת בורן - טיול בשכונה הכי שיקית בעיר...
    meeting_point_he: "15:50 בכניסה למטרו Jaume I צמוד למלון Suizo"
```

### `config/templates.yaml`
```yaml
night_header: |
  *לילה טוב לכל המטיילים והמטיילות האהובים מ- Barcelola Tours ✨🌜*

  ❤️ *לנמצאים בברצלונה - הצטרפו לסיורי ברצלולה, מחר {weekday_he} ה-{date}* ❤️

  *סיורים חינם על בסיס טיפ בתוך העיר*

morning_header: |
  *בוקר טוב לכל המטיילים והמטיילות ☀️*
  *היום {weekday_he} ה-{date} — הסיורים שיתקיימו:*

footer: |
  🌻 *למידע נוסף והרשמה לסיורים הכנסו לאתר שלנו:*
  https://www.barcelola-tours.com/barcelolatours

  🌻בואו גם ל *קבוצת הפייסבוק* שלנו!
  https://www.facebook.com/groups/barcelolatours/?ref=share

tour_block: |
  {emoji} {time_range}
  *{name_he}*
  {description_he}
  *נקודת ושעת מפגש* - {meeting_point_he}

booking_confirmation: |
  שלום {client_name}! 👋
  אישור הזמנתך לסיור *{tour_name_he}* בתאריך {date} בשעה {time}.
  נתראה! 🌻
```

### `config/allowlist.yaml`
```yaml
mode: "explicit"   # explicit | rule | open
explicit_phones:
  - "+972501234567"
  - "+34600111222"
rule:
  country_codes: ["+972", "+34"]
```

### `config/settings.yaml`
```yaml
timezone: "Europe/Madrid"
schedule:
  nightly_cron: "30 21 * * *"
  morning_cron: "30 8 * * *"
broadcast:
  mode: "test"              # test | production
  test_group_id: "120363...@g.us"
  inter_message_delay_ms: 2000
min_bookings_to_run: 1
retry:
  max_attempts: 3
  backoff_ms: [60000, 300000, 900000]
```

**Secrets** (Wix API key, webhook signing secret, admin UI password hash, session cookie secret) live in `.env` / Fly secrets — never in YAML, never in git.

## 6. Data flows

### 6.1 Nightly job (21:30 Europe/Madrid)

```
cron fires
  └─ runner wraps nightlyJob (try / retry / log / job_runs row)
       └─ nightlyJob:
            1. automations paused? → abort, mark skipped
            2. WhatsApp connected? → abort + alert event, mark failed
            3. WixClient.getToursForDate(tomorrow)
                 → [{ id, time, bookingCount, ... }]
            4. filter tours where bookingCount >= min_bookings_to_run
            5. if filtered list empty:
                 → skip broadcast (no message sent)
                 → proceed to close groups
            6. else:
                 MessageBuilder.buildNightMessage(tours, tomorrow) // pure
                 resolve target groups:
                   - settings.broadcast.mode === "test" → [testGroupId]
                   - else → all groups where active=true
                 GroupAdmin.verifyAdmin(targets)  // fail loud per group
                 Broadcaster.send(message, targetGroups)
                   - inter_message_delay_ms between sends
                   - 3 retries per group on failure
            7. GroupAdmin.closeAll(targetGroups)
                 - setMessagesAdminsOnly(true) per group
                 - 3 retries per group
            8. finalize job_runs row: started_at, ended_at, outcome
```

### 6.2 Morning job (08:30 Europe/Madrid)

```
cron fires
  └─ morningJob:
       1. paused? connected? (same checks as nightly)
       2. resolve target groups (same rules)
       3. GroupAdmin.openAll(targetGroups)  // ALWAYS, even if no message
       4. WixClient.getToursForDate(today)
       5. filter bookingCount >= min_bookings_to_run
       6. if empty → no message sent; groups already reopened, done
       7. else:
            MessageBuilder.buildMorningMessage(tours, today)
            Broadcaster.send(message, targetGroups)
       8. finalize job_runs row
```

### 6.3 Booking webhook (real-time)

```
POST /webhook/wix
  1. verify signature + payload shape (401 on fail, log)
  2. extract: booking_id, phone, client_name, tour_id, date, time
  3. webhookDedup: already seen booking_id? → 200 OK, log, done
  4. insert "processing" row in processed_webhooks
  5. BookingHandler.handle(booking):
       a. normalize phone → +CC...
       b. AllowlistGate.allows(phone)? → no: mark "skipped_allowlist", done
       c. automations paused? → mark "skipped_paused", done
       d. WA disconnected? → enqueue into pending_dms, mark "deferred", done
       e. build confirmation text
       f. DirectMessage.send(phone, text) (3 retries)
       g. mark dedup row "sent" or "failed"
  6. 200 OK to Wix
```

**Pending-DMs drain:** on every successful WA reconnect, `pendingDms.drain()` iterates pending rows oldest-first, sending each. Failed rows get `attempts++` and remain pending until `attempts >= max_attempts`, then marked `abandoned`.

## 7. Data model (SQLite, better-sqlite3)

Single idempotent migration run on startup.

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  level       TEXT NOT NULL,                 -- info | warn | error
  source      TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  message     TEXT NOT NULL,
  metadata    TEXT
);
CREATE INDEX idx_events_ts ON events(ts DESC);
CREATE INDEX idx_events_type ON events(event_type);

CREATE TABLE job_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name      TEXT NOT NULL,              -- nightly | morning
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT NOT NULL,              -- running | success | partial | failed | skipped
  tours_count   INTEGER,
  groups_sent   INTEGER,
  groups_closed INTEGER,
  dry_run       INTEGER DEFAULT 0,
  error         TEXT,
  metadata      TEXT
);
CREATE INDEX idx_job_runs_started ON job_runs(started_at DESC);

CREATE TABLE processed_webhooks (
  booking_id    TEXT PRIMARY KEY,
  received_at   TEXT NOT NULL,
  completed_at  TEXT,
  outcome       TEXT                         -- sent | skipped_allowlist | skipped_paused | deferred | failed
);

CREATE TABLE pending_dms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  body        TEXT NOT NULL,
  booking_id  TEXT,
  created_at  TEXT NOT NULL,
  attempts    INTEGER DEFAULT 0,
  last_error  TEXT,
  status      TEXT NOT NULL                  -- pending | sent | abandoned
);
CREATE INDEX idx_pending_dms_status ON pending_dms(status);

CREATE TABLE control_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- seeded: ("automations_paused", "false"), ("last_connect_state", "disconnected")
```

**Retention:** a daily prune job keeps `events` and `job_runs` to last 90 days. `processed_webhooks` keeps last 180 days (safety margin for Wix retries).

## 8. Admin web UI

Single HTML page at `/admin`, protected by admin password (bcrypt hash in `.env`). Plain HTML + vanilla JS; partials are re-fetched every 5s for live status. No React, no build step.

### Sections (single-page)

- **Status** — WhatsApp state (connected / qr_pending / disconnected), paused state, broadcast mode (test/production), target group count. Buttons: Pause/Resume, Disconnect, Reset session.
- **QR code** — visible only when `qr_pending`.
- **Next scheduled** — next nightly + morning times in Europe/Madrid. Buttons: Run Nightly (dry-run), Run Nightly (live), same for morning, Re-open all groups, Close all groups.
- **Last job outcomes** — last 5 job runs with status, tour count, group count, error (if any). Link to full history.
- **Recent events** — tail of the event log (last 100), incremental refresh (`?since=<event_id>`), level filter.
- **Config summary** — counts of groups/tours/allowlist, last-loaded timestamp. Button: Reload config.

### Endpoints

```
GET  /admin                       → full HTML
POST /admin/login                 → session cookie
GET  /admin/partials/status
GET  /admin/partials/events?since=<id>
GET  /admin/partials/qr
POST /admin/connect
POST /admin/disconnect
POST /admin/pause
POST /admin/resume
POST /admin/jobs/nightly          body: { dry_run: boolean }
POST /admin/jobs/morning          body: { dry_run: boolean }
POST /admin/groups/close-all
POST /admin/groups/open-all
POST /admin/config/reload
```

### Dry-run behavior

Dry-run renders the composed Hebrew message in the UI (modal or result panel). No WhatsApp send. `job_runs` row written with `dry_run=1` for audit.

## 9. Reliability, error handling, and control

### Connection state machine

```
disconnected ──(connect)──▶ qr_pending ──(scanned)──▶ connected
     ▲                           │                        │
     └──(disconnect / auth fail / logout)─────────────────┘
```

State held in memory (`whatsapp/client.ts`), mirrored to `control_state`. UI polls every 5s.

### Pause vs Disconnect semantics

| Control | Cron jobs | Webhook DMs | WA client |
|---|---|---|---|
| Pause automations | skipped (logged) | skipped (logged) | stays connected |
| Disconnect WA | abort + mark failed | enqueued to pending_dms | disconnected |

Both independent, both persistent, both toggleable from UI.

### Retry policy

- **WhatsApp sends (groups + DMs):** 3 attempts, backoff 1m/5m/15m. Final failure → logged, outcome recorded.
- **Group close/open:** 3 attempts, same backoff. Admin-check failure on a group is **fail loud** — that group is skipped, job outcome becomes `partial`, other groups proceed.
- **Wix API calls:** 3 attempts, backoff 5s/15s/45s. Final failure in job → job marked `failed`, no broadcast sent (safer than incomplete list).
- **Wix webhook:** verify signature + dedup inline, then respond 200 to Wix immediately. The actual send runs asynchronously (fire-and-forget inside the Node process, outcome recorded back into `processed_webhooks` + `events`). Wix retries if it doesn't get a 200, and our dedup ensures retries are no-ops. Future: external queue (redis/sqs) if processing latency ever matters.

### Rate limiting

`inter_message_delay_ms` (default 2000) between sends to different groups. Tuned empirically if WhatsApp throttles.

### Crash recovery

Fly.io auto-restart. On startup:
- Any `job_runs` in `running` state > 1h old → marked `failed` with `error = "process restart"`.
- `pending_dms` in `pending` state → drained after WA reconnects.

### Observability

- Structured events written to both winston console + rotating file log (`data/logs/app-YYYY-MM-DD.log`, 14-day rotation) AND to `events` table for UI consumption.
- Every external action (send, close, open, Wix call, webhook receive) logs before + after with structured metadata.
- `GET /healthz` → `{ wa: "connected" | "disconnected" | "qr_pending", paused: boolean, uptime_s: number }`.

## 10. Testing strategy (lean)

- **Unit tests (vitest)** — pure modules:
  - `messaging/builder.ts` — snapshot Hebrew output for various tour lists.
  - `config/loader.ts` — valid + invalid YAML fixtures.
  - `allowlistGate` — explicit / rule / open modes.
  - Phone normalizer — international / local / malformed.
- **Integration tests (vitest + temp SQLite)** — with mocked Wix and WhatsApp clients:
  - `jobs/nightlyJob` happy path + 0 tours + test mode + paused.
  - `jobs/morningJob` happy path.
  - `webhook/bookingHandler` — allowlist gated, dedup, WA disconnected → defer.
  - Retry behavior — mock client fails N times, verify attempt count + backoff.
- **Manual/E2E (occasional)** — QR scan on fresh install, real Wix webhook via Cloudflare Tunnel, dry-run nightly against real Wix data, one live nightly against test group.

### Not tested
- whatsapp-web.js internals (thin wrapper, mocked).
- Headed-browser visual regression.
- Admin UI visual regression.

### Local dev tooling
- `vitest`, `tsx` (dev runner), `eslint`, `prettier`, `tsc --noEmit` gate.
- Pre-commit: lint + typecheck + test.

## 11. Deployment

### Local dev
- `.env.local` (gitignored) for secrets.
- `npm run dev` → `tsx watch src/index.ts`. Admin UI at `localhost:3000/admin`.
- First run: scan QR in admin UI → session persisted to `data/session/`.
- Wix webhook testing: **Cloudflare Tunnel** (named tunnel, persistent URL) → `/webhook/wix` on laptop. Curl fixtures for fast inner loop.

### Production (Fly.io, `mad` region)
- Single VM, Fly volume mounted at `/data` (session + SQLite + logs, survives redeploy).
- Fly secrets: `WIX_API_KEY`, `WIX_WEBHOOK_SIGNING_SECRET`, `ADMIN_PASSWORD_HASH`, `SESSION_COOKIE_SECRET`.
- Health check: `GET /healthz` every 30s. Auto-restart on failure.
- Public HTTPS endpoint exposes both `/webhook/wix` and `/admin`.

### Dockerfile (outline)
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y chromium \
      fonts-noto-color-emoji fonts-noto-hinted \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxrandr2 \
      libxdamage1 libgbm1 libasound2 \
      && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Migration path (laptop → Fly.io)
1. Run stably on laptop for 1–2 weeks in test-group mode.
2. `fly launch` + create volume.
3. `fly ssh sftp` upload `data/session/` to the volume.
4. Flip `broadcast.mode` to `production` in `config/settings.yaml`.
5. Update Wix webhook URL to Fly app URL.
6. Deploy; monitor via admin UI.

## 12. Secrets inventory

- `WIX_API_KEY` — Wix REST API.
- `WIX_WEBHOOK_SIGNING_SECRET` — webhook signature verification.
- `ADMIN_PASSWORD_HASH` — bcrypt.
- `SESSION_COOKIE_SECRET` — express-session / cookie-signing.

## 13. Open questions / deferred decisions

Items flagged during brainstorming to revisit later:

- **Phone format normalization from Wix** — verify during Wix integration. Add a normalizer + log any unexpected formats.
- **Late-booking behavior (after 21:30 announcement)** — current v1: do nothing extra. Future: potentially a special "late booking" confirmation message. Log these cases so we have data.
- **Wix webhook programmatic registration** — explore Wix MCP/API at integration time to avoid manually updating webhook URLs.
- **Rate limit tuning** — start with 2000ms inter-message delay; tune if we hit WhatsApp throttling.
- **Morning header wording** — the current template is a placeholder; user will provide final Hebrew copy when we wire templates up.
- **Additional groups / tours** — user will provide the full list of broadcast group IDs and the full tour-to-description mapping before first production run.

## 14. Future features (out of v1 scope)

- **Rule-based allowlist phase** — country-code / substring match.
- **Full open rollout.**
- **Post-9:30pm booking handling** — special "late booking" message.
- **Incoming message handling / LLM auto-responses** — the existing repo had stubs; not part of v1 redesign.
- **Per-tour group subscriptions** — currently all groups get the same newsletter; future: per-group tour filters.
- **Template/config editing via UI** — v1 is YAML edit + reload; UI editing is deferred.
- **Structured event log UI filters + search** — v1 is simple tail; deferred.
- **Multi-number support** — v1 locks one number.

## 15. Success criteria

- Bot can be connected with one QR scan; subsequent restarts do not require re-scanning.
- Pause and disconnect controls each do what they promise, visible in the admin UI.
- Nightly job at 21:30 Europe/Madrid for 7 consecutive days: posts correct Hebrew message to test group with tour data drawn from Wix; closes groups.
- Morning job at 08:30 Europe/Madrid for 7 consecutive days: re-opens groups and posts good-morning message.
- Booking webhook confirmation DM arrives in WhatsApp within 30s for phones on the allowlist; phones not on the allowlist receive nothing and are logged.
- Admin UI is usable from a phone browser.
- All the above survive a deploy to Fly.io.
