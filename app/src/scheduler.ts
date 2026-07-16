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
  privateTourSync: cron.ScheduledTask | null;
}

export function startScheduler(app: App): ScheduledTasks {
  const tz = app.config.settings.timezone;

  // Guide photos: fetch today's images/videos from the guides group and
  // forward them to the target group. Uses the native forwardMessage path
  // (which works now that whatsapp-web.js has the _serialized fix).
  const guidesGroupId = '34651886491-1578239130@g.us';
  async function forwardTodayGuidePhotos(targetChatId: string): Promise<number> {
    const messages = await app.whatsapp.getMessages(guidesGroupId, 50);
    const nowLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const images = messages
      .filter((m) => (m.type === 'image' || m.type === 'video') && m.hasMedia)
      .filter((m) => {
        const msgDate = new Date(m.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: tz });
        return msgDate === nowLocal;
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    if (images.length === 0) return 0;
    let forwarded = 0;
    for (const img of images) {
      try {
        await app.whatsapp.forwardMessage(img.id, targetChatId);
        forwarded++;
        if (forwarded < images.length) await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        app.logger.warn({
          source: 'jobs',
          eventType: 'guide_photo_forward_failed',
          message: `forward ${img.id} to ${targetChatId}: ${(err as Error).message}`,
        });
      }
    }
    return forwarded;
  }

  const nightlyFn = async () => {
    await runNightlyJob({
      config: app.config,
      whatsapp: app.whatsapp,
      wix: app.wix,
      history: app.jobHistory,
      reminders: app.reminders,
      logger: app.logger,
      dataDir: process.env.DATA_DIR ?? './data',
      forwardGuidePhotos: forwardTodayGuidePhotos,
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

  // Daily private-tour sync (fetch + LLM-parse new/changed bookings from the
  // Google Calendar). Independent of the day-before notify poller, which is
  // started separately in index.ts.
  const ptSync = app.config.settings.private_tours;
  const privateTourSync =
    ptSync?.enabled && ptSync.sync?.enabled && app.runPrivateTourSync
      ? cron.schedule(
          ptSync.sync.cron,
          () => {
            app.runPrivateTourSync!().catch((err) =>
              app.logger.error({
                source: 'scheduler',
                eventType: 'private_tour_sync_failed',
                message: (err as Error).message,
              }),
            );
          },
          { timezone: tz },
        )
      : null;

  app.logger.info({
    source: 'scheduler',
    eventType: 'scheduler_started',
    message: `scheduler started (tz=${tz})`,
    metadata: {
      nightly_cron: app.config.settings.schedule.nightly_cron,
      morning_cron: app.config.settings.schedule.morning_cron,
    },
  });

  return { nightly, nightlyFriday, morning, prune, waHealth, privateTourSync };
}
