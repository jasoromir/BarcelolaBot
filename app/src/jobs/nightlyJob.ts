import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { JobHistory } from '../persistence/jobHistory.js';
import type { AppLogger } from '../log/logger.js';
import type { AppConfig } from '../config/loader.js';
import type { JobOutcome } from '../types.js';
import type { RemindersStore } from '../persistence/reminders.js';
import { GroupAdminService } from '../whatsapp/groupAdmin.js';
import { Broadcaster } from '../messaging/broadcaster.js';
import { buildBroadcastMessage, buildWorkerNightlySummary } from '../messaging/builder.js';
import { runJob } from './runner.js';

export interface NightlyJobInput {
  config: AppConfig;
  whatsapp: WhatsAppClient;
  wix: WixClient;
  history: JobHistory;
  logger: AppLogger;
  reminders: RemindersStore;
  isPaused: () => boolean;
  dryRun: boolean;
  now?: () => Date;
}

function tomorrowDateString(now: Date, tz: string): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(tomorrow);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function resolveTargets(cfg: AppConfig): string[] {
  if (cfg.settings.broadcast.mode === 'test') {
    return [cfg.settings.broadcast.test_group_id];
  }
  return cfg.groups.groups.filter((g) => g.active).map((g) => g.id);
}

export async function runNightlyJob(input: NightlyJobInput): Promise<JobOutcome> {
  const now = (input.now ?? (() => new Date()))();
  return runJob({
    jobName: 'nightly',
    dryRun: input.dryRun,
    history: input.history,
    logger: input.logger,
    fn: async () => {
      if (input.isPaused()) {
        return { status: 'skipped', toursCount: 0, groupsSent: 0, groupsClosed: 0 };
      }
      if (input.whatsapp.state().kind !== 'connected' && !input.dryRun) {
        return {
          status: 'failed',
          toursCount: 0,
          groupsSent: 0,
          groupsClosed: 0,
          error: 'whatsapp not connected',
        };
      }

      const date = tomorrowDateString(now, input.config.settings.timezone);
      const tours = await input.wix.getToursForDate(date);
      // Include tours that have bookings OR start at noon or later (afternoon
      // tours without bookings are still worth advertising — people might sign
      // up). Only hide zero-booking morning tours (before 12:00).
      const eligible = tours.filter((t) => {
        // Skip English-only tours — the Hebrew broadcasts shouldn't include them.
        const lang = input.config.tours.tours[t.id]?.language;
        if (lang === 'en') return false;
        return t.bookingCount > 0 || t.startTime >= '12:00';
      });
      const targets = resolveTargets(input.config);

      const message = buildBroadcastMessage({
        kind: 'night',
        date,
        tours: eligible,
        toursConfig: input.config.tours,
        templates: input.config.templates,
      });

      if (input.dryRun) {
        return {
          status: 'success',
          toursCount: eligible.length,
          groupsSent: 0,
          groupsClosed: 0,
          metadata: { preview: message, targets },
        };
      }

      const groupAdmin = new GroupAdminService(input.whatsapp);
      const verified = await groupAdmin.verifyAdminAll(targets);
      if (verified.notAdmin.length > 0) {
        input.logger.warn({
          source: 'jobs',
          eventType: 'nightly_admin_missing',
          message: `bot is not admin of ${verified.notAdmin.length} groups`,
          metadata: { notAdmin: verified.notAdmin },
        });
      }

      let groupsSent = 0;
      if (eligible.length > 0 && verified.admin.length > 0) {
        const b = new Broadcaster(input.whatsapp, {
          interMessageDelayMs: input.config.settings.broadcast.inter_message_delay_ms,
          retry: {
            attempts: input.config.settings.retry.max_attempts,
            backoffMs: input.config.settings.retry.backoff_ms,
          },
        });
        const res = await b.send(message, verified.admin);
        groupsSent = res.sent;
      }

      let groupsClosed = 0;
      for (const id of verified.admin) {
        try {
          await input.whatsapp.setGroupMessagesAdminsOnly(id, true);
          groupsClosed += 1;
        } catch (err) {
          input.logger.error({
            source: 'jobs',
            eventType: 'nightly_close_failed',
            message: (err as Error).message,
            metadata: { groupId: id },
          });
        }
      }

      // Send the internal worker summary to the Barcelola BOT group.
      // This runs after the broadcast so the group gets both messages.
      // Failures here are non-fatal — logged and swallowed.
      const workerGroupId = input.config.settings.reminders.worker_group_id;
      try {
        const reminderRows = input.reminders.forDate(date);
        const summary = buildWorkerNightlySummary({
          date,
          tours,
          reminders: reminderRows,
          toursConfig: input.config.tours,
        });
        await input.whatsapp.sendToGroup(workerGroupId, summary);
        input.logger.info({
          source: 'jobs',
          eventType: 'nightly_worker_summary_sent',
          message: `worker summary sent for ${date}`,
          metadata: { date, remindersFound: reminderRows.length },
        });
      } catch (err) {
        input.logger.error({
          source: 'jobs',
          eventType: 'nightly_worker_summary_failed',
          message: (err as Error).message,
        });
      }

      const status = verified.notAdmin.length > 0 ? 'partial' : 'success';
      return {
        status,
        toursCount: eligible.length,
        groupsSent,
        groupsClosed,
        metadata: { targets: verified.admin, skipped: verified.notAdmin },
      };
    },
  });
}
