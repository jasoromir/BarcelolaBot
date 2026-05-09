import type { AppLogger } from '../log/logger.js';
import type { ReminderRow, RemindersStore, ReplyAuditStore } from '../persistence/reminders.js';
import type { WorkerForwardsStore } from '../persistence/workerForwards.js';
import type { WhatsAppClient, IncomingDm } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import type { Classifier, ClassificationResult } from './classifier.js';
import type { Drafter } from './drafter.js';
import {
  buildConfirmationAck,
  buildCancelAck,
  buildWorkerForward,
  buildCancelNotice,
} from './templates.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';

export interface ReplyHandlerDeps {
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
  };
  config: {
    templates: TemplatesConfig;
    tours: ToursConfig;
  };
}

interface PendingReply {
  dms: IncomingDm[];
  timer: NodeJS.Timeout;
}

export function createReplyHandler(deps: ReplyHandlerDeps) {
  const debounceMs = Math.max(0, (deps.settings.debounceSeconds ?? 0) * 1000);
  const buffers = new Map<string, PendingReply>();

  async function flush(phone: string): Promise<void> {
    const pending = buffers.get(phone);
    if (!pending) return;
    buffers.delete(phone);
    // Merge all buffered bodies with a newline separator so Gemini sees the
    // full context but keeps natural message boundaries.
    const merged: IncomingDm = {
      messageId: pending.dms[pending.dms.length - 1]!.messageId,
      fromPhoneE164: pending.dms[0]!.fromPhoneE164,
      body: pending.dms.map((d) => d.body).join('\n'),
      timestamp: pending.dms[pending.dms.length - 1]!.timestamp,
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

    if (!reminder) {
      // No active reminder: this customer has no upcoming tour. Ignore silently;
      // the group-worker forwarding only applies to active bookings (per spec).
      deps.audit.record({
        ts: nowIso,
        phone,
        bookingId: null,
        rawText: dm.body,
        intent: null,
        participantCount: null,
        confidence: null,
        forwarded: false,
        notes: 'no_active_reminder',
      });
      deps.logger.info({
        source: 'reply',
        eventType: 'no_active_reminder',
        message: `incoming DM from ${phone} with no active reminder`,
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

    // Push the count change to Wix so the guide's calendar reflects reality.
    // We sync on every count change (first confirm or subsequent update).
    let wixUpdateNote: string | null = null;
    if (countChanged) {
      try {
        const upd = await deps.wix.updateNumberOfParticipants({
          bookingId: reminder.bookingId,
          totalParticipants: newCount,
        });
        if (!upd.ok) {
          wixUpdateNote = `wix_update_failed: ${upd.error ?? 'unknown'}`;
          deps.logger.error({
            source: 'reply',
            eventType: 'wix_update_participants_failed',
            message: wixUpdateNote,
            metadata: { bookingId: reminder.bookingId },
          });
        } else {
          deps.logger.info({
            source: 'reply',
            eventType: 'wix_update_participants',
            message: `wix count -> ${newCount}${upd.unchanged ? ' (unchanged)' : ''}`,
            metadata: { bookingId: reminder.bookingId },
          });
        }
      } catch (err) {
        wixUpdateNote = `wix_update_failed: ${(err as Error).message}`;
        deps.logger.error({
          source: 'reply',
          eventType: 'wix_update_participants_failed',
          message: wixUpdateNote,
          metadata: { bookingId: reminder.bookingId },
        });
      }
    }

    deps.reminders.setStatus(reminder.bookingId, 'confirmed', {
      participantCount: newCount,
      lastReplyTs: nowIso,
    });
    // Shorter "updated" ack when the customer is changing a count they
    // already confirmed. First confirm always gets the full ack with
    // meeting point + map.
    const ack = buildConfirmationAck({
      reminder: { ...reminder, participantCount: newCount },
      templates: deps.config.templates,
      tours: deps.config.tours,
      officialContactNumber: deps.settings.officialContactNumber,
      defaultGoogleMapsUrl: deps.settings.defaultGoogleMapsUrl,
      isUpdate: wasAlreadyConfirmed,
    });
    await safeSend(deps, reminder.phone, ack, wasAlreadyConfirmed ? 'confirmation_update_ack' : 'confirmation_ack');
    deps.audit.record({
      ts: nowIso,
      phone,
      bookingId: reminder.bookingId,
      rawText: dm.body,
      intent: cls.intent,
      participantCount: cls.participantCount,
      confidence: cls.confidence,
      forwarded: false,
      notes: wixUpdateNote ?? (wasAlreadyConfirmed ? 'count_changed' : null),
    });
    deps.logger.info({
      source: 'reply',
      eventType: wasAlreadyConfirmed ? 'booking_count_updated' : 'booking_confirmed',
      message: `${wasAlreadyConfirmed ? 'updated' : 'confirmed'} ${reminder.bookingId} count=${newCount}`,
    });
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
  const reason = `Customer cancelled via WhatsApp at ${nowIso}. Their message: ${dm.body}`;
  let wixResult;
  try {
    wixResult = await deps.wix.cancelBooking({ bookingId: reminder.bookingId, reason });
  } catch (err) {
    wixResult = { ok: false, error: (err as Error).message };
  }
  deps.reminders.setStatus(reminder.bookingId, 'cancelled', { lastReplyTs: nowIso });

  const ack = buildCancelAck({
    reminder,
    templates: deps.config.templates,
    officialContactNumber: deps.settings.officialContactNumber,
  });
  await safeSend(deps, reminder.phone, ack, 'cancel_ack');

  // Notify worker group with the dedicated cancel-notice template so it
  // doesn't read as an unrelated off-topic forward.
  const wixStatus = wixResult.ok
    ? wixResult.alreadyCancelled
      ? 'כבר בוטל קודם'
      : 'בוטל בהצלחה ✅'
    : `נכשל — ${wixResult.error ?? 'unknown'}`;
  const notice = buildCancelNotice({
    reminder,
    templates: deps.config.templates,
    customerMessage: dm.body,
    wixStatus,
  });
  await safeSendGroup(deps, deps.settings.workerGroupId, notice, 'cancel_notice');

  deps.logger.info({
    source: 'reply',
    eventType: 'booking_cancelled',
    message: `cancelled ${reminder.bookingId} wix=${wixResult.ok}`,
    metadata: { wixError: wixResult.error },
  });
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
    templates: deps.config.templates,
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

async function safeSendGroup(
  deps: ReplyHandlerDeps,
  groupId: string,
  body: string,
  kind: string,
): Promise<void> {
  try {
    await deps.wa.sendToGroup(groupId, body);
  } catch (err) {
    deps.logger.error({
      source: 'reply',
      eventType: 'worker_notify_failed',
      message: `${kind}: ${(err as Error).message}`,
    });
  }
}
