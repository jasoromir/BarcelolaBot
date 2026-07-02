import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import type { WhatsAppState } from '../types.js';
import type {
  GroupJoinHandler,
  GroupMessageHandler,
  IncomingDmHandler,
  ReactionHandler,
  SendResult,
  WhatsAppClient,
} from './types.js';

const { Client, LocalAuth } = pkg;

export interface LinkPreviewData {
  title: string;
  description: string;
  canonicalUrl: string;
  matchedText: string;
  thumbnail?: string; // base64 JPEG
}

/**
 * Fetch OG metadata from a URL (runs in Node.js, not in Chromium).
 * Returns pre-computed link preview data that can be injected into sendMessage.
 */
export async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WhatsApp/2' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = (prop: string): string => {
      const m = html.match(new RegExp(`<meta[^>]*property="${prop}"[^>]*content="([^"]*)"`, 'i'));
      return m?.[1] ?? '';
    };
    const title = og('og:title') || url;
    const description = og('og:description') || '';
    const canonicalUrl = og('og:url') || url;
    const imageUrl = og('og:image');

    let thumbnail: string | undefined;
    if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl, { redirect: 'follow' });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          thumbnail = buf.toString('base64');
        }
      } catch {
        // image fetch failed — send without thumbnail
      }
    }

    return { title, description, canonicalUrl, matchedText: url, thumbnail };
  } catch {
    return null;
  }
}

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
  const groupMessageHandlers: GroupMessageHandler[] = [];
  const groupJoinHandlers: GroupJoinHandler[] = [];
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
    // A QR event means the session is dead — stop any reconnect loop.
    if (!reconnectGaveUp) cancelReconnect('qr event received — session needs fresh scan');
  });
  client.on('ready', () => {
    const phone = client.info?.wid?.user ? `+${client.info.wid.user}` : 'unknown';
    reconnectAttempt = 0;
    reconnectGaveUp = false;
    setState({ kind: 'connected', phone });
  });

  // Auto-reconnect with bounded exponential backoff. WhatsApp-web drops the
  // session occasionally (network blips, server restarts, Chromium hiccups);
  // without this the bot stays disconnected until somebody hits /admin.
  // Backoff: 30s → 2m → 5m, max 10 attempts. After that, or once a QR event
  // fires (meaning the session is dead and needs a fresh scan), give up —
  // retrying further just exhausts container resources (EAGAIN).
  const reconnectDelaysMs = [30_000, 120_000, 300_000];
  const MAX_RECONNECT_ATTEMPTS = 10;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectGaveUp = false;
  const autoReconnectEnabled = process.env.PUPPETEER_AUTO_RECONNECT !== 'false';

  const cancelReconnect = (reason: string) => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectGaveUp = true;
    console.log(`[wa:reconnect] gave up (${reason})`);
  };

  const scheduleReconnect = (reason: string) => {
    if (!autoReconnectEnabled) return;
    if (reconnectTimer) return; // already scheduled
    if (reconnectGaveUp) return; // already gave up
    if (current.kind === 'qr_pending') {
      cancelReconnect('qr_pending — session dead, needs fresh scan');
      return;
    }
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      cancelReconnect(`max attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      return;
    }
    const idx = Math.min(reconnectAttempt, reconnectDelaysMs.length - 1);
    const delay = reconnectDelaysMs[idx]!;
    console.log(`[wa:reconnect] scheduling in ${delay}ms (attempt ${reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS}, reason=${reason})`);
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

    // Group messages end in @g.us. Dispatch them to group handlers (spam
    // moderation) and stop — the DM/reminder path below only handles 1:1 chats.
    if (from.endsWith('@g.us')) {
      if (serialized && seenMessageIds.has(serialized)) return;
      if (serialized) {
        seenMessageIds.add(serialized);
        if (seenMessageIds.size > 500) {
          const first = seenMessageIds.values().next().value;
          if (first) seenMessageIds.delete(first);
        }
      }
      if (groupMessageHandlers.length === 0) return;
      // `author` is the participant who sent it; `from` is the group jid.
      const authorId: string =
        (msg as any).author ?? (msg as any)._data?.author ?? '';
      const gm = {
        messageId: serialized,
        groupId: from,
        authorId,
        body: typeof msg.body === 'string' ? msg.body : '',
        type: typeof msg.type === 'string' ? msg.type : 'unknown',
        timestamp:
          typeof msg.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
        hasMedia: Boolean(msg.hasMedia),
      };
      for (const h of groupMessageHandlers) {
        Promise.resolve(h(gm)).catch((err) => {
          console.error('[wa:groupMessageHandler] error', err);
        });
      }
      return;
    }

    // Accept both classic @c.us (phone-addressed) and @lid (LID-addressed) DMs.
    // Anything else we skip.
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

  client.on('group_join', (notification: any) => {
    try {
      if (groupJoinHandlers.length === 0) return;
      const groupId: string = notification?.chatId ?? notification?.id?.remote ?? '';
      const recipientIds: string[] = Array.isArray(notification?.recipientIds)
        ? notification.recipientIds
        : [];
      const ts: number =
        typeof notification?.timestamp === 'number'
          ? notification.timestamp
          : Math.floor(Date.now() / 1000);
      if (!groupId || recipientIds.length === 0) return;
      const ev = { groupId, participantIds: recipientIds, timestamp: ts };
      console.log(`[wa:group_join] group=${groupId} joined=${recipientIds.join(',')}`);
      for (const h of groupJoinHandlers) {
        Promise.resolve(h(ev)).catch((err) => {
          console.error('[wa:groupJoinHandler] error', err);
        });
      }
    } catch (err) {
      console.error('[wa:group_join] dispatch failed', err);
    }
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

  async function debugLinkPreview(url: string): Promise<unknown> {
    return client.pupPage!.evaluate(async (u: string) => {
      const w = globalThis as any;

      // Test 1: can the page context fetch the URL at all?
      let fetchTest: string;
      try {
        const r = await fetch(u, { method: 'HEAD' });
        fetchTest = `fetch HEAD ${r.status} ${r.headers.get('content-type')}`;
      } catch (e: any) {
        fetchTest = `fetch failed: ${e?.message}`;
      }

      // Test 2: WALinkify + getLinkPreview
      const { findLink } = w.require('WALinkify');
      const link = findLink(u);
      if (!link) return { fetchTest, error: 'no link found by WALinkify' };

      const result = await w.require('WAWebLinkPreviewChatAction').getLinkPreview(link);
      if (!result || !result.data) return { fetchTest, error: 'no preview data', raw: JSON.stringify(result)?.slice(0, 500) };
      const d = result.data;
      return {
        fetchTest,
        title: d.title,
        description: d.description,
        canonicalUrl: d.canonicalUrl,
        matchedText: d.matchedText,
        thumbnail: d.thumbnail ? `base64(${d.thumbnail.length} chars)` : null,
        thumbnailUrl: d.thumbnailUrl || d.directPath || null,
        mediaType: d.mediaType,
        subtype: d.subtype,
        previewType: d.previewType,
        doNotPlayInline: d.doNotPlayInline,
        // Dump all top-level keys to see what's available
        allKeys: Object.keys(d),
      };
    }, url);
  }

  async function sendToGroup(groupId: string, body: string, opts?: { linkPreview?: LinkPreviewData }): Promise<SendResult> {
    if (opts?.linkPreview) {
      // Bypass the broken WAWebLinkPreviewChatAction by injecting pre-fetched
      // preview data directly. We disable the library's auto-preview and pass
      // the fields ourselves via pupPage.evaluate.
      const lp = opts.linkPreview;
      const msg = await client.pupPage!.evaluate(
        async (chatId: string, content: string, preview: any) => {
          const w = globalThis as any;
          const chat = await w.WWebJS.getChat(chatId, { getAsModel: false });
          if (!chat) return null;
          const msgResult = await w.WWebJS.sendMessage(chat, content, {
            linkPreview: undefined,
            ...preview,
            preview: true,
            subtype: 'url',
          });
          return msgResult ? w.WWebJS.getMessageModel(msgResult) : null;
        },
        groupId,
        body,
        lp,
      );
      return { messageId: (msg as any)?.id?._serialized ?? '' };
    }
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

  async function getGroupAdmins(groupId: string): Promise<string[]> {
    const chat = await client.getChatById(groupId);
    const participants =
      (chat as unknown as { participants?: Array<{ id: { _serialized: string }; isAdmin: boolean }> })
        .participants ?? [];
    return participants.filter((p) => p.isAdmin).map((p) => p.id._serialized);
  }

  async function deleteMessageForEveryone(messageId: string): Promise<void> {
    const msg = await client.getMessageById(messageId);
    if (!msg) throw new Error(`deleteMessageForEveryone: message not found id=${messageId}`);
    await msg.delete(true);
  }

  async function removeParticipant(groupId: string, participantId: string): Promise<void> {
    const chat = await client.getChatById(groupId);
    await (chat as unknown as { removeParticipants: (ids: string[]) => Promise<unknown> })
      .removeParticipants([participantId]);
  }

  async function resolveParticipantPhone(participantId: string): Promise<string | null> {
    // @c.us ids already carry the E.164 digits.
    if (participantId.endsWith('@c.us')) {
      const digits = participantId.replace(/@c\.us$/, '');
      return /^\d{6,15}$/.test(digits) ? `+${digits}` : null;
    }
    // @lid (and anything else) is opaque — resolve via the Contact, which for
    // @lid contacts exposes the real @c.us jid in id._serialized / id.user.
    try {
      const contact: any = await client.getContactById(participantId);
      const candidates = [contact?.id?._serialized, contact?.id?.user, contact?.number];
      for (const raw of candidates) {
        if (typeof raw !== 'string' || !raw) continue;
        const digits = raw.replace(/@c\.us$/, '');
        if (/^\d{6,15}$/.test(digits) && !digits.startsWith('1200')) return `+${digits}`;
      }
    } catch (err) {
      console.error(`[wa:resolveParticipantPhone] failed for ${participantId}:`, err);
    }
    return null;
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
    getGroupAdmins,
    deleteMessageForEveryone,
    removeParticipant,
    resolveParticipantPhone,
    listChats,
    getMessages,
    forwardMessage,
    sendSticker,
    onIncomingDm: (h: IncomingDmHandler) => dmHandlers.push(h),
    onReaction: (h: ReactionHandler) => reactionHandlers.push(h),
    onGroupMessage: (h: GroupMessageHandler) => groupMessageHandlers.push(h),
    onGroupJoin: (h: GroupJoinHandler) => groupJoinHandlers.push(h),
    sendStickerFromDataUrl,
    downloadStickerBytes,
    debugLinkPreview,
  };
}
