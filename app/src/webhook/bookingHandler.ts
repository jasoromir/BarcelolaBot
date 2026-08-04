import type { WebhookDedup } from '../persistence/webhookDedup.js';
import type { AppLogger } from '../log/logger.js';
import type { AppConfig } from '../config/loader.js';
import type { DirectMessageSender } from '../messaging/directMessage.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { RemindersStore } from '../persistence/reminders.js';
import { parseBookingWebhook } from '../wix/webhookVerifier.js';
import { buildBookingConfirmation } from '../messaging/builder.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';
import { computeReminderSendAtMs } from '../reminders/schedule.js';
import { sendGuideForward } from '../messaging/guideForward.js';

export type HandlerOutcome =
  | { outcome: 'sent' }
  | { outcome: 'duplicate' }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'skipped_allowlist' }
  | { outcome: 'skipped_paused' }
  | { outcome: 'forwarded_to_guide' }
  | { outcome: 'deferred' }
  | { outcome: 'failed'; error: string };

export interface HandleInput {
  payload: unknown;
  config: AppConfig;
  dedup: WebhookDedup;
  sender: DirectMessageSender;
  wa: WhatsAppClient;
  logger: AppLogger;
  isPaused: () => boolean;
  reminders?: RemindersStore;
  /** Confirms delivery of the sent DM and pings the worker group. Optional. */
  notifyDelivery?: {
    confirmAndAnnounce(input: {
      messageId: string;
      phone: string;
      kind: string;
      name: string;
      body?: string;
    }): Promise<{ status: string }>;
  };
  /**
   * Getter resolving the guide who should be DMed the client's message
   * instead of the client directly, while new_client_messages_enabled is
   * off — e.g. ליאנה, per operator request during the 2026-07-20/24
   * "restricted for 4 more days" WhatsApp linked-device lockout. Returns
   * null to skip forwarding (e.g. guide not found in guides.yaml).
   */
  forwardToGuidePhone?: () => string | null;
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
  // Wix fires both a sessions_booked automation (flat format, keyed by
  // order_id when booking_id is absent) and a REST webhook (nested format,
  // keyed by the real booking_id). If both arrive, the first one claims its
  // key successfully but the second uses a *different* key and would bypass
  // dedup. Claim the eCommerce order_id too so the second webhook (whichever
  // format it is) is caught as a duplicate.
  if (event.orderIdEcom && event.orderIdEcom !== event.bookingId) {
    input.dedup.tryClaim(event.orderIdEcom);
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

  const sendAtMs = computeReminderSendAtMs({
    startAtMs,
    reminderSendTime: remindersCfg.reminder_send_time,
    leadTimeHours: remindersCfg.lead_time_hours,
    timezone: tz,
  });
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

  if (remindersCfg.new_client_messages_enabled === false) {
    const guidePhone = input.forwardToGuidePhone?.();
    if (guidePhone) {
      const header =
        `⚠️ שליחה אוטומטית לקוחות מושבתת כרגע — הודעת קבלה ל${event.clientName} (${phone}) לא נשלחה אליו/ה. ` +
        `אנא שלחי לו/ה ידנית:`;
      try {
        await sendGuideForward(input.wa, guidePhone, header, body);
      } catch (err) {
        input.logger.error({
          source: 'webhook',
          eventType: 'guide_forward_failed',
          message: (err as Error).message,
          metadata: { bookingId: event.bookingId },
        });
      }
    }
    // Still queue a reminders row (even though the welcome itself was
    // forwarded to the guide, not sent) so the day-before reminder isn't
    // silently skipped — reminders/runner.ts checks the SAME flag at send
    // time and will forward it to the guide too if messaging is still off
    // then, or send it to the client normally if re-enabled by then. Without
    // this, the only thing that could ever backfill a reminder for a booking
    // made while messaging was off is the periodic Wix sweep, which only
    // looks a day or two ahead — a booking for a tour weeks out would get no
    // row at all until then.
    if (reminders && remindersCfg.enabled) {
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
        // Left null (not false) — the reminder runner's "skip if welcome
        // never delivered" guard is for a genuine delivery failure to a
        // client we actually tried to reach; here we deliberately never
        // tried, so the day-before reminder should still fire (forwarded to
        // the guide, same as the welcome was).
        welcomeDelivered: null,
      });
    }
    input.dedup.complete(event.bookingId, 'skipped_paused');
    input.logger.warn({
      source: 'webhook',
      eventType: 'booking_forwarded_to_guide',
      message: `new_client_messages_enabled=false; forwarded welcome for ${event.bookingId} to guide instead of ${phone}`,
      metadata: { bookingId: event.bookingId, phone, forwardedToGuide: Boolean(guidePhone) },
    });
    return { outcome: 'forwarded_to_guide' };
  }

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
          welcomeDelivered: null,
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
      // Confirm delivery (ack) and ping the worker group — but do NOT block the
      // Wix webhook response on the up-to-20s ack poll. Fire-and-forget.
      // Also persist the delivered/not-delivered outcome on the reminder row so
      // the day-before reminder runner can skip anyone whose welcome never
      // actually reached them (see RemindersStore.setWelcomeDelivered).
      if (input.notifyDelivery) {
        void input.notifyDelivery
          .confirmAndAnnounce({
            messageId: r.messageId,
            phone,
            kind: combined ? 'welcome + confirmation' : 'welcome',
            name: event.clientName,
            body,
          })
          .then((result) => {
            if (reminders) {
              reminders.setWelcomeDelivered(event.bookingId, result.status === 'delivered');
            }
          })
          .catch((err) =>
            input.logger.error({
              source: 'webhook',
              eventType: 'delivery_confirm_failed',
              message: (err as Error).message,
              metadata: { bookingId: event.bookingId },
            }),
          );
      }
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
