# WhatsApp Bot Operations Guide

> ## 🚦 START HERE — required next steps (as of 2026-06-16)
>
> **The bot is deployed on Railway** (`barcelola-whatsapp-bot`, prod URL `https://barcelola-whatsapp-bot-production.up.railway.app`). Most of this guide describes running locally; the production instance runs on Railway. If the bot "isn't working", it's almost always that the **WhatsApp link dropped and needs a fresh QR scan** (happens every few weeks — this is normal, NOT a ban).
>
> **Do these, in order:**
> 1. **Check state:** `curl https://barcelola-whatsapp-bot-production.up.railway.app/healthz`. If `"wa":"connected"` → you're fine. If `"qr_pending"`/`"disconnected"` → continue.
> 2. **Re-link (needs the phone):** `railway logs --service barcelola-whatsapp-bot` to see the QR (or open `/admin` on the prod URL), then phone → WhatsApp → Settings → Linked Devices → Link a device → scan. Re-check `/healthz` for `"connected"`. **Session files cannot reconnect it — only a fresh scan works.**
> 3. **Enable email alerts (one-time):** set `RESEND_API_KEY` so you get warned next time instead of finding out weeks later:
>    ```bash
>    railway variables --set RESEND_API_KEY=re_xxxxx --service barcelola-whatsapp-bot
>    ```
>    Sign up free at resend.com. **Use jason.pruebas@gmail.com as the account email** (Resend's sandbox sender only delivers to the account owner) — that's the configured alert recipient in `config/settings.yaml`.
> 4. **Deploy latest code** if the email-alert feature isn't live yet: push to GitHub (auto-deploys) or `railway up`.
>
> Full detail: see `HANDOFF.md` → "REQUIRED NEXT STEPS" and "Re-link reminder system".

## Quick Reference

```bash
# Project directory
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app

# Check if bot is running
curl -s http://localhost:3000/healthz

# Start bot
npx tsx src/index.ts

# Kill bot completely (when stuck)
lsof -ti:3000 | xargs kill -9 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null
```

---

## 1. Starting the Bot

### First Time (or after session deleted)
```bash
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
npx tsx src/index.ts
```

**What happens:**
- Bot starts on port 3000
- Chrome opens (headless mode - you won't see a window)
- QR code prints in terminal
- Scan QR with WhatsApp → Settings → Linked Devices → Link a device
- Session saves to `app/data/session/`

**After first scan:** The bot will auto-reconnect on future starts - **no QR needed**!

### Subsequent Starts (session exists)
```bash
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
npx tsx src/index.ts
```

- No QR code
- Connects automatically using saved session
- Ready in ~10-15 seconds

---

## 2. Checking Bot Status

### Health Check
```bash
curl -s http://localhost:3000/healthz
```

**Responses:**
- `{"wa":"connected","paused":false,"uptime_s":123}` ✅ Bot is running and connected
- `{"wa":"disconnected","paused":false,"uptime_s":45}` ⚠️ Bot running but WhatsApp disconnected
- `curl: (7) Failed to connect` ❌ Bot not running

### Admin UI (Browser)
```
http://localhost:3000/admin
Password: barcelola2026
```

---

## 3. Stopping the Bot

### Clean Stop
If you can access the terminal where bot is running:
- Press `Ctrl+C`

### Force Stop (when stuck or running in background)
```bash
# Kill the Node process
lsof -ti:3000 | xargs kill -9 2>/dev/null

# Kill Chrome processes (if bot doesn't release them)
pkill -9 -f "chrome" 2>/dev/null
```

**When to use force stop:**
- Bot is unresponsive
- Port 3000 is stuck
- After code changes
- Chrome processes are orphaned

---

## 4. Restarting After Code Changes

**Important:** The bot does NOT auto-reload when code changes. You must restart it manually.

### Steps:
```bash
# 1. Stop everything
lsof -ti:3000 | xargs kill -9 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null

# 2. Wait a moment
sleep 3

# 3. Start fresh
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
npx tsx src/index.ts
```

**One-liner:**
```bash
lsof -ti:3000 | xargs kill -9 2>/dev/null && pkill -9 -f "chrome" 2>/dev/null && sleep 3 && cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app && npx tsx src/index.ts
```

---

## 5. Running in Background

### Start in Background
```bash
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
nohup npx tsx src/index.ts > bot.log 2>&1 &
```

### Check Logs
```bash
tail -f bot.log
```

### Stop Background Bot
```bash
lsof -ti:3000 | xargs kill -9
```

---

## 6. Troubleshooting

### Problem: "Port 3000 already in use"
```bash
# Find and kill the process
lsof -ti:3000 | xargs kill -9
```

### Problem: "Browser is already running"
```bash
# Kill all Chrome processes
pkill -9 -f "chrome"

# Then restart bot
npx tsx src/index.ts
```

### Problem: Bot connects but doesn't respond to API calls
```bash
# Full clean restart
lsof -ti:3000 | xargs kill -9 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null
rm -rf /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app/data/session/*
sleep 3
npx tsx src/index.ts
# Scan QR again
```

### Problem: Bot keeps crashing
- Check logs for error messages
- Verify `.env` file exists with correct values
- Run `npm install` to ensure dependencies are up to date

### Problem: WhatsApp account banned
- **This is no longer expected to happen.** The original ban was while the number was on a WhatsApp **Business** account. The same number was migrated to a **personal** account and the ban issue has not recurred. We are not worried about bans for now.
- Don't confuse a ban with the routine **server-side logout** (see next entry) — that's what usually causes "the bot stopped working", and the fix is just a re-link, not a cooldown.
- If a real ban ever does occur: stop the bot, use the account manually for 1–2 weeks, then re-link.

### Problem: Bot was working, then silently stopped (server-side logout)
This is the common one. WhatsApp unlinks the device periodically (when the primary phone has been offline ~14 days, sometimes sooner for hosted sessions). The container keeps running and healthy; only the WhatsApp link dies, so `/healthz` shows `"wa":"qr_pending"`.
- **Fix:** re-link with a fresh QR scan (see START HERE banner at the top). Saved session files can't fix it.
- **Prevention:** you can't fully prevent it — instead the bot now **emails jason.pruebas@gmail.com** when it disconnects (reactive) and ~2 days before the expiry window (proactive). Make sure `RESEND_API_KEY` is set so those alerts actually send.

---

## 7. Common Operations

### Test Wix Connection (Safe - No WhatsApp)
```bash
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
npx tsx scripts/show-tomorrow.ts
```

### Send Tomorrow's Broadcast (via API)
```bash
# Login
curl -s -c /tmp/admin-cookies.txt -X POST http://localhost:3000/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password":"barcelola2026"}'

# Send broadcast
curl -s -b /tmp/admin-cookies.txt -X POST \
  http://localhost:3000/admin/api/send-tomorrow-broadcast \
  -H "Content-Type: application/json" \
  -d '{"phone":"+34623964800"}'
```

### List All WhatsApp Chats
```bash
# Login first, then:
curl -s -b /tmp/admin-cookies.txt \
  http://localhost:3000/admin/api/chats/list
```

---

## 8. File Locations

```
BarcelolaBot/app/
├── .env                    # Secrets (WIX_API_KEY, passwords)
├── src/                    # Source code
├── config/                 # Configuration files
│   ├── groups.yaml         # WhatsApp groups
│   ├── tours.yaml          # Tour descriptions
│   ├── settings.yaml       # Bot settings
│   └── templates.yaml      # Message templates
├── data/
│   ├── session/            # WhatsApp session (don't delete!)
│   ├── logs/               # Log files
│   └── bot.db              # SQLite database
└── scripts/                # Utility scripts
```

---

## 9. Ban Prevention Rules

**Ban status: resolved.** The original ban was tied to the WhatsApp **Business** account. The number is now on a **personal** account and bans have not recurred, so the strict residential-IP-only rules are downgraded to light hygiene. (Running on Railway's datacenter IP is fine in practice — see Production Considerations.)

✅ **DO:**
- Keep the number on a **personal** WhatsApp account (not Business)
- Let the bot run continuously
- Keep session files (in `data/session/`)
- Use headless mode (default)
- Test in the test group first

🟡 **Light hygiene (not hard rules anymore):**
- Avoid scanning the QR many times in rapid succession
- Don't delete session files unnecessarily

❌ **DON'T:**
- Switch the number back to a WhatsApp Business account

---

## 10. Session Management

### Check Session Exists
```bash
ls -la /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app/data/session/session/
```

If you see 40+ files → session exists ✅

### Delete Session (requires re-scanning QR)
```bash
rm -rf /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app/data/session/*
```

**Only delete if:**
- WhatsApp Web shows "logged out"
- Session is corrupted
- You want to link a different number

---

## 11. For LLMs: Quick Start Checklist

When helping with this bot, follow these steps:

1. **Check if bot is running:**
   ```bash
   curl -s http://localhost:3000/healthz
   ```

2. **If not running, start it:**
   ```bash
   cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
   npx tsx src/index.ts
   ```

3. **If stuck/need to restart:**
   ```bash
   lsof -ti:3000 | xargs kill -9 2>/dev/null
   pkill -9 -f "chrome" 2>/dev/null
   sleep 3
   cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
   npx tsx src/index.ts
   ```

4. **Wait for connection:**
   - Check `curl -s http://localhost:3000/healthz` until `"wa":"connected"`
   - Usually takes 10-15 seconds

5. **Session info:**
   - Session persists across restarts (no QR needed)
   - Located at: `app/data/session/`
   - Only needs QR on first run or if session deleted

6. **After code changes:**
   - Bot does NOT auto-reload
   - Must kill and restart (step 3 above)

---

## 12. Environment Variables

Located in `app/.env`:

```bash
NODE_ENV=development
HTTP_PORT=3000
ADMIN_PASSWORD_HASH=$2b$10$pwu81e58GOvCoBlZV77dDO...
SESSION_COOKIE_SECRET=392c1b988f33b01243ace9b9...
WIX_API_KEY=IST.eyJraWQiOiJQb3pIX2FDMiIsImFsZy...
WIX_SITE_ID=67d007dd-7ad6-426e-a092-dd0d701d6c69
WIX_WEBHOOK_SIGNING_SECRET=placeholder
DATA_DIR=./data
```

**To generate new admin password:**
```bash
node -e "console.log(require('bcrypt').hashSync('YOUR_PASSWORD', 10))"
```

---

## 13. Production Considerations

**Current setup:** Deployed on **Railway** (`barcelola-whatsapp-bot`). Railway handles always-on hosting, restart-on-crash, and a persistent volume at `/app/data` for the session + DB. Running on Railway's datacenter IP is fine now that the ban issue is resolved (it was a Business-account problem). The main operational task is periodic **re-linking** when WhatsApp logs the device out (~every few weeks) — the email alert system tells you when.

**Before going to production:**
- ✅ Test thoroughly in test group
- ✅ Change `broadcast.mode` from `"test"` to `"production"` in `config/settings.yaml`
- ✅ Add real group IDs to `config/groups.yaml`
- ✅ Add guide assignment logic
- ✅ Set `RESEND_API_KEY` on Railway so re-link email alerts send (recipient: jason.pruebas@gmail.com)
- ✅ Set up proper logging/monitoring (email alerts on disconnect are now built in — see §6)

---

## 14. Useful Commands Summary

```bash
# Start
npx tsx src/index.ts

# Stop (clean)
Ctrl+C

# Stop (force)
lsof -ti:3000 | xargs kill -9 && pkill -9 -f "chrome"

# Restart after code changes
lsof -ti:3000 | xargs kill -9 && pkill -9 -f "chrome" && sleep 3 && npx tsx src/index.ts

# Check status
curl -s http://localhost:3000/healthz

# Test Wix (safe)
npx tsx scripts/show-tomorrow.ts

# Login to admin
curl -s -c /tmp/admin-cookies.txt -X POST http://localhost:3000/admin/login -H "Content-Type: application/json" -d '{"password":"barcelola2026"}'

# View logs (if running in background)
tail -f bot.log
```

---

**Last Updated:** 2026-07-03
**Bot Version:** v0.1.0 (feat/redesign branch)

---

## 15. Deployment & Config Updates (for LLM agents)

This project has TWO layers of config that agents must understand:

### Architecture

```
app/config/*.yaml          ← bundled config (committed to git, baked into Docker image)
/app/data/config/*.yaml    ← Railway volume OVERLAY (persists across deploys, NOT in git)
```

The **overlay wins**: if a file exists in `/app/data/config/`, the config loader uses it INSTEAD of the bundled version with the same name. This is by design — it lets operators edit config at runtime without redeploying.

### How to deploy code changes

```bash
cd /path/to/BarcelolaBot
railway up --detach -m "description"
```

This rebuilds the Docker image and restarts the container. The WhatsApp session survives (it's on the persistent volume at `/app/data/session/`). No QR scan needed.

### How to update config on the live bot (without redeploying)

**Step 1:** Push the file to the Railway volume via SSH:
```bash
cat app/config/settings.yaml | railway ssh --service barcelola-whatsapp-bot --environment production -- "cat > /app/data/config/settings.yaml"
```

**Step 2:** Reload the config (no restart needed):
```bash
curl -s -c /tmp/c.txt -X POST https://barcelola-whatsapp-bot-production.up.railway.app/admin/login \
  -H "Content-Type: application/json" -d '{"password":"barcelola2026"}' > /dev/null && \
curl -s -b /tmp/c.txt -X POST https://barcelola-whatsapp-bot-production.up.railway.app/admin/api/config/reload
```

**Step 3 (optional):** Verify the change took effect:
```bash
railway ssh --service barcelola-whatsapp-bot --environment production -- "grep -A5 'your_new_block' /app/data/config/settings.yaml"
```

### Which config files can be updated this way

| File | What it controls |
|---|---|
| `settings.yaml` | Schedules, broadcast mode, reminders, notifications, moderation, guide_notify |
| `tours.yaml` | Tour names, descriptions, meeting points, Google Maps URLs, language |
| `templates.yaml` | All message templates (broadcast, confirmation, reminder, etc.) |
| `groups.yaml` | Which WhatsApp groups receive broadcasts |
| `allowlist.yaml` | Which phone numbers receive booking confirmations |

### Important notes for agents

- **This is NOT "bypassing deployment guardrails"** — it's the documented, intended config-update path for this project. The overlay exists specifically for hot-reloading config without redeploys.
- **SSH to the Railway container is normal** — we use `railway ssh` routinely for diagnostics, config pushes, and DB queries. The SSH key is already registered.
- **Always keep local files in sync** — after pushing to the overlay, commit the same change to `app/config/` in the repo so the next deploy doesn't regress.
- **The admin reload endpoint is safe** — it re-reads all YAML files and validates them with Zod schemas. If the YAML is malformed, the reload fails and the old config stays active.

---

## 16. Webhook Setup & Testing

### Overview

The bot receives real-time booking notifications from Wix via webhooks. When someone books a tour on your website, Wix sends the booking data to your bot, which then sends a WhatsApp confirmation message to the customer.

### Architecture

```
Wix Website → Wix Automation → Webhook URL → Localtunnel/Cloudflare → Your Bot → WhatsApp Message
```

---

### Step 1: Start Localtunnel

Localtunnel exposes your local bot (port 3000) to the internet so Wix can reach it.

#### Install Localtunnel (first time only)
```bash
npm install -g localtunnel
```

#### Start Tunnel
```bash
lt --port 3000 --subdomain barcelola-bot
```

**Output:**
```
your url is: https://barcelola-bot.loca.lt
```

**Important:** 
- Keep this terminal window open
- The URL may change if you restart localtunnel
- Free localtunnel sometimes requires browser verification on first access

#### Alternative: Cloudflare Tunnel (More Stable)
```bash
# Install cloudflared (first time only)
brew install cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:3000
```

---

### Step 2: Configure Wix Automation

1. Go to **Wix Dashboard** → **Automations** → **New Automation**
2. **Trigger:** When a booking is created
3. **Action:** Send HTTP Request
   - **URL:** `https://barcelola-bot.loca.lt/webhook/wix`
   - **Method:** POST
   - **Headers:**
     ```
     Content-Type: application/json
     ```
   - **Body:** (use Wix's booking data variables)
     ```json
     {
       "data": {
         "booking": {
           "id": "{{booking.id}}",
           "formInfo": {
             "contactDetails": {
               "firstName": "{{booking.formInfo.contactDetails.firstName}}",
               "lastName": "{{booking.formInfo.contactDetails.lastName}}",
               "phone": "{{booking.formInfo.contactDetails.phone}}",
               "email": "{{booking.formInfo.contactDetails.email}}"
             }
           },
           "bookedEntity": {
             "serviceId": "{{booking.bookedEntity.serviceId}}",
             "title": "{{booking.bookedEntity.title}}",
             "singleSession": {
               "start": "{{booking.bookedEntity.singleSession.start}}",
               "end": "{{booking.bookedEntity.singleSession.end}}"
             }
           }
         }
       }
     }
     ```

4. **Save** the automation

---

### Step 3: Configure Allowlist

Only phone numbers in the allowlist will receive WhatsApp messages.

Edit `config/allowlist.yaml`:
```yaml
mode: "explicit"  # or "rule" or "open"
explicit_phones:
  - "+34675319188"  # Add phone numbers here
  - "+34623964800"
rule:
  country_codes: ["+34", "+972"]  # Used when mode is "rule"
```

**Modes:**
- `explicit` - Only specific numbers receive messages
- `rule` - Numbers matching country codes receive messages
- `open` - All numbers receive messages (use with caution!)

**After editing:**
```bash
# Reload configuration without restarting
curl -s -c /tmp/admin-cookies.txt -X POST http://localhost:3000/admin/login \
  -H "Content-Type: application/json" -d '{"password":"barcelola2026"}'

curl -s -b /tmp/admin-cookies.txt -X POST \
  http://localhost:3000/admin/api/config/reload
```

---

### Step 4: Test the Webhook

#### Manual Test (Local)
```bash
curl -X POST http://localhost:3000/webhook/wix \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/wix/real-booking-webhook.json
```

**Expected Response:**
```json
{"received":true,"outcome":"sent"}
```

**Possible Outcomes:**
- `"outcome":"sent"` ✅ Message sent successfully
- `"outcome":"skipped_allowlist"` ⚠️ Phone not in allowlist
- `"outcome":"duplicate"` ℹ️ Booking ID already processed
- `"outcome":"invalid"` ❌ Malformed webhook payload
- `"outcome":"deferred"` ⏸️ WhatsApp disconnected, queued for later
- `"outcome":"skipped_paused"` ⏸️ Bot is paused
- `"outcome":"failed"` ❌ Send failed (check logs)

#### Test via Tunnel
```bash
curl -X POST https://barcelola-bot.loca.lt/webhook/wix \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/wix/real-booking-webhook.json
```

#### Test with Real Wix Booking
1. Go to your Wix site
2. Book a tour with your phone number (+34675319188)
3. Check if you receive a WhatsApp message

---

### Troubleshooting Webhooks

#### Problem: No message received

**1. Check Bot is Running & Connected**
```bash
curl -s http://localhost:3000/healthz
```
Must show: `"wa":"connected"` ✅

If disconnected:
```bash
# Restart bot
lsof -ti:3000 | xargs kill -9 && pkill -9 -f "chrome" && sleep 3 && npx tsx src/index.ts
```

**2. Check Tunnel is Running**
```bash
# Test tunnel
curl https://barcelola-bot.loca.lt/healthz
```

Should return bot health status. If not:
```bash
# Restart tunnel
lt --port 3000 --subdomain barcelola-bot
```

**3. Check Allowlist**
```bash
cat config/allowlist.yaml
```

Make sure the phone number is listed.

**4. Test Webhook Manually**
```bash
curl -X POST http://localhost:3000/webhook/wix \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "booking": {
        "id": "test-'.$(date +%s).'",
        "formInfo": {
          "contactDetails": {
            "firstName": "Test",
            "lastName": "User",
            "phone": "+34675319188"
          }
        },
        "bookedEntity": {
          "serviceId": "4422ee5f-957b-45c8-bf06-876482fd2b57",
          "title": "Test Tour",
          "singleSession": {
            "start": "2026-05-10T12:00:00.000Z"
          }
        }
      }
    }
  }'
```

**5. Check Bot Logs**
```bash
# If running in foreground, check terminal output
# If running in background:
tail -f bot.log
```

Look for:
- `booking_sent` ✅ Success
- `booking_skipped_allowlist` ⚠️ Not whitelisted
- `booking_invalid` ❌ Bad payload
- `booking_send_failed` ❌ WhatsApp error

**6. Check Wix Automation Logs**
In Wix Dashboard → Automations → Your Automation → View Logs

Check if:
- Automation triggered
- HTTP request succeeded
- Response code (should be 200)

---

#### Problem: "outcome": "invalid"

**Cause:** Webhook payload format is wrong.

**Fix:** Make sure Wix sends this exact structure:
```json
{
  "data": {
    "booking": {
      "id": "...",
      "formInfo": { "contactDetails": { ... } },
      "bookedEntity": { "serviceId": "...", "singleSession": { "start": "..." } }
    }
  }
}
```

**Common mistake:** Wrapping in `"event"` object - ❌ Don't do this!

---

#### Problem: "outcome": "skipped_allowlist"

**Cause:** Phone number not in allowlist.

**Fix:**
1. Edit `config/allowlist.yaml`
2. Add the phone number
3. Reload config:
```bash
curl -s -b /tmp/admin-cookies.txt -X POST \
  http://localhost:3000/admin/api/config/reload
```

Or restart the bot.

---

#### Problem: Tunnel URL changes

**Cause:** Free localtunnel resets subdomain sometimes.

**Solutions:**
1. **Use paid localtunnel** for stable subdomain
2. **Use Cloudflare Tunnel** (more stable)
3. **Deploy to Railway/Fly.io** for permanent URL

**Quick fix:**
Update the URL in Wix automation to the new tunnel URL.

---

### Running Both Services Together

#### Option 1: Two Terminals
```bash
# Terminal 1 - Bot
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
npx tsx src/index.ts

# Terminal 2 - Tunnel
lt --port 3000 --subdomain barcelola-bot
```

#### Option 2: Screen/Tmux
```bash
# Start screen session
screen -S whatsapp-bot

# In screen: Start bot
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
npx tsx src/index.ts

# Detach: Ctrl+A, then D

# Start another screen for tunnel
screen -S localtunnel
lt --port 3000 --subdomain barcelola-bot

# Detach: Ctrl+A, then D

# Reattach later:
screen -r whatsapp-bot
screen -r localtunnel
```

#### Option 3: Background with nohup
```bash
# Start bot in background
cd /Users/jomedes/Desktop/projets/whatsap_bot/BarcelolaBot/app
nohup npx tsx src/index.ts > bot.log 2>&1 &

# Start tunnel in background
nohup lt --port 3000 --subdomain barcelola-bot > tunnel.log 2>&1 &

# Check logs
tail -f bot.log
tail -f tunnel.log
```

---

### Message Templates

Edit `config/templates.yaml` to customize booking confirmation messages:

```yaml
booking_confirmation: |
  שלום {client_name}! 👋
  אישור הזמנתך לסיור *{tour_name_he}* בתאריך {date} בשעה {time}.
  נתראה! 🌻
```

Available variables:
- `{client_name}` - Customer name
- `{tour_name_he}` - Hebrew tour name
- `{date}` - Tour date (YYYY-MM-DD)
- `{time}` - Tour time (HH:mm)

---

### Production Deployment

For production, replace localtunnel with a permanent deployment:

#### Railway — ✅ ALREADY DEPLOYED HERE
This is the live host. Project `barcelola-whatsapp-bot`, prod URL `https://barcelola-whatsapp-bot-production.up.railway.app`.
1. Code is connected via GitHub — push to deploy (or `railway up`).
2. Environment variables are already set on the service. When adding new ones: `railway variables --set KEY=value --service barcelola-whatsapp-bot`. Notably `RESEND_API_KEY` must be set for re-link email alerts (recipient jason.pruebas@gmail.com).
3. Session + DB persist on a volume at `/app/data` (`DATA_DIR=/app/data`), so redeploys don't wipe them.
4. Wix webhook URL: `https://barcelola-whatsapp-bot-production.up.railway.app/webhook/wix`.
5. To see the QR for re-linking: `railway logs --service barcelola-whatsapp-bot`.

#### Fly.io
1. Install flyctl: `brew install flyctl`
2. `fly launch`
3. Set secrets: `fly secrets set WIX_API_KEY=...`
4. Deploy: `fly deploy`
5. Get URL: `fly info`
6. Update Wix webhook

**No more tunnel needed!** ✅

---

### Quick Reference: Webhook Flow

```
1. Customer books tour on Wix
   ↓
2. Wix automation triggers
   ↓
3. Wix sends POST to webhook URL
   ↓
4. Localtunnel/Cloudflare forwards to bot
   ↓
5. Bot validates payload
   ↓
6. Bot checks allowlist
   ↓
7. Bot checks WhatsApp connection
   ↓
8. Bot builds Hebrew message
   ↓
9. Bot sends WhatsApp message
   ↓
10. Customer receives confirmation ✅
```

---

### Testing Checklist

Before deploying to production:

- [ ] Bot connects to WhatsApp successfully
- [ ] Tunnel exposes localhost:3000
- [ ] Wix automation configured with correct URL
- [ ] Test phone number in allowlist
- [ ] Manual webhook test succeeds (`outcome: "sent"`)
- [ ] Real Wix booking sends WhatsApp message
- [ ] Message template looks correct in Hebrew
- [ ] Tour descriptions are accurate
- [ ] Guide assignments work (if implemented)

---

**Last Updated:** 2026-06-16
