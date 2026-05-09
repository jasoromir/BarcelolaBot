# Cloudflare Tunnel Setup for Wix Webhooks

This guide explains how to expose your WhatsApp bot to receive webhooks from Wix using Cloudflare Tunnel.

## Quick Start

### 1. Start the Bot with Tunnel

From the BarcelolaBot directory, run:

```bash
./start-with-tunnel.sh
```

This script starts both:
- Your WhatsApp bot on `http://localhost:3000`
- Cloudflare tunnel that exposes it publicly

### 2. Get Your Tunnel URL

When the tunnel starts, you'll see output like:

```
2026-05-09T10:30:45Z INF +--------------------------------------------------------------------------------------------+
2026-05-09T10:30:45Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-05-09T10:30:45Z INF |  https://abc123def456.trycloudflare.com                                                    |
2026-05-09T10:30:45Z INF +--------------------------------------------------------------------------------------------+
```

**Copy that URL!** This is your public webhook endpoint.

### 3. Configure Wix Webhooks

#### In Wix Dashboard:

1. Go to **Settings** → **Bookings** → **Webhooks**
2. Click **"+ Add Webhook"** or **"Connect"**
3. Configure:
   - **Event Type**: `bookings/booking-created` (or "New Booking Created")
   - **Endpoint URL**: `https://YOUR-TUNNEL-URL.trycloudflare.com/webhook/wix`
     - Example: `https://abc123def456.trycloudflare.com/webhook/wix`
   - **Method**: `POST`
4. Click **Save**

### 4. Test It

1. Create a test booking in Wix
2. Watch your terminal for logs like:
   ```
   [webhook] booking_sent: confirmation sent for booking-123
   ```
3. The client should receive a WhatsApp message!

---

## Important Notes

### ⚠️ Tunnel URL Changes

**With the free Cloudflare tunnel, the URL changes on each restart** (e.g., `abc123.trycloudflare.com` → `xyz789.trycloudflare.com`).

**When you restart the bot:**
1. Note the new tunnel URL from the terminal
2. Update it in Wix webhook configuration

### 💡 Permanent URL Option

If you need a permanent URL that never changes:

#### Option A: Named Cloudflare Tunnel (Free)

```bash
# One-time setup
cloudflared tunnel login
cloudflared tunnel create barcelola-bot
cloudflared tunnel route dns barcelola-bot barcelola-bot.yourdomain.com

# Then always use
cloudflared tunnel run barcelola-bot
```

This requires:
- A Cloudflare account (free)
- A domain managed by Cloudflare

#### Option B: Deploy to Railway (Recommended for Production)

Railway gives you a permanent URL like `https://barcelola-bot.up.railway.app` that never changes.

See the main README for Railway deployment instructions.

---

## Troubleshooting

### Bot won't start
- Make sure you're in the `BarcelolaBot` directory
- Check your `.env` file has all required variables
- Run `cd app && npm install` to ensure dependencies are installed

### Tunnel won't start
- Verify cloudflared is installed: `cloudflared --version`
- Check port 3000 isn't already in use: `lsof -i :3000`

### Webhook not receiving data
- Verify the tunnel URL is correct in Wix
- Check the full URL includes `/webhook/wix` at the end
- Look for errors in your bot terminal logs

### Test the webhook manually
```bash
curl -X POST https://YOUR-TUNNEL-URL.trycloudflare.com/webhook/wix \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "booking": {
        "id": "test-123",
        "bookedEntity": {
          "serviceId": "tour-gothic",
          "singleSession": {
            "start": "2026-05-10T14:00:00Z"
          }
        },
        "formInfo": {
          "contactDetails": {
            "firstName": "Test",
            "lastName": "User",
            "phone": "+34612345678"
          }
        }
      }
    }
  }'
```

Expected response:
```json
{"received": true, "outcome": "sent"}
```

---

## What Happens Behind the Scenes

1. **Wix** sends booking webhook → `https://YOUR-TUNNEL.trycloudflare.com/webhook/wix`
2. **Cloudflare Tunnel** forwards to → `http://localhost:3000/webhook/wix`
3. **Your Bot** receives the booking data
4. **Bot** parses: client name, phone, tour, date, time
5. **Bot** sends WhatsApp confirmation message
6. **Bot** responds to Wix with success

---

## Manual Start (Without Script)

If you prefer to run things manually:

**Terminal 1 - Start Bot:**
```bash
cd BarcelolaBot/app
npm run dev
```

**Terminal 2 - Start Tunnel:**
```bash
cloudflared tunnel --url http://localhost:3000
```

---

## Next Steps

Once everything is working with Cloudflare Tunnel, consider:

1. **Deploy to Railway** for a permanent, production-ready setup
2. **Customize the confirmation message** in `app/config/templates.yaml`
3. **Add tour configurations** to map Wix service IDs to Hebrew tour names

Happy touring! 🌻
