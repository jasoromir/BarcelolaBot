import type { WebhookDedup } from '../persistence/webhookDedup.js';
import type { AppLogger } from '../log/logger.js';
import type { AppConfig } from '../config/loader.js';
import type { DirectMessageSender } from '../messaging/directMessage.js';
import type { RemindersStore } from '../persistence/reminders.js';
import { parseBookingWebhook } from '../wix/webhookVerifier.js';
import { buildBookingConfirmation } from '../messaging/builder.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';

export type HandlerOutcome =
  | { outcome: 'sent' }
  | { outcome: 'duplicate' }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'skipped_allowlist' }
  | { outcome: 'skipped_paused' }
  | { outcome: 'deferred' }
  | { outcome: 'failed'; error: string };

export interface HandleInput {
  payload: unknown;
  config: AppConfig;
  dedup: WebhookDedup;
  sender: DirectMessageSender;
  logger: AppLogger;
  isPaused: () => boolean;
  reminders?: RemindersStore;
}

export async function handleBookingWebhook(input: HandleInput): Promise<HandlerOutcome> {
  const parsed = parseBookingWebhook(input.payload);
  if (!parsed.ok) {
    let rawSample = '';
    try {
      rawSample = JSON.stringify(input.payload).slice(0, 10000);
    } catch {
      rawSample = '<unserializable>';
    }
    input.logger.warn({
      source: 'webhook',
      eventType: 'booking_invalid',
      message: `${parsed.error}; raw=${rawSample}`,
    });
    return { outcome: 'invalid', error: parsed.error };
  }
  const event = parsed.event;

  if (!input.dedup.tryClaim(event.bookingId)) {
    input.logger.info({
      source: 'webhook',
      eventType: 'booking_duplicate',
      message: `duplicate booking ${event.bookingId}`,
    });
    return { outcome: 'duplicate' };
  }

  if (input.isPaused()) {
    input.dedup.complete(event.bookingId, 'skipped_paused');
    input.logger.info({
      source: 'webhook',
      eventType: 'booking_skipped_paused',
      message: `paused; not sending ${event.bookingId}`,
    });
    return { outcome: 'skipped_paused' };
  }

  const phone = normalizePhone(event.phone);
  if (!phone) {
    input.dedup.complete(event.bookingId, 'failed');
    input.logger.warn({
      source: 'webhook',
      eventType: 'booking_bad_phone',
      message: `cannot normalize phone: ${event.phone}`,
      metadata: { bookingId: event.bookingId },
    });
    return { outcome: 'failed', error: 'unparseable phone' };
  }

  const reminders = input.reminders;
  const remindersCfg = input.config.settings.reminders;
  const combineThresholdMs = remindersCfg.combine_threshold_hours * 3_600_000;
  const leadTimeMs = remindersCfg.lead_time_hours * 3_600_000;
  const testDelaySeconds = Number(process.env.REMINDER_TEST_DELAY_SECONDS ?? 0);
  const now = Date.now();
  const startAtMs = new Date(event.startAtIso).getTime();
  const msUntilStart = startAtMs - now;
  const combined = remindersCfg.enabled && msUntilStart <= combineThresholdMs;

  const body = buildBookingConfirmation({
    event,
    toursConfig: input.config.tours,
    templates: input.config.templates,
    combined,
    officialContactNumber: remindersCfg.official_contact_number,
  });

  const r = await input.sender.send({ phone, body, bookingId: event.bookingId });
  switch (r.outcome) {
    case 'sent':
      input.dedup.complete(event.bookingId, 'sent');
      if (reminders && remindersCfg.enabled) {
        // Enqueue a reminder row so we can accept replies and, for >=24h bookings,
        // fire a standalone reminder DM at T-24h.
        const sendAtIso = combined
          ? null
          : testDelaySeconds > 0
            ? new Date(now + testDelaySeconds * 1000).toISOString()
            : new Date(startAtMs - leadTimeMs).toISOString();
        reminders.upsert({
          bookingId: event.bookingId,
          phone,
          clientName: event.clientName,
          tourId: event.tourId || null,
          tourNameHe: event.tourTitle ?? null,
          startAtIso: event.startAtIso,
          participantCount: event.participantCount ?? 1,
          status: combined ? 'awaiting_reply' : 'awaiting_send',
          sendAtIso,
          sentAtIso: combined ? new Date().toISOString() : null,
          lastReplyTs: null,
        });
        input.logger.info({
          source: 'reminder',
          eventType: combined ? 'reminder_combined' : 'reminder_queued',
          message: combined
            ? `combined DM sent, awaiting reply for ${event.bookingId}`
            : `reminder queued for ${event.bookingId} at ${sendAtIso}`,
          metadata: { bookingId: event.bookingId, sendAtIso },
        });
      }
      input.logger.info({
        source: 'webhook',
        eventType: 'booking_sent',
        message: `confirmation sent for ${event.bookingId}`,
        metadata: { phone, bookingId: event.bookingId },
      });
      return { outcome: 'sent' };
    case 'skipped_allowlist':
      input.dedup.complete(event.bookingId, 'skipped_allowlist');
      input.logger.info({
        source: 'webhook',
        eventType: 'booking_skipped_allowlist',
        message: `${event.bookingId} not on allowlist`,
        metadata: { phone },
      });
      return { outcome: 'skipped_allowlist' };
    case 'skipped_paused':
      input.dedup.complete(event.bookingId, 'skipped_paused');
      return { outcome: 'skipped_paused' };
    case 'deferred':
      input.dedup.complete(event.bookingId, 'deferred');
      input.logger.info({
        source: 'webhook',
        eventType: 'booking_deferred',
        message: `${event.bookingId} queued; WA disconnected`,
      });
      return { outcome: 'deferred' };
    case 'failed':
      input.dedup.complete(event.bookingId, 'failed');
      input.logger.error({
        source: 'webhook',
        eventType: 'booking_send_failed',
        message: r.error,
        metadata: { bookingId: event.bookingId },
      });
      return { outcome: 'failed', error: r.error };
  }
}
