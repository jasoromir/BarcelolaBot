import { describe, it, expect } from 'vitest';
import { todayLocalDate, tomorrowLocalDate, localHHMM } from '../../src/util/localTime.js';

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
});
