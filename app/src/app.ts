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
import type { DeliveryNotifier } from './messaging/deliveryNotifier.js';
import type { AppLogger } from './log/logger.js';
import type { RemindersStore, ReplyAuditStore } from './persistence/reminders.js';
import type { WorkerForwardsStore } from './persistence/workerForwards.js';
import type { GroupMembersStore, SpamActionsStore } from './persistence/groupMembers.js';
import type { GuideNotificationsStore } from './persistence/guideNotifications.js';
import type { PrivateTourEventsStore } from './persistence/privateTourEvents.js';
import type { PrivateTourNotificationsStore } from './persistence/privateTourNotifications.js';
import type { ReminderRunner } from './reminders/runner.js';
import type { GuideNotifyRunner } from './jobs/guideNotifyRunner.js';
import type { PrivateTourNotifyRunner } from './jobs/privateTourNotifyRunner.js';
import type { JobOutcome } from './types.js';
import type { Classifier } from './reminders/classifier.js';
import type { IncomingDm } from './whatsapp/types.js';
import type { SessionMonitor } from './notify/sessionMonitor.js';
import type { GuidePhotosCollector } from './jobs/guidePhotosCollector.js';
export type { GuidePhotosCollector };

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
  groupMembers: GroupMembersStore;
  spamActions: SpamActionsStore;
  guideNotifications: GuideNotificationsStore;
  privateTourEvents: PrivateTourEventsStore;
  privateTourNotifications: PrivateTourNotificationsStore;

  whatsapp: WhatsAppClient;
  wix: WixClient;
  dmSender: DirectMessageSender;
  /** Sends a customer DM and posts a delivery-confirmed (or failure) ping to the worker group. */
  notifyDelivery: DeliveryNotifier;
  logger: AppLogger;
  reminderRunner: ReminderRunner;
  /** Sends each guide their attendee roster shortly before tour start. Null if disabled. */
  guideNotifyRunner: GuideNotifyRunner | null;
  /** Day-before reminder for private (calendar-sourced) tour bookings. Null if disabled. */
  privateTourNotifyRunner: PrivateTourNotifyRunner | null;
  /** Fetches+parses new/changed private tour bookings. Null if disabled/unconfigured. */
  runPrivateTourSync: (() => Promise<JobOutcome>) | null;
  /** Watches the WhatsApp link and emails out-of-band alerts. Null if notifications disabled. */
  sessionMonitor: SessionMonitor | null;
  /** Collects guide photos throughout the day for resharing in the nightly broadcast. */
  guidePhotosCollector: GuidePhotosCollector | null;
  /** Exposed so admin /simulate-reply can inject synthetic DMs. Null if reminders disabled. */
  replyHandler: ((dm: IncomingDm) => Promise<void>) | null;
  /** Exposed so admin /classify can call it directly. Null if reminders disabled. */
  classifier: Classifier | null;

  lastQrDataUrl: string | null;
}
