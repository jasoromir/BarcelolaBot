import type { AppLogger } from '../log/logger.js';
import type { WhatsAppClient } from '../whatsapp/types.js';
import type { WixClient, GuideTourRoster } from '../wix/types.js';
import type { GuidesConfig, ToursConfig } from '../config/schemas.js';
import type { GuideNotificationsStore } from '../persistence/guideNotifications.js';
import {
  buildGuideRosterMessage,
  buildGuideDayBeforeReminder,
  buildChecklistPoll,
  type ChecklistPollConfig,
} from '../messaging/guideRosterMessage.js';
import { resolveGuidePhone } from '../messaging/guideDirectory.js';
import { todayLocalDate, tomorrowLocalDate, localHHMM } from '../util/localTime.js';

export interface GuideDayBeforeSettings {
  enabled: boolean;
  /** Local (timezone) clock time HH:MM to send the evening before. */
  sendTime: string;
  /** Guide names (exact Wix resource name) who get this reminder. Omit/empty = all guides. */
  guideNames?: string[];
}

export interface GuideNotifySettings {
  minutesBefore: number;
  pollIntervalSeconds: number;
  testMode: boolean;
  testGroupId?: string;
  dayBefore?: GuideDayBeforeSettings;
  /** Optional checklist poll sent right after the pre-tour roster. */
  checklistPoll?: ChecklistPollConfig;
}

export interface GuideNotifyRunnerDeps {
  wa: WhatsAppClient;
  wix: WixClient;
  store: GuideNotificationsStore;
  logger: AppLogger;
  /** Getter, not a static snapshot — so a config reload (e.g. an edited
   *  guides.yaml pushed via /admin/api/config/reload) is picked up on the
   *  next tick instead of staying frozen at whatever was loaded at startup. */
  config: () => { guides: GuidesConfig; tours: ToursConfig };
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

export function createGuideNotifyRunner(deps: GuideNotifyRunnerDeps): GuideNotifyRunner {
  let handle: NodeJS.Timeout | null = null;
  const now = () => (deps.now ?? (() => new Date()))();
  // Re-entrancy guard: a roster/day-before send only gets marked handled
  // (store.record) AFTER it completes, and each send now goes through the
  // bot's single global send queue with a humanized typing delay — easily
  // longer than the 60s poll interval. Without this guard, a slow tick is
  // still in flight when the next one starts, both see "not yet handled",
  // and both send — seen live 2026-07-22 as a duplicated day-before reminder
  // to guide אדיר. Mirrors the same fix already applied to reminders/runner.ts.
  let tickInFlight = false;

  // Send the pre-tour checklist poll right after the roster message. The short
  // note goes first (a poll message can't carry body text), then the poll
  // itself. Best-effort: a poll failure never fails the roster send — the
  // roster is the important part; the poll is a nice-to-have nudge.
  async function sendChecklistPoll(
    target: { kind: 'group'; id: string } | { kind: 'direct'; id: string },
    guideName: string | undefined,
  ): Promise<void> {
    const cfg = deps.settings.checklistPoll;
    // Optional per-guide allowlist: when set, only listed guides get the poll.
    const allow = cfg?.guideNames;
    if (allow && allow.length > 0 && (!guideName || !allow.includes(guideName))) return;
    const poll = buildChecklistPoll(cfg);
    if (!poll) return;
    const note = deps.settings.checklistPoll?.note?.trim();
    try {
      if (target.kind === 'group') {
        if (note) await deps.wa.sendToGroup(target.id, note);
        await deps.wa.sendPollToGroup(target.id, poll.question, poll.options);
      } else {
        if (note) await deps.wa.sendDirect(target.id, note);
        await deps.wa.sendPollDirect(target.id, poll.question, poll.options);
      }
    } catch (err) {
      deps.logger.warn({
        source: 'guide_notify',
        eventType: 'checklist_poll_failed',
        message: (err as Error).message,
        metadata: { guide: guideName, target: target.kind },
      });
    }
  }

  async function tick() {
    const stats = { due: 0, sent: 0, skipped: 0, failed: 0 };
    if (tickInFlight) return stats;
    if (deps.isPaused() || !deps.isConnected()) return stats;
    tickInFlight = true;
    try {
      return await runTick(stats);
    } finally {
      tickInFlight = false;
    }
  }

  async function runTick(stats: { due: number; sent: number; skipped: number; failed: number }) {
    const cfg = deps.config();
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

      const tourNameHe = cfg.tours.tours[roster.serviceId]?.name_he;
      const body = buildGuideRosterMessage({ roster, tourNameHe });
      const guidePhone = resolveGuidePhone(cfg.guides, roster.guideName);

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
          await sendChecklistPoll(
            { kind: 'group', id: deps.settings.testGroupId },
            roster.guideName,
          );
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

      // NOTE: The new-contact restriction does NOT apply to guides. They are
      // known contacts listed in guides.yaml, not cold customers. The restriction
      // only gates customer DMs in the DirectMessageSender; guide roster sends
      // always go through unconditionally.

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
        await sendChecklistPoll({ kind: 'direct', id: guidePhone }, roster.guideName);
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
    const dayBeforeCfg = deps.settings.dayBefore;
    if (!dayBeforeCfg?.enabled) return;
    if (localHHMM(now(), deps.timezone) < dayBeforeCfg.sendTime) return;
    // Empty/omitted guide_names → send to ALL guides (same convention as the
    // checklist poll). A non-empty list restricts it to just those guides.
    const allowAll = !dayBeforeCfg.guideNames || dayBeforeCfg.guideNames.length === 0;

    const cfg = deps.config();
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
      if (!roster.guideName) continue;
      if (!allowAll && !dayBeforeCfg.guideNames!.includes(roster.guideName)) continue;
      if (roster.attendees.length === 0) continue;

      const key = dayBeforeKey(roster);
      if (deps.store.wasHandled(key)) continue;
      stats.due += 1;

      const tourCfg = cfg.tours.tours[roster.serviceId];
      const body = buildGuideDayBeforeReminder({
        roster,
        tourNameHe: tourCfg?.name_he,
        meetingPointHe: tourCfg?.meeting_point_he,
        mapsUrl: tourCfg?.google_maps_url,
      });
      const guidePhone = resolveGuidePhone(cfg.guides, roster.guideName);

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

      // NOTE: Guides are exempt from the new-contact restriction (see pre-tour
      // pass comment). They are known contacts; the restriction only gates
      // customer DMs in DirectMessageSender.

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
        db?.enabled
          ? `; day-before ${db.sendTime} for ${db.guideNames?.length ?? 'all'} guide(s)`
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
