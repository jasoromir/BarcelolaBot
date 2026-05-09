import type { AppLogger } from '../log/logger.js';
import type { RemindersStore, ReminderRow } from '../persistence/reminders.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { TemplatesConfig, ToursConfig } from '../config/schemas.js';
import { buildReminder24h } from './templates.js';

export interface ReminderRunnerDeps {
  wa: WhatsAppClient;
  reminders: RemindersStore;
  logger: AppLogger;
  config: { templates: TemplatesConfig; tours: ToursConfig };
  settings: {
    pollIntervalSeconds: number;
    officialContactNumber: string;
    workerGroupId: string;
  };
  isPaused: () => boolean;
  isConnected: () => boolean;
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

  async function sendOne(r: ReminderRow): Promise<'sent' | 'deferred' | 'failed'> {
    if (!deps.isConnected()) return 'deferred';
    if (deps.isPaused()) return 'deferred';
    const body = buildReminder24h({
      reminder: r,
      templates: deps.config.templates,
      tours: deps.config.tours,
      officialContactNumber: deps.settings.officialContactNumber,
    });
    try {
      await deps.wa.sendDirect(r.phone, body);
      deps.reminders.markSent(r.bookingId, new Date().toISOString());
      deps.logger.info({
        source: 'reminder',
        eventType: 'reminder_sent',
        message: `sent 24h reminder for ${r.bookingId}`,
        metadata: { phone: r.phone, bookingId: r.bookingId },
      });
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
      const body = deps.config.templates.no_reply_alert
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
