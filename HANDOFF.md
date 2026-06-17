# Session handoff — read before continuing

Read this first when picking up the project in a new session or on a new machine. It summarizes non-code context that the git history alone doesn't capture.

## Project in one line

WhatsApp automation bot for a Barcelona tour agency: nightly + morning broadcasts of tour lists to WhatsApp groups (opening/closing them on a schedule), plus real-time booking confirmation DMs triggered by Wix webhooks.

## Current state

- **All 13 planned implementation phases are complete** on branch `feat/redesign`.
- `cd app && npm test` → 64/64 tests pass; `npm run typecheck` clean; `npm run build` clean.
- Boot smoke test passed on a dev desktop: `/healthz` returns JSON, `/admin` serves, `POST /webhook/wix` acks with outcome, log events are written.
- Wix integration verified end-to-end against the real Wix account: `npx tsx scripts/show-tomorrow.ts` fetched tomorrow's real tour + participant list (names, phones, emails) for the owner's account.
- WhatsApp integration **not yet verified** (see "WhatsApp ban incident" below).
- Remote `origin` is `git@github.com:jasoromir/BarcelolaBot.git`.
- **Deployed on Railway** (project `barcelola-whatsapp-bot`, prod URL `https://barcelola-whatsapp-bot-production.up.railway.app`). Session + DB live on a persistent volume at `/app/data`.

> ⚠️ **If you just opened a session and the bot "isn't working", start here:** check `curl https://barcelola-whatsapp-bot-production.up.railway.app/healthz`. If it shows `"wa":"qr_pending"` or `"disconnected"`, the WhatsApp link died and needs a **fresh QR scan with the phone** — see [REQUIRED NEXT STEPS](#required-next-steps-do-these-first) below. This is expected to happen every few weeks; it is NOT a ban.

## WhatsApp ban incident — RESOLVED (kept for history)

**Status (2026-06-16): the ban problem is considered resolved and is no longer a blocker.**

On the first session we linked the WhatsApp account to `whatsapp-web.js` and it got banned for ~12 hours. The key realization since then: **the ban happened while the number was on a WhatsApp _Business_ account.** The owner has since **migrated the same number to a personal WhatsApp account**, and the ban issue has **not recurred**. So for now we do **not** need to worry about the abuse-ban — it was tied to the Business account, not to `whatsapp-web.js` per se.

Mild hygiene still worth keeping (cheap insurance, not hard rules anymore):
- **Scan the QR once, keep the session.** Don't needlessly delete `app/data/session/` or let a watcher restart Chromium in a loop — each fresh scan is a new device-linking event.
- **Don't generate many QR codes in rapid succession.** If the QR prints and you're not ready, stop the process cleanly.
- The owner declined the official Meta WhatsApp Business Cloud API path. We're staying on `whatsapp-web.js`.

### Separate issue — periodic server-side logout (this is the real ongoing thing)

On **2026-05-31** the Railway-hosted session was **logged out server-side by WhatsApp** (NOT a ban). The container stayed healthy the whole time; only the WhatsApp link died, so the bot sat at `qr_pending` for 16 days with nobody noticing. This is the normal "linked device" lifecycle: WhatsApp unlinks a device when the **primary phone has been offline ~14 days**, and datacenter-hosted sessions can be cut sooner. **Expect to re-link periodically.** The session files cannot fix this — a server-side logout revokes the credentials everywhere, so only a fresh QR scan reconnects.

To stop this from going unnoticed again, an **email alert system** was added (see "Re-link reminder system" below). The earlier "deploy only to residential IPs / Fly.io is risky" guidance is **downgraded**: since the ban is resolved, Railway is fine to keep using; just be ready to re-link every few weeks and let the email alerts tell you when.

## REQUIRED NEXT STEPS (do these first)

These are the open action items from the 2026-06-16 session. Do them in order; they're the things most likely to be forgotten between sessions.

1. **Re-link WhatsApp (the bot is currently disconnected).** As of 2026-06-16 the prod session is logged out (`wa:qr_pending`). To fix, with the phone in hand:
   - `railway logs --service barcelola-whatsapp-bot` (or open `/admin` on the prod URL) to see the QR.
   - On the phone: WhatsApp → Settings → Linked Devices → Link a device → scan.
   - Confirm with `curl https://barcelola-whatsapp-bot-production.up.railway.app/healthz` → should read `"wa":"connected"`.
   - The files cannot reconnect it — only a fresh QR scan works (server-side logout revokes credentials everywhere).

2. **Set `RESEND_API_KEY` on Railway** so the new re-link email alerts actually send (see "Re-link reminder system"). Until this is set, alerts are only logged, not emailed:
   ```bash
   railway variables --set RESEND_API_KEY=re_xxxxx --service barcelola-whatsapp-bot
   ```
   - Sign up free at resend.com and create an API key.
   - **The free Resend sandbox sender only delivers to the email that owns the Resend account** — so sign up with **jason.pruebas@gmail.com** (the alert recipient), or verify a domain and set `notifications.email_from` in `config/settings.yaml`.

3. **Deploy the latest code** (the email-alert system was added 2026-06-16 but may not be deployed yet): push to GitHub (Railway auto-deploys) or `railway up`. After deploy, re-check `/healthz`.

4. **Verify the alerts work** (optional sanity check): with `RESEND_API_KEY` set and the bot disconnected for >30 min, you should get a "WhatsApp disconnected" email at jason.pruebas@gmail.com.

The longer-term backlog (group IDs, tour copy, going to production mode, real Wix webhook) is in [Things to do next](#things-to-do-next-backlog) further down.

## Re-link reminder system (added 2026-06-16)

Out-of-band **email** alerts notify you when the WhatsApp link needs attention (email, not WhatsApp, because WhatsApp is what goes down — and a Railway/host webhook can't catch it since the container stays healthy):

- **Reactive:** emails when the link has been down ≥ `reactive_after_minutes` (default 30). Once per outage; re-arms on reconnect.
- **Proactive:** emails a "re-link soon" warning at `proactive_warn_after_days` (default 12), before the ~14-day expiry window.
- **Recipient & tuning:** `config/settings.yaml` → `notifications:` block (currently `email_to: jason.pruebas@gmail.com`).
- **Channel:** Resend HTTP API (no new npm dependency). Needs `RESEND_API_KEY` env var — see step 2 above.
- **Code:** `app/src/notify/emailer.ts`, `app/src/notify/sessionMonitor.ts`; driven by the 15-min health-check cron in `app/src/scheduler.ts`. Tests in `app/tests/unit/sessionMonitor.test.ts`.

## Secrets — bring these over manually on a new machine

Create `app/.env` locally (it's gitignored). Required vars:

```
NODE_ENV=development
HTTP_PORT=3000
ADMIN_PASSWORD_HASH=<bcrypt hash of admin password>
SESSION_COOKIE_SECRET=<48+ random bytes hex>
WIX_API_KEY=<from old backend/init-wix-config.js or Wix dashboard>
WIX_SITE_ID=67d007dd-7ad6-426e-a092-dd0d701d6c69
WIX_WEBHOOK_SIGNING_SECRET=placeholder
DATA_DIR=./data
RESEND_API_KEY=<from resend.com — enables re-link email alerts; optional locally>
```

To generate a bcrypt hash for a new admin password:
```bash
node -e "console.log(require('bcrypt').hashSync('YOUR_PASSWORD', 10))"
```

To generate a cookie secret:
```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

## How to resume on the laptop

```bash
git clone git@github.com:jasoromir/BarcelolaBot.git
cd BarcelolaBot
git checkout feat/redesign
cd app
npm install
# Create app/.env as described above
npx tsx scripts/show-tomorrow.ts   # safe — only hits Wix, no WhatsApp
npm run dev                         # starts bot; prints QR in terminal on first run
```

On first `npm run dev`: a QR code will print in the terminal. Scan with WhatsApp → Settings → Linked Devices → Link a device. The session is saved under `app/data/session/` and persists across restarts.

## Useful commands

- `cd app && npm test` — run all 64 tests
- `cd app && npm run typecheck` — strict TS check
- `cd app && npx tsx scripts/show-tomorrow.ts [today|tomorrow|YYYY-MM-DD]` — preview tours from Wix without touching WhatsApp
- `cd app && npx tsx scripts/list-chats.ts` — after QR scan, print all groups + DMs with IDs (use output to fill `config/groups.yaml`)
- `curl http://localhost:3000/healthz` — state snapshot
- `curl -X POST http://localhost:3000/webhook/wix -H 'Content-Type: application/json' -d @tests/fixtures/wix/booking-webhook.json` — simulate a booking webhook

## Things to do next (backlog)

1. **Get the real WhatsApp group IDs.** After scanning QR on the laptop, run `npx tsx scripts/list-chats.ts` and paste the output to Claude — it will show group names + IDs to paste into `app/config/groups.yaml`.
2. **Map tour service IDs to Hebrew copy in `app/config/tours.yaml`.** The Wix service ID we saw in testing (`4422ee5f-957b-45c8-bf06-876482fd2b57`) is for "גותיראמבלה ללא הפסקה". Collect all service IDs over several days via `show-tomorrow.ts` and fill in the Hebrew blocks for each one.
3. **Dry-run the nightly job** (`POST /admin/api/jobs/nightly` with `{"dry_run": true}`, or click the button in the admin UI) to see the composed Hebrew message before going live.
4. **Flip `config/settings.yaml` `broadcast.mode` from `test` to `production`** only after successful live test in the test group for several days.
5. **Wire real Wix webhook.** The signature verifier in `app/src/wix/webhookVerifier.ts` is a stub (`createSignatureVerifier`) — swap to real HMAC when wiring up the actual webhook in Wix.
6. **Deployment host — DECIDED: Railway.** Already deployed there (`barcelola-whatsapp-bot`). The earlier "residential-IP-only / Fly.io is risky" concern is downgraded now that the ban is resolved (it was a Business-account issue, not a hosting issue). Railway stays; just re-link every few weeks per the email alerts.

## Files you should know about

- `app/src/` — TypeScript source, organized by module (config, persistence, log, control, whatsapp, wix, messaging, jobs, webhook, http, scheduler)
- `app/tests/unit/` and `app/tests/integration/` — 64 tests
- `app/src/notify/` — email alerter + WhatsApp-session monitor (re-link reminders, added 2026-06-16)
- `app/config/*.yaml` — all runtime configuration (groups, tours, templates, allowlist, settings)
- `app/scripts/show-tomorrow.ts` — Wix preview (safe)
- `app/scripts/list-chats.ts` — WhatsApp chats inspector (requires linked session)
- `app/web/admin.html,css,js` — minimal admin UI served at `/admin` on port 3000
- `docs/superpowers/specs/2026-04-25-whatsapp-bot-redesign-design.md` — full design doc with all decisions
- `docs/superpowers/plans/2026-04-25-whatsapp-bot-redesign.md` — task-by-task implementation plan (already executed)

## User preferences observed across the session

- Prefers terse, direct responses.
- Trusts recommended-option choices to avoid decision fatigue.
- Wants to iterate fast — lean on simplicity, avoid over-engineering.
- Codes mostly in Python but OK with TypeScript for this project since WhatsApp/Node ecosystem is better.
- Doesn't want the Meta WhatsApp Business Cloud API (keep whatsapp-web.js).
- Working from an Amazon dev desktop (corporate Linux) and a personal laptop — the former should NOT run any WhatsApp-touching code.
