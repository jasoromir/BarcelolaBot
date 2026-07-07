import type { AppLogger } from '../log/logger.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient, GuideTourRoster } from '../wix/types.js';
import type { GuidesConfig, ToursConfig } from '../config/schemas.js';
import type { GuideNotificationsStore } from '../persistence/guideNotifications.js';
import {
  buildGuideRosterMessage,
  buildGuideDayBeforeReminder,
} from '../messaging/guideRosterMessage.js';

export interface GuideDayBeforeSettings {
  enabled: boolean;
  /** Local (timezone) clock time HH:MM to send the evening before. */
  sendTime: string;
  /** Guide names (exact Wix resource name) who opted into this reminder. */
  guideNames: string[];
}

export interface GuideNotifySettings {
  minutesBefore: number;
  pollIntervalSeconds: number;
  testMode: boolean;
  testGroupId?: string;
  dayBefore?: GuideDayBeforeSettings;
}

export interface GuideNotifyRunnerDeps {
  wa: WhatsAppClient;
  wix: WixClient;
  store: GuideNotificationsStore;
  logger: AppLogger;
  config: { guides: GuidesConfig; tours: ToursConfig };
  settings: GuideNotifySettings;
  timezone: string;
  isPaused: () => boolean;
  isConnected: () => boolean;
  now?: () => Date;
}

export interface GuideNotifyRunner {
  start(): void;
  stop(): void;
  /** One poll pass. Exposed for the admin "fire now" endpoint and tests. */
  tick(): Promise<{ due: number; sent: number; skipped: number; failed: number }>;
}

/** Stable per-occurrence key used for dedup. */
function tourKey(r: GuideTourRoster): string {
  return r.eventId ?? `${r.serviceId}-${r.startAtIso}`;
}

/**
 * Dedup key for the day-before reminder. Distinct namespace from the pre-tour
 * roster key so both can fire for the same tour without colliding.
 */
function dayBeforeKey(r: GuideTourRoster): string {
  return `db:${tourKey(r)}`;
}

function todayLocalDate(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/** Local date (YYYY-MM-DD) shifted by +1 day, in the given timezone. */
function tomorrowLocalDate(now: Date, tz: string): string {
  return todayLocalDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);
}

/** Current wall-clock time as "HH:MM" in the given timezone. */
function localHHMM(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

export function createGuideNotifyRunner(deps: GuideNotifyRunnerDeps): GuideNotifyRunner {
  let handle: NodeJS.Timeout | null = null;
  const now = () => (deps.now ?? (() => new Date()))();

  // Build a name→phone lookup once per tick (cheap; keeps config hot-reloadable).
  function resolveGuidePhone(guideName: string | undefined): string | null {
    if (!guideName) return null;
    const match = deps.config.guides.guides.find(
      (g) => g.active !== false && g.name === guideName,
    );
    return match?.phone ?? null;
  }

  async function tick() {
    const stats = { due: 0, sent: 0, skipped: 0, failed: 0 };
    if (deps.isPaused() || !deps.isConnected()) return stats;

    const nowMs = now().getTime();
    const windowMs = deps.settings.minutesBefore * 60 * 1000;
    const date = todayLocalDate(now(), deps.timezone);

    let rosters: GuideTourRoster[];
    try {
      rosters = await deps.wix.getGuideRostersForDate(date);
    } catch (err) {
      deps.logger.error({
        source: 'guide_notify',
        eventType: 'roster_fetch_failed',
        message: (err as Error).message,
      });
      return stats;
    }

    for (const roster of rosters) {
      const startMs = new Date(roster.startAtIso).getTime();
      // Send once the tour is inside the [now, now+window] lead time and hasn't
      // already started (allow a small 2-min grace after start for late polls).
      const leadMs = startMs - nowMs;
      if (leadMs > windowMs || leadMs < -2 * 60 * 1000) continue;
      if (roster.attendees.length === 0) continue;

      const key = tourKey(roster);
      if (deps.store.wasHandled(key)) continue;
      stats.due += 1;

      const tourNameHe = deps.config.tours.tours[roster.serviceId]?.name_he;
      const body = buildGuideRosterMessage({ roster, tourNameHe });
      const guidePhone = resolveGuidePhone(roster.guideName);

      // Debug mode: everything goes to the test group regardless of phone.
      if (deps.settings.testMode && deps.settings.testGroupId) {
        try {
          const res = await deps.wa.sendToGroup(deps.settings.testGroupId, body);
          deps.store.record({
            tourKey: key,
            guideName: roster.guideName ?? null,
            guidePhone: guidePhone,
            tourTitle: roster.tourTitle,
            startAtIso: roster.startAtIso,
            attendeeCount: roster.attendees.length,
            sentAt: new Date().toISOString(),
            messageId: res.messageId,
            status: 'sent',
          });
          stats.sent += 1;
        } catch (err) {
          stats.failed += 1;
          deps.logger.error({
            source: 'guide_notify',
            eventType: 'send_failed',
            message: (err as Error).message,
            metadata: { tourKey: key, testMode: true },
          });
        }
        continue;
      }

      // No number on file for this guide → record a skip so we don't retry it
      // every poll, and log it so the operator knows to add the number.
      if (!guidePhone) {
        deps.store.record({
          tourKey: key,
          guideName: roster.guideName ?? null,
          guidePhone: null,
          tourTitle: roster.tourTitle,
          startAtIso: roster.startAtIso,
          attendeeCount: roster.attendees.length,
          sentAt: new Date().toISOString(),
          messageId: null,
          status: 'skipped_no_phone',
        });
        stats.skipped += 1;
        deps.logger.warn({
          source: 'guide_notify',
          eventType: 'guide_no_phone',
          message: `no phone on file for guide "${roster.guideName ?? '(unknown)'}" — roster not sent`,
          metadata: { tourKey: key, tour: roster.tourTitle, start: roster.startAtIso },
        });
        continue;
      }

      try {
        const res = await deps.wa.sendDirect(guidePhone, body);
        deps.store.record({
          tourKey: key,
          guideName: roster.guideName ?? null,
          guidePhone,
          tourTitle: roster.tourTitle,
          startAtIso: roster.startAtIso,
          attendeeCount: roster.attendees.length,
          sentAt: new Date().toISOString(),
          messageId: res.messageId,
          status: 'sent',
        });
        stats.sent += 1;
        deps.logger.info({
          source: 'guide_notify',
          eventType: 'roster_sent',
          message: `sent roster to guide "${roster.guideName}" for ${roster.tourTitle}`,
          metadata: {
            tourKey: key,
            guide: roster.guideName,
            phone: guidePhone,
            attendees: roster.attendees.length,
            start: roster.startAtIso,
          },
        });
      } catch (err) {
        stats.failed += 1;
        deps.logger.error({
          source: 'guide_notify',
          eventType: 'send_failed',
          message: (err as Error).message,
          metadata: { tourKey: key, guide: roster.guideName },
        });
      }
    }

    await runDayBeforePass(stats);
    return stats;
  }

  // Day-before reminder pass: for opted-in guides, once the local clock reaches
  // the configured send_time, send a single reminder per tomorrow's tour with
  // the headcount so far. Dedup (db:<tourKey>) makes it fire exactly once even
  // though the poller runs every minute; the key includes the occurrence so it
  // naturally resets for the next day's tours.
  async function runDayBeforePass(stats: {
    due: number;
    sent: number;
    skipped: number;
    failed: number;
  }): Promise<void> {
    const cfg = deps.settings.dayBefore;
    if (!cfg?.enabled || cfg.guideNames.length === 0) return;
    if (localHHMM(now(), deps.timezone) < cfg.sendTime) return;

    const date = tomorrowLocalDate(now(), deps.timezone);
    let rosters: GuideTourRoster[];
    try {
      rosters = await deps.wix.getGuideRostersForDate(date);
    } catch (err) {
      deps.logger.error({
        source: 'guide_notify',
        eventType: 'day_before_fetch_failed',
        message: (err as Error).message,
      });
      return;
    }

    for (const roster of rosters) {
      if (!roster.guideName || !cfg.guideNames.includes(roster.guideName)) continue;
      if (roster.attendees.length === 0) continue;

      const key = dayBeforeKey(roster);
      if (deps.store.wasHandled(key)) continue;
      stats.due += 1;

      const tourCfg = deps.config.tours.tours[roster.serviceId];
      const body = buildGuideDayBeforeReminder({
        roster,
        tourNameHe: tourCfg?.name_he,
        meetingPointHe: tourCfg?.meeting_point_he,
        mapsUrl: tourCfg?.google_maps_url,
      });
      const guidePhone = resolveGuidePhone(roster.guideName);

      const target =
        deps.settings.testMode && deps.settings.testGroupId
          ? { kind: 'group' as const, id: deps.settings.testGroupId }
          : guidePhone
            ? { kind: 'direct' as const, id: guidePhone }
            : null;

      if (!target) {
        deps.store.record({
          tourKey: key,
          guideName: roster.guideName,
          guidePhone: null,
          tourTitle: roster.tourTitle,
          startAtIso: roster.startAtIso,
          attendeeCount: roster.attendees.length,
          sentAt: new Date().toISOString(),
          messageId: null,
          status: 'skipped_no_phone',
        });
        stats.skipped += 1;
        deps.logger.warn({
          source: 'guide_notify',
          eventType: 'day_before_no_phone',
          message: `no phone on file for guide "${roster.guideName}" — day-before reminder not sent`,
          metadata: { tourKey: key, tour: roster.tourTitle, start: roster.startAtIso },
        });
        continue;
      }

      try {
        const res =
          target.kind === 'group'
            ? await deps.wa.sendToGroup(target.id, body)
            : await deps.wa.sendDirect(target.id, body);
        deps.store.record({
          tourKey: key,
          guideName: roster.guideName,
          guidePhone,
          tourTitle: roster.tourTitle,
          startAtIso: roster.startAtIso,
          attendeeCount: roster.attendees.length,
          sentAt: new Date().toISOString(),
          messageId: res.messageId,
          status: 'sent',
        });
        stats.sent += 1;
        deps.logger.info({
          source: 'guide_notify',
          eventType: 'day_before_sent',
          message: `sent day-before reminder to "${roster.guideName}" for ${roster.tourTitle}`,
          metadata: {
            tourKey: key,
            guide: roster.guideName,
            attendees: roster.attendees.length,
            start: roster.startAtIso,
          },
        });
      } catch (err) {
        stats.failed += 1;
        deps.logger.error({
          source: 'guide_notify',
          eventType: 'day_before_send_failed',
          message: (err as Error).message,
          metadata: { tourKey: key, guide: roster.guideName },
        });
      }
    }
  }

  return {
    start() {
      if (handle) return;
      const intervalMs = Math.max(15, deps.settings.pollIntervalSeconds) * 1000;
      handle = setInterval(() => {
        tick().catch((err) =>
          deps.logger.error({
            source: 'guide_notify',
            eventType: 'tick_failed',
            message: (err as Error).message,
          }),
        );
      }, intervalMs);
      const db = deps.settings.dayBefore;
      const dbNote =
        db?.enabled && db.guideNames.length > 0
          ? `; day-before ${db.sendTime} for ${db.guideNames.length} guide(s)`
          : '';
      deps.logger.info({
        source: 'guide_notify',
        eventType: 'runner_started',
        message: `guide-notify poller started (every ${deps.settings.pollIntervalSeconds}s, ${deps.settings.minutesBefore}min before tour${dbNote})`,
      });
    },
    stop() {
      if (handle) clearInterval(handle);
      handle = null;
    },
    tick,
  };
}
