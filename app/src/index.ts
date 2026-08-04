import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import qrcodeTerminal from 'qrcode-terminal';
import { loadConfig } from './config/loader.js';
import { openDatabase } from './persistence/db.js';
import { EventLog } from './persistence/eventLog.js';
import { JobHistory } from './persistence/jobHistory.js';
import { WebhookDedup } from './persistence/webhookDedup.js';
import { PendingDms } from './persistence/pendingDms.js';
import { ControlState } from './persistence/controlState.js';
import { ControlStateService } from './control/state.js';
import { RemindersStore, ReplyAuditStore } from './persistence/reminders.js';
import { WorkerForwardsStore } from './persistence/workerForwards.js';
import { GroupMembersStore, SpamActionsStore } from './persistence/groupMembers.js';
import { GuideNotificationsStore } from './persistence/guideNotifications.js';
import { PrivateTourEventsStore } from './persistence/privateTourEvents.js';
import { PrivateTourNotificationsStore } from './persistence/privateTourNotifications.js';
import { createGuideNotifyRunner } from './jobs/guideNotifyRunner.js';
import { createPrivateTourNotifyRunner } from './jobs/privateTourNotifyRunner.js';
import { runPrivateTourSyncJob } from './jobs/privateTourSyncJob.js';
import { createCalendarAuthFromServiceAccount } from './google/calendarAuth.js';
import { createDetector } from './moderation/detector.js';
import { createModerator } from './moderation/moderator.js';
import { createGeminiClassifier } from './reminders/classifier.js';
import { createGeminiDrafter } from './reminders/drafter.js';
import { createReplyHandler } from './reminders/replyHandler.js';
import { createReactionHandler } from './reminders/reactionHandler.js';
import { createReminderRunner } from './reminders/runner.js';
import { createReminderBackfillRunner } from './jobs/reminderBackfillRunner.js';
import { createLogger } from './log/logger.js';
import { createWhatsAppClient } from './whatsapp/client.js';
import { createWixClient } from './wix/client.js';
import { DirectMessageSender } from './messaging/directMessage.js';
import { createDeliveryNotifier } from './messaging/deliveryNotifier.js';
import { resolveGuidePhone } from './messaging/guideDirectory.js';
import { createHttpServer } from './http/server.js';
import { startScheduler } from './scheduler.js';
import { createEmailer } from './notify/emailer.js';
import { createSessionMonitor } from './notify/sessionMonitor.js';
import { createBrowserProbe } from './notify/browserProbe.js';
import { createJobAlerter } from './notify/jobAlerts.js';
import type { App } from './app.js';
import type { SessionMonitor } from './notify/sessionMonitor.js';
import type { BrowserProbe } from './notify/browserProbe.js';
import type { JobAlerter } from './notify/jobAlerts.js';

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  console.error(`FATAL: missing required environment variable ${name}. See .env.example.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const adminPasswordHash = requireEnv('ADMIN_PASSWORD_HASH');
  const sessionCookieSecret = requireEnv('SESSION_COOKIE_SECRET');
  const wixApiKey = requireEnv('WIX_API_KEY');
  const wixSiteId = requireEnv('WIX_SITE_ID');

  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const sessionDir = path.join(dataDir, 'session');
  const logDir = path.join(dataDir, 'logs');
  const dbPath = path.join(dataDir, 'wabot.sqlite');
  const configDir = path.resolve(process.cwd(), 'config');
  const configOverlayDir = path.join(dataDir, 'config');
  if (!fs.existsSync(configOverlayDir)) fs.mkdirSync(configOverlayDir, { recursive: true });
  const webDir = path.resolve(process.cwd(), 'web');

  const db = openDatabase(dbPath);
  const eventLog = new EventLog(db);
  const jobHistory = new JobHistory(db);
  const webhookDedup = new WebhookDedup(db);
  const pendingDms = new PendingDms(db);
  const controlStateStore = new ControlState(db);
  const controlState = new ControlStateService(controlStateStore);
  const reminders = new RemindersStore(db);
  const replyAudit = new ReplyAuditStore(db);
  const workerForwards = new WorkerForwardsStore(db);
  const groupMembers = new GroupMembersStore(db);
  const spamActions = new SpamActionsStore(db);
  const guideNotifications = new GuideNotificationsStore(db);
  const privateTourEvents = new PrivateTourEventsStore(db);
  const privateTourNotifications = new PrivateTourNotificationsStore(db);

  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const recovered = jobHistory.markStaleRunning(cutoff);

  const logger = createLogger({ eventLog, logDir, consoleLevel: 'info' });
  if (recovered > 0) {
    logger.warn({
      source: 'startup',
      eventType: 'stale_job_runs_recovered',
      message: `marked ${recovered} stale running jobs as failed`,
    });
  }

  let config = loadConfig(configDir, { overlayDir: configOverlayDir });

  const whatsapp = createWhatsAppClient({
    sessionDir,
    onQrRaw: (qr) => {
      console.log('\n============ SCAN THIS QR WITH WHATSAPP ============\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\nWhatsApp → Settings → Linked Devices → Link a device');
      console.log('=====================================================\n');
      logger.info({
        source: 'whatsapp',
        eventType: 'qr_received',
        message: 'QR code printed to terminal; scan to link this device',
      });
    },
  });
  const wix = createWixClient({
    apiKey: wixApiKey,
    siteId: wixSiteId,
    baseUrl: process.env.WIX_BASE_URL || undefined,
  });

  // Wait this long after reconnecting before ANY poller (reminders, guide
  // roster, private-tour notify, reminder backfill) is allowed to send.
  // Firing automated messages the instant a fresh session comes up — no
  // warm-up, no gap — is the exact burst pattern suspected of triggering the
  // 2026-07-20 instant-logout ban: a reconnect drained a queued DM within
  // ~15s of coming online, then WhatsApp killed the session again seconds
  // later. isConnectedAndStable() is the single gate all pollers check
  // instead of raw whatsapp.state(), so a poller can never act in the first
  // minute after any reconnect, however it happened (QR scan, auto-reconnect,
  // restart with a persisted session).
  const RECONNECT_STABLE_COOLDOWN_MS = 60_000;
  let connectedSinceMs: number | null = null;
  whatsapp.onStateChange((s) => {
    connectedSinceMs = s.kind === 'connected' ? Date.now() : null;
  });
  const isConnectedAndStable = (): boolean =>
    whatsapp.state().kind === 'connected' &&
    connectedSinceMs !== null &&
    Date.now() - connectedSinceMs >= RECONNECT_STABLE_COOLDOWN_MS;

  const dmSender = new DirectMessageSender({
    client: whatsapp,
    pendingDms,
    allowlist: () => config.allowlist,
    retry: () => ({
      attempts: config.settings.retry.max_attempts,
      backoffMs: config.settings.retry.backoff_ms,
    }),
    isPaused: () => controlState.isPaused(),
    isNewContactRestricted: () => controlState.isNewContactRestricted(),
    hasConfirmedDelivery: (phone) => reminders.hasConfirmedDelivery(phone),
  });

  const notifyDelivery = createDeliveryNotifier({
    wa: whatsapp,
    logger,
    workerGroupId: config.settings.reminders.worker_group_id,
    // Per operator request: when a client can't be auto-notified (permanent
    // delivery failure — e.g. the WhatsApp-side per-recipient "No LID for
    // user" case), DM ליאנה directly with an alert + the message text so she
    // can text the client manually from her own phone.
    alertPhone: () => resolveGuidePhone(config.guides, 'ליאנה'),
  });

  const geminiApiKey = process.env.GEMINI_API_KEY ?? '';
  const classifier = createGeminiClassifier(geminiApiKey);
  const drafter = geminiApiKey ? createGeminiDrafter(geminiApiKey) : null;
  const reminderRunner = createReminderRunner({
    wa: whatsapp,
    wix,
    reminders,
    logger,
    config: () => ({ templates: config.templates, tours: config.tours }),
    settings: {
      pollIntervalSeconds: config.settings.reminders.poll_interval_seconds,
      officialContactNumber: config.settings.reminders.official_contact_number,
      workerGroupId: config.settings.reminders.worker_group_id,
      defaultGoogleMapsUrl: config.settings.reminders.default_google_maps_url,
      interMessageDelayMinMs: config.settings.reminders.inter_message_delay_min_ms,
      interMessageDelayMaxMs: config.settings.reminders.inter_message_delay_max_ms,
    },
    isPaused: () => controlState.isPaused(),
    isConnected: isConnectedAndStable,
    isNewClientMessagingEnabled: () => config.settings.reminders.new_client_messages_enabled !== false,
    forwardToGuidePhone: () => resolveGuidePhone(config.guides, 'ליאנה'),
    notifyDelivery,
  });

  const backfillCfg = config.settings.reminders.backfill;
  const reminderBackfillRunner = backfillCfg?.enabled
    ? createReminderBackfillRunner({
        wix,
        reminders,
        logger,
        settings: {
          pollIntervalSeconds: backfillCfg.poll_interval_seconds,
          reminderSendTime: config.settings.reminders.reminder_send_time,
          leadTimeHours: config.settings.reminders.lead_time_hours,
          timezone: config.settings.timezone,
          wideSweepDaysAhead: backfillCfg.wide_sweep_days_ahead,
        },
        isPaused: () => controlState.isPaused(),
      })
    : null;

  // Guide pre-tour roster notifications: poll for tours entering the send
  // window and DM the assigned guide their attendee list. Null when disabled.
  const gn = config.settings.guide_notify;
  const guideNotifyRunner =
    gn?.enabled
      ? createGuideNotifyRunner({
          wa: whatsapp,
          wix,
          store: guideNotifications,
          logger,
          config: () => ({ guides: config.guides, tours: config.tours }),
          settings: {
            minutesBefore: gn.minutes_before,
            pollIntervalSeconds: gn.poll_interval_seconds,
            testMode: gn.test_mode ?? false,
            testGroupId: gn.test_group_id,
            dayBefore: gn.day_before
              ? {
                  enabled: gn.day_before.enabled,
                  sendTime: gn.day_before.send_time,
                  guideNames: gn.day_before.guide_names,
                }
              : undefined,
            checklistPoll: gn.checklist_poll
              ? {
                  enabled: gn.checklist_poll.enabled,
                  question: gn.checklist_poll.question,
                  note: gn.checklist_poll.note,
                  items: gn.checklist_poll.items,
                  guideNames: gn.checklist_poll.guide_names,
                }
              : undefined,
          },
          timezone: config.settings.timezone,
          isPaused: () => controlState.isPaused(),
          isConnected: isConnectedAndStable,
        })
      : null;

  // Private (custom, non-catalog) tour bookings sourced from a Google
  // Calendar via a service account. Two independent pieces, both gated on
  // private_tours.enabled: a daily sync job (fetch+LLM-parse) and a
  // day-before notify poller. Both are null when disabled/unconfigured so
  // nothing runs without an explicit opt-in + valid service account key.
  const pt = config.settings.private_tours;
  const googleSaKeyB64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  const googleSaKeyRaw = googleSaKeyB64 ? Buffer.from(googleSaKeyB64, 'base64').toString('utf8') : undefined;

  let runPrivateTourSync: (() => Promise<import('./types.js').JobOutcome>) | null = null;
  if (pt?.enabled && pt.sync?.enabled) {
    if (!googleSaKeyRaw) {
      logger.warn({
        source: 'startup',
        eventType: 'private_tours_missing_service_account',
        message: 'private_tours.sync enabled but GOOGLE_SERVICE_ACCOUNT_KEY_B64 not set; sync will not run',
      });
    } else if (!geminiApiKey) {
      logger.warn({
        source: 'startup',
        eventType: 'private_tours_missing_gemini_key',
        message: 'private_tours.sync enabled but GEMINI_API_KEY not set; sync will not run',
      });
    } else {
      const calendarAuth = createCalendarAuthFromServiceAccount(googleSaKeyRaw);
      runPrivateTourSync = () =>
        runPrivateTourSyncJob({
          calendarId: pt.calendar_id,
          auth: calendarAuth,
          store: privateTourEvents,
          logger,
          history: jobHistory,
          geminiApiKey,
          windowDaysBack: pt.sync!.window_days_back,
          windowDaysForward: pt.sync!.window_days_forward,
          dryRun: false,
        });
    }
  }

  const privateTourNotifyRunner =
    pt?.enabled && pt.notify?.enabled
      ? createPrivateTourNotifyRunner({
          wa: whatsapp,
          store: privateTourEvents,
          notifyStore: privateTourNotifications,
          logger,
          config: () => ({ guides: config.guides, templates: config.templates, tours: config.tours }),
          settings: {
            sendTime: pt.notify.send_time,
            pollIntervalSeconds: pt.notify.poll_interval_seconds,
            testMode: pt.notify.test_mode ?? false,
            testGroupId: pt.notify.test_group_id,
            managerGuideName: pt.notify.manager_guide_name,
          },
          timezone: config.settings.timezone,
          isPaused: () => controlState.isPaused(),
          isConnected: isConnectedAndStable,
        })
      : null;

  // Out-of-band alerting: email the operator when the WhatsApp link drops, and
  // proactively before the session ages out. Email (not WhatsApp) is the channel
  // precisely because WhatsApp is what goes down.
  let sessionMonitor: SessionMonitor | null = null;
  let browserProbe: BrowserProbe | null = null;
  let jobAlerter: JobAlerter | null = null;
  const notif = config.settings.notifications;
  if (notif?.enabled) {
    const emailer = createEmailer({
      apiKey: process.env.RESEND_API_KEY,
      to: notif.email_to,
      from: notif.email_from,
      logger,
    });
    if (!emailer.enabled) {
      logger.warn({
        source: 'startup',
        eventType: 'notifications_unconfigured',
        message: 'notifications enabled but RESEND_API_KEY not set; alerts will be logged, not emailed',
      });
    }
    sessionMonitor = createSessionMonitor({
      whatsapp,
      emailer,
      store: controlStateStore,
      logger,
      settings: {
        reactiveAfterMinutes: notif.reactive_after_minutes,
        proactiveWarnAfterDays: notif.proactive_warn_after_days,
        adminUrl: process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : undefined,
      },
    });

    const adminUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : undefined;

    // A wedged Chromium renderer keeps state() at "connected" while every send
    // times out — invisible to sessionMonitor. Evaluate a trivial expression in
    // the page; if that can't finish, nothing can be sent.
    browserProbe = createBrowserProbe({
      probe: () => whatsapp.pupPageEval(() => 1),
      isConnected: () => whatsapp.state().kind === 'connected',
      emailer,
      store: controlStateStore,
      logger,
      settings: {
        timeoutMs: notif.browser_probe_timeout_ms ?? 30_000,
        failuresBeforeAlert: notif.browser_probe_failures_before_alert ?? 2,
        adminUrl,
      },
    });

    jobAlerter = createJobAlerter({ emailer, logger, adminUrl });
  }

  // Guide photos are forwarded at nightly-job time (fetch from history +
  // forward), not captured in real-time. See scheduler.ts forwardTodayGuidePhotos.

  const app: App = {
    db,
    config,
    reloadConfig: () => {
      config = loadConfig(configDir, { overlayDir: configOverlayDir });
      logger.info({
        source: 'startup',
        eventType: 'config_reloaded',
        message: 'config reloaded',
      });
      app.config = config;
    },
    eventLog,
    jobHistory,
    webhookDedup,
    pendingDms,
    controlStateStore,
    controlState,
    reminders,
    replyAudit,
    workerForwards,
    groupMembers,
    spamActions,
    guideNotifications,
    privateTourEvents,
    privateTourNotifications,
    whatsapp,
    wix,
    dmSender,
    notifyDelivery,
    logger,
    reminderRunner,
    reminderBackfillRunner,
    guideNotifyRunner,
    privateTourNotifyRunner,
    runPrivateTourSync,
    sessionMonitor,
    browserProbe,
    jobAlerter,
    guidePhotosCollector: null,
    replyHandler: null,
    classifier: null,
    lastQrDataUrl: null,
  };

  if (config.settings.reminders.enabled) {
    if (!geminiApiKey) {
      logger.warn({
        source: 'startup',
        eventType: 'gemini_missing_key',
        message: 'reminders enabled but GEMINI_API_KEY not set; replies will always forward to worker',
      });
    }
    const replyHandler = createReplyHandler({
      wa: whatsapp,
      wix,
      reminders,
      audit: replyAudit,
      workerForwards,
      classifier,
      drafter,
      logger,
      // Getters, not captured values: handlers are built once at startup, but
      // `config` is reassigned by reloadConfig(). A plain literal here freezes
      // whatever the overlay held at boot — which is exactly how
      // client_response_notify_phone stayed undefined after being hot-added.
      settings: {
        get officialContactNumber() {
          return config.settings.reminders.official_contact_number;
        },
        get workerGroupId() {
          return config.settings.reminders.worker_group_id;
        },
        get confidenceThreshold() {
          return config.settings.reminders.classifier_confidence_threshold;
        },
        get defaultGoogleMapsUrl() {
          return config.settings.reminders.default_google_maps_url;
        },
        get debounceSeconds() {
          return config.settings.reminders.reply_debounce_seconds;
        },
        get clientResponseNotifyPhone() {
          return config.settings.reminders.client_response_notify_phone;
        },
      },
      config: () => ({ templates: config.templates, tours: config.tours }),
    });
    whatsapp.onIncomingDm(replyHandler);
    app.replyHandler = replyHandler;
    app.classifier = classifier;

    // Handles both staff 👍 on a worker-group draft AND customers answering the
    // day-before reminder with a reaction instead of a text reply.
    const reactionHandler = createReactionHandler({
      wa: whatsapp,
      wix,
      reminders,
      audit: replyAudit,
      workerForwards,
      logger,
      // Getters for the same reason as the reply handler above — see comment there.
      settings: {
        get workerGroupId() {
          return config.settings.reminders.worker_group_id;
        },
        get officialContactNumber() {
          return config.settings.reminders.official_contact_number;
        },
        get defaultGoogleMapsUrl() {
          return config.settings.reminders.default_google_maps_url;
        },
        get clientResponseNotifyPhone() {
          return config.settings.reminders.client_response_notify_phone;
        },
      },
      config: () => ({ templates: config.templates, tours: config.tours }),
    });
    whatsapp.onReaction(reactionHandler);
    reminderRunner.start();
  }

  // Spam moderation: detect crypto/promo spam in group chats and (in enforce
  // groups where the bot is admin) delete the message + remove the sender.
  // Detection/alerting runs everywhere; enforcement is gated by config.
  const mod = config.settings.moderation;
  if (mod?.enabled) {
    const detector = createDetector(
      {
        keywords: mod.keywords,
        newJoinerWindowMinutes: mod.new_joiner_window_minutes,
        spamThreshold: mod.score_spam_threshold,
        reviewMin: mod.score_review_min,
      },
      geminiApiKey,
    );
    const moderator = createModerator({
      wa: whatsapp,
      detector,
      members: groupMembers,
      actions: spamActions,
      logger,
      settings: {
        enabled: mod.enabled,
        enforceInGroups: mod.enforce_in_groups,
        neverActionPhones: mod.never_action_phones,
      },
      alertGroupId: config.settings.reminders.worker_group_id,
    });
    whatsapp.onGroupMessage((m) => moderator.onGroupMessage(m));
    whatsapp.onGroupJoin((ev) => moderator.onGroupJoin(ev));
    logger.info({
      source: 'startup',
      eventType: 'moderation_enabled',
      message: `spam moderation enabled; enforcing in ${mod.enforce_in_groups.length} group(s)`,
    });
  }

  if (guideNotifyRunner) {
    guideNotifyRunner.start();
    logger.info({
      source: 'startup',
      eventType: 'guide_notify_enabled',
      message: `guide pre-tour notifications enabled (${config.settings.guide_notify?.minutes_before}min before, ${config.guides.guides.length} guide(s) mapped)`,
    });
  }

  if (reminderBackfillRunner) {
    reminderBackfillRunner.start();
    logger.info({
      source: 'startup',
      eventType: 'reminder_backfill_enabled',
      message: `reminder backfill sweep enabled (every ${backfillCfg!.poll_interval_seconds}s, covers today+tomorrow)`,
    });
    // Wide (weeks-ahead) sweep runs once here at boot — i.e. on every deploy
    // and restart — rather than on a timer, so it catches any booking made
    // further out than the tight sweep's today+tomorrow window without
    // adding recurring Wix API load. Fire-and-forget: startup shouldn't wait
    // on a potentially large Wix query.
    reminderBackfillRunner.runWideSweep().catch((err) =>
      logger.error({
        source: 'startup',
        eventType: 'reminder_backfill_wide_sweep_failed',
        message: (err as Error).message,
      }),
    );
  }

  if (privateTourNotifyRunner) {
    privateTourNotifyRunner.start();
    logger.info({
      source: 'startup',
      eventType: 'private_tour_notify_enabled',
      message: `private-tour day-before notifications enabled (send at ${config.settings.private_tours?.notify?.send_time})`,
    });
  }

  // Wait this long after reconnecting before draining any queued DMs. Firing
  // automated sends the instant a fresh session comes up — no warm-up, no
  // gap — is the exact burst pattern suspected of triggering the 2026-07-20
  // instant-logout ban: a reconnect drained a queued DM within ~15s of
  // coming online, then WhatsApp killed the session again seconds later.
  // Re-checks connection state after the wait so a reconnect that immediately
  // drops again doesn't still fire a stale drain.
  const RECONNECT_DRAIN_COOLDOWN_MS = 60_000;
  whatsapp.onStateChange((s) => {
    if (s.kind === 'connected') {
      controlStateStore.set('last_connect_state', 'connected');
      setTimeout(() => {
        if (whatsapp.state().kind !== 'connected') return;
        dmSender
          .drainPending()
          .then((r) => {
            if (r.sent + r.failed + r.abandoned > 0) {
              logger.info({
                source: 'pending',
                eventType: 'pending_dms_drained',
                message: `drain: sent=${r.sent} failed=${r.failed} abandoned=${r.abandoned}`,
              });
            }
          })
          .catch((err) =>
            logger.error({
              source: 'pending',
              eventType: 'pending_dms_drain_failed',
              message: (err as Error).message,
            }),
          );
      }, RECONNECT_DRAIN_COOLDOWN_MS);
    } else if (s.kind === 'disconnected') {
      controlStateStore.set('last_connect_state', 'disconnected');
    }
  });

  const server = createHttpServer(app, {
    adminConfig: {
      passwordHash: adminPasswordHash,
      cookieSecret: sessionCookieSecret,
      webDir,
    },
  });
  const port = Number(process.env.PORT ?? process.env.HTTP_PORT ?? 3000);
  server.listen(port, () => {
    logger.info({
      source: 'startup',
      eventType: 'http_listening',
      message: `HTTP listening on :${port}`,
    });
  });

  // Auto-start WhatsApp on boot. If a session exists at sessionDir it reconnects silently;
  // otherwise whatsapp-web.js emits a 'qr' event and we print it to the terminal.
  logger.info({
    source: 'startup',
    eventType: 'autoconnect',
    message: 'starting WhatsApp client (will print QR if no session)',
  });
  whatsapp.start().catch((err) => {
    logger.error({
      source: 'startup',
      eventType: 'autoconnect_failed',
      message: (err as Error).message,
    });
  });

  startScheduler(app);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
