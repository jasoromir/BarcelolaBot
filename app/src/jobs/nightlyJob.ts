import type { WhatsAppClient } from '../whatsapp/types';
import type { WixClient } from '../wix/types';
import type { JobHistory } from '../persistence/jobHistory';
import type { AppLogger } from '../log/logger';
import type { AppConfig } from '../config/loader';
import type { JobOutcome } from '../types';
import { GroupAdminService } from '../whatsapp/groupAdmin';
import { Broadcaster } from '../messaging/broadcaster';
import { buildBroadcastMessage } from '../messaging/builder';
import { runJob } from './runner';

export interface NightlyJobInput {
  config: AppConfig;
  whatsapp: WhatsAppClient;
  wix: WixClient;
  history: JobHistory;
  logger: AppLogger;
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
      const eligible = tours.filter(
        (t) => t.bookingCount >= input.config.settings.min_bookings_to_run,
      );
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
