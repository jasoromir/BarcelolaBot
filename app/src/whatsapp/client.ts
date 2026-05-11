import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import type { WhatsAppState } from '../types.js';
import type {
  IncomingDmHandler,
  ReactionHandler,
  SendResult,
  WhatsAppClient,
} from './types.js';

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
  const reactionHandlers: ReactionHandler[] = [];
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
    reconnectAttempt = 0;
    setState({ kind: 'connected', phone });
  });

  // Auto-reconnect with bounded exponential backoff. WhatsApp-web drops the
  // session occasionally (network blips, server restarts, Chromium hiccups);
  // without this the bot stays disconnected until somebody hits /admin.
  // Backoff: 30s → 2m → 5m → 5m forever. Caller can disable by setting
  // PUPPETEER_AUTO_RECONNECT=false.
  const reconnectDelaysMs = [30_000, 120_000, 300_000];
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const autoReconnectEnabled = process.env.PUPPETEER_AUTO_RECONNECT !== 'false';

  const scheduleReconnect = (reason: string) => {
    if (!autoReconnectEnabled) return;
    if (reconnectTimer) return; // already scheduled
    const idx = Math.min(reconnectAttempt, reconnectDelaysMs.length - 1);
    const delay = reconnectDelaysMs[idx]!;
    console.log(`[wa:reconnect] scheduling in ${delay}ms (attempt ${reconnectAttempt + 1}, reason=${reason})`);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      try {
        console.log(`[wa:reconnect] attempting client.initialize()`);
        await client.initialize();
      } catch (err) {
        console.error(`[wa:reconnect] initialize failed:`, err);
        scheduleReconnect(`retry-${(err as Error).message}`);
      }
    }, delay);
  };

  client.on('disconnected', (reason: any) => {
    console.log(`[wa:disconnected] reason=${reason}`);
    setState({ kind: 'disconnected' });
    scheduleReconnect(`disconnected:${reason}`);
  });
  client.on('auth_failure', (msg: any) => {
    console.log(`[wa:auth_failure] ${msg}`);
    setState({ kind: 'disconnected' });
    // Don't auto-reconnect on auth_failure; it usually means the session is
    // logged out / needs a fresh QR scan, and retrying just burns attempts.
  });

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
    // phone digits. For @lid (WhatsApp's opaque Linked-Device ID) we need to
    // resolve via the Contact. Different whatsapp-web.js versions expose the
    // E.164 in different fields — try each in order. Dump everything we can
    // see for debugging when resolution fails.
    let fromPhoneE164: string | null = null;
    if (from.endsWith('@c.us')) {
      const digits = from.replace(/@c\.us$/, '');
      fromPhoneE164 = digits.startsWith('+') ? digits : `+${digits}`;
    } else {
      try {
        const contact: any = await msg.getContact();
        // Priority: jid-style fields first (these hold the real E.164 for
        // @lid contacts), then raw strings, then contact.number as a last
        // resort. For LID contacts `contact.number` is the LID itself (e.g.
        // 221616084627681), which we must reject — real phone numbers arrive
        // in `contact.id._serialized` / `contact.id.user` as the @c.us jid.
        const candidates: Array<[string, unknown]> = [
          ['contact.id._serialized', contact?.id?._serialized],
          ['msg._data.senderObj.id._serialized', (msg as any)._data?.senderObj?.id?._serialized],
          ['msg._data.sender.id._serialized', (msg as any)._data?.sender?.id?._serialized],
          ['msg.author', (msg as any).author],
          ['msg._data.author', (msg as any)._data?.author],
          ['msg._data.from', (msg as any)._data?.from],
          ['contact.id.user', contact?.id?.user],
          ['contact.number', contact?.number],
        ];
        console.log(
          `[wa:${eventName}] lid resolution candidates: ${JSON.stringify(
            candidates.map(([k, v]) => [k, v]),
          )}`,
        );
        const looksLikePhone = (s: string) => /^\d{8,15}$/.test(s) && !s.startsWith('1200');
        for (const [key, raw] of candidates) {
          if (typeof raw !== 'string' || !raw) continue;
          if (raw.endsWith('@lid')) continue;
          if (raw.endsWith('@c.us')) {
            const digits = raw.replace(/@c\.us$/, '');
            if (looksLikePhone(digits)) {
              fromPhoneE164 = `+${digits}`;
              console.log(`[wa:${eventName}] resolved phone via ${key} = ${fromPhoneE164}`);
              break;
            }
          } else if (looksLikePhone(raw)) {
            // Only accept bare-digit fields if their key is known-safe.
            // `contact.id.user` is safe (always the E.164 for @c.us-backed
            // contacts). `contact.number` is NOT safe — for @lid contacts it
            // returns the LID. Everything else we skip.
            if (key === 'contact.id.user') {
              fromPhoneE164 = `+${raw}`;
              console.log(`[wa:${eventName}] resolved phone via ${key} = ${fromPhoneE164}`);
              break;
            }
          }
        }
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

  client.on('message_reaction', (reaction: any) => {
    try {
      // whatsapp-web.js emits every reaction update, including removals (reaction === '').
      const emoji: string = typeof reaction?.reaction === 'string' ? reaction.reaction : '';
      const targetMessageId: string = reaction?.msgId?._serialized ?? '';
      const chatId: string = reaction?.msgId?.remote?._serialized ?? reaction?.msgId?.remote ?? '';
      const ts: number =
        typeof reaction?.timestamp === 'number' ? reaction.timestamp : Math.floor(Date.now() / 1000);
      console.log(
        `[wa:message_reaction] target=${targetMessageId} emoji=${JSON.stringify(emoji)} chat=${chatId}`,
      );
      if (!emoji || !targetMessageId) return;
      const ev = { targetMessageId, reaction: emoji, chatId, timestamp: ts };
      for (const h of reactionHandlers) {
        Promise.resolve(h(ev)).catch((err) => {
          console.error('[wa:reactionHandler] error', err);
        });
      }
    } catch (err) {
      console.error('[wa:message_reaction] dispatch failed', err);
    }
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
    const msg: any = await client.getMessageById(messageId);
    if (!msg) {
      throw new Error(`sendSticker: message not found id=${messageId}`);
    }
    console.log(
      `[wa:sendSticker] src id=${messageId} type=${msg.type} hasMedia=${msg.hasMedia} from=${msg.from} to=${toChatId}`,
    );
    if (!msg.hasMedia) {
      throw new Error(
        `sendSticker: source message has no media (type=${msg.type}, id=${messageId})`,
      );
    }
    console.log(`[wa:sendSticker] calling downloadMedia...`);
    const downloadTimeoutMs = 30_000;
    const media: any = await Promise.race([
      msg.downloadMedia(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`downloadMedia timeout after ${downloadTimeoutMs}ms`)), downloadTimeoutMs),
      ),
    ]);
    if (!media) {
      throw new Error(`sendSticker: downloadMedia returned null for ${messageId}`);
    }
    const dataLen = typeof media.data === 'string' ? media.data.length : 0;
    console.log(
      `[wa:sendSticker] downloaded mimetype=${media.mimetype} filename=${media.filename} dataLen=${dataLen}`,
    );
    const sent: any = await client.sendMessage(toChatId, media, {
      sendMediaAsSticker: true,
    });
    return { messageId: sent?.id?._serialized ?? messageId };
  }

  async function downloadStickerBytes(messageId: string): Promise<{ data: string; mimetype: string } | null> {
    // Try the simple path first: the whatsapp-web.js wrapper's downloadMedia
    // on the Message object. It kicks off key resolution + decrypt internally.
    try {
      const msg: any = await client.getMessageById(messageId);
      if (!msg) {
        console.log(`[wa:downloadStickerBytes] message not found`);
        return null;
      }
      console.log(
        `[wa:downloadStickerBytes] msg type=${msg.type} hasMedia=${msg.hasMedia} fromMe=${msg.fromMe}`,
      );
      const media = await Promise.race([
        msg.downloadMedia(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000)),
      ]);
      if (media && typeof media === 'object' && (media as any).data) {
        const m = media as any;
        console.log(
          `[wa:downloadStickerBytes] wrapper path ok mimetype=${m.mimetype} dataLen=${(m.data || '').length}`,
        );
        return { data: m.data, mimetype: m.mimetype || 'image/webp' };
      }
      console.log(`[wa:downloadStickerBytes] wrapper path returned null, trying page.evaluate`);
    } catch (err) {
      console.log(`[wa:downloadStickerBytes] wrapper path threw: ${(err as Error).message}`);
    }

    // Fallback: reach into the page Store directly via page.evaluate.
    const page = (client as any).pupPage;
    if (!page) return null;
    const result = await page.evaluate(async (id: string) => {
      const w = globalThis as any;
      const ns = w.WWebJS;
      const mod = w.Store;
      if (!ns || !mod?.Msg) return { error: 'no Store' };
      const msg = mod.Msg.get(id);
      if (!msg) return { error: 'msg not found' };
      try {
        const blob = await ns.downloadMedia(msg);
        if (!blob) return { error: 'downloadMedia null' };
        const ab = await blob.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(ab);
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i] as number);
        return { data: w.btoa(binary), mimetype: blob.type || 'image/webp' };
      } catch (e: any) {
        return { error: e?.message || String(e) };
      }
    }, messageId);
    if (!result || (result as any).error) {
      console.log(`[wa:downloadStickerBytes] page.evaluate failed: ${(result as any)?.error}`);
      return null;
    }
    return result as { data: string; mimetype: string };
  }

  async function sendStickerFromDataUrl(toChatId: string, dataUrl: string) {
    // data:image/webp;base64,AAAA...
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error('sendStickerFromDataUrl: invalid data URL');
    const mimetype = match[1]!;
    const data = match[2]!;
    const MessageMedia = (pkg as any).MessageMedia;
    const media = new MessageMedia(mimetype, data, 'sticker.webp');
    const sent: any = await client.sendMessage(toChatId, media, { sendMediaAsSticker: true });
    return { messageId: sent?.id?._serialized ?? '' };
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
    onStateChange: (cb: Listener) => listeners.push(cb),
    sendToGroup,
    sendDirect,
    isGroupAdmin,
    setGroupMessagesAdminsOnly,
    listChats,
    getMessages,
    forwardMessage,
    sendSticker,
    onIncomingDm: (h: IncomingDmHandler) => dmHandlers.push(h),
    onReaction: (h: ReactionHandler) => reactionHandlers.push(h),
    sendStickerFromDataUrl,
    downloadStickerBytes,
  };
}
