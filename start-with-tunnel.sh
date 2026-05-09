#!/bin/bash

# Start WhatsApp Bot with Cloudflare Tunnel
# This script runs both the bot and cloudflare tunnel in parallel

set -e

cd "$(dirname "$0")/app"

echo "🚀 Starting Barcelola WhatsApp Bot with Cloudflare Tunnel..."
echo ""

# Function to cleanup background processes on exit
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    kill $BOT_PID $TUNNEL_PID 2>/dev/null || true
    exit
}

trap cleanup SIGINT SIGTERM

# Start the bot in background
echo "📱 Starting WhatsApp Bot..."
npm run dev &
BOT_PID=$!

# Give the bot a moment to start
sleep 3

# Start cloudflare tunnel in background
echo "🌐 Starting Cloudflare Tunnel..."
echo ""
echo "⚠️  IMPORTANT: Copy the tunnel URL below and configure it in Wix webhooks!"
echo "   Format: https://YOUR-TUNNEL-URL.trycloudflare.com/webhook/wix"
echo ""
cloudflared tunnel --url http://localhost:3000 &
TUNNEL_PID=$!

# Wait for both processes
echo ""
echo "✅ Both services are running!"
echo "   - WhatsApp Bot: http://localhost:3000"
echo "   - Admin Panel: http://localhost:3000/admin"
echo ""
echo "Press Ctrl+C to stop both services"
echo ""

wait
