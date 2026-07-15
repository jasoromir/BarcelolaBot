import type { AppLogger } from '../log/logger.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { GuidesConfig, TemplatesConfig, ToursConfig } from '../config/schemas.js';
import type { PrivateTourEventsStore, PrivateTourEventRow } from '../persistence/privateTourEvents.js';
import type { PrivateTourNotificationsStore } from '../persistence/privateTourNotifications.js';
import { resolveGuidePhone, resolveGuidePhones } from '../messaging/guideDirectory.js';
import { resolveMeetingPointFromTourName } from '../messaging/meetingPointResolver.js';
import { buildPrivateTourReminder } from '../messaging/privateTourMessage.js';
import { tomorrowLocalDate, localHHMM } from '../util/localTime.js';

export interface PrivateTourNotifySettings {
  sendTime: string;
  pollIntervalSeconds: number;
  testMode: boolean;
  testGroupId?: string;
  managerGuideName: string;
}

export interface PrivateTourNotifyRunnerDeps {
  wa: WhatsAppClient;
  store: PrivateTourEventsStore;
  notifyStore: PrivateTourNotificationsStore;
  logger: AppLogger;
  /** Getter, not a static snapshot — so a config reload is picked up on the
   *  next tick instead of staying frozen at whatever was loaded at startup. */
  config: () => { guides: GuidesConfig; templates: TemplatesConfig; tours: ToursConfig };
  settings: PrivateTourNotifySettings;
  timezone: string;
  isPaused: () => boolean;
  isConnected: () => boolean;
  now?: () => Date;
}

export interface PrivateTourNotifyRunner {
  start(): void;
  stop(): void;
  tick(): Promise<{ due: number; sent: number; skipped: number; failed: number }>;
}

// IMPORTANT: this runner must NEVER send to event.phone (the client's number).
// It only resolves and messages guide/manager phones via resolveGuidePhone(s)
// against guides.yaml. Client-facing reminders for private tours are an
// explicit product decision to defer indefinitely — the client's name/phone
// are only ever displayed inside the guide's/manager's message body, never
// used as a send target.

/** Local-day [start, end) ISO bounds, in UTC, for a given local YYYY-MM-DD date. */
function localDayBoundsIso(localDate: string, tz: string): { startIso: string; endIso: string } {
  // Construct midnight-to-midnight in the target timezone by probing offsets
  // via Intl — simplest robust approach without a date library dependency.
  const startOfDayUtcGuess = new Date(`${localDate}T00:00:00Z`);
  const offsetMinutes = getTzOffsetMinutes(startOfDayUtcGuess, tz);
  const startIso = new Date(startOfDayUtcGuess.getTime() - offsetMinutes * 60_000).toISOString();
  const endIso = new Date(new Date(startIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { startIso, endIso };
}

function getTzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const asUtcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const toMinutes = (p: Intl.DateTimeFormatPart[]) => {
    const h = Number(p.find((x) => x.type === 'hour')?.value ?? '0');
    const m = Number(p.find((x) => x.type === 'minute')?.value ?? '0');
    return h * 60 + m;
  };
  let diff = toMinutes(parts) - toMinutes(asUtcParts);
  // Normalize across midnight wraparound (diff should be within [-720, 720]).
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

export function createPrivateTourNotifyRunner(deps: PrivateTourNotifyRunnerDeps): PrivateTourNotifyRunner {
  let handle: NodeJS.Timeout | null = null;
  const now = () => (deps.now ?? (() => new Date()))();

  async function sendReminder(
    event: PrivateTourEventRow,
    label: string,
    body: string,
  ): Promise<{ ok: boolean }> {
    try {
      if (deps.settings.testMode && deps.settings.testGroupId) {
        await deps.wa.sendToGroup(deps.settings.testGroupId, `[${label}]\n${body}`);
      } else {
        await deps.wa.sendDirect(label, body);
      }
      return { ok: true };
    } catch (err) {
      deps.logger.error({
        source: 'private_tour_notify',
        eventType: 'send_failed',
        message: (err as Error).message,
        metadata: { eventId: event.eventId, recipient: label },
      });
      return { ok: false };
    }
  }

  async function tick() {
    const stats = { due: 0, sent: 0, skipped: 0, failed: 0 };
    if (deps.isPaused() || !deps.isConnected()) return stats;
    if (localHHMM(now(), deps.timezone) < deps.settings.sendTime) return stats;

    const cfg = deps.config();
    const tomorrow = tomorrowLocalDate(now(), deps.timezone);
    const { startIso, endIso } = localDayBoundsIso(tomorrow, deps.timezone);
    const events = deps.store.listInRange(startIso, endIso);

    for (const event of events) {
      if (deps.notifyStore.wasHandled(event.eventId)) continue;
      stats.due += 1;

      const resolution = resolveMeetingPointFromTourName(event.tourName, cfg.tours);
      const guidePhones = resolveGuidePhones(cfg.guides, event.guide);
      const managerPhone = resolveGuidePhone(cfg.guides, deps.settings.managerGuideName);
      const recipients = Array.from(
        new Set([...guidePhones, managerPhone].filter((p): p is string => Boolean(p))),
      );

      const timeLocal = new Intl.DateTimeFormat('en-GB', {
        timeZone: deps.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(event.startAtIso));

      if (recipients.length === 0) {
        deps.notifyStore.record({
          eventId: event.eventId,
          guideName: event.guide,
          guidePhones,
          managerPhone,
          recipients: [],
          tourName: event.tourName,
          startAtIso: event.startAtIso,
          missingFields: ['guide_or_manager_phone'],
          sentAt: new Date().toISOString(),
          status: 'skipped_no_recipients',
        });
        stats.skipped += 1;
        deps.logger.warn({
          source: 'private_tour_notify',
          eventType: 'no_recipients',
          message: `no resolvable phone for guide "${event.guide ?? '(none)'}" or manager "${deps.settings.managerGuideName}" — private tour reminder not sent`,
          metadata: { eventId: event.eventId, tourName: event.tourName, start: event.startAtIso },
        });
        continue;
      }

      let allOk = true;
      for (const phone of recipients) {
        const isManager = phone === managerPhone;
        const guideLabel = isManager ? deps.settings.managerGuideName : event.guide || 'מדריך/ה';
        const body = buildPrivateTourReminder({
          event,
          templates: cfg.templates,
          resolution,
          timeLocal,
          recipientGuideLabel: guideLabel,
          forManager: isManager,
        });
        const result = await sendReminder(event, phone, body);
        if (!result.ok) allOk = false;
      }

      const missingFields: string[] = [];
      if (!event.guide) missingFields.push('guide');
      if (!event.phone) missingFields.push('client_phone');
      if (!event.meetingPoint && !resolution.meetingPointHe) missingFields.push('meeting_point');

      deps.notifyStore.record({
        eventId: event.eventId,
        guideName: event.guide,
        guidePhones,
        managerPhone,
        recipients,
        tourName: event.tourName,
        startAtIso: event.startAtIso,
        missingFields,
        sentAt: new Date().toISOString(),
        status: allOk ? 'sent' : 'failed',
      });
      if (allOk) stats.sent += 1;
      else stats.failed += 1;
    }

    return stats;
  }

  return {
    start() {
      if (handle) return;
      const intervalMs = Math.max(15, deps.settings.pollIntervalSeconds) * 1000;
      handle = setInterval(() => {
        tick().catch((err) =>
          deps.logger.error({
            source: 'private_tour_notify',
            eventType: 'tick_failed',
            message: (err as Error).message,
          }),
        );
      }, intervalMs);
      deps.logger.info({
        source: 'private_tour_notify',
        eventType: 'runner_started',
        message: `private-tour notify poller started (every ${deps.settings.pollIntervalSeconds}s, send at ${deps.settings.sendTime})`,
      });
    },
    stop() {
      if (handle) clearInterval(handle);
      handle = null;
    },
    tick,
  };
}
