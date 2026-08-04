import type { AppLogger } from '../log/logger.js';
import type { ReminderRow, RemindersStore, ReplyAuditStore } from '../persistence/reminders.js';
import type { WorkerForwardsStore } from '../persistence/workerForwards.js';
import type { WhatsAppClient, IncomingDm } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import type { Classifier, ClassificationResult } from './classifier.js';
import type { Drafter } from './drafter.js';
import { buildWorkerForward } from './templates.js';
import { applyCancel, applyConfirm, type BookingResponseDeps } from './bookingResponse.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';

/** Extends BookingResponseDeps so `deps` can be handed straight to
 *  applyConfirm / applyCancel — the shared confirm/cancel core in
 *  reminders/bookingResponse.ts, also used by the reaction handler. */
export interface ReplyHandlerDeps extends BookingResponseDeps {
  wa: WhatsAppClient;
  wix: WixClient;
  reminders: RemindersStore;
  audit: ReplyAuditStore;
  workerForwards: WorkerForwardsStore;
  classifier: Classifier;
  drafter: Drafter | null;
  logger: AppLogger;
  settings: {
    officialContactNumber: string;
    workerGroupId: string;
    confidenceThreshold: number;
    defaultGoogleMapsUrl?: string;
    /** Quiet window after each DM before we classify. 0 = fire immediately. */
    debounceSeconds?: number;
    /** Manager DMed on every confirm/cancel. Undefined disables the notification. */
    clientResponseNotifyPhone?: string;
  };
  /** Getter, not a static snapshot — so a config reload is picked up on the
   *  next incoming DM instead of staying frozen at whatever was loaded at startup. */
  config: () => {
    templates: TemplatesConfig;
    tours: ToursConfig;
  };
}

interface PendingReply {
  dms: IncomingDm[];
  timer: NodeJS.Timeout;
}

/** Throttle window for the "unmanaged number" auto-reply: after we send it to a
 *  phone, we won't send it again for this long, so someone messaging non-stop
 *  from an unmanaged number doesn't get spammed with identical replies. */
const UNMANAGED_REPLY_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

export function createReplyHandler(deps: ReplyHandlerDeps) {
  const debounceMs = Math.max(0, (deps.settings.debounceSeconds ?? 0) * 1000);
  const buffers = new Map<string, PendingReply>();
  // phone -> epoch ms of the last unmanaged-number auto-reply we sent. In-memory
  // only: a restart resets it (worst case one extra reply after a redeploy).
  const lastUnmanagedReplyAt = new Map<string, number>();

  async function flush(phone: string): Promise<void> {
    const pending = buffers.get(phone);
    if (!pending) return;
    buffers.delete(phone);
    // Merge all buffered bodies with a newline separator so Gemini sees the
    // full context but keeps natural message boundaries.
    const merged: IncomingDm = {
      messageId: pending.dms[pending.dms.length - 1]!.messageId,
      fromPhoneE164: pending.dms[0]!.fromPhoneE164,
      body: pending.dms.map((d) => d.body).filter(Boolean).join('\n'),
      timestamp: pending.dms[pending.dms.length - 1]!.timestamp,
      // Preserve non-text signal: if any buffered message was a voice note /
      // media / non-chat, the merged message is treated as non-text so it's
      // forwarded to staff (the LLM can't read audio/images).
      type: pending.dms.some((d) => d.type && d.type !== 'chat') ? 'media' : 'chat',
      hasMedia: pending.dms.some((d) => d.hasMedia),
    };
    if (pending.dms.length > 1) {
      deps.logger.info({
        source: 'reply',
        eventType: 'debounce_flush_merged',
        message: `merged ${pending.dms.length} messages from ${phone}`,
      });
    }
    await processReply(merged);
  }

  function enqueue(dm: IncomingDm): void {
    const phone = normalizePhone(dm.fromPhoneE164) ?? dm.fromPhoneE164;
    const existing = buffers.get(phone);
    if (existing) {
      clearTimeout(existing.timer);
      existing.dms.push(dm);
      existing.timer = setTimeout(() => {
        flush(phone).catch((err) =>
          deps.logger.error({
            source: 'reply',
            eventType: 'flush_failed',
            message: (err as Error).message,
          }),
        );
      }, debounceMs);
    } else {
      const timer = setTimeout(() => {
        flush(phone).catch((err) =>
          deps.logger.error({
            source: 'reply',
            eventType: 'flush_failed',
            message: (err as Error).message,
          }),
        );
      }, debounceMs);
      buffers.set(phone, { dms: [dm], timer });
    }
  }

  async function processReply(dm: IncomingDm): Promise<void> {
    const nowIso = new Date().toISOString();
    const phone = normalizePhone(dm.fromPhoneE164) ?? dm.fromPhoneE164;
    deps.logger.info({
      source: 'reply',
      eventType: 'reply_received',
      message: `incoming from ${phone}: ${dm.body.slice(0, 200)}`,
    });
    const reminder = deps.reminders.findActiveForReply(phone, nowIso);

    // Non-text messages (voice notes, images, video, stickers, documents) can't
    // be understood by the text LLM. Rather than drop them (which silently
    // ignored real customers), always forward them to the worker group so staff
    // can listen/look and respond. If the sender has no active booking we also
    // send the unmanaged-number auto-reply (once per hour), same as for text.
    const isNonText = (dm.hasMedia === true) || (dm.type !== undefined && dm.type !== 'chat') || dm.body.length === 0;
    if (isNonText) {
      await forwardMediaToWorker(deps, phone, reminder, dm);
      let repliedUnmanaged = false;
      if (!reminder) {
        const lastReply = lastUnmanagedReplyAt.get(phone);
        const throttled =
          lastReply !== undefined && Date.now() - lastReply < UNMANAGED_REPLY_THROTTLE_MS;
        if (!throttled) {
          await safeSend(deps, phone, deps.config().templates.unmanaged_number_reply, 'unmanaged_number_reply');
          lastUnmanagedReplyAt.set(phone, Date.now());
          repliedUnmanaged = true;
        }
      }
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder?.bookingId ?? null,
        rawText: dm.body || `[${dm.type ?? 'media'} message]`,
        intent: null,
        participantCount: null,
        confidence: null,
        forwarded: true,
        notes: `non_text_${dm.type ?? 'media'}${repliedUnmanaged ? '_unmanaged_replied' : ''}`,
      });
      deps.logger.info({
        source: 'reply',
        eventType: 'non_text_forwarded',
        message: `forwarded non-text (${dm.type ?? 'media'}) from ${phone} to worker group${reminder ? '' : ' (no booking; auto-replied)'}`,
      });
      return;
    }

    if (!reminder) {
      // No active reminder: this number isn't managed by the bot (no upcoming
      // tour booked). Reply in Hebrew pointing them to the WhatsApp groups
      // instead of running the classifier / worker-forward flow.
      //
      // Throttle: only send this auto-reply once per hour per phone, so someone
      // messaging non-stop from an unmanaged number isn't spammed with identical
      // replies. We still record every message in the audit log.
      const lastReply = lastUnmanagedReplyAt.get(phone);
      const throttled =
        lastReply !== undefined && Date.now() - lastReply < UNMANAGED_REPLY_THROTTLE_MS;
      if (!throttled) {
        await safeSend(
          deps,
          phone,
          deps.config().templates.unmanaged_number_reply,
          'unmanaged_number_reply',
        );
        lastUnmanagedReplyAt.set(phone, Date.now());
      }
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: null,
        rawText: dm.body,
        intent: null,
        participantCount: null,
        confidence: null,
        forwarded: false,
        notes: throttled ? 'no_active_reminder_throttled' : 'no_active_reminder_replied',
      });
      deps.logger.info({
        source: 'reply',
        eventType: 'no_active_reminder',
        message: throttled
          ? `incoming DM from ${phone} with no active reminder; unmanaged-number reply throttled`
          : `incoming DM from ${phone} with no active reminder; sent unmanaged-number reply`,
      });
      return;
    }

    let cls: ClassificationResult;
    try {
      cls = await deps.classifier.classify(dm.body, {
        currentCount: reminder.participantCount,
      });
    } catch (err) {
      deps.logger.error({
        source: 'reply',
        eventType: 'classifier_failed',
        message: (err as Error).message,
        metadata: { bookingId: reminder.bookingId },
      });
      // Fail-open: forward to worker so nothing is lost.
      await forwardToWorker(deps, reminder, dm, 'classifier_failed');
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText: dm.body,
        intent: null,
        participantCount: null,
        confidence: null,
        forwarded: true,
        notes: 'classifier_failed',
      });
      return;
    }

    const lowConfidence = cls.confidence < deps.settings.confidenceThreshold;
    const treatAsOther = cls.intent === 'other' || lowConfidence;

    if (treatAsOther) {
      await forwardToWorker(deps, reminder, dm, lowConfidence ? 'low_confidence' : 'other_intent');
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText: dm.body,
        intent: cls.intent,
        participantCount: cls.participantCount,
        confidence: cls.confidence,
        forwarded: true,
        notes: lowConfidence ? `low_confidence=${cls.confidence}` : null,
      });
      return;
    }

    if (cls.intent === 'cancel') {
      if (reminder.status === 'cancelled') {
        // Already cancelled — silently record and exit (no double-cancel, no
        // duplicate ack). A human can pick up any follow-up from reply_audit.
        deps.audit.record({
          ts: nowIso,
          phone,
          bookingId: reminder.bookingId,
          rawText: dm.body,
          intent: 'cancel',
          participantCount: null,
          confidence: cls.confidence,
          forwarded: false,
          notes: 'already_cancelled',
        });
        deps.logger.info({
          source: 'reply',
          eventType: 'cancel_ignored_already_cancelled',
          message: `duplicate cancel for ${reminder.bookingId}`,
        });
        return;
      }
      await handleCancel(deps, reminder, dm, nowIso);
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText: dm.body,
        intent: 'cancel',
        participantCount: null,
        confidence: cls.confidence,
        forwarded: false,
        notes: null,
      });
      return;
    }

    // confirm or update_count
    const newCount = cls.participantCount ?? reminder.participantCount;
    const countChanged = newCount !== reminder.participantCount;
    const wasAlreadyConfirmed = reminder.status === 'confirmed';

    // Idempotency: if already confirmed with the same count and no count change
    // was requested, don't re-send the ack — just log and exit.
    if (wasAlreadyConfirmed && !countChanged) {
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: reminder.bookingId,
        rawText: dm.body,
        intent: cls.intent,
        participantCount: cls.participantCount,
        confidence: cls.confidence,
        forwarded: false,
        notes: 'already_confirmed_same_count',
      });
      deps.logger.info({
        source: 'reply',
        eventType: 'confirm_ignored_duplicate',
        message: `duplicate confirm for ${reminder.bookingId}`,
      });
      return;
    }

    const { wixUpdateNote } = await applyConfirm(deps, {
      reminder,
      newCount,
      via: 'text',
      rawText: dm.body,
      nowIso,
    });

    // If the customer also asked a question alongside their confirmation,
    // forward to the worker group so it doesn't get silently dropped.
    // Detection: message contains "?" or common Hebrew question words.
    const hasQuestion =
      dm.body.includes('?') ||
      /איפה|מתי|מה |איך|כמה|מי |האם|האם|אפשר/.test(dm.body);
    if (hasQuestion) {
      await forwardToWorker(deps, reminder, dm, 'confirm_with_question');
      deps.logger.info({
        source: 'reply',
        eventType: 'confirm_with_question_forwarded',
        message: `confirmed ${reminder.bookingId} and forwarded question to worker`,
      });
    }

    deps.audit.record({
      ts: nowIso,
      phone,
      bookingId: reminder.bookingId,
      rawText: dm.body,
      intent: cls.intent,
      participantCount: cls.participantCount,
      confidence: cls.confidence,
      forwarded: hasQuestion,
      notes: wixUpdateNote ?? (hasQuestion ? 'confirm_with_question' : null) ?? (wasAlreadyConfirmed ? 'count_changed' : null),
    });
    // The booking_confirmed / booking_count_updated log line is emitted by
    // applyConfirm, so every channel logs it identically.
  }

  // Public entry point. When debounceMs>0 we buffer per-phone and flush after
  // the quiet window so rapid-fire messages are consolidated into one classify
  // call. debounceMs=0 keeps the legacy immediate path for tests.
  return async function handleIncoming(dm: IncomingDm): Promise<void> {
    if (debounceMs === 0) {
      await processReply(dm);
      return;
    }
    enqueue(dm);
  };
}

async function handleCancel(
  deps: ReplyHandlerDeps,
  reminder: ReminderRow,
  dm: IncomingDm,
  nowIso: string,
): Promise<void> {
  await applyCancel(deps, { reminder, via: 'text', rawText: dm.body, nowIso });
}

// Forward a non-text customer message (voice note / image / video / etc.) to the
// worker group so staff can handle it — the text LLM can't read media. Posts a
// Hebrew heads-up with the customer's details, then forwards the actual media
// message so staff can listen/view it directly.
async function forwardMediaToWorker(
  deps: ReplyHandlerDeps,
  phone: string,
  reminder: ReminderRow | null,
  dm: IncomingDm,
): Promise<void> {
  const typeLabelHe: Record<string, string> = {
    ptt: 'הודעה קולית 🎤',
    audio: 'הודעת אודיו 🎵',
    image: 'תמונה 🖼️',
    video: 'וידאו 🎥',
    sticker: 'סטיקר',
    document: 'קובץ 📎',
    media: 'הודעת מדיה',
  };
  const kind = typeLabelHe[dm.type ?? 'media'] ?? `הודעה (${dm.type ?? 'media'})`;
  const clientName = reminder?.clientName ?? 'לקוח/ה';
  const bookingLine = reminder
    ? `🎯 *סיור:* ${reminder.tourNameHe ?? '(לא ידוע)'}`
    : '⚠️ *אין הזמנה פעילה למספר זה*';
  const notice =
    `📩 *התקבלה ${kind} מלקוח* — לא ניתן לקרוא אוטומטית, נא לטפל ידנית\n\n` +
    `👤 *לקוח:* ${clientName}\n` +
    `📞 ${phone}\n` +
    `${bookingLine}` +
    (dm.body ? `\n\n*טקסט מצורף:*\n_${dm.body}_` : '');
  try {
    await deps.wa.sendToGroup(deps.settings.workerGroupId, notice);
    // Best-effort: forward the actual media message so staff can open it.
    if (dm.messageId && dm.hasMedia) {
      try {
        await deps.wa.forwardMessage(dm.messageId, deps.settings.workerGroupId);
      } catch (err) {
        deps.logger.warn({
          source: 'reply',
          eventType: 'media_forward_failed',
          message: `could not forward media ${dm.messageId}: ${(err as Error).message}`,
        });
      }
    }
  } catch (err) {
    deps.logger.error({
      source: 'reply',
      eventType: 'worker_notify_failed',
      message: `media forward notice: ${(err as Error).message}`,
    });
  }
}

async function forwardToWorker(
  deps: ReplyHandlerDeps,
  reminder: ReminderRow,
  dm: IncomingDm,
  reason: string,
): Promise<void> {
  // Draft a suggested reply in the background. If drafting fails we still
  // forward the message (template shows a "no suggestion" placeholder).
  let suggestedReply: string | null = null;
  if (deps.drafter) {
    try {
      const fmt = (iso: string) => {
        const d = new Date(iso);
        const date = d.toLocaleDateString('en-GB', {
          timeZone: 'Europe/Madrid',
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
        });
        const time = d.toLocaleTimeString('en-GB', {
          timeZone: 'Europe/Madrid',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        return { date, time };
      };
      const { date, time } = fmt(reminder.startAtIso);
      suggestedReply = await deps.drafter.draft({
        clientName: reminder.clientName ?? 'Guest',
        tourNameHe: reminder.tourNameHe ?? '(unknown)',
        dateDisplay: date,
        timeDisplay: time,
        customerMessage: dm.body,
      });
    } catch (err) {
      deps.logger.warn({
        source: 'reply',
        eventType: 'drafter_failed',
        message: (err as Error).message,
      });
    }
  }

  const forward = buildWorkerForward({
    reminder,
    templates: deps.config().templates,
    message: dm.body,
    suggestedReply,
  });
  let sendResult;
  try {
    sendResult = await deps.wa.sendToGroup(deps.settings.workerGroupId, forward);
  } catch (err) {
    deps.logger.error({
      source: 'reply',
      eventType: 'worker_notify_failed',
      message: `forward:${reason}: ${(err as Error).message}`,
    });
    return;
  }
  if (suggestedReply && sendResult?.messageId) {
    deps.workerForwards.insert({
      groupMessageId: sendResult.messageId,
      bookingId: reminder.bookingId,
      phone: reminder.phone,
      clientName: reminder.clientName,
      customerMessage: dm.body,
      suggestedReply,
    });
  }
}

async function safeSend(
  deps: ReplyHandlerDeps,
  phone: string,
  body: string,
  kind: string,
): Promise<void> {
  try {
    await deps.wa.sendDirect(phone, body);
  } catch (err) {
    deps.logger.error({
      source: 'reply',
      eventType: 'ack_send_failed',
      message: `${kind}: ${(err as Error).message}`,
    });
  }
}

