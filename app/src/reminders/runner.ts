import type { AppLogger } from '../log/logger.js';
import type { RemindersStore, ReminderRow } from '../persistence/reminders.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import { buildReminder24h } from './templates.js';

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
  };
  isPaused: () => boolean;
  isConnected: () => boolean;
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

  async function sendOne(
    r: ReminderRow,
  ): Promise<'sent' | 'deferred' | 'failed' | 'skipped_undelivered_welcome'> {
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
    const due = deps.reminders.due(new Date().toISOString());
    let sent = 0;
    let deferred = 0;
    for (const r of due) {
      const result = await sendOne(r);
      if (result === 'sent') sent++;
      else if (result === 'deferred') deferred++;
    }
    return { attempted: due.length, sent, deferred };
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
