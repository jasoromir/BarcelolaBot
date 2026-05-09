# WhatsApp Bot Operations Guide

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
- **Stop using the bot immediately**
- Use the account normally (manual WhatsApp) for 1-2 weeks
- The bot uses a **personal** account now (not business)
- Running headless mode with saved session should prevent bans

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

✅ **DO:**
- Use **personal** WhatsApp account (not business)
- Let bot run continuously (don't restart frequently)
- Keep session files (in `data/session/`)
- Use headless mode (default)
- Test in test group first

❌ **DON'T:**
- Scan QR multiple times
- Restart bot repeatedly
- Delete session files unnecessarily
- Run on datacenter/cloud IPs (use laptop only)
- Use business account

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

**Current setup:** Development mode on laptop

**Before going to production:**
- ✅ Test thoroughly in test group
- ✅ Change `broadcast.mode` from `"test"` to `"production"` in `config/settings.yaml`
- ✅ Add real group IDs to `config/groups.yaml`
- ✅ Add guide assignment logic
- ✅ Set up proper logging/monitoring
- ⚠️ Consider running on dedicated always-on machine (not cloud!)
- ⚠️ Set up automatic restart on crash (e.g., `pm2` or `systemd`)

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

**Last Updated:** 2026-05-09
**Bot Version:** v0.1.0 (feat/redesign branch)

---

## 15. Webhook Setup & Testing

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

#### Railway (Recommended)
1. Push code to GitHub
2. Connect Railway to your repo
3. Set environment variables (from `.env`)
4. Railway gives you a permanent URL: `https://your-app.railway.app`
5. Update Wix webhook URL to: `https://your-app.railway.app/webhook/wix`

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

**Last Updated:** 2026-05-09
