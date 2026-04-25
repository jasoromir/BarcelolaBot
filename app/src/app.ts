import type { Database as DB } from 'better-sqlite3';
import type { AppConfig } from './config/loader';
import type { EventLog } from './persistence/eventLog';
import type { JobHistory } from './persistence/jobHistory';
import type { WebhookDedup } from './persistence/webhookDedup';
import type { PendingDms } from './persistence/pendingDms';
import type { ControlState } from './persistence/controlState';
import type { ControlStateService } from './control/state';
import type { WhatsAppClient } from './whatsapp/types';
import type { WixClient } from './wix/types';
import type { DirectMessageSender } from './messaging/directMessage';
import type { AppLogger } from './log/logger';

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
