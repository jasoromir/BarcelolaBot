import type { GuideTourRoster } from '../types.js';

export interface BuildGuideRosterOpts {
  roster: GuideTourRoster;
  /** Hebrew display name of the tour (from tours.yaml); falls back to Wix title. */
  tourNameHe?: string;
  /** Optional Wix bookings-calendar link; appended when provided. */
  wixLink?: string;
}

/**
 * Builds the Hebrew pre-tour roster message sent to the assigned guide.
 * Lists each client with their booked participant count and phone, then a
 * bold reminder to mark attendance in Wix at the START of the tour (so clients
 * receive a reminder and a referral to write a recommendation about us).
 */
export function buildGuideRosterMessage(opts: BuildGuideRosterOpts): string {
  const { roster } = opts;
  const tourName = opts.tourNameHe?.trim() || roster.tourTitle;
  const greetName = roster.guideName ? ` ${roster.guideName}` : '';

  const lines: string[] = [];
  lines.push(`היי${greetName} 👋`);
  lines.push(
    `זו רשימת המשתתפים בסיור *${tourName}* היום בשעה ${roster.startTimeLocal}:`,
  );
  lines.push('');
  lines.push(
    `👥 *${roster.attendees.length} הזמנות · ${roster.totalParticipants} משתתפים*`,
  );
  lines.push('➖➖➖➖➖➖➖');
  for (const a of roster.attendees) {
    const name = a.name?.trim() || 'אורח/ת';
    const phone = a.phone?.trim() || '—';
    lines.push(`• ${name} (${a.participants}): ${phone}`);
  }
  lines.push('➖➖➖➖➖➖➖');
  lines.push('');
  lines.push(
    '*חשוב: אל תשכח/י לסמן את הנוכחות של המשתתפים ב-Wix בתחילת הסיור, כדי שיקבלו תזכורת והפנייה לכתיבת המלצה עלינו 🙏*',
  );
  if (opts.wixLink) {
    lines.push(opts.wixLink);
  }
  lines.push('');
  lines.push('סיור נעים! 🎉');

  return lines.join('\n');
}
