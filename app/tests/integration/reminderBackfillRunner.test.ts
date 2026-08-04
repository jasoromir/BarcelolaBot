import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { RemindersStore } from '../../src/persistence/reminders.js';
import { createReminderBackfillRunner } from '../../src/jobs/reminderBackfillRunner.js';
import type { Tour, BookingSummary } from '../../src/types.js';
import type { WixClient } from '../../src/wix/types.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
});
function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-rb-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

function tourWithParticipant(overrides: Partial<Tour> = {}): Tour {
  return {
    id: 'svc-1',
    date: '2026-07-24',
    startTime: '15:00',
    endTime: '18:00',
    bookingCount: 2,
    tourTitle: 'Gothic Quarter',
    participants: [
      { name: 'Dana', phone: '+972544211402', count: 2, bookingId: 'bk-1', createdAt: '2026-07-20T10:00:00.000Z' },
    ],
    ...overrides,
  };
}

function makeDeps(
  toursByDate: Record<string, Tour[]>,
  overrides: Partial<Parameters<typeof createReminderBackfillRunner>[0]> = {},
) {
  const wix: Partial<WixClient> = {
    getToursForDate: async (date: string) => toursByDate[date] ?? [],
  };
  const db = openDatabase(tmpDbPath());
  const reminders = new RemindersStore(db);
  const runner = createReminderBackfillRunner({
    wix: wix as WixClient,
    reminders,
    logger: noopLogger,
    settings: {
      pollIntervalSeconds: 900,
      reminderSendTime: '10:00',
      leadTimeHours: 24,
      timezone: 'Europe/Madrid',
    },
    isPaused: () => false,
    // "now" = 2026-07-24T09:00:00Z = 11:00 local (Europe/Madrid, UTC+2, July).
    now: () => new Date('2026-07-24T09:00:00.000Z'),
    ...overrides,
  });
  return { runner, reminders };
}

describe('reminderBackfillRunner.tick', () => {
  it('backfills a reminder for a today booking that was never queued', async () => {
    const { runner, reminders } = makeDeps({ '2026-07-24': [tourWithParticipant()] });
    const stats = await runner.tick();
    expect(stats.checked).toBe(1);
    expect(stats.backfilled).toBe(1);
    const row = reminders.get('bk-1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('awaiting_send');
    expect(row!.phone).toBe('+972544211402');
    expect(row!.clientName).toBe('Dana');
  });

  it('does not duplicate a booking that already has a reminders row (dedup)', async () => {
    const { runner, reminders } = makeDeps({ '2026-07-24': [tourWithParticipant()] });
    reminders.upsert({
      bookingId: 'bk-1',
      orderIdEcom: null,
      phone: '+972544211402',
      clientName: 'Dana',
      tourId: 'svc-1',
      tourNameHe: 'Gothic Quarter',
      startAtIso: '2026-07-24T13:00:00.000Z',
      participantCount: 2,
      status: 'awaiting_reply', // already sent — must not be touched
      sendAtIso: null,
      sentAtIso: '2026-07-20T10:05:00.000Z',
      lastReplyTs: null,
      welcomeDelivered: true,
    });
    const stats = await runner.tick();
    expect(stats.backfilled).toBe(0);
    const row = reminders.get('bk-1')!;
    expect(row.status).toBe('awaiting_reply'); // unchanged
  });

  it('schedules the backfilled reminder for "now" when the normal 10:00 send time has already passed', async () => {
    // "now" fixture is 11:00 local — past today's 10:00 send_time.
    const { runner, reminders } = makeDeps({ '2026-07-24': [tourWithParticipant()] });
    await runner.tick();
    const row = reminders.get('bk-1')!;
    expect(new Date(row.sendAtIso!).getTime()).toBeLessThanOrEqual(new Date('2026-07-24T09:00:00.000Z').getTime());
  });

  it('schedules the backfilled reminder for the normal day-before time when it is still in the future', async () => {
    const tomorrow = tourWithParticipant({ date: '2026-07-25', startTime: '15:00' });
    // "now" = 2026-07-24T07:00:00Z = 09:00 local — BEFORE today's 10:00 send
    // time, so the day-before slot for tomorrow's tour is still in the future.
    const { runner, reminders } = makeDeps(
      { '2026-07-25': [tomorrow] },
      { now: () => new Date('2026-07-24T07:00:00.000Z') },
    );
    await runner.tick();
    const row = reminders.get('bk-1')!;
    // Day-before 10:00 local (Europe/Madrid, UTC+2 in July) = 08:00 UTC on 2026-07-24.
    expect(row.sendAtIso).toBe('2026-07-24T08:00:00.000Z');
  });

  it('checks both today and tomorrow', async () => {
    const today = tourWithParticipant({ date: '2026-07-24', participants: [
      { name: 'Dana', phone: '+972544211402', count: 2, bookingId: 'bk-today', createdAt: '' },
    ] });
    const tomorrow = tourWithParticipant({ date: '2026-07-25', participants: [
      { name: 'Ohad', phone: '+972528221293', count: 1, bookingId: 'bk-tomorrow', createdAt: '' },
    ] });
    const { runner, reminders } = makeDeps({ '2026-07-24': [today], '2026-07-25': [tomorrow] });
    const stats = await runner.tick();
    expect(stats.backfilled).toBe(2);
    expect(reminders.get('bk-today')).not.toBeNull();
    expect(reminders.get('bk-tomorrow')).not.toBeNull();
  });

  it('skips a participant with an unnormalizable phone and logs a warning, without throwing', async () => {
    const badPhone = tourWithParticipant({ participants: [
      { name: 'Bad', phone: '', count: 1, bookingId: 'bk-bad', createdAt: '' },
    ] });
    const { runner, reminders } = makeDeps({ '2026-07-24': [badPhone] });
    const stats = await runner.tick();
    expect(stats.backfilled).toBe(0);
    expect(reminders.get('bk-bad')).toBeNull();
  });

  it('a tick already in flight blocks an overlapping tick (re-entrancy guard)', async () => {
    // runTick calls getToursForDate twice (today + tomorrow) — resolve every
    // pending call once released, so the "today" and "tomorrow" fetches both
    // complete after the single release rather than hanging on separate gates.
    const pending: Array<() => void> = [];
    const wix: Partial<WixClient> = {
      getToursForDate: async (date: string) =>
        new Promise((resolve) => {
          pending.push(() => resolve(date === '2026-07-24' ? [tourWithParticipant()] : []));
        }),
    };
    const db = openDatabase(tmpDbPath());
    const reminders = new RemindersStore(db);
    const runner = createReminderBackfillRunner({
      wix: wix as WixClient,
      reminders,
      logger: noopLogger,
      settings: { pollIntervalSeconds: 900, reminderSendTime: '10:00', leadTimeHours: 24, timezone: 'Europe/Madrid' },
      isPaused: () => false,
      now: () => new Date('2026-07-24T09:00:00.000Z'),
    });

    const firstTick = runner.tick();
    // Let the first tick's "today" fetch register before firing the second tick.
    await new Promise((r) => setTimeout(r, 0));
    const secondStats = await runner.tick();
    expect(secondStats).toEqual({ checked: 0, backfilled: 0, failed: 0 });
    // Drain continuously (not just once) — runTick calls getToursForDate a
    // second time, for "tomorrow", only after the first ("today") call
    // resolves, so that second pending gate doesn't exist yet at this point.
    let firstStats: { checked: number; backfilled: number; failed: number } | undefined;
    firstTick.then((s) => {
      firstStats = s;
    });
    while (firstStats === undefined) {
      while (pending.length) pending.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(firstStats.backfilled).toBe(1);
  });

  it('does nothing while paused', async () => {
    const { runner, reminders } = makeDeps({ '2026-07-24': [tourWithParticipant()] }, { isPaused: () => true });
    const stats = await runner.tick();
    expect(stats).toEqual({ checked: 0, backfilled: 0, failed: 0 });
    expect(reminders.get('bk-1')).toBeNull();
  });
});

function bookingSummary(overrides: Partial<BookingSummary> = {}): BookingSummary {
  return {
    bookingId: 'bk-wide-1',
    tourId: 'svc-1',
    tourTitle: 'Gothic Quarter',
    startAtIso: '2026-08-20T13:00:00.000Z',
    clientName: 'Ohad',
    phone: '+972547779188',
    participantCount: 5,
    ...overrides,
  };
}

describe('reminderBackfillRunner.runWideSweep', () => {
  function makeWideDeps(
    bookings: BookingSummary[],
    overrides: Partial<Parameters<typeof createReminderBackfillRunner>[0]> = {},
  ) {
    const wix: Partial<WixClient> = {
      getToursForDate: async () => [],
      getConfirmedBookingsInRange: async () => bookings,
    };
    const db = openDatabase(tmpDbPath());
    const reminders = new RemindersStore(db);
    const runner = createReminderBackfillRunner({
      wix: wix as WixClient,
      reminders,
      logger: noopLogger,
      settings: {
        pollIntervalSeconds: 900,
        reminderSendTime: '10:00',
        leadTimeHours: 24,
        timezone: 'Europe/Madrid',
      },
      isPaused: () => false,
      now: () => new Date('2026-07-29T09:00:00.000Z'),
      ...overrides,
    });
    return { runner, reminders };
  }

  it('backfills a reminder for a booking weeks out that the tight today+tomorrow sweep would never reach', async () => {
    const { runner, reminders } = makeWideDeps([bookingSummary()]);
    const stats = await runner.runWideSweep();
    expect(stats.checked).toBe(1);
    expect(stats.backfilled).toBe(1);
    const row = reminders.get('bk-wide-1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('awaiting_send');
    expect(row!.clientName).toBe('Ohad');
  });

  it('does not duplicate a booking already in the reminders table', async () => {
    const { runner, reminders } = makeWideDeps([bookingSummary()]);
    reminders.upsert({
      bookingId: 'bk-wide-1',
      orderIdEcom: null,
      phone: '+972547779188',
      clientName: 'Ohad',
      tourId: 'svc-1',
      tourNameHe: 'Gothic Quarter',
      startAtIso: '2026-08-20T13:00:00.000Z',
      participantCount: 5,
      status: 'awaiting_send',
      sendAtIso: '2026-08-19T08:00:00.000Z',
      sentAtIso: null,
      lastReplyTs: null,
      welcomeDelivered: null,
    });
    const stats = await runner.runWideSweep();
    expect(stats.backfilled).toBe(0);
  });

  it('queries the range from now out to wideSweepDaysAhead days', async () => {
    const getConfirmedBookingsInRange = vi.fn(async () => []);
    const wix: Partial<WixClient> = { getToursForDate: async () => [], getConfirmedBookingsInRange };
    const db = openDatabase(tmpDbPath());
    const reminders = new RemindersStore(db);
    const runner = createReminderBackfillRunner({
      wix: wix as WixClient,
      reminders,
      logger: noopLogger,
      settings: {
        pollIntervalSeconds: 900,
        reminderSendTime: '10:00',
        leadTimeHours: 24,
        timezone: 'Europe/Madrid',
        wideSweepDaysAhead: 30,
      },
      isPaused: () => false,
      now: () => new Date('2026-07-29T09:00:00.000Z'),
    });
    await runner.runWideSweep();
    expect(getConfirmedBookingsInRange).toHaveBeenCalledWith(
      '2026-07-29T09:00:00.000Z',
      '2026-08-28T09:00:00.000Z',
    );
  });

  it('does not touch a normal tick() call and vice versa — same re-entrancy guard blocks overlap across both methods', async () => {
    let resolveWide: (() => void) | null = null;
    const wix: Partial<WixClient> = {
      getToursForDate: async () => [tourWithParticipant()],
      getConfirmedBookingsInRange: async () =>
        new Promise((resolve) => {
          resolveWide = () => resolve([]);
        }),
    };
    const db = openDatabase(tmpDbPath());
    const reminders = new RemindersStore(db);
    const runner = createReminderBackfillRunner({
      wix: wix as WixClient,
      reminders,
      logger: noopLogger,
      settings: { pollIntervalSeconds: 900, reminderSendTime: '10:00', leadTimeHours: 24, timezone: 'Europe/Madrid' },
      isPaused: () => false,
      now: () => new Date('2026-07-24T09:00:00.000Z'),
    });

    const wideSweep = runner.runWideSweep();
    await new Promise((r) => setTimeout(r, 0));
    const tickStats = await runner.tick(); // blocked — wide sweep still in flight
    expect(tickStats).toEqual({ checked: 0, backfilled: 0, failed: 0 });
    resolveWide!();
    await wideSweep;
  });
});
