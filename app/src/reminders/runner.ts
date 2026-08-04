import type { AppLogger } from '../log/logger.js';
import type { RemindersStore, ReminderRow } from '../persistence/reminders.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import { buildReminder24h } from './templates.js';
import { sendGuideForward } from '../messaging/guideForward.js';

export interface ReminderRunnerDeps {
  wa: WhatsAppClient;
  wix: WixClient;
  reminders: RemindersStore;
  logger: AppLogger;
  /** Getter, not a static snapshot — so a config reload (e.g. hand-edited
   *  templates/tours after a hot reload) is picked up on the next tick
   *  instead of staying frozen at whatever was loaded at startup. */
  config: () => { templates: TemplatesConfig; tours: ToursConfig };
  settings: {
    pollIntervalSeconds: number;
    officialContactNumber: string;
    workerGroupId: string;
    defaultGoogleMapsUrl?: string;
    /**
     * Extra pause between consecutive due reminders in the same tick, on top
     * of sendDirect's own scaled typing delay — a batch of several reminders
     * firing back-to-back (only 4-30s apart) still reads as automated bulk
     * messaging to WhatsApp's anti-spam detection. Randomized within
     * [min, max] so identical-size batches don't take an identical total
     * time. Defaults to a 10-20s gap.
     */
    interMessageDelayMinMs?: number;
    interMessageDelayMaxMs?: number;
  };
  isPaused: () => boolean;
  isConnected: () => boolean;
  /** Kill-switch for the day-before reminder DM, independent of isPaused —
   *  e.g. while the WhatsApp account is flagged/recovering and we don't want
   *  to send any more automated messages to customers. Defaults to enabled
   *  (returns true) if not provided. */
  isNewClientMessagingEnabled?: () => boolean;
  /** Getter resolving the guide who should be DMed the reminder instead of
   *  the client, while isNewClientMessagingEnabled is off — e.g. ליאנה, per
   *  operator request during the 2026-07-20/24 WhatsApp linked-device
   *  lockout. Returns null to skip forwarding (e.g. guide not in guides.yaml). */
  forwardToGuidePhone?: () => string | null;
  /** Confirms delivery of the sent reminder and pings the worker group. Optional. */
  notifyDelivery?: {
    confirmAndAnnounce(input: {
      messageId: string;
      phone: string;
      kind: string;
      name: string;
      body?: string;
    }): Promise<unknown>;
  };
}

export interface ReminderRunner {
  start(): void;
  stop(): void;
  /** Fire any due reminders right now. Exposed for the admin "fire now" endpoint. */
  tick(): Promise<{ attempted: number; sent: number; deferred: number }>;
  /** Run a one-shot no-reply scan over the T-120min window. */
  runNoReplyCheck(minutesBefore: number): Promise<{ alerted: number }>;
}

export function createReminderRunner(deps: ReminderRunnerDeps): ReminderRunner {
  let handle: NodeJS.Timeout | null = null;
  // Re-entrancy guard: each humanized DM send takes 10-40s (presence + typing
  // delay), so a tick with several due reminders easily outlives the 30s poll
  // interval. Without this guard, overlapping ticks re-read the due list
  // (rows are only marked sent AFTER their send completes) and re-send the
  // same reminders — seen live on 2026-07-16 as clients receiving the same
  // reminder up to 6 times.
  let tickInFlight = false;

  async function sendOne(
    r: ReminderRow,
  ): Promise<
    'sent' | 'deferred' | 'failed' | 'skipped_undelivered_welcome' | 'forwarded_to_guide'
  > {
    if (!deps.isConnected()) return 'deferred';
    if (deps.isPaused()) return 'deferred';
    // The original welcome/confirmation DM for this booking was confirmed NOT
    // delivered (ack never reached the device) — sending a day-before reminder
    // on top of that would be a second automated message to a number we
    // already know the bot can't reach, which only makes the WhatsApp
    // anti-spam "new chat" restriction worse. Skip; staff were already
    // alerted to contact this customer manually when the welcome failed.
    if (r.welcomeDelivered === false) {
      deps.reminders.setStatus(r.bookingId, 'skipped_undelivered_welcome');
      deps.logger.info({
        source: 'reminder',
        eventType: 'reminder_skipped_undelivered_welcome',
        message: `skipping 24h reminder for ${r.bookingId} — welcome was never confirmed delivered`,
        metadata: { phone: r.phone, bookingId: r.bookingId },
      });
      return 'skipped_undelivered_welcome';
    }

    // Look up deposit/balance info if this booking has an eCommerce order ID.
    // Failure is non-fatal — we fall back to no deposit line rather than
    // failing the whole reminder send.
    let depositLine: string | undefined;
    if (r.orderIdEcom) {
      try {
        const payment = await deps.wix.getOrderPaymentInfo(r.orderIdEcom);
        if (payment) {
          depositLine =
            `\n💳 תזכורת תשלום: שילמתם פיקדון של *${payment.paid}${payment.currencySymbol}*.\n` +
            `יתרת התשלום (*${payment.balance}${payment.currencySymbol}*) תשולם למדריך בסיום הסיור.`;
        }
      } catch {
        // swallow — payment info is nice-to-have
      }
    }

    const cfg = deps.config();
    const body = buildReminder24h({
      reminder: r,
      templates: cfg.templates,
      tours: cfg.tours,
      officialContactNumber: deps.settings.officialContactNumber,
      defaultGoogleMapsUrl: deps.settings.defaultGoogleMapsUrl,
      depositLine,
    });

    if (deps.isNewClientMessagingEnabled?.() === false) {
      const guidePhone = deps.forwardToGuidePhone?.();
      if (guidePhone) {
        const header =
          `⚠️ שליחה אוטומטית לקוחות מושבתת כרגע — תזכורת ל${r.clientName ?? r.phone} (${r.phone}) לא נשלחה אליו/ה. ` +
          `אנא שלחי לו/ה ידנית:`;
        try {
          await sendGuideForward(deps.wa, guidePhone, header, body);
        } catch (err) {
          deps.logger.error({
            source: 'reminder',
            eventType: 'guide_forward_failed',
            message: (err as Error).message,
            metadata: { bookingId: r.bookingId },
          });
        }
      }
      deps.reminders.markSent(r.bookingId, new Date().toISOString());
      deps.logger.info({
        source: 'reminder',
        eventType: 'reminder_forwarded_to_guide',
        message: `new-client messaging disabled; forwarded 24h reminder for ${r.bookingId} to guide instead of ${r.phone}`,
        metadata: { phone: r.phone, bookingId: r.bookingId, forwardedToGuide: Boolean(guidePhone) },
      });
      return 'forwarded_to_guide';
    }

    try {
      const sendResult = await deps.wa.sendDirect(r.phone, body);
      deps.reminders.markSent(r.bookingId, new Date().toISOString());
      deps.logger.info({
        source: 'reminder',
        eventType: 'reminder_sent',
        message: `sent 24h reminder for ${r.bookingId}`,
        metadata: { phone: r.phone, bookingId: r.bookingId },
      });
      // Confirm delivery (ack) and ping the worker group in the background so the
      // poll loop isn't blocked on the up-to-20s ack wait.
      if (deps.notifyDelivery) {
        void deps.notifyDelivery
          .confirmAndAnnounce({
            messageId: sendResult.messageId,
            phone: r.phone,
            kind: 'reminder',
            name: r.clientName ?? r.phone,
            body,
          })
          .catch((err) =>
            deps.logger.error({
              source: 'reminder',
              eventType: 'delivery_confirm_failed',
              message: (err as Error).message,
              metadata: { bookingId: r.bookingId },
            }),
          );
      }
      return 'sent';
    } catch (err) {
      deps.logger.error({
        source: 'reminder',
        eventType: 'reminder_send_failed',
        message: (err as Error).message,
        metadata: { bookingId: r.bookingId },
      });
      return 'failed';
    }
  }

  async function tick() {
    if (tickInFlight) return { attempted: 0, sent: 0, deferred: 0 };
    tickInFlight = true;
    try {
      const due = deps.reminders.due(new Date().toISOString());
      let sent = 0;
      let deferred = 0;
      const minMs = deps.settings.interMessageDelayMinMs ?? 10_000;
      const maxMs = deps.settings.interMessageDelayMaxMs ?? 20_000;
      for (let i = 0; i < due.length; i++) {
        if (i > 0 && maxMs > 0) {
          const delayMs = minMs + Math.random() * Math.max(0, maxMs - minMs);
          await new Promise((r) => setTimeout(r, delayMs));
        }
        const result = await sendOne(due[i]!);
        if (result === 'sent') sent++;
        else if (result === 'deferred') deferred++;
      }
      return { attempted: due.length, sent, deferred };
    } finally {
      tickInFlight = false;
    }
  }

  async function runNoReplyCheck(minutesBefore: number) {
    const now = Date.now();
    const fromIso = new Date(now + (minutesBefore - 5) * 60 * 1000).toISOString();
    const toIso = new Date(now + (minutesBefore + 5) * 60 * 1000).toISOString();
    const pending = deps.reminders.pendingNoReply(fromIso, toIso);
    if (pending.length === 0) return { alerted: 0 };

    // Group by tour + start time for a tidy digest.
    const groups = new Map<string, ReminderRow[]>();
    for (const p of pending) {
      const key = `${p.tourNameHe ?? 'unknown'}|${p.startAtIso}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    for (const [key, rows] of groups) {
      const [tourName, startIso] = key.split('|');
      const time = new Date(startIso!).toLocaleTimeString('en-GB', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
      });
      const date = new Date(startIso!).toLocaleDateString('en-GB', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      });
      const list = rows
        .map((r) => `• ${r.clientName ?? 'Guest'} (${r.phone}) — ${r.participantCount} משתתפים`)
        .join('\n');
      const body = deps.config().templates.no_reply_alert
        .replaceAll('{tour_name_he}', tourName ?? '(unknown)')
        .replaceAll('{date}', date)
        .replaceAll('{time}', time)
        .replaceAll('{client_list}', list);
      try {
        await deps.wa.sendToGroup(deps.settings.workerGroupId, body);
      } catch (err) {
        deps.logger.error({
          source: 'reminder',
          eventType: 'no_reply_alert_failed',
          message: (err as Error).message,
        });
      }
    }
    deps.logger.info({
      source: 'reminder',
      eventType: 'no_reply_alert_sent',
      message: `posted no-reply alert for ${pending.length} reminders across ${groups.size} sessions`,
    });
    return { alerted: pending.length };
  }

  return {
    start() {
      if (handle) return;
      const intervalMs = Math.max(5, deps.settings.pollIntervalSeconds) * 1000;
      handle = setInterval(() => {
        tick().catch((err) =>
          deps.logger.error({
            source: 'reminder',
            eventType: 'tick_failed',
            message: (err as Error).message,
          }),
        );
      }, intervalMs);
    },
    stop() {
      if (handle) clearInterval(handle);
      handle = null;
    },
    tick,
    runNoReplyCheck,
  };
}
