import { describe, it, expect } from 'vitest';
import { buildGuideRosterMessage } from '../../src/messaging/guideRosterMessage.js';
import type { GuideTourRoster } from '../../src/types.js';

const baseRoster: GuideTourRoster = {
  serviceId: 'svc-1',
  eventId: 'evt-1',
  tourTitle: 'Born to be Wild',
  startAtIso: '2026-07-02T15:00:00.000Z',
  startTimeLocal: '17:00',
  guideName: 'ליאנה',
  attendees: [
    { name: 'אלישי כץ', phone: '+972543050555', participants: 1 },
    { name: 'רוני טל', phone: '+972549000073', participants: 2 },
  ],
  totalParticipants: 3,
};

describe('buildGuideRosterMessage', () => {
  it('greets the guide by name and lists each attendee with count and phone', () => {
    const msg = buildGuideRosterMessage({ roster: baseRoster });
    expect(msg).toContain('היי ליאנה');
    expect(msg).toContain('*Born to be Wild*');
    expect(msg).toContain('17:00');
    expect(msg).toContain('• אלישי כץ (1): +972543050555');
    expect(msg).toContain('• רוני טל (2): +972549000073');
    expect(msg).toContain('2 הזמנות · 3 משתתפים');
  });

  it('includes the bold attendance reminder with the approved wording', () => {
    const msg = buildGuideRosterMessage({ roster: baseRoster });
    expect(msg).toContain(
      '*חשוב: אל תשכח/י לסמן את הנוכחות של המשתתפים ב-Wix בתחילת הסיור, כדי שיקבלו תזכורת והפנייה לכתיבת המלצה עלינו 🙏*',
    );
  });

  it('prefers the Hebrew tour name when provided', () => {
    const msg = buildGuideRosterMessage({ roster: baseRoster, tourNameHe: 'בורן טו בי וויילד' });
    expect(msg).toContain('*בורן טו בי וויילד*');
    expect(msg).not.toContain('*Born to be Wild*');
  });

  it('omits the link line unless a wixLink is supplied', () => {
    const without = buildGuideRosterMessage({ roster: baseRoster });
    expect(without).not.toContain('http');
    const withLink = buildGuideRosterMessage({
      roster: baseRoster,
      wixLink: 'https://manage.wix.com/dashboard/x/bookings/calendar',
    });
    expect(withLink).toContain('https://manage.wix.com/dashboard/x/bookings/calendar');
  });

  it('falls back to a generic name when an attendee name is blank', () => {
    const msg = buildGuideRosterMessage({
      roster: { ...baseRoster, attendees: [{ name: '', phone: '', participants: 1 }] },
    });
    expect(msg).toContain('• אורח/ת (1): —');
  });
});
