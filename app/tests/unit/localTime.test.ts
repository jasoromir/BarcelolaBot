import { describe, it, expect } from 'vitest';
import { todayLocalDate, tomorrowLocalDate, localHHMM, localDateTimeToUtcMs } from '../../src/util/localTime.js';

describe('localTime', () => {
  it('todayLocalDate returns the local (not UTC) calendar date', () => {
    // 23:30 UTC on 2026-07-02 is already 2026-07-03 in Europe/Madrid (UTC+2, DST).
    const now = new Date('2026-07-02T23:30:00.000Z');
    expect(todayLocalDate(now, 'Europe/Madrid')).toBe('2026-07-03');
    expect(todayLocalDate(now, 'UTC')).toBe('2026-07-02');
  });

  it('tomorrowLocalDate is exactly one day after todayLocalDate', () => {
    const now = new Date('2026-01-15T10:00:00.000Z');
    expect(tomorrowLocalDate(now, 'Europe/Madrid')).toBe('2026-01-16');
  });

  it('localHHMM formats wall-clock time in the given timezone', () => {
    const now = new Date('2026-07-02T16:05:00.000Z'); // Europe/Madrid is UTC+2 in July
    expect(localHHMM(now, 'Europe/Madrid')).toBe('18:05');
    expect(localHHMM(now, 'UTC')).toBe('16:05');
  });

  it('localDateTimeToUtcMs converts a local date+time to the correct UTC instant, independent of the server timezone', () => {
    // 15:00 in Europe/Madrid on 2026-07-24 (UTC+2 in July) = 13:00 UTC.
    const ms = localDateTimeToUtcMs('2026-07-24', '15:00', 'Europe/Madrid');
    expect(new Date(ms).toISOString()).toBe('2026-07-24T13:00:00.000Z');
  });

  it('localDateTimeToUtcMs handles a timezone with no offset (UTC) as a no-op', () => {
    const ms = localDateTimeToUtcMs('2026-07-24', '15:00', 'UTC');
    expect(new Date(ms).toISOString()).toBe('2026-07-24T15:00:00.000Z');
  });

  it('localDateTimeToUtcMs is correct across a DST boundary (Jan, UTC+1)', () => {
    const ms = localDateTimeToUtcMs('2026-01-15', '10:00', 'Europe/Madrid');
    expect(new Date(ms).toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });
});
