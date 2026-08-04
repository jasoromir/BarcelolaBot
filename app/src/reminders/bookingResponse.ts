import type { AppLogger } from '../log/logger.js';
import type { ReminderRow, RemindersStore } from '../persistence/reminders.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import {
  buildCancelAck,
  buildCancelNotice,
  buildClientResponseNotice,
  buildConfirmationAck,
} from './templates.js';

/**
 * The confirm / cancel side effects, shared by every channel a customer can
 * answer the day-before reminder through:
 *   - a text or emoji reply  → reminders/replyHandler.ts (LLM classifier)
 *   - a reaction on the reminder (👍) → reminders/reactionHandler.ts
 *
 * Keeping them here means a reaction-confirm and a text-confirm produce exactly
 * the same Wix update, DB status, customer ack, and manager notification —
 * there is no second, subtly-different copy of this logic to drift.
 */

/** How the customer's answer reached us. Rendered in the manager notification. */
export type ResponseChannel = 'text' | 'reaction';

export interface BookingResponseDeps {
  wa: WhatsAppClient;
  wix: WixClient;
  reminders: RemindersStore;
  logger: AppLogger;
  settings: {
    officialContactNumber: string;
    workerGroupId: string;
    defaultGoogleMapsUrl?: string;
    /** Manager DMed on every confirm/cancel. Undefined disables the notification. */
    clientResponseNotifyPhone?: string;
  };
  /** Live getter, not a snapshot — so a config reload is picked up here too. */
  config: () => { templates: TemplatesConfig; tours: ToursConfig };
}

/**
 * DM the manager that a customer just confirmed or cancelled. Best-effort: a
 * failure here is logged but never propagated, because the customer-facing ack
 * and the Wix/DB updates have already happened and must not be rolled back or
 * retried on account of a notification.
 */
export async function notifyClientResponse(
  deps: BookingResponseDeps,
  input: {
    reminder: ReminderRow;
    outcome: 'confirm' | 'cancel';
    via: ResponseChannel;
    rawText: string;
  },
): Promise<void> {
  const phone = deps.settings.clientResponseNotifyPhone;
  if (!phone) return;
  const cfg = deps.config();
  const body = buildClientResponseNotice({
    reminder: input.reminder,
    templates: cfg.templates,
    tours: cfg.tours,
    outcome: input.outcome,
    via: input.via,
    rawText: input.rawText,
  });
  try {
    await deps.wa.sendDirect(phone, body);
    deps.logger.info({
      source: 'reply',
      eventType: 'client_response_notified',
      message: `notified ${phone} of ${input.outcome} (via ${input.via}) for ${input.reminder.bookingId}`,
      metadata: { bookingId: input.reminder.bookingId },
    });
  } catch (err) {
    deps.logger.error({
      source: 'reply',
      eventType: 'client_response_notify_failed',
      message: (err as Error).message,
      metadata: { bookingId: input.reminder.bookingId },
    });
  }
}

export interface ApplyConfirmInput {
  reminder: ReminderRow;
  /** Participant count after this reply. Pass the existing count when unchanged. */
  newCount: number;
  via: ResponseChannel;
  /** The customer's message, or the emoji when via === 'reaction'. */
  rawText: string;
  nowIso: string;
}

export interface ApplyConfirmResult {
  countChanged: boolean;
  wasAlreadyConfirmed: boolean;
  /** Set when pushing the new count to Wix failed; surfaced in the audit row. */
  wixUpdateNote: string | null;
}

/**
 * Mark a booking confirmed: push any count change to Wix, update our row, ack
 * the customer, and notify the manager.
 */
export async function applyConfirm(
  deps: BookingResponseDeps,
  input: ApplyConfirmInput,
): Promise<ApplyConfirmResult> {
  const { reminder, newCount, nowIso } = input;
  const countChanged = newCount !== reminder.participantCount;
  const wasAlreadyConfirmed = reminder.status === 'confirmed';

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

  const cfg = deps.config();
  // Shorter "updated" ack when the customer is changing a count they already
  // confirmed. First confirm always gets the full ack with meeting point + map.
  const ack = buildConfirmationAck({
    reminder: { ...reminder, participantCount: newCount },
    templates: cfg.templates,
    tours: cfg.tours,
    officialContactNumber: deps.settings.officialContactNumber,
    defaultGoogleMapsUrl: deps.settings.defaultGoogleMapsUrl,
    isUpdate: wasAlreadyConfirmed,
  });
  await safeSendDirect(
    deps,
    reminder.phone,
    ack,
    wasAlreadyConfirmed ? 'confirmation_update_ack' : 'confirmation_ack',
  );

  await notifyClientResponse(deps, {
    reminder: { ...reminder, participantCount: newCount },
    outcome: 'confirm',
    via: input.via,
    rawText: input.rawText,
  });

  deps.logger.info({
    source: 'reply',
    eventType: wasAlreadyConfirmed ? 'booking_count_updated' : 'booking_confirmed',
    message: `${wasAlreadyConfirmed ? 'updated' : 'confirmed'} ${reminder.bookingId} count=${newCount} via=${input.via}`,
  });

  return { countChanged, wasAlreadyConfirmed, wixUpdateNote };
}

export interface ApplyCancelInput {
  reminder: ReminderRow;
  via: ResponseChannel;
  /** The customer's message, or the emoji when via === 'reaction'. */
  rawText: string;
  nowIso: string;
}

/**
 * Cancel a booking: cancel it in Wix, update our row, ack the customer, post a
 * cancel notice to the worker group, and notify the manager.
 */
export async function applyCancel(
  deps: BookingResponseDeps,
  input: ApplyCancelInput,
): Promise<void> {
  const { reminder, nowIso } = input;
  const via = input.via === 'reaction' ? `reacted with ${input.rawText}` : `Their message: ${input.rawText}`;
  const reason = `Customer cancelled via WhatsApp at ${nowIso}. ${via}`;
  let wixResult: { ok: boolean; error?: string; alreadyCancelled?: boolean };
  try {
    wixResult = await deps.wix.cancelBooking({ bookingId: reminder.bookingId, reason });
  } catch (err) {
    wixResult = { ok: false, error: (err as Error).message };
  }
  deps.reminders.setStatus(reminder.bookingId, 'cancelled', { lastReplyTs: nowIso });

  const cfg = deps.config();
  const ack = buildCancelAck({
    reminder,
    templates: cfg.templates,
    officialContactNumber: deps.settings.officialContactNumber,
  });
  await safeSendDirect(deps, reminder.phone, ack, 'cancel_ack');

  // Notify worker group with the dedicated cancel-notice template so it
  // doesn't read as an unrelated off-topic forward.
  const wixStatus = wixResult.ok
    ? wixResult.alreadyCancelled
      ? 'כבר בוטל קודם'
      : 'בוטל בהצלחה ✅'
    : `נכשל — ${wixResult.error ?? 'unknown'}`;
  const notice = buildCancelNotice({
    reminder,
    templates: cfg.templates,
    customerMessage:
      input.via === 'reaction' ? `(תגובה בלבד) ${input.rawText}` : input.rawText,
    wixStatus,
  });
  try {
    await deps.wa.sendToGroup(deps.settings.workerGroupId, notice);
  } catch (err) {
    deps.logger.error({
      source: 'reply',
      eventType: 'worker_notify_failed',
      message: `cancel_notice: ${(err as Error).message}`,
    });
  }

  await notifyClientResponse(deps, {
    reminder,
    outcome: 'cancel',
    via: input.via,
    rawText: input.rawText,
  });

  deps.logger.info({
    source: 'reply',
    eventType: 'booking_cancelled',
    message: `cancelled ${reminder.bookingId} wix=${wixResult.ok} via=${input.via}`,
    metadata: { wixError: wixResult.error },
  });
}

async function safeSendDirect(
  deps: BookingResponseDeps,
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
