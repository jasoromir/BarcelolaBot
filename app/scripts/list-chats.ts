// Standalone script: connects to WhatsApp using the saved session, lists all chats
// and groups, then exits.
//
// Usage:
//   cd app && npx tsx scripts/list-chats.ts
//
// Requires: session already linked (QR scanned once via `npm run dev`).

import 'dotenv/config';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';

const { Client, LocalAuth } = pkg;

type ChatLike = {
  id: { _serialized: string; server: string };
  name?: string;
  isGroup: boolean;
  isReadOnly?: boolean;
  unreadCount?: number;
  timestamp?: number;
  participants?: Array<{ id: { _serialized: string }; isAdmin?: boolean }>;
};

async function main(): Promise<void> {
  const sessionDir = path.resolve(process.env.DATA_DIR ?? './data', 'session');
  console.log(`Connecting (session dir: ${sessionDir})...\n`);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  let ready = false;

  client.on('qr', (qr: string) => {
    console.log('\n============ SCAN THIS QR WITH WHATSAPP ============');
    console.log('WhatsApp → Settings → Linked Devices → Link a device\n');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('Waiting for scan... (this script will wait up to 5 minutes)');
  });

  client.on('ready', async () => {
    ready = true;
    const me = client.info?.wid;
    console.log(`Connected as: +${me?.user ?? 'unknown'}\n`);
    try {
      const chats = (await client.getChats()) as unknown as ChatLike[];
      const groups = chats.filter((c) => c.isGroup);
      const dms = chats.filter((c) => !c.isGroup);

      const selfId = me?._serialized;
      const fmtAdmin = (g: ChatLike) => {
        if (!selfId || !g.participants) return '(no participants loaded)';
        const me = g.participants.find((p) => p.id._serialized === selfId);
        return me?.isAdmin ? 'ADMIN' : 'member';
      };

      console.log('='.repeat(80));
      console.log(`GROUPS (${groups.length})`);
      console.log('='.repeat(80));
      for (const g of groups) {
        const ts = g.timestamp ? new Date(g.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—';
        console.log(
          `${(g.name ?? '(unnamed)').padEnd(45)} ` +
            `${g.id._serialized.padEnd(30)} ` +
            `${fmtAdmin(g).padEnd(10)} ` +
            `last=${ts} unread=${g.unreadCount ?? 0}`,
        );
      }

      console.log('\n' + '='.repeat(80));
      console.log(`DIRECT CHATS (${dms.length}) — top 30 by recency`);
      console.log('='.repeat(80));
      const dmsSorted = [...dms].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 30);
      for (const c of dmsSorted) {
        const ts = c.timestamp ? new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—';
        console.log(
          `${(c.name ?? c.id._serialized).padEnd(45)} ${c.id._serialized.padEnd(30)} last=${ts} unread=${c.unreadCount ?? 0}`,
        );
      }
      console.log(`\nTotal: ${chats.length} chats (${groups.length} groups, ${dms.length} DMs)`);
    } finally {
      await client.destroy();
      process.exit(0);
    }
  });

  client.on('auth_failure', (msg: string) => {
    console.error('auth failure:', msg);
    process.exit(1);
  });

  await client.initialize();

  // Safety timeout (5 minutes — gives you time to scan the QR)
  setTimeout(() => {
    if (!ready) {
      console.error('\nTimed out waiting for WhatsApp ready event (5 minutes).');
      void client.destroy();
      process.exit(1);
    }
  }, 300_000);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
