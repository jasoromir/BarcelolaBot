import type { AppLogger } from '../log/logger.js';
import type { ReminderRow, RemindersStore, ReplyAuditStore } from '../persistence/reminders.js';
import type { WhatsAppClient, IncomingDm } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import type { Classifier, ClassificationResult } from './classifier.js';
import { buildConfirmationAck, buildCancelAck, buildWorkerForward } from './templates.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';

export interface ReplyHandlerDeps {
  wa: WhatsAppClient;
  wix: WixClient;
  reminders: RemindersStore;
  audit: ReplyAuditStore;
  classifier: Classifier;
  logger: AppLogger;
  settings: {
    officialContactNumber: string;
    workerGroupId: string;
    confidenceThreshold: number;
  };
  config: {
    templates: TemplatesConfig;
    tours: ToursConfig;
  };
}

export function createReplyHandler(deps: ReplyHandlerDeps) {
  return async function handleIncoming(dm: IncomingDm): Promise<void> {
    const nowIso = new Date().toISOString();
    const phone = normalizePhone(dm.fromPhoneE164) ?? dm.fromPhoneE164;
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

    // confirm or update_count — both end up at "confirmed" state.
    const newCount = cls.participantCount ?? reminder.participantCount;
    deps.reminders.setStatus(reminder.bookingId, 'confirmed', {
      participantCount: newCount,
      lastReplyTs: nowIso,
    });
    const ack = buildConfirmationAck({
      reminder: { ...reminder, participantCount: newCount },
      templates: deps.config.templates,
      tours: deps.config.tours,
      officialContactNumber: deps.settings.officialContactNumber,
    });
    await safeSend(deps, reminder.phone, ack, 'confirmation_ack');
    deps.audit.record({
      ts: nowIso,
      phone,
      bookingId: reminder.bookingId,
      rawText: dm.body,
      intent: cls.intent,
      participantCount: cls.participantCount,
      confidence: cls.confidence,
      forwarded: false,
      notes: null,
    });
    deps.logger.info({
      source: 'reply',
      eventType: 'booking_confirmed',
      message: `confirmed ${reminder.bookingId} count=${newCount}`,
    });
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

  // Notify worker group with full context + wix status.
  const forward = buildWorkerForward({
    reminder,
    templates: deps.config.templates,
    message: `CANCEL: ${dm.body}\n(wix: ${wixResult.ok ? (wixResult.alreadyCancelled ? 'already_cancelled' : 'cancelled') : `FAILED ${wixResult.error ?? 'unknown'}`})`,
  });
  await safeSendGroup(deps, deps.settings.workerGroupId, forward, 'cancel_notice');

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
  const forward = buildWorkerForward({
    reminder,
    templates: deps.config.templates,
    message: dm.body,
  });
  await safeSendGroup(deps, deps.settings.workerGroupId, forward, `forward:${reason}`);
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
