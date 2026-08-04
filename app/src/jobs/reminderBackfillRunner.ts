import type { AppLogger } from '../log/logger.js';
import type { RemindersStore } from '../persistence/reminders.js';
import type { WixClient } from '../wix/types.js';
import { normalizePhone } from '../messaging/phoneNormalizer.js';
import { computeReminderSendAtMs } from '../reminders/schedule.js';
import { todayLocalDate, tomorrowLocalDate, localDateTimeToUtcMs } from '../util/localTime.js';

export interface ReminderBackfillSettings {
  pollIntervalSeconds: number;
  reminderSendTime?: string;
  leadTimeHours: number;
  timezone: string;
  /** How many days ahead the wide, on-demand sweep looks (default 60). */
  wideSweepDaysAhead?: number;
}

export interface ReminderBackfillRunnerDeps {
  wix: WixClient;
  reminders: RemindersStore;
  logger: AppLogger;
  settings: ReminderBackfillSettings;
  isPaused: () => boolean;
  now?: () => Date;
}

export interface ReminderBackfillRunner {
  start(): void;
  stop(): void;
  /** Run the tight today+tomorrow sweep now. Exposed for the admin "fire now" endpoint and tests. */
  tick(): Promise<{ checked: number; backfilled: number; failed: number }>;
  /** Run the wide (weeks-ahead) sweep now — see createReminderBackfillRunner's doc comment. */
  runWideSweep(): Promise<{ checked: number; backfilled: number; failed: number }>;
}

interface BookingLike {
  bookingId: string;
  phone: string;
  clientName: string | null;
  tourId: string | null;
  tourTitle: string | null;
  startAtIso: string;
  participantCount: number;
}

/**
 * Safety net for the day-before reminder: the normal path only queues a
 * reminder at booking-webhook time (see bookingHandler.ts), so anyone booked
 * while new_client_messages_enabled was off, or whose webhook silently failed
 * to queue one, would otherwise never get a reminder even after messaging is
 * re-enabled. Two complementary sweeps, both deduped via
 * RemindersStore.get(bookingId) so an already-queued/sent/replied booking is
 * never touched twice:
 *
 * - tick(): tight, frequent (every ~15min), covers today+tomorrow only —
 *   catches anything urgent with minimal Wix API traffic.
 * - runWideSweep(): wide (default 60 days ahead), NOT on a timer — run once
 *   at startup/deploy and on demand via the admin route. Catches gaps weeks
 *   before they'd otherwise be noticed, at the cost of a bigger one-off Wix
 *   query. Added 2026-07-29 after bookings made during a new_client_messages
 *   _enabled=false window (tours 1-4 weeks out) had no reminders row at all
 *   until the tight sweep's day-before window reached them, leaving no
 *   margin for error.
 */
export function createReminderBackfillRunner(deps: ReminderBackfillRunnerDeps): ReminderBackfillRunner {
  let handle: NodeJS.Timeout | null = null;
  const now = () => (deps.now ?? (() => new Date()))();
  // Re-entrancy guard, same pattern as the other pollers — a sweep queries
  // Wix + writes to SQLite per booking, easily slower than the poll interval
  // if there are many bookings; an overlapping run would double-insert races
  // against RemindersStore.get()'s read-then-write. Shared between tick() and
  // runWideSweep() since both write to the same table via the same helper.
  let sweepInFlight = false;

  function backfillOneBooking(
    booking: BookingLike,
    nowDate: Date,
    stats: { checked: number; backfilled: number; failed: number },
  ): void {
    stats.checked += 1;
    try {
      if (deps.reminders.get(booking.bookingId)) return; // already queued/sent/handled

      const phone = normalizePhone(booking.phone);
      if (!phone) {
        deps.logger.warn({
          source: 'reminder_backfill',
          eventType: 'backfill_bad_phone',
          message: `cannot normalize phone for booking ${booking.bookingId}`,
          metadata: { bookingId: booking.bookingId },
        });
        return;
      }

      const startAtMs = new Date(booking.startAtIso).getTime();
      const sendAtMs = computeReminderSendAtMs({
        startAtMs,
        reminderSendTime: deps.settings.reminderSendTime,
        leadTimeHours: deps.settings.leadTimeHours,
        timezone: deps.settings.timezone,
      });
      // If the normal send time has already passed (e.g. we're backfilling a
      // tour touring this afternoon), fire it right away instead of
      // scheduling it into the past — due() only picks up rows whose
      // send_at_iso <= now anyway, so this just makes the intent explicit.
      const sendAtIso = new Date(Math.max(sendAtMs, nowDate.getTime())).toISOString();

      deps.reminders.upsert({
        bookingId: booking.bookingId,
        orderIdEcom: null,
        phone,
        clientName: booking.clientName,
        tourId: booking.tourId,
        tourNameHe: booking.tourTitle,
        startAtIso: booking.startAtIso,
        participantCount: booking.participantCount || 1,
        status: 'awaiting_send',
        sendAtIso,
        sentAtIso: null,
        lastReplyTs: null,
        welcomeDelivered: null,
      });
      stats.backfilled += 1;
      deps.logger.info({
        source: 'reminder_backfill',
        eventType: 'reminder_backfilled',
        message: `backfilled missing reminder for booking ${booking.bookingId}`,
        metadata: { bookingId: booking.bookingId, phone, sendAtIso },
      });
    } catch (err) {
      stats.failed += 1;
      deps.logger.error({
        source: 'reminder_backfill',
        eventType: 'backfill_failed',
        message: (err as Error).message,
        metadata: { bookingId: booking.bookingId },
      });
    }
  }

  async function withSweepGuard<T extends { checked: number; backfilled: number; failed: number }>(
    empty: T,
    run: () => Promise<T>,
  ): Promise<T> {
    if (sweepInFlight) return empty;
    if (deps.isPaused()) return empty;
    sweepInFlight = true;
    try {
      return await run();
    } finally {
      sweepInFlight = false;
    }
  }

  async function tick() {
    return withSweepGuard({ checked: 0, backfilled: 0, failed: 0 }, async () => {
      const stats = { checked: 0, backfilled: 0, failed: 0 };
      const nowDate = now();
      const dates = [todayLocalDate(nowDate, deps.settings.timezone), tomorrowLocalDate(nowDate, deps.settings.timezone)];

      for (const date of dates) {
        let tours;
        try {
          tours = await deps.wix.getToursForDate(date);
        } catch (err) {
          deps.logger.error({
            source: 'reminder_backfill',
            eventType: 'tours_fetch_failed',
            message: (err as Error).message,
            metadata: { date },
          });
          continue;
        }

        for (const tour of tours) {
          for (const participant of tour.participants ?? []) {
            const startAtMs = localDateTimeToUtcMs(tour.date, tour.startTime, deps.settings.timezone);
            backfillOneBooking(
              {
                bookingId: participant.bookingId,
                phone: participant.phone,
                clientName: participant.name || null,
                tourId: tour.id || null,
                tourTitle: tour.tourTitle ?? null,
                startAtIso: new Date(startAtMs).toISOString(),
                participantCount: participant.count,
              },
              nowDate,
              stats,
            );
          }
        }
      }
      return stats;
    });
  }

  async function runWideSweep() {
    return withSweepGuard({ checked: 0, backfilled: 0, failed: 0 }, async () => {
      const stats = { checked: 0, backfilled: 0, failed: 0 };
      const nowDate = now();
      const daysAhead = deps.settings.wideSweepDaysAhead ?? 60;
      const fromIso = nowDate.toISOString();
      const toIso = new Date(nowDate.getTime() + daysAhead * 24 * 3600_000).toISOString();

      let bookings;
      try {
        bookings = await deps.wix.getConfirmedBookingsInRange(fromIso, toIso);
      } catch (err) {
        deps.logger.error({
          source: 'reminder_backfill',
          eventType: 'wide_sweep_fetch_failed',
          message: (err as Error).message,
        });
        return stats;
      }

      for (const b of bookings) {
        backfillOneBooking(
          {
            bookingId: b.bookingId,
            phone: b.phone,
            clientName: b.clientName || null,
            tourId: b.tourId || null,
            tourTitle: b.tourTitle ?? null,
            startAtIso: b.startAtIso,
            participantCount: b.participantCount,
          },
          nowDate,
          stats,
        );
      }
      deps.logger.info({
        source: 'reminder_backfill',
        eventType: 'wide_sweep_done',
        message: `wide reminder backfill sweep: checked=${stats.checked} backfilled=${stats.backfilled} failed=${stats.failed} (${daysAhead}d ahead)`,
      });
      return stats;
    });
  }

  return {
    start() {
      if (handle) return;
      const intervalMs = Math.max(60, deps.settings.pollIntervalSeconds) * 1000;
      handle = setInterval(() => {
        tick().catch((err) =>
          deps.logger.error({
            source: 'reminder_backfill',
            eventType: 'tick_failed',
            message: (err as Error).message,
          }),
        );
      }, intervalMs);
      deps.logger.info({
        source: 'reminder_backfill',
        eventType: 'runner_started',
        message: `reminder-backfill poller started (every ${Math.round(intervalMs / 1000)}s, covers today+tomorrow)`,
      });
    },
    stop() {
      if (handle) clearInterval(handle);
      handle = null;
    },
    tick,
    runWideSweep,
  };
}
