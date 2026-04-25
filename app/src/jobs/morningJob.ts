import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient } from '../wix/types.js';
import type { JobHistory } from '../persistence/jobHistory.js';
import type { AppLogger } from '../log/logger.js';
import type { AppConfig } from '../config/loader.js';
import type { JobOutcome } from '../types.js';
import { GroupAdminService } from '../whatsapp/groupAdmin.js';
import { Broadcaster } from '../messaging/broadcaster.js';
import { buildBroadcastMessage } from '../messaging/builder.js';
import { runJob } from './runner.js';

export interface MorningJobInput {
  config: AppConfig;
  whatsapp: WhatsAppClient;
  wix: WixClient;
  history: JobHistory;
  logger: AppLogger;
  isPaused: () => boolean;
  dryRun: boolean;
  now?: () => Date;
}

function todayDateString(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
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

export async function runMorningJob(input: MorningJobInput): Promise<JobOutcome> {
  const now = (input.now ?? (() => new Date()))();
  return runJob({
    jobName: 'morning',
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

      const date = todayDateString(now, input.config.settings.timezone);
      const targets = resolveTargets(input.config);

      const groupAdmin = new GroupAdminService(input.whatsapp);
      const verified = await groupAdmin.verifyAdminAll(targets);
      if (verified.notAdmin.length > 0) {
        input.logger.warn({
          source: 'jobs',
          eventType: 'morning_admin_missing',
          message: `bot is not admin of ${verified.notAdmin.length} groups`,
          metadata: { notAdmin: verified.notAdmin },
        });
      }

      let groupsOpened = 0;
      if (!input.dryRun) {
        for (const id of verified.admin) {
          try {
            await input.whatsapp.setGroupMessagesAdminsOnly(id, false);
            groupsOpened += 1;
          } catch (err) {
            input.logger.error({
              source: 'jobs',
              eventType: 'morning_open_failed',
              message: (err as Error).message,
              metadata: { groupId: id },
            });
          }
        }
      }

      const tours = await input.wix.getToursForDate(date);
      const eligible = tours.filter(
        (t) => t.bookingCount >= input.config.settings.min_bookings_to_run,
      );

      const message = buildBroadcastMessage({
        kind: 'morning',
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

      const status = verified.notAdmin.length > 0 ? 'partial' : 'success';
      return {
        status,
        toursCount: eligible.length,
        groupsSent,
        groupsClosed: groupsOpened,
        metadata: { targets: verified.admin, skipped: verified.notAdmin },
      };
    },
  });
}
