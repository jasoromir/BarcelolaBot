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
  const testDelaySeconds = Number(process.env.REMINDER_TEST_DELAY_SECONDS ?? 0);
  const now = Date.now();
  const startAtMs = new Date(event.startAtIso).getTime();
  const tz = input.config.settings.timezone;

  // Compute when the reminder should fire: 10:00 AM (reminder_send_time) on
  // the calendar day before the tour, in the configured timezone. Falls back
  // to tourStart - lead_time_hours if reminder_send_time is not set.
  function reminderSendAtMs(): number {
    const sendTime = remindersCfg.reminder_send_time;
    if (!sendTime) return startAtMs - remindersCfg.lead_time_hours * 3_600_000;
    // Get the tour date (YYYY-MM-DD) in the local timezone.
    const tourDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(startAtMs));
    const [tourY, tourM, tourD] = tourDateStr.split('-').map(Number);
    // Day before = subtract 1 from the day (Intl handles month rollover for us
    // by constructing from a Date).
    const dayBefore = new Date(Date.UTC(tourY!, tourM! - 1, tourD! - 1, 12, 0, 0));
    const dayBeforeStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(dayBefore);
    // Build "YYYY-MM-DDTHH:MM:00" in local time, then parse as UTC offset via
    // Intl so we get the correct absolute instant regardless of DST.
    const [hh, mm] = sendTime.split(':').map(Number);
    // Find the UTC instant that corresponds to sendTime on dayBeforeStr in tz.
    // Strategy: try candidate UTC offsets by bisecting on what the local time
    // would be at that instant. Simpler: use Date with a known-offset approach.
    // We approximate by formatting a probe instant and adjusting.
    const probeLocal = new Date(`${dayBeforeStr}T${sendTime}:00`); // naive local (wrong tz)
    // Adjust for the difference between the probe's local interpretation and tz.
    const fmtProbe = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(probeLocal);
    const pDate = fmtProbe.find((p) => p.type === 'year')?.value + '-' +
      fmtProbe.find((p) => p.type === 'month')?.value + '-' +
      fmtProbe.find((p) => p.type === 'day')?.value;
    const pHH = Number(fmtProbe.find((p) => p.type === 'hour')?.value ?? 0);
    const pMM = Number(fmtProbe.find((p) => p.type === 'minute')?.value ?? 0);
    const diffMs =
      (pDate === dayBeforeStr ? 0 : pDate < dayBeforeStr ? 86400000 : -86400000) +
      ((pHH - hh!) * 60 + (pMM - mm!)) * 60000;
    return probeLocal.getTime() - diffMs;
  }

  const sendAtMs = reminderSendAtMs();
  // "combined" = the booking arrived after the reminder would already have fired,
  // so we fold the reminder ask into the confirmation DM right now.
  const combined = remindersCfg.enabled && now >= sendAtMs;

  const body = buildBookingConfirmation({
    event,
    toursConfig: input.config.tours,
    templates: input.config.templates,
    combined,
    officialContactNumber: remindersCfg.official_contact_number,
    defaultGoogleMapsUrl: remindersCfg.default_google_maps_url,
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
            : new Date(sendAtMs).toISOString();
        reminders.upsert({
          bookingId: event.bookingId,
          orderIdEcom: event.orderIdEcom ?? null,
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
