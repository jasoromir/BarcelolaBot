import cron from 'node-cron';
import type { App } from './app';
import { runNightlyJob } from './jobs/nightlyJob';
import { runMorningJob } from './jobs/morningJob';

export interface ScheduledTasks {
  nightly: cron.ScheduledTask;
  morning: cron.ScheduledTask;
  prune: cron.ScheduledTask;
}

export function startScheduler(app: App): ScheduledTasks {
  const tz = app.config.settings.timezone;

  const nightly = cron.schedule(
    app.config.settings.schedule.nightly_cron,
    async () => {
      await runNightlyJob({
        config: app.config,
        whatsapp: app.whatsapp,
        wix: app.wix,
        history: app.jobHistory,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
        dryRun: false,
      });
    },
    { timezone: tz },
  );

  const morning = cron.schedule(
    app.config.settings.schedule.morning_cron,
    async () => {
      await runMorningJob({
        config: app.config,
        whatsapp: app.whatsapp,
        wix: app.wix,
        history: app.jobHistory,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
        dryRun: false,
      });
    },
    { timezone: tz },
  );

  const prune = cron.schedule(
    '0 3 * * *',
    () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const removed = app.eventLog.pruneOlderThan(cutoff);
      app.logger.info({
        source: 'scheduler',
        eventType: 'prune',
        message: `pruned ${removed} old event rows`,
      });
    },
    { timezone: tz },
  );

  app.logger.info({
    source: 'scheduler',
    eventType: 'scheduler_started',
    message: `scheduler started (tz=${tz})`,
    metadata: {
      nightly_cron: app.config.settings.schedule.nightly_cron,
      morning_cron: app.config.settings.schedule.morning_cron,
    },
  });

  return { nightly, morning, prune };
}
