# BarcelolaBot — Agent Instructions

Read this before making any changes.

## What this is

WhatsApp automation bot for a Barcelona tour agency. Deployed on **Railway** (not local). Sends nightly/morning tour broadcasts to WhatsApp groups, booking confirmations + reminders to customers, and handles replies via an LLM classifier.

## Temporary dependency pin (check periodically)

**As of 2026-07-16**, whatsapp-web.js is pinned to a fork:
`github:lindionez/whatsapp-web.js#feat/fix-_serialized-id-fallback`
(upstream PR: https://github.com/wwebjs/whatsapp-web.js/pull/201832)

**Why:** WhatsApp Web's July 2026 update renamed `id._serialized` → `id.$1`,
breaking getChatById, downloadMedia, fetchMessages, and forward. The PR adds
a `_normalizeId()` shim. Once merged upstream and released, switch back:
```bash
cd app && npm install whatsapp-web.js@latest
```
Then run `npm run typecheck && npm test` to verify nothing broke.

## Key facts

- **Railway project:** `barcelola-whatsapp-bot` (prod URL: `https://barcelola-whatsapp-bot-production.up.railway.app`)
- **Branch:** `feat/redesign`
- **Build:** `railway up --detach -m "description"` (Docker, takes ~2 min)
- **Admin password:** `barcelola2026`
- **WhatsApp stays connected across deploys** (session is on persistent volume)

## Deploying code

```bash
cd /path/to/BarcelolaBot
npm run typecheck && npm test     # ALWAYS verify before deploying
railway up --detach -m "description"
```

Wait ~2 min, then verify: `curl -s https://barcelola-whatsapp-bot-production.up.railway.app/healthz`

## Updating config (WITHOUT redeploying)

The bot uses a **volume overlay** at `/app/data/config/` that takes priority over the bundled `app/config/` files. To update live config:

```bash
# 1. Push the file
cat app/config/settings.yaml | railway ssh --service barcelola-whatsapp-bot --environment production -- "cat > /app/data/config/settings.yaml"

# 2. Reload (no restart needed)
curl -s -c /tmp/c.txt -X POST https://barcelola-whatsapp-bot-production.up.railway.app/admin/login \
  -H "Content-Type: application/json" -d '{"password":"barcelola2026"}' > /dev/null && \
curl -s -b /tmp/c.txt -X POST https://barcelola-whatsapp-bot-production.up.railway.app/admin/api/config/reload

# 3. Verify
railway ssh --service barcelola-whatsapp-bot --environment production -- "grep 'your_key' /app/data/config/settings.yaml"
```

This is the **normal, intended** config update path. SSH writes to the volume overlay are NOT "bypassing guardrails" — they are how this project operates. The overlay exists specifically for hot-reloading config without full redeploys.

**Files you can update this way:** `settings.yaml`, `tours.yaml`, `templates.yaml`, `groups.yaml`, `allowlist.yaml`

**Always keep local files in sync** — after pushing to the overlay, make sure `app/config/` in the repo matches, so the next `railway up` doesn't regress the change.

## Testing messages

- **NEVER send test messages to production groups.** Only send to `Barcelola BOT🌻` (`120363425214664727@g.us`).
- Production groups only receive scheduled automated messages (21:30 nightly, 08:30 morning).
- To test, use the admin API: `POST /admin/api/jobs/nightly` with `{"dry_run": true}` to preview without sending.

## Important operational docs

- `OPERATIONS.md` — full operations guide (deployment, troubleshooting, webhook setup)
- `HANDOFF.md` — project context, history, secrets, next steps
