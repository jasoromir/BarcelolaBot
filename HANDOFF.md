# Session handoff — read before continuing

Read this first when picking up the project in a new session or on a new machine. It summarizes non-code context that the git history alone doesn't capture.

## Project in one line

WhatsApp automation bot for a Barcelona tour agency: nightly + morning broadcasts of tour lists to WhatsApp groups (opening/closing them on a schedule), plus real-time booking confirmation DMs triggered by Wix webhooks.

## Current state

- **All 13 planned implementation phases are complete** on branch `feat/redesign`.
- `cd app && npm test` → 57/57 tests pass; `npm run typecheck` clean; `npm run build` clean.
- Boot smoke test passed on a dev desktop: `/healthz` returns JSON, `/admin` serves, `POST /webhook/wix` acks with outcome, log events are written.
- Wix integration verified end-to-end against the real Wix account: `npx tsx scripts/show-tomorrow.ts` fetched tomorrow's real tour + participant list (names, phones, emails) for the owner's account.
- WhatsApp integration **not yet verified** (see "WhatsApp ban incident" below).
- Remote `origin` is `git@github.com:jasoromir/BarcelolaBot.git`.

## WhatsApp ban incident — CRITICAL CONTEXT

On the first session we linked the owner's WhatsApp account to `whatsapp-web.js` **from an Amazon dev desktop** (datacenter IP). WhatsApp's automated abuse detection flagged it and banned the account for ~12 hours. Key takeaways for next time:

- **Never link from a datacenter IP.** Not from AWS, GCP, Azure, Fly.io, Oracle Cloud, Hetzner, DigitalOcean, or the Amazon dev desktop. Residential IPs only.
- **Scan the QR once, keep the session.** Don't delete `app/data/session/` and don't let `tsx watch` restart the Chromium process in a loop. Each fresh scan looks like a new device-linking event to WhatsApp.
- **Don't generate many QR codes in rapid succession.** If you see the QR print and you're not ready to scan, stop the process cleanly.
- **After the first successful scan, let things idle before firing a broadcast.** Don't immediately run a live job.
- The user declined the official Meta WhatsApp Business Cloud API path. We're staying on `whatsapp-web.js`; mitigation is residential-IP-only plus the discipline above.

The spec's original "deploy to Fly.io" recommendation is now considered risky for the same reason. Production host should be residential or residential-adjacent (home always-on machine, or a hosting service that offers residential IPs). Revisit before deploying.

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

- `cd app && npm test` — run all 57 tests
- `cd app && npm run typecheck` — strict TS check
- `cd app && npx tsx scripts/show-tomorrow.ts [today|tomorrow|YYYY-MM-DD]` — preview tours from Wix without touching WhatsApp
- `cd app && npx tsx scripts/list-chats.ts` — after QR scan, print all groups + DMs with IDs (use output to fill `config/groups.yaml`)
- `curl http://localhost:3000/healthz` — state snapshot
- `curl -X POST http://localhost:3000/webhook/wix -H 'Content-Type: application/json' -d @tests/fixtures/wix/booking-webhook.json` — simulate a booking webhook

## Things to do next (not started)

1. **Get the real WhatsApp group IDs.** After scanning QR on the laptop, run `npx tsx scripts/list-chats.ts` and paste the output to Claude — it will show group names + IDs to paste into `app/config/groups.yaml`.
2. **Map tour service IDs to Hebrew copy in `app/config/tours.yaml`.** The Wix service ID we saw in testing (`4422ee5f-957b-45c8-bf06-876482fd2b57`) is for "גותיראמבלה ללא הפסקה". Collect all service IDs over several days via `show-tomorrow.ts` and fill in the Hebrew blocks for each one.
3. **Dry-run the nightly job** (`POST /admin/api/jobs/nightly` with `{"dry_run": true}`, or click the button in the admin UI) to see the composed Hebrew message before going live.
4. **Flip `config/settings.yaml` `broadcast.mode` from `test` to `production`** only after successful live test in the test group for several days.
5. **Wire real Wix webhook.** The signature verifier in `app/src/wix/webhookVerifier.ts` is a stub (`createSignatureVerifier`) — swap to real HMAC when wiring up the actual webhook in Wix.
6. **Decide on deployment host.** Fly.io is in the spec but risky post-ban. Consider: home always-on laptop/Mac Mini/Raspberry Pi, or a hosting service with residential IPs.

## Files you should know about

- `app/src/` — TypeScript source, organized by module (config, persistence, log, control, whatsapp, wix, messaging, jobs, webhook, http, scheduler)
- `app/tests/unit/` and `app/tests/integration/` — 57 tests
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
