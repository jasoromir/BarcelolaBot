import { describe, it, expect } from 'vitest';
import { looksLikePrivateTour } from '../../src/reminders/privateTourDetector.js';

describe('looksLikePrivateTour', () => {
  it('matches real private-tour summaries (סיור/טיול + פרטי)', () => {
    expect(looksLikePrivateTour('סיור גאודי פרטי. דנה. 5 אנשים. מדריך אדיר')).toBe(true);
    expect(looksLikePrivateTour('סיור פרטי משולב גותי בורן משפחת ורד 4 מטיילים מדריכה ליאנה/ עדי')).toBe(true);
    expect(looksLikePrivateTour('טיול יום פרטי גוני 6 מטיילים מדריכה ליאנה קוסטה בראווה')).toBe(true);
  });

  it('does not match a staff note that mentions "privately" without a tour word', () => {
    // Real false-positive case found during production verification: an
    // internal reminder using פרטי conversationally ("talk to X privately"),
    // not a customer booking.
    expect(looksLikePrivateTour('לדבר עם שי פרטי 1.10 תשלום')).toBe(false);
  });

  it('does not match a general-catalog tour or availability note (no פרטי)', () => {
    expect(looksLikePrivateTour('סיור הר היהודים - מדריכה:ליאנה')).toBe(false);
    expect(looksLikePrivateTour('גאות פנויה עד 18:00')).toBe(false);
    expect(looksLikePrivateTour('אדיר יכול לעבוד רק לילה מ20:30')).toBe(false);
  });

  it('requires both words — פרטי alone or a tour word alone is not enough', () => {
    expect(looksLikePrivateTour('פרטים נוספים בתיאור')).toBe(false); // פרטי substring but no tour word
    expect(looksLikePrivateTour('סיור גותי - מדריכה:עדי')).toBe(false); // tour word but not private
  });

  it('returns false for null/undefined/empty summary', () => {
    expect(looksLikePrivateTour(null)).toBe(false);
    expect(looksLikePrivateTour(undefined)).toBe(false);
    expect(looksLikePrivateTour('')).toBe(false);
  });
});
