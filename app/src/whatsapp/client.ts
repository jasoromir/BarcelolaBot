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

const { Client, LocalAuth, Poll } = pkg;

/** Thrown by sendDirect when a phone is definitively not a WhatsApp user
 *  (WhatsApp's existence query succeeded and returned "no such account").
 *  Callers treat this as a permanent, non-retryable failure. */
export class UnregisteredNumberError extends Error {
  constructor(public readonly phone: string) {
    super(`number not registered on WhatsApp: ${phone}`);
    this.name = 'UnregisteredNumberError';
  }
}

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
  const rawGroupMessageHandlers: Array<(msg: any, groupId: string) => void> = [];
  const rawDmMediaHandlers: Array<(msg: any, fromPhone: string) => void> = [];
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
    if (!serialized) {
      console.log(`[wa:${eventName}] EMPTY ID — raw msg.id=${JSON.stringify(msg?.id)}`);
    }
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
      // Raw message hook for the guide photos collector (needs the original msg
      // object to call .forward() later — the GroupMessage interface strips it).
      for (const h of rawGroupMessageHandlers) {
        try { h(msg, from); } catch (err) {
          console.error('[wa:rawGroupMessageHandler] error', err);
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
    // Note: we intentionally do NOT drop empty-body DMs anymore. Voice notes
    // (type=ptt), images, videos, stickers etc. carry no text `body` but are
    // real customer messages — dropping them meant the bot silently ignored a
    // customer (bad experience). We pass them through with type/hasMedia so the
    // reply handler can forward them to staff and, if unbooked, auto-reply.
    // We still skip WhatsApp system notifications (e2e_notification, etc.).
    const msgType: string = typeof msg.type === 'string' ? msg.type : 'unknown';
    const SYSTEM_TYPES = new Set(['e2e_notification', 'notification_template', 'gp2', 'broadcast_notification', 'call_log', 'protocol']);
    if (SYSTEM_TYPES.has(msgType)) return;
    const hasBody = typeof msg.body === 'string' && msg.body.length > 0;
    const hasMedia = Boolean(msg.hasMedia);
    // Nothing actionable (no text and no media) — skip.
    if (!hasBody && !hasMedia && msgType === 'unknown') return;
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
      body: typeof msg.body === 'string' ? msg.body : '',
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000),
      type: msgType,
      hasMedia,
    };
    for (const h of dmHandlers) {
      Promise.resolve(h(dm)).catch((err) => {
        console.error('[wa:dmHandler] error', err);
      });
    }
    // Raw DM media hook: passes the original msg object (with downloadMedia)
    // to handlers that need to capture images/videos from DMs (testing path).
    if (hasMedia && rawDmMediaHandlers.length > 0 && fromPhoneE164) {
      for (const h of rawDmMediaHandlers) {
        try { h(msg, fromPhoneE164); } catch (err) {
          console.error('[wa:rawDmMediaHandler] error', err);
        }
      }
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
            title: preview.title,
            description: preview.description,
            canonicalUrl: preview.canonicalUrl,
            matchedText: preview.matchedText,
            thumbnail: preview.thumbnail,
            thumbnailWidth: preview.thumbnailWidth || 646,
            thumbnailHeight: preview.thumbnailHeight || 594,
            mediaType: 1,
            preview: true,
            subtype: 'url',
            doNotPlayInline: true,
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
    return { messageId: (msg as any)?.id?._serialized ?? '' };
  }

  /**
   * Resolve a phone number to its CANONICAL WhatsApp chat id. WhatsApp has been
   * migrating accounts to LID (@lid) addressing; a hand-built `${digits}@c.us`
   * id can silently fail to route after such a migration even though the number
   * is a real WhatsApp user. `getNumberId` asks WhatsApp for the real id (which
   * may be @c.us or @lid) and returns null if the number isn't on WhatsApp.
   */
  async function resolveNumberId(phoneE164: string): Promise<string | null> {
    const digits = phoneE164.replace(/^\+/, '');
    try {
      const wid = await client.getNumberId(`${digits}@c.us`);
      return wid?._serialized ?? null;
    } catch (err) {
      console.error(`[wa:resolveNumberId] failed for ${phoneE164}:`, err);
      return null;
    }
  }

  // Every 1:1 DM in the app — whether triggered by a webhook, the reminder
  // poller, the guide-notify poller, or an admin route — funnels through this
  // single queue so at most one send is ever in flight at a time, regardless
  // of which caller triggered it. WhatsApp flagged this account for suspected
  // bulk/automated messaging (linked-device "new chat" restriction, seen
  // 2026-07-07); sending several DMs in parallel is exactly the pattern that
  // triggers that kind of anti-spam detection. `sendDirectQueue` chains onto
  // itself so a slow/failed send never blocks forever — the chain always
  // advances even if the previous send throws.
  let sendDirectQueue: Promise<unknown> = Promise.resolve();
  function enqueueSendDirect<T>(task: () => Promise<T>): Promise<T> {
    const result = sendDirectQueue.then(task, task);
    sendDirectQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function sendDirect(phoneE164: string, body: string): Promise<SendResult> {
    // Customer DMs go through the humanized path (come online → mark seen →
    // show "typing…" for a randomized 5-30s → send). For numbers the bot has
    // never chatted with, WhatsApp is far more likely to actually establish
    // the session and deliver a message that follows this natural presence
    // pattern than one fired instantly by an idle linked device (the
    // __x_isSendFailure / ack=-1 case we saw). Resolution to the canonical
    // @c.us/@lid id happens inside. Queued so it never overlaps another
    // in-flight direct send (see enqueueSendDirect above).
    return enqueueSendDirect(() => sendDirectHumanized(phoneE164, body));
  }

  /**
   * Send a DM the way a human would: come online, open the chat, mark seen,
   * show a "typing…" indicator for a couple of seconds, then send. For numbers
   * the bot has never chatted with, WhatsApp is more likely to actually deliver
   * a message that follows this natural presence pattern than one fired
   * instantly by an otherwise-idle linked device. Resolves the canonical id via
   * getNumberId first (same server handshake the phone does when you open a chat).
   */
  /**
   * WhatsApp only assigns a contact's LID (opaque Linked-Device Id) once it has
   * been "synced" — normally this happens automatically the first time a human
   * opens a chat with them. A linked device (this bot) messaging someone cold
   * skips that sync, so internal calls like `findOrCreateLatestChat` throw
   * "No LID for user" and/or the send silently never reaches the device (the
   * ack=-1 failures we've observed). This forces the same USync sync WhatsApp
   * Web does when you open a chat, via WAWebContactSyncUtils, so the LID gets
   * resolved before we attempt to send. Community-verified workaround for
   * https://github.com/wwebjs/whatsapp-web.js/issues/3834 (unresolved upstream
   * as of whatsapp-web.js 1.34.7 — see also the July 2026 duplicate report at
   * https://github.com/wwebjs/whatsapp-web.js/issues/201822). Best-effort: if
   * the internal module shape changes in a future WA Web release this silently
   * no-ops rather than breaking sends.
   */
  async function forceSyncLid(phoneE164: string): Promise<void> {
    const digits = phoneE164.replace(/^\+/, '');
    try {
      const result = await client.pupPage!.evaluate(async (phoneNumber: string) => {
        const w = globalThis as any;
        try {
          const syncUtils = w.require('WAWebContactSyncUtils');
          if (!syncUtils?.constructUsyncDeltaQuery) return { ok: false, reason: 'no constructUsyncDeltaQuery' };
          const query = syncUtils.constructUsyncDeltaQuery([{ type: 'add', phoneNumber }]);
          const res = await query.execute();
          const lid = res?.list?.[0]?.lid ?? null;
          return { ok: true, lid };
        } catch (e: any) {
          return { ok: false, reason: e?.message || String(e) };
        }
      }, digits);
      console.log(`[wa:forceSyncLid] ${phoneE164} -> ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[wa:forceSyncLid] evaluate failed for ${phoneE164}:`, err);
    }
  }

  /**
   * Typing duration scaled to message length so it reads as a human actually
   * composing that text — a one-line "thank you" shouldn't take as long to
   * "type" as a multi-paragraph booking confirmation. Linearly interpolates
   * between MIN_MS (short messages) and MAX_MS (long messages) based on
   * character count, then applies ±15% jitter so identical-length messages
   * don't all take the exact same time.
   */
  function typingMsForBody(body: string): number {
    const MIN_MS = 4_000;
    const MAX_MS = 30_000;
    const MIN_LEN = 10; // very short replies ("תודה!") floor near MIN_MS
    const MAX_LEN = 500; // long confirmations/reminders cap near MAX_MS
    const len = Math.min(Math.max(body.length, MIN_LEN), MAX_LEN);
    const t = (len - MIN_LEN) / (MAX_LEN - MIN_LEN);
    const base = MIN_MS + t * (MAX_MS - MIN_MS);
    const jitter = 0.85 + Math.random() * 0.3; // 0.85x - 1.15x
    return Math.round(base * jitter);
  }

  async function sendDirectHumanized(
    phoneE164: string,
    body: string,
    typingMs = typingMsForBody(body),
  ): Promise<SendResult> {
    const digits = phoneE164.replace(/^\+/, '');
    const chatId = (await resolveNumberId(phoneE164)) ?? `${digits}@c.us`;
    // Proactively force the LID sync before the first send attempt (not just on
    // "No LID for user" catch) — some cold-contact sends fail *silently*
    // (ack stays -1, no exception) rather than throwing, because the LID was
    // never resolved server-side. See forceSyncLid() for background.
    await forceSyncLid(phoneE164);
    try {
      await client.sendPresenceAvailable();
    } catch (err) {
      console.error('[wa:humanized] sendPresenceAvailable failed:', err);
    }

    const attemptChatSend = async (): Promise<SendResult> => {
      const chat = await client.getChatById(chatId);
      try { await chat.sendSeen(); } catch { /* best-effort */ }
      // The "typing…" indicator expires after a few seconds on the recipient's
      // side, so to hold it for the full typingMs we re-assert the typing state
      // every ~2.5s (keep-alive) instead of firing it once.
      const deadline = Date.now() + typingMs;
      while (Date.now() < deadline) {
        try { await (chat as any).sendStateTyping(); } catch { /* best-effort */ }
        const remaining = deadline - Date.now();
        await new Promise((r) => setTimeout(r, Math.min(2500, Math.max(0, remaining))));
      }
      try { await (chat as any).clearState(); } catch { /* best-effort */ }
      const msg = await chat.sendMessage(body, { linkPreview: false } as any);
      return { messageId: (msg as any)?.id?._serialized ?? '' };
    };

    try {
      return await attemptChatSend();
    } catch (err) {
      const isLidError = /No LID for user/i.test((err as Error)?.message ?? '');
      console.error('[wa:humanized] chat path failed, falling back to sendMessage:', err);
      if (isLidError) {
        console.log(`[wa:humanized] "No LID" detected, forcing LID sync for ${phoneE164}`);
        await forceSyncLid(phoneE164);
        try {
          return await attemptChatSend();
        } catch (err2) {
          console.error('[wa:humanized] retry after LID sync also failed:', err2);
        }
      }
      const msg = await client.sendMessage(chatId, body, { linkPreview: false });
      return { messageId: (msg as any)?.id?._serialized ?? '' };
    }
  }

  /**
   * Poll a sent message's delivery ack until it reaches ACK_DEVICE (2 = delivered
   * to the recipient's device) or better, or the timeout elapses. Returns the
   * final ack seen (-1 error … 0 pending, 1 sent-to-server, 2 delivered, 3 read).
   * We use this to only announce a customer send in the worker group once WhatsApp
   * confirms it actually reached the device — a plain sendMessage() success only
   * means "handed to the library", which we learned can silently not deliver.
   */
  async function confirmDelivery(messageId: string, timeoutMs = 20_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let lastAck = 0;
    while (Date.now() < deadline) {
      try {
        const msg: any = await client.getMessageById(messageId);
        const ack = typeof msg?.ack === 'number' ? msg.ack : 0;
        lastAck = ack;
        if (ack >= 2 || ack === -1) return ack; // delivered/read, or hard error
      } catch {
        // message not resolvable yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return lastAck;
  }

  /**
   * Send a native WhatsApp poll as a 1:1 message. WhatsApp polls double as a
   * lightweight checklist: with allowMultipleAnswers the recipient can tick
   * every item. Routed through the same one-at-a-time send queue as sendDirect
   * (the account's anti-spam "new chat" restriction — see enqueueSendDirect).
   * Resolves the canonical @c.us/@lid id first, same as a humanized DM.
   */
  async function sendPollDirect(
    phoneE164: string,
    question: string,
    options: string[],
    allowMultipleAnswers = true,
  ): Promise<SendResult> {
    return enqueueSendDirect(async () => {
      const digits = phoneE164.replace(/^\+/, '');
      const chatId = (await resolveNumberId(phoneE164)) ?? `${digits}@c.us`;
      await forceSyncLid(phoneE164);
      const poll = new Poll(question, options, { allowMultipleAnswers, messageSecret: undefined });
      const msg = await client.sendMessage(chatId, poll);
      return { messageId: (msg as any)?.id?._serialized ?? '' };
    });
  }

  /** Send a native WhatsApp poll to a group chat. */
  async function sendPollToGroup(
    groupId: string,
    question: string,
    options: string[],
    allowMultipleAnswers = true,
  ): Promise<SendResult> {
    const poll = new Poll(question, options, { allowMultipleAnswers, messageSecret: undefined });
    const msg = await client.sendMessage(groupId, poll);
    return { messageId: (msg as any)?.id?._serialized ?? '' };
  }

  async function isGroupAdmin(groupId: string): Promise<boolean> {
    // client.getChatById(groupId) internally calls fetchMessages-adjacent
    // machinery that throws an opaque "r" on this session (same root cause as
    // the guide-photos forwarding bug). Read participants straight from the
    // in-memory Store instead, bypassing the broken wrapper entirely. Compare
    // against WhatsApp Web's own notion of "me" (window.Store.User / the
    // meUser wid) rather than client.info.wid — this account is LID-migrated,
    // so participants list ids are @lid while client.info.wid is @c.us and
    // never matches.
    try {
      const result = await client.pupPage!.evaluate(async (cid: string) => {
        const w = globalThis as any;
        const chat = await w.WWebJS.getChat(cid, { getAsModel: false });
        if (!chat) return { isAdmin: false, debug: 'no chat' };
        const coll = chat.groupMetadata?.participants;
        let list: any[] = [];
        if (coll?.getModelsArray) list = coll.getModelsArray();
        else if (coll?.serialize) list = coll.serialize();
        else if (Array.isArray(coll)) list = coll;
        else if (coll?._models) list = Object.values(coll._models);

        const meCandidates = [
          w.Store?.User?.getMaybeMeUser?.()?._serialized,
          w.Store?.User?.getMeUser?.()?._serialized,
          w.Store?.Conn?.wid?._serialized,
          w.Store?.Conn?.me?._serialized,
          w.Store?.Conn?.lid,
        ].filter(Boolean);

        const idOf = (p: any) => p?.id?._serialized ?? p?.id;
        let found = list.find((p: any) => meCandidates.includes(idOf(p)));
        // Fallback: every participant whose message we've sent (fromMe=true)
        // carries a `participant` field on the underlying event equal to our
        // own LID — but we don't have a message here, so instead just look
        // for the one admin whose id contains no phone-shaped digits at all
        // is NOT reliable either. Last resort: dump full Conn fields so we
        // can see the real shape live instead of guessing further.
        if (!found) {
          found = list.find((p: any) => Boolean(p?.isAdmin) && idOf(p)?.endsWith('@lid'));
        }
        const isAdmin = Boolean(found?.isAdmin);
        const connKeys = w.Store?.Conn ? Object.keys(w.Store.Conn) : [];
        return {
          isAdmin,
          debug: `listLen=${list.length} me=${JSON.stringify(meCandidates)} found=${JSON.stringify(found ?? null)} connKeys=${JSON.stringify(connKeys)}`,
        };
      }, groupId);
      console.log(`[wa:isGroupAdmin] ${groupId} -> ${JSON.stringify(result)}`);
      return Boolean((result as any)?.isAdmin);
    } catch (err) {
      console.error(`[wa:isGroupAdmin] evaluate failed for ${groupId}:`, (err as Error)?.message ?? err);
      return false;
    }
  }

  async function setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    // client.getChatById(groupId) throws the same opaque "r" as elsewhere on
    // this session. whatsapp-web.js's own GroupChat.setMessagesAdminsOnly
    // internally re-resolves the chat via WWebJS.getChat(..., {getAsModel:
    // false}) anyway (the working raw path) — so call that action directly
    // instead of going through getChatById first.
    const success = await client.pupPage!.evaluate(
      async (cid: string, announce: boolean) => {
        const w = globalThis as any;
        const chat = await w.WWebJS.getChat(cid, { getAsModel: false });
        if (!chat) return false;
        try {
          await w.require('WAWebSetPropertyGroupAction').setGroupProperty(
            chat,
            'announcement',
            announce ? 1 : 0,
          );
          return true;
        } catch {
          return false;
        }
      },
      groupId,
      adminsOnly,
    );
    if (!success) throw new Error(`setGroupMessagesAdminsOnly failed for ${groupId}`);
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
      id: msg.id?._serialized ?? '',
      body: msg.body || '',
      type: msg.type,
      timestamp: msg.timestamp,
      hasMedia: msg.hasMedia,
      fromMe: Boolean(msg.fromMe),
      ack: typeof msg.ack === 'number' ? msg.ack : null,
    }));
  }

  /**
   * Inspect the delivery ack of the most recent outbound (fromMe) messages to a
   * phone. Read-only diagnostic to answer "did our last DM to X actually arrive?"
   * ack: -1 error, 0 pending, 1 sent-to-server, 2 delivered, 3 read, 4 played.
   */
  async function lastOutboundAcks(phoneE164: string, limit = 5): Promise<
    Array<{ id: string; ack: number; ackName: string; timestamp: number; bodyPreview: string }>
  > {
    const chatId = (await resolveNumberId(phoneE164)) ?? `${phoneE164.replace(/^\+/, '')}@c.us`;
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 30 });
    const ackName = (a: number) =>
      ({ '-1': 'ERROR', '0': 'PENDING', '1': 'SENT', '2': 'DELIVERED', '3': 'READ', '4': 'PLAYED' } as Record<string, string>)[
        String(a)
      ] ?? String(a);
    return messages
      .filter((m: any) => m.fromMe)
      .sort((a: any, b: any) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((m: any) => ({
        id: m.id?._serialized ?? '',
        ack: typeof m.ack === 'number' ? m.ack : 0,
        ackName: ackName(typeof m.ack === 'number' ? m.ack : 0),
        timestamp: m.timestamp,
        bodyPreview: (m.body || '').slice(0, 40),
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
    sendPollDirect,
    sendPollToGroup,
    resolveNumberId,
    confirmDelivery,
    lastOutboundAcks,
    // Exposed publicly too — route through the same queue as sendDirect so a
    // direct caller can't bypass the one-at-a-time guarantee.
    sendDirectHumanized: (phoneE164: string, body: string, typingMs?: number) =>
      enqueueSendDirect(() => sendDirectHumanized(phoneE164, body, typingMs)),
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
    onRawGroupMessage: (h: (msg: any, groupId: string) => void) => rawGroupMessageHandlers.push(h),
    onRawDmMedia: (h: (msg: any, fromPhone: string) => void) => rawDmMediaHandlers.push(h),
    onGroupJoin: (h: GroupJoinHandler) => groupJoinHandlers.push(h),
    sendStickerFromDataUrl,
    downloadStickerBytes,
    debugLinkPreview,
    async sendMediaToGroup(chatId: string, media: { mimetype: string; data: string }, caption?: string): Promise<SendResult> {
      const MessageMedia = (pkg as any).MessageMedia;
      const mm = new MessageMedia(media.mimetype, media.data, 'photo.jpg');
      const msg: any = await client.sendMessage(chatId, mm, { caption: caption || undefined });
      return { messageId: msg?.id?._serialized ?? '' };
    },
    pupPageEval: (fn: (...args: any[]) => any, ...args: any[]) => client.pupPage!.evaluate(fn, ...args),
  };
}
