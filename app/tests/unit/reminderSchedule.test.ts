import { describe, it, expect } from 'vitest';
import { computeReminderSendAtMs } from '../../src/reminders/schedule.js';

describe('computeReminderSendAtMs', () => {
  it('schedules for 10:00 local the day before the tour when reminderSendTime is set', () => {
    // Tour starts 2026-07-25T13:00:00Z = 15:00 local (Europe/Madrid, UTC+2 in July).
    const startAtMs = new Date('2026-07-25T13:00:00.000Z').getTime();
    const sendAtMs = computeReminderSendAtMs({
      startAtMs,
      reminderSendTime: '10:00',
      leadTimeHours: 24,
      timezone: 'Europe/Madrid',
    });
    // Day before = 2026-07-24, 10:00 local = 08:00 UTC.
    expect(new Date(sendAtMs).toISOString()).toBe('2026-07-24T08:00:00.000Z');
  });

  it('falls back to startAtMs - leadTimeHours when reminderSendTime is not set', () => {
    const startAtMs = new Date('2026-07-25T13:00:00.000Z').getTime();
    const sendAtMs = computeReminderSendAtMs({
      startAtMs,
      reminderSendTime: undefined,
      leadTimeHours: 24,
      timezone: 'Europe/Madrid',
    });
    expect(sendAtMs).toBe(startAtMs - 24 * 3_600_000);
  });

  it('is correct across a DST boundary (January, UTC+1)', () => {
    const startAtMs = new Date('2026-01-16T09:00:00.000Z').getTime(); // 10:00 local
    const sendAtMs = computeReminderSendAtMs({
      startAtMs,
      reminderSendTime: '10:00',
      leadTimeHours: 24,
      timezone: 'Europe/Madrid',
    });
    // Day before = 2026-01-15, 10:00 local (UTC+1 in January) = 09:00 UTC.
    expect(new Date(sendAtMs).toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });
});
