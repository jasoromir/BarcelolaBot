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
import { createGeminiClassifier } from './reminders/classifier.js';
import { createGeminiDrafter } from './reminders/drafter.js';
import { createReplyHandler } from './reminders/replyHandler.js';
import { createReactionHandler } from './reminders/reactionHandler.js';
import { createReminderRunner } from './reminders/runner.js';
import { createLogger } from './log/logger.js';
import { createWhatsAppClient } from './whatsapp/client.js';
import { createWixClient } from './wix/client.js';
import { DirectMessageSender } from './messaging/directMessage.js';
import { createHttpServer } from './http/server.js';
import { startScheduler } from './scheduler.js';
import type { App } from './app.js';

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

  let config = loadConfig(configDir);

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

  const dmSender = new DirectMessageSender({
    client: whatsapp,
    pendingDms,
    allowlist: () => config.allowlist,
    retry: () => ({
      attempts: config.settings.retry.max_attempts,
      backoffMs: config.settings.retry.backoff_ms,
    }),
    isPaused: () => controlState.isPaused(),
  });

  const geminiApiKey = process.env.GEMINI_API_KEY ?? '';
  const classifier = createGeminiClassifier(geminiApiKey);
  const drafter = geminiApiKey ? createGeminiDrafter(geminiApiKey) : null;
  const reminderRunner = createReminderRunner({
    wa: whatsapp,
    reminders,
    logger,
    config: { templates: config.templates, tours: config.tours },
    settings: {
      pollIntervalSeconds: config.settings.reminders.poll_interval_seconds,
      officialContactNumber: config.settings.reminders.official_contact_number,
      workerGroupId: config.settings.reminders.worker_group_id,
    },
    isPaused: () => controlState.isPaused(),
    isConnected: () => whatsapp.state().kind === 'connected',
  });

  const app: App = {
    db,
    config,
    reloadConfig: () => {
      config = loadConfig(configDir);
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
    whatsapp,
    wix,
    dmSender,
    logger,
    reminderRunner,
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
      settings: {
        officialContactNumber: config.settings.reminders.official_contact_number,
        workerGroupId: config.settings.reminders.worker_group_id,
        confidenceThreshold: config.settings.reminders.classifier_confidence_threshold,
        defaultGoogleMapsUrl: config.settings.reminders.default_google_maps_url,
        debounceSeconds: config.settings.reminders.reply_debounce_seconds,
      },
      config: { templates: config.templates, tours: config.tours },
    });
    whatsapp.onIncomingDm(replyHandler);
    app.replyHandler = replyHandler;
    app.classifier = classifier;

    const reactionHandler = createReactionHandler({
      wa: whatsapp,
      workerForwards,
      logger,
      settings: { workerGroupId: config.settings.reminders.worker_group_id },
    });
    whatsapp.onReaction(reactionHandler);
    reminderRunner.start();
  }

  whatsapp.onStateChange(async (s) => {
    if (s.kind === 'connected') {
      controlStateStore.set('last_connect_state', 'connected');
      const r = await dmSender.drainPending();
      if (r.sent + r.failed + r.abandoned > 0) {
        logger.info({
          source: 'pending',
          eventType: 'pending_dms_drained',
          message: `drain: sent=${r.sent} failed=${r.failed} abandoned=${r.abandoned}`,
        });
      }
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
