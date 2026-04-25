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

  whatsapp: WhatsAppClient;
  wix: WixClient;
  dmSender: DirectMessageSender;
  logger: AppLogger;

  lastQrDataUrl: string | null;
}
