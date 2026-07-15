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

export interface BuildGuideDayBeforeOpts {
  roster: GuideTourRoster;
  /** Hebrew display name of the tour (from tours.yaml); falls back to Wix title. */
  tourNameHe?: string;
  /** Hebrew meeting-point text (from tours.yaml); omitted from message when blank. */
  meetingPointHe?: string;
  /** Optional Google Maps pin for the meeting point; appended when provided. */
  mapsUrl?: string;
}

/**
 * Builds the Hebrew day-before reminder for a guide: reminds them that tomorrow
 * at a given time they have a tour, to be at the meeting point at least 15 min
 * early, and how many people are booked SO FAR (numbers can still change with
 * last-minute bookings/cancellations — the full list comes in the pre-tour
 * roster message ~15 min before start).
 */
export function buildGuideDayBeforeReminder(opts: BuildGuideDayBeforeOpts): string {
  const { roster } = opts;
  const tourName = opts.tourNameHe?.trim() || roster.tourTitle;
  const greetName = roster.guideName ? ` ${roster.guideName}` : '';
  const meetingPoint = opts.meetingPointHe?.trim();

  const lines: string[] = [];
  lines.push(`היי${greetName} 👋`);
  lines.push('תזכורת לסיור של מחר 🗓️');
  lines.push('');
  lines.push(`🚩 *${tourName}*`);
  lines.push(`🕒 מחר בשעה *${roster.startTimeLocal}*`);
  if (meetingPoint) {
    lines.push(`📍 נקודת מפגש: ${meetingPoint}`);
    if (opts.mapsUrl) lines.push(opts.mapsUrl);
  }
  lines.push('');
  lines.push('⏰ *חשוב להגיע לנקודת המפגש לפחות 15 דקות לפני תחילת הסיור.*');
  lines.push('');
  lines.push(
    `👥 נכון לעכשיו רשומים *${roster.totalParticipants}* משתתפים (${roster.attendees.length} הזמנות).`,
  );
  lines.push('המספר עשוי להשתנות עד מועד הסיור — הרשימה המלאה תישלח כ-15 דקות לפני ההתחלה.');
  lines.push('');
  lines.push('סיור נעים! 🎉');

  return lines.join('\n');
}

export interface ChecklistPollConfig {
  enabled: boolean;
  question: string;
  note: string;
  items: string[];
  /** When set, the poll is sent only to these guide names; omit to send to all. */
  guideNames?: string[];
}

export interface BuiltChecklistPoll {
  /** Poll title line. */
  question: string;
  /** Checkable options (WhatsApp allows up to 12, each ≤100 chars). */
  options: string[];
}

/**
 * Assembles the pre-tour checklist poll from config. WhatsApp caps a poll at
 * 12 options of ≤100 chars each; we trim to stay within those limits so a long
 * items list (added over time) can never make the send fail. Returns null when
 * the poll is disabled or has no usable items.
 */
export function buildChecklistPoll(cfg: ChecklistPollConfig | undefined): BuiltChecklistPoll | null {
  if (!cfg?.enabled) return null;
  const options = cfg.items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 12)
    .map((s) => (s.length > 100 ? s.slice(0, 100) : s));
  if (options.length === 0) return null;
  return { question: cfg.question.trim() || '✅', options };
}
