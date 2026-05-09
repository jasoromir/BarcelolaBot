#!/usr/bin/env tsx
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import qrcodeTerminal from 'qrcode-terminal';

const GROUP_ID = '120363425214664727@g.us'; // Barcelola BOT🌻
const TARGET_PHONE = '+34675319188';
const SESSION_DIR = './data/session';

async function main() {
  console.log('Creating WhatsApp client...');

  const client = createWhatsAppClient({
    sessionDir: SESSION_DIR,
    onQrRaw: (qr) => {
      console.log('\n============ SCAN THIS QR WITH WHATSAPP ============\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\nWhatsApp → Settings → Linked Devices → Link a device');
      console.log('=====================================================\n');
    },
  });

  // Wait for connection
  await new Promise<void>((resolve) => {
    client.onStateChange((state) => {
      console.log('State:', state.kind);
      if (state.kind === 'connected') {
        console.log('✅ Connected!');
        resolve();
      }
    });
    client.start();
  });

  // Wait a moment for client to be fully ready
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('\n📥 Fetching ALL messages from Barcelola BOT group...');
  const messages = await client.getMessages(GROUP_ID, 1000);

  console.log(`Found ${messages.length} messages`);

  // Sort by timestamp to get oldest first
  const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];  // Very first message ever
  const second = sorted[1]; // Second message ever

  console.log('\n📋 First message:');
  console.log('  Type:', first.type);
  console.log('  Body:', first.body.substring(0, 100));
  console.log('  Has media:', first.hasMedia);

  console.log('\n📋 Second message:');
  console.log('  Type:', second.type);
  console.log('  Body:', second.body.substring(0, 100));
  console.log('  Has media:', second.hasMedia);

  console.log('\n📤 Sending messages to', TARGET_PHONE, '(as fresh messages, not forwarded)');

  // Send first message
  if (first.type === 'chat' && first.body) {
    console.log('Sending first message text...');
    await client.sendDirect(TARGET_PHONE, first.body);
    console.log('✅ First message sent');
  } else if (first.hasMedia) {
    console.log('⚠️  First message has media - forwarding instead');
    const targetChatId = TARGET_PHONE.replace(/^\+/, '') + '@c.us';
    await client.forwardMessage(first.id, targetChatId);
    console.log('✅ First message (media) forwarded');
  }

  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s between messages

  // Send second message (likely a sticker based on your description)
  if (second.type === 'sticker' || second.hasMedia) {
    console.log('Forwarding second message (sticker/media)...');
    const targetChatId = TARGET_PHONE.replace(/^\+/, '') + '@c.us';
    await client.forwardMessage(second.id, targetChatId);
    console.log('✅ Second message (sticker) forwarded');
  } else if (second.body) {
    console.log('Sending second message text...');
    await client.sendDirect(TARGET_PHONE, second.body);
    console.log('✅ Second message sent');
  }

  console.log('\n✅ Done! Messages sent successfully.');

  await client.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
