import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import type { WhatsAppState } from '../types.js';
import type { SendResult, WhatsAppClient } from './types.js';

const { Client, LocalAuth } = pkg;

export interface WhatsAppClientOpts {
  sessionDir: string;
  onQr?: (dataUrl: string) => void;
  onQrRaw?: (qrString: string) => void;
}

type Listener = (s: WhatsAppState) => void;

export function createWhatsAppClient(opts: WhatsAppClientOpts): WhatsAppClient {
  const listeners: Listener[] = [];
  let current: WhatsAppState = { kind: 'disconnected' };
  const setState = (s: WhatsAppState) => {
    current = s;
    for (const l of listeners) l(s);
  };

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
        '--no-zygote',
        '--single-process',
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
  };
}
