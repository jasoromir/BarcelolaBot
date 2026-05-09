import type { WebhookDedup } from '../persistence/webhookDedup.js';
import type { AppLogger } from '../log/logger.js';
import type { AppConfig } from '../config/loader.js';
import type { DirectMessageSender } from '../messaging/directMessage.js';
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

  const body = buildBookingConfirmation({
    event,
    toursConfig: input.config.tours,
    templates: input.config.templates,
  });

  const r = await input.sender.send({ phone, body, bookingId: event.bookingId });
  switch (r.outcome) {
    case 'sent':
      input.dedup.complete(event.bookingId, 'sent');
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
