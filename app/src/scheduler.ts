import cron from 'node-cron';
import type { App } from './app.js';
import { runNightlyJob } from './jobs/nightlyJob.js';
import { runMorningJob } from './jobs/morningJob.js';

export interface ScheduledTasks {
  nightly: cron.ScheduledTask;
  nightlyFriday: cron.ScheduledTask | null;
  morning: cron.ScheduledTask;
  prune: cron.ScheduledTask;
  waHealth: cron.ScheduledTask;
}

export function startScheduler(app: App): ScheduledTasks {
  const tz = app.config.settings.timezone;

  const nightlyFn = async () => {
    await runNightlyJob({
      config: app.config,
      whatsapp: app.whatsapp,
      wix: app.wix,
      history: app.jobHistory,
      reminders: app.reminders,
      logger: app.logger,
      dataDir: process.env.DATA_DIR ?? './data',
      isPaused: () => app.controlState.isPaused(),
      dryRun: false,
    });
  };

  const nightly = cron.schedule(
    app.config.settings.schedule.nightly_cron,
    nightlyFn,
    { timezone: tz },
  );

  // Friday early nightly (Shabbat Shalom) — same job, earlier time.
  const fridayCron = app.config.settings.schedule.nightly_friday_cron;
  const nightlyFriday = fridayCron
    ? cron.schedule(fridayCron, nightlyFn, { timezone: tz })
    : null;

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

  // Log the WhatsApp connection state every 15 minutes. Structured events
  // give Railway's log-based alerting (and any external monitor) a stable
  // hook. The level escalates to 'error' when WA has been disconnected
  // long enough that auto-reconnect has likely exhausted its fast backoff.
  let disconnectedSinceMs: number | null = null;
  const waHealth = cron.schedule(
    '*/15 * * * *',
    () => {
      const state = app.whatsapp.state();
      if (state.kind === 'connected') {
        disconnectedSinceMs = null;
        app.logger.info({
          source: 'scheduler',
          eventType: 'wa_health_check',
          message: `wa=connected phone=${state.phone}`,
          metadata: { status: 'connected', phone: state.phone },
        });
        return;
      }
      if (disconnectedSinceMs === null) disconnectedSinceMs = Date.now();
      const elapsedMinutes = Math.floor((Date.now() - disconnectedSinceMs) / 60_000);
      const level = elapsedMinutes >= 15 ? 'error' : 'warn';
      app.logger[level]({
        source: 'scheduler',
        eventType: 'wa_health_check',
        message: `wa=${state.kind} disconnectedForMinutes=${elapsedMinutes}`,
        metadata: { status: state.kind, disconnectedForMinutes: elapsedMinutes },
      });

      // Drive out-of-band email alerts (reactive disconnect + proactive re-link).
      // Same 15-min cadence as the health check; the monitor owns its thresholds
      // and dedup, so calling every tick is safe.
      if (app.sessionMonitor) {
        app.sessionMonitor.tick().catch((err) => {
          app.logger.error({
            source: 'scheduler',
            eventType: 'session_monitor_tick_failed',
            message: (err as Error).message,
          });
        });
      }
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

  return { nightly, nightlyFriday, morning, prune, waHealth };
}
