import type { Database as DB } from 'better-sqlite3';
import type { AppConfig } from './config/loader.js';
import type { EventLog } from './persistence/eventLog.js';
import type { JobHistory } from './persistence/jobHistory.js';
import type { WebhookDedup } from './persistence/webhookDedup.js';
import type { PendingDms } from './persistence/pendingDms.js';
import type { ControlState } from './persistence/controlState.js';
import type { ControlStateService } from './control/state.js';
import type { WhatsAppClient } from './whatsapp/types.js';
import type { WixClient } from './wix/types.js';
import type { DirectMessageSender } from './messaging/directMessage.js';
import type { AppLogger } from './log/logger.js';
import type { RemindersStore, ReplyAuditStore } from './persistence/reminders.js';
import type { WorkerForwardsStore } from './persistence/workerForwards.js';
import type { ReminderRunner } from './reminders/runner.js';
import type { Classifier } from './reminders/classifier.js';
import type { IncomingDm } from './whatsapp/types.js';
import type { SessionMonitor } from './notify/sessionMonitor.js';

export interface App {
  db: DB;
  config: AppConfig;
  reloadConfig: () => void;

  eventLog: EventLog;
  jobHistory: JobHistory;
  webhookDedup: WebhookDedup;
  pendingDms: PendingDms;
  controlStateStore: ControlState;
  controlState: ControlStateService;
  reminders: RemindersStore;
  replyAudit: ReplyAuditStore;
  workerForwards: WorkerForwardsStore;

  whatsapp: WhatsAppClient;
  wix: WixClient;
  dmSender: DirectMessageSender;
  logger: AppLogger;
  reminderRunner: ReminderRunner;
  /** Watches the WhatsApp link and emails out-of-band alerts. Null if notifications disabled. */
  sessionMonitor: SessionMonitor | null;
  /** Exposed so admin /simulate-reply can inject synthetic DMs. Null if reminders disabled. */
  replyHandler: ((dm: IncomingDm) => Promise<void>) | null;
  /** Exposed so admin /classify can call it directly. Null if reminders disabled. */
  classifier: Classifier | null;

  lastQrDataUrl: string | null;
}
