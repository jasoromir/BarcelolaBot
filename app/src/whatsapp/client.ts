import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import type { WhatsAppState } from '../types.js';
import type { IncomingDmHandler, SendResult, WhatsAppClient } from './types.js';

const { Client, LocalAuth } = pkg;

function clearChromiumSingletonLocks(sessionDir: string): void {
  // Containers killed without graceful shutdown leave Singleton{Lock,Socket,Cookie}
  // in the Chromium profile; whatsapp-web.js's LocalAuth stores the profile under
  // `${sessionDir}/session-<clientId|Default>/`. Without cleanup the next boot fails
  // with "The profile appears to be in use by another Chromium process".
  if (!fs.existsSync(sessionDir)) return;
  const roots = [sessionDir, ...fs.readdirSync(sessionDir).map((e) => path.join(sessionDir, e))];
  for (const root of roots) {
    try {
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const p = path.join(root, name);
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

export interface WhatsAppClientOpts {
  sessionDir: string;
  onQr?: (dataUrl: string) => void;
  onQrRaw?: (qrString: string) => void;
}

type Listener = (s: WhatsAppState) => void;

export function createWhatsAppClient(opts: WhatsAppClientOpts): WhatsAppClient {
  const listeners: Listener[] = [];
  const dmHandlers: IncomingDmHandler[] = [];
  let current: WhatsAppState = { kind: 'disconnected' };
  const setState = (s: WhatsAppState) => {
    current = s;
    for (const l of listeners) l(s);
  };

  clearChromiumSingletonLocks(opts.sessionDir);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: opts.sessionDir }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    },
  });

  client.on('qr', async (qr: string) => {
    opts.onQrRaw?.(qr);
    const dataUrl = await QRCode.toDataURL(qr);
    opts.onQr?.(dataUrl);
    setState({ kind: 'qr_pending', qrDataUrl: dataUrl });
  });
  client.on('ready', () => {
    const phone = client.info?.wid?.user ? `+${client.info.wid.user}` : 'unknown';
    setState({ kind: 'connected', phone });
  });
  client.on('disconnected', () => setState({ kind: 'disconnected' }));
  client.on('auth_failure', () => setState({ kind: 'disconnected' }));

  const seenMessageIds = new Set<string>();
  const handleMessageEvent = async (msg: any, eventName: string) => {
    const from: string = msg?.from ?? '';
    const fromMe = Boolean(msg?.fromMe);
    const bodyLen = typeof msg?.body === 'string' ? msg.body.length : 0;
    const serialized = msg?.id?._serialized ?? '';
    console.log(
      `[wa:${eventName}] id=${serialized} from=${from} fromMe=${fromMe} bodyLen=${bodyLen} type=${msg?.type}`,
    );
    if (fromMe) return;
    // Accept both classic @c.us (phone-addressed) and @lid (LID-addressed) DMs.
    // Groups end in @g.us and are ignored. Anything else we also skip.
    if (!(from.endsWith('@c.us') || from.endsWith('@lid'))) return;
    if (typeof msg.body !== 'string' || msg.body.length === 0) return;
    if (serialized && seenMessageIds.has(serialized)) return;
    if (serialized) {
      seenMessageIds.add(serialized);
      if (seenMessageIds.size > 500) {
        const first = seenMessageIds.values().next().value;
        if (first) seenMessageIds.delete(first);
      }
    }

    // Resolve the real phone number. For @c.us the `from` already contains the
    // phone digits. For @lid (WhatsApp's new opaque Linked-Device ID) we need
    // getContact() to get the underlying E.164.
    let fromPhoneE164: string | null = null;
    if (from.endsWith('@c.us')) {
      const digits = from.replace(/@c\.us$/, '');
      fromPhoneE164 = digits.startsWith('+') ? digits : `+${digits}`;
    } else {
      try {
        const contact = await msg.getContact();
        // Contact.number is the international phone number without the '+'.
        const num: string | undefined = contact?.number;
        if (num && /^\d+$/.test(num)) fromPhoneE164 = `+${num}`;
      } catch (err) {
        console.error(`[wa:${eventName}] getContact failed for ${from}:`, err);
      }
    }
    if (!fromPhoneE164) {
      console.log(`[wa:${eventName}] could not resolve phone for from=${from}`);
      return;
    }

    const dm = {
      messageId: serialized,
      fromPhoneE164,
      body: msg.body,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
    };
    for (const h of dmHandlers) {
      Promise.resolve(h(dm)).catch((err) => {
        console.error('[wa:dmHandler] error', err);
      });
    }
  };
  client.on('message', (msg: any) => {
    handleMessageEvent(msg, 'message').catch((err) =>
      console.error('[wa:message] unhandled', err),
    );
  });
  client.on('message_create', (msg: any) => {
    handleMessageEvent(msg, 'message_create').catch((err) =>
      console.error('[wa:message_create] unhandled', err),
    );
  });

  async function sendToGroup(groupId: string, body: string): Promise<SendResult> {
    const msg = await client.sendMessage(groupId, body);
    return { messageId: msg.id._serialized };
  }

  async function sendDirect(phoneE164: string, body: string): Promise<SendResult> {
    const digits = phoneE164.replace(/^\+/, '');
    const chatId = `${digits}@c.us`;
    const msg = await client.sendMessage(chatId, body);
    return { messageId: msg.id._serialized };
  }

  async function isGroupAdmin(groupId: string): Promise<boolean> {
    const chat = await client.getChatById(groupId);
    const selfId = client.info?.wid?._serialized;
    if (!selfId) return false;
    const participants = (chat as unknown as { participants?: Array<{ id: { _serialized: string }; isAdmin: boolean }> })
      .participants ?? [];
    return participants.some((p) => p.id._serialized === selfId && p.isAdmin);
  }

  async function setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    const chat = await client.getChatById(groupId);
    await (chat as unknown as { setMessagesAdminsOnly: (v: boolean) => Promise<void> })
      .setMessagesAdminsOnly(adminsOnly);
  }

  async function listChats() {
    const chats = await client.getChats();
    const selfId = client.info?.wid?._serialized;
    const result = [];

    for (const chat of chats) {
      const isGroup = chat.isGroup;
      let isAdmin = false;

      if (isGroup && selfId) {
        const participants = (chat as unknown as { participants?: Array<{ id: { _serialized: string }; isAdmin: boolean }> })
          .participants ?? [];
        isAdmin = participants.some((p) => p.id._serialized === selfId && p.isAdmin);
      }

      result.push({
        id: chat.id._serialized,
        name: chat.name || 'Unknown',
        isGroup,
        isAdmin: isGroup ? isAdmin : undefined,
      });
    }

    return result;
  }

  async function getMessages(chatId: string, limit: number) {
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });

    return messages.map((msg: any) => ({
      id: msg.id._serialized,
      body: msg.body || '',
      type: msg.type,
      timestamp: msg.timestamp,
      hasMedia: msg.hasMedia,
    }));
  }

  async function forwardMessage(messageId: string, toChatId: string) {
    const msg = await client.getMessageById(messageId);
    await msg.forward(toChatId);
    return { messageId: messageId };
  }

  async function sendSticker(toChatId: string, messageId: string) {
    const msg = await client.getMessageById(messageId);
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      await client.sendMessage(toChatId, media, { sendMediaAsSticker: true });
    }
    return { messageId: messageId };
  }

  return {
    async start(): Promise<void> {
      if (current.kind === 'connected' || current.kind === 'qr_pending') return;
      await client.initialize();
    },
    async stop(): Promise<void> {
      await client.destroy();
      setState({ kind: 'disconnected' });
    },
    state: () => current,
    onStateChange: (cb) => listeners.push(cb),
    sendToGroup,
    sendDirect,
    isGroupAdmin,
    setGroupMessagesAdminsOnly,
    listChats,
    getMessages,
    forwardMessage,
    sendSticker,
    onIncomingDm: (h) => dmHandlers.push(h),
  };
}
