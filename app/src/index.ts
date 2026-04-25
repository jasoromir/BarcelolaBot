import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config/loader';
import { openDatabase } from './persistence/db';
import { EventLog } from './persistence/eventLog';
import { JobHistory } from './persistence/jobHistory';
import { WebhookDedup } from './persistence/webhookDedup';
import { PendingDms } from './persistence/pendingDms';
import { ControlState } from './persistence/controlState';
import { ControlStateService } from './control/state';
import { createLogger } from './log/logger';
import { createWhatsAppClient } from './whatsapp/client';
import { createWixClient } from './wix/client';
import { DirectMessageSender } from './messaging/directMessage';
import { createHttpServer } from './http/server';
import { startScheduler } from './scheduler';
import type { App } from './app';

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const sessionDir = path.join(dataDir, 'session');
  const logDir = path.join(dataDir, 'logs');
  const dbPath = path.join(dataDir, 'wabot.sqlite');
  const configDir = path.resolve(process.cwd(), 'config');

  const db = openDatabase(dbPath);
  const eventLog = new EventLog(db);
  const jobHistory = new JobHistory(db);
  const webhookDedup = new WebhookDedup(db);
  const pendingDms = new PendingDms(db);
  const controlStateStore = new ControlState(db);
  const controlState = new ControlStateService(controlStateStore);

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

  const whatsapp = createWhatsAppClient({ sessionDir });
  const wix = createWixClient({
    apiKey: process.env.WIX_API_KEY ?? '',
    siteId: process.env.WIX_SITE_ID ?? '',
  });

  const dmSender = new DirectMessageSender({
    client: whatsapp,
    pendingDms,
    allowlist: () => config.allowlist,
    retry: {
      attempts: config.settings.retry.max_attempts,
      backoffMs: config.settings.retry.backoff_ms,
    },
    isPaused: () => controlState.isPaused(),
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
    whatsapp,
    wix,
    dmSender,
    logger,
    lastQrDataUrl: null,
  };

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

  const server = createHttpServer(app);
  const port = Number(process.env.HTTP_PORT ?? 3000);
  server.listen(port, () => {
    logger.info({
      source: 'startup',
      eventType: 'http_listening',
      message: `HTTP listening on :${port}`,
    });
  });

  if (controlStateStore.get('last_connect_state') === 'connected') {
    logger.info({
      source: 'startup',
      eventType: 'autoconnect',
      message: 'attempting WhatsApp reconnect (last state was connected)',
    });
    whatsapp.start().catch((err) => {
      logger.error({
        source: 'startup',
        eventType: 'autoconnect_failed',
        message: (err as Error).message,
      });
    });
  }

  startScheduler(app);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
